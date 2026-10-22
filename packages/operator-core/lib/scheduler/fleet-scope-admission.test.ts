/** Recurrence guards for P-016's shared fleet-scope predicate + wind-down contract. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLAIM_SPEC, type FilterNode } from './claim-spec';
import type { ClaimSpecRecord } from './claim-spec-store';
// Type-only: erased at compile time, so this does NOT defeat the vi.mock('../work-items')
// factory below — it only makes the fixture genuinely checked against the real shape.
import type { WorkItem } from '../work-items';
import {
  claimSpecSubjectFromWorkItem,
  matchesClaimSpecFilter,
  type ClaimSpecSubject,
} from './claim-spec-match';
/** The all-zero `IssueClaimExclusionBreakdown.queueControl` axis-set. Declared ONCE so the
 *  breakdown fixtures below stay type-complete against the real interface: `queueControl` is
 *  REQUIRED (get-next.ts), and these fixtures assert floor/exclusion behaviour, for which every
 *  queue-control axis is deliberately empty. A fixture that genuinely exercises an axis should
 *  spread this and override just that field, so a NEW axis added to the interface strands one
 *  declaration here rather than every call site. */
const ZERO_QUEUE_CONTROL = {
  activeClaims: 0,
  rawClaimHolds: 0,
  holdOpenLeases: 0,
  durableParks: 0,
  unattributedClaimHolds: 0,
  pendingAgentReview: 0,
  revisionRequestedAgentReview: 0,
  revisionReproductionValidation: 0,
  revisionContentAdoptionCandidates: 0,
  revisionLegacyException: 0,
};

const admissionMocks = vi.hoisted(() => ({
  getClaimSpecRecord: vi.fn(),
  latestFleetMembership: vi.fn(),
  listFleetAssignments: vi.fn(),
  getWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  readHeldDependencyEscapeContext: vi.fn(),
  sendMessage: vi.fn(),
  getFleet: vi.fn(),
  // EI-13520: diagnoseFleetScopeCooldownMiss's own seam-level dependencies —
  // claimFloorsWhereSql/releaseCooldownSec (work-items.ts) + compileFilter
  // (get-next.ts) are mocked here so the test asserts the WIRING (right args in,
  // right count/expiry out) instead of replicating postgres.js's nested tagged-
  // template fragment composition in a fake sql tag.
  claimFloorsWhereSql: vi.fn(),
  featureClaimFloorPredicatesSql: vi.fn(),
  reservedPlanLaneExclusionSql: vi.fn(),
  stopTheLineExclusionSql: vi.fn(),
  releaseCooldownSec: vi.fn(),
  compileFilter: vi.fn(),
  // WI-5561: diagnoseFleetScopeIssueFloorMiss's own seam-level dependency — the
  // real aggregateIssueClaimExclusions (get-next.ts) is mocked here for the same
  // reason compileFilter is: assert the WIRING, not postgres.js's SQL composition.
  aggregateIssueClaimExclusions: vi.fn(),
  boundedPgReadTxn: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('./claim-spec-store', () => ({
  getClaimSpecRecord: admissionMocks.getClaimSpecRecord,
}));
vi.mock('../fleet-membership-store', () => ({
  latestFleetMembership: admissionMocks.latestFleetMembership,
}));
vi.mock('../fleet/assignments', async (importOriginal) => {
  // WI-6326: keep groupByAgent REAL (hasLiveFleetRouteTarget's own dependency) — only
  // listFleetAssignments (the PG I/O) is mocked, same pattern as reconcileFleetScopeClaims
  // already relies on elsewhere in this file.
  const actual = await importOriginal<typeof import('../fleet/assignments')>();
  return { ...actual, listFleetAssignments: admissionMocks.listFleetAssignments };
});
vi.mock('../work-items', () => ({
  getWorkItem: admissionMocks.getWorkItem,
  releaseWorkItem: admissionMocks.releaseWorkItem,
  readHeldDependencyEscapeContext: admissionMocks.readHeldDependencyEscapeContext,
  claimFloorsWhereSql: admissionMocks.claimFloorsWhereSql,
  featureClaimFloorPredicatesSql: admissionMocks.featureClaimFloorPredicatesSql,
  reservedPlanLaneExclusionSql: admissionMocks.reservedPlanLaneExclusionSql,
  releaseCooldownSec: admissionMocks.releaseCooldownSec,
  // EI-19393442073558754: specIsIssueFamilyOnly (fleet-scope-admission.ts) imports the REAL
  // kind-set constant from '../work-items' — mirror it here rather than re-declaring it, so
  // this mock can never silently drift from the real ISSUE_FAMILY_KINDS.
  ISSUE_FAMILY_KINDS: ['bug', 'change', 'task'],
}));
vi.mock('../work-items-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../work-items-admission')>()),
  stopTheLineExclusionSql: admissionMocks.stopTheLineExclusionSql,
}));
// EI-22180177490969530: the two SQL-composing seams stay mocked (see above), but the PURE
// registry projection is passed through from the real module so this file's fixtures can be
// DERIVED from ISSUE_CLAIM_FLOORS instead of hand-restating every bucket name. Hand-listed
// fixtures are the same drift one level up: adding a floor stranded six copies here at once.
vi.mock('./get-next', async () => {
  const actual = await vi.importActual<typeof import('./get-next')>('./get-next');
  return {
    compileFilter: admissionMocks.compileFilter,
    aggregateIssueClaimExclusions: admissionMocks.aggregateIssueClaimExclusions,
    mapIssueClaimExclusionCounts: actual.mapIssueClaimExclusionCounts,
  };
});
vi.mock('../pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pg-read-query')>()),
  boundedPgReadTxn: (...args: unknown[]) => admissionMocks.boundedPgReadTxn(...args),
}));
vi.mock('../agent-tools/coordination/messages', () => ({
  sendMessage: admissionMocks.sendMessage,
}));
vi.mock('../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: admissionMocks.getFleet,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: admissionMocks.sql }),
}));

import {
  admitSubjectForFleetTarget,
  admitWorkItemForFleetTarget,
  admitWorkItemForLoopTarget,
  leaderDispatchedAdmission,
  selfFiledFalloutAdmission,
  selfFiledKindRefusalHint,
  diagnoseFleetScopeCooldownMiss,
  diagnoseFleetScopeFeatureFamilyExclusions,
  diagnoseFleetScopeFeatureFamilyMatch,
  diagnoseFleetScopeIssueFloorMiss,
  FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,
  diagnoseFleetScopeRetiredPlans,
  fleetLeaderUnavailableRefusal,
  fleetScopeRefusalContract,
  fleetScopeLeaderRemedy,
  fleetScopedMiss,
  hasLiveFleetRouteTarget,
  fencePreservingWidenFilter,
  itemMatchesRawClaimSpec,
  notifyFleetScopeRefusal,
  readFleetPauseState,
  reconcileFleetScopeClaims,
  type FleetScopeAdmission,
  type FleetScopeContext,
} from './fleet-scope-admission';
import { evaluateGoalFenceGuard } from './spec-pool-preview';
/** A VALUE import, deliberately: the vi.mock factory above passes the real
 *  `mapIssueClaimExclusionCounts` through, so every `excluded` fixture below derives its
 *  per-floor zero baseline from ISSUE_CLAIM_FLOORS. Same reasoning as ZERO_QUEUE_CONTROL,
 *  one rung better — nothing here restates a bucket name, so adding a floor cannot strand
 *  these fixtures at all (EI-22180177490969530). */
import { mapIssueClaimExclusionCounts } from './get-next';

describe('fleetLeaderUnavailableRefusal (EI-21079515303301272)', () => {
  it('is a recoverable pre-claim block, not a drained-lane verdict', () => {
    const scope = {
      ownerId: 'su-member',
      fleetSlug: 'leaderless-fleet',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          ...DEFAULT_CLAIM_SPEC,
          specId: 'leaderless-rev4',
          revision: 4,
        },
        revision: 4,
        updatedBy: 'test-fixture',
        updatedAt: '2026-08-21T22:00:00.000Z',
        fleetSlug: 'leaderless-fleet',
      },
    } satisfies FleetScopeContext;

    const refusal = fleetLeaderUnavailableRefusal(scope);

    expect(refusal).toMatchObject({
      ok: false,
      error: 'fleet_leader_unavailable',
      reason: 'registered_leader_not_live',
      retryable: true,
      noClaim: true,
      recoverable: true,
      leaderLiveness: false,
      windDown: false,
      fleetScope: {
        fleet: 'leaderless-fleet',
        member: 'su-member',
        specId: 'leaderless-rev4',
        revision: 4,
      },
      recovery: {
        tool: 'fleet:take-leadership',
        args: { fleet: 'leaderless-fleet' },
      },
    });
    expect(refusal.message).toMatch(/no live registered leader/);
    expect(refusal.advice).toMatch(/Do not treat this as an empty queue/);
  });
});

describe('WI-41163: caller-neutral feature-family population count', () => {
  const populationScope = {
    ownerId: 'su-reading-leader',
    fleetSlug: 'fleet-x',
    fleetRole: 'member' as const,
    workspaceId: 'papercusp-workspace',
    record: {
      source: 'fleet' as const,
      spec: {
        specVersion: '1.0' as const,
        specId: 'fleet-x-rev1',
        revision: 1,
        states: ['open'],
        view: { filter: { field: 'plan', op: '=' as const, value: 'plan-x' } },
        rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age' as const, dir: 'asc' as const }] },
      },
      revision: 1,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    },
  } satisfies FleetScopeContext;

  beforeEach(() => {
    for (const mock of Object.values(admissionMocks)) mock.mockReset();
    admissionMocks.stopTheLineExclusionSql.mockReturnValue('STOP_THE_LINE_FLOOR');
    admissionMocks.featureClaimFloorPredicatesSql.mockReturnValue({ reservedPlanLane: 'RESERVATION_FLOOR', stopTheLine: 'STOP_THE_LINE_FLOOR' });
  });

  it('explicit null omits the reading leader from the feature-family cooldown floor', async () => {
    admissionMocks.claimFloorsWhereSql.mockReturnValue('FLOORS_WITHOUT_CALLER');
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.reservedPlanLaneExclusionSql.mockReturnValue('RESERVATION_FLOOR');
    admissionMocks.sql.mockResolvedValue([{ matched: 5, claimable: 3, reserved_plan_lane: 2 }]);

    const count = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: populationScope,
      harness: 'papercusp',
      workspaceId: 'papercusp-workspace',
      cooldownAssignee: null,
    });

    expect(count).toBe(3);
    expect(admissionMocks.claimFloorsWhereSql).toHaveBeenCalledWith(
      admissionMocks.sql,
      expect.objectContaining({ cooldownAssignee: undefined }),
    );
  });

  it('names additional excluding floors from the same feature claim predicate registry', async () => {
    admissionMocks.claimFloorsWhereSql.mockReturnValue('SHARED_FLOORS');
    admissionMocks.featureClaimFloorPredicatesSql.mockReturnValue({ scope: 'SCOPE', rig: 'RIG_FLOOR', claimHold: 'HOLD_FLOOR' });
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.sql.mockResolvedValue([{ matched: 3, claimable: 0, reserved_plan_lane: 0, stop_the_line: 0, rig: 2, claimHold: 1 }]);
    const result = await diagnoseFleetScopeFeatureFamilyExclusions({ scope: populationScope, harness: 'papercusp', workspaceId: 'papercusp-workspace', cooldownAssignee: null });
    expect(result).toMatchObject({ matchedByFilter: 3, claimable: 0, excluded: { claimFloors: 3, rig: 2, claimHold: 1 } });
    expect(admissionMocks.featureClaimFloorPredicatesSql).toHaveBeenCalledWith(admissionMocks.sql, expect.objectContaining({ cooldownAssignee: undefined, claimantFleetSlug: 'fleet-x' }));
    expect(result?.excluded).not.toHaveProperty('scope');
  });

  it('returns matched, claimable, and overlapping reservation-floor counts', async () => {
    admissionMocks.claimFloorsWhereSql.mockReturnValue('FLOORS_WITHOUT_CALLER');
    admissionMocks.reservedPlanLaneExclusionSql.mockReturnValue('RESERVATION_FLOOR');
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.sql.mockResolvedValue([{ matched: 4, claimable: 1, reserved_plan_lane: 2, stop_the_line: 0 }]);

    await expect(diagnoseFleetScopeFeatureFamilyExclusions({
      scope: populationScope,
      harness: 'papercusp',
      workspaceId: 'papercusp-workspace',
      cooldownAssignee: null,
    })).resolves.toEqual({
      matchedByFilter: 4,
      claimable: 1,
      excluded: { claimFloors: 3, reservedPlanLane: 2, stopTheLine: 0 },
    });

    expect(admissionMocks.stopTheLineExclusionSql).toHaveBeenCalledWith(
      admissionMocks.sql,
      'feature-consolidated',
    );
  });

  it('passes the scope fleet and structural fleet authorization to the shared floor', async () => {
    admissionMocks.claimFloorsWhereSql.mockReturnValue('FLOORS_WITH_FLEET_AUTH');
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.reservedPlanLaneExclusionSql.mockReturnValue('RESERVATION_FLOOR');
    admissionMocks.sql.mockResolvedValue([{ matched: 1, claimable: 1, reserved_plan_lane: 0 }]);

    const fleetReferencedScope = {
      ...populationScope,
      record: {
        ...populationScope.record,
        spec: {
          ...populationScope.record.spec,
          view: { filter: { field: 'fleet' as const, op: '=' as const, value: 'fleet-x' } },
        },
      },
    };

    const count = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: fleetReferencedScope,
      harness: 'papercusp',
      workspaceId: 'papercusp-workspace',
    });

    expect(count).toBe(1);
    expect(admissionMocks.claimFloorsWhereSql).toHaveBeenCalledWith(
      admissionMocks.sql,
      expect.objectContaining({
        claimantFleetSlug: 'fleet-x',
        claimSpecReferencesFleet: true,
      }),
    );
  });

  /**
   * EI-21398324268952860: the GOAL sibling of the structural fleet authorization above. A
   * per-goal standing drain fleet scopes its spec by `{ field:'goal', op:'=', value:<goalId> }`
   * and its OWN steward mints plan-stamped work for it — which the plan-lane floor then reserved
   * away from the only fleet entitled to it (`matchedByFilter=7, claimable=0, planLaneReserved=7`;
   * the drain stalled fleet-wide). The fleet leg could not rescue those rows: measured live, 0 of
   * the 9 stamped-and-untaken items carried a `fleet_slug` at all.
   *
   * Asserted on BOTH floors this diagnostic composes, deliberately — `claimFloorsWhereSql` feeds
   * the `claimable` count and `reservedPlanLaneExclusionSql` feeds `reserved_plan_lane`. Deriving
   * the flag for one and not the other is exactly how this fix could land looking complete while
   * the diagnostic kept reporting the gating it had just removed.
   */
  it('EI-21398324268952860: derives structural GOAL authorization for both floors, and withholds it for a spec that does not reference goal', async () => {
    admissionMocks.claimFloorsWhereSql.mockReturnValue('FLOORS_WITH_GOAL_AUTH');
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.reservedPlanLaneExclusionSql.mockReturnValue('RESERVATION_FLOOR');
    admissionMocks.sql.mockResolvedValue([{ matched: 7, claimable: 7, reserved_plan_lane: 0 }]);

    const goalReferencedScope = {
      ...populationScope,
      record: {
        ...populationScope.record,
        spec: {
          ...populationScope.record.spec,
          view: { filter: { field: 'goal' as const, op: '=' as const, value: 'work-on-everything-0a8163' } },
        },
      },
    };

    await diagnoseFleetScopeFeatureFamilyMatch({
      scope: goalReferencedScope,
      harness: 'papercusp',
      workspaceId: 'papercusp-workspace',
    });

    expect(admissionMocks.claimFloorsWhereSql).toHaveBeenLastCalledWith(
      admissionMocks.sql,
      expect.objectContaining({ claimSpecReferencesGoal: true }),
    );
    expect(admissionMocks.reservedPlanLaneExclusionSql).toHaveBeenLastCalledWith(
      admissionMocks.sql,
      expect.anything(),
      'payload',
      expect.objectContaining({ claimSpecReferencesGoal: true }),
    );

    // POSITIVE CONTROL. Without it this test passes just as well against a hardcoded `true`,
    // which would grant goal authorization to EVERY caller and un-gate every ordinary plan lane
    // — a strictly worse failure than the one being fixed. `populationScope`'s spec filters on
    // `plan`, so it structurally references neither `fleet` nor `goal` and must be refused.
    await diagnoseFleetScopeFeatureFamilyMatch({
      scope: populationScope,
      harness: 'papercusp',
      workspaceId: 'papercusp-workspace',
    });

    expect(admissionMocks.claimFloorsWhereSql).toHaveBeenLastCalledWith(
      admissionMocks.sql,
      expect.objectContaining({ claimSpecReferencesGoal: false }),
    );
    expect(admissionMocks.reservedPlanLaneExclusionSql).toHaveBeenLastCalledWith(
      admissionMocks.sql,
      expect.anything(),
      'payload',
      expect.objectContaining({ claimSpecReferencesGoal: false }),
    );
  });
});

const base: ClaimSpecSubject = {
  id: 'WI-7',
  title: 'Fix scheduler admission',
  summary: 'admission summary text',
  kind: 'bug',
  priority: 3,
  tags: ['scheduler', 'non-p2p'],
  paths: ['packages/operator-core/lib/scheduler/get-next.ts'],
  plan: 'bug-drain',
  planItem: ['P-016'],
  fleet: null,
  triageGate: null,
  itemClass: 'work',
  age: 1_000,
  riskTier: 'moderate',
  redundancy: 1,
  estCost: 12,
  assignee: null,
  severity: 'major',
  goal: null,
};

