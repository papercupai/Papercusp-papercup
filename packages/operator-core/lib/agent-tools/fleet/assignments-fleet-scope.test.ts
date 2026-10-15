/**
 * assignments-fleet-scope.test.ts — regression for EI-18689331932953939.
 *
 * `fleet:assignments` rejected a `fleet` argument outright ("Unrecognized key:
 * fleet") even though the tool lives in the `fleet:` namespace and every row
 * already carries `fleet_slug` — the one obvious per-fleet scope a fleet
 * leader/member reaches for ("who's on fleet F") had no way to express itself,
 * forcing a `plan` filter that only coincides with the fleet when it happens
 * to be working exactly one plan.
 *
 * Pins: (1) the zod schema now ACCEPTS a `fleet` key instead of throwing, and
 * (2) it is threaded straight through to `listFleetAssignments` — the data
 * layer's own `fleet_slug = $fleet` WHERE clause is exercised at the SQL level
 * by fleet/assignments.integration.test.ts's existing plan/agent/harness
 * filter coverage (identical WHERE-clause shape); this file mocks that seam
 * (no PG needed), mirroring assignments-workspace-scope.test.ts's pattern.
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
const getFleetMock = vi.fn(async (..._args: unknown[]) => null as unknown);
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  getFleet: (...a: unknown[]) => getFleetMock(...a),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({
    ownerId: 'su-leader',
    ownerLabel: 'l',
    source: 'static-client',
    workspaceId: 'ws-real',
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
vi.mock('../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../adv-sessions')>()),
  recordedLiveOwnerIds: vi.fn(async () => new Set()),
  endedRecordedOwnerIds: vi.fn(async () => new Set()),
}));
vi.mock('../coordination/wake-mode', () => ({
  getWakeModeOverridesFor: vi.fn(async () => new Map()),
  getDefaultWakeMode: vi.fn(async () => 'auto'),
  resolveWakeModeFrom: vi.fn(() => 'auto'),
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
vi.mock('../plans/effective-status', () => ({ resolveEffectiveStatusForItems: vi.fn(async () => new Map()) }));
vi.mock('../plans/source', () => ({
  getPlanRow: vi.fn(async () => null),
  planItemsForRow: vi.fn(() => []),
  planSlugsForHarness: vi.fn(async () => new Set<string>()),
}));
vi.mock('../../plan-item-coverage', () => ({
  getAllPlanItemCoverage: vi.fn(async () => new Map()),
  compactCoverage: vi.fn((c: unknown) => c),
  coverageCollisions: vi.fn(() => []),
}));

// vitest 4 infers a vi.fn mock's Parameters from its initial implementation —
// a zero-arg arrow made spreading `...a` (below, into the mocked module's
// wrapper) fail to typecheck (TS2556: a spread argument must have a tuple
// type or hit a rest parameter). A rest param keeps the mock body identical
// while accepting the wrapper's forwarded args.
const listFleetAssignmentsMock = vi.fn(async (..._args: unknown[]) => []);
const groupByAgentMock = vi.fn((..._args: unknown[]) => [] as unknown[]);
// PARTIAL mock (importOriginal), not a closed factory: anything this file does
// not deliberately stub falls through to the REAL module. A closed factory has
// to be hand-edited every time fleet/assignments.ts gains an export, and when it
// isn't, unrelated tests red with "No <export> is defined on the mock" — which is
// exactly how reconcileOrphanedWithVerdicts red-pinned this file and its two
// siblings without anyone touching them (WI-6035). The explicit stubs below still
// override precisely what they name, so the behaviour under test is unchanged.
vi.mock('../../fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/assignments')>()),
  listFleetAssignments: (...a: unknown[]) => listFleetAssignmentsMock(...a),
  groupByAgent: (...a: unknown[]) => groupByAgentMock(...a),
  lastToolCallAtByOwner: vi.fn(async () => new Map()),
  lastProductiveToolCallAtByOwner: vi.fn(async () => new Map()),
  orphanedClaims: vi.fn(() => []),
  stalledClaims: vi.fn(() => []),
  summarizeOrphan: vi.fn((r: unknown) => r),
  isReclaimCandidate: vi.fn(() => false),
}));

import fleetAssignmentsTool from './assignments';
import { fleetSlugFromName } from '../../agent-fleets-store';

const ctx = { workspaceId: 'ws-real' } as unknown as Parameters<typeof fleetAssignmentsTool.handler>[1];

beforeEach(() => {
  vi.clearAllMocks();
  getFleetMock.mockImplementation(async (...args: unknown[]) => ({ fleetSlug: String(args[1]) }));
  listFleetAssignmentsMock.mockResolvedValue([]);
  groupByAgentMock.mockReturnValue([]);
});

describe('fleet:assignments — EI-18689331932953939 fleet-scoped read', () => {
  it('a { fleet } arg is ACCEPTED by the schema — the pre-fix rejection is gone', () => {
    expect(() => fleetAssignmentsTool.args.parse({ fleet: 'gui-chat-controls' })).not.toThrow();
  });

  it('{ fleet } is threaded straight through to listFleetAssignments', async () => {
    await fleetAssignmentsTool.handler({ fleet: 'gui-chat-controls' } as never, ctx);
    expect(listFleetAssignmentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ fleet: 'gui-chat-controls' }),
    );
  });

  it('resolves the untruncated launch name to its persisted slug before filtering', async () => {
    const launchName = 'papercusp-session-transcript-exact-fuzzy-search-2026-09-14-plan-fleet';
    const slug = fleetSlugFromName(launchName);
    await fleetAssignmentsTool.handler({ fleet: launchName } as never, ctx);

    expect(getFleetMock).toHaveBeenCalledWith('ws-real', slug);
    expect(listFleetAssignmentsMock).toHaveBeenCalledWith(expect.objectContaining({ fleet: slug }));
  });

  it('returns unknown_fleet instead of a measured-empty roster for an unresolved name', async () => {
    getFleetMock.mockResolvedValueOnce(null);
    const result = (await fleetAssignmentsTool.handler(
      { fleet: 'does-not-exist' } as never,
      ctx,
    )) as { data?: Record<string, unknown> };

    expect(result.data).toMatchObject({ ok: false, error: 'unknown_fleet', fleet: 'does-not-exist' });
    expect(listFleetAssignmentsMock).not.toHaveBeenCalled();
  });

  it('omitting { fleet } passes undefined — byte-identical to pre-fix behavior', async () => {
    await fleetAssignmentsTool.handler({} as never, ctx);
    expect(listFleetAssignmentsMock).toHaveBeenCalledWith(expect.objectContaining({ fleet: undefined }));
  });

  it('{ fleet } composes with an independent { plan } filter (both threaded through, no collision)', async () => {
    await fleetAssignmentsTool.handler({ fleet: 'gui-chat-controls', plan: 'some-plan' } as never, ctx);
    expect(listFleetAssignmentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ fleet: 'gui-chat-controls', plan: 'some-plan' }),
    );
  });

  it('explicit payloadTier:"full" bypasses the handler-owned agent trim', async () => {
    const agents = Array.from({ length: 8 }, (_, index) => ({
      agentId: `su-agent-${index}`,
      label: null,
      name: null,
      present: true,
      alive: true,
      heartbeatAt: new Date().toISOString(),
      intent: 'i'.repeat(4_000),
      declaredPlanSlug: null,
      fleetSlug: 'gui-chat-controls',
      fleetRole: 'member',
      claims: [],
      orphaned: false,
      stalled: false,
      declaredUnclaimed: false,
      doing: null,
      queued: Array.from({ length: 8 }, (_, queuedIndex) => ({
        id: `WI-${index}-${queuedIndex}`,
        title: 'q'.repeat(300),
      })),
      load: 0,
    }));
    groupByAgentMock.mockReturnValue(agents);

    const ordinary = (await fleetAssignmentsTool.handler({}, ctx)) as {
      data: { agents: unknown[]; agents_truncated?: boolean };
    };
    expect(ordinary.data.agents_truncated).toBe(true);
    expect(ordinary.data.agents.length).toBeLessThan(agents.length);

    const full = (await fleetAssignmentsTool.handler(
      {},
      { ...ctx, payloadTierOverride: 'full' } as never,
    )) as {
      data: {
        agents: Array<{ intent: string; queued: unknown[] }>;
        agents_truncated?: boolean;
      };
    };
    expect(full.data.agents_truncated).toBeUndefined();
    expect(full.data.agents).toHaveLength(agents.length);
    expect(full.data.agents[0]?.intent).toHaveLength(4_000);
    expect(full.data.agents[0]?.queued).toHaveLength(8);
  });
});
