import { describe, expect, it } from 'vitest';
import {
  GATE_CODE_OWNERSHIP,
  buildAgentObligationAgenda,
  fleetStaffingObligations,
  type FleetStaffingProviderInput,
  independentVerificationObligation,
  ownerReportObligation,
  planPlacementObligation,
  selectGoalPlacementPlan,
  goalPlanningObligation,
  type GoalPlanningProviderInput,
  waitingOnObligations,
  type IndependentVerificationProviderInput,
  type OwnerReportProviderInput,
  type PlanAcceptanceGateCodeOwnership,
  type PlanPlacementProviderInput,
  type WaitingOnObligationRow,
  type WaitingOnProviderInput,
} from './agent-obligation-providers';
import type { GoalLaunchRefusal, GoalLaunchResolution, GoalPlanPlacement, GoalPortfolioBrief } from './goal-launch-settings';
import { compileGoalPlanPlacement } from './goal-launch-settings';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';
import { goalPlanningPortfolioFingerprint, type GoalPlanningReview } from './goal-planning-review';
import { advanceGoalPlacementProgress, goalPlacementProgressScopeKey,
  type GoalPlacementProgressState } from './goal-placement-progress';
import type { ExactPlanAdmission, ExactPlanAdmissionReason } from './agent-tools/plans/plan-admission-preflight';
import { AGENT_OBLIGATION_SCHEMA_VERSION, formatAgentObligationLine } from './agent-obligations';
import { projectAgentTurnStartObligationBrief } from './agent-obligation-reader';
import { deliveredGoalPlacementRows } from './goal-placement-turn-receipts';
import type { FleetUnderStaffedEvaluation } from './fleet/under-staffed-alert';
import { inboxWakeKey } from './agent-tools/coordination/inbox-wake';

const NOW = '2026-09-05T20:00:00.000Z';
const base = { workspaceId: 'ws', ownerId: 'su-goal', observedAt: NOW, sourceGeneration: 'rev-42' };
const failure = { code: 'read-failed', detail: 'canonical writer timed out', retry: 'retry the canonical writer' };

describe('scope-aware goal planning obligations', () => {
  function input(disposition: GoalPlanningReview['disposition'] = 'plan-needed', populated = true): GoalPlanningProviderInput {
    const value = portfolio(populated ? [worklistPlan(placement('working', 'none'))] : []);
    return { ...base, goalId: 'goal-1', read: { status: 'known', value: {
      portfolio: value, reviewIntervalMs: 60 * 60_000,
      review: { schemaVersion: 1, goalId: 'goal-1', disposition,
        rationale: 'Measured missing recovery coverage.', evidenceRefs: ['work-item:WI-fixture'],
        planRefs: [], ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Recover failed checkout' } : {}),
        ...(disposition === 'existing-plans-sufficient' || disposition === 'no-eligible-work'
          ? { coverage: [{ need: 'checkout recovery', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'plan:papercusp/checkout' }] } : {}),
        portfolioFingerprint: goalPlanningPortfolioFingerprint(value), reviewedAt: NOW },
      authorities: { papercusp: { allowed: true, reason: 'caller-goal-owns-pot', ownerGoalId: 'goal-1', ownerGoalTitle: 'Goal' } },
    } } };
  }
  function known(value: GoalPlanningProviderInput) {
    if (value.read.status !== 'known') throw new Error('test requires known source');
    return value.read.value;
  }
  it.each([true, false])('exposes an uncovered outcome with populated worklist=%s', (populated) => {
    expect(goalPlanningObligation(input('plan-needed', populated))).toMatchObject({
      family: 'planning-needed', status: 'due', applicableDemand: 1,
      action: { kind: 'continue' },
    });
    expect(goalPlanningObligation(input('plan-needed', populated)).reason).toContain('Recover failed checkout');
  });
  it('accepts a current supported sufficient-plan review without an idea quota', () => {
    expect(goalPlanningObligation(input('existing-plans-sufficient'))).toMatchObject({ status: 'satisfied', applicableDemand: 0 });
  });
  // P-009 (goal-holder-plans-ideation-truthful-reports-2026-10-03): measured
  // 2026-10-01..03, 18 of 24 reviews said existing-plans-sufficient and no holder
  // wrote a plan. A no-new-plan review now discharges only with a passing map.
  it('keeps the nudge due when a no-new-plan review carries no coverage map', () => {
    const unbacked = input('existing-plans-sufficient');
    delete (known(unbacked).review as { coverage?: unknown }).coverage;
    expect(goalPlanningObligation(unbacked)).toMatchObject({
      status: 'due', title: 'Back the no-new-plan review with a coverage map', applicableDemand: 1, ruleRevision: 'goal-planning-needed-v4',
    });
  });
  it('keeps the nudge due when a 3+ item cluster maps to no plan, and names it', () => {
    const uncovered = input('existing-plans-sufficient');
    known(uncovered).review!.coverage = [
      { need: 'checkout recovery', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'plan:papercusp/checkout' },
      { need: 'stale loop wakes', itemRefs: ['WI-4', 'WI-5', 'WI-6'] },
    ];
    const obligation = goalPlanningObligation(uncovered);
    expect(obligation).toMatchObject({ status: 'due', title: 'Write a plan for the uncovered need', applicableDemand: 1 });
    expect(obligation.reason).toContain('stale loop wakes');
    expect(obligation.reason).toContain('plans:new');
  });
  // WI-10006710 (measured 2026-10-06, goal 60d3a8 epoch 21): the 12:19:30Z
  // existing-plans-sufficient review cited three worklist plans and omitted a ready,
  // unplaced one with open goal work. Nothing flagged it, and that plan then got no
  // start, staffing or recorded hold for the rest of the tenure.
  describe('unplaced worklist plans must be accounted for by a no-new-plan review', () => {
    function withWorklist(entries: GoalPortfolioBrief['worklist'], coverage?: Array<{ need: string; itemRefs: string[]; planRef?: string; justification?: string }>) {
      const value = input('existing-plans-sufficient'); const state = known(value);
      state.portfolio!.worklist = entries;
      if (coverage) state.review!.coverage = coverage;
      state.review!.portfolioFingerprint = goalPlanningPortfolioFingerprint(state.portfolio!);
      return value;
    }
    it('keeps the nudge due and names each uncited unplaced or blocked plan', () => {
      const obligation = goalPlanningObligation(withWorklist([
        worklistPlan(placement('working', 'none'), 'checkout'),
        worklistPlan(placement('unplaced', 'launch-plan-fleet'), 'orphan-plan'),
        worklistPlan(placement('blocked', 'resolve-plan-blockers'), 'stuck-plan'),
      ]));
      expect(obligation).toMatchObject({ status: 'due', title: 'Account for every unplaced worklist plan', applicableDemand: 2 });
      expect(obligation.reason).toContain('plan:papercusp/orphan-plan (unplaced)');
      expect(obligation.reason).toContain('plan:papercusp/stuck-plan (blocked)');
      expect(obligation.reason).not.toContain('plan:papercusp/checkout');
    });
    it('discharges once the coverage map cites the plan', () => {
      expect(goalPlanningObligation(withWorklist(
        [worklistPlan(placement('unplaced', 'launch-plan-fleet'), 'orphan-plan')],
        [
          { need: 'checkout recovery', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'plan:papercusp/checkout' },
          { need: 'orphan work, held until checkout lands', itemRefs: ['WI-7'], planRef: 'plan:papercusp/orphan-plan' },
        ],
      ))).toMatchObject({ status: 'satisfied' });
    });
    it('demands nothing for placed, owner-walled or terminal worklist plans', () => {
      expect(goalPlanningObligation(withWorklist([
        worklistPlan(placement('working', 'none'), 'busy'),
        worklistPlan(placement('owner-walled', 'none'), 'walled'),
        worklistPlan(placement('terminal', 'none'), 'finished'),
      ]))).toMatchObject({ status: 'satisfied' });
    });
  });
  it('accepts an explicitly empty map for no-eligible-work', () => {
    const none = input('no-eligible-work');
    known(none).review!.coverage = [];
    expect(goalPlanningObligation(none)).toMatchObject({ status: 'satisfied' });
  });
  it('reviews the standing frontier instead of equating terminal plans with goal completion', () => {
    const value = input(); const state = known(value);
    state.portfolio!.worklist = [worklistPlan(placement('terminal', 'none'))];
    state.review = null;
    expect(goalPlanningObligation(value)).toMatchObject({ status: 'due', action: { kind: 'inspect' } });
    expect(goalPlanningObligation(value).action?.summary).toContain('frontier');
  });
  it('does not turn a failed source read into no demand', () => {
    expect(goalPlanningObligation({ ...base, goalId: 'goal-1', read: { status: 'unknown', failure } })).toMatchObject({ status: 'unknown', measurementFailure: failure });
  });
  it.each(['paused', 'achieved', 'killed'])('does not resume a %s goal', (status) => {
    const value = input(); known(value).portfolio!.goal.status = status;
    expect(goalPlanningObligation(value)).toMatchObject({ status: 'not-applicable' });
    expect(goalPlanningObligation(value).action).toBeUndefined();
  });
  it('refreshes a review when outcomes changed, not when observation clocks changed', () => {
    const value = input('existing-plans-sufficient'); const state = known(value);
    state.portfolio!.assembledAt = '2026-09-05T20:01:00Z';
    expect(goalPlanningObligation(value).status).toBe('satisfied');
    state.portfolio!.goal.body = 'New outcome';
    expect(goalPlanningObligation(value)).toMatchObject({ status: 'due', action: { kind: 'inspect' } });
  });
  it('makes periodic review due even when planning inputs are unchanged', () => {
    const value = input('existing-plans-sufficient'); value.observedAt = '2026-09-05T21:01:00Z';
    expect(goalPlanningObligation(value).status).toBe('due');
  });
  it('routes other-goal plans instead of offering local adoption', () => {
    const value = input('adopt-plan'); const state = known(value);
    state.review!.planRefs = ['plan:papercusp/foreign'];
    state.authorities.papercusp = { allowed: false, reason: 'different-active-goal-owns-pot', ownerGoalId: 'goal-other', ownerGoalTitle: 'Other' };
    expect(goalPlanningObligation(value).reason).toMatch(/route.*goal-other/i);
    expect(goalPlanningObligation(value).action?.summary).toContain('do not adopt or duplicate');
    expect(goalPlanningObligation(value).action?.tool).toBeUndefined();
  });
  it('permits nonduplicating adoption in an unowned harness but retains CAS and launch guards', () => {
    const value = input('adopt-plan'); const state = known(value);
    state.review!.planRefs = ['plan:papercusp/reuse'];
    state.authorities.papercusp = { allowed: true, reason: 'no-active-owner', ownerGoalId: null, ownerGoalTitle: null };
    expect(goalPlanningObligation(value).action?.summary).toMatch(/adopt.*CAS/i);
    expect(goalPlanningObligation(value).action?.summary).toContain('budget');
  });
  it('keeps unresolved candidate ownership unknown', () => {
    const value = input('adopt-plan'); known(value).review!.planRefs = ['plan:unknown/candidate'];
    expect(goalPlanningObligation(value).status).toBe('unknown');
  });
  it('puts executable existing-plan staffing ahead of planning', () => {
    const planning = input();
    const p = portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]);
    const agenda = buildAgentObligationAgenda({ goalPlanning: planning, planPlacement: planInput({ status: 'known', value: {
      portfolio: p, launch: launch(), alert: null, evidenceRef: 'placement:fixture',
    } }) }, NOW);
    expect(agenda.primary[0]?.family).toBe('plan-placement');
    expect(agenda.primary.some((row) => row.family === 'planning-needed' && row.status === 'due')).toBe(true);
  });
});

