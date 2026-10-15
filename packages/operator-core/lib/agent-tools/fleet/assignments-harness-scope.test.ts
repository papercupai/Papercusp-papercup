/**
 * assignments-harness-scope.test.ts — regression for EI-6176.
 *
 * `fleet:assignments`'s plan-item coverage rollup ignored a passed `harness`
 * filter entirely: every OTHER section of the read (rows/agents) is queried
 * `WHERE harness_slug = args.harness`, but the coverage rollup fused EVERY
 * plan's coverage regardless of harness. A hive-confined caller like
 * `fleet:assignments { harness: 'oddsmith' }` — whose direct tool calls to a
 * sibling hive's harness are already rejected (`harness_forbidden`) — still
 * saw that sibling hive's plan-item coverage leak straight through the
 * coverage[] rollup. Fixed by scoping the rollup to `planSlugsForHarness`
 * when `args.harness` is set and `args.plan` is not.
 *
 * This pins the fix with an injected coverage map spanning two harnesses'
 * plans, mirroring assignments-workspace-scope.test.ts's mock-the-IO-seam
 * pattern (no PG needed).
 */
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';
import { getAllPlanItemCoverage, type PlanItemCoverage } from '../../plan-item-coverage';

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
vi.mock('../coordination/context-pressure', () => ({ fetchContextPressure: vi.fn(async () => new Map()) }));
vi.mock('../coordination/unanswered-directed', () => ({ fetchUnansweredDirected: vi.fn(async () => new Map()) }));
vi.mock('../coordination/inbox-read-freshness', () => ({
  classifyCoordDeafness: vi.fn(() => null),
  coordDeafBudgetMs: vi.fn(() => 900_000),
  lastInboxReadAtBatch: vi.fn(async () => new Map()),
}));
vi.mock('../../harness/routines/loop', () => ({ getLoopStatuses: vi.fn(async () => new Map()) }));
vi.mock('../plans/effective-status', () => ({ resolveEffectiveStatusForItems: vi.fn(async () => new Map()) }));

const planSlugsForHarnessMock = vi.fn(async (_workspaceId: string, harnessSlug: string) => {
  if (harnessSlug === 'oddsmith') return new Set(['oddsmith-plan']);
  if (harnessSlug === 'papercusp') return new Set(['papercusp-plan']);
  return new Set<string>();
});
vi.mock('../plans/source', () => ({
  getPlanRow: vi.fn(async () => null),
  planItemsForRow: vi.fn(() => []),
  planSlugsForHarness: (workspaceId: string, harnessSlug: string) =>
    planSlugsForHarnessMock(workspaceId, harnessSlug),
}));

// PARTIAL mock (importOriginal) — see WI-6035. A closed factory silently reds
// this file whenever fleet/assignments.ts gains an export it does not list; the
// spread makes any un-stubbed export fall through to the real implementation.
vi.mock('../../fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/assignments')>()),
  listFleetAssignments: vi.fn(async () => []),
  groupByAgent: vi.fn(() => []),
  lastToolCallAtByOwner: vi.fn(async () => new Map()),
  lastProductiveToolCallAtByOwner: vi.fn(async () => new Map()),
  orphanedClaims: vi.fn(() => []),
  stalledClaims: vi.fn(() => []),
  summarizeOrphan: vi.fn((r: unknown) => r),
  isReclaimCandidate: vi.fn(() => false),
}));

function cov(ref: string): PlanItemCoverage {
  return {
    ref,
    links: [],
    directlyClaimed: true,
    directHolder: 'someone',
    directActivity: 'alive',
    // P-029/D-060 made `holder` required on PlanItemCoverage — the claim's holder
    // WITH its declared goal, so a reader browsing what is taken need not collide
    // with the holder to learn why. Mirrors directHolder for this fixture.
    holder: { ownerId: 'someone', ownerLabel: null, goalText: null, declaredAt: null, stale: null },
    level: 'partial',
    workers: ['someone'],
    lastActivityAt: new Date(),
  };
}

// Two harnesses' plan-item coverage in the SAME fused map — exactly the shape
// getAllPlanItemCoverage returns workspace-wide (it has no harness concept of
// its own; scoping is the caller's job, per the fix).
const coverageMap = new Map<string, PlanItemCoverage>([
  ['oddsmith-plan#item1', cov('oddsmith-plan#item1')],
  ['papercusp-plan#item1', cov('papercusp-plan#item1')],
]);
vi.mock('../../plan-item-coverage', () => ({
  getAllPlanItemCoverage: vi.fn(async () => coverageMap),
  compactCoverage: vi.fn((c: PlanItemCoverage) => ({ level: c.level, workers: c.workers, links: [] })),
  coverageCollisions: vi.fn(() => []),
  duplicateCoverage: vi.fn(() => []),
}));

import fleetAssignmentsTool from './assignments';

const ctx = { workspaceId: 'ws-real' } as unknown as Parameters<typeof fleetAssignmentsTool.handler>[1];

beforeEach(() => {
  vi.clearAllMocks();
  planSlugsForHarnessMock.mockImplementation(async (_workspaceId: string, harnessSlug: string) => {
    if (harnessSlug === 'oddsmith') return new Set(['oddsmith-plan']);
    if (harnessSlug === 'papercusp') return new Set(['papercusp-plan']);
    return new Set<string>();
  });
});

describe('fleet:assignments — EI-6176 harness-scoped coverage regression', () => {
  it('a { harness } filter narrows coverage[] to that harness\'s OWN plans only', async () => {
    const res = (await fleetAssignmentsTool.handler({ harness: 'oddsmith' } as never, ctx)) as {
      data: { coverage?: { plan: string; item: string }[] };
    };
    const plans = (res.data.coverage ?? []).map((c) => c.plan);
    expect(plans).toContain('oddsmith-plan');
    expect(plans).not.toContain('papercusp-plan');
  });

  it('the OTHER harness is symmetrically scoped (not a one-sided fix)', async () => {
    const res = (await fleetAssignmentsTool.handler({ harness: 'papercusp' } as never, ctx)) as {
      data: { coverage?: { plan: string; item: string }[] };
    };
    const plans = (res.data.coverage ?? []).map((c) => c.plan);
    expect(plans).toContain('papercusp-plan');
    expect(plans).not.toContain('oddsmith-plan');
  });

  it('no { harness } filter keeps today\'s unrestricted, workspace-wide coverage', async () => {
    const res = (await fleetAssignmentsTool.handler({} as never, ctx)) as {
      data: { coverage?: { plan: string; item: string }[] };
    };
    const plans = (res.data.coverage ?? []).map((c) => c.plan);
    expect(plans).toContain('oddsmith-plan');
    expect(plans).toContain('papercusp-plan');
  });

  it('an explicit { plan } still wins outright over the harness scope', async () => {
    const res = (await fleetAssignmentsTool.handler(
      { harness: 'oddsmith', plan: 'papercusp-plan' } as never,
      ctx,
    )) as {
      data: { coverage?: { plan: string; item: string }[] };
    };
    const plans = (res.data.coverage ?? []).map((c) => c.plan);
    expect(plans).toContain('papercusp-plan');
    expect(plans).not.toContain('oddsmith-plan');
    expect(getAllPlanItemCoverage).toHaveBeenCalledWith({ planSlug: 'papercusp-plan' });
  });
});
