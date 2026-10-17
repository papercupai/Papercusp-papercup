/**
 * search-stale-index-caveat.test.ts — EI-21699129692862363.
 *
 * `session:'self'` force-tails the live transcript into the index before it
 * reads, which is what lets it find a turn written seconds ago. That refresh is
 * FAIL-SOFT (`catch { return false }` per owner in
 * `refreshLiveSessionsBeforeRead`), and its `{ attempted, refreshed }` receipt
 * used to be DISCARDED at the call site.
 *
 * So a failed refresh produced a confident `total_hits: 0` — for text sitting in
 * the transcript, unindexed — accompanied by a hint blaming the caller's query
 * shape. That is the dangerous direction: the compaction protocol tells agents
 * to verify a claimed owner directive with exactly this call, so a stale zero
 * read as "the owner never said it" is directive-rot arriving through a tool
 * result rather than through a summary.
 *
 * Run: cd packages/operator-core && npx vitest run \
 *   lib/agent-tools/sessions/search-stale-index-caveat.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deferredSqlAnswer } from '../../../test/_fake-sql';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-self', ownerLabel: 'su · self' })),
}));

const refreshLiveSessionsBeforeRead = vi.fn();
vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshLiveSessionsBeforeRead: (...a: unknown[]) => refreshLiveSessionsBeforeRead(...a),
}));

const resolveSelfSession = vi.fn();
vi.mock('../../search/self-session', () => ({
  resolveSelfSession: (...a: unknown[]) => resolveSelfSession(...a),
}));

vi.mock('../../search/session-ingest', () => ({
  ingestFileNow: vi.fn(async () => undefined),
}));

const tool = (await import('./search')).default;

interface ParsedResult {
  ok: boolean;
  total_hits: number;
  zeroHitCaveat?: string;
  hint?: string;
  indexRefresh?: {
    attempted: number;
    refreshed: number;
    degraded: boolean;
    unconfirmed?: number;
    skipped?: number;
    failureReasons?: Record<string, number>;
    failureSubtypes?: Record<string, number>;
  };
}

function makeTx(results: unknown[][]) {
  let i = 0;
  // deferredSqlAnswer: a result is handed out only when a query is AWAITED
  // (never for an interpolated fragment); D-006 ledger reads take no slot.
  return vi.fn((..._args: unknown[]) => deferredSqlAnswer(_args, () => {
    const r = results[i] ?? [];
    i += 1;
    return r;
  }));
}

async function run(args: Record<string, unknown>, results: unknown[][]) {
  const tx = makeTx(results);
  const res = await (
    tool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, { workspaceId: 'default', tx });
  return JSON.parse(res.content[0].text) as ParsedResult;
}

const SELF = {
  sourceKind: 'claude',
  sessionId: 'sess-current',
  filePath: '/home/x/.papercusp/session-claude/su-self/projects/repo/sess-current.jsonl',
};

/**
 * PERMANENT FALSIFIABILITY CONTROL (never delete).
 *
 * The pre-fix assembly, reconstructed: `refreshLiveSessionsBeforeRead` was
 * awaited for its side effect and its `{ attempted, refreshed }` receipt thrown
 * away, so the response could not carry the fact that the refresh had failed —
 * no `indexRefresh`, and a `zeroHitCaveat` that only ever discussed query shape.
 *
 * This exists so the suite below is verified to DISCRIMINATE rather than merely
 * pass. Without it, every assertion could be satisfied by a build that always
 * emitted the caveat, and the "stays SILENT" cases could be satisfied by one
 * that never emitted it; the pair only means something against a model of the
 * behaviour being ruled out.
 */
function preFixResponse(args: { hits: number; zeroHitCaveat?: string }): ParsedResult {
  return {
    ok: true,
    total_hits: args.hits,
    ...(args.zeroHitCaveat ? { zeroHitCaveat: args.zeroHitCaveat } : {}),
    // NOTE: no `indexRefresh` key — that is precisely the defect.
  };
}

