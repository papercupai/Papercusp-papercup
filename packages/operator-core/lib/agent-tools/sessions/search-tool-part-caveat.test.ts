/**
 * search-tool-part-caveat.test.ts — EI-21922997688425048.
 *
 * `mode:'verbatim'` runs a raw ILIKE against `harness_shared.session_turns`,
 * which is a TEXT-TURNS-ONLY corpus by design (session-ingest.ts:156-164):
 * tool_use/tool_result content is never stored there, except a narrow
 * AskUserQuestion owner-dialog carve-out (EI-20772173866687919). So a verbatim
 * 0 there can mean the string genuinely never occurred, OR that it occurred
 * only inside a tool call's arguments or a tool result — a report body, a file
 * dump, most interactive-tool answers — which this index structurally cannot
 * see, regardless of how fresh the ingest is (a DIFFERENT gap from the
 * already-fixed stale-refresh case in search-stale-index-caveat.test.ts).
 *
 * The fix: on a verbatim 0-hit, probe the faithful-render companion store
 * (`session_turn_parts`, 14-day retention, DOES keep tool_use/tool_result
 * payloads) for the same literal substring restricted to those part kinds. A
 * hit there is a POSITIVE existence proof and must lead ahead of the generic
 * "retry with a different fragment" advice, which can never succeed against
 * content this corpus excludes by design.
 *
 * Run: cd packages/operator-core && npx vitest run \
 *   lib/agent-tools/sessions/search-tool-part-caveat.test.ts
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
}

/** Sequential stand-in for ctx.tx — each tagged-template call returns the next
 *  queued result set, and records the SQL text so assertions can name the
 *  query they care about instead of counting calls (the convention this suite
 *  and its sibling files both use, and the exact thing that would have caught
 *  a positional-ordering regression before it shipped). */
function makeTx(results: unknown[][]) {
  let i = 0;
  // deferredSqlAnswer: a result is handed out only when a query is AWAITED
  // (never for an interpolated fragment); D-006 ledger reads take no slot.
  const tx = vi.fn((..._args: unknown[]) => deferredSqlAnswer(_args, () => {
    const r = results[i] ?? [];
    i += 1;
    return r;
  }));
  return {
    tx,
    sqlTexts: () =>
      tx.mock.calls.map((c) => (Array.isArray(c[0]) ? (c[0] as unknown as string[]).join(' ? ') : String(c[0]))),
  };
}

const TOOL_PART_PROBE_QUERY = /FROM harness_shared\.session_turn_parts p/;

async function run(args: Record<string, unknown>, results: unknown[][]) {
  const { tx, sqlTexts } = makeTx(results);
  const res = await (
    tool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, { workspaceId: 'default', tx });
  return { parsed: JSON.parse(res.content[0].text) as ParsedResult, sqls: sqlTexts() };
}

const SELF = {
  sourceKind: 'claude',
  sessionId: 'sess-current',
  filePath: '/home/x/.papercusp/session-claude/su-self/projects/repo/sess-current.jsonl',
};