function planInput(value: PlanPlacementProviderInput['read']): PlanPlacementProviderInput {
  return { ...base, goalId: 'goal-1', read: value };
}

function reportInput(value: OwnerReportProviderInput['read']): OwnerReportProviderInput {
  return { ...base, goalId: 'goal-1', read: value };
}

function verifyInput(value: IndependentVerificationProviderInput['read']): IndependentVerificationProviderInput {
  return { ...base, planSlug: 'plan-a', read: value };
}

const planAlert = (
  reason: 'started-plan-no-live-targeting-fleet' | 'started-plan-targeting-fleet-zero-live-claims',
) => ({
  goalId: 'goal-1',
  workspaceId: 'ws',
  title: 'Goal',
  reason,
  planSlug: 'plan-a',
  harnessSlug: 'papercusp',
  itemIds: ['P-001'],
  targetingFleets: [],
  liveHolders: ['su-goal'],
});

function placement(
  state: GoalPlanPlacement['state'],
  action: GoalPlanPlacement['reconciliation']['action'],
  overrides: Partial<GoalPlanPlacement> = {},
): GoalPlanPlacement {
  const launchAction =
    action === 'launch-plan-fleet' ||
    action === 'launch-spawned-leader' ||
    action === 'resume-partial-launch' ||
    action === 'restore-spawned-leader';
  const base: GoalPlanPlacement = {
    state,
    // P-026 / D-012: these fixtures exercise placement states, not closure, so
    // no closure reading was taken. `null` says exactly that — it is never a
    // way to spell "closed".
    closure: null,
    fleet:
      state === 'unplaced'
        ? null
        : {
            slug: 'plan-a-fleet',
            controlState: 'active',
            leaderOwnerId: 'su-independent',
            leaderLive: true,
            liveMembers: 2,
            target: 2,
          },
    activeLane:
      state === 'unplaced'
        ? null
        : {
            itemId: 'P-001',
            ownerId: 'su-member',
            ownerFleet: 'plan-a-fleet',
            holderLive: true,
            expiresAt: '2026-09-05T21:00:00.000Z',
          },
    launchTransaction:
      state === 'admitting'
        ? {
            transactionId: 'tx-partial',
            state: 'partial',
            retryOwnerIds: ['su-retry'],
            nextAction: 'retry only the unverified canary identity',
          }
        : state === 'working' || state === 'independently-led'
          ? { transactionId: 'tx-verified', state: 'verified', retryOwnerIds: [], nextAction: null }
          : null,
    reconciliation: {
      consistent: action === 'none',
      action,
      reason: action === 'none' ? 'canonical placement is consistent' : `canonical repair: ${action}`,
      toolCall: launchAction
        ? {
            tool: 'fleet:launch-on-plan',
            args: {
              name: 'plan-a-fleet',
              plan: 'plan-a',
              harness: 'papercusp',
              leader: 'spawn',
              headless: true,
            },
          }
        : null,
    },
  };
  return {
    ...base,
    ...overrides,
    reconciliation: { ...base.reconciliation, ...overrides.reconciliation },
  };
}

function worklistPlan(value: GoalPlanPlacement, slug = 'plan-a'): GoalPortfolioBrief['worklist'][number] {
  return {
    ref: `plan:papercusp/${slug}`,
    ordinal: 1,
    harness: 'papercusp',
    slug,
    title: 'Plan A',
    status: value.state === 'terminal' ? 'done' : 'active',
    next: value.state === 'terminal' ? null : { id: 'P-001', text: 'Do the work', phase: 'Build', blockedBy: [] },
    counts: {
      todo: value.state === 'terminal' ? 0 : 1,
      wip: 0,
      blocked: 0,
      needsHuman: 0,
      done: value.state === 'terminal' ? 1 : 0,
    },
    ambiguousMatches: 1,
    placement: value,
  };
}

function portfolio(worklist: GoalPortfolioBrief['worklist'], degradedReasons: string[] = []): GoalPortfolioBrief {
  return {
    schemaVersion: 1,
    assembledAt: NOW,
    goal: {
      id: 'goal-1',
      title: 'Goal',
      status: 'active',
      body: null,
      killCriterion: null,
      standing: true,
      parentId: null,
    },
    worklist,
    pots: [{ harness: 'papercusp', role: 'owner', note: null, killCriterion: null, linkId: 'fixture-link' }],
    drainFleet: {
      slug: 'goal-fleet',
      exists: true,
      controlState: 'active',
      leaderOwnerId: 'su-goal',
      live: 1,
      working: 1,
    },
    queue: {
      total: worklist.length,
      terminal: 0,
      inFlight: 0,
      blocked: 0,
      needsHuman: 0,
      claimable: 1,
      claimabilityScope: 'issue-family',
    },
    launch: { settings: null, ceilings: { maxAgents: 10, maxPerFleet: 5 }, headcount: { total: 2, fleet: 0 } },
    budget: {
      budgetCents: 10_000,
      spentCents: 2_500,
      unmeasuredPricedSpend: false,
      spentCentsAt: '2026-09-05T19:55:00.000Z',
      spentCentsSource: 'goal-lineage-rollup',
      interactiveUsageFreshnessStatus: null,
      interactiveUsageLastIngestedAtMs: null,
      budgetWindowSec: null,
    },
    tripwires: [],
    pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null },
    priorities: [],
    degradedReasons,
  };
}

