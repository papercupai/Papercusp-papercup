/**
 * list.test.ts — EI-11403 regression.
 *
 * sessions:list { owner:'self' } returned count 0 for a LIVE Codex session that
 * sessions:search { session:'self' } and sessions:timeline { owner:'self' } could
 * both read. Root cause: search/timeline reach the session by SESSION_ID, while
 * list filters session_turns by OWNER — and a managed-Codex-home / history.jsonl
 * live session's turns are indexed under a different owner stamp (or not yet
 * indexed) than the coord ownerId `self` resolves to. list now merges an explicit
 * active-session row (the issue's recommended fix + GUARD: "list/search/timeline
 * must all resolve the same session id"), with OWNER-INDEPENDENT counts so the row
 * matches what search/timeline see.
 *
 * WI-37867 (owner-reported: "chat window opens but stays empty") extends that
 * fallback from owner:'self' to ANY named owner, resolved via harness_shared.
 * adv_sessions — which carries session_id from the instant of launch, whereas
 * session_turns cannot see a session that has produced no turns. The HUD chat
 * popup resolves a peer agent's ownerId through this tool, so the 'self' scoping
 * meant a brand-new session resolved to null and the popup rendered blank.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/sessions/list.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-self', ownerLabel: 'su · self' })),
}));

// Keep SESSION_SOURCE_KINDS / disabledResult real (the tool's z.enum needs the
// former at module load); stub only the two read-path side effects.
vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshLiveSessionsBeforeRead: vi.fn(async () => ({ attempted: 1, refreshed: 1 })),
}));

const resolveSelfSession = vi.fn();
vi.mock('../../search/self-session', () => ({
  resolveSelfSession: (...a: unknown[]) => resolveSelfSession(...a),
}));

const tool = (await import('./list')).default;

interface ParsedResult {
  ok: boolean;
  mode?: string;
  count: number;
  total: number;
  hasMore: boolean;
  window?: { since?: string; until: string };
  nextCursor?: string;
  sessions: Array<{
    source_kind: string;
    session_id: string | null;
    turns: number;
    prompt_count: number;
    owner: string | null;
    active?: boolean;
    event_sources?: string[];
  }>;
}

/** A stand-in for ctx.tx — each tagged-template call returns the next queued
 *  result set. The handler calls it once for the main owner-filtered query and,
 *  when the fallback fires, once more for the owner-independent aggregate. */
function makeTx(results: unknown[][]) {
  let i = 0;
  const queries: string[] = [];
  const tx = vi.fn(async (strings: unknown) => {
    if (Array.isArray(strings)) queries.push(strings.join(' '));
    const r = results[i] ?? [];
    i += 1;
    return r;
  });
  return { tx, calledTimes: () => tx.mock.calls.length, queries };
}

function callTool(args: Record<string, unknown>, tx: unknown) {
  return (
    tool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, { workspaceId: 'default', tx });
}

async function run(args: Record<string, unknown>, results: unknown[][]) {
  const { tx, calledTimes, queries } = makeTx(results);
  const res = await callTool(args, tx);
  return { parsed: JSON.parse(res.content[0].text) as ParsedResult, txCalls: calledTimes(), queries };
}

