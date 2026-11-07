import { describe, expect, it, vi } from 'vitest';
import { sessionSearchEnabled } from './_shared';

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
}));

const tool = (await import('./digest')).default;

type Handler = (args: unknown, ctx: unknown) => Promise<unknown>;

function handler(): Handler {
  return (tool as unknown as { handler: Handler }).handler;
}

function digestTx(queryRows: () => unknown[] = () => []) {
  return vi.fn(async (strings: unknown, ..._values: unknown[]) => {
    const statement = Array.isArray(strings) ? strings.join('?') : '';
    if (statement.includes('clock_timestamp()')) return [{ snapshot_at: new Date().toISOString() }];
    return statement.includes('WITH scoped') ? queryRows() : [];
  });
}

function indexedSession(session: string, total: number) {
  return {
    source_kind: 'codex', session_id: session, owner: null, harness_slug: null, cwd: null,
    turns: 1, prompt_count: 0, first_ts: null, last_ts: null, last_ts_ms: null,
    tool_call_count: null, kickoff_text: null, closing_text: null, task_candidates: [],
    closing_turn_idx: null, host_events: [], stop_text: null, stop_turn_idx: null, stop_ts: null,
    total_matching: total,
  };
}

describe('sessions:digest time-window bounds', () => {
  it('normalizes a documented relative since window before binding PostgreSQL', async () => {
    const before = Date.now();
    const tx = digestTx();

    const result = await handler()({ since: '14d' }, { workspaceId: 'ws-test', tx });

    // Nested SQL fragments also use the tag. Count the digest SELECT separately
    // from the database clock read that freezes ingestion across pages.
    const statements = tx.mock.calls.map(([strings]) => (Array.isArray(strings) ? strings.join('?') : ''));
    expect(statements.filter((s) => s.includes('WITH scoped'))).toHaveLength(1);
    expect(statements.filter((s) => s.includes('clock_timestamp()'))).toHaveLength(1);
    // D-006 (WI-10005570): the reader rule is part of the digest's scope, and a caller
    // with no identity is not an error — it reads as nobody (fail closed).
    expect(statements.some((s) => s.includes('harness_shared.personal_disclosures'))).toBe(true);
    expect(result).toMatchObject({ data: { ok: true, count: 0, total: 0, digests: [] } });
    const boundValues = tx.mock.calls.flatMap(([, ...values]) => values);
    const resolvedSince = boundValues.find(
      (value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value),
    );
    expect(resolvedSince).toBeDefined();
    expect(Math.abs(Date.parse(resolvedSince!) - (before - 14 * 86_400_000))).toBeLessThan(10_000);
    expect(boundValues).not.toContain('14d');
  });

  it('keeps historical timestamp bounds indexable before disclosure filtering', async () => {
    const tx = digestTx();

    await handler()({
      since: '2026-10-30T00:00:00.000Z',
      until: '2026-10-31T23:59:59.000Z',
    }, { workspaceId: 'ws-test', tx });

    const statement = tx.mock.calls
      .map(([strings]) => (Array.isArray(strings) ? strings.join('?') : ''))
      .find((query) => query.includes('WITH scoped_window AS MATERIALIZED'));
    expect(statement).toBeDefined();
    expect(statement).toContain('ts IS NOT NULL');
    expect(statement).toContain('ts >= ?');
    expect(statement).toContain('ts <= ?');
    expect(statement).toContain('ts IS NULL');
    expect(statement).toContain('ingested_at >= ?');
    expect(statement).toContain('ingested_at <= ?');
    expect(statement).not.toContain('COALESCE(ts, ingested_at) >= ?');
    expect(statement).not.toContain('COALESCE(ts, ingested_at) <= ?');

    const windowCte = statement!.indexOf('scoped_window AS MATERIALIZED');
    const filteredCte = statement!.indexOf('scoped AS MATERIALIZED');
    const filteredBody = statement!.slice(filteredCte, statement!.indexOf('agg AS', filteredCte));
    expect(filteredCte).toBeGreaterThan(windowCte);
    expect(filteredBody).toContain('FROM scoped_window windowed');
    expect(filteredBody).toContain('WHERE NOT ?');
  });

  it('rejects an invalid since bound before opening a database query', async () => {
    const tx = vi.fn();

    const result = await handler()({ since: 'yesterday-ish' }, { workspaceId: 'ws-test', tx });

    expect(tx).not.toHaveBeenCalled();
    // { data } envelope, not the legacy MCP content[0].text one: digest.ts signals the
    // invalid-bound rejection through the same `data` shape as its success path, so the
    // tool-data-shape ratchet holds. Reading `content` here strands on that contract.
    const { ok, error } = (result as { data: { ok: boolean; error: string } }).data;
    expect(ok).toBe(false);
    expect(error).toContain('relative window like "45m", "12h", "7d"');
  });
});

describe('sessions:digest coverage disclosure', () => {
  it('limits an empty census claim to the indexed transcript window', async () => {
    const result = await handler()({}, { workspaceId: 'ws-test', tx: digestTx() });

    expect(result).toMatchObject({ data: { ok: true, digests: [], nextCursor: null,
      coverage: { candidateSessions: 0, candidateIncidents: null, pageScanned: 0,
        scannedThrough: 0, status: 'complete-for-indexed-transcript-window', hostOnlyOwners: 'not-covered' } } });
  });

  it('labels a capped census incomplete and requires a narrower window', async () => {
    let nextSession = 0;
    const tx = digestTx(() => Array.from({ length: 100 }, () => indexedSession(`fixture-${nextSession++}`, 505)));
    let cursor: string | undefined;
    let last: { data: { nextCursor: string | null } } | undefined;
    for (let page = 0; page < 5; page++) {
      last = await handler()({ limit: 100, cursor }, { workspaceId: 'ws-test', tx }) as typeof last;
      cursor = last!.data.nextCursor ?? undefined;
    }

    expect(last).toMatchObject({ data: { hasMore: true, nextCursor: null,
      coverage: { candidateSessions: 505, pageScanned: 100, scannedThrough: 500,
        censusLimit: 500, status: 'window-limit; narrow since/until', hostOnlyOwners: 'not-covered' } } });
    const statements = tx.mock.calls.map(([strings]) => (Array.isArray(strings) ? strings.join('?') : ''));
    expect(statements.filter(s => s.includes('clock_timestamp()'))).toHaveLength(1);
  });

  it('reports unavailable history without claiming a complete census', async () => {
    vi.mocked(sessionSearchEnabled).mockResolvedValueOnce(false);
    const tx = digestTx();
    const result = await handler()({}, { workspaceId: 'ws-test', tx });

    expect(tx).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(result).not.toHaveProperty('data.coverage');
    const envelope = result as { content: Array<{ text: string }> };
    expect(JSON.parse(envelope.content[0].text)).toMatchObject({ ok: false, error: 'feature_disabled' });
  });
});