describe('independent GOAL plan lanes (P-020)', () => {
  it('offers the next unplaced plan while an earlier independent fleet works', () => {
    const first = worklistPlan(placement('unplaced', 'launch-plan-fleet'), 'alpha');
    const second = worklistPlan(placement('unplaced', 'launch-plan-fleet'), 'beta');
    expect(selectGoalPlacementPlan(portfolio([first, second]))?.slug).toBe('alpha');
    const working = worklistPlan(placement('working', 'none'), 'alpha');
    expect(selectGoalPlacementPlan(portfolio([working, second]))?.slug).toBe('beta');
  });
});

function launch(overrides: Partial<GoalLaunchResolution> = {}): GoalLaunchResolution {
  return {
    goalId: 'goal-1',
    settings: null,
    goalBrief: null,
    effective: { carry: 'warm' },
    ceilings: { maxAgents: 10, maxPerFleet: 5 },
    headcount: { total: 2, fleet: 0 },
    budget: {
      budgetCents: 10_000,
      spentCents: 2_500,
      unmeasuredPricedSpend: false,
      spentCentsAt: '2026-09-05T19:55:00.000Z',
      spentCentsSource: 'goal-lineage-rollup',
      interactiveUsageFreshnessStatus: null,
      interactiveUsageLastIngestedAtMs: null,
    },
    refusal: null,
    degraded: false,
    degradedReasons: [],
    ...overrides,
  };
}

function knownPlacement(value: {
  portfolio: GoalPortfolioBrief | null;
  launch: GoalLaunchResolution | null;
  alert?: ReturnType<typeof planAlert> | null;
  evidenceRef: string;
  ageMs?: number;
  progress?: Record<string, GoalPlacementProgressState | null>;
  admissions?: Record<string, ExactPlanAdmission | null>;
}): PlanPlacementProviderInput['read'] {
  return { status: 'known', value: { alert: null, ...value } };
}

function exactAdmission(reason: ExactPlanAdmissionReason): ExactPlanAdmission {
  return {
    ready: reason === 'ready', status: reason === 'ready' ? 'ready' : 'blocked',
    reason, message: `measured ${reason}`, requestedSeats: 1, executableWidth: reason === 'ready' ? 1 : 0,
  } as ExactPlanAdmission;
}

describe('typed exact-plan admission guidance', () => {
  it.each([
    ['plan-not-found', 'unknown', 'refresh the plan link'],
    ['no-actionable-plan-items', 'blocked', 'repair the plan DAG'],
    ['promotion-lag', 'blocked', 'plans:start'],
    ['duplicate-coverage', 'blocked', 'duplicate promoted'],
    ['lane-unknown', 'unknown', 'refresh the exact-plan claim lane'],
    ['floor-diagnostics-unavailable', 'unknown', 'repair the claim-lane diagnostic'],
    ['floor-gated', 'blocked', 'claim exclusions'],
    ['family-disagreement', 'blocked', 'promoted row family'],
    ['insufficient-executable-width', 'blocked', 'requested seats'],
  ] as const)('maps %s to a specific %s action', (reason, status, guidance) => {
    const plan = worklistPlan(placement('unplaced', 'launch-plan-fleet'));
    const result = planPlacementObligation(planInput(knownPlacement({
      portfolio: portfolio([plan]), launch: null, evidenceRef: 'cohort:admission',
      admissions: { [plan.ref]: exactAdmission(reason) },
    })));
    expect(result).toMatchObject({ status, scope: { planSlug: plan.slug },
      action: { targetRef: plan.ref, summary: expect.stringContaining(guidance) } });
    expect(result.action?.tool).toBeUndefined();
    expect(result.reason).toContain(reason);
  });
  it('keeps an unreadable admission unknown and never offers a launch', () => {
    const plan = worklistPlan(placement('unplaced', 'launch-plan-fleet'));
    const result = planPlacementObligation(planInput(knownPlacement({
      portfolio: portfolio([plan]), launch: null, evidenceRef: 'cohort:admission-unknown',
      admissions: { [plan.ref]: null },
    })));
    expect(result).toMatchObject({ status: 'unknown',
      measurementFailure: { code: 'exact-plan-admission-unavailable' } });
    expect(result.action?.tool).toBeUndefined();
  });
});

describe('persisted placement effect clock', () => {
  it('uses the first verified effect without resetting it on a later read or retry', () => {
    const plan = worklistPlan(placement('unplaced', 'launch-plan-fleet'));
    const scope = { workspaceId: base.workspaceId, ownerId: base.ownerId, goalId: 'goal-1', planRef: plan.ref };
    const effectAt = '2026-09-05T19:55:00.000Z';
    const state = advanceGoalPlacementProgress({ scopeKey: goalPlacementProgressScopeKey(scope), previous: null,
      now: effectAt, effect: { kind: 'member-claim', ref: 'canonical-member-effect', at: effectAt } }).state;
    const input: PlanPlacementProviderInput = { ...base, goalId: 'goal-1', read: { status: 'known', value: {
      portfolio: portfolio([plan]), launch: launch(), alert: null, evidenceRef: 'fixture', progress: { [plan.ref]: state },
    } } };
    expect(planPlacementObligation(input).ageMs).toBe(5 * 60_000);
    expect(planPlacementObligation({ ...input, observedAt: '2026-09-05T20:02:00.000Z' }).ageMs).toBe(7 * 60_000);
    expect(state.lastEffect?.at).toBe(effectAt);
    // Missing, foreign-scope and corrupt clock data is unknown, never age zero.
    for (const stored of [null, { ...state, scopeKey: 'other-goal' }, { ...state, opportunities: -1 }]) {
      expect(planPlacementObligation({ ...input, read: { status: 'known', value: {
        portfolio: portfolio([plan]), launch: launch(), alert: null, evidenceRef: 'fixture', progress: { [plan.ref]: stored },
      } } }).ageMs).toBeUndefined();
    }
  });

  it('turns two eligible completed decisions into one repair, while retaining current admission and in-flight boundaries', () => {
    const unplaced = worklistPlan(placement('unplaced', 'launch-plan-fleet'));
    const scopeKey = goalPlacementProgressScopeKey({ workspaceId: base.workspaceId, ownerId: base.ownerId,
      goalId: 'goal-1', planRef: unplaced.ref });
    const first = advanceGoalPlacementProgress({ scopeKey, previous: null,
      now: '2026-09-05T19:57:00.000Z', opportunity: { deliveryToken: 'delivery-1',
        completedTurnRef: 'native-1', offeredAt: '2026-09-05T19:56:00.000Z',
        completedAt: '2026-09-05T19:57:00.000Z', eligibleAtOffer: true, eligibleAtCompletion: true } });
    const stalled = advanceGoalPlacementProgress({ scopeKey, previous: first.state,
      now: '2026-09-05T19:59:00.000Z', opportunity: { deliveryToken: 'delivery-2',
        completedTurnRef: 'native-2', offeredAt: '2026-09-05T19:58:00.000Z',
        completedAt: '2026-09-05T19:59:00.000Z', eligibleAtOffer: true, eligibleAtCompletion: true } });
    expect(stalled.stalled).toBe(true);
    const input = (plan: typeof unplaced, resolved = launch()): PlanPlacementProviderInput => ({
      ...base, goalId: 'goal-1', read: knownPlacement({ portfolio: portfolio([plan]), launch: resolved,
        evidenceRef: 'cohort:stalled', progress: { [plan.ref]: stalled.state } }),
    });
    const repair = planPlacementObligation(input(unplaced));
    expect(repair).toMatchObject({ status: 'due', action: { kind: 'repair', targetRef: unplaced.ref } });
    expect(repair.action?.tool).toBeUndefined();
    expect(repair.episode).toContain('stalled:');
    const repairBrief = projectAgentTurnStartObligationBrief({ schemaVersion: AGENT_OBLIGATION_SCHEMA_VERSION,
      evaluatedAt: NOW, sourceGeneration: base.sourceGeneration, evaluations: [repair], primary: [repair], conflicts: [] });
    expect(deliveredGoalPlacementRows({ ownerId: base.ownerId, workspaceId: base.workspaceId,
      brief: repairBrief, block: formatAgentObligationLine(repair, 'action') }))
      .toMatchObject([{ launch: { fleetSlug: 'plan-a-fleet', requestedSeats: 1 } }]);
    // A later eligible repair decision must eventually change the action, not
    // repeat the first repair forever. Reads and excluded decisions cannot do so.
    let repaired = stalled.state;
    for (const n of [1, 2]) {
      const offeredAt = `2026-09-05T20:0${n * 2}:00.000Z`;
      const completedAt = `2026-09-05T20:0${n * 2 + 1}:00.000Z`;
      repaired = advanceGoalPlacementProgress({ scopeKey, previous: repaired, now: completedAt,
        opportunity: { deliveryToken: `repair-${n}`, completedTurnRef: `repair-turn-${n}`,
          offeredAt, completedAt, eligibleAtOffer: true, eligibleAtCompletion: true } }).state;
      const repairInput = { ...input(unplaced), observedAt: completedAt };
      if (repairInput.read.status !== 'known') throw new Error('expected known repair input');
      repairInput.read.value.progress = { [unplaced.ref]: repaired };
      const result = planPlacementObligation(repairInput);
      if (n === 1) expect(result.action?.kind).toBe('repair');
      else {
        expect(result.action?.kind).toBe('report');
        expect(result.action?.summary).toMatch(/stop repeating.*reassign.*existing authority.*escalate/i);
        expect(result.action?.tool).toBeUndefined();
        expect(result.episode).toContain('repair-exhausted:');
      }
    }
    const refused = planPlacementObligation(input(unplaced, launch({ refusal: {
      reason: 'goal_budget_unmeasurable', current: null, limit: 10_000, requested: 1,
      currentScope: 'goal-pots', message: 'authoritative spend is unknown',
    } })));
    expect(refused).toMatchObject({ status: 'blocked', action: { kind: 'repair', targetRef: 'goal:goal-1' } });
    const admitting = worklistPlan(placement('admitting', 'resume-partial-launch'));
    expect(planPlacementObligation(input(admitting))).toMatchObject({ status: 'in-progress' });
  });

  it('keeps a corrupt scoped progress receipt unknown instead of offering another launch', () => {
    const plan = worklistPlan(placement('unplaced', 'launch-plan-fleet'));
    const result = planPlacementObligation({ ...base, goalId: 'goal-1', read: knownPlacement({
      portfolio: portfolio([plan]), launch: launch(), evidenceRef: 'cohort:corrupt',
      progress: { [plan.ref]: { version: 1, scopeKey: 'another-goal', firstEligibleAt: null,
        lastEffect: null, lastDeliveryToken: null, lastCompletedTurnRef: null, lastCompletedAt: null,
        opportunities: 0, stalledAt: null } },
    }) });
    expect(result).toMatchObject({ status: 'unknown', measurementFailure: { code: 'goal-placement-progress-invalid' },
      action: { kind: 'inspect', targetRef: plan.ref } });
    expect(result.action?.tool).toBeUndefined();
  });
});