describe('fleet scope assignment admission (P-016)', () => {
  beforeEach(() => {
    for (const mock of Object.values(admissionMocks)) mock.mockReset();
    admissionMocks.sendMessage.mockResolvedValue(undefined);
    admissionMocks.readHeldDependencyEscapeContext.mockResolvedValue(null);
  });

  it('evaluates the full boolean grammar, including id cohort + non-P2P exclusion', () => {
    const filter: FilterNode = {
      all: [
        { field: 'id', op: 'in', value: ['WI-7', 'WI-8'] },
        { field: 'kind', op: '=', value: 'bug' },
        { not: { field: 'title', op: 'glob', value: '*p2p*' } },
        { any: [{ field: 'tags', op: 'contains', value: 'scheduler' }, { field: 'risk_tier', op: '=', value: 'low' }] },
      ],
    };
    expect(matchesClaimSpecFilter(base, filter)).toBe(true);
    expect(matchesClaimSpecFilter({ ...base, id: 'WI-out' }, filter)).toBe(false);
    expect(matchesClaimSpecFilter({ ...base, title: 'P2P transport bug' }, filter)).toBe(false);
  });

  it('treats an unknown not-yet-minted id as outside a fixed cohort', () => {
    expect(matchesClaimSpecFilter({ ...base, id: null }, { field: 'id', op: 'in', value: ['WI-7'] })).toBe(false);
  });

  it('mirrors priority inversion and array membership semantics from the SQL compiler', () => {
    expect(matchesClaimSpecFilter(base, { field: 'priority', op: '>', value: 5 })).toBe(true);
    expect(matchesClaimSpecFilter(base, { field: 'plan_item', op: '=', value: 'P-016' })).toBe(true);
    expect(matchesClaimSpecFilter(base, { field: 'paths', op: 'glob', value: '*scheduler*' })).toBe(true);
  });

  it('hydrates issue plan/risk/path vocabulary from the canonical payload shape', () => {
    const subject = claimSpecSubjectFromWorkItem({
      id: 'EI-9',
      harness: 'papercusp',
      kind: 'bug',
      family: 'issue',
      title: 'issue',
      summary: 'body',
      state: 'open',
      assignee: null,
      takenAt: null,
      lastProgressAt: null,
      assignedBy: null,
      createdBy: null,
      severity: 'major',
      parent: null,
      payload: {
        plan_item: { plan_slug: 'ops', item_id: 'P-9' },
        paths: ['packages/operator-core/lib/x.ts'],
        risk_tier: 'high',
      },
      rank: null,
      rankWriter: null,
      rankUpdatedAt: null,
      priority: null,
      origin: 'local',
      auditVerdict: null,
      verifiedAuthorGithubUserId: null,
      terminalOwner: null,
      terminalCompletionRef: null,
      terminalCompletionEvidence: null,
      completionAuthority: null,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      closedAt: null,
      goalId: null,
    });
    expect(subject).toMatchObject({ plan: 'ops', planItem: ['P-9'], riskTier: 'high' });
    expect(subject.paths).toEqual(['packages/operator-core/lib/x.ts']);
  });

  it('returns an explicit wind-down verdict instead of generic-backlog advice', () => {
    const miss = fleetScopedMiss({
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet',
        spec: { specVersion: '1.0', specId: 'bugs-rev4', revision: 4, view: {}, rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] } },
        revision: 4,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    }, ['WI-out']);
    expect(miss).toMatchObject({ windDown: true, quarantinedIds: ['WI-out'], fleetScope: { fleet: 'bugs' } });
    expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
  });

  it('EI-21659493450381888: loop admission refuses a per-cup scheduler-spec mismatch even without fleet membership', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue(null);
    admissionMocks.listFleetAssignments.mockResolvedValue([]);
    admissionMocks.getClaimSpecRecord.mockResolvedValue({
      source: 'cup',
      spec: {
        specVersion: '1.0',
        specId: 'only-pui-su-session-runtime-correction',
        revision: 3,
        view: { filter: { field: 'plan', op: '=', value: 'pui-su-session-runtime-correction-2026-08-27' } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 3,
      updatedBy: 'su-member',
      updatedAt: 'now',
    });
    const item: WorkItem = {
      id: 'WI-1774',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      title: 'out-of-lane item',
      summary: 'item from a different plan',
      state: 'open',
      assignee: null,
      takenAt: null,
      lastProgressAt: null,
      assignedBy: null,
      createdBy: null,
      severity: 'major',
      parent: null,
      payload: {},
      sourcePlanSlug: 'backend-reliability-100pct-2026-07-03',
      sourcePlanItemIds: null,
      goalId: null,
      origin: 'local',
      auditVerdict: null,
      verifiedAuthorGithubUserId: null,
      rank: null,
      rankWriter: null,
      rankUpdatedAt: null,
      priority: null,
      terminalOwner: null,
      terminalCompletionRef: null,
      terminalCompletionEvidence: null,
      completionAuthority: null,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      closedAt: null,
    };
    admissionMocks.getWorkItem.mockResolvedValue(item);

    const admission = await admitWorkItemForLoopTarget({
      target: 'su-member',
      workItemId: item.id,
      harness: 'papercusp',
      workspaceId: 'papercusp-workspace',
      enforceSchedulerSpec: true,
    });

    expect(admission).toMatchObject({
      allowed: false,
      scoped: false,
      code: 'scheduler_spec_violation',
      specId: 'only-pui-su-session-runtime-correction',
      revision: 3,
    });
    expect((admission as { reason: string }).reason).toMatch(/does not match active scheduler spec/);
  });

  it('releases every incompatible pre-existing claim in one reconciliation sweep and alerts once', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'bugs', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({
      source: 'fleet',
      spec: {
        specVersion: '1.0',
        specId: 'bugs-rev4',
        revision: 4,
        view: { filter: { field: 'id', op: 'in', value: ['WI-in'] } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 4,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    });
    admissionMocks.listFleetAssignments.mockResolvedValue([
      { source: 'work_item_claim', agentId: 'su-member', workItemId: 'WI-out-1' },
      { source: 'work_item_claim', agentId: 'su-member', workItemId: 'WI-in' },
      { source: 'work_item_claim', agentId: 'su-member', workItemId: 'WI-out-2' },
      { source: 'work_item_claim', agentId: 'su-member', workItemId: 'WI-out-1' }, // de-duped, not dripped into a later wake
    ]);
    admissionMocks.getWorkItem.mockImplementation(async (id: string) => ({
      id,
      family: 'issue',
      kind: 'bug',
      title: id,
      summary: id,
      state: 'wip',
      assignee: 'su-member',
      payload: {},
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    }));
    admissionMocks.releaseWorkItem.mockImplementation(async (id: string) => ({ id }));

    const result = await reconcileFleetScopeClaims({
      ownerId: 'su-member',
      workspaceId: 'papercusp-workspace',
      identity: { ownerId: 'su-member' } as never,
    });

    expect(result.quarantinedIds).toEqual(['WI-out-1', 'WI-out-2']);
    expect(admissionMocks.releaseWorkItem).toHaveBeenCalledTimes(2);
    expect(admissionMocks.releaseWorkItem).toHaveBeenNthCalledWith(1, 'WI-out-1', {
      expectedAssignee: 'su-member',
    });
    expect(admissionMocks.releaseWorkItem).toHaveBeenNthCalledWith(2, 'WI-out-2', {
      expectedAssignee: 'su-member',
    });
    expect(admissionMocks.sendMessage).toHaveBeenCalledOnce();
    expect(admissionMocks.sendMessage.mock.calls[0]?.[1]).toMatchObject({
      to: ['@fleet-leader:bugs'],
      summary: 'quarantined 2 out-of-scope fleet claim(s)',
    });
  });

  // EI-16710: featureMatchesRecord must key the workspace match off the EXPLICITLY
  // threaded scope.workspaceId — never an ambient/global resolver — or a genuinely
  // in-scope feature-family item spuriously fails to match (and, in the live path,
  // reconcileFleetScopeClaims wrongly releases + re-arms the cooldown on the member's
  // own valid claim every single call).
  it('EI-16710: a feature-family item matches scope using the caller-supplied workspaceId, not an ambient global', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'bugs', fleetRole: 'member' });
    admissionMocks.getFleet.mockResolvedValue({ fleetSlug: 'bugs', controlState: 'active', controlReason: null });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({
      source: 'fleet',
      spec: {
        specVersion: '1.0',
        specId: 'bugs-rev4',
        revision: 4,
        view: { filter: { field: 'kind', op: '=', value: 'feature' } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 4,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    });
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.getWorkItem.mockResolvedValue({
      id: 'WI-feat',
      family: 'feature',
      kind: 'feature',
      title: 'WI-feat',
      summary: 'WI-feat',
      state: 'todo',
      assignee: null,
      payload: {},
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    // The outer EXISTS query's own raw SQL text contains `workspace_id =`; the nested
    // harness_slug/TRUE fragment does not — keying off that isolates exactly what
    // value the outer query received for `workspaceId`, independent of any ambient
    // resolver the (buggy) old code might otherwise have consulted.
    admissionMocks.sql.mockImplementation((strings: readonly string[], ...values: unknown[]) => {
      if (strings.some((s) => s.includes('workspace_id ='))) {
        return Promise.resolve([{ matched: values[0] === 'papercusp-workspace' }]);
      }
      return 'FRAGMENT';
    });

    const admission = await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: 'WI-feat',
      workspaceId: 'papercusp-workspace',
    });

    expect(admission).toMatchObject({ allowed: true, scoped: true });
    expect(admissionMocks.sql).toHaveBeenCalled();
  });

  // EI-12832: while a fleet is winding-down (paused via fleet:pause / fleet:wind-down),
  // a member must not acquire NEW work — the by-id claim path (admitWorkItemForFleetTarget)
  // must consult the durable control_state, not just spec-match. Regression: a compliant
  // stand-down release woke a parked member which then claimed the released item because
  // it was in-spec and the claim path never checked the pause.
  describe('EI-12832: fleet pause gates the claim/assign admission path', () => {
    const fleetSpec: ClaimSpecRecord = {
      source: 'fleet' as const,
      spec: {
        specVersion: '1.0',
        specId: 'bugs-rev4',
        revision: 4,
        view: { filter: { field: 'id', op: 'in', value: ['WI-in'] } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 4,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    };
    const issueItem = {
      id: 'WI-in',
      family: 'issue',
      kind: 'bug',
      title: 'WI-in',
      summary: 'WI-in',
      state: 'open',
      assignee: null,
      payload: {},
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    };

    beforeEach(() => {
      admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'bugs', fleetRole: 'member' });
      admissionMocks.getClaimSpecRecord.mockResolvedValue(fleetSpec);
    });

    it('refuses a member by-id claim while its fleet is winding-down (paused), before any item read', async () => {
      admissionMocks.getFleet.mockResolvedValue({ fleetSlug: 'bugs', controlState: 'winding-down', controlReason: 'owner pause' });

      const admission = await admitWorkItemForFleetTarget({
        target: 'su-member',
        workItemId: 'WI-in',
        workspaceId: 'papercusp-workspace',
      });

      expect(admission).toMatchObject({ allowed: false, code: 'fleet_winding_down', scope: { fleetSlug: 'bugs' } });
      expect((admission as { reason: string }).reason).toMatch(/winding-down/);
      expect((admission as { reason: string }).reason).toMatch(/owner pause/);
      // The pause short-circuits admission BEFORE the item read — the claim never reaches spec-match.
      expect(admissionMocks.getWorkItem).not.toHaveBeenCalled();
    });

    it.each(['membership', 'stable-target', 'pause'])('fails closed when %s authority cannot be read', async (stage) => {
      if (stage === 'membership') admissionMocks.latestFleetMembership.mockRejectedValueOnce(new Error('authority unreadable'));
      if (stage === 'stable-target') {
        admissionMocks.latestFleetMembership.mockResolvedValueOnce(null);
        admissionMocks.listFleetAssignments.mockRejectedValueOnce(new Error('authority unreadable'));
      }
      if (stage === 'pause') admissionMocks.getFleet.mockRejectedValueOnce(new Error('authority unreadable'));
      await expect(admitWorkItemForFleetTarget({
        target: 'su-member', workItemId: 'WI-in', workspaceId: 'default',
      })).rejects.toThrow('authority unreadable');
      expect(admissionMocks.getWorkItem).not.toHaveBeenCalled();
    });

    it('allows the SAME in-spec claim once the fleet is active again (the fix is control-state-conditional)', async () => {
      admissionMocks.getFleet.mockResolvedValue({ fleetSlug: 'bugs', controlState: 'active', controlReason: null });
      admissionMocks.getWorkItem.mockResolvedValue(issueItem);

      const admission = await admitWorkItemForFleetTarget({
        target: 'su-member',
        workItemId: 'WI-in',
        workspaceId: 'papercusp-workspace',
      });

      expect(admission).toMatchObject({ allowed: true, scoped: true });
      expect(admissionMocks.getWorkItem).toHaveBeenCalledWith('WI-in', undefined);
    });

    it('fleetScopedMiss surfaces a paused stand-down verdict for the self-select path', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        [],
        { pausedReason: 'owner pause' },
      );
      expect(miss).toMatchObject({ windDown: true, paused: true, fleetScope: { fleet: 'bugs' } });
      expect(miss.claimability).toMatchObject({
        value: null,
        population: { fleet: 'bugs', spec: { revision: fleetSpec.spec.revision } },
        interpretation: {
          state: 'paused',
          exactness: { status: 'exact' },
          evidence: { fleetPaused: true },
        },
      });
      expect(miss.error).toMatch(/winding-down/);
      expect(miss.error).toMatch(/owner pause/);
      expect(miss.advice).toMatch(/fleet:resume/);
    });

    // EI-15777: the paused branch now also reports how many of the caller's OWN
    // pre-pause work-item:claimable idle-park await(s) were just cancelled server-side
    // (see the cancelClaimableAwaits call at both self-pull call sites) — and the
    // advice must tell the caller NOT to re-park one while paused, since that standing
    // wake was retired, not merely gated at the ensuing claim.
    it('EI-15777: a paused miss surfaces claimableAwaitsCancelled + the do-not-re-park advice', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        [],
        { pausedReason: 'owner pause', claimableAwaitsCancelled: 2 },
      );
      expect(miss).toMatchObject({ windDown: true, paused: true, claimableAwaitsCancelled: 2 });
      expect(miss.advice).toMatch(/Do NOT re-park a work-item:claimable await while paused/);
      expect(miss.advice).toMatch(/EI-15777/);
    });

    it('EI-15777: a paused miss with no cancelled awaits still surfaces claimableAwaitsCancelled:0 (default)', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        [],
        { pausedReason: 'owner pause' },
      );
      expect(miss).toMatchObject({ claimableAwaitsCancelled: 0 });
    });

    it('EI-15777: a non-paused (cooldown-only) miss never carries claimableAwaitsCancelled', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        [],
        { cooldownDiag: null },
      );
      expect(miss).not.toHaveProperty('claimableAwaitsCancelled');
    });

    it('readFleetPauseState preserves UNKNOWN when the control-state read errors', async () => {
      admissionMocks.getFleet.mockRejectedValue(new Error('pg unavailable'));
      await expect(readFleetPauseState(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        'papercusp-workspace',
      )).rejects.toThrow('pg unavailable');
    });
  });

  // EI-13520: scheduler:get_next reported a release-cooldown exclusion as "no claimable
  // work-item matched fleet scope" — blaming the spec for a miss that was actually a
  // per-bee cooldown floor, driving a real fleet livelock of leader re-authoring a spec
  // that was never the cause. diagnoseFleetScopeCooldownMiss re-attributes the miss;
  // fleetScopedMiss surfaces it with an honest message + do-not-re-author advice.
  describe('EI-13520: cooldown-only miss re-attribution', () => {
    const cooldownScope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'bugs-rev4',
          revision: 4,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 4,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    beforeEach(() => {
      admissionMocks.claimFloorsWhereSql.mockReturnValue('FLOORS_NO_COOLDOWN');
      admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
      admissionMocks.releaseCooldownSec.mockReturnValue(300);
    });

    it('returns the cooldown-excluded count + earliest expiry + the argmin row id when rows match sans the cooldown floor', async () => {
      const releasedAt = new Date('2026-07-17T07:00:00.000Z');
      // EI-16519: the query now returns the argmin row (feature_id + last_released_at)
      // plus a `count(*) OVER()` window total, not a bare aggregate — one row back.
      admissionMocks.sql.mockResolvedValue([{ feature_id: 'WI-9001', last_released_at: releasedAt, cnt: 3 }]);

      const diag = await diagnoseFleetScopeCooldownMiss({
        scope: cooldownScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });

      expect(diag).toEqual({ cooldownExcluded: 3, earliestExpiryMs: releasedAt.getTime() + 300_000, earliestRowId: 'WI-9001' });
      // The defining assertion: the WITHOUT-cooldown floors call must NOT thread this
      // bee's ownerId as cooldownAssignee — that is precisely the leg being dropped.
      const floorsOpts = admissionMocks.claimFloorsWhereSql.mock.calls[0]?.[1];
      expect(floorsOpts).toMatchObject({ harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      expect(floorsOpts?.cooldownAssignee).toBeUndefined();
    });

    it('returns null (no diagnosis) when nothing matches even without the cooldown floor', async () => {
      admissionMocks.sql.mockResolvedValue([]);
      const diag = await diagnoseFleetScopeCooldownMiss({
        scope: cooldownScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });
      expect(diag).toBeNull();
    });

    it('returns null when the spec has no view filter (nothing to diagnose)', async () => {
      const diag = await diagnoseFleetScopeCooldownMiss({
        scope: { ...cooldownScope, record: { ...cooldownScope.record, spec: { ...cooldownScope.record.spec, view: {} } } },
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });
      expect(diag).toBeNull();
      expect(admissionMocks.sql).not.toHaveBeenCalled();
    });

    it('FAILS SOFT: a query error degrades to null, never throws (annotation only, like buildMissDiagnosis)', async () => {
      admissionMocks.sql.mockRejectedValue(new Error('pg unavailable'));
      const diag = await diagnoseFleetScopeCooldownMiss({
        scope: cooldownScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });
      expect(diag).toBeNull();
    });

    it('fleetScopedMiss reattributes a cooldown-only miss: honest message, cooldownOnly flag, do-not-re-author advice', () => {
      const miss = fleetScopedMiss(cooldownScope, [], {
        cooldownDiag: { cooldownExcluded: 3, earliestExpiryMs: Date.now() + 42_000, earliestRowId: 'WI-9001' },
      });
      expect(miss).toMatchObject({ windDown: true, cooldownOnly: true, cooldownExcluded: 3, cooldownEarliestRowId: 'WI-9001' });
      expect(miss.paused).toBeUndefined();
      expect(miss.error).toMatch(/YOUR OWN release-cooldown floor/);
      expect(miss.error).not.toMatch(/NOT allowed to fall through to the generic backlog/);
      // EI-13520's intent survives (a NORMAL one-time cooldown is not a scope/spec
      // problem — do not re-author the spec for it); EI-14615/EI-16519 only ADD the
      // livelock-vs-churn distinction below, they do not revert this.
      expect(miss.advice).toMatch(/not a scope\/spec mismatch/);
      expect(miss.advice).toMatch(/do NOT re-author the claim spec/);
      expect(miss.advice).not.toMatch(/Report the scoped miss to the fleet leader/);
    });

    // EI-14615/EI-16519: a cooldown-only miss whose relative `cooldownExpirySec` alone
    // can't reveal whether the SAME row keeps re-arming (a genuine livelock) or a
    // DIFFERENT one of this bee's own several recently-released rows is now the
    // earliest (ordinary churn) — so the miss surfaces both the ABSOLUTE
    // `cooldownExpiryAt` AND the specific `cooldownEarliestRowId` driving it, and the
    // advice teaches the caller to compare the ROW ID (not just the number) across polls.
    describe('EI-14615/EI-16519: absolute cooldown expiry + argmin row id + churn-vs-livelock advice', () => {
      it('surfaces cooldownExpiryAt as the ISO of earliestExpiryMs (so a re-stamped window is observable across polls)', () => {
        const earliestExpiryMs = Date.parse('2026-07-17T15:09:00.000Z');
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 2, earliestExpiryMs, earliestRowId: 'WI-9002' },
        });
        expect(miss.cooldownExpiryAt).toBe(new Date(earliestExpiryMs).toISOString());
        // cooldownExpiryAt is the absolute complement of the (still-present) relative sec.
        expect(typeof (miss as { cooldownExpirySec: number | null }).cooldownExpirySec).toBe('number');
      });

      it('surfaces cooldownEarliestRowId and teaches the SAME-id-vs-different-id distinction (EI-16519)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 2, earliestExpiryMs: Date.now() + 300_000, earliestRowId: 'WI-9003' },
        });
        expect((miss as { cooldownEarliestRowId: string | null }).cooldownEarliestRowId).toBe('WI-9003');
        // Normal case preserved: re-poll after cooldownExpiryAt, do not re-author the spec.
        expect(miss.advice).toMatch(/re-poll/i);
        expect(miss.advice).toMatch(/cooldownExpiryAt/);
        expect(miss.advice).toMatch(/cooldownEarliestRowId/);
        expect(miss.advice).toMatch(/EI-16519/);
        // A bare advancing expiry alone is explicitly NOT treated as proof of a livelock —
        // that was EI-16475's finding (a MIN over multiple self-released rows legitimately
        // jumps forward as churn, with zero bug involved).
        expect(miss.advice).toMatch(/not.{0,40}by itself a livelock signal/i);
        expect(miss.advice).toMatch(/ordinary churn/i);
        // Escalation is now conditioned on the SAME id recurring, not on the number alone.
        expect(miss.advice).toMatch(/SAME id/);
        expect(miss.advice).toMatch(/EI-14615/);
      });

      it('cooldownExpiryAt is null-safe when earliestExpiryMs is null (defensive; WI-5303 makes it non-null in practice)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 1, earliestExpiryMs: null, earliestRowId: null },
        });
        expect(miss.cooldownOnly).toBe(true);
        expect(miss.cooldownExpiryAt).toBeNull();
        expect((miss as { cooldownExpirySec: number | null }).cooldownExpirySec).toBeNull();
      });

      it('a paused miss carries NO cooldownExpiryAt even if a cooldownDiag is passed (pause fully explains the miss)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          pausedReason: 'owner pause',
          cooldownDiag: { cooldownExcluded: 5, earliestExpiryMs: Date.now() + 1_000, earliestRowId: 'WI-9004' },
        });
        expect(miss.paused).toBe(true);
        expect(miss.cooldownExpiryAt).toBeUndefined();
      });
    });

    it('fleetScopedMiss keeps the ORIGINAL scope-mismatch message when cooldownDiag is null/absent (no false reattribution)', () => {
      const miss = fleetScopedMiss(cooldownScope, [], { cooldownDiag: null });
      expect(miss.cooldownOnly).toBeUndefined();
      expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    });

    it('a paused miss NEVER reattributes to cooldown, even if a cooldownDiag is passed (pause explains the miss fully)', () => {
      const miss = fleetScopedMiss(cooldownScope, [], {
        pausedReason: 'owner pause',
        cooldownDiag: { cooldownExcluded: 5, earliestExpiryMs: Date.now() + 1_000, earliestRowId: 'WI-9005' },
      });
      expect(miss.paused).toBe(true);
      expect(miss.cooldownOnly).toBeUndefined();
      expect(miss.error).toMatch(/winding-down/);
    });
  });

  // WI-5561: scheduler:get_next's fleet-scoped miss path gave ZERO diagnosis when the
  // whole issue-family pool was floor-gated (federation-detector / owner-action /
  // claim-hold / observation-lane / …), leaving a fleet member (and the leader they'd
  // report a false "scope/spec bug" to) with nothing but a bare "no claimable
  // work-item matched fleet scope". diagnoseFleetScopeIssueFloorMiss reuses the exact
  // aggregateIssueClaimExclusions floor-breakdown the non-fleet miss path already gets
  // via buildMissDiagnosis; fleetScopedMiss surfaces it honestly instead of the bare
  // message.
  describe('WI-5561: issue-family floor-breakdown miss re-attribution', () => {
    const fakeTx = { unsafe: vi.fn() };
    const issueScope = {
      ownerId: 'su-member',
      fleetSlug: 'bug-drain-200k',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'bugs-rev1',
          revision: 1,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          states: ['open'],
        },
        revision: 1,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    const floorGatedBreakdown = {
      matchedByFilter: 302,
      claimable: 0,
      affinityCoverage: { denominator: 0, nonEmptyPaths: 0, floor: 0.5, belowFloor: false },
      queueControl: ZERO_QUEUE_CONTROL,
      excluded: {
        ...mapIssueClaimExclusionCounts(undefined),
        claimHold: 33,
        needsOwnerAction: 80,
        observationLane: 21,
        federationDetector: 169,
      },
    };

    beforeEach(() => {
      fakeTx.unsafe.mockReset();
      admissionMocks.boundedPgReadTxn.mockImplementation(
        async (run: (tx: typeof fakeTx) => Promise<unknown>) => run(fakeTx),
      );
    });

    it('returns the floor breakdown when the spec matches issue-family rows, threading harness/assignee/states/rigAvailable', async () => {
      admissionMocks.aggregateIssueClaimExclusions.mockResolvedValue(floorGatedBreakdown);

      const diag = await diagnoseFleetScopeIssueFloorMiss({
        scope: issueScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
        rigAvailable: true,
      });

      expect(diag).toEqual(floorGatedBreakdown);
      const [filterArg, optsArg] = admissionMocks.aggregateIssueClaimExclusions.mock.calls[0] ?? [];
      expect(filterArg).toEqual(issueScope.record.spec.view.filter);
      expect(optsArg).toMatchObject({
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
        assignee: 'su-member',
        rigAvailable: true,
        states: ['open'],
        client: fakeTx,
      });
      const [, txnOpts] = admissionMocks.boundedPgReadTxn.mock.calls[0] ?? [];
      expect(txnOpts).toEqual({ acquireTimeoutMs: 2_250, timeoutMs: 6_750 });
      expect(
        txnOpts.acquireTimeoutMs + txnOpts.timeoutMs + 3_000,
      ).toBe(FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS);
    });

    it('fits acquire + statement + helper overhead inside a tighter caller budget', async () => {
      admissionMocks.aggregateIssueClaimExclusions.mockResolvedValue(floorGatedBreakdown);

      await diagnoseFleetScopeIssueFloorMiss({
        scope: issueScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
        totalBudgetMs: 8_000,
      });

      expect(admissionMocks.boundedPgReadTxn).toHaveBeenCalledWith(expect.any(Function), {
        acquireTimeoutMs: 1_250,
        timeoutMs: 3_750,
      });
    });

    it('falls back to the spec\'s own `states` when no explicit states are passed', async () => {
      admissionMocks.aggregateIssueClaimExclusions.mockResolvedValue(floorGatedBreakdown);
      await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      const optsArg = admissionMocks.aggregateIssueClaimExclusions.mock.calls[0]?.[1];
      expect(optsArg?.states).toEqual(['open']);
    });

    it('EI-18663622382734446: returns the breakdown (NOT null) when the filter matches zero issue-family rows — the spec-empty case must be distinguishable from a diagnosis failure', async () => {
      const zeroMatch = { matchedByFilter: 0, claimable: 0, excluded: floorGatedBreakdown.excluded };
      admissionMocks.aggregateIssueClaimExclusions.mockResolvedValue(zeroMatch);
      const diag = await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      expect(diag).toEqual(zeroMatch);
    });

    it('FAILS SOFT: a query error degrades to null, never throws (annotation only, like diagnoseFleetScopeCooldownMiss)', async () => {
      admissionMocks.aggregateIssueClaimExclusions.mockRejectedValue(new Error('pg unavailable'));
      const diag = await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      expect(diag).toBeNull();
    });

    it('FAILS SOFT: a bounded transaction acquisition/timeout error degrades to null', async () => {
      admissionMocks.boundedPgReadTxn.mockRejectedValue(new Error('bounded transaction timed out'));
      const diag = await diagnoseFleetScopeIssueFloorMiss({
        scope: issueScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });
      expect(diag).toBeNull();
      expect(admissionMocks.aggregateIssueClaimExclusions).not.toHaveBeenCalled();
    });

    it('skips the DB entirely when the caller cannot fund both 100ms legs plus helper overhead', async () => {
      const diag = await diagnoseFleetScopeIssueFloorMiss({
        scope: issueScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
        totalBudgetMs: 3_199,
      });
      expect(diag).toBeNull();
      expect(admissionMocks.boundedPgReadTxn).not.toHaveBeenCalled();
    });

    it('returns null when the workspace cannot be resolved (nothing to diagnose)', async () => {
      const diag = await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: null });
      expect(diag).toBeNull();
      expect(admissionMocks.aggregateIssueClaimExclusions).not.toHaveBeenCalled();
    });

    it('fleetScopedMiss surfaces excludedBreakdown + excludedBreakdownSummary + floor-gated advice when an issueBreakdown is present', () => {
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: floorGatedBreakdown });
      expect(miss.windDown).toBe(true);
      expect(miss.claimability).toMatchObject({
        value: 0,
        population: {
          basis: 'issue-family',
          matchedByFilter: 302,
          excluded: expect.objectContaining({ federationDetector: 169, claimHold: 33 }),
        },
        interpretation: { state: 'floor-gated', exactness: { status: 'exact' } },
      });
      expect(miss.excludedBreakdown).toEqual(floorGatedBreakdown);
      expect(miss.excludedBreakdownSummary).toMatch(/federationDetector=169/);
      expect(miss.excludedBreakdownSummary).toMatch(/needsOwnerAction=80/);
      expect(miss.excludedBreakdownSummary).toMatch(/claimHold=33/);
      expect(miss.excludedBreakdownSummary).toMatch(/observationLane=21/);
      // zero-count buckets are dropped from the summary, not padded in
      expect(miss.excludedBreakdownSummary).not.toMatch(/taken=0/);
      expect(miss.advice).toMatch(/FLOOR-GATED miss \(WI-5561/);
      expect(miss.advice).toMatch(/not a scope\/spec mismatch/);
      expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
    });

    // WI-10004358: a floor-gated lane whose spec rows are pending PEER REVIEW is not drained —
    // review never self-clears, and the member is who can do it. Measured on goal 60d3a8's drain
    // spec: 331 matched, 0 claimable, 24 pending review, and members were told windDown:true.
    it('fleetScopedMiss routes a member to peer review instead of standing down when spec rows await review', () => {
      const reviewBreakdown = {
        ...floorGatedBreakdown,
        queueControl: { ...ZERO_QUEUE_CONTROL, pendingAgentReview: 24, revisionRequestedAgentReview: 1 },
      };
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: reviewBreakdown, harness: 'papercusp' });
      expect(miss.windDown).toBe(false);
      expect(miss.reviewable).toMatchObject({
        pendingAgentReview: 24,
        list: {
          tool: 'work_items:claimable',
          args: { harness: 'papercusp', spec: issueScope.fleetSlug, breakdownOnly: true },
          idsAt: 'excludedSample.queueControl.agentReview[].id',
        },
        claim: {
          tool: 'improvements:agent-review',
          mode: 'claim',
          idFrom: 'excludedSample.queueControl.agentReview[].id',
          harness: 'papercusp',
        },
        grade: { tool: 'blender:grade-idea' },
      });
      expect(miss.error).toMatch(/^REVIEWABLE, NOT IDLE: 24 spec-matched row\(s\)/);
      expect(miss.error).not.toContain('WI-10004358');
      // The floor-gated classification itself is still reported, after the review lead.
      expect(miss.error).toMatch(/POOL BLOCKED, NOT SPEC-BROKEN/);
      expect(miss.advice).toMatch(/^DO NOT STAND DOWN YET: review the 24 pending row\(s\)/);
      expect(miss.advice).toMatch(/blender:grade-idea/);
    });

    it('fleetScopedMiss still certifies the floor-gated drain when nothing awaits review (revision-requested alone is not reviewable)', () => {
      const revisionOnly = {
        ...floorGatedBreakdown,
        queueControl: { ...ZERO_QUEUE_CONTROL, revisionRequestedAgentReview: 3 },
      };
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: revisionOnly });
      expect(miss.windDown).toBe(true);
      expect(miss.reviewable).toBeUndefined();
      expect(miss.error).not.toMatch(/REVIEWABLE/);
    });

    it('fleetScopedMiss never offers review to a PAUSED fleet member', () => {
      const reviewBreakdown = {
        ...floorGatedBreakdown,
        queueControl: { ...ZERO_QUEUE_CONTROL, pendingAgentReview: 5 },
      };
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: reviewBreakdown, pausedReason: 'drain' });
      expect(miss.reviewable).toBeUndefined();
      expect(miss.error).not.toMatch(/REVIEWABLE/);
    });

    // EI-18741523426513509: `spec_matches_nothing` asserts a CAUSE (the spec's filter is wrong);
    // a floor-gated miss is an EFFECT (real rows matched, but every one is presently excluded by
    // a transient claim floor) with the OPPOSITE remedy — await/re-poll, never rewrite the spec.
    // These assert the two are named with distinct, machine-checkable reason tokens.
    it('EI-18741523426513509: sets reason `all_matches_gated` (NOT spec_matches_nothing) when the spec matched real rows but every one is floor-excluded', () => {
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: floorGatedBreakdown });
      expect(miss.reason).toBe('all_matches_gated');
      expect(miss.error).toMatch(/POOL BLOCKED, NOT SPEC-BROKEN/);
      expect(miss.advice).toMatch(/reason: "all_matches_gated"/);
      // the advice explicitly disambiguates from spec_matches_nothing (a DIFFERENT reason token
      // with the opposite remedy) rather than ever claiming/escalating a spec-authoring bug itself
      expect(miss.error).not.toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.advice).not.toMatch(/ESCALATE to your fleet leader NOW \(EI-18663622382734446\)/);
    });

    // The exact recurrence this ticket documents: a plan-lane `externalBlocker` gate (not any
    // other floor) is the sole reason every matched row is excluded — the member must still get
    // the transient token, not a spec-authoring escalation, and not a bare undefined reason.
    it('EI-18741523426513509 recurrence guard: an uncleared plan-lane externalBlocker gate (the live 2026-07-26 repro) returns `all_matches_gated`, never `spec_matches_nothing`', () => {
      const externalBlockerOnlyBreakdown = {
        matchedByFilter: 2,
        claimable: 0,
        affinityCoverage: { denominator: 0, nonEmptyPaths: 0, floor: 0.5, belowFloor: false },
        queueControl: ZERO_QUEUE_CONTROL,
        excluded: {
          ...mapIssueClaimExclusionCounts(undefined),
          externalBlocker: 2,
        },
      };
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: externalBlockerOnlyBreakdown });
      expect(miss.reason).toBe('all_matches_gated');
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.excludedBreakdownSummary).toMatch(/externalBlocker=2/);
      expect(miss.windDown).toBe(true);
    });

    it('fleetScopedMiss keeps the ORIGINAL scope-mismatch message + omits excludedBreakdown when issueBreakdown is null/absent', () => {
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: null });
      expect(miss.excludedBreakdown).toBeUndefined();
      expect(miss.excludedBreakdownSummary).toBeUndefined();
      expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    });

    it('a paused miss NEVER surfaces the floor breakdown, even if an issueBreakdown is passed (pause explains the miss fully)', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: floorGatedBreakdown,
      });
      expect(miss.paused).toBe(true);
      expect(miss.excludedBreakdown).toBeUndefined();
      expect(miss.error).toMatch(/winding-down/);
    });

    it('a cooldown-only miss and a floor breakdown can co-occur (both are independent, non-paused annotations)', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        cooldownDiag: { cooldownExcluded: 2, earliestExpiryMs: Date.now() + 5_000, earliestRowId: 'WI-9010' },
        issueBreakdown: floorGatedBreakdown,
      });
      expect(miss.cooldownOnly).toBe(true);
      expect(miss.excludedBreakdown).toEqual(floorGatedBreakdown);
      // cooldown's message takes precedence when both are present (fleetScopedMiss's
      // `error` branches on cooldown before breakdown), but the breakdown data itself
      // still rides along on the response for the caller to inspect.
      expect(miss.error).toMatch(/YOUR OWN release-cooldown floor/);
    });
  });

  // EI-18663622382734446: a claim-spec that matches ZERO rows is indistinguishable from a
  // drained queue at the member's end unless fleetScopedMiss names the case loudly. Live
  // incident: spec `p2p-release-lane@8` matched 0 of 1250 rows for 4.5h while two members
  // separately, in good faith, reported "floor-gated, not a spec bug" — because the miss they
  // WI-7316: the plan-lane bounce happens AFTER the atomic claim, so no SQL-floor diagnosis in
  // this file can see it. A lane whose every candidate was bounced by a plan item stuck on a
  // STALE `blocked` token therefore used to report as an ordinary drain — windDown:true, "no
  // claimable work-item matched fleet scope" — and each member in turn stood down while the work
  // sat one status write from claimable. These pin the opposite.
  describe('WI-7316: a lane held shut by a STALE plan-item block is never certified as a drain', () => {
    const staleScope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'bugs-lane',
          revision: 3,
          view: { filter: { field: 'kind', op: 'in' as const, value: ['bug', 'change'] } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          states: ['open'],
        },
        revision: 1,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };
    const staleRows = [
      { workItemId: 'WI-8001', planSlug: 'a-plan', itemId: 'P-003', hint: 'every blocked-by dependency has already resolved' },
      { workItemId: 'WI-8002', planSlug: 'a-plan', itemId: 'P-004', hint: 'every blocked-by dependency has already resolved' },
    ];

    it('refuses windDown and names the rows + the one-call remedy', () => {
      const miss = fleetScopedMiss(staleScope, [], { staleBlockedLane: staleRows });
      // THE regression this exists to prevent: certifying a drain here is what silently
      // stands a whole fleet down on work that is still there.
      expect(miss.windDown).toBe(false);
      expect(miss.reason).toBe('stale_plan_item_block');
      expect(miss.staleBlockedLane).toEqual(staleRows);
      expect(miss.error).toMatch(/STALE PLAN-ITEM BLOCK, NOT A DRAINED LANE/);
      // The rows must be NAMED — a count alone leaves the member with nothing to act on.
      expect(miss.error).toMatch(/WI-8001 → a-plan#P-003/);
      // The advice must be executable, not a diagnosis: an exact call it can paste.
      expect(miss.advice).toMatch(/plans:set-status \{ slug: "a-plan", item: "P-003", status: "todo" \}/);
      // And it must not contradict windDown:false by also telling the member to stand down —
      // the failure mode if this case fell through to the planComplete/specExhausted advice.
      expect(miss.advice).not.toMatch(/loop:end/);
      expect(miss.advice).toMatch(/do NOT stand down/i);
      // Re-polling is the intuitive move and is exactly wrong: the token never self-clears.
      expect(miss.advice).toMatch(/do NOT just re-poll/);
    });

    it('is inert when no row carried a stale hint — an ordinary drain still certifies', () => {
      // The falsifiability control for the pair above: same scope, same call, empty list. If the
      // new branch fired on the mere PRESENCE of the option (or unconditionally), this would red.
      const miss = fleetScopedMiss(staleScope, [], { staleBlockedLane: [] });
      expect(miss.windDown).toBe(true);
      expect(miss.reason).not.toBe('stale_plan_item_block');
      expect(miss).not.toHaveProperty('staleBlockedLane');
      expect(miss.error).not.toMatch(/STALE PLAN-ITEM BLOCK/);
    });

    it('a PAUSED fleet still reports the pause, not the stale block', () => {
      // Precedence: every diagnosis here is suppressed while paused because the pause message
      // already fully explains the miss — and a paused member must stand down regardless of
      // what its lane holds. This pins the new branch into that same rule.
      const miss = fleetScopedMiss(staleScope, [], { staleBlockedLane: staleRows, pausedReason: 'winding down' });
      expect(miss.windDown).toBe(true);
      expect(miss.paused).toBe(true);
      expect(miss.reason).not.toBe('stale_plan_item_block');
      expect(miss.error).toMatch(/winding-down/);
    });
  });

  // could actually observe (windDown:true, a bare message) is the SAME shape a genuine drain
  // produces. These tests assert the zero-match case gets its own loud, escalate-worthy shape.
  describe('EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain', () => {
    // The explicit issue-kind restriction makes the issue breakdown complete for this
    // fixture. An id allowlist by itself can also admit feature-family work.
    const issueScope = {
      ownerId: 'su-member',
      fleetSlug: 'p2p-release',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'p2p-release-lane',
          revision: 8,
          view: { filter: { all: [
            { field: 'kind', op: 'in' as const, value: ['bug', 'change', 'task'] },
            { field: 'id', op: 'in' as const, value: ['WI-9001', 'WI-9002'] },
          ] } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          states: ['open'],
        },
        revision: 1,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    const zeroMatchBreakdown = {
      matchedByFilter: 0,
      claimable: 0,
      affinityCoverage: { denominator: 0, nonEmptyPaths: 0, floor: 0.5, belowFloor: false },
      queueControl: ZERO_QUEUE_CONTROL,
      excluded: {
        ...mapIssueClaimExclusionCounts(undefined),
      },
    };

    it('sets a distinct top-level reason + loud error + escalate advice, but still windDown:true (correct to stop pulling)', () => {
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: zeroMatchBreakdown });
      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.claimability).toMatchObject({
        value: 0,
        population: {
          spec: { ref: 'p2p-release-lane (spec rev 8)', revision: 8, planScoped: false },
          matchedByFilter: 0,
        },
        interpretation: { state: 'spec-empty', exactness: { status: 'exact' } },
      });
      // EI-18741523426513509: a genuinely empty spec (matchedByFilter === 0) must never also
      // carry the floor-gated token — the two are mutually exclusive by construction (floorGated
      // requires matchedByFilter > 0).
      expect(miss.reason).not.toBe('all_matches_gated');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.error).toMatch(/ESCALATE to your fleet leader NOW/);
      expect(miss.advice).toMatch(/ESCALATE to your fleet leader NOW/);
      expect(miss.advice).toMatch(/spec_matches_nothing/);
      expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
      expect(miss.excludedBreakdown).toEqual(zeroMatchBreakdown);
      // The old (pre-fix) summary text actively said the OPPOSITE of the truth for this case
      // ("not a scope/spec bug — re-authoring the claim spec will not help"); assert it is gone.
      expect(miss.excludedBreakdownSummary).not.toMatch(/re-authoring the claim spec will not help/);
      expect(miss.excludedBreakdownSummary).toMatch(/SPEC ITSELF is the problem/);
    });

    it('EI-20186990913643457: reports successful exhaustion when every status-floor-free match is terminal', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 2, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 0 },
      });

      expect(miss.reason).toBe('spec_exhausted');
      expect(miss.claimability.interpretation).toMatchObject({
        state: 'drained',
        exactness: { status: 'exact' },
      });
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/SPEC EXHAUSTED/);
      expect(miss.error).toMatch(/successful drain/);
      expect(miss.error).not.toMatch(/ESCALATE/);
      expect(miss.advice).toMatch(/LANE COMPLETE/);
      expect(miss.advice).toMatch(/Do NOT escalate, widen, or re-author/);
      expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
      expect(miss.advice).toMatch(/park the standing watch `watch:create/);
      expect(miss.advice).toMatch(/wake:true, once:false/);
      expect(miss.advice).toContain('backlog interest only');
      expect(miss.advice).toMatch(/work-item:claimable/);
      expect(miss.advice).toMatch(/payload_filter/);
      expect(miss.excludedBreakdownSummary).toMatch(/all 2 are terminal/);
      expect((miss as { terminalExhaustion?: unknown }).terminalExhaustion).toEqual({
        matchedByFilter: 2,
        terminalMatchedByFilter: 2,
        inFlightMatchedByFilter: 0,
        parkedMatchedByFilter: 0,
      });
    });

    it.each([
      ['completed plan', () => fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        planTerminality: { planSlugs: ['finished'], terminalPlanSlugs: ['finished'], allTerminal: true },
      })],
      ['exhausted spec', () => fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 2, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 0 },
      })],
      ['held remainder', () => fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 1, inFlightMatchedByFilter: 1, parkedMatchedByFilter: 0 },
      })],
      ['ordinary feature drain', () => fleetScopedMiss({
        ...issueScope,
        record: { ...issueScope.record, spec: { ...issueScope.record.spec, view: {
          filter: { field: 'kind', op: '=' as const, value: 'feature' },
        } } },
      }, [], {
        issueBreakdown: zeroMatchBreakdown,
        featureBreakdown: { matchedByFilter: 0, claimable: 0, excluded: { claimFloors: 0, reservedPlanLane: 0 } },
      })],
      ['empty spec with live leader', () => fleetScopedMiss(issueScope, [], { issueBreakdown: zeroMatchBreakdown })],
      ['empty spec with dead leader', () => fleetScopedMiss(issueScope, [], { issueBreakdown: zeroMatchBreakdown, leaderLiveness: false })],
      ['floor-gated spec', () => fleetScopedMiss(issueScope, [], {
        issueBreakdown: { ...zeroMatchBreakdown, matchedByFilter: 1, excluded: { ...zeroMatchBreakdown.excluded, claimHold: 1 } },
      })],
      ['filtered idle watch', () => fleetScopedMiss(issueScope)],
      ['unfilterable idle scope', () => fleetScopedMiss({
        ...issueScope,
        record: { ...issueScope.record, spec: { ...issueScope.record.spec, view: {} } },
      })],
    ] as const)('P-008: %s checks retained obligations before winding down', (_label, buildMiss) => {
      const { advice } = buildMiss();
      // A scheduler miss describes the pool, not whether this caller has finished its own work.
      expect(advice).toContain('First finish independent work on held items');
      // S41 repeats 0 and 2 completed local verification but treated the armed
      // loop as a substitute for registering the known dependency's exact wake.
      expect(advice).toContain('After that work completes, reassess the remaining held obligations in this same turn');
      expect(advice).toContain('An already-armed loop is not a substitute for this exact dependency await');
      expect(advice).toContain('a blocked item you still hold stays held');
      expect(advice).toContain('retained blocked claims stay held');
      expect(advice).toContain('work_items:set_blocker');
      expect(advice).toContain('exact recorded blocker event');
      expect(advice).toContain('events:await');
      expect(advice).toContain('timeout_sec');
      expect(advice).toContain('on_timeout:"wake"');
      expect(advice).toContain('Keep the existing loop armed until registration succeeds');
      expect(advice).toContain('If no independently actionable blocker event is recorded');
      expect(advice).toContain('do not invent an event from blocked status');
      // The missing-key branch must be decided before an instruction to create a blocker.
      // S41 observed an invented peer-review:<item id> ref when registration came first.
      const missingKey = advice.indexOf('If no independently actionable blocker event is recorded');
      const knownKey = advice.indexOf('Otherwise copy the supplied dependency event key exactly');
      expect(knownKey).toBeGreaterThan(missingKey);
      expect(advice.slice(missingKey, knownKey)).toContain('do not call work_items:set_blocker or events:await');
      expect(advice.slice(missingKey, knownKey)).toContain('Never fabricate a blocker ref or derive an event key from an item id');
      expect(advice).toContain('backlog interest only');
      expect(advice).not.toContain('recovery.steps');
      // D-009 still permits replacing the loop AFTER a guaranteed wake exists, and stopping
      // after completed work or a verified stop/handoff. Neither depends on a refusal first.
      expect(advice).toContain('Only after a guaranteed wake is registered');
      const stop = 'call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true }';
      expect(advice).toContain(stop);
      expect(advice.indexOf('events:await')).toBeLessThan(advice.indexOf(stop));
    });

    it('renders loop:end only for legitimate completion or stop when unfinished obligations are retained', () => {
      const { advice } = fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        planTerminality: { planSlugs: ['finished'], terminalPlanSlugs: ['finished'], allTerminal: true },
      });
      // Finishing the shared plan does not establish that this caller's other obligations ended.
      const permission = advice.indexOf('Only after a guaranteed wake is registered');
      const stop = advice.indexOf('call loop:end');
      expect(permission).toBeGreaterThanOrEqual(0);
      expect(stop).toBeGreaterThan(permission);
      expect(advice.slice(permission, stop)).toContain('no unfinished obligations remain');
      expect(advice.slice(permission, stop)).toContain('a verified stop/handoff has disposed of them');
      expect(advice.slice(permission, stop)).toContain('release only finished lane resources');
      expect(advice.slice(permission, stop)).toContain('retained blocked claims stay held');
      expect(advice.indexOf('If work remains blocked')).toBeLessThan(permission);
    });

    it('renders continue-independent-work guidance for a partially blocked agent', () => {
      const { advice } = fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 1,
          inFlightMatchedByFilter: 1, parkedMatchedByFilter: 0 },
      });
      const independent = advice.indexOf('First finish independent work on held items');
      const reassess = advice.indexOf('After that work completes, reassess the remaining held obligations in this same turn');
      const blocked = advice.indexOf('If work remains blocked');
      expect(independent).toBeGreaterThanOrEqual(0);
      expect(reassess).toBeGreaterThan(independent);
      expect(blocked).toBeGreaterThan(reassess);
      expect(advice.indexOf('call loop:end')).toBeGreaterThan(blocked);
      expect(advice).toContain('a blocked item you still hold stays held');
      expect(advice).toContain('Keep the existing loop armed until registration succeeds');
    });

    it('renders a bounded exact-event wake with timeout for a fully blocked agent', () => {
      const { advice } = fleetScopedMiss(issueScope, [], { issueBreakdown: zeroMatchBreakdown });
      const missing = advice.indexOf('If no independently actionable blocker event is recorded');
      const supplied = advice.indexOf('Otherwise copy the supplied dependency event key exactly');
      expect(missing).toBeGreaterThanOrEqual(0);
      expect(supplied).toBeGreaterThan(missing);
      expect(advice.slice(missing, supplied)).toContain('do not call work_items:set_blocker or events:await');
      expect(advice.slice(missing, supplied)).toContain('Never fabricate a blocker ref or derive an event key from an item id');
      const registration = advice.slice(supplied, advice.indexOf('Only after a guaranteed wake is registered'));
      expect(registration).toContain('record its typed blocker with work_items:set_blocker if not already recorded');
      expect(registration).toContain('events:await for the exact recorded blocker event');
      expect(registration).toContain('positive timeout_sec matched to its recheckAt and on_timeout:"wake"');
      expect(registration).toContain('register it before ending this turn');
      expect(registration).toContain('Keep the existing loop armed until registration succeeds');
      expect(registration).toContain('do not invent an event from blocked status or await a lifecycle transition that this session itself must perform');
      expect(registration).toContain('A standing work-item:claimable watch is backlog interest only');
    });

    it('EI-20260781488788952: reports a completed bound plan as a successful plan wind-down', () => {
      const completedPlanScope = {
        ...issueScope,
        fleetSlug: 'completed-plan-fleet',
        record: {
          ...issueScope.record,
          spec: {
            ...issueScope.record.spec,
            specId: 'completed-plan-lane',
            revision: 3,
            view: { filter: { field: 'plan', op: '=' as const, value: 'finished-plan' } },
          },
        },
      };
      const planTerminality = {
        planSlugs: ['finished-plan'],
        terminalPlanSlugs: ['finished-plan'],
        allTerminal: true,
      };
      const miss = fleetScopedMiss(completedPlanScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        planTerminality,
        leaderLiveness: true,
      });

      expect(miss.reason).toBe('plan_complete');
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/PLAN COMPLETE/);
      expect(miss.error).not.toMatch(/ESCALATE/);
      expect(miss.advice).toMatch(/successful completed-plan wind-down/);
      expect(miss.advice).toMatch(/Do NOT escalate, widen, or re-author/);
      expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
      expect((miss as { planTerminality?: unknown }).planTerminality).toEqual(planTerminality);
    });

    it('EI-22179902813950215: a plan-complete verdict survives a degraded (null) issue-floor breakdown', () => {
      // Reproduces the observed bug: two scheduler:get_next calls against the SAME unchanged
      // terminal plan gave materially different diagnoses, ~4 minutes apart, depending only on
      // whether the UNRELATED issue-floor breakdown query happened to time out.
      // diagnoseFleetScopeIssueFloorMiss fails soft to null on any query error/timeout, by
      // design (see its doc comment) — a plan's terminality is read directly from the plan's
      // own lifecycle and does not depend on that query, so a null breakdown must not silently
      // suppress it and fall through to the generic miss + its unfollowable
      // park-a-work-item:claimable-await advice.
      const completedPlanScope = {
        ...issueScope,
        fleetSlug: 'completed-plan-fleet-degraded-breakdown',
        record: {
          ...issueScope.record,
          spec: {
            ...issueScope.record.spec,
            specId: 'completed-plan-lane-degraded-breakdown',
            revision: 5,
            view: { filter: { field: 'plan', op: '=' as const, value: 'finished-plan' } },
          },
        },
      };
      const planTerminality = {
        planSlugs: ['finished-plan'],
        terminalPlanSlugs: ['finished-plan'],
        allTerminal: true,
      };
      const miss = fleetScopedMiss(completedPlanScope, [], {
        // issueBreakdown intentionally OMITTED — the degraded/timed-out case.
        planTerminality,
      });

      expect(miss.reason).toBe('plan_complete');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/PLAN COMPLETE/);
      expect(miss.advice).toMatch(/successful completed-plan wind-down/);
      expect(miss.advice).toMatch(/Do NOT escalate, widen, or re-author/);
      // The pre-fix generic fallback shape must NOT appear.
      expect(miss.error).not.toMatch(/NOT allowed to fall through to the generic backlog/);
      expect(miss.advice).not.toMatch(/park ONE events:await/);
      expect((miss as { planTerminality?: unknown }).planTerminality).toEqual(planTerminality);
    });

    it('EI-22179902813950215: a successfully-read nonzero issue-floor breakdown still overrides plan terminality', () => {
      // The belt-and-suspenders half of the same fix: when the issue-floor breakdown DID
      // succeed and reports a live matching row, that must still veto plan_complete even
      // though planTerminality independently reads allTerminal:true — the two would be
      // genuinely contradictory, and only a NULL (unavailable) breakdown should defer to
      // planTerminality alone.
      const completedPlanScope = {
        ...issueScope,
        fleetSlug: 'completed-plan-fleet-nonzero-breakdown',
        record: {
          ...issueScope.record,
          spec: {
            ...issueScope.record.spec,
            specId: 'completed-plan-lane-nonzero-breakdown',
            revision: 7,
            view: { filter: { field: 'plan', op: '=' as const, value: 'finished-plan' } },
          },
        },
      };
      const planTerminality = {
        planSlugs: ['finished-plan'],
        terminalPlanSlugs: ['finished-plan'],
        allTerminal: true,
      };
      const miss = fleetScopedMiss(completedPlanScope, [], {
        issueBreakdown: { ...zeroMatchBreakdown, matchedByFilter: 2 },
        planTerminality,
      });

      expect(miss.reason).not.toBe('plan_complete');
    });

    it('EI-20260781488788952: a dead leader changes the zero-match handoff without changing the spec verdict', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        leaderLiveness: false,
      });

      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.error).not.toMatch(/ESCALATE to your fleet leader NOW/);
      expect(miss.error).toMatch(/leader is not live/);
      expect(miss.error).toMatch(/fleet launcher\/owner/);
      expect(miss.advice).toMatch(/do not route this miss to a dead leader/);
      expect(miss.advice).toMatch(/take leadership as the sole live member/);
      expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
      expect((miss as { leaderLiveness?: unknown }).leaderLiveness).toBe(false);
    });

    it('keeps the spec-authoring verdict when the status-floor-free matches are mixed terminal and active', () => {
      // The non-terminal row is neither held nor parked, so no never-pullable bucket explains it.
      const miss = fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 1, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 0 },
      });

      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.error).toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.error).toMatch(/ESCALATE to your fleet leader NOW/);
      expect(miss.advice).toMatch(/spec_matches_nothing/);
    });

    describe('WI-6554700010010002: a remainder held by agents or parked is not an empty spec', () => {
      // Observed live (gate-lint-green, claim spec rev 8): an id allowlist of 17 rows, 16 done and
      // 1 wip held by a peer. The claimable-state breakdown read 0, so every idle member was told
      // "SPEC MATCHES NOTHING ... ESCALATE to your fleet leader NOW" about a spec that was correct.
      const heldRemainder = { matchedByFilter: 17, terminalMatchedByFilter: 16, inFlightMatchedByFilter: 1, parkedMatchedByFilter: 0 };

      it('reports spec_in_flight with drain advice when the only non-terminal match is held by an agent', () => {
        const miss = fleetScopedMiss(issueScope, [], {
          issueBreakdown: zeroMatchBreakdown,
          terminalExhaustion: heldRemainder,
        });

        expect(miss.reason).toBe('spec_in_flight');
        expect(miss.windDown).toBe(true);
        expect(miss.error).toMatch(/NOTHING CLAIMABLE, REMAINDER IN FLIGHT/);
        expect(miss.error).toMatch(/16 terminal, 1 held by an agent \(in flight\), 0 parked/);
        expect(miss.error).toMatch(/NOT a spec-authoring problem/);
        expect(miss.error).not.toMatch(/SPEC MATCHES NOTHING/);
        expect(miss.error).not.toMatch(/ESCALATE to your fleet leader NOW/);
        expect(miss.advice).toMatch(/NOTHING TO CLAIM, NOT A SPEC BUG/);
        expect(miss.advice).toMatch(/spec_in_flight/);
        expect(miss.advice).toMatch(/Do NOT escalate, widen, or re-author/);
        expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
        expect(miss.advice).toContain('a blocked item you still hold stays held');
        expect(miss.advice).toMatch(/park the standing watch `watch:create/);
        expect(miss.advice).toMatch(/work-item:claimable/);
        expect(miss.advice).toMatch(/payload_filter/);
        expect(miss.advice).not.toMatch(/ESCALATE to your fleet leader NOW/);
        expect(miss.advice).toContain('backlog interest only');
        expect(miss.excludedBreakdownSummary).toMatch(/16 terminal, 1 held by an agent, 0 parked/);
        expect(miss.excludedBreakdownSummary).toMatch(/the spec is not empty/);
        expect(miss.excludedBreakdownSummary).not.toMatch(/SPEC ITSELF is the problem/);
        expect(miss.claimability.interpretation).toMatchObject({
          state: 'drained',
          exactness: { status: 'exact', reason: expect.stringMatching(/held by an agent, or parked/) },
        });
        expect((miss as { terminalExhaustion?: unknown }).terminalExhaustion).toEqual(heldRemainder);
      });

      it('reports spec_in_flight when the non-terminal remainder is parked (blocked/needs-human) or wholly held', () => {
        const parked = fleetScopedMiss(issueScope, [], {
          issueBreakdown: zeroMatchBreakdown,
          terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 1, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 1 },
        });
        expect(parked.reason).toBe('spec_in_flight');
        expect(parked.error).toMatch(/1 terminal, 0 held by an agent \(in flight\), 1 parked \(blocked\/needs-human\)/);

        // No terminal row at all: every match is still in flight with a holder.
        const allHeld = fleetScopedMiss(issueScope, [], {
          issueBreakdown: zeroMatchBreakdown,
          terminalExhaustion: { matchedByFilter: 3, terminalMatchedByFilter: 0, inFlightMatchedByFilter: 3, parkedMatchedByFilter: 0 },
        });
        expect(allHeld.reason).toBe('spec_in_flight');
      });

      it('does not certify the remainder without a measured zero breakdown, or while paused', () => {
        // A degraded (null) issue-floor breakdown cannot prove that no row is claimable.
        const degraded = fleetScopedMiss(issueScope, [], { terminalExhaustion: heldRemainder });
        expect(degraded.reason).not.toBe('spec_in_flight');

        // A claimable-state breakdown that matched rows means the spec is reaching open work.
        const reachable = fleetScopedMiss(issueScope, [], {
          issueBreakdown: { ...zeroMatchBreakdown, matchedByFilter: 1 },
          terminalExhaustion: heldRemainder,
        });
        expect(reachable.reason).not.toBe('spec_in_flight');

        const paused = fleetScopedMiss(issueScope, [], {
          pausedReason: 'owner pause',
          issueBreakdown: zeroMatchBreakdown,
          terminalExhaustion: heldRemainder,
        });
        expect(paused.reason).not.toBe('spec_in_flight');
      });

      it('keeps spec_exhausted for an all-terminal tranche', () => {
        const miss = fleetScopedMiss(issueScope, [], {
          issueBreakdown: zeroMatchBreakdown,
          terminalExhaustion: { matchedByFilter: 17, terminalMatchedByFilter: 17, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 0 },
        });
        expect(miss.reason).toBe('spec_exhausted');
      });
    });

    it('is mutually exclusive with the divergent (claim-path bug) case by construction', () => {
      // divergent requires claimable > 0, which cannot coexist with matchedByFilter === 0
      // (claimable is a subset of matchedByFilter) — assert the miss never claims both.
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: zeroMatchBreakdown });
      expect(miss.error).not.toMatch(/CLAIM-PATH\/READ-PATH DIVERGENCE/);
    });

    it('a paused miss suppresses specEmpty just like every other breakdown-derived signal', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: zeroMatchBreakdown,
      });
      expect(miss.paused).toBe(true);
      expect(miss.reason).toBeUndefined();
      expect(miss.excludedBreakdown).toBeUndefined();
      expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
    });

    it('cooldown never masks specEmpty — a truly empty spec takes precedence in the error/advice', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        cooldownDiag: { cooldownExcluded: 1, earliestExpiryMs: Date.now() + 5_000, earliestRowId: 'WI-1' },
        issueBreakdown: zeroMatchBreakdown,
      });
      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.error).toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.advice).toMatch(/ESCALATE to your fleet leader NOW/);
    });
  });

  // WI-7151 (EI-19318364531323846): a plan-scoped spec whose promoted items are feature-family
  // (D-009 — every plans:start promotion mints one) made the issue-family-only breakdown above
  // report a confident `matchedByFilter: 0` and therefore `reason: 'spec_matches_nothing'` +
  // `windDown: true` even when real, unclaimed, spec-matching feature-family rows exist. These
  // pin the fix: a positive `featureFamilyMatched` suppresses `specEmpty` entirely and reports
  // the honest, non-drain, non-spec-authoring verdict instead.
  describe('WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot)', () => {
    const planScope = {
      ownerId: 'su-member',
      fleetSlug: 'opencode-omp-research',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'fleet-launch-opencode-omp-research-plan',
          revision: 1,
          view: { filter: { field: 'plan', op: '=' as const, value: 'opencode-omp-token-reduction-research-2026-08-02' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 1,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    const zeroIssueFamilyBreakdown = {
      matchedByFilter: 0,
      claimable: 0,
      affinityCoverage: { denominator: 0, nonEmptyPaths: 0, floor: 0.5, belowFloor: false },
      queueControl: ZERO_QUEUE_CONTROL,
      excluded: {
        ...mapIssueClaimExclusionCounts(undefined),
      },
    };

    describe('EI-24905216534076710: pre-floor feature matches survive miss diagnosis', () => {
      const featureScope = {
        ...planScope,
        record: {
          ...planScope.record,
          spec: {
            ...planScope.record.spec,
            view: { filter: { all: [
              { field: 'kind', op: '=' as const, value: 'feature' },
              { field: 'id', op: 'in' as const, value: ['WI-held-feature'] },
            ] } },
          },
        },
      };
      const heldFeature = {
        matchedByFilter: 1,
        claimable: 0,
        excluded: { claimFloors: 1, reservedPlanLane: 0 },
      };

      it('reports a held feature as floor-gated without widening its non-plan spec', () => {
        const opts = { issueBreakdown: zeroIssueFamilyBreakdown, featureBreakdown: heldFeature };
        const miss = fleetScopedMiss(featureScope, [], opts);

        expect(miss.reason).toBe('all_matches_gated');
        expect(miss.error).toContain('POOL BLOCKED, NOT SPEC-BROKEN');
        expect(miss.error).not.toMatch(/SPEC MATCHES NOTHING|ORDINARY DRAIN/);
        expect(miss.advice).toContain('Do NOT re-author');
        expect(miss.claimability).toMatchObject({
          value: 0,
          population: { basis: 'issue+feature-family', matchedByFilter: 1 },
          interpretation: { state: 'floor-gated' },
        });
        expect(miss.claimability.population.families.feature).toEqual(heldFeature);
      });

      it('combines disjoint families while preserving overlapping exclusion buckets', () => {
        const opts = {
          issueBreakdown: { ...zeroIssueFamilyBreakdown, matchedByFilter: 2 },
          featureBreakdown: { ...heldFeature, matchedByFilter: 3, excluded: { claimFloors: 3, reservedPlanLane: 1 } },
        };
        const miss = fleetScopedMiss(featureScope, [], opts);
        expect(miss.reason).toBe('all_matches_gated');
        expect(miss.claimability.population.matchedByFilter).toBe(5);
        expect(miss.claimability.population.families.feature).toEqual(opts.featureBreakdown);
      });

      it('keeps a claimable feature as a blind spot, with no stand-down', () => {
        const opts = {
          issueBreakdown: zeroIssueFamilyBreakdown,
          featureBreakdown: { matchedByFilter: 2, claimable: 2, excluded: { claimFloors: 0, reservedPlanLane: 0 } },
        };
        const miss = fleetScopedMiss(featureScope, [], opts);
        expect(miss.reason).toBe('issue_family_diagnosis_blind_spot');
        expect(miss.windDown).toBe(false);
        expect(miss.claimability.value).toBe(2);
      });

      it('retains a genuine zero-match authoring verdict when both measured families are empty', () => {
        const opts = {
          issueBreakdown: zeroIssueFamilyBreakdown,
          featureBreakdown: { matchedByFilter: 0, claimable: 0, excluded: { claimFloors: 0, reservedPlanLane: 0 } },
        };
        const miss = fleetScopedMiss(featureScope, [], opts);
        expect(miss.reason).toBe('spec_matches_nothing');
        expect(miss.claimability.population.matchedByFilter).toBe(0);
      });

      it('keeps the pause verdict ahead of measured feature floors', () => {
        const opts = { pausedReason: 'stand down', issueBreakdown: zeroIssueFamilyBreakdown, featureBreakdown: heldFeature };
        const miss = fleetScopedMiss(featureScope, [], opts);
        expect(miss.paused).toBe(true);
        expect(miss.error).toContain('winding-down');
        expect(miss.reason).not.toBe('all_matches_gated');
        expect(miss.reason).not.toBe('spec_matches_nothing');
      });
    });

    it('suppresses specEmpty/spec_matches_nothing when a tier-1 (feature-family) match exists', () => {
      const miss = fleetScopedMiss(planScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 8,
      });
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.reason).toBe('issue_family_diagnosis_blind_spot');
      expect((miss as { featureFamilyMatched?: number }).featureFamilyMatched).toBe(8);
      expect(miss.error).toMatch(/ISSUE-FAMILY DIAGNOSIS BLIND SPOT/);
      expect(miss.error).not.toMatch(/SPEC-AUTHORING problem/);
      // A real candidate exists — the member must NOT stand down.
      expect(miss.windDown).toBe(false);
      expect(miss.advice).toMatch(/PULL AGAIN/);
      expect(miss.advice).not.toMatch(/ESCALATE to your fleet leader NOW \(EI-18663622382734446\)/);
      expect(miss.excludedBreakdownSummary).toMatch(/8 FEATURE-family row/);
    });

    // EI-19393442073558754: this used to fall back to `spec_matches_nothing` (asserted as
    // "no behavior change") — that was itself the false-alarm class this ticket fixes.
    // `planScope`'s filter references `plan` and carries no kind restriction, so a
    // A complete zero-match feature reading permits a drain; a survivor count alone
    // cannot establish whether the filter matched floor-gated feature rows.
    it('reports ordinary_drain when both measured families are empty', () => {
      const miss = fleetScopedMiss(planScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureBreakdown: { matchedByFilter: 0, claimable: 0, excluded: { claimFloors: 0, reservedPlanLane: 0 } },
      });
      expect(miss.reason).toBe('ordinary_drain');
      expect(miss.claimability).toMatchObject({
        value: 0,
        population: { spec: { planScoped: true }, matchedByFilter: 0 },
        interpretation: { state: 'drained', exactness: { status: 'exact' } },
      });
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/ORDINARY DRAIN/);
      expect(miss.error).not.toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.error).toMatch(/genuinely empty right now/);
      expect((miss as { featureFamilyMatched?: number | null }).featureFamilyMatched).toBe(0);
      expect(miss.advice).not.toMatch(/ESCALATE to your fleet leader NOW/);
      expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
    });

    it('keeps plan-scoped family evidence unknown when only a missing or zero survivor count is available', () => {
      for (const fam of [null, undefined, 0] as const) {
        const miss = fleetScopedMiss(planScope, [], {
          issueBreakdown: zeroIssueFamilyBreakdown,
          featureFamilyMatched: fam,
        });
        expect(miss.reason).toBeUndefined();
        expect(miss.claimability.value).toBeNull();
        expect(miss.claimability.interpretation).toMatchObject({
          state: 'unknown',
        });
        expect(miss.windDown).toBe(false);
        expect(miss.error).toMatch(/FEATURE-FAMILY DIAGNOSIS UNAVAILABLE/);
        expect(miss.error).not.toMatch(/ORDINARY DRAIN|SPEC MATCHES NOTHING/);
        expect(miss.advice).toMatch(/Do NOT re-author/);
        expect(miss.advice).toMatch(/repeat identical pulls/);
      }
    });

    it('a paused miss suppresses the feature-family verdict too, same as every other breakdown-derived signal', () => {
      const miss = fleetScopedMiss(planScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 8,
      });
      expect(miss.paused).toBe(true);
      expect(miss.reason).toBeUndefined();
    });

    it('a paused miss suppresses `ordinary_drain` too, same as every other breakdown-derived signal', () => {
      const miss = fleetScopedMiss(planScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 0,
      });
      expect(miss.paused).toBe(true);
      expect(miss.reason).toBeUndefined();
    });

    it('has no effect on a non-zero issueBreakdown.matchedByFilter (only relevant to the matchedByFilter===0 case)', () => {
      // A caller should never pass featureFamilyMatched alongside a nonzero matchedByFilter in
      // practice (get_next.ts only computes it when matchedByFilter===0) — but the guard itself
      // must still be inert here rather than accidentally suppressing an unrelated floorGated verdict.
      const floorGatedBreakdown = { ...zeroIssueFamilyBreakdown, matchedByFilter: 5, claimable: 0 };
      const miss = fleetScopedMiss(planScope, [], {
        issueBreakdown: floorGatedBreakdown,
        featureFamilyMatched: 8,
      });
      expect(miss.reason).toBe('all_matches_gated');
      expect(miss.reason).not.toBe('issue_family_diagnosis_blind_spot');
    });
  });

  // EI-19393442073558754: the narrower scoping of `nonIssueSpecEmpty`/`ordinary_drain` —
  // gated specifically on a `plan`/`plan_item` predicate (D-009's documented family
  // correlation), NOT on "any filter lacking a kind restriction". Pins the two edge cases
  // the plan-predicate heuristic must get right: a NESTED plan predicate is still detected,
  // and an explicit issue-family kind restriction on a plan-scoped spec overrides it back to
  // the loud `spec_matches_nothing` (that spec really can only ever match the issue family,
  // so a genuine 0 there really is a spec-authoring signal).
  describe('EI-19393442073558754: plan-predicate scoping edge cases', () => {
    const zeroIssueFamilyBreakdown = {
      matchedByFilter: 0,
      claimable: 0,
      affinityCoverage: { denominator: 0, nonEmptyPaths: 0, floor: 0.5, belowFloor: false },
      queueControl: ZERO_QUEUE_CONTROL,
      excluded: {
        ...mapIssueClaimExclusionCounts(undefined),
      },
    };

    function scopeWithFilter(filter: FilterNode) {
      return {
        ownerId: 'su-member',
        fleetSlug: 'test-fleet',
        fleetRole: 'member' as const,
        workspaceId: 'papercusp-workspace',
        record: {
          source: 'fleet' as const,
          spec: {
            specVersion: '1.0',
            specId: 'test-spec',
            revision: 1,
            view: { filter },
            rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          },
          revision: 1,
          updatedBy: 'su-leader',
          updatedAt: 'now',
        },
      };
    }

    it('detects a plan predicate NESTED inside an `all` (not just a bare top-level leaf)', () => {
      const nestedScope = scopeWithFilter({
        all: [
          { field: 'harness', op: '=' as const, value: 'papercusp' },
          { field: 'plan', op: '=' as const, value: 'some-plan' },
        ],
      });
      const miss = fleetScopedMiss(nestedScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureBreakdown: { matchedByFilter: 0, claimable: 0, excluded: { claimFloors: 0, reservedPlanLane: 0 } },
      });
      expect(miss.reason).toBe('ordinary_drain');
    });

    it('detects `plan_item` (not just `plan`) as the family-correlated field', () => {
      const planItemScope = scopeWithFilter({ field: 'plan_item', op: '=' as const, value: 'P-001' });
      const miss = fleetScopedMiss(planItemScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureBreakdown: { matchedByFilter: 0, claimable: 0, excluded: { claimFloors: 0, reservedPlanLane: 0 } },
      });
      expect(miss.reason).toBe('ordinary_drain');
    });

    it('an explicit issue-family kind restriction on a plan-scoped spec overrides back to spec_matches_nothing', () => {
      const kindRestrictedPlanScope = scopeWithFilter({
        all: [
          { field: 'plan', op: '=' as const, value: 'some-plan' },
          { field: 'kind', op: 'in' as const, value: ['bug', 'change', 'task'] },
        ],
      });
      const miss = fleetScopedMiss(kindRestrictedPlanScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 0,
      });
      // This spec can ONLY ever match the issue family (its own kind leaf says so), so a
      // confirmed-empty tier-1 count doesn't matter — the issue-family zero really is the
      // whole story, and really is a genuine spec-authoring signal.
      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.reason).not.toBe('ordinary_drain');
      expect(miss.windDown).toBe(true);
    });

    it('an id-only filter cannot certify an empty spec when feature diagnosis is unavailable', () => {
      const idOnlyScope = scopeWithFilter({ field: 'id', op: 'in' as const, value: ['WI-1', 'WI-2'] });
      const miss = fleetScopedMiss(idOnlyScope, [], { issueBreakdown: zeroIssueFamilyBreakdown });
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.reason).not.toBe('ordinary_drain');
      expect(miss.windDown).toBe(false);
      expect(miss.error).toMatch(/FEATURE-FAMILY DIAGNOSIS UNAVAILABLE/);
      expect(miss.claimability).toMatchObject({
        value: null,
        population: { basis: 'partial-family', matchedByFilter: null },
        interpretation: { state: 'unknown' },
      });
      expect(miss.advice).toMatch(/Do NOT re-author/);
    });

    it('an id-only filter retains a genuine empty-spec verdict when both families were measured empty', () => {
      const idOnlyScope = scopeWithFilter({ field: 'id', op: 'in' as const, value: ['WI-1', 'WI-2'] });
      const miss = fleetScopedMiss(idOnlyScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureBreakdown: { matchedByFilter: 0, claimable: 0, excluded: { claimFloors: 0, reservedPlanLane: 0 } },
      });
      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.windDown).toBe(true);
    });
  });

  // EI-18666093519248020: the INVARIANT behind the four recurrences of the claim-path/read-path
  // divergence class (EI-10062 -> WI-4309 -> WI-5275 -> WI-5822). Each was a different way for the
  // claim path's narrowing to diverge from the spec filter; each surfaced to members as
  // `windDown:true` + "FLOOR-GATED miss ... checkpoint, release, loop:end" while their lane still
  // had claimable rows. The mechanism kept getting fixed; the invariant was never asserted, so
  // recurrence #4 was as invisible as #1 — found only when a member hand-compared a get_next miss
  // against work_items:claimable and saw `claimable: 19` inside the very response telling it to
  // stand down. These tests assert that a miss can never again certify a drain the oracle contradicts.
  describe('EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain', () => {
    const divergentScope = {
      ownerId: 'su-member',
      fleetSlug: 'p2p-release',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'p2p-release-lane',
          revision: 9,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          states: ['open'],
        },
        revision: 9,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    // The live reproduction, verbatim from the 2026-07-26 p2p-release pull that found this:
    // 22 rows matched the spec filter, 19 survived every floor, and get_next still reported
    // windDown + floor-gated. A by-id claim on one of the 19 then succeeded.
    const divergentBreakdown = {
      matchedByFilter: 22,
      claimable: 19,
      affinityCoverage: { denominator: 19, nonEmptyPaths: 19, floor: 0.5, belowFloor: false },
      queueControl: ZERO_QUEUE_CONTROL,
      excluded: {
        ...mapIssueClaimExclusionCounts(undefined),
        claimHold: 1,
        needsOwnerAction: 1,
        cooldown: 1,
      },
    };

    // WI-5947: a survivor count alone is only a SUSPICION — it is read after the claim attempt,
    // so lane churn reproduces it with a healthy claim path. The loud divergence verdict is now
    // gated on the caller having CONFIRMED it by re-asking the claim path. These cases all
    // describe that confirmed shape; the unconfirmed shape is covered in its own block below.
    const confirmed = { issueBreakdown: divergentBreakdown, divergenceRecheck: 'confirmed-twice' as const };

    it('does NOT set windDown when the oracle still reports claimable rows (the harmful half)', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      expect(miss.windDown).toBe(false);
    });

    it('names the divergence in `error` instead of claiming the scope matched nothing', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      expect(miss.error).toMatch(/CLAIM-PATH\/READ-PATH DIVERGENCE/);
      expect(miss.error).toMatch(/19 of 22/);
      expect(miss.error).toMatch(/NOT drained and NOT floor-gated/);
      // the old bare message must NOT be what a diverging member is told
      expect(miss.error).not.toMatch(/NOT allowed to fall through to the generic backlog/);
      // WI-5947: and it must say WHY this is not just churn, or the reader cannot weigh it
      expect(miss.error).toMatch(/CONFIRMED across TWO claim attempts/);
    });

    it('advice tells the member to keep working (claim by id) and to report a claim-path bug — never to stand down', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      expect(miss.advice).toMatch(/DO NOT STAND DOWN/);
      expect(miss.advice).toMatch(/work_items:claimable/);
      expect(miss.advice).toMatch(/work_items:claim/);
      expect(miss.advice).toMatch(/CLAIM-PATH BUG/);
      // must not carry the floor-gated stand-down instruction
      expect(miss.advice).not.toMatch(/FLOOR-GATED miss \(WI-5561\)/);
      expect(miss.advice).not.toMatch(/loop:end/);
    });

    it('WI-5947: the report instruction is framed as an observation to re-verify, not a settled diagnosis', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      // the reader must be told to quote the CONFIRMATION, since that is what separates a real
      // divergence from churn — a bare claimable count is exactly what produced false reports
      expect(miss.advice).toMatch(/confirmed-twice/);
      expect(miss.advice).toMatch(/not as a settled\s+diagnosis|not as a settled diagnosis/);
      // the old text pre-supplied an excuse for why a maintainer could not reproduce it
      // ("it just has not DEPLOYED yet"), which insulated a false report from correction
      expect(miss.advice).not.toMatch(/has not DEPLOYED yet/);
      expect(miss.advice).not.toMatch(/pre-fix release checkout/);
    });

    it('WI-5947: warns that the by-id workaround can itself return an empty list under churn', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      // the advice routes through work_items:claimable, whose row list is read separately from
      // its count — so under the same churn it can come back empty and read as "broken too"
      expect(miss.advice).toMatch(/EMPTY under a churning lane/);
      expect(miss.advice).toMatch(/WI-5947/);
    });

    it('the breakdown summary says the pool is NOT floor-gated, so the floor counts are not misread as the cause', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      expect(miss.excludedBreakdown).toEqual(divergentBreakdown);
      expect(miss.excludedBreakdownSummary).toMatch(/NOT floor-gated/);
      expect(miss.excludedBreakdownSummary).toMatch(/19 of them survive ALL floors/);
      expect(miss.excludedBreakdownSummary).not.toMatch(/genuinely floor-gated/);
    });

    it('a divergence outranks a cooldown re-attribution (never renders as do-not-escalate cooldown noise)', () => {
      const miss = fleetScopedMiss(divergentScope, [], {
        cooldownDiag: { cooldownExcluded: 1, earliestExpiryMs: Date.now() + 5_000, earliestRowId: 'WI-9011' },
        ...confirmed,
      });
      expect(miss.windDown).toBe(false);
      expect(miss.error).toMatch(/CLAIM-PATH\/READ-PATH DIVERGENCE/);
      expect(miss.advice).toMatch(/DO NOT STAND DOWN/);
    });

    // WI-5947 — the regression this fix exists for. An UNCONFIRMED survivor reading (the shape
    // every caller produced before the re-check existed, and the shape a degraded retry still
    // produces) must NOT be dressed up as a claim-path defect: that is what sent agents to file
    // fabricated bugs against healthy code, carrying what looked like a clean reproduction.
    describe('WI-5947 — survivors reported but NOT confirmed by a second claim attempt', () => {
      it('does not pronounce a divergence, and does not tell anyone to file a claim-path bug', () => {
        const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect(miss.error).not.toMatch(/CLAIM-PATH\/READ-PATH DIVERGENCE/);
        expect(miss.advice).not.toMatch(/CLAIM-PATH BUG/);
        expect(miss.advice).not.toMatch(/EI-10062/);
      });

      it('still refuses to certify a drain — an unconfirmed reading is not evidence of an empty lane', () => {
        const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect(miss.windDown).toBe(false);
      });

      it('names the real likely cause (the pool moved) and gives the one useful action: pull again', () => {
        const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect(miss.error).toMatch(/POOL CHANGED UNDER YOU/);
        expect(miss.error).toMatch(/19 of 22/);
        expect(miss.advice).toMatch(/PULL AGAIN/);
        expect(miss.advice).toMatch(/scheduler:get_next again/);
        // and must not push the member toward the two wrong remedies
        expect(miss.advice).not.toMatch(/re-author the claim spec\b(?!.*do NOT)/);
        expect(miss.advice).not.toMatch(/loop:end/);
      });

      it('stamps the provenance so a relayed report carries its own confidence level', () => {
        const unconfirmed = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect((unconfirmed as { divergenceRecheck?: string }).divergenceRecheck).toBe('unconfirmed');
        const conf = fleetScopedMiss(divergentScope, [], confirmed);
        expect((conf as { divergenceRecheck?: string }).divergenceRecheck).toBe('confirmed-twice');
        // absent entirely when there were no survivors to be suspicious about
        const drained = fleetScopedMiss(divergentScope, [], { issueBreakdown: { ...divergentBreakdown, claimable: 0 } });
        expect((drained as { divergenceRecheck?: string }).divergenceRecheck).toBeUndefined();
      });

      it('the breakdown summary frames the survivors as a later instant, not a floor story', () => {
        const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect(miss.excludedBreakdownSummary).toMatch(/the pool moved/);
        expect(miss.excludedBreakdownSummary).not.toMatch(/genuinely floor-gated/);
      });
    });

    // The other side of the guard: a GENUINE floor-gated drain must be untouched, or the fix
    // would trade a false stand-down for a fleet that never stands down at all.
    it('claimable === 0 keeps the existing floor-gated verdict verbatim (windDown + stand-down advice)', () => {
      const genuinelyDrained = { ...divergentBreakdown, claimable: 0 };
      const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: genuinelyDrained });
      expect(miss.windDown).toBe(true);
      // EI-18741523426513509: this shape (matchedByFilter > 0, claimable === 0, not
      // divergent/unconfirmed/paused/cooldown) is exactly the floor-gated case, which now gets
      // its own named reason + error instead of the old generic "no claimable work-item matched"
      // message that was indistinguishable-by-shape from a diagnosis failure.
      expect(miss.reason).toBe('all_matches_gated');
      expect(miss.error).toMatch(/POOL BLOCKED, NOT SPEC-BROKEN/);
      expect(miss.advice).toMatch(/FLOOR-GATED miss \(WI-5561/);
      expect(miss.excludedBreakdownSummary).toMatch(/genuinely floor-gated/);
      expect(miss.excludedBreakdownSummary).not.toMatch(/NOT floor-gated/);
    });

    it('a PAUSED fleet still stands down even though a divergent breakdown was passed (pause is a real stand-down)', () => {
      const miss = fleetScopedMiss(divergentScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: divergentBreakdown,
      });
      expect(miss.paused).toBe(true);
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/winding-down/);
      expect(miss.excludedBreakdown).toBeUndefined();
    });

    it('a miss with NO breakdown at all is unchanged (windDown, original message)', () => {
      const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: null });
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    });
  });

  // EI-18221674485894260: a fleet-scope refusal must POINT AT the concrete widen tool
  // (scheduler:set_claim_spec) so a leader never has to hunt a tool ToolSearch/tools:find
  // failed to surface. The prior body said only "Re-steer the member's claim spec" —
  // naming neither the tool nor the call shape.
  describe('EI-18221674485894260: fleet-scope refusal names the one-call widen action', () => {
    const scope = {
      ownerId: 'su-member',
      fleetSlug: 'p2p-release-verify',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'p2p-release-verify-lane',
          revision: 20,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 20,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };
    const violation: Extract<FleetScopeAdmission, { allowed: false }> = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'work-item WI-5700 does not match p2p-release-verify-lane@20 for fleet \'p2p-release-verify\'',
      refusal: fleetScopeRefusalContract('fleet_scope_violation', scope),
      scope,
    };

    it('EI-20263410682554156: identifies a terminal plan pin and changes the remedy from per-row widening to re-steering', async () => {
      const planViolation: Extract<FleetScopeAdmission, { allowed: false }> = {
        ...violation,
        scope: {
          ...scope,
          record: {
            ...scope.record,
            spec: {
              ...scope.record.spec,
              view: { filter: { field: 'plan', op: '=' as const, value: 'finished-plan' } },
            },
          },
        },
      };
      admissionMocks.sql.mockResolvedValue([{ plan_slug: 'finished-plan', status: 'shipped' }]);

      const retired = await diagnoseFleetScopeRetiredPlans({ scope: planViolation.scope });
      expect(retired).toEqual([{ planSlug: 'finished-plan', status: 'shipped' }]);

      const remedy = fleetScopeLeaderRemedy(planViolation, null, null, retired);
      expect(remedy).toMatch(/RETIRED PLAN PIN/);
      expect(remedy).toMatch(/finished-plan.*status: shipped/);
      expect(remedy).toMatch(/terminal/);
      expect(remedy).toMatch(/scheduler:set_claim_spec/);
      expect(remedy).toMatch(/do not keep bumping this revision/i);
      expect(remedy).toMatch(/RE-STEER the fleet lane/);
      expect(remedy).not.toMatch(/WIDEN the fleet lane/);
    });

    it('fleetScopeLeaderRemedy names scheduler:set_claim_spec, the fleet slug, and the current spec ref (unambiguous, not "@N") for a scope violation', () => {
      const remedy = fleetScopeLeaderRemedy(violation);
      expect(remedy).toMatch(/scheduler:set_claim_spec/);
      expect(remedy).toMatch(/fleet: "p2p-release-verify"/);
      // EI-18676258006299036: "<specId>@<revision>" reads as a size/replica count in ops
      // tooling — a member misread it as a live-member count. Render unambiguously instead.
      expect(remedy).toMatch(/p2p-release-verify-lane \(spec rev 20\)/);
      expect(remedy).not.toMatch(/p2p-release-verify-lane@20/);
      // A live scope violation is NOT a pause — it must never route the leader at fleet:resume.
      expect(remedy).not.toMatch(/fleet:resume/);
    });

    it('states that completing a stamped work-item can reflect its plan item to done', () => {
      const planViolation: Extract<FleetScopeAdmission, { allowed: false }> = {
        ...violation,
        scope: {
          ...scope,
          record: {
            ...scope.record,
            spec: {
              ...scope.record.spec,
              view: { filter: { field: 'plan', op: '=' as const, value: 'stamped-plan' } },
            },
          },
        },
      };

      const remedy = fleetScopeLeaderRemedy(planViolation);

      expect(remedy).toMatch(/completing the stamped work-item may reflect its plan item to `done`/);
      expect(remedy).toMatch(/closing that plan item later may also auto-resolve this work-item as residue/i);
    });

    it('fleetScopeLeaderRemedy routes a fleet_winding_down refusal at fleet:resume, NOT a spec widen', () => {
      const paused: Extract<FleetScopeAdmission, { allowed: false }> = {
        ...violation,
        code: 'fleet_winding_down',
        reason: 'fleet \'p2p-release-verify\' is winding-down (paused)',
      };
      const remedy = fleetScopeLeaderRemedy(paused);
      expect(remedy).toMatch(/fleet:resume \{ fleet: "p2p-release-verify" \}/);
      // Widening a PAUSED fleet's spec would recruit a member that must be standing down.
      expect(remedy).not.toMatch(/scheduler:set_claim_spec/);
    });

    it('fleetScopeLeaderRemedy still names the widen tool for a fleet_scope_missing (no authored spec) refusal', () => {
      const missing: Extract<FleetScopeAdmission, { allowed: false }> = {
        allowed: false,
        scoped: true,
        code: 'fleet_scope_missing',
        reason: 'fleet member su-member belongs to \'p2p-release-verify\' but has no explicit spec',
        refusal: fleetScopeRefusalContract('fleet_scope_missing', scope),
        scope: { ...scope, record: { ...scope.record, source: 'default' as const } },
      };
      const remedy = fleetScopeLeaderRemedy(missing);
      expect(remedy).toMatch(/scheduler:set_claim_spec/);
      expect(remedy).toMatch(/fleet: "p2p-release-verify"/);
    });

    it('a fleet_scope_missing receipt includes the append-ids call for the refused id', () => {
      const missing: Extract<FleetScopeAdmission, { allowed: false }> = {
        ...violation, code: 'fleet_scope_missing',
        scope: { ...scope, record: { ...scope.record, source: 'default' } },
      };
      const remedy = fleetScopeLeaderRemedy(missing, true, null, null, 'WI-refused', 'papercusp');
      expect(remedy).toContain('scheduler:set_claim_spec {"fleet":"p2p-release-verify","appendIds":["WI-refused"],"harness":"papercusp"}');
      expect(remedy).not.toContain('spec:');
    });

    it('the fleet leader auto-message includes the append-ids call for the refused id', async () => {
      const missing: Extract<FleetScopeAdmission, { allowed: false }> = {
        ...violation, code: 'fleet_scope_missing',
        scope: { ...scope, record: { ...scope.record, source: 'default' } },
      };
      await notifyFleetScopeRefusal({ ownerId: 'su-member' } as never, missing, 'work_items:claim WI-refused', {
        harness: 'papercusp', subject: { itemId: 'WI-refused', member: 'su-member' },
      });
      const payload = admissionMocks.sendMessage.mock.calls.at(-1)?.[1];
      expect(payload.to).toEqual(['@fleet-leader:p2p-release-verify']);
      expect(payload.body).toContain('scheduler:set_claim_spec {"fleet":"p2p-release-verify","appendIds":["WI-refused"],"harness":"papercusp"}');
      expect(payload.extra['fleetAdmissionBlock']).toMatchObject({ itemId: 'WI-refused', code: 'fleet_scope_missing' });
    });

    it('notifyFleetScopeRefusal sends the leader a body carrying the factual reason AND the concrete widen action', async () => {
      await notifyFleetScopeRefusal(
        { ownerId: 'su-member' } as never,
        violation,
        'work_items:claim WI-5700 → su-member',
      );
      expect(admissionMocks.sendMessage).toHaveBeenCalledOnce();
      const payload = admissionMocks.sendMessage.mock.calls[0]?.[1] as { to: string[]; summary: string; body: string; category: string };
      expect(payload.to).toEqual(['@fleet-leader:p2p-release-verify']);
      expect(payload.category).toBe('fleet-scope-admission');
      // The factual mismatch is preserved…
      expect(payload.body).toMatch(/does not match p2p-release-verify-lane@20/);
      // …AND the leader now gets the one-call widen action instead of "re-steer somehow".
      expect(payload.body).toMatch(/scheduler:set_claim_spec/);
      expect(payload.body).not.toMatch(/Re-steer the member's claim spec or route the work elsewhere\./);
    });

    it('returns and stamps a typed dependency escape when the refused row blocks member-held work', async () => {
      admissionMocks.readHeldDependencyEscapeContext.mockResolvedValue({
        dependencyId: 'WI-5700',
        dependencyKind: 'issue',
        blockedHeldItems: [{ id: 'WI-held', kind: 'change', harness: 'papercusp' }],
      });
      const result = await notifyFleetScopeRefusal(
        { ownerId: 'su-member' } as never,
        violation,
        'work_items:claim WI-5700 → stable-builder',
        { harness: 'papercusp', subject: { itemId: 'WI-5700', member: 'stable-builder' } },
      );
      expect(admissionMocks.readHeldDependencyEscapeContext).toHaveBeenCalledWith({
        dependencyId: 'WI-5700',
        member: 'su-member',
        memberAliases: ['stable-builder'],
        harness: 'papercusp',
      });
      expect(result.dependencyEscape).toMatchObject({
        kind: 'dependency_escape',
        dependency: { id: 'WI-5700', kind: 'issue' },
        blockedHeldItemIds: ['WI-held'],
        member: 'su-member',
        ownershipPreserved: true,
      });
      expect(result.dependencyEscape?.routes.map((route) => route.kind)).toEqual([
        'spec_widen',
        'outside_lane_placement',
        'leader_claim',
      ]);
      const payload = admissionMocks.sendMessage.mock.calls[0]?.[1] as {
        body: string;
        extra: { fleetAdmissionBlock: { dependencyEscape: unknown } };
      };
      expect(payload.body).toMatch(/DEPENDENCY ESCAPE/);
      expect(payload.extra.fleetAdmissionBlock.dependencyEscape).toEqual(result.dependencyEscape);
    });
  });

  // WI-6326 (residual half of EI-18784357226895330): "route the work elsewhere" named an
  // exit with no liveness check — a refused member found the fleet was themself plus one
  // idle member and had to escalate by hand. hasLiveFleetRouteTarget + the code-conditional
  // remedy text close that gap.
  describe('WI-6326: the "route elsewhere" exit is code-conditional on a real presence read', () => {
    const scope = {
      ownerId: 'su-member',
      fleetSlug: 'p2p-release-verify',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'p2p-release-verify-lane',
          revision: 20,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 20,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };
    const violation: Extract<FleetScopeAdmission, { allowed: false }> = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'work-item WI-5700 does not match p2p-release-verify-lane@20 for fleet \'p2p-release-verify\'',
      refusal: fleetScopeRefusalContract('fleet_scope_violation', scope),
      scope,
    };

    describe('hasLiveFleetRouteTarget', () => {
      it('reports false when every OTHER row in the fleet is present-but-not-alive or absent', async () => {
        admissionMocks.listFleetAssignments.mockResolvedValue([
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-member', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: true },
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-leader', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: false },
        ]);
        // Excludes the caller itself (su-member) — the question is whether ANYONE ELSE
        // can receive routed work, not whether the caller is alive (it obviously is).
        await expect(hasLiveFleetRouteTarget('p2p-release-verify', 'papercusp-workspace', 'su-member')).resolves.toBe(false);
      });

      it('reports true when another member/leader in the fleet is present and alive', async () => {
        admissionMocks.listFleetAssignments.mockResolvedValue([
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-member', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: true },
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-other', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: true },
        ]);
        await expect(hasLiveFleetRouteTarget('p2p-release-verify', 'papercusp-workspace', 'su-member')).resolves.toBe(true);
      });

      it('ignores rows from a DIFFERENT fleet', async () => {
        admissionMocks.listFleetAssignments.mockResolvedValue([
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-other', fleetSlug: 'some-other-fleet', holderPresent: true, holderAlive: true },
        ]);
        await expect(hasLiveFleetRouteTarget('p2p-release-verify', 'papercusp-workspace', 'su-member')).resolves.toBe(false);
      });

      it('degrades to null (unknown) on a lookup failure rather than a false negative', async () => {
        admissionMocks.listFleetAssignments.mockRejectedValue(new Error('pg unavailable'));
        await expect(hasLiveFleetRouteTarget('p2p-release-verify', 'papercusp-workspace', 'su-member')).resolves.toBeNull();
      });
    });

    describe('fleetScopeLeaderRemedy liveRouteTarget wiring', () => {
      it('keeps the original unconditional wording when a live target exists', () => {
        const remedy = fleetScopeLeaderRemedy(violation, true);
        expect(remedy).toMatch(/\(Or route the work elsewhere \/ complete it yourself\.\)/);
      });

      it('keeps the original unconditional wording when liveness is UNKNOWN (null/undefined) — never asserts a false negative', () => {
        expect(fleetScopeLeaderRemedy(violation, null)).toMatch(/\(Or route the work elsewhere \/ complete it yourself\.\)/);
        expect(fleetScopeLeaderRemedy(violation)).toMatch(/\(Or route the work elsewhere \/ complete it yourself\.\)/);
      });

      it('replaces the "route elsewhere" exit with an honest closed-exit statement + the ledger fallback when no live target exists', () => {
        const remedy = fleetScopeLeaderRemedy(violation, false);
        expect(remedy).not.toMatch(/\(Or route the work elsewhere \/ complete it yourself\.\)/);
        expect(remedy).toMatch(/Do NOT rely on "route the work elsewhere"/);
        expect(remedy).toMatch(/no other live agent/);
        expect(remedy).toMatch(/stays filed, unassigned, on the ledger/);
        // The widen action is still named regardless — that exit was never closed.
        expect(remedy).toMatch(/scheduler:set_claim_spec/);
      });

      it('never applies the liveness note to a fleet_winding_down refusal (that branch never mentions "route elsewhere")', () => {
        const paused: Extract<FleetScopeAdmission, { allowed: false }> = {
          ...violation,
          code: 'fleet_winding_down',
          reason: 'fleet \'p2p-release-verify\' is winding-down (paused)',
        };
        const remedy = fleetScopeLeaderRemedy(paused, false);
        expect(remedy).toMatch(/fleet:resume/);
        expect(remedy).not.toMatch(/Do NOT rely on "route the work elsewhere"/);
      });
    });

    it('notifyFleetScopeRefusal returns the liveRouteTarget verdict AND reflects it in the leader message body', async () => {
      // Only the refused member itself (the excluded owner) is present in the fleet —
      // the exact repro shape (fleet was themself plus one idle member).
      admissionMocks.listFleetAssignments.mockResolvedValue([
        { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-member', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: true },
      ]);
      const result = await notifyFleetScopeRefusal(
        { ownerId: 'su-member' } as never,
        violation,
        'work_items:claim WI-5700 → su-member',
      );
      // EI-19484346966003625 (R1): `classRefusal` is null because no `harness` was passed —
      // the class reading is opt-in per call site, so a caller that cannot name a harness
      // gets exactly the pre-change behaviour rather than a partial or guessed diagnosis.
      // Kept as an EXACT shape assertion on purpose: it is what caught this field's arrival.
      expect(result).toEqual({ liveRouteTarget: false, classRefusal: null });
      const payload = admissionMocks.sendMessage.mock.calls[0]?.[1] as { body: string };
      expect(payload.body).toMatch(/Do NOT rely on "route the work elsewhere"/);
      expect(payload.body).not.toContain('CLASS REFUSAL');
    });

    it('notifyFleetScopeRefusal skips the liveness lookup entirely for a fleet_winding_down refusal', async () => {
      const paused: Extract<FleetScopeAdmission, { allowed: false }> = {
        ...violation,
        code: 'fleet_winding_down',
        reason: 'fleet \'p2p-release-verify\' is winding-down (paused)',
      };
      const result = await notifyFleetScopeRefusal({ ownerId: 'su-member' } as never, paused, 'work_items:claim WI-5700 → su-member');
      // EI-19484346966003625 (R1): a PAUSED fleet skips the class reading too, and for the
      // same reason it skips the liveness lookup — its remedy is "stand down", so a class
      // diagnosis could only ever argue for a spec widen the member must not act on.
      expect(result).toEqual({ liveRouteTarget: null, classRefusal: null });
      expect(admissionMocks.listFleetAssignments).not.toHaveBeenCalled();
    });
  });

  // EI-18674160393981819: a harness-scoped fleet's claim spec typically narrows on
  // kind/plan/tags only — harness scoping comes from the caller's OWN `args.harness`, never
  // from a spec leaf (the claimable payload's `harness` field is payload-only per
  // claim-spec-payload-filter.ts). Without folding the caller's harness into the derived
  // payload_filter, the miss advice recommended an events:await that fired on every OTHER
  // harness's claimable bug too (observed live: a papercusp-scoped fleet woken by an
  // oddsmith-hive bug). fleetScopedMiss must AND the caller's harness into `payloadFilter`
  // whenever it is passed, regardless of what the spec's own view.filter narrows on.
  describe('EI-18674160393981819: payloadFilter is scoped to the caller\'s own harness', () => {
    const kindOnlyScope = {
      ownerId: 'su-member',
      fleetSlug: 'nonp2p-bug-drain',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'nonp2p-bug-drain-0725',
          revision: 5,
          view: { filter: { field: 'kind' as const, op: 'in' as const, value: ['bug'] } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 5,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    it('ANDs the caller harness into a spec-derived payloadFilter (kind-only spec, the real nonp2p-bug-drain shape)', () => {
      const miss = fleetScopedMiss(kindOnlyScope, [], { harness: 'papercusp' });
      expect(miss.payloadFilter).toEqual({
        all: [{ harness: { equals: 'papercusp' } }, { kind: { in: ['bug'] } }],
      });
      expect(miss.advice).toMatch(/loop:end \{ acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true \}/);
    });

    it('labels payloadFilter as a candidate hint, not an exact admission guarantee', () => {
      const miss = fleetScopedMiss(kindOnlyScope, [], { harness: 'papercusp' });
      expect(miss.advice).toContain('CANDIDATE HINT, not a full admission predicate');
      expect(miss.advice).toContain('claim floors, rig availability, and lifecycle races');
      expect(miss.advice).not.toContain('woken ONLY on work your spec could admit');
      expect(miss.advice).not.toContain('fires only on in-scope items');
    });

    it('falls back to a harness-only filter when the spec narrows on nothing payload-filterable', () => {
      const noFilterScope = {
        ...kindOnlyScope,
        record: {
          ...kindOnlyScope.record,
          spec: { ...kindOnlyScope.record.spec, view: {} },
        },
      };
      const miss = fleetScopedMiss(noFilterScope, [], { harness: 'papercusp' });
      expect(miss.payloadFilter).toEqual({ all: [{ harness: { equals: 'papercusp' } }] });
    });

    it('omits payloadFilter entirely when no harness is known AND the spec narrows on nothing payload-filterable (no unsound narrowing)', () => {
      const noFilterScope = {
        ...kindOnlyScope,
        record: {
          ...kindOnlyScope.record,
          spec: { ...kindOnlyScope.record.spec, view: {} },
        },
      };
      const miss = fleetScopedMiss(noFilterScope, []);
      expect(miss.payloadFilter).toBeUndefined();
    });

    it('a cross-harness claimable event never matches the derived filter (the actual regression: an oddsmith-hive bug woke a papercusp fleet)', async () => {
      const { evaluateDataCondition } = await import('@papercusp/rules');
      const miss = fleetScopedMiss(kindOnlyScope, [], { harness: 'papercusp' });
      const crossHarnessPayload = { id: 'WI-5854', kind: 'bug', harness: 'oddsmith-hive' };
      const sameHarnessPayload = { id: 'WI-1', kind: 'bug', harness: 'papercusp' };
      expect(evaluateDataCondition(miss.payloadFilter!, crossHarnessPayload)).toBe(false);
      expect(evaluateDataCondition(miss.payloadFilter!, sameHarnessPayload)).toBe(true);
    });
  });
});