describe('sessions:list EI-11403 active-session fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('declares and applies ownerId as a compatibility alias for owner', async () => {
    const parsedArgs = (tool as any).args.parse({ ownerId: 'self' });
    expect(parsedArgs.ownerId).toBe('self');

    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: 'sess-alias', filePath: '/x' });
    const { parsed, txCalls } = await run(
      { ownerId: 'self' },
      [
        [], // owner-filtered query → no indexed rows
        [{ turns: 0, prompt_count: 0, harness_slug: null, cwd: null, first_ts: null, last_ts: null }],
      ],
    );

    expect(txCalls).toBe(2);
    expect(parsed.sessions[0]).toMatchObject({
      source_kind: 'codex',
      session_id: 'sess-alias',
      owner: 'su-self',
      active: true,
    });
  });

  it('prefers canonical owner when owner and ownerId are both supplied', async () => {
    resolveSelfSession.mockResolvedValue(null);
    const { parsed } = await run(
      {
        owner: 'su-canonical',
        ownerId: 'su-alias',
      },
      [[
        {
          source_kind: 'codex',
          session_id: 'sess-canonical',
          turns: 1,
          prompt_count: 1,
          owner: 'su-canonical',
          harness_slug: null,
          cwd: null,
          first_ts: null,
          last_ts: null,
          response_count: null,
          tool_call_count: null,
          total_matching: 1,
        },
      ], []],
    );

    expect(parsed.sessions[0].owner).toBe('su-canonical');
    expect(resolveSelfSession).toHaveBeenCalledWith('su-canonical');
  });

  it("surfaces the caller's LIVE session even when its turns are indexed under another owner", async () => {
    // The owner filter finds nothing (turns stamped with a different owner), but
    // the session_id aggregate — the lens search/timeline use — finds the turns.
    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: 'sess-live', filePath: '/x' });
    const { parsed, txCalls } = await run(
      { owner: 'self', since: '2026-07-13T13:30:00Z' },
      [
        [], // main owner-filtered query → zero rows (the bug)
        [{ turns: 5, prompt_count: 2, harness_slug: 'papercusp', cwd: '/repo', first_ts: '2026-07-13T13:45:00-04:00', last_ts: '2026-07-13T14:10:00-04:00' }],
      ],
    );

    expect(txCalls).toBe(2); // main + fallback aggregate
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    const row = parsed.sessions.find((s) => s.session_id === 'sess-live');
    expect(row).toBeDefined();
    expect(row!.active).toBe(true);
    expect(row!.source_kind).toBe('codex');
    expect(row!.turns).toBe(5); // owner-independent count — matches what search sees
    expect(row!.owner).toBe('su-self');
  });

  it('returns an explicit active/unindexed row when the live session has no indexed turns yet', async () => {
    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: 'sess-fresh', filePath: '/x' });
    const { parsed } = await run(
      { owner: 'self' },
      [
        [], // main query → zero rows
        [{ turns: 0, prompt_count: 0, harness_slug: null, cwd: null, first_ts: null, last_ts: null }],
      ],
    );

    const row = parsed.sessions.find((s) => s.session_id === 'sess-fresh');
    expect(row).toBeDefined();
    expect(row!.active).toBe(true);
    expect(row!.turns).toBe(0);
  });

  it('does NOT double-list a live session already present in the owner-filtered result', async () => {
    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: 'sess-live', filePath: '/x' });
    const { parsed, txCalls } = await run(
      { owner: 'self' },
      [
        [{ source_kind: 'codex', session_id: 'sess-live', turns: 3, prompt_count: 1, owner: 'su-self', harness_slug: null, cwd: null, first_ts: null, last_ts: null, response_count: null, tool_call_count: null, total_matching: 1 }],
      ],
    );

    expect(txCalls).toBe(1); // no fallback aggregate — the session is already there
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].session_id).toBe('sess-live');
    expect(parsed.sessions[0].active).toBeUndefined();
    expect(parsed.count).toBe(1);
  });

  /* WI-37867 DELIBERATELY REVERSES the previous assertion here.
   *
   * This slot used to hold "scopes the fallback to owner:self — never runs for
   * another agent's owner", which pinned the restriction that CAUSED the bug: the
   * HUD conversation popup resolves an arbitrary agent's ownerId through this
   * tool, so scoping the fallback to 'self' meant a brand-new session (zero
   * indexed turns) resolved to null, the popup built no stream URL, and the chat
   * window rendered silently blank. The old test is not merely obsolete — it
   * asserted the defect. It is replaced, not deleted, so the reversal is legible.
   *
   * What that test was legitimately protecting — never fabricating a row, and not
   * paying for a fallback with nothing to find — is kept below.
   */
  it('surfaces a NAMED owner\'s live session that has produced ZERO indexed turns (WI-37867)', async () => {
    resolveSelfSession.mockResolvedValue(null); // no pty/discovery record for a peer
    const { parsed, txCalls } = await run(
      { owner: 'su-other' },
      [
        [], // main owner-filtered query → zero rows (no turns indexed yet)
        [{ agent: 'claude', session_id: 'sess-brand-new' }], // adv_sessions: live from launch
        [{ turns: 0, prompt_count: 0, harness_slug: null, cwd: null, first_ts: null, last_ts: null }],
      ],
    );

    expect(txCalls).toBe(3); // main + adv_sessions lookup + owner-independent aggregate
    const row = parsed.sessions.find((s) => s.session_id === 'sess-brand-new');
    expect(row).toBeDefined();
    expect(row!.active).toBe(true);
    expect(row!.source_kind).toBe('claude');
    expect(row!.turns).toBe(0); // zero turns is the POINT — not a reason to omit the row
    expect(parsed.count).toBe(1);
  });

  it('does NOT fabricate a row when the owner has no live session at all', async () => {
    resolveSelfSession.mockResolvedValue(null);
    const { parsed, txCalls } = await run(
      { owner: 'su-nobody' },
      [
        [], // main query → zero rows
        [], // adv_sessions → no live session
      ],
    );

    expect(txCalls).toBe(2); // main + adv lookup; no aggregate, nothing to aggregate
    expect(parsed.sessions).toHaveLength(0);
    expect(parsed.count).toBe(0);
  });

  it('ignores an adv_sessions row whose agent is not a known source kind', async () => {
    resolveSelfSession.mockResolvedValue(null);
    const { parsed } = await run(
      { owner: 'su-weird' },
      [
        [],
        [{ agent: 'not-a-real-client', session_id: 'sess-x' }],
      ],
    );

    expect(parsed.sessions).toHaveLength(0); // no lens for that kind — omit, don't guess
  });
});