describe('turn-start sink fit for a due placement row', () => {
  // Measured live 2026-09-30 (goal 60d3a8, holder su-2e6fb313): this slug with a
  // due author-repair row for the same plan. The placement line was 296 chars,
  // 481 with the other row against the 400-char sink, so it was never delivered
  // and no goalPlacementTurn receipt could exist.
  const SLUG = 'session-transcript-exact-fuzzy-search-2026-09-14';
  const LIVE_GENERATION = 'e7ec8c510285eac5ca67';
  function agenda() {
    const plan = worklistPlan(placement('unplaced', 'launch-plan-fleet'), SLUG);
    return buildAgentObligationAgenda({
      planPlacement: { ...base, sourceGeneration: LIVE_GENERATION, goalId: 'goal-1', read: {
        status: 'known', value: { portfolio: portfolio([plan]), launch: launch(), alert: null, evidenceRef: 'placement:fixture' },
      } },
      independentVerification: [{ ...base, sourceGeneration: LIVE_GENERATION, planSlug: SLUG, read: { status: 'known', value: {
        gate: { satisfied: false, code: 'acceptance_bar_contract_not_ready' as never,
          message: 'refused', rubricId: 'acceptance-plan-a', gradedBy: null },
        evidenceRef: 'gate:acceptance_bar_contract_not_ready', reviewAgeMs: 3_600_000, gradeable: true,
      } } }],
    }, NOW);
  }

  it('delivers the placement row beside a due author-repair row, so a receipt can form', () => {
    const value = agenda();
    const due = value.primary.filter((row) => row.status === 'due');
    expect(due.map((row) => row.family).sort()).toEqual(['independent-verification', 'plan-placement']);
    const brief = projectAgentTurnStartObligationBrief(value);
    expect(brief.projection.receipt).toMatchObject({ entriesDelivered: 2, entriesOmitted: 0, bodyTruncated: false });
    expect(deliveredGoalPlacementRows({ ownerId: base.ownerId, workspaceId: base.workspaceId,
      brief, block: brief.projection.text })).toMatchObject([{ planSlug: SLUG }]);
  });

  it('CONTROL: the old slug-repeating summary is starved by the same sink', () => {
    const value = agenda();
    const old = { ...value, primary: value.primary.map((row) => row.family !== 'plan-placement' ? row : {
      ...row, action: { ...row.action!, summary: `launch the independently led fleet for ${SLUG} with the canonical transaction arguments` },
    }) };
    const brief = projectAgentTurnStartObligationBrief(old);
    expect(brief.projection.receipt.entriesOmitted).toBeGreaterThan(0);
    expect(deliveredGoalPlacementRows({ ownerId: base.ownerId, workspaceId: base.workspaceId,
      brief, block: brief.projection.text })).toEqual([]);
  });
});

describe('frozen provider matrix: plan placement (6 opportunities)', () => {
  const unplaced = worklistPlan(placement('unplaced', 'launch-plan-fleet'));
  const working = worklistPlan(placement('working', 'none'));
  const led = worklistPlan(placement('independently-led', 'none'), 'plan-b');
  const partial = worklistPlan(placement('admitting', 'resume-partial-launch'));
  const budgetRefusal = launch({
    refusal: {
      reason: 'goal_budget_exceeded',
      limit: 10_000,
      current: 10_500,
      requested: 2,
      currentScope: 'attributed-by-lineage:authoritative',
      message: 'verified goal budget is exhausted',
    },
  });

  it.each([
    [
      'due',
      planInput(
        knownPlacement({
          portfolio: portfolio([unplaced]),
          launch: launch(),
          alert: planAlert('started-plan-no-live-targeting-fleet'),
          evidenceRef: 'cohort:1',
        }),
      ),
      'delegate',
    ],
    [
      'blocked',
      planInput(
        knownPlacement({
          portfolio: portfolio([unplaced]),
          launch: budgetRefusal,
          alert: planAlert('started-plan-no-live-targeting-fleet'),
          evidenceRef: 'cohort:2',
        }),
      ),
      'repair',
    ],
    [
      'satisfied',
      planInput(knownPlacement({ portfolio: portfolio([working, led]), launch: launch(), evidenceRef: 'cohort:3' })),
      undefined,
    ],
    [
      'not-applicable',
      planInput(knownPlacement({ portfolio: portfolio([]), launch: budgetRefusal, evidenceRef: 'cohort:4' })),
      undefined,
    ],
    ['unknown', planInput({ status: 'unknown', failure }), 'inspect'],
    [
      'in-progress',
      planInput(
        knownPlacement({
          portfolio: portfolio([partial]),
          launch: launch(),
          alert: planAlert('started-plan-targeting-fleet-zero-live-claims'),
          evidenceRef: 'cohort:recovery',
          ageMs: 9_000,
        }),
      ),
      'continue',
    ],
  ] as const)('%s', (status, input, action) => {
    const result = planPlacementObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });
});

