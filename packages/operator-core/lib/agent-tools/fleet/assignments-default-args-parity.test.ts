/**
 * assignments-default-args-parity.test.ts — regression for EI-5987.
 *
 * Incident: a Queen wake's FIRST `fleet:assignments { harness }` call (default
 * args — include_lapsed/include_stale both omitted, i.e. false) returned
 * summary.agents=0/alive=0 (fully empty), while a SECOND call one minute later
 * with `{ include_lapsed: true, include_stale: true }` returned the same 5
 * genuinely-live agents with fresh heartbeats and active work-item claims —
 * nearly causing a double-placement onto work those agents already held.
 *
 * `include_lapsed`/`include_stale` are documented to only ADD extra lapsed/stale
 * rows on top of the default read — they must never make a live, actively-claimed
 * agent disappear. This test pins that invariant directly at the tool-handler
 * level: for a fixed set of live+claimed agents, the default-args read and the
 * fully-inclusive read must agree on `summary.agents`/`summary.alive` and on the
 * returned agent-id set.
 *
 * (Root-cause note, EI-5987 completion: the codebase already carries three
 * later, more specific fixes for exactly this failure class — EI-13820's
 * resolveConcreteWorkspaceId '*'-sentinel fix, EI-8106's recorded-live
 * bootstrap-window fix, and EI-6374's ended-holder heartbeat-lag fix — each
 * with its own passing regression test, plus a real-Postgres
 * immediate-write-then-read integration test with zero induced delay
 * (assignments.integration.test.ts: "unifies presence, plan-item claims, and
 * work-item claims in one read"). This test adds the one invariant those
 * fixes didn't yet pin explicitly: default-args/inclusive-args PARITY for a
 * live+claimed agent set.)
 */
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  readJsonResult: () => undefined,
}));
vi.mock('../coordination/identity', () => ({
  // A concrete, already-scoped workspace (not the '*' unscoped sentinel —
  // that class is EI-13820's own regression file) so this test isolates the
  // include_lapsed/include_stale parity invariant specifically.
  resolveAgentIdentity: () => ({
    ownerId: 'su-queen',
    ownerLabel: 'q',
    source: 'static-client',
    workspaceId: 'papercusp-workspace',
    userId: null,
  }),
}));
vi.mock('../coordination/self-marker', () => ({
  resolveSelfRef: () => null,
  markSelfRows: (rows: unknown[]) => rows,
}));
vi.mock('../coordination/presence-wakeability', () => ({ fetchWakeability: vi.fn(async () => new Map()) }));
vi.mock('../coordination/presence', async (original) => ({
  ...(await original<typeof import('../coordination/presence')>()),
  listPresence: vi.fn(async () => []),
}));
vi.mock('../coordination/presence-selfwake', async (original) => ({
  ...(await original<typeof import('../coordination/presence-selfwake')>()),
  fetchSelfWake: vi.fn(async () => new Map()),
}));
vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()),
  recordedLiveOwnerIds: vi.fn(async () => new Set()),
  endedRecordedOwnerIds: vi.fn(async () => new Set()),
}));
vi.mock('../coordination/wake-mode', () => ({
  getWakeModeOverridesFor: vi.fn(async () => new Map()),
  getDefaultWakeMode: vi.fn(async () => 'auto'),
  resolveWakeModeFrom: vi.fn(() => 'auto'),
}));
vi.mock('../../plan-item-coverage', () => ({
  getAllPlanItemCoverage: vi.fn(async () => new Map()),
  compactCoverage: vi.fn((c: unknown) => c),
  coverageCollisions: vi.fn(() => []),
}));
vi.mock('../../events/await/store', () => ({ listParkedAwaitsForSubscribers: vi.fn(async () => []) }));
// The schedulerClaimState decoration reads claim concurrency from PG (WI-6554700010008335); keep it
// off the real-PG rail exactly as assignments-bounded.test.ts does.
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/claim-spec-store')>()),
  readClaimConcurrencyBatch: vi.fn(async () => new Map()),
}));
vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressure: vi.fn(async () => new Map()),
  fetchContextPressureReadings: vi.fn(async () => new Map()),
}));
vi.mock('../coordination/unanswered-directed', () => ({ fetchUnansweredDirected: vi.fn(async () => new Map()) }));
vi.mock('../coordination/inbox-read-freshness', () => ({
  classifyCoordDeafness: vi.fn(() => null),
  coordDeafBudgetMs: vi.fn(() => 900_000),
  lastInboxReadAtBatch: vi.fn(async () => new Map()),
}));
vi.mock('../../harness/routines/loop', () => ({ getLoopStatuses: vi.fn(async () => new Map()) }));
vi.mock('../plans/source', async (original) => ({
  ...(await original<typeof import('../plans/source')>()),
  planSlugsForHarness: vi.fn(async () => new Set<string>()),
}));

