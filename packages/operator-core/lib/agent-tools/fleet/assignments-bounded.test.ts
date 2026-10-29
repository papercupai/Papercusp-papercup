/**
 * Handler regressions for EI-21526112676676081.
 *
 * `fleet:assignments` is a supervisory read. A wedged roster query must return
 * an explicitly degraded response before the MCP deadline, and independent
 * enrichment reads must start together rather than serially consuming that
 * deadline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFleet: vi.fn(),
  listAssignments: vi.fn(),
  coverage: vi.fn(),
  wakeability: vi.fn(),
  recordedLive: vi.fn(),
  selfWake: vi.fn(),
  recordedEnded: vi.fn(),
  parkedOn: vi.fn(),
  contextPressure: vi.fn(),
  unanswered: vi.fn(),
  loopStatuses: vi.fn(),
  lastToolCalls: vi.fn(),
  productiveToolCalls: vi.fn(),
  schedulerClaims: vi.fn(),
  wakeModeOverrides: vi.fn(),
  defaultWakeMode: vi.fn(),
  getPlanRow: vi.fn(),
  residue: vi.fn(),
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (definition: unknown) => definition,
  readJsonResult: () => undefined,
}));
vi.mock('../coordination/roles', () => ({ COORD_READ_ROLES: ['operator'] }));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  getFleet: mocks.getFleet,
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({
    ownerId: 'su-test',
    ownerLabel: 'test',
    source: 'static-client',
    workspaceId: 'papercusp-workspace',
    userId: null,
  }),
}));
vi.mock('../coordination/self-marker', () => ({
  resolveSelfRef: () => null,
  markSelfRows: (rows: unknown[]) => rows,
}));
vi.mock('../coordination/presence-wakeability', () => ({
  fetchWakeability: mocks.wakeability,
}));
vi.mock('../coordination/presence-selfwake', () => ({
  fetchSelfWake: mocks.selfWake,
  isStrandedMember: vi.fn(() => false),
}));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  recordedLiveOwnerIds: mocks.recordedLive,
  endedRecordedOwnerIds: mocks.recordedEnded,
}));
vi.mock('../coordination/wake-mode', () => ({
  getWakeModeOverridesFor: mocks.wakeModeOverrides,
  getDefaultWakeMode: mocks.defaultWakeMode,
  resolveWakeModeFrom: vi.fn(() => 'auto'),
}));
vi.mock('../../plan-item-coverage', () => ({
  getAllPlanItemCoverage: mocks.coverage,
  compactCoverage: vi.fn((coverage: unknown) => coverage),
  coverageCollisions: vi.fn(() => []),
  duplicateCoverage: vi.fn(() => []),
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/claim-spec-store')>()),
  readClaimConcurrencyBatch: mocks.schedulerClaims,
}));
vi.mock('../../events/await/store', () => ({
  listParkedAwaitsForSubscribers: mocks.parkedOn,
}));
vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressureReadings: mocks.contextPressure,
}));
vi.mock('../coordination/unanswered-directed', () => ({
  fetchUnansweredDirected: mocks.unanswered,
}));
vi.mock('../coordination/inbox-read-freshness', () => ({
  classifyCoordDeafness: vi.fn(() => null),
  coordDeafBudgetMs: vi.fn(() => 900_000),
  lastInboxReadAtBatch: vi.fn(async () => new Map()),
}));
vi.mock('../../harness/routines/loop', () => ({
  getLoopStatuses: mocks.loopStatuses,
}));
vi.mock('../plans/source', () => ({
  getPlanRow: mocks.getPlanRow,
  planItemsForRow: vi.fn(() => []),
  planSlugsForHarness: vi.fn(async () => new Set<string>()),
}));
vi.mock('../../fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/assignments')>()),
  listFleetAssignments: mocks.listAssignments,
  lastToolCallAtByOwner: mocks.lastToolCalls,
  lastProductiveToolCallAtByOwner: mocks.productiveToolCalls,
  resolveTerminalPlanItemResidue: mocks.residue,
}));

import fleetAssignmentsTool, {
  FLEET_ASSIGNMENTS_HANDLER_BUDGET_MS,
  FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS,
} from './assignments';
import { shapeFleetAssignments } from './assignments-shape';

const ctx = { workspaceId: 'papercusp-workspace' } as unknown as Parameters<
  typeof fleetAssignmentsTool.handler
>[1];

function liveRow() {
  const now = new Date().toISOString();
  return {
    source: 'work_item_claim',
    workspaceId: 'papercusp-workspace',
    agentId: 'su-worker',
    agentLabel: null,
    agentName: null,
    harnessSlug: 'papercusp',
    planSlug: null,
    itemId: null,
    workItemId: 'WI-1',
    itemKind: 'bug',
    detail: 'bounded read fixture',
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
    fleetSlug: 'test-fleet',
    fleetRole: 'member',
    stalled: false,
  };
}

function livePresenceRow() {
  return {
    ...liveRow(),
    source: 'presence',
    workItemId: null,
    itemKind: null,
    status: null,
    claimActive: null,
    detail: 'parked while blocked work remains assigned',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFleet.mockResolvedValue({ fleetSlug: 'test-fleet' });
  mocks.listAssignments.mockResolvedValue([]);
  mocks.schedulerClaims.mockImplementation(
    ({ cupIds }: { cupIds: readonly string[] }) =>
      Promise.resolve(
        new Map(
          cupIds.map((id) => [
            id,
            { blocked: false, activeClaims: 0, maxConcurrentClaims: 1, heldIds: [], blockerParkedIds: [] },
          ]),
        ),
      ),
  );
  mocks.coverage.mockResolvedValue(new Map());
  mocks.wakeability.mockResolvedValue(new Map());
  mocks.recordedLive.mockResolvedValue(new Set());
  mocks.selfWake.mockResolvedValue(new Map());
  mocks.recordedEnded.mockResolvedValue(new Set());
  mocks.parkedOn.mockResolvedValue([]);
  mocks.contextPressure.mockResolvedValue(new Map());
  mocks.unanswered.mockResolvedValue(new Map());
  mocks.loopStatuses.mockResolvedValue(new Map());
  mocks.lastToolCalls.mockResolvedValue(new Map());
  mocks.productiveToolCalls.mockResolvedValue(new Map());
  mocks.wakeModeOverrides.mockResolvedValue(new Map());
  mocks.defaultWakeMode.mockResolvedValue('auto');
  mocks.getPlanRow.mockResolvedValue(null);
  mocks.residue.mockResolvedValue(new Map());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fleet:assignments bounded handler reads', () => {
  it('bounds fleet validation and refuses without broadening when the lookup stalls', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    mocks.getFleet.mockImplementation(() => new Promise<never>(() => {}));

    const pending = fleetAssignmentsTool.handler(
      { fleet: 'test-fleet', includeTimings: true } as never,
      ctx,
    ) as Promise<{
      data: {
        ok: boolean;
        error?: string;
        degraded?: boolean;
        degradedLegs?: string[];
        readTimings?: Array<{ phase: string; elapsedMs: number; outcome: string }>;
        handlerElapsedMs?: number;
      };
    }>;

    await vi.advanceTimersByTimeAsync(FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS);
    const result = await pending;

    expect(result.data).toMatchObject({
      ok: false,
      error: 'fleet_lookup_timeout',
      degraded: true,
      degradedLegs: ['fleetLookup'],
    });
    expect(warnings.join('\n')).toContain(
      'fleet:assignments:fleetLookup exceeded ' + FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS + 'ms',
    );
    expect(result.data.handlerElapsedMs).toBe(FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS);
    expect(result.data.readTimings).toContainEqual({
      phase: 'fleetLookup',
      startOffsetMs: expect.any(Number),
      elapsedMs: FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS,
      outcome: 'timeout',
    });
    expect(mocks.listAssignments).not.toHaveBeenCalled();
  });

  it('caps cumulative sequential phases at the shared handler budget', async () => {
    expect(FLEET_ASSIGNMENTS_HANDLER_BUDGET_MS).toBeLessThanOrEqual(20_000);
    vi.useFakeTimers();
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    mocks.getFleet.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ fleetSlug: 'test-fleet' }), FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS - 500),
        ),
    );
    mocks.listAssignments.mockResolvedValue([liveRow()]);
    mocks.coverage.mockImplementation(() => new Promise<never>(() => {}));
    mocks.unanswered.mockImplementation(() => new Promise<never>(() => {}));
    mocks.loopStatuses.mockImplementation(() => new Promise<never>(() => {}));
    mocks.lastToolCalls.mockImplementation(() => new Promise<never>(() => {}));
    mocks.residue.mockImplementation(() => new Promise<never>(() => {}));
    mocks.getPlanRow.mockImplementation(() => new Promise<never>(() => {}));
    const startedAt = Date.now();

    const pending = fleetAssignmentsTool.handler(
      {
        fleet: 'test-fleet',
        plan: 'test-plan',
        includeDag: true,
        includeTimings: true,
      } as never,
      ctx,
    ) as Promise<{
      data: {
        degraded?: boolean;
        degradedLegs?: string[];
        readTimings?: Array<{ phase: string; startOffsetMs: number; elapsedMs: number; outcome: string }>;
        handlerElapsedMs?: number;
      };
    }>;

    await vi.advanceTimersByTimeAsync(FLEET_ASSIGNMENTS_HANDLER_BUDGET_MS);
    const result = await pending;

    expect(Date.now() - startedAt).toBe(FLEET_ASSIGNMENTS_HANDLER_BUDGET_MS);
    expect(result.data.handlerElapsedMs).toBe(FLEET_ASSIGNMENTS_HANDLER_BUDGET_MS);
    expect(result.data.degraded).toBe(true);
    expect(result.data.degradedLegs).toEqual(
      expect.arrayContaining(['coverage', 'unanswered', 'loop', 'lastToolCalls', 'residue', 'dag']),
    );
    expect(warnings.join('\n')).toContain(
      'fleet:assignments:coverage exceeded ' + FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS + 'ms',
    );
    expect(mocks.getPlanRow).not.toHaveBeenCalled();
  });

  it('reports successful bounded-read phase timing when explicitly requested', async () => {
    vi.useFakeTimers();
    mocks.listAssignments.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 137)),
    );

    const pending = fleetAssignmentsTool.handler({ includeTimings: true } as never, ctx) as Promise<{
      data: {
        readTimings?: Array<{ phase: string; startOffsetMs: number; elapsedMs: number; outcome: string }>;
        handlerElapsedMs?: number;
      };
    }>;
    await vi.advanceTimersByTimeAsync(137);
    const result = await pending;

    expect(result.data.readTimings).toContainEqual({
      phase: 'assignments',
      startOffsetMs: expect.any(Number),
      elapsedMs: 137,
      outcome: 'ok',
    });
    expect(result.data.handlerElapsedMs).toBeGreaterThanOrEqual(137);
  });

  it('bounds and reports a stalled productive-tool-call read used for member verdicts', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    mocks.listAssignments.mockResolvedValue([liveRow()]);
    mocks.productiveToolCalls.mockImplementation(() => new Promise<never>(() => {}));

    const pending = fleetAssignmentsTool.handler(
      { fleet: 'test-fleet', includeTimings: true } as never,
      ctx,
    ) as Promise<{
      data: {
        degraded?: boolean;
        degradedLegs?: string[];
        readTimings?: Array<{ phase: string; startOffsetMs: number; elapsedMs: number; outcome: string }>;
      };
    }>;

    await vi.advanceTimersByTimeAsync(FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS);
    const result = await pending;

    expect(mocks.productiveToolCalls).toHaveBeenCalledTimes(1);
    expect(result.data.degraded).toBe(true);
    expect(result.data.degradedLegs).toContain('productiveToolCalls');
    expect(result.data.readTimings).toContainEqual({
      phase: 'productiveToolCalls',
      startOffsetMs: expect.any(Number),
      elapsedMs: FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS,
      outcome: 'timeout',
    });
    expect(warnings.join('\n')).toContain(
      `fleet:assignments:productiveToolCalls exceeded ${FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS}ms`,
    );
  });

  it('returns an explicitly degraded fallback when the assignment query never settles', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    mocks.listAssignments.mockImplementation(() => new Promise<never>(() => {}));

    const pending = fleetAssignmentsTool.handler({ includeTimings: true } as never, ctx) as Promise<{
      data: {
        degraded?: boolean;
        degradedLegs?: string[];
        summary: { agents: number };
        readTimings?: Array<{ phase: string; startOffsetMs: number; elapsedMs: number; outcome: string }>;
      };
    }>;

    // Coverage starts before the hung assignment leg reaches its deadline.
    await Promise.resolve();
    expect(mocks.coverage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS);
    const result = await pending;

    expect(result.data).toMatchObject({
      degraded: true,
      degradedLegs: ['assignments'],
      summary: { agents: 0 },
    });
    expect(result.data.readTimings).toContainEqual({
      phase: 'assignments',
      startOffsetMs: expect.any(Number),
      elapsedMs: FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS,
      outcome: 'timeout',
    });
    expect(warnings.join('\n')).toContain(
      `fleet:assignments:assignments exceeded ${FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS}ms`,
    );
  });

  it('snapshot detail keeps the full scoped roster and claims without running member diagnostics', async () => {
    mocks.listAssignments.mockResolvedValue([liveRow(), livePresenceRow()]);

    const result = await fleetAssignmentsTool.handler(
      { fleet: 'test-fleet', detail: 'snapshot', includeTimings: true } as never,
      ctx,
    ) as {
      data: {
        detail?: string;
        unmeasuredMetrics?: string[];
        scope?: { fleet?: string | null };
        summary: Record<string, unknown>;
        agents: Array<{
          agentId?: string;
          claims?: unknown[];
          alive?: boolean | null;
          heartbeatFresh?: boolean;
        }>;
        readTimings?: Array<{ phase: string }>;
      };
    };

    expect(result.data).toMatchObject({
      detail: 'snapshot',
      scope: { fleet: 'test-fleet' },
      summary: {
        agents: 1,
        alive: null,
        claims: 1,
        scheduler_claim_state_status: 'unknown',
        scheduler_active_work_item_claims: null,
        orphaned_claims: null,
        stalled_claims: null,
        reclaimable_claims: null,
        unanswered_directed: null,
      },
      agents: [expect.objectContaining({ agentId: 'su-worker', alive: null, heartbeatFresh: true })],
    });
    const shaped = shapeFleetAssignments(result.data, 'trimmed') as {
      summary?: { alive?: unknown };
      agents?: Array<{ alive?: unknown }>;
    };
    expect(shaped.summary?.alive).toBeNull();
    expect(shaped.agents?.[0]?.alive).toBeNull();
    expect(result.data.unmeasuredMetrics).toContain('orphaned_claims');
    expect(result.data.unmeasuredMetrics).toContain('summary.alive');
    expect(result.data.unmeasuredMetrics).toContain('member.alive');
    expect(result.data.unmeasuredMetrics).toContain('member.verdict');
    expect(result.data.readTimings?.map((timing) => timing.phase)).not.toEqual(
      expect.arrayContaining(['coverage', 'unanswered', 'loop', 'lastToolCalls', 'residue']),
    );

    for (const read of [
      mocks.coverage,
      mocks.schedulerClaims,
      mocks.wakeability,
      mocks.recordedLive,
      mocks.selfWake,
      mocks.recordedEnded,
      mocks.parkedOn,
      mocks.contextPressure,
      mocks.unanswered,
      mocks.loopStatuses,
      mocks.lastToolCalls,
      mocks.productiveToolCalls,
      mocks.wakeModeOverrides,
      mocks.defaultWakeMode,
      mocks.residue,
    ]) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('starts independent row enrichments together before any one of them settles', async () => {
    mocks.listAssignments.mockResolvedValue([liveRow()]);
    const wakeability = deferred<Map<string, never>>();
    const parkedOn = deferred<Array<{ subscriberId: string; eventKey: string }>>();
    const contextPressure = deferred<Map<string, never>>();
    const unanswered = deferred<Map<string, never>>();
    mocks.wakeability.mockReturnValue(wakeability.promise);
    mocks.parkedOn.mockReturnValue(parkedOn.promise);
    mocks.contextPressure.mockReturnValue(contextPressure.promise);
    mocks.unanswered.mockReturnValue(unanswered.promise);

    const pending = fleetAssignmentsTool.handler({ harness: 'papercusp' } as never, ctx);
    await vi.waitFor(() => {
      expect(mocks.wakeability).toHaveBeenCalledTimes(1);
      expect(mocks.parkedOn).toHaveBeenCalledTimes(1);
      expect(mocks.contextPressure).toHaveBeenCalledTimes(1);
      expect(mocks.unanswered).toHaveBeenCalledTimes(1);
    });

    wakeability.resolve(new Map<string, never>());
    parkedOn.resolve([]);
    contextPressure.resolve(new Map<string, never>());
    unanswered.resolve(new Map<string, never>());

    const result = (await pending) as { data: { degraded?: boolean; summary: { agents: number } } };
    expect(result.data.summary.agents).toBe(1);
    expect(result.data.degraded).toBeUndefined();
    expect(result.data).not.toHaveProperty('readTimings');
  });

  it('shows scheduler-held blocked claims when the actionable assignment view omits them', async () => {
    mocks.listAssignments.mockResolvedValue([livePresenceRow()]);
    mocks.schedulerClaims.mockResolvedValue(
      new Map([
        [
          'su-worker',
          {
            blocked: true,
            activeClaims: 2,
            maxConcurrentClaims: 2,
            heldIds: ['EI-blocked-1', 'EI-blocked-2'],
            // P-010 (plan D-010): a hold parked on a recorded external blocker is held but
            // not counted — the projection must still surface it.
            blockerParkedIds: ['EI-parked-3'],
          },
        ],
      ]),
    );

    const result = (await fleetAssignmentsTool.handler({ harness: 'papercusp' } as never, ctx)) as {
      data: {
        summary: Record<string, unknown>;
        agents: Array<Record<string, unknown>>;
      };
    };

    expect(result.data.summary).toMatchObject({
      claims: 0,
      work_item_load: 0,
      scheduler_claim_state_status: 'measured',
      scheduler_active_work_item_claims: 2,
    });
    expect(result.data.agents[0].schedulerClaimState).toEqual({
      activeClaims: 2,
      heldIds: ['EI-blocked-1', 'EI-blocked-2'],
      blockerParkedIds: ['EI-parked-3'],
    });
  });
});