describe('plan placement preserves canonical launch evidence', () => {
  it.each(['paused', 'achieved', 'killed'])('never restarts a %s goal with unfinished plans', (status) => {
    const stopped = portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]);
    stopped.goal.status = status;
    const result = planPlacementObligation(
      planInput(knownPlacement({ portfolio: stopped, launch: launch(), evidenceRef: 'cohort:stopped' })),
    );

    expect(result).toMatchObject({ status: 'not-applicable', applicableDemand: 0 });
    expect(result.action).toBeUndefined();
    expect(result.changeSignal).toBeUndefined();
    expect(buildAgentObligationAgenda({ planPlacement: planInput(
      knownPlacement({ portfolio: stopped, launch: launch(), evidenceRef: 'cohort:stopped' }),
    ) }, NOW).primary).toEqual([]);
  });

  it.each([null, 'unrecognized'])('keeps unresolved goal lifecycle %s unknown', (status) => {
    const unresolved = portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]);
    unresolved.goal.status = status;
    const result = planPlacementObligation(
      planInput(knownPlacement({ portfolio: unresolved, launch: launch(), evidenceRef: 'cohort:lifecycle' })),
    );
    expect(result).toMatchObject({
      status: 'unknown',
      action: { kind: 'inspect' },
      measurementFailure: { code: 'goal-lifecycle-unresolved' },
    });
    expect(result.action?.tool).toBeUndefined();
  });

  it('does not turn a different goal portfolio into placement instructions', () => {
    const wrong = portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]);
    wrong.goal.id = 'other-goal';
    const result = planPlacementObligation(
      planInput(knownPlacement({ portfolio: wrong, launch: launch(), evidenceRef: 'cohort:wrong-goal' })),
    );
    expect(result).toMatchObject({
      status: 'unknown',
      action: { kind: 'inspect' },
      measurementFailure: { code: 'goal-portfolio-scope-mismatch' },
    });
    expect(result.action?.tool).toBeUndefined();
  });

  it('advances an eligible plan past a blocked predecessor and clears only on canonical placement effect', () => {
    const compile = (slug: string, source: unknown = {}) => compileGoalPlanPlacement({
      plan: { harness: 'papercusp', slug, ambiguousMatches: 1 },
      status: 'ready',
      itemStatuses: ['todo'],
      actionableItemId: slug === 'waiting-plan' ? null : 'P-001',
      source,
      now: new Date(NOW),
    });
    const waiting = worklistPlan(compile('waiting-plan'), 'waiting-plan');
    const eligible = worklistPlan(compile('ready-plan'), 'ready-plan');
    const observe = (plans: GoalPortfolioBrief['worklist']) => planPlacementObligation(
      planInput(knownPlacement({ portfolio: portfolio(plans), launch: launch(), evidenceRef: 'cohort:progress' })),
    );

    expect(observe([waiting, eligible])).toMatchObject({
      status: 'due',
      scope: { planSlug: 'ready-plan' },
      action: { kind: 'delegate', args: { plan: 'ready-plan' } },
    });
    // A declaration/empty transaction cannot clear the required placement.
    expect(observe([eligible]).status).toBe('due');
    const working = worklistPlan(compile('ready-plan', {
      goalHolderOwnerIds: ['su-goal'],
      claims: [{ itemId: 'P-001', ownerId: 'su-member', fleetSlug: 'ready-fleet', holderLive: true,
        workItemId: 'WI-member', expiresAt: '2026-09-05T20:05:00.000Z' }],
      fleet: {
        slug: 'ready-fleet', controlState: 'active', leaderOwnerId: 'su-independent', leaderLive: true,
        claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'ready-plan' } } },
        liveMembers: 1, target: 1, launchTransaction: { state: 'verified' },
      },
    }), 'ready-plan');
    expect(observe([working]).status).toBe('satisfied');
    expect(observe([working]).action).toBeUndefined();
    // The already-owned plan stays untouched; its independent wait is still visible.
    expect(observe([waiting, working])).toMatchObject({
      status: 'blocked',
      scope: { planSlug: 'waiting-plan' },
      action: { kind: 'repair', targetRef: waiting.ref },
    });
  });

  it('uses the portfolio transaction tool call, including spawned leadership, unchanged', () => {
    const result = planPlacementObligation(
      planInput(
        knownPlacement({
          portfolio: portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]),
          launch: launch(),
          alert: planAlert('started-plan-no-live-targeting-fleet'),
          evidenceRef: 'cohort:launch',
        }),
      ),
    );

    expect(result).toMatchObject({
      status: 'due',
      action: {
        kind: 'delegate',
        tool: 'fleet:launch-on-plan',
        args: { name: 'plan-a-fleet', plan: 'plan-a', harness: 'papercusp', leader: 'spawn', headless: true },
      },
    });
    expect(result.evidence.map((entry) => entry.note).join('\n')).toContain('headcount=2');
    expect(result.evidence.map((entry) => entry.note).join('\n')).toContain('budgetSource=goal-lineage-rollup');
  });

  it('keeps a degraded budget/headcount read explicit and never turns it into due work', () => {
    const result = planPlacementObligation(
      planInput(
        knownPlacement({
          portfolio: portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]),
          launch: launch({
            budget: {
              budgetCents: 10_000,
              spentCents: null,
              unmeasuredPricedSpend: false,
              spentCentsAt: null,
              spentCentsSource: null,
              interactiveUsageFreshnessStatus: null,
              interactiveUsageLastIngestedAtMs: null,
            },
            degraded: true,
            degradedReasons: ['budget ceiling not enforced — no platform spend snapshot'],
          }),
          evidenceRef: 'cohort:degraded',
        }),
      ),
    );

    expect(result).toMatchObject({
      status: 'unknown',
      measurementFailure: { code: 'goal-launch-resolution-degraded' },
      boundary: { unknown: 'allow-with-warning' },
    });
    expect(result.applicableDemand).toBe(1);
    expect(result.evidence.map((entry) => entry.note).join('\n')).toContain('budget=unknown/10000');
  });

  it('reports a classifier/portfolio disagreement as unknown rather than choosing a writer', () => {
    const result = planPlacementObligation(
      planInput(
        knownPlacement({
          portfolio: portfolio([worklistPlan(placement('working', 'none'))]),
          launch: launch(),
          alert: planAlert('started-plan-no-live-targeting-fleet'),
          evidenceRef: 'cohort:conflict',
        }),
      ),
    );

    expect(result).toMatchObject({
      status: 'unknown',
      measurementFailure: { code: 'plan-placement-writer-conflict' },
    });
  });

  it.each([
    ['goal_budget_unmeasurable', /budget measurement/i, /repair.*authoritative.*spend.*measurement/i],
    ['goal_budget_exceeded', /goal budget/i, /owner.*budget.*direction/i],
    ['goal_max_agents', /goal headcount/i, /within.*goal.*ceiling/i],
    ['fleet_max_agents', /fleet headcount/i, /within.*fleet.*ceiling/i],
  ] as const)('maps %s to its own bounded repair without increasing a ceiling', (reason, title, repair) => {
    const refusal: GoalLaunchRefusal = {
      reason, current: reason === 'goal_budget_unmeasurable' ? null : 10,
      limit: 10, requested: 1, currentScope: 'fixture:known-population', message: `Measured refusal: ${reason}`,
    };
    const result = planPlacementObligation(planInput(knownPlacement({
      portfolio: portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]),
      launch: launch({ refusal }), evidenceRef: 'cohort:typed-refusal',
    })));
    expect(result.status).toBe('blocked');
    expect(result.title).toMatch(title);
    expect(result.reason).toBe(refusal.message);
    expect(result.action).toMatchObject({ kind: 'repair', targetRef: 'goal:goal-1' });
    expect(result.action?.tool).toBeUndefined();
    expect(result.action?.summary).toMatch(repair);
    expect(result.action?.summary).not.toMatch(/revise the declared ceiling|restore verified budget headroom/i);
  });

  it('keeps an unrecognized launch refusal unknown instead of inventing a headcount remedy', () => {
    const refusal = { reason: 'future_admission_reason', current: null, limit: 1, requested: 1,
      currentScope: 'unknown', message: 'A newer launch resolver refused.' } as unknown as GoalLaunchRefusal;
    const result = planPlacementObligation(planInput(knownPlacement({
      portfolio: portfolio([worklistPlan(placement('unplaced', 'launch-plan-fleet'))]),
      launch: launch({ refusal }), evidenceRef: 'cohort:future-refusal',
    })));
    expect(result).toMatchObject({ status: 'unknown',
      measurementFailure: { code: 'unsupported-goal-launch-refusal' },
    });
    expect(result.action?.tool).toBeUndefined();
    expect(result.action?.summary).not.toMatch(/headroom|raise|ceiling/i);
  });

  it('does not intervene for a terminal-only portfolio even when launches would be refused', () => {
    const result = planPlacementObligation(
      planInput(
        knownPlacement({
          portfolio: portfolio([worklistPlan(placement('terminal', 'none'))]),
          launch: launch({
            refusal: {
              reason: 'goal_max_agents',
              limit: 5,
              current: 5,
              requested: 1,
              currentScope: 'live-agents-in-goal',
              message: 'no headroom',
            },
          }),
          evidenceRef: 'cohort:terminal',
        }),
      ),
    );

    expect(result).toMatchObject({ status: 'not-applicable', applicableDemand: 0 });
    expect(result.action).toBeUndefined();
  });

  describe('owner-walled plans create no placement demand (WI-10005657)', () => {
    const wall = { kind: 'owner' as const, itemIds: ['P-003'] };
    const walled = (slug = 'plan-a') => worklistPlan(placement('owner-walled', 'none', { wall }), slug);
    const observe = (worklist: GoalPortfolioBrief['worklist'], alert: ReturnType<typeof planAlert> | null = null) =>
      planPlacementObligation(planInput(knownPlacement({
        portfolio: portfolio(worklist), launch: launch(), alert, evidenceRef: 'cohort:owner-walled',
      })));

    it('treats a worklist of only owner-walled plans as zero demand with no launch mandate', () => {
      const result = observe([walled()]);
      expect(result).toMatchObject({ status: 'not-applicable', applicableDemand: 0 });
      expect(result.episode).toBe(`owner-walled:${base.sourceGeneration}`);
      expect(result.reason).toContain('plan:papercusp/plan-a (P-003)');
      expect(result.action).toBeUndefined();
    });

    it('keeps the wall quiet when the cohort watchdog alert names the walled plan', () => {
      // The watchdog legitimately sees an unstaffed started plan; the wall is the more
      // specific writer, so this must neither conflict nor re-mandate a launch.
      const result = observe([walled()], planAlert('started-plan-no-live-targeting-fleet'));
      expect(result).toMatchObject({ status: 'not-applicable', applicableDemand: 0 });
      expect(result.measurementFailure).toBeUndefined();
      expect(result.action).toBeUndefined();
    });

    it('does not let a wall starve a later eligible plan, and does not count the wall as its demand', () => {
      const laterLaunch = placement('unplaced', 'launch-plan-fleet', {
        reconciliation: {
          consistent: false,
          action: 'launch-plan-fleet',
          reason: 'canonical repair: launch-plan-fleet',
          toolCall: {
            tool: 'fleet:launch-on-plan',
            args: { name: 'plan-b-fleet', plan: 'plan-b', harness: 'papercusp', leader: 'spawn', headless: true },
          },
        },
      });
      const result = observe([walled('plan-a'), worklistPlan(laterLaunch, 'plan-b')],
        planAlert('started-plan-no-live-targeting-fleet'));
      expect(result).toMatchObject({
        status: 'due',
        applicableDemand: 1,
        action: { tool: 'fleet:launch-on-plan', args: { plan: 'plan-b' } },
      });
      expect(result.measurementFailure).toBeUndefined();
    });

    it('CONTROL: the same plan without the wall is still demand, and its alert still conflicts', () => {
      // Positive controls — without these the three tests above would also pass if
      // every `blocked`/`working` plan were silently treated as walled.
      const blocked = observe([worklistPlan(placement('blocked', 'resolve-plan-blockers'))]);
      expect(blocked.applicableDemand).toBe(1);
      expect(blocked.episode).not.toMatch(/^owner-walled:/);
      expect(blocked.status).not.toBe('not-applicable');
      expect(observe([worklistPlan(placement('working', 'none')), worklistPlan(placement('unplaced', 'launch-plan-fleet'), 'plan-b')],
        planAlert('started-plan-no-live-targeting-fleet'))).toMatchObject({
        status: 'unknown', measurementFailure: { code: 'plan-placement-writer-conflict' },
      });
    });
  });
});