describe('CONTROL — the pre-fix shape fails the assertions this suite makes', () => {
  it('carried no refresh receipt at all', () => {
    const legacy = preFixResponse({ hits: 0 });
    expect(legacy.indexRefresh).toBeUndefined();
  });

  it('explained a stale zero as a query-shape problem, the misdirection this fixes', () => {
    const legacy = preFixResponse({
      hits: 0,
      zeroHitCaveat:
        "0 hits for this query, but session:'self' is owner-scoped across 3 indexed sessions — this is a QUERY-MATCH MISS, not \"no history\".",
    });
    // The caller is told to re-phrase. If the index was stale, no re-phrasing
    // can ever succeed, and the advice sends them in circles.
    expect(legacy.zeroHitCaveat).toMatch(/QUERY-MATCH MISS/);
    expect(legacy.zeroHitCaveat ?? '').not.toMatch(/UNVERIFIABLE, NOT ABSENT/);
    expect(legacy.indexRefresh).toBeUndefined();
  });
});

describe('sessions:search — degraded-refresh caveat (EI-21699129692862363)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSelfSession.mockResolvedValue(SELF);
  });

  it('discloses a FAILED live-transcript refresh behind a zero', async () => {
    // The reported failure shape: the refresh was attempted for this session and
    // did not land, so the index cannot contain the caller's most recent turns.
    refreshLiveSessionsBeforeRead.mockResolvedValue({
      attempted: 1,
      refreshed: 0,
      failureReasons: { ingest_error: 1 },
      failureSubtypes: { filesystem_access: 1 },
    });

    const parsed = await run(
      { session: 'self', mode: 'verbatim', query: 'lane fix' },
      [[], [{ session_count: '1', earliest: null }]],
    );

    expect(parsed.total_hits).toBe(0);
    expect(parsed.indexRefresh).toEqual({
      attempted: 1,
      refreshed: 0,
      degraded: true,
      failureReasons: { ingest_error: 1 },
      failureSubtypes: { filesystem_access: 1 },
    });
    expect(parsed.zeroHitCaveat).toBeDefined();
    // The claim that matters: this zero is UNVERIFIABLE, not evidence of absence.
    expect(parsed.zeroHitCaveat).toMatch(/UNVERIFIABLE, NOT ABSENT/);
    expect(parsed.zeroHitCaveat).toMatch(/owner\s+directive/i);
  });

  it('the staleness caveat LEADS, so re-phrasing advice never buries it', async () => {
    // With another owner-scoped session present, the pre-existing QUERY-MATCH
    // MISS caveat also fires. Ordering is the whole point: one says "your query
    // missed", the other says "this answer may be wrong". The second must come
    // first, or the caller acts on the first and re-phrases forever.
    refreshLiveSessionsBeforeRead.mockResolvedValue({ attempted: 2, refreshed: 1 });

    const parsed = await run(
      { session: 'self', mode: 'verbatim', query: 'lane fix' },
      [[], [{ session_count: '3', earliest: '2026-07-01T00:00:00.000Z' }]],
    );

    const caveat = parsed.zeroHitCaveat ?? '';
    expect(caveat).toMatch(/UNVERIFIABLE, NOT ABSENT/);
    expect(caveat).toMatch(/QUERY-MATCH MISS/);
    expect(caveat.indexOf('UNVERIFIABLE')).toBeLessThan(caveat.indexOf('QUERY-MATCH MISS'));
    expect(parsed.indexRefresh?.degraded).toBe(true);
  });

  it('reports the ATTEMPTED/REFRESHED counts, not just a boolean', async () => {
    // A caller auditing "was this answer trustworthy" needs the magnitude: 4 of 5
    // failing is a different situation from 1 of 5.
    refreshLiveSessionsBeforeRead.mockResolvedValue({
      attempted: 5,
      refreshed: 1,
      failureReasons: { resolve_timeout: 2, ingest_timeout: 2 },
    });
    const parsed = await run({ session: 'self', mode: 'verbatim', query: 'x' }, [[], []]);
    expect(parsed.indexRefresh).toEqual({
      attempted: 5,
      refreshed: 1,
      degraded: true,
      failureReasons: { resolve_timeout: 2, ingest_timeout: 2 },
    });
    expect(parsed.zeroHitCaveat).toMatch(/4 of 5/);
  });

  it('keeps a zero unverifiable when candidate liveness is unconfirmed', async () => {
    refreshLiveSessionsBeforeRead.mockResolvedValue({
      attempted: 0,
      refreshed: 0,
      unconfirmed: 2,
    });

    const parsed = await run({ session: 'self', mode: 'verbatim', query: 'lane fix' }, [[], []]);

    expect(parsed.total_hits).toBe(0);
    expect(parsed.indexRefresh).toEqual({
      attempted: 0,
      refreshed: 0,
      degraded: true,
      unconfirmed: 2,
    });
    expect(parsed.zeroHitCaveat).toMatch(/UNVERIFIABLE, NOT ABSENT/);
    expect(parsed.zeroHitCaveat).toMatch(/Liveness was UNCONFIRMED for 2 candidate session\(s\)/);
    expect(parsed.zeroHitCaveat).toMatch(/those were not refreshed/);
  });

  it('reports refreshable candidates skipped by the 20-session bound', async () => {
    refreshLiveSessionsBeforeRead.mockResolvedValue({
      attempted: 20,
      refreshed: 20,
      skipped: 3,
    });

    const parsed = await run({ session: 'self', mode: 'verbatim', query: 'lane fix' }, [[], []]);

    expect(parsed.indexRefresh).toEqual({
      attempted: 20,
      refreshed: 20,
      degraded: true,
      skipped: 3,
    });
    expect(parsed.zeroHitCaveat).toMatch(/UNVERIFIABLE, NOT ABSENT/);
    expect(parsed.zeroHitCaveat).toMatch(/20-session refresh bound left 3 confirmed-refreshable candidate session\(s\) unrefreshed/);
  });

  it('stays SILENT when the refresh fully succeeded — a genuine zero is not muddied', async () => {
    // The guard must not cry wolf: if the index really is current, a 0 means 0,
    // and adding doubt to every empty result would train callers to ignore it.
    refreshLiveSessionsBeforeRead.mockResolvedValue({ attempted: 1, refreshed: 1 });

    const parsed = await run(
      { session: 'self', mode: 'verbatim', query: 'never written anywhere' },
      [[], [{ session_count: '1', earliest: null }]],
    );

    expect(parsed.total_hits).toBe(0);
    expect(parsed.indexRefresh).toBeUndefined();
    expect(parsed.zeroHitCaveat ?? '').not.toMatch(/UNVERIFIABLE/);
  });

  it('stays silent when there was nothing to refresh at all', async () => {
    refreshLiveSessionsBeforeRead.mockResolvedValue({ attempted: 0, refreshed: 0 });
    const parsed = await run({ session: 'self', mode: 'verbatim', query: 'x' }, [[], []]);
    expect(parsed.indexRefresh).toBeUndefined();
    expect(parsed.zeroHitCaveat ?? '').not.toMatch(/UNVERIFIABLE/);
  });

  it('does not fire when the query actually MATCHED, even on a degraded refresh', async () => {
    // A degraded refresh with hits is not a false negative — the caveat explains
    // a ZERO, so attaching it to a non-empty result would be noise.
    refreshLiveSessionsBeforeRead.mockResolvedValue({ attempted: 1, refreshed: 0 });

    const parsed = await run(
      { session: 'self', mode: 'verbatim', query: 'lane fix', context: 0 },
      [
        [
          {
            source_kind: 'claude',
            session_id: 'sess-current',
            turn_idx: 0,
            speaker: 'user',
            owner: 'su-self',
            harness_slug: null,
            ts: '2026-08-28T00:00:00.000Z',
            text: 'the lane fix landed',
          },
        ],
        // A matched hit is re-read for origin before it is emitted; keep the
        // same coordinate so the liveness check does not classify it as stale.
        [
          {
            source_kind: 'claude',
            session_id: 'sess-current',
            turn_idx: 0,
            speaker: 'user',
            head: 'the lane fix landed',
            tail: '',
            turn_origin: null,
            turn_origin_verdict: null,
          },
        ],
      ],
    );

    expect(parsed.total_hits).toBeGreaterThan(0);
    expect(parsed.zeroHitCaveat ?? '').not.toMatch(/UNVERIFIABLE/);
  });
});