/**
 * EI-18862608742257943: itemMatchesRawClaimSpec — the SAME feature/issue-family branch
 * as the private itemMatchesScope (exercised above via admitWorkItemForFleetTarget), but
 * against a RAW ClaimSpec with no live FleetScopeContext/fleet-membership required. This
 * is what lets fleet:launch-on-plan check, BEFORE any member has joined a brand-new
 * fleet, whether the claim spec it is about to apply actually admits a work-item its own
 * kickoff brief names.
 */
describe('itemMatchesRawClaimSpec (EI-18862608742257943 — pre-launch kickoff-vs-spec check)', () => {
  beforeEach(() => {
    admissionMocks.sql.mockReset();
  });

  const issueSpec: ClaimSpecRecord['spec'] = {
    specVersion: '1.0',
    specId: 'nonp2p-bugs',
    revision: 6,
    view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };

  it('matches an issue-family item purely (no SQL call) when its kind is in-spec', async () => {
    const item = {
      id: 'WI-6502',
      family: 'issue',
      kind: 'bug',
      title: 'A bug',
      summary: '',
      state: 'open',
      assignee: null,
    } as unknown as Parameters<typeof itemMatchesRawClaimSpec>[0];
    await expect(itemMatchesRawClaimSpec(item, issueSpec, 'papercusp-workspace')).resolves.toBe(true);
    expect(admissionMocks.sql).not.toHaveBeenCalled();
  });

  it('does NOT match an issue-family item whose kind is outside the spec (the exact live repro shape)', async () => {
    const item = {
      id: 'WI-9',
      family: 'issue',
      kind: 'task',
      title: 'A task',
      summary: '',
      state: 'open',
      assignee: null,
    } as unknown as Parameters<typeof itemMatchesRawClaimSpec>[0];
    const taskLessSpec: ClaimSpecRecord['spec'] = {
      ...issueSpec,
      view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } },
    };
    await expect(itemMatchesRawClaimSpec(item, taskLessSpec, 'papercusp-workspace')).resolves.toBe(false);
  });

  it('routes a feature-family item through the SQL EXISTS check, keyed on the passed workspaceId', async () => {
    const item = {
      id: 'WI-feat',
      family: 'feature',
      kind: 'feature',
      title: 'WI-feat',
      summary: '',
      state: 'todo',
      assignee: null,
    } as unknown as Parameters<typeof itemMatchesRawClaimSpec>[0];
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.sql.mockImplementation((strings: readonly string[], ...values: unknown[]) => {
      if (strings.some((s) => s.includes('workspace_id ='))) {
        return Promise.resolve([{ matched: values[0] === 'papercusp-workspace' }]);
      }
      return 'FRAGMENT';
    });
    await expect(
      itemMatchesRawClaimSpec(item, { ...issueSpec, view: { filter: { field: 'kind', op: '=', value: 'feature' } } }, 'papercusp-workspace'),
    ).resolves.toBe(true);
    expect(admissionMocks.sql).toHaveBeenCalled();
  });
});