describe('frozen provider matrix: owner reporting (6 opportunities)', () => {
  const report = (obligation: 'overdue' | 'due-now' | 'not-due', lastReportAt: string | null = null) => ({
    lastReportAt,
    ageMin: obligation === 'overdue' ? 75 : 20,
    floorMin: 60,
    dueInMin: obligation === 'overdue' ? -15 : obligation === 'due-now' ? 3 : 40,
    dueAt:
      obligation === 'overdue'
        ? '2026-09-05T18:45:00.000Z'
        : obligation === 'due-now'
          ? '2026-09-05T19:03:00.000Z'
          : '2026-09-05T19:40:00.000Z',
    standing: true,
    obligation,
    instruction: obligation,
  });

  it.each([
    ['due', reportInput({ status: 'known', value: report('overdue') }), 'report'],
    ['due', reportInput({ status: 'known', value: report('due-now') }), 'report'],
    ['satisfied', reportInput({ status: 'known', value: report('not-due', '2026-09-05T19:40:00.000Z') }), undefined],
    ['not-applicable', reportInput({ status: 'known', value: report('not-due') }), undefined],
    ['not-applicable', reportInput({ status: 'known', value: null }), undefined],
    ['unknown', reportInput({ status: 'unknown', failure }), 'inspect'],
  ] as const)('%s', (status, input, action) => {
    const result = ownerReportObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });
});

