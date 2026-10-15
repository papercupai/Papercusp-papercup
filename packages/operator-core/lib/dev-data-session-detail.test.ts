import { beforeEach, describe, expect, it, vi } from 'vitest';

// getSessionDetail's related_chats block (WI-5383: migrated off getLegacyClient)
// now reads via harnessQuery, while the spawned_agents / tool_invocations /
// children queries still go through getOrgPg()'s tagged-template `sql`. Mock
// both, spreading the real module so any OTHER export dev-data.ts imports from
// '@papercusp/db-org' keeps working (this module is a protected full-replacement-
// mock target per scripts/check-full-replacement-mocks.mjs). The tagged-template
// `sql` fake also carries a `.begin` stub — required by that same script's
// org-pg-sql-double guard (WI-40234), since production org clients support
// transactions even though this function never calls .begin.
const dbMocks = vi.hoisted(() => ({
  harnessQuery: vi.fn(),
  orgSql: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  harnessQuery: dbMocks.harnessQuery,
  getOrgPg: () => ({ sql: Object.assign(dbMocks.orgSql, { begin: vi.fn() }) }),
}));

import { getSessionDetail } from './dev-data';

// The spawned-agent path uses getOrgPg() for spawned_agents, tool_invocations,
// and children. Interactive and transcript-only paths add their resolver read.
const AGENT_ROW = {
  spawn_id: 'spawn-1',
  session_id: null,
  workspace_id: 'ws-1',
  harness_slug: 'papercusp',
  parent_spawn_id: null,
  parent_role: null,
  child_role: null,
  feature_id: 'F-100',
  chunk_id: null,
  run_id: null,
  status: 'ok',
  started_at: '2026-09-01T00:00:00.000Z',
  finished_at: null,
  duration_ms: null,
  exit_code: null,
  output_tail: null,
  error_message: null,
  cancel_requested: false,
};