/** Five genuinely-live agents, each holding one fresh, active work-item claim —
 *  the exact incident shape (heartbeats seconds old, claims acquired seconds
 *  ago). `listFleetAssignments` (the real DB reader) is a fixed-output mock
 *  here: a real Postgres read of committed rows is opts-independent for this
 *  shape (proven separately by the real-PG integration suite), so pinning the
 *  TOOL's own post-read filtering against a fixed row set is the correct unit
 *  boundary for this invariant. */
const capturedOpts: unknown[] = [];
function liveClaimedRow(n: number) {
  const now = new Date().toISOString();
  return {
    source: 'work_item_claim',
    workspaceId: 'papercusp-workspace',
    agentId: `su-bee-${n}`,
    agentLabel: null,
    agentName: null,
    harnessSlug: 'papercusp',
    planSlug: null,
    itemId: null,
    workItemId: `WI-${1000 + n}`,
    itemKind: 'bug',
    detail: `work item ${n}`,
    status: 'wip',
    claimAcquiredTs: now,
    claimExpiresTs: null,
    claimActive: true,
    livenessMode: null,
    lastActivityTs: now,
    holderPresent: true,
    holderAlive: true,
    holderHeartbeatAt: now,
    holderIntent: null,
    holderPlanSlug: null,
    orphaned: false,
    declaredPlanMatches: null,
    assigneeRank: null,
    rankWriter: null,
    fleetSlug: null,
    fleetRole: null,
    stalled: false,
  };
}
const FIXED_ROWS = Array.from({ length: 5 }, (_, i) => liveClaimedRow(i + 1));

vi.mock('../../fleet/assignments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../fleet/assignments')>();
  return {
    ...actual,
    listFleetAssignments: vi.fn(async (opts: unknown) => {
      capturedOpts.push(opts);
      return FIXED_ROWS;
    }),
    lastToolCallAtByOwner: vi.fn(async () => new Map()),
    lastProductiveToolCallAtByOwner: vi.fn(async () => new Map()),
  };
});

import fleetAssignmentsTool from './assignments';

const ctx = { workspaceId: 'papercusp-workspace' } as unknown as Parameters<
  typeof fleetAssignmentsTool.handler
>[1];

beforeEach(() => {
  vi.clearAllMocks();
  capturedOpts.length = 0;
});

describe('fleet:assignments — EI-5987 default-args/inclusive-args parity', () => {
  it('a default-args read surfaces every live+claimed agent (never a false empty)', async () => {
    const res = (await fleetAssignmentsTool.handler({ harness: 'papercusp' } as never, ctx)) as {
      data: { summary: { agents: number; alive: number }; agents: Array<{ agentId: string }> };
    };
    expect(res.data.summary.agents).toBe(5);
    expect(res.data.summary.alive).toBe(5);
    expect(res.data.agents.map((a) => a.agentId).sort()).toEqual(
      ['su-bee-1', 'su-bee-2', 'su-bee-3', 'su-bee-4', 'su-bee-5'].sort(),
    );
  });

  it('include_lapsed+include_stale=true agrees with the default-args read for the same live+claimed set (the exact incident diff)', async () => {
    const defaultRes = (await fleetAssignmentsTool.handler({ harness: 'papercusp' } as never, ctx)) as {
      data: { summary: { agents: number; alive: number }; agents: Array<{ agentId: string }> };
    };
    const inclusiveRes = (await fleetAssignmentsTool.handler(
      { harness: 'papercusp', include_lapsed: true, include_stale: true } as never,
      ctx,
    )) as { data: { summary: { agents: number; alive: number }; agents: Array<{ agentId: string }> } };

    expect(inclusiveRes.data.summary).toEqual(defaultRes.data.summary);
    expect(inclusiveRes.data.agents.map((a) => a.agentId).sort()).toEqual(
      defaultRes.data.agents.map((a) => a.agentId).sort(),
    );
  });
});