describe('frozen provider matrix: independent verification (6 opportunities)', () => {
  const gate = (
    satisfied: boolean,
    code?: NonNullable<Parameters<typeof independentVerificationObligation>[0]['read']> extends never ? never : string,
  ) => ({
    buildProvenance: { sha: null, version: 'test' },
    satisfied,
    ...(code ? { code: code as never } : {}),
    message: code ? `refused: ${code}` : 'accepted',
    rubricId: 'acceptance-plan-a',
    gradedBy: satisfied ? 'su-independent' : null,
  });
  const known = (g: ReturnType<typeof gate>, gradeable = true): IndependentVerificationProviderInput['read'] => ({
    status: 'known',
    value: { gate: g, evidenceRef: `gate:${g.code ?? 'pass'}`, reviewAgeMs: 3_600_000, gradeable },
  });

  it.each([
    ['due', verifyInput(known(gate(false, 'acceptance_ungraded'))), 'delegate'],
    ['due', verifyInput(known(gate(false, 'self_graded_only'))), 'delegate'],
    // D-009 ruling 3: author repair is DUE, not blocked. The author can start it
    // this second, so `[BLOCKED]` was telling the only agent who could act that it
    // could not. It is `repair`, never `delegate` — visibility recruits nobody.
    ['due', verifyInput(known(gate(false, 'acceptance_rubric_missing'))), 'repair'],
    // A failed MEASUREMENT is not work: nobody owns a repair for a gate read that
    // never happened, so it stays blocked and asks to be re-read.
    ['blocked', verifyInput(known(gate(false, 'acceptance_lineage_unreadable'))), 'inspect'],
    ['satisfied', verifyInput(known(gate(true))), undefined],
    ['not-applicable', verifyInput(known(gate(false, 'plan_items_unfinished'), false)), undefined],
    ['unknown', verifyInput({ status: 'unknown', failure }), 'inspect'],
  ] as const)('%s', (status, input, action) => {
    const result = independentVerificationObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });

  it('delegates grading by naming the routed recruiter, never a hand-picked grader', () => {
    // review-routing-through-relevance-router-2026-09-26 D-001: plans:set-plan-status
    // → shipped IS the recruiter. The action must name that call so a reader does
    // not pick a grader off coord:presence and message it directly.
    for (const code of ['acceptance_ungraded', 'self_graded_only', 'independent_verification_missing'] as const) {
      const action = independentVerificationObligation(verifyInput(known(gate(false, code)))).action;
      expect(action).toMatchObject({
        kind: 'delegate',
        tool: 'plans:set-plan-status',
        args: { slug: verifyInput(known(gate(false, code))).planSlug, status: 'shipped' },
      });
      expect(action?.summary).not.toMatch(/coord:send|coord:dispatch|assign_to/);
    }
  });

  it('mints a fresh episode when the same gate code recurs on a new source generation', () => {
    const read = known(gate(false, 'acceptance_ungraded'));
    const first = independentVerificationObligation(verifyInput(read));
    const second = independentVerificationObligation({ ...verifyInput(read), sourceGeneration: 'generation-2' });
    expect(first.id).not.toBe(second.id);
  });

  /**
   * D-009 ruling 3, the safety half. Driven over EVERY key of GATE_CODE_OWNERSHIP —
   * derived from the Record itself, so a code added later is covered automatically
   * rather than silently escaping a hand-listed fixture.
   *
   * The invariant that must never break: making author-owned work VISIBLE (`due`)
   * must not make it DELEGABLE. `acceptance-bar-lifecycle-evaluator.ts` renders a
   * user-facing promise that a contract refusal "does NOT recruit a grader … do not
   * recruit or wake a peer for them"; if this test ever fails, that rendered sentence
   * has become a lie.
   */
  const ownershipCodes = Object.entries(GATE_CODE_OWNERSHIP) as [
    keyof typeof GATE_CODE_OWNERSHIP,
    PlanAcceptanceGateCodeOwnership,
  ][];

  it('covers the whole gate-code union (calibration: the derived population is non-trivial)', () => {
    // Without this, a Record that somehow enumerated nothing would make every
    // assertion below pass VACUOUSLY — the it.each would simply run zero cases.
    expect(ownershipCodes.length).toBeGreaterThanOrEqual(20);
    // WI-6554700010008529: independent_verification_missing joined acceptance_ungraded and
    // self_graded_only — a recruited grader is the D-005 independent verifier.
    expect(ownershipCodes.filter(([, owner]) => owner === 'grader').map(([code]) => code).sort()).toEqual([
      'acceptance_ungraded',
      'independent_verification_missing',
      'self_graded_only',
    ]);
  });

  it.each(ownershipCodes)('%s (%s) routes by ownership, and only a grader gap delegates', (code, owner) => {
    const result = independentVerificationObligation(verifyInput(known(gate(false, code))));

    // THE safety invariant: delegation is reachable from `grader` and nothing else.
    expect(result.action?.kind === 'delegate').toBe(owner === 'grader');

    // The visibility half: actionable is strictly WIDER than delegable.
    expect(result.status).toBe(owner === 'grader' || owner === 'author' ? 'due' : 'blocked');

    // Author repair stays upstream so it cannot be outranked by a downstream symptom.
    expect(result.causalRank).toBe(owner === 'author' ? 0 : 2);

    // A failed measurement is never dressed up as somebody's repair.
    if (owner === 'unmeasured') expect(result.action?.kind).toBe('inspect');
  });

  /**
   * R-1's falsifier, verbatim: "Drive one plan to an `acceptance_ungraded` verdict
   * twice … and count its plan-acceptance obligations after each pass; any count
   * other than one falsifies R-1 on P-002."
   */
  it.each(['acceptance_ungraded', 'acceptance_bar_contract_not_ready'] as const)(
    'reconciles a repeat %s verdict into exactly one obligation instead of a second',
    (code) => {
      const read = known(gate(false, code));
      const pass = () =>
        buildAgentObligationAgenda({ independentVerification: [verifyInput(read)] }, NOW).primary.filter(
          (entry) => entry.family === 'independent-verification',
        );

      expect(pass()).toHaveLength(1);
      // Same verdict, same source generation — a reconciliation, not a new episode.
      const [first] = pass();
      const [second] = pass();
      expect(pass()).toHaveLength(1);
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('due');

      // Both passes agree, so the agenda must not flag a provider conflict.
      expect(
        buildAgentObligationAgenda(
          { independentVerification: [verifyInput(read), verifyInput(read)] },
          NOW,
        ).conflicts,
      ).toEqual([]);
    },
  );
});

describe('shared agenda composition', () => {
  it('returns one deterministic generation and ranks author repair ahead of grader dispatch', () => {
    const agenda = buildAgentObligationAgenda(
      {
        ownerReport: reportInput({
          status: 'known',
          value: {
            lastReportAt: null,
            ageMin: 75,
            floorMin: 60,
            dueInMin: -15,
            dueAt: '2026-09-05T18:45:00.000Z',
            standing: true,
            obligation: 'overdue',
            instruction: 'report now',
          },
        }),
        independentVerification: [
          verifyInput({
            status: 'known',
            value: {
              gate: {
                satisfied: false,
                code: 'acceptance_rubric_missing',
                message: 'author the rubric',
              },
              evidenceRef: 'gate:missing-rubric',
              gradeable: true,
            },
          }),
        ],
      },
      NOW,
    );
    expect(agenda.evaluations).toHaveLength(2);
    expect(agenda.primary[0]?.family).toBe('independent-verification');
    expect(agenda.sourceGeneration).toMatch(/^[a-f0-9]{20}$/);
  });

  it('never mistakes unknown or no-demand cases for due work', () => {
    const agenda = buildAgentObligationAgenda(
      {
        planPlacement: planInput({ status: 'unknown', failure }),
        ownerReport: reportInput({ status: 'known', value: null }),
      },
      NOW,
    );
    expect(agenda.evaluations.map((entry) => entry.status).sort()).toEqual(['not-applicable', 'unknown']);
    expect(agenda.evaluations.some((entry) => entry.status === 'due')).toBe(false);
  });
});