describe('getSessionDetail related_chats', () => {
  const unsafe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    unsafe.mockResolvedValue([]);
    // harnessQuery's callback receives a postgres.js-shaped `sql` handle;
    // the related_chats block only calls `.unsafe(text, params)` on it, so a
    // fake exposing just that method is enough to observe what was sent.
    dbMocks.harnessQuery.mockImplementation(async (_slug: string, fn: any) => fn({ unsafe }));
    dbMocks.orgSql
      .mockResolvedValueOnce([AGENT_ROW]) // spawned_agents
      .mockResolvedValueOnce([]) // tool_invocations
      .mockResolvedValueOnce([]); // children
  });

  it('queries agent_chats by feature_id and converts the bigint epoch-ms updated_at to an ISO string', async () => {
    unsafe.mockResolvedValueOnce([
      { id: 'chat-1', role: 'planner', title: 'Plan A', updated_at: 1788400000000n },
    ]);

    const detail = await getSessionDetail('spawn-1');

    expect(dbMocks.harnessQuery).toHaveBeenCalledWith('papercusp', expect.any(Function));
    const sql = String(unsafe.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
    expect(sql).toContain('FROM agent_chats WHERE feature_id = $1');
    // Direct-mode regression: the same single positional bind the old
    // `.prepare(...).all(agent.feature_id)` (`?` placeholder) sent — proving
    // the `?` -> `$1` translation preserved both the SQL text and the bind.
    expect(unsafe.mock.calls[0]?.[1]).toEqual(['F-100']);
    expect(detail?.related_chats).toEqual([
      {
        id: 'chat-1',
        role: 'planner',
        title: 'Plan A',
        updated_at: new Date(1788400000000).toISOString(),
      },
    ]);
  });

  it('maps a null updated_at to an empty string rather than throwing', async () => {
    unsafe.mockResolvedValueOnce([
      { id: 'chat-2', role: 'worker', title: null, updated_at: null },
    ]);

    const detail = await getSessionDetail('spawn-1');

    expect(detail?.related_chats).toEqual([
      { id: 'chat-2', role: 'worker', title: null, updated_at: '' },
    ]);
  });

  it('swallows a query failure and returns an empty related_chats list (behavior unchanged from the getLegacyClient path)', async () => {
    unsafe.mockRejectedValueOnce(new Error('boom'));

    const detail = await getSessionDetail('spawn-1');

    expect(detail?.related_chats).toEqual([]);
  });

  it('skips the harnessQuery lookup entirely when the agent has no feature_id', async () => {
    dbMocks.orgSql.mockReset();
    dbMocks.orgSql
      .mockResolvedValueOnce([{ ...AGENT_ROW, feature_id: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const detail = await getSessionDetail('spawn-1');

    expect(dbMocks.harnessQuery).not.toHaveBeenCalled();
    expect(detail?.related_chats).toEqual([]);
  });

  it('resolves an interactive native session id through adv_sessions and owner activity', async () => {
    dbMocks.orgSql.mockReset();
    dbMocks.orgSql
      .mockResolvedValueOnce([]) // no spawned_agents row for an interactive session
      .mockResolvedValueOnce([
        {
          session_id: 'codex-session-1',
          omp_thread_id: null,
          coord_owner_id: 'su-owner-1',
          started_at: '2026-09-13T00:00:00.000Z',
          ended_at: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: '42',
          tool_name: 'coord:orient',
          invoked_at: '2026-09-13T00:10:00.000Z',
          duration_ms: 10,
          status: 'ok',
          error_message: null,
          args_json: {},
        },
      ]);

    const detail = await getSessionDetail('codex-session-1');

    expect(detail).toMatchObject({
      spawn_id: 'codex-session-1',
      session_id: 'codex-session-1',
      omp_thread_id: null,
      coord_owner_id: 'su-owner-1',
      agent: null,
      children: [],
    });
    expect(detail?.invocations).toHaveLength(1);
    expect(detail?.invocations[0]?.tool_name).toBe('coord:orient');
    const invocationCall = dbMocks.orgSql.mock.calls[2];
    const invocationTemplate = invocationCall?.[0] as TemplateStringsArray | undefined;
    const invocationSql = invocationTemplate
      ?.reduce((query, part, index) => `${query}${index ? `$${index}` : ''}${part}`, '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(invocationSql).not.toContain('invoked_at <=');
    expect(invocationCall?.slice(1)).toEqual([
      'su-owner-1',
      '2026-09-13T00:00:00.000Z',
    ]);
  });

  it('bounds an ended interactive session with its typed end timestamp', async () => {
    dbMocks.orgSql.mockReset();
    dbMocks.orgSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          session_id: 'codex-session-ended',
          omp_thread_id: null,
          coord_owner_id: 'su-owner-1',
          started_at: '2026-09-13T00:00:00.000Z',
          ended_at: '2026-09-13T01:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([]);

    await getSessionDetail('codex-session-ended');

    const invocationCall = dbMocks.orgSql.mock.calls[2];
    const invocationTemplate = invocationCall?.[0] as TemplateStringsArray | undefined;
    const invocationSql = invocationTemplate
      ?.reduce((query, part, index) => `${query}${index ? `$${index}` : ''}${part}`, '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(invocationSql).toContain('invoked_at <= $3');
    expect(invocationCall?.slice(1)).toEqual([
      'su-owner-1',
      '2026-09-13T00:00:00.000Z',
      '2026-09-13T01:00:00.000Z',
    ]);
  });

  it('resolves a headless native session id to its canonical spawn id', async () => {
    dbMocks.orgSql.mockReset();
    dbMocks.orgSql
      .mockResolvedValueOnce([{ ...AGENT_ROW, spawn_id: 'spawn-2', session_id: 'claude-session-2' }])
      .mockResolvedValueOnce([]) // tool_invocations
      .mockResolvedValueOnce([]); // children

    const detail = await getSessionDetail('claude-session-2');

    expect(detail).toMatchObject({
      spawn_id: 'spawn-2',
      session_id: 'claude-session-2',
      coord_owner_id: null,
    });
    expect(dbMocks.orgSql.mock.calls[0]?.slice(1)).toContain('claude-session-2');
  });

  it('resolves transcript-only tool invocations through historical session event sources and time bounds', async () => {
    dbMocks.orgSql.mockReset();
    dbMocks.orgSql
      .mockResolvedValueOnce([]) // no spawned_agents row
      .mockResolvedValueOnce([]) // no adv_sessions row
      .mockResolvedValueOnce([
        {
          owner: 'su-owner-transcript',
          started_at: '2026-09-13T00:00:00.000Z',
          ended_at: '2026-09-13T00:30:00.000Z',
        },
      ]) // historical session events resolve the owner and this session's time bounds
      .mockResolvedValueOnce([
        {
          id: '43',
          tool_name: 'work_items:get',
          invoked_at: '2026-09-13T00:10:00.000Z',
          duration_ms: 14,
          status: 'ok',
          error_message: null,
          args_json: { id: 'WI-1' },
        },
      ]) // tool_invocations by transcript owner + session window
      .mockResolvedValueOnce([]); // no child spawns

    const detail = await getSessionDetail('codex-session-from-transcript');

    expect(detail).toMatchObject({
      spawn_id: 'codex-session-from-transcript',
      session_id: 'codex-session-from-transcript',
      omp_thread_id: null,
      coord_owner_id: 'su-owner-transcript',
      agent: null,
      invocations: [
        {
          id: '43',
          tool_name: 'work_items:get',
          invoked_at: '2026-09-13T00:10:00.000Z',
          duration_ms: 14,
          status: 'ok',
          error_message: null,
          args_json: { id: 'WI-1' },
        },
      ],
      children: [],
      related_chats: [],
    });

    const partsCall = dbMocks.orgSql.mock.calls[2];
    const partsSql = partsCall?.[0] as TemplateStringsArray | undefined;
    const query = partsSql?.join(' ') ?? '';
    expect(query).toContain('FROM harness_shared.session_turn_parts');
    expect(query).toContain("workspace_id = 'default'");
    expect(query).toContain("source_kind IN ('claude', 'omp', 'codex')");
    expect(query).toContain('MIN(COALESCE(ts, ingested_at))');
    expect(query).toContain('MAX(COALESCE(ts, ingested_at))');
    expect(query).toContain('GROUP BY source_kind, owner');
    expect(query).toContain('FROM harness_shared.session_turns');
    expect(query).toContain('FROM harness_shared.agent_activity');
    expect(partsCall?.slice(1)).toEqual([
      'codex-session-from-transcript',
      'codex-session-from-transcript',
      'codex-session-from-transcript',
    ]);

    const invocationCall = dbMocks.orgSql.mock.calls[3];
    const invocationTemplate = invocationCall?.[0] as TemplateStringsArray | undefined;
    const invocationSql = invocationTemplate
      ?.reduce((statement, part, index) => `${statement}${index ? `$${index}` : ''}${part}`, '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(invocationSql).toContain('WHERE coord_owner_id = $1');
    expect(invocationSql).toContain('invoked_at >= $2');
    expect(invocationSql).toContain('invoked_at <= $3');
    expect(invocationSql).not.toContain('WHERE spawn_id =');
    expect(invocationCall?.slice(1)).toEqual([
      'su-owner-transcript',
      '2026-09-13T00:00:00.000Z',
      '2026-09-13T00:30:00.000Z',
    ]);
  });

  it('keeps unknown ids unresolved when no transcript part exists', async () => {
    dbMocks.orgSql.mockReset();
    dbMocks.orgSql
      .mockResolvedValueOnce([]) // no spawned_agents row
      .mockResolvedValueOnce([]) // no adv_sessions row
      .mockResolvedValueOnce([]) // no transcript part
      .mockResolvedValueOnce([]) // no tool_invocations row by spawn id
      .mockResolvedValueOnce([]); // no child spawns

    await expect(getSessionDetail('unknown-session')).resolves.toBeNull();
  });
});