describe('sessions:search — tool-part existence caveat (EI-21922997688425048)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSelfSession.mockResolvedValue(SELF);
    refreshLiveSessionsBeforeRead.mockResolvedValue({ attempted: 1, refreshed: 1 }); // fully fresh — no staleIndexCaveat noise
  });

  it('fires when the exact string is found inside a tool_use/tool_result part', async () => {
    const { parsed, sqls } = await run(
      { session: 'self', mode: 'verbatim', query: 'P-006' },
      [
        [], // main verbatim ILIKE over session_turns -> zero rows
        [{ session_count: '1', earliest: null }], // owner-scope aggregate: only this session, so no QUERY-MATCH-MISS caveat
        [{ tool_use_ready: true, tool_result_ready: true }], // both owner indexes are valid
        [{ found: true }], // the existence probe stops at the first matching part
      ],
    );

    expect(parsed.total_hits).toBe(0);
    const partProbe = sqls.find((s) => TOOL_PART_PROBE_QUERY.test(s)) ?? '';
    expect(sqls.filter((s) => TOOL_PART_PROBE_QUERY.test(s))).toHaveLength(1);
    expect(partProbe).toMatch(/SELECT EXISTS\s*\(/i);
    expect(partProbe).toContain("part_kind = 'tool_use'");
    expect(partProbe).toContain("part_kind = 'tool_result'");
    expect(partProbe).not.toMatch(/COUNT\s*\(/i);
    expect(parsed.zeroHitCaveat).toBeDefined();
    expect(parsed.zeroHitCaveat).toMatch(/FOUND, JUST NOT IN A TEXT TURN/);
    expect(parsed.zeroHitCaveat).toMatch(/appears inside a tool call or tool result/);
    expect(parsed.zeroHitCaveat).toMatch(/tool call or tool result/);
    expect(parsed.zeroHitCaveat).not.toMatch(/UNVERIFIABLE, NOT ABSENT/); // refresh was fresh
  });

  it('skips the full-table fallback while the tool_result owner index is not ready', async () => {
    const { parsed, sqls } = await run(
      { session: 'self', mode: 'verbatim', query: 'P-006' },
      [
        [],
        [{ session_count: '1', earliest: null }],
        [{ tool_use_ready: true, tool_result_ready: false }],
      ],
    );

    expect(sqls.some((s) => TOOL_PART_PROBE_QUERY.test(s))).toBe(false);
    expect(parsed.zeroHitCaveat).toMatch(/TOOL-CONTENT NOT CHECKED/);
  });

  it('stays silent when the string genuinely does not occur anywhere, tool parts included', async () => {
    const { parsed, sqls } = await run(
      { session: 'self', mode: 'verbatim', query: 'never written anywhere' },
      [
        [],
        [{ session_count: '1', earliest: null }],
        [{ tool_use_ready: true, tool_result_ready: true }],
        [{ found: false }],
      ],
    );

    expect(sqls.some((s) => TOOL_PART_PROBE_QUERY.test(s))).toBe(true);
    expect(parsed.total_hits).toBe(0);
    expect(parsed.zeroHitCaveat).toBeUndefined();
  });

  it('never runs the probe when there are real hits — nothing to explain', async () => {
    const { parsed, sqls } = await run(
      { session: 'self', mode: 'verbatim', query: 'a phrase that matches', context: 0 },
      [
        [{
          source_kind: 'claude', session_id: 'sess-current', turn_idx: 3, speaker: 'assistant',
          owner: 'su-self', harness_slug: null, ts: '2026-08-01T00:00:00.000Z', text: 'a phrase that matches',
        }],
        [{ source_kind: 'claude', session_id: 'sess-current', turn_idx: 3,
          speaker: 'assistant', head: 'a phrase that matches', tail: 'a phrase that matches' }],
      ],
    );

    expect(sqls.some((s) => TOOL_PART_PROBE_QUERY.test(s))).toBe(false);
    expect(parsed.total_hits).toBe(1);
    expect(parsed.zeroHitCaveat).toBeUndefined();
  });

  it('the stale-refresh caveat still LEADS ahead of the tool-part caveat when both fire', async () => {
    // Ordering matters twice over here: staleIndexCaveat questions whether the
    // 0 itself is trustworthy at all, which is a prerequisite question to
    // "and by the way it also exists in a tool part" — so it must stay first.
    refreshLiveSessionsBeforeRead.mockResolvedValue({ attempted: 1, refreshed: 0 });

    const { parsed } = await run(
      { session: 'self', mode: 'verbatim', query: 'lane fix' },
      [
        [],
        [{ session_count: '1', earliest: null }],
        [{ tool_use_ready: true, tool_result_ready: true }],
        [{ found: true }],
      ],
    );

    const caveat = parsed.zeroHitCaveat ?? '';
    expect(caveat).toMatch(/UNVERIFIABLE, NOT ABSENT/);
    expect(caveat).toMatch(/FOUND, JUST NOT IN A TEXT TURN/);
    expect(caveat.indexOf('UNVERIFIABLE')).toBeLessThan(caveat.indexOf('FOUND, JUST NOT IN A TEXT TURN'));
  });

  it('the paraphrase hint now names the structural tool-content exclusion too', async () => {
    const { parsed } = await run(
      { session: 'self', mode: 'verbatim', query: 'something I paraphrased' },
      [
        [],
        [{ session_count: '1', earliest: null }],
        [{ tool_use_ready: true, tool_result_ready: true }],
        [{ found: false }],
      ],
    );

    expect(parsed.hint).toBeDefined();
    expect(parsed.hint).toMatch(/verbatim mode matches only an exact/i);
    expect(parsed.hint).toMatch(/tool call or tool result/);
  });

  it('is a best-effort probe — a failing query never breaks the search', async () => {
    let call = 0;
    const tx = vi.fn((..._args: unknown[]) => deferredSqlAnswer(_args, () => {
      call += 1;
      if (call === 1) return []; // main verbatim query
      if (call === 2) return [{ session_count: '1', earliest: null }]; // owner-scope aggregate
      if (call === 3) return [{ tool_use_ready: true, tool_result_ready: true }]; // index readiness
      throw new Error('session_turn_parts unavailable');
    }));
    const res = await (
      tool as unknown as {
        handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
      }
    ).handler({ session: 'self', mode: 'verbatim', query: 'x' }, { workspaceId: 'default', tx });
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.ok).toBe(true);
    expect(parsed.total_hits).toBe(0);
    expect(parsed.zeroHitCaveat).toMatch(/TOOL-CONTENT NOT CHECKED/);
  });
});