describe('frozen provider matrix: waiting-on (P-011)', () => {
  const waitingInput = (read: WaitingOnProviderInput['read']): WaitingOnProviderInput => ({ ...base, read });
  const awaitRow = (over: Partial<Extract<WaitingOnObligationRow, { kind: 'event-await' }>> = {}) =>
    ({
      kind: 'event-await' as const,
      key: 'work-item:done:WI-10002222',
      timeoutAt: '2026-09-05T21:00:00.000Z',
      onTimeout: 'wake' as const,
      ...over,
    }) satisfies WaitingOnObligationRow;

  it('reports a failed read as unknown rather than as "waiting on nothing"', () => {
    const [row] = waitingOnObligations(waitingInput({ status: 'unknown', failure }));
    // The reassuring reading is the dangerous one: a read that FAILED must never
    // render as an empty wait list, or a silently-expiring await disappears.
    expect(row!.status).toBe('unknown');
    expect(row!.applicableDemand).toBe(0);
    expect(row!.reason).toBe(failure.detail);
    expect(row!.action?.targetRef).toBe('events:status');
  });

  it('reports a genuinely empty wait as not-applicable, not as absence of measurement', () => {
    const [row] = waitingOnObligations(waitingInput({ status: 'known', value: [] }));
    expect(row!.status).toBe('not-applicable');
    expect(row!.priority).toBe('low');
    expect(row!.applicableDemand).toBe(0);
  });

  it('carries the awaited key VERBATIM in the title, which is the only field the narrow sink renders', () => {
    const [row] = waitingOnObligations(waitingInput({ status: 'known', value: [awaitRow()] }));
    expect(row!.title).toContain('work-item:done:WI-10002222');
    expect(row!.reason).toContain('work-item:done:WI-10002222');
    // A hand-retyped key does not rendezvous — so the key must survive the hop
    // into evidence too, where a successor recovers it.
    expect(row!.evidence[0]!.ref).toBe('event-await:work-item:done:WI-10002222');
  });

  it("does not report this session's standing inbox-wake as a blocking dependency", () => {
    const rows = waitingOnObligations(
      waitingInput({
        status: 'known',
        value: [awaitRow({ key: inboxWakeKey(base.ownerId), timeoutAt: null })],
      }),
    );

    expect(rows.every((row) => row.status !== 'blocked')).toBe(true);
    expect(rows.map((row) => formatAgentObligationLine(row, 'action')).join('\n'))
      .not.toContain(`[BLOCKED] Awaiting ${inboxWakeKey(base.ownerId)}`);
  });

  it('ranks a SILENTLY-expiring await above a waking one and says so in the title', () => {
    const [waking] = waitingOnObligations(waitingInput({ status: 'known', value: [awaitRow()] }));
    const [expiring] = waitingOnObligations(
      waitingInput({ status: 'known', value: [awaitRow({ onTimeout: 'expire' })] }),
    );
    expect(waking!.priority).toBe('normal');
    expect(waking!.title).not.toContain('expires SILENTLY');
    // At the deadline a `wake` row still gets a turn; an `expire` row lapses with
    // NO turn, so nothing in the session ever mentions it again.
    expect(expiring!.priority).toBe('high');
    expect(expiring!.title).toContain('expires SILENTLY');
  });

  it('keys the episode on the await itself, so a re-render on a new generation is not a new obligation', () => {
    const first = waitingOnObligations(waitingInput({ status: 'known', value: [awaitRow()] }))[0]!;
    const second = waitingOnObligations({
      ...waitingInput({ status: 'known', value: [awaitRow()] }),
      sourceGeneration: 'rev-43',
      observedAt: '2026-09-05T20:30:00.000Z',
    })[0]!;
    // Same parked await, later turn: the SAME obligation, or a warm-turn dedup
    // reads every re-render as brand-new and the row churns forever.
    expect(second.episode).toBe(first.episode);
    expect(second.id).toBe(first.id);
  });

  it('names WHAT a queued lock is behind — holder, intent and expiry — not merely THAT it is queued', () => {
    const [row] = waitingOnObligations(
      waitingInput({
        status: 'known',
        value: [
          {
            kind: 'lock-queue',
            path: 'packages/operator-core/lib/agent-obligations.ts',
            holder: 'su-peer',
            holderIntent: 'rewriting the obligation union',
            holderExpiresAt: '2026-09-05T20:10:00.000Z',
          },
        ],
      }),
    );
    expect(row!.title).toContain('su-peer');
    expect(row!.reason).toContain('rewriting the obligation union');
    expect(row!.reason).toContain('2026-09-05T20:10:00.000Z');
    expect(row!.action?.tool).toBe('locks:queue');
    expect(row!.action?.args).toEqual({ paths: ['packages/operator-core/lib/agent-obligations.ts'] });
  });

  it('keeps a row whose holder could not be resolved, rather than dropping the wait itself', () => {
    const [row] = waitingOnObligations(
      waitingInput({
        status: 'known',
        value: [
          {
            kind: 'lock-queue',
            path: 'packages/operator-core/lib/x.ts',
            holder: 'unknown holder',
            holderIntent: null,
            holderExpiresAt: null,
          },
        ],
      }),
    );
    // One unresolvable FIELD must never suppress the row: the ticket is queued
    // either way, and a dropped row hides the wait completely.
    expect(row!.status).toBe('blocked');
    expect(row!.applicableDemand).toBe(1);
    expect(row!.dueAt).toBeUndefined();
  });

  it('emits one row per wait, so two concurrent waits are both visible', () => {
    const rows = waitingOnObligations(
      waitingInput({
        status: 'known',
        value: [
          awaitRow(),
          awaitRow({ key: 'plan-item:done:turn-start-memory-two-class-2026-09-21:P-011', timeoutAt: null }),
        ],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.episode)).size).toBe(2);
    expect(rows[1]!.reason).toContain('no deadline');
    expect(rows[1]!.dueAt).toBeUndefined();
  });
});

describe('frozen provider matrix: fleet staffing (P-005 / D-030)', () => {
  type Evaluation = FleetUnderStaffedEvaluation;
  const staffingInput = (read: FleetStaffingProviderInput['read']): FleetStaffingProviderInput => ({ ...base, read });
  const evaluation = (over: Partial<Evaluation> = {}): Evaluation => ({
    alert: true,
    current: 0,
    target: 3,
    shortfall: 3,
    held: false,
    notHeldBecause: 'supervise-not-granted',
    topUpRule: null,
    repair: 'fleet:headcount-target { target, supervise:true }',
    reason: '0 of 3 target worker(s) are productive (short 3).',
    ...over,
  });
  const known = (fleetSlug: string, e: Evaluation | null, unknownReason?: string) =>
    staffingInput({
      status: 'known',
      value: [{ fleetSlug, evaluation: e, ...(unknownReason ? { unknownReason } : {}) }],
    });

  it('reports a failed read as ONE unknown row, never as "leads no under-staffed fleet"', () => {
    const rows = fleetStaffingObligations(staffingInput({ status: 'unknown', failure }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('unknown');
    expect(rows[0]!.applicableDemand).toBe(0);
    expect(rows[0]!.reason).toBe(failure.detail);
    expect(rows[0]!.measurementFailure).toEqual(failure);
  });

  it('emits nothing when the session leads no active fleet', () => {
    expect(fleetStaffingObligations(staffingInput({ status: 'known', value: [] }))).toEqual([]);
  });

  it('makes an unheld EMPTY fleet a high-priority due repair that names the fleet and the tool', () => {
    const [row] = fleetStaffingObligations(known('fleet-empty', evaluation()));
    expect(row!.family).toBe('fleet-staffing');
    expect(row!.status).toBe('due');
    expect(row!.priority).toBe('high');
    expect(row!.applicableDemand).toBe(1);
    expect(row!.title).toContain('fleet-empty');
    expect(row!.title).toContain('short 3 of 3');
    expect(row!.action).toMatchObject({ kind: 'repair', tool: 'fleet:headcount-target', targetRef: 'fleet:fleet-empty' });
    expect(row!.evidence[0]!.ref).toBe('fleet:fleet-empty');
  });

  it('keeps a partly-staffed unheld fleet due, at normal priority', () => {
    const [row] = fleetStaffingObligations(known('fleet-thin', evaluation({ current: 1, shortfall: 2 })));
    expect(row!.status).toBe('due');
    expect(row!.priority).toBe('normal');
  });

  it('stays due when whether the governor holds the fleet is UNKNOWN: nothing confirms a restore', () => {
    const [row] = fleetStaffingObligations(known('fleet-unsure', evaluation({ held: null, notHeldBecause: null })));
    expect(row!.status).toBe('due');
  });

  it('emits no row for a held fleet below target: the governor is already restoring it', () => {
    expect(fleetStaffingObligations(known('fleet-held', evaluation({ held: true, notHeldBecause: null })))).toEqual([]);
  });

  it('emits no row for a fleet at target', () => {
    expect(
      fleetStaffingObligations(known('fleet-full', evaluation({ alert: false, current: 3, shortfall: 0 }))),
    ).toEqual([]);
  });

  it('titles a zero-worker fleet with no target by that cause, not by a shortfall', () => {
    const [row] = fleetStaffingObligations(
      known('fleet-untargeted', evaluation({ target: null, shortfall: null, notHeldBecause: 'no-target' })),
    );
    expect(row!.title).toBe('Fleet fleet-untargeted has no workers and no headcount target');
  });

  it('makes an unmeasured fleet an UNKNOWN row that points at the brief, not a due repair', () => {
    const [row] = fleetStaffingObligations(known('fleet-dark', null, 'the live roster could not be read'));
    expect(row!.status).toBe('unknown');
    expect(row!.applicableDemand).toBe(0);
    expect(row!.reason).toBe('the live roster could not be read');
    expect(row!.action).toMatchObject({ tool: 'fleet:leader-brief', targetRef: 'fleet:fleet-dark' });
  });

  it('keys the episode on the fleet and its cause, so a re-render is the same obligation and a new cause is not', () => {
    const first = fleetStaffingObligations(known('fleet-a', evaluation()))[0]!;
    const again = fleetStaffingObligations({
      ...known('fleet-a', evaluation()),
      sourceGeneration: 'rev-43',
      observedAt: '2026-09-05T20:30:00.000Z',
    })[0]!;
    const newCause = fleetStaffingObligations(known('fleet-a', evaluation({ notHeldBecause: 'top-up-rule' })))[0]!;
    expect(again.episode).toBe(first.episode);
    expect(again.id).toBe(first.id);
    expect(newCause.episode).not.toBe(first.episode);
  });

  it('reaches the shared agenda as a due row', () => {
    const agenda = buildAgentObligationAgenda({ fleetStaffing: known('fleet-agenda', evaluation()) }, NOW);
    expect(agenda.primary[0]?.family).toBe('fleet-staffing');
    expect(agenda.evaluations.map((entry) => entry.status)).toEqual(['due']);
  });
});