/**
 * EI-18732199386440540 — a fleet must be able to absorb the fallout bugs it files
 * mid-run. The live repro: a member finished its lane, ran the affected suite, found the
 * fleet's own plan had turned a test RED, filed the bug, and then could not claim the
 * item it had just created (fleet_scope_violation), because a freshly-filed EI carries
 * no plan/plan_item stamp and the fleet's spec is scoped to the plan's item set.
 */
describe('self-filed fallout admission (EI-18732199386440540)', () => {
  /**
   * This block is a SIBLING of the describe that owns the shared mock reset, so it does
   * NOT inherit that beforeEach — it must reset for itself. Learned the hard way while
   * writing these: the whole-file run was GREEN while the reconciliation test below only
   * passed because a test in the earlier block had left `sendMessage` resolved. Run
   * alone (-t 'self-filed fallout admission') it threw on `.catch` of undefined. A green
   * file is not evidence a test is independent of the ones before it.
   */
  beforeEach(() => {
    for (const mock of Object.values(admissionMocks)) mock.mockReset();
    admissionMocks.sendMessage.mockResolvedValue(undefined);
  });

  const scope = {
    ownerId: 'su-member',
    fleetSlug: 'mail-retirement',
    fleetRole: 'member' as const,
    workspaceId: 'papercusp-workspace',
    record: {
      source: 'fleet',
      spec: {
        specVersion: '1.0',
        specId: 'plan-scoped-rev2',
        revision: 2,
        // The shape that causes the bug: scoped to the PLAN's items, so nothing filed
        // mid-run can ever match.
        view: { filter: { field: 'plan', op: '=', value: 'mail-retirement' } as FilterNode },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 2,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    } as unknown as ClaimSpecRecord,
  };

  /**
   * A COMPLETE, genuinely typechecked WorkItem with a Partial override seam — not a cast.
   * `as never` on a fixture would defeat the one check vi.mocked() exists to give: the
   * value would stop being checked against the real signature, so the next required field
   * added to WorkItem would strand this fixture INVISIBLY (vitest does not typecheck, and
   * lint:tsc would pass BECAUSE of the cast) and surface as a red green-checkpoint for
   * whoever is next waiting on a deploy. Same shape as the factories in
   * agent-tools/work_items/*.test.ts.
   */
  const aWorkItem = (over: Partial<WorkItem> = {}): WorkItem => ({
    id: 'EI-18731717643670832',
    kind: 'bug',
    family: 'issue',
    harness: 'papercusp',
    title: 'blueprint-deps-catalog.test.ts went RED',
    summary: 'fallout from this fleet own plan',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: 'su-member',
    severity: 'major',
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    createdAt: '2026-07-26T18:20:17.438Z',
    updatedAt: '2026-07-26T18:20:17.438Z',
    closedAt: null,
    goalId: null,
    ...over,
  });

  const falloutBug = aWorkItem();
  const leaderDispatchedTask = aWorkItem({
    id: 'WI-leader-dispatched',
    kind: 'task',
    title: 'Grade the acceptance artifact',
    createdBy: 'su-leader',
    assignedBy: 'su-leader',
    assignee: 'su-member',
  });

  /**
   * The case table IS the specification. Every claim below is asserted against the real
   * predicate AND replayed against two deliberately-wrong implementations in the
   * falsifiability control at the end of this block — so the table cannot silently
   * degrade into one that would pass for a broken predicate.
   */
  const cases: { name: string; item: Partial<WorkItem>; admit: boolean }[] = [
    {
      name: 'the reported repro: a bug this member filed itself, out of spec',
      item: { kind: 'bug', createdBy: 'su-member' },
      admit: true,
    },
    {
      name: 'NEGATIVE CONTROL — a bug filed by a PEER is still refused (this is not a general widening)',
      item: { kind: 'bug', createdBy: 'su-other-member' },
      admit: false,
    },
    {
      name: 'NEGATIVE CONTROL — a self-filed `change` is refused: you may absorb what you broke, not self-authorize new work',
      item: { kind: 'change', createdBy: 'su-member' },
      admit: false,
    },
    {
      name: 'NEGATIVE CONTROL — a self-filed `task` is refused for the same reason',
      item: { kind: 'task', createdBy: 'su-member' },
      admit: false,
    },
    {
      name: 'a row with no createdBy (feature-family, legacy) can never match — no null-equals-null admission',
      item: { kind: 'bug', createdBy: null },
      admit: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(selfFiledFalloutAdmission(aWorkItem(c.item), scope)).toBe(c.admit);
    });
  }

  it('admits the self-filed fallout bug through the real admission seam, not just the predicate', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });
    admissionMocks.getWorkItem.mockResolvedValue(falloutBug);
    // The spec is plan-scoped, so the normal match path must genuinely FAIL here —
    // otherwise this test would pass without exercising the carve-out at all.
    admissionMocks.sql.mockResolvedValue([{ matched: false }]);

    const admission = await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: 'EI-18731717643670832',
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: true, scoped: true });
  });

  it('keeps atomic create+assign atomic for a server-attributed self-filed bug', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });

    const admission = await admitSubjectForFleetTarget({
      target: 'su-member',
      createdBy: 'su-member',
      subject: { ...base, kind: 'bug', plan: null, planItem: [] },
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: true, scoped: true });
  });

  it('admits a by-id self-filed bug even when the fleet has no authored claim spec', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({ ...scope.record, source: 'default' });
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });
    admissionMocks.getWorkItem.mockResolvedValue(falloutBug);

    const admission = await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: falloutBug.id,
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: true, scoped: true });
  });

  it('keeps atomic create+assign atomic for a self-filed bug when the fleet has no authored claim spec', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({ ...scope.record, source: 'default' });
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });

    const admission = await admitSubjectForFleetTarget({
      target: 'su-member',
      createdBy: 'su-member',
      subject: { ...base, kind: 'bug', plan: null, planItem: [] },
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: true, scoped: true });
  });

  it('keeps atomic no-spec peer bugs refused instead of widening the self-filed exception', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({ ...scope.record, source: 'default' });
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });

    const admission = await admitSubjectForFleetTarget({
      target: 'su-member',
      createdBy: 'su-other-member',
      subject: { ...base, kind: 'bug', plan: null, planItem: [] },
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: false, code: 'fleet_scope_missing' });
  });

  it('keeps atomic no-spec self-filed non-bugs refused instead of widening by provenance alone', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({ ...scope.record, source: 'default' });
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });

    const admission = await admitSubjectForFleetTarget({
      target: 'su-member',
      createdBy: 'su-member',
      subject: { ...base, kind: 'change', plan: null, planItem: [] },
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: false, code: 'fleet_scope_missing' });
  });

  it('admits a by-id claim for an item durably dispatched by the current fleet leader', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({
      controlState: 'active',
      controlReason: null,
      leaderOwnerId: 'su-leader',
    });
    admissionMocks.getWorkItem.mockResolvedValue(leaderDispatchedTask);

    const admission = await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: leaderDispatchedTask.id,
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: true, scoped: true });
  });

  it('refuses a by-id claim whose assignedBy is not the current fleet leader', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({
      controlState: 'active',
      controlReason: null,
      leaderOwnerId: 'su-current-leader',
    });
    admissionMocks.getWorkItem.mockResolvedValue({
      ...leaderDispatchedTask,
      assignedBy: 'su-former-leader',
    });

    const admission = await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: leaderDispatchedTask.id,
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: false, code: 'fleet_scope_violation' });
    expect(admission).toMatchObject({ reporter: 'su-leader' });
  });

  it('keeps atomic create+assign atomic for a server-attributed leader dispatch', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({
      controlState: 'active',
      controlReason: null,
      leaderOwnerId: 'su-leader',
    });

    const admission = await admitSubjectForFleetTarget({
      target: 'su-member',
      createdBy: 'su-leader',
      assignedBy: 'su-leader',
      subject: { ...base, kind: 'task', plan: null, planItem: [] },
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: true, scoped: true });
  });

  it('does not turn the atomic seam into a peer-assignment escape hatch', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });

    const admission = await admitSubjectForFleetTarget({
      target: 'su-member',
      createdBy: 'su-other-member',
      subject: { ...base, kind: 'bug', plan: null, planItem: [] },
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: false, code: 'fleet_scope_violation' });
    expect(admission).toMatchObject({ reporter: 'su-other-member' });
  });

  it('does not let atomic self-filing bypass a winding-down fleet', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'winding-down', controlReason: 'owner pause' });

    const admission = await admitSubjectForFleetTarget({
      target: 'su-member',
      createdBy: 'su-member',
      subject: { ...base, kind: 'bug', plan: null, planItem: [] },
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: false, code: 'fleet_winding_down' });
  });

  it('ORDERING CONTROL — a winding-down fleet still refuses the self-filed bug (EI-12832 keeps precedence)', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'winding-down', controlReason: 'owner pause' });
    admissionMocks.getWorkItem.mockResolvedValue(falloutBug);

    const admission = await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: 'EI-18731717643670832',
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: false, code: 'fleet_winding_down' });
  });

  it('keeps no-spec peer bugs refused instead of widening the lane beyond self-filed fallout', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({ ...scope.record, source: 'default' });
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });
    admissionMocks.getWorkItem.mockResolvedValue(aWorkItem({ createdBy: 'su-other-member' }));

    const admission = await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: 'EI-18731717643670832',
      workspaceId: 'papercusp-workspace',
    });
    expect(admission).toMatchObject({ allowed: false, code: 'fleet_scope_missing' });
  });

  it('a refused self-filed non-bug is TOLD why the carve-out did not apply, instead of a bare spec mismatch', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });
    admissionMocks.getWorkItem.mockResolvedValue(aWorkItem({ kind: 'change' }));
    admissionMocks.sql.mockResolvedValue([{ matched: false }]);

    const admission = (await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: 'EI-18731717643670832',
      workspaceId: 'papercusp-workspace',
    })) as Extract<FleetScopeAdmission, { allowed: false }>;
    expect(admission.allowed).toBe(false);
    expect(admission.reason).toMatch(/you filed this item/i);
    expect(admission.reason).toMatch(/kind:'bug' only/);
  });

  /**
   * THE COHERENCE GUARD, and the reason this is not merely a predicate test.
   * `reconcileFleetScopeClaims` re-evaluates every claim a member holds and RELEASES the
   * ones that no longer match. If it does not honour the same carve-out, the fix is
   * worse than useless: the member is allowed to claim the bug it filed, and then the
   * next sweep quarantines that very claim and tells the leader it was out of scope.
   */
  it('the reconciliation sweep KEEPS a self-filed fallout claim instead of quarantining it back', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.listFleetAssignments.mockResolvedValue([
      { source: 'work_item_claim', agentId: 'su-member', workItemId: 'EI-18731717643670832' },
      { source: 'work_item_claim', agentId: 'su-member', workItemId: 'EI-filed-by-someone-else' },
    ]);
    admissionMocks.getWorkItem.mockImplementation(async (id: string) =>
      id === 'EI-18731717643670832' ? falloutBug : aWorkItem({ id, createdBy: 'su-other-member' }),
    );
    admissionMocks.sql.mockResolvedValue([{ matched: false }]);
    admissionMocks.releaseWorkItem.mockImplementation(async (id: string) => ({ id }));

    const result = await reconcileFleetScopeClaims({
      ownerId: 'su-member',
      workspaceId: 'papercusp-workspace',
      identity: { ownerId: 'su-member' } as never,
    });

    // The self-filed one survives; the peer-filed out-of-scope one is still quarantined.
    // Asserting BOTH is what makes this a test of narrowness rather than of the sweep
    // having simply stopped working.
    expect(result.quarantinedIds).toEqual(['EI-filed-by-someone-else']);
  });

  it('the reconciliation sweep KEEPS a current-leader-dispatched claim instead of quarantining it back', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
    admissionMocks.getFleet.mockResolvedValue({
      controlState: 'active',
      controlReason: null,
      leaderOwnerId: 'su-leader',
    });
    admissionMocks.listFleetAssignments.mockResolvedValue([
      { source: 'work_item_claim', agentId: 'su-member', workItemId: leaderDispatchedTask.id },
      { source: 'work_item_claim', agentId: 'su-member', workItemId: 'EI-not-dispatched' },
    ]);
    admissionMocks.getWorkItem.mockImplementation(async (id: string) =>
      id === leaderDispatchedTask.id ? leaderDispatchedTask : aWorkItem({ id, createdBy: 'su-other-member' }),
    );
    admissionMocks.releaseWorkItem.mockImplementation(async (id: string) => ({ id }));

    const result = await reconcileFleetScopeClaims({
      ownerId: 'su-member',
      workspaceId: 'papercusp-workspace',
      identity: { ownerId: 'su-member' } as never,
    });

    expect(result.quarantinedIds).toEqual(['EI-not-dispatched']);
  });

  it('leaderDispatchedAdmission fails closed when the durable leader is unavailable', async () => {
    admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null, leaderOwnerId: null });
    await expect(leaderDispatchedAdmission({ assignedBy: 'su-leader' }, scope)).resolves.toBe(false);
  });

  /**
   * EI-20426366154081065: the refusal must not PUBLISH ITS OWN BYPASS.
   *
   * The pre-fix wording ended `File genuine fallout as a bug, or ask the leader to widen
   * the spec.` — an instruction to re-file the same work under the one kind
   * `selfFiledFalloutAdmission` admits. It was taken twice in 45 minutes on 2026-08-14;
   * the resulting duplicate (WI-38771) carried none of the tracked incident's history and
   * its obvious next action would have destroyed a live gate auto-refire rescue.
   *
   * These assert the BEHAVIOUR (does the sentence recommend a re-file, or warn against
   * one?) rather than pinning an exact string, so a later rewording that keeps the
   * warning stays green while a regression to the recommendation goes red.
   */
  describe('EI-20426366154081065: the self-filed kind refusal stops advertising the re-file bypass', () => {
    const hintFor = (kind: WorkItem['kind']) =>
      selfFiledKindRefusalHint(aWorkItem({ kind, createdBy: 'su-member' }), scope);

    /**
     * A bare `/file .{0,40} as a bug/` regex CANNOT express this: it matches the
     * prohibition ("Do NOT re-file the same work as a bug") exactly as readily as the
     * recommendation it replaced, so it fails the fixed code and would pass a future
     * regression that merely re-worded the advice. The discriminating property is
     * whether the CLAUSE mentioning it is negated — so test that, per clause.
     */
    const filingClauses = (text: string) =>
      text
        .split(/(?<=[.—])\s+|,\s+/)
        .filter((clause) => /\bfil(e|ing)\b/i.test(clause) && /\bbug\b/i.test(clause));

    it('never instructs the member to re-file the work as a bug', () => {
      for (const kind of ['task', 'change'] as const) {
        const hint = hintFor(kind);
        expect(hint).not.toContain('File genuine fallout as a bug');
        // Every clause that talks about filing-as-a-bug must be a prohibition.
        for (const clause of filingClauses(hint)) {
          expect(clause).toMatch(/\b(not|never|n't)\b/i);
        }
      }
    });

    it('warns AGAINST the re-file and says why the carve-out is not a relabel', () => {
      const hint = hintFor('task');
      expect(hint).toMatch(/do not re-file/i);
      // The two consequences that make the bypass dangerous, not merely irregular.
      expect(hint).toMatch(/self-authoriz/i);
      expect(hint).toMatch(/strands|duplicate/i);
    });

    it('still names the kind that was refused and the kind the carve-out admits', () => {
      expect(hintFor('task')).toContain("kind:'task'");
      expect(hintFor('task')).toContain("kind:'bug'");
    });

    it('names the two containment-preserving routes (widen the lane / work it unheld)', () => {
      const hint = hintFor('change');
      expect(hint).toMatch(/widen the lane/i);
      expect(hint).toMatch(/without holding the row/i);
    });

    it('is silent when it does not apply — a peer-filed row, and a self-filed bug (already admitted)', () => {
      expect(selfFiledKindRefusalHint(aWorkItem({ kind: 'task', createdBy: 'su-other' }), scope)).toBe('');
      expect(selfFiledKindRefusalHint(aWorkItem({ kind: 'bug', createdBy: 'su-member' }), scope)).toBe('');
      expect(selfFiledKindRefusalHint(aWorkItem({ kind: 'task', createdBy: null }), scope)).toBe('');
    });

    /**
     * WIRING, not wording. Every assertion above passes a `selfFiledKindRefusalHint`
     * that is never CALLED — extracting the sentence into a pure function made it
     * testable and simultaneously made it possible to leave the refusal path pointing at
     * the old text. This is the only test here that fails if the seam is not wired.
     */
    it('the real refusal path carries the hint — the seam is wired, not just the helper', async () => {
      admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'mail-retirement', fleetRole: 'member' });
      admissionMocks.getClaimSpecRecord.mockResolvedValue(scope.record);
      admissionMocks.getFleet.mockResolvedValue({ controlState: 'active', controlReason: null });
      admissionMocks.getWorkItem.mockResolvedValue(aWorkItem({ kind: 'task', createdBy: 'su-member' }));
      // Plan-scoped spec: the ordinary match path must genuinely fail, so the refusal
      // (and its hint) is what we are reading.
      admissionMocks.sql.mockResolvedValue([{ matched: false }]);

      const admission = await admitWorkItemForFleetTarget({
        target: 'su-member',
        workItemId: 'EI-18731717643670832',
        workspaceId: 'papercusp-workspace',
      });
      expect(admission.allowed).toBe(false);
      const reason = (admission as Extract<typeof admission, { allowed: false }>).reason;
      expect(reason).toMatch(/do not re-file/i);
      expect(reason).not.toContain('File genuine fallout as a bug');
    });

    it('CONTROL: these assertions reject the pre-fix wording (they are not vacuous)', () => {
      // The literal sentence this fix removed. Every guard above must fail it.
      const preFix =
        ` (you filed this item, but the self-filed carve-out admits kind:'bug' only — this is kind:'task'.` +
        ` File genuine fallout as a bug, or ask the leader to widen the spec.)`;
      expect(preFix).toContain('File genuine fallout as a bug');
      expect(preFix).not.toMatch(/do not re-file/i);
      expect(preFix).not.toMatch(/without holding the row/i);
      // The clause guard must actually CATCH it: the pre-fix text has a filing-as-a-bug
      // clause carrying no negation. Without this the guard could be vacuous — a helper
      // that found no clauses at all would pass the shipped text for the wrong reason.
      const preFixClauses = filingClauses(preFix);
      expect(preFixClauses.length).toBeGreaterThan(0);
      expect(preFixClauses.some((clause) => !/\b(not|never|n't)\b/i.test(clause))).toBe(true);
      // ...and the shipped text DOES produce clauses for that guard to inspect, so its
      // green is "every clause is negated", never "there were no clauses".
      expect(filingClauses(hintFor('task')).length).toBeGreaterThan(0);
      // ...and the shipped wording satisfies what the pre-fix wording fails, so the
      // assertions above discriminate rather than being satisfiable by anything.
      const shipped = hintFor('task');
      expect(shipped).not.toContain('File genuine fallout as a bug');
      expect(shipped).toMatch(/do not re-file/i);
    });
  });

  /**
   * PERMANENT FALSIFIABILITY CONTROL. A guard that has never failed is a guard nobody
   * has tested. Both deliberately-wrong implementations must FAIL the case table above;
   * if either one passes it, the table has stopped discriminating and every assertion
   * above is worthless.
   */
  it('CONTROL: the case table rejects both an always-admit and a never-admit implementation', () => {
    const alwaysAdmit = () => true;
    const neverAdmit = () => false;
    const survives = (impl: () => boolean) => cases.every((c) => impl() === c.admit);

    expect(survives(alwaysAdmit)).toBe(false);
    expect(survives(neverAdmit)).toBe(false);
    // ...and the real implementation passes every one. This calibration case proves the
    // table is satisfiable at all, so the two failures above mean discrimination rather
    // than a table nothing could satisfy.
    expect(cases.every((c) => selfFiledFalloutAdmission(aWorkItem(c.item), scope) === c.admit)).toBe(true);
  });
});

/**
 * WI-10005683 — the CROSS-MODULE contract, which is the part that actually drifted.
 *
 * Each side was individually defensible: the admission notice recommends a widen that
 * keeps the incumbent fence, and the write door refuses any `any` node with an unfenced
 * arm. Composed, the platform recommended a repair its own write door rejected, and
 * nothing failed — no type changed and each module's own unit tests stayed green. Only a
 * test that COMPOSES them can catch it, so this asserts the composition, not either half.
 */
describe("WI-10005683: fleet-scope admission's own widen recommendation passes its own write door", () => {
  const goalFence: FilterNode = { field: 'goal', op: '=', value: 'goal-60d3a8' };

  it('fencePreservingWidenFilter output is NOT refused for a goal-fenced incumbent lane', () => {
    const candidateFilter = fencePreservingWidenFilter(goalFence, 'WI-10005683');
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goalFence,
      candidateFilter,
      previousSource: 'authored',
      confirm: false,
    });
    // A refusal here means a leader following the fleet_scope_violation notice verbatim
    // is told to send a revision that set_claim_spec will reject.
    expect(verdict.refuse).toBe(false);
    expect(verdict.errors).toEqual([]);
  });

  it('CALIBRATION: the composition is discriminating — a hand-rolled class widen is still refused', () => {
    // Proves the test above is not passing because the guard accepts everything.
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goalFence,
      candidateFilter: { any: [goalFence, { field: 'kind', op: '=', value: 'bug' }] },
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict.refuse).toBe(true);
  });

  it('the no-incumbent-filter branch still yields a bare id leaf, which needs no fence carve-out', () => {
    expect(fencePreservingWidenFilter(undefined, 'WI-10005683')).toEqual({
      field: 'id',
      op: '=',
      value: 'WI-10005683',
    });
  });
});