describe('sessions:list historical bounded census', () => {
  it('requires an explicit finite [since, until) window', async () => {
    const { parsed, txCalls } = await run(
      { mode: 'historical', since: '2026-07-13T13:30:00Z' },
      [],
    );

    expect(txCalls).toBe(0);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(/requires valid ISO since and until bounds/);
  });

  it('unions all three append-only event legs and maps immutable evidence', async () => {
    const { parsed, txCalls, queries } = await run(
      {
        mode: 'historical',
        since: '2026-07-13T13:30:00Z',
        until: '2026-07-13T14:30:00Z',
      },
      [[
        {
          source_kind: 'codex',
          session_id: 'sess-historical',
          owner: 'su-historical',
          first_seen_at: '2026-07-01T10:00:00.000Z',
          first_event_at: '2026-07-13T13:35:00.000Z',
          last_event_at: '2026-07-13T14:20:00.000Z',
          event_count: 3,
          event_sources: ['agent_activity', 'session_turns', 'tool_invocations'],
          harness_slug: 'papercusp',
          cwd: '/repo',
          fleet_slug: 'fleet-a',
          fleet_role: 'member',
          model: 'gpt-5.6',
          effort: 'xhigh',
          total_matching: 1,
        },
      ]],
    );

    expect(txCalls).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('historical');
    expect(parsed.window).toEqual({ since: '2026-07-13T13:30:00.000Z', until: '2026-07-13T14:30:00.000Z' });
    expect(parsed.count).toBe(1);
    expect(parsed.sessions[0].event_sources).toEqual(['agent_activity', 'session_turns', 'tool_invocations']);

    const sql = queries[0];
    expect(sql).toContain('FROM harness_shared.session_turns');
    // Preserve the COALESCE(ts, ingested_at) semantics without hiding both
    // indexed timestamp columns from PostgreSQL's bounded-window planner.
    expect(sql).toContain('ts AS event_at');
    expect(sql).toContain('ts IS NULL');
    expect(sql).toContain('ingested_at AS event_at');
    expect(sql).toMatch(/ts\s*>=/);
    expect(sql).toMatch(/ingested_at\s*>=/);
    expect(sql).not.toMatch(/COALESCE\(ts,\s*ingested_at\)\s*>=/i);
    expect(sql).toContain('FROM harness_shared.agent_activity');
    expect(sql).toContain('FROM harness_shared.tool_invocations');
    expect(sql).toContain('coord_owner_id AS owner_id');
    expect(sql).toContain('fleet_membership_events');
    expect(sql).toContain('first_seen_at');
    expect(sql).toContain('launch_spec');
    expect(sql).toContain('>=');
    expect(sql).toContain('<');
    expect(sql).not.toMatch(/\bstarted_at\b/);
    expect(sql).not.toContain('spawn_id');
  });

  it('aggregates raw event keys before mapping and splits null/non-null session joins', async () => {
    const { queries } = await run(
      {
        mode: 'historical',
        since: '2026-07-13T13:30:00Z',
        until: '2026-07-13T14:30:00Z',
      },
      [[]],
    );

    const sql = queries[0];
    const rawEventGroups = sql.indexOf('raw_event_groups AS MATERIALIZED');
    const rawEventGroupBy = sql.indexOf('GROUP BY owner_id, session_id', rawEventGroups);
    const mapStart = sql.indexOf('session_map AS MATERIALIZED');
    const mapKeys = sql.indexOf('FROM raw_event_groups k', mapStart);
    const lateralLookup = sql.indexOf('LEFT JOIN LATERAL', mapKeys);
    const splitJoin = sql.indexOf('mapped_key_events AS', lateralLookup);
    const metricRollup = sql.indexOf('event_group_metrics AS', splitJoin);
    const sourceRollup = sql.indexOf('event_group_sources AS', metricRollup);
    const sessionLookupEnd = sql.indexOf(') a ON true', lateralLookup);
    const sessionLookup = sql.slice(lateralLookup, sessionLookupEnd);
    const sessionLookupSelect = sessionLookup.slice(0, sessionLookup.indexOf('FROM harness_shared.adv_sessions'));

    expect(rawEventGroups).toBeGreaterThanOrEqual(0);
    expect(rawEventGroupBy).toBeGreaterThan(rawEventGroups);
    expect(mapStart).toBeGreaterThanOrEqual(0);
    expect(mapStart).toBeGreaterThan(rawEventGroupBy);
    expect(mapKeys).toBeGreaterThan(mapStart);
    expect(lateralLookup).toBeGreaterThan(mapKeys);
    expect(splitJoin).toBeGreaterThan(lateralLookup);
    expect(metricRollup).toBeGreaterThan(splitJoin);
    expect(sourceRollup).toBeGreaterThan(metricRollup);
    expect(sql).toContain('WHERE k.session_id IS NOT NULL');
    expect(sql).toContain('WHERE k.session_id IS NULL');
    // The append-only event stream is scanned exactly once, inside the grouped CTE.
    expect(sql.match(/\bFROM raw_events\b/g)).toHaveLength(1);
    const rawEventScan = sql.search(/\bFROM raw_events\b/);
    expect(rawEventScan).toBeGreaterThan(rawEventGroups);
    expect(rawEventScan).toBeLessThan(rawEventGroupBy);
    expect(sql).not.toContain('a.raw_session_id IS NOT DISTINCT FROM e.session_id');
    expect(sql).toContain('sum(event_count)::int AS event_count');
    expect(sql).toContain('array_agg(DISTINCT source.event_source ORDER BY source.event_source) AS event_sources');
    expect(sessionLookup).toContain("FROM harness_shared.adv_sessions");
    expect(sessionLookupSelect).toContain("launch_spec->>'harnessSlug' AS harness_slug");
    expect(sessionLookupSelect).not.toMatch(/,\s*harness_slug\s*,/);
  });

  it('uses disjoint indexed lookups for known sessions and owner-only events', async () => {
    const { queries } = await run(
      {
        mode: 'historical',
        since: '2026-07-13T13:30:00Z',
        until: '2026-07-13T14:30:00Z',
      },
      [[]],
    );
    const sql = queries[0];
    const start = sql.indexOf('session_map AS MATERIALIZED');
    const lookup = sql.slice(start, sql.indexOf('mapped_key_events AS', start));

    // The nullable OR and CASE order caused a repeated lookup/sort for every
    // grouped key. Each disjoint branch must retain its own earliest-row limit.
    expect(lookup).toContain('k.session_id IS NOT NULL AND session_id = k.session_id');
    expect(lookup).toContain('coord_owner_id = k.owner_id AND k.session_id IS NULL');
    expect(lookup).toContain('UNION ALL');
    expect(lookup.match(/LIMIT 1/g)).toHaveLength(2);
    expect(lookup.match(/first_seen_at ASC NULLS LAST,\s*id ASC/g)).toHaveLength(2);
    expect(lookup).not.toMatch(/k\.session_id IS NULL OR session_id/);
    expect(lookup).not.toContain('ORDER BY CASE');
  });

  it('supports the historical compatibility alias while retaining the same bounds', async () => {
    const { parsed } = await run(
      {
        historical: true,
        since: '2026-07-13T13:30:00-04:00',
        until: '2026-07-13T14:30:00-04:00',
      },
      [[]],
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('historical');
    expect(parsed.window).toEqual({ since: '2026-07-13T17:30:00.000Z', until: '2026-07-13T18:30:00.000Z' });
  });

  it('rejects an inverted historical window before touching the database', async () => {
    const { parsed, txCalls } = await run(
      {
        mode: 'historical',
        since: '2026-07-13T14:30:00Z',
        until: '2026-07-13T13:30:00Z',
      },
      [],
    );

    expect(txCalls).toBe(0);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(/since must be earlier than until/);
  });

  // EI-21386375248907708: a relative window used to reach PostgreSQL raw and die
  // as `invalid input syntax for type timestamp with time zone: "3h"`.
  it('normalizes a RELATIVE window ("3h"/"1h") instead of feeding it to ::timestamptz', async () => {
    const before = Date.now();
    const { parsed, txCalls } = await run(
      { mode: 'historical', since: '3h', until: '1h' },
      [[]],
    );

    expect(txCalls).toBe(1);
    expect(parsed.ok).toBe(true);
    const w = parsed.window as { since: string; until: string };
    const sinceMs = Date.parse(w.since);
    const untilMs = Date.parse(w.until);
    expect(Math.abs(sinceMs - (before - 3 * 3_600_000))).toBeLessThan(10_000);
    expect(Math.abs(untilMs - (before - 1 * 3_600_000))).toBeLessThan(10_000);
  });

  it('rejects an unrecognized window value NAMING the accepted forms', async () => {
    const { parsed, txCalls } = await run({ since: 'yesterday-ish' }, []);
    expect(txCalls).toBe(0);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(/relative window like \\"45m\\", \\"12h\\", \\"7d\\"/);
  });
});
