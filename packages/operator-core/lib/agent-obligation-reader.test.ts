import { afterEach, describe, expect, it, vi } from 'vitest';
import { goalPlanningPortfolioFingerprint } from './goal-planning-review';
import { advanceGoalPlacementProgress, goalPlacementProgressScopeKey } from './goal-placement-progress';
import { buildGoalOwnerReportDraft } from './goal-owner-report';

import {
  AGENT_OBLIGATION_PORTFOLIO_PROJECTION,
  defaultAgentObligationReaderDeps,
  PLAN_CONTEXT_MAX,
  projectAgentObligationBrief,
  projectAgentTurnStartObligationBrief,
  readAgentObligationAgenda,
  readAgentGoalModeState,
  type AgentObligationReaderDeps,
} from './agent-obligation-reader';
import type { GoalLaunchResolution, GoalPortfolioBrief } from './goal-launch-settings';
import type { PlanAcceptanceGateVerdict } from './plan-acceptance-gate';
import type { PlanClosureObservationRead } from './goals/plan-closure-observations';
import type { GoalPlanFleetObservation } from './system-health/goal-drain-fleet-watchdog';
import type { GoalOwnerReportObligation } from './system-health/goal-owner-report-watchdog';
import type { ExactPlanAdmission } from './agent-tools/plans/plan-admission-preflight';

const NOW = new Date('2026-09-05T20:00:00.000Z');

function portfolio(assembledAt = NOW.toISOString()): GoalPortfolioBrief {
  return {
    schemaVersion: 1,
    assembledAt,
    goal: {
      id: 'goal-1',
      title: 'Goal',
      status: 'active',
      body: null,
      killCriterion: null,
      standing: true,
      parentId: null,
    },
    worklist: [],
    pots: [],
    drainFleet: { slug: null, exists: null, controlState: null, leaderOwnerId: null, live: null, working: null },
    queue: {
      total: 0,
      terminal: 0,
      inFlight: 0,
      blocked: 0,
      needsHuman: 0,
      claimable: 0,
      claimabilityScope: 'issue-family',
    },
    launch: { settings: null, ceilings: { maxAgents: 10, maxPerFleet: 5 }, headcount: { total: 1, fleet: null } },
    budget: {
      budgetCents: null,
      spentCents: null,
      unmeasuredPricedSpend: false,
      spentCentsAt: null,
      spentCentsSource: null,
      interactiveUsageFreshnessStatus: null,
      interactiveUsageLastIngestedAtMs: null,
      budgetWindowSec: null,
    },
    tripwires: [],
    pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null },
    priorities: [],
    degradedReasons: [],
  };
}

function launch(): GoalLaunchResolution {
  return {
    goalId: 'goal-1',
    settings: null,
    goalBrief: null,
    effective: {},
    ceilings: { maxAgents: 10, maxPerFleet: 5 },
    headcount: { total: 1, fleet: null },
    budget: null,
    refusal: null,
    degraded: false,
    degradedReasons: [],
  };
}

function deps(overrides: Partial<AgentObligationReaderDeps> = {}): AgentObligationReaderDeps {
  return {
    goalSubject: vi.fn(async () => 'goal-1'),
    planSlugs: vi.fn(async () => ['plan-a']),
    goalPortfolio: vi.fn(async () => portfolio()),
    goalPlacementProgress: vi.fn(async () => ({})),
    goalPlanning: vi.fn(async () => ({ review: {
      schemaVersion: 1 as const, goalId: 'goal-1', disposition: 'existing-plans-sufficient' as const,
      rationale: 'No uncovered outcome in this generic reader fixture.', evidenceRefs: ['goal:goal-1'], planRefs: [],
      coverage: [],
      portfolioFingerprint: goalPlanningPortfolioFingerprint(portfolio()), reviewedAt: NOW.toISOString(),
    }, authorities: {} })),
    goalLaunch: vi.fn(async () => launch()),
    planAdmission: vi.fn(async (): Promise<ExactPlanAdmission> => ({
      ready: true, status: 'ready', reason: 'ready', message: 'exact plan is ready',
      requestedSeats: 1, executableWidth: 1,
    } as ExactPlanAdmission)),
    planFleet: vi.fn(
      async (): Promise<GoalPlanFleetObservation> => ({
        status: 'known',
        alert: null,
        applicablePlanCount: 0,
      }),
    ),
    ownerReport: vi.fn(
      async (): Promise<GoalOwnerReportObligation> => ({
        lastReportAt: null,
        ageMin: 75,
        floorMin: 60,
        dueInMin: -15,
        dueAt: '2026-09-05T18:45:00.000Z',
        standing: true,
        obligation: 'overdue',
        instruction: 'report now',
      }),
    ),
    planAcceptance: vi.fn(
      async (): Promise<PlanAcceptanceGateVerdict> => ({
        buildProvenance: { sha: null, version: 'test' },
        satisfied: false,
        code: 'acceptance_rubric_missing',
        message: 'author the rubric',
      }),
    ),
    // Injected rather than left to the default dep: the real one reads
    // harness_shared.owner_directives, so omitting it would make every case
    // below depend on a live database AND silently add an `unknown`
    // owner-directive row to the agenda each fixture is asserting on.
    // The owner-directive family has its own suite
    // (agent-obligation-owner-directives.test.ts); here it is deliberately
    // empty so these cases keep measuring the goal/plan providers.
    ownerDirectives: vi.fn(async () => []),
    waitingOn: vi.fn(async () => []),
    fleetStaffing: vi.fn(async () => []),
    strandedGoalWork: vi.fn(async (_ws: string, goalId: string) => ({ goalId, thresholdMs: 0, total: 0, refusedCount: 0, sample: [], truncatedByLimit: false })),
    ...overrides,
  };
}

describe('shared agent obligation reader', () => {
  it('delivers a bounded goal action with exact identity and source revision despite a long outcome', async () => {
    const p = portfolio();
    const uncoveredOutcome = 'An evidenced missing recovery path. '.repeat(80);
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      planSlugs: [], deps: deps({ ownerReport: async () => null, goalPlanning: async () => ({
        review: { schemaVersion: 1, goalId: 'goal-1', disposition: 'plan-needed',
          rationale: 'Existing plans do not cover this outcome.', evidenceRefs: ['work-item:WI-gap'], planRefs: [],
          uncoveredOutcome, portfolioFingerprint: goalPlanningPortfolioFingerprint(p), reviewedAt: NOW.toISOString() },
        authorities: {},
      }) }) });
    const obligation = read.agenda.primary.find((row) => row.family === 'planning-needed')!;
    const brief = projectAgentTurnStartObligationBrief(read.agenda);
    expect(brief.projection.receipt.entriesDelivered).toBe(1);
    expect(brief.projection.receipt.entriesOmitted).toBe(0);
    expect(brief.projection.text.length).toBeLessThanOrEqual(400);
    expect(brief.projection.text).toContain(obligation.id);
    expect(brief.projection.text).toContain(obligation.ruleRevision);
    expect(brief.projection.text).toContain(obligation.sourceGeneration);
    expect(brief.projection.text).toContain('verify real claims');
    expect(obligation.reason).toContain(uncoveredOutcome);
  });

  it('prints source identity even when the ordinary goal action already fits the sink', async () => {
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      planSlugs: [], deps: deps({ ownerReport: async () => null, goalPlanning: async () => ({ review: null, authorities: {} }) }) });
    const obligation = read.agenda.primary.find((row) => row.family === 'planning-needed')!;
    const text = projectAgentTurnStartObligationBrief(read.agenda).projection.text;
    expect(text).toContain(obligation.id);
    expect(text).toContain(obligation.ruleRevision);
    expect(text).toContain(obligation.sourceGeneration);
  });

  it('delivers recorded uncovered needs from the planning reader', async () => {
    const p = portfolio();
    const goalPlanning = vi.fn(async () => ({ review: {
      schemaVersion: 1 as const, goalId: 'goal-1', disposition: 'plan-needed' as const,
      rationale: 'Failure recovery is uncovered.', evidenceRefs: ['work-item:WI-gap'], planRefs: [],
      uncoveredOutcome: 'Recover failed checkout', portfolioFingerprint: goalPlanningPortfolioFingerprint(p),
      reviewedAt: NOW.toISOString(),
    }, authorities: {} }));
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      deps: deps({ goalPlanning }) });
    expect(goalPlanning).toHaveBeenCalledWith('ws', 'su-goal', 'goal-1');
    expect(read.agenda.evaluations.find((row) => row.family === 'planning-needed')).toMatchObject({
      status: 'due', applicableDemand: 1, action: { kind: 'continue' },
    });
  });
  it('keeps failed planning reads unknown while unrelated obligations remain available', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      deps: deps({ goalPlanning: vi.fn(async () => { throw new Error('review ledger unavailable'); }) }) });
    expect(read.agenda.evaluations.find((row) => row.family === 'planning-needed')?.status).toBe('unknown');
    expect(read.agenda.evaluations.some((row) => row.family === 'owner-report')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('review ledger unavailable'));
    warn.mockRestore();
  });
  it.each(['paused', 'achieved', 'killed'])('does not deliver stale reporting work for a %s goal', async (status) => {
    const stopped = portfolio();
    stopped.goal.status = status;
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      planSlugs: [],
      deps: deps({ goalPortfolio: vi.fn(async () => stopped) }),
    });
    expect(read.agenda.primary).toEqual([]);
    expect(read.agenda.evaluations.find((entry) => entry.family === 'owner-report')?.status).toBe('not-applicable');
    expect(projectAgentTurnStartObligationBrief(read.agenda).projection.text).toBe('');
  });

  it('does not revive a stopped goal when its review ledger fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stopped = portfolio(); stopped.goal.status = 'paused';
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      planSlugs: [], deps: deps({ goalPortfolio: async () => stopped,
        goalPlanning: async () => { throw new Error('stopped review unavailable'); } }) });
    expect(read.agenda.evaluations.find((row) => row.family === 'planning-needed')?.status).toBe('not-applicable');
    expect(read.agenda.primary).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopped review unavailable'));
    warn.mockRestore();
  });

  it.each(['paused', 'achieved', 'killed'])('does not revive placement for a %s goal when its fleet read is unknown', async (status) => {
    const stopped = portfolio(); stopped.goal.status = status;
    const planFleet = vi.fn(async (): Promise<GoalPlanFleetObservation> =>
      ({ status: 'unknown', alert: null, applicablePlanCount: null }));
    const read = await readAgentObligationAgenda({ workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      planSlugs: [], deps: deps({ goalPortfolio: async () => stopped, planFleet }) });
    expect(read.agenda.evaluations.find((row) => row.ruleId === 'goal-plan-placement')).toMatchObject({
      status: 'not-applicable',
    });
    expect(read.agenda.primary).toEqual([]);
  });

  it.each([null, 'unrecognized'])('does not turn lifecycle %s into a reporting duty', async (status) => {
    const unknown = portfolio();
    unknown.goal.status = status;
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', now: NOW, planSlugs: [],
      deps: deps({ goalPortfolio: vi.fn(async () => unknown) }),
    });
    expect(read.agenda.evaluations.find((entry) => entry.family === 'owner-report')).toMatchObject({
      status: 'unknown', action: { kind: 'inspect' },
    });
  });

  it('keeps a mismatched portfolio unknown in the consumed reporting agenda', async () => {
    const wrong = portfolio();
    wrong.goal.id = 'other-goal';
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', now: NOW, planSlugs: [],
      deps: deps({ goalPortfolio: vi.fn(async () => wrong) }),
    });
    expect(read.agenda.evaluations.find((entry) => entry.family === 'owner-report')).toMatchObject({
      status: 'unknown', action: { kind: 'inspect' },
    });
    expect(read.degradedSources).not.toEqual([]);
    expect(projectAgentTurnStartObligationBrief(read.agenda).projection.text).not.toContain('[DUE]');
  });

  it('assembles all applicable canonical providers into one agenda', async () => {
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps(),
    });

    expect(read.goalId).toBe('goal-1');
    expect(read.planSlugs).toEqual(['plan-a']);
    expect(read.portfolio?.goal.id).toBe('goal-1');
    expect(read.agenda.evaluations.map((entry) => [entry.family, entry.status])).toEqual([
      ['owner-report', 'due'],
      ['plan-placement', 'not-applicable'],
      ['planning-needed', 'satisfied'],
      // P-006: the owner-directive family is assembled UNCONDITIONALLY, so an
      // empty queue is reported as a measured not-applicable rather than as the
      // class being absent — those two must never render identically.
      ['owner-directive', 'not-applicable'],
      // 'due', not 'blocked': D-009 ruling 3 split `graderGap` into `isDelegable`
      // (grader only) and `isActionable` (grader OR author repair). This fixture's
      // gate code is `acceptance_rubric_missing`, which is AUTHOR-owned, so the
      // author can act this second. Rendering it `[BLOCKED]` told the one agent
      // who CAN act that it cannot — which is the defect that ruling removed.
      ['independent-verification', 'due'],
      // P-011: same unconditional-assembly contract as owner-directive above. A
      // session waiting on nothing must report a MEASURED not-applicable; if the
      // family were assembled only when rows exist, "no wait" and "the read never
      // ran" would render identically — and the silent-expire await this class
      // exists to surface is exactly what would vanish into that gap.
      ['waiting-on', 'not-applicable'],
    ]);
    expect(read.agenda.primary[0]?.family).toBe('independent-verification');
    expect(read.degradedSources).toEqual([]);
  });

  it('turns a failed canonical source into explicit unknown instead of false no-demand', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps({
        goalPortfolio: vi.fn(async () => {
          throw new Error('portfolio unavailable');
        }),
      }),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('goal-portfolio failed'));
    warn.mockRestore();
    const placement = read.agenda.evaluations.find((entry) => entry.family === 'plan-placement');
    expect(placement).toMatchObject({
      status: 'unknown',
      measurementFailure: { code: 'canonical-plan-placement-read-failed' },
    });
    expect(read.degradedSources.some((entry) => entry.includes('goal portfolio'))).toBe(true);
  });

  it('P-005 / D-030: a failed fleet-staffing read is an explicit unknown row and a degraded source, never "staffed"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps({
        fleetStaffing: vi.fn(async () => {
          throw new Error('fleet registry unavailable');
        }),
      }),
    });
    warn.mockRestore();
    const staffing = read.agenda.evaluations.filter((entry) => entry.family === 'fleet-staffing');
    expect(staffing).toHaveLength(1);
    expect(staffing[0]).toMatchObject({
      status: 'unknown',
      measurementFailure: { code: 'canonical-fleet-staffing-read-failed' },
    });
    expect(read.degradedSources.some((entry) => entry.includes('fleet staffing'))).toBe(true);
  });

  it('P-005 / D-030: an unheld empty led fleet reaches the agenda as a due fleet-staffing row', async () => {
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps({
        fleetStaffing: vi.fn(async () => [
          {
            fleetSlug: 'fleet-empty',
            evaluation: {
              alert: true,
              current: 0,
              target: 2,
              shortfall: 2,
              held: false,
              notHeldBecause: 'supervise-not-granted' as const,
              topUpRule: null,
              repair: 'fleet:headcount-target { target, supervise:true }',
              reason: '0 of 2 target worker(s) are productive (short 2).',
            },
          },
        ]),
      }),
    });
    const staffing = read.agenda.evaluations.filter((entry) => entry.family === 'fleet-staffing');
    expect(staffing).toHaveLength(1);
    expect(staffing[0]).toMatchObject({ status: 'due' });
    expect(read.degradedSources.some((entry) => entry.includes('fleet staffing'))).toBe(false);
  });

  it('keeps the generation stable when only observation clocks change', async () => {
    // The production portfolio embeds its observation clock in the generated
    // report text as well as assembledAt. Exercise both copies of that clock.
    const withReporting = (assembledAt: string): GoalPortfolioBrief => ({
      ...portfolio(assembledAt),
      reporting: {
        cadence: null,
        draft: buildGoalOwnerReportDraft({
          goalId: 'goal-1', observedAt: assembledAt, previousReportAt: null,
          movements: [], ownerWalls: [], killed: [], artifactReads: [],
          cost: { spentCents: null, budgetCents: null, source: null, coverage: 'unknown', unmeasuredPricedSpend: false },
        }),
        movementTruncated: false,
        killedTruncated: false,
      },
    });
    const first = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps({ goalPortfolio: vi.fn(async () => withReporting(NOW.toISOString())) }),
    });
    const second = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: new Date('2026-09-05T20:01:00.000Z'),
      deps: deps({ goalPortfolio: vi.fn(async () => withReporting('2026-09-05T20:01:00.000Z')) }),
    });
    expect(second.portfolio?.reporting?.draft.text).not.toBe(first.portfolio?.reporting?.draft.text);
    expect(second.agenda.sourceGeneration).toBe(first.agenda.sourceGeneration);
    expect(second.agenda.evaluations.map((entry) => entry.id)).toEqual(first.agenda.evaluations.map((entry) => entry.id));

    // Actual placement authority must still invalidate the same generation.
    const stopped = withReporting('2026-09-05T20:01:00.000Z');
    stopped.goal.status = 'paused';
    const third = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      deps: deps({ goalPortfolio: vi.fn(async () => stopped) }),
    });
    expect(third.agenda.sourceGeneration).not.toBe(first.agenda.sourceGeneration);
    expect(third.agenda.evaluations.find((entry) => entry.ruleId === 'goal-plan-placement')?.status).toBe('not-applicable');
  });

  it.each(['goal', 'plan'] as const)('keeps failed %s scope discovery visibly unknown', async (scope) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const read = await readAgentObligationAgenda({
        workspaceId: 'ws',
        ownerId: 'su-goal',
        now: NOW,
        deps: deps({
          goalSubject: vi.fn(async () => {
            if (scope === 'goal') throw new Error('goal scope unavailable');
            return null;
          }),
          planSlugs: vi.fn(async () => {
            if (scope === 'plan') throw new Error('plan scope unavailable');
            return [];
          }),
        }),
      });

      expect(read.degradedSources.length).toBeGreaterThan(0);
      expect(read.agenda.primary).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'unknown' })]));
      expect(projectAgentTurnStartObligationBrief(read.agenda).projection.text).toContain('UNKNOWN');
      const placement = read.agenda.evaluations.find((row) => row.ruleId === 'goal-plan-placement');
      expect(placement).toMatchObject({
        status: 'unknown',
        measurementFailure: { code: 'canonical-obligation-scope-read-failed' },
      });
      expect(placement?.changeSignal).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the placement event for a known goal when the placement source is unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const read = await readAgentObligationAgenda({
        workspaceId: 'ws',
        ownerId: 'su-goal',
        now: NOW,
        deps: deps({
          goalPortfolio: vi.fn(async () => { throw new Error('portfolio unavailable'); }),
        }),
      });
      const placement = read.agenda.evaluations.find((row) => row.ruleId === 'goal-plan-placement');
      expect(placement).toMatchObject({
        status: 'unknown',
        measurementFailure: { code: 'canonical-plan-placement-read-failed' },
        changeSignal: {
          event: 'goal:plan-placement:goal-1',
          cancellationRef: 'goal:goal-1',
        },
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('projects the same agenda with sink-specific caps and an omission receipt', async () => {
    const { agenda } = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      now: NOW,
      deps: deps(),
    });
    const brief = projectAgentObligationBrief({
      agenda,
      sink: 'turn-start',
      detailRef: 'coord:orient',
      maxEntries: 1,
      maxChars: 400,
      maxEstimatedTokens: 100,
    });
    expect(brief.sourceGeneration).toBe(agenda.sourceGeneration);
    expect(brief.projection.receipt).toMatchObject({ entriesDelivered: 1, entriesOmitted: 1, bodyTruncated: true });
    expect(brief.detailRef).toBe('coord:orient');
  });

  it('gives the GUI the exact turn-start projection plus the portfolio that fed it', async () => {
    const sharedDeps = deps();
    const state = await readAgentGoalModeState({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      goalId: 'goal-1',
      planSlugs: ['plan-a'],
      now: NOW,
      deps: sharedDeps,
    });
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      goalId: 'goal-1',
      planSlugs: ['plan-a'],
      now: NOW,
      deps: deps(),
    });

    expect(state).toMatchObject({
      schemaVersion: 'agent-goal-mode-state-v1',
      status: 'known',
      ownerId: 'su-goal',
      portfolio: { goal: { id: 'goal-1' } },
    });
    expect(state.obligations).toEqual(projectAgentTurnStartObligationBrief(read.agenda));
    expect(state.obligations?.projection.receipt.sink).toBe('turn-start');
    expect(state.obligations?.projection.receipt.entriesOmitted).toBe(0);
    expect(state.obligations?.projection.receipt.entriesDelivered).toBe(read.agenda.primary.length);
    expect(state.obligations!.projection.text.length).toBeLessThanOrEqual(400);
    for (const entry of read.agenda.primary) {
      expect(state.obligations!.projection.text).toContain(entry.action?.summary ?? entry.clearsWhen.summary);
    }
  });

  it('keeps partial source failure visibly degraded with provider-owned unknown rows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = await readAgentGoalModeState({
      workspaceId: 'ws',
      ownerId: 'su-goal',
      goalId: 'goal-1',
      planSlugs: ['plan-a'],
      now: NOW,
      deps: deps({
        goalPortfolio: vi.fn(async () => {
          throw new Error('portfolio unavailable');
        }),
      }),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('goal-portfolio failed'));
    warn.mockRestore();

    expect(state.status).toBe('degraded');
    expect(state.portfolio).toBeNull();
    expect(state.degradedReasons.join(' ')).toContain('goal portfolio');
    expect(state.obligations?.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'plan-placement', status: 'unknown' }),
      ]),
    );
  });

  it('reports missing attribution as unknown without touching canonical providers', async () => {
    const providerDeps = deps();
    const state = await readAgentGoalModeState({
      workspaceId: 'ws',
      ownerId: null,
      goalId: 'goal-1',
      planSlugs: ['plan-a'],
      now: NOW,
      deps: providerDeps,
    });

    expect(state).toMatchObject({
      status: 'unknown',
      ownerId: null,
      obligations: null,
      unknown: { code: 'no-canonical-goal-holder' },
    });
    expect(providerDeps.goalPortfolio).not.toHaveBeenCalled();
    expect(providerDeps.planAcceptance).not.toHaveBeenCalled();
  });
});

describe('P-026 / D-012 item 2: the acceptance obligation covers the delegated worklist', () => {
  function worklistPlan(
    slug: string,
    closure: GoalPortfolioBrief['worklist'][number]['placement']['closure'],
    ordinal = 1,
  ): GoalPortfolioBrief['worklist'][number] {
    return {
      ref: `plan:papercusp/${slug}`,
      ordinal,
      harness: 'papercusp',
      slug,
      title: slug,
      status: 'awaiting-acceptance',
      next: null,
      counts: { todo: 0, wip: 0, blocked: 0, needsHuman: 0, done: 3 },
      ambiguousMatches: 0,
      placement: {
        state: closure?.state === 'closed' ? 'terminal' : 'awaiting-closure',
        activeLane: null,
        fleet: null,
        launchTransaction: null,
        reconciliation: { consistent: true, action: 'none', reason: 'none', toolCall: null },
        closure,
      },
    };
  }

  function closure(
    state: 'closed' | 'open' | 'partial' | 'unknown',
  ): NonNullable<GoalPortfolioBrief['worklist'][number]['placement']['closure']> {
    return {
      state,
      evidenceSatisfied: state === 'closed',
      reportOutstandingOnly: false,
      reason: `closure is ${state}`,
    };
  }

  function withWorklist(entries: GoalPortfolioBrief['worklist']): GoalPortfolioBrief {
    const brief = portfolio();
    brief.worklist = entries;
    return brief;
  }

  async function read(brief: GoalPortfolioBrief, overrides: Partial<AgentObligationReaderDeps> = {}) {
    return readAgentObligationAgenda({
      workspaceId: 'ws',
      ownerId: 'su-holder',
      now: NOW,
      deps: deps({ goalPortfolio: vi.fn(async () => brief), ...overrides }),
    });
  }

  it('measures launch feasibility for the selected plan fleet after skipping a blocked predecessor', async () => {
    const blocked = worklistPlan('blocked-plan', null);
    blocked.placement.state = 'blocked';
    blocked.placement.reconciliation = {
      consistent: false, action: 'resolve-plan-blockers', reason: 'dependency is unresolved', toolCall: null,
    };
    const ready = worklistPlan('ready-plan', null);
    ready.placement.state = 'unplaced';
    ready.placement.reconciliation = {
      consistent: false, action: 'launch-plan-fleet', reason: 'ready to place',
      toolCall: { tool: 'fleet:launch-on-plan', args: {
        name: 'Ready Plan Fleet', plan: 'ready-plan', harness: 'papercusp', leader: 'spawn', headless: true,
      } },
    };
    const goalLaunch = vi.fn(async ({ fleetSlug }: { fleetSlug: string | null }) => ({
      ...launch(),
      refusal: fleetSlug === 'ready-plan-fleet' ? {
        reason: 'fleet_max_agents' as const, current: 1, currentScope: 'live-agents-in-fleet',
        limit: 1, requested: 1,
        message: 'selected fleet is full',
      } : null,
    }));
    const result = await read(withWorklist([blocked, ready]), { goalLaunch });
    expect(goalLaunch).toHaveBeenCalledWith({
      workspaceId: 'ws', ownerId: 'su-holder', fleetSlug: 'ready-plan-fleet', count: 1,
    });
    expect(result.agenda.evaluations.find((row) => row.family === 'plan-placement')).toMatchObject({
      scope: { planSlug: 'ready-plan' }, status: 'blocked',
      action: { kind: 'repair' },
    });
  });

  it('chooses a later admitted plan when the earlier independent launch has promotion lag', async () => {
    const makeReadyPlan = (slug: string): GoalPortfolioBrief['worklist'][number] => {
      const entry = worklistPlan(slug, null);
      entry.placement.state = 'unplaced';
      entry.placement.reconciliation = {
        consistent: false, action: 'launch-plan-fleet', reason: 'ready to place',
        toolCall: { tool: 'fleet:launch-on-plan', args: {
          name: `${slug}-fleet`, plan: slug, harness: 'papercusp', leader: 'spawn', headless: true,
        } },
      };
      return entry;
    };
    const first = makeReadyPlan('promotion-lagged');
    const second = makeReadyPlan('admitted');
    const planAdmission = vi.fn(async ({ planSlug }: { planSlug: string }) => ({
      ready: planSlug === 'admitted', status: planSlug === 'admitted' ? 'ready' : 'blocked',
      reason: planSlug === 'admitted' ? 'ready' : 'promotion-lag',
      message: planSlug === 'admitted' ? 'ready' : 'promoted rows are missing',
      requestedSeats: 1, executableWidth: planSlug === 'admitted' ? 1 : 0,
    } as ExactPlanAdmission));
    const goalLaunch = vi.fn(async () => launch());
    const result = await read(withWorklist([first, second]), { planAdmission, goalLaunch });
    expect(planAdmission).toHaveBeenCalledTimes(2);
    expect(goalLaunch).toHaveBeenCalledWith({
      workspaceId: 'ws', ownerId: 'su-holder', fleetSlug: 'admitted-fleet', count: 1,
    });
    expect(result.agenda.evaluations.find((row) => row.family === 'plan-placement')).toMatchObject({
      scope: { planSlug: 'admitted' }, status: 'due',
      action: { kind: 'delegate', args: { plan: 'admitted' } },
    });
  });

  it('threads the scoped durable clock through the real agenda reader without replacing it with read time', async () => {
    const plan = worklistPlan('clocked-plan', closure('open'));
    const at = '2026-09-05T19:55:00.000Z';
    const previous = advanceGoalPlacementProgress({
      scopeKey: goalPlacementProgressScopeKey({ workspaceId: 'ws', ownerId: 'su-holder', goalId: 'goal-1', planRef: plan.ref }),
      previous: null, now: at, effect: { kind: 'member-claim', ref: 'member-effect', at },
    }).state;
    const goalPlacementProgress = vi.fn(async () => ({ [plan.ref]: previous }));
    const result = await read(withWorklist([plan]), { goalPlacementProgress });
    expect(goalPlacementProgress).toHaveBeenCalledWith('ws', 'su-holder', 'goal-1', [plan.ref]);
    expect(result.agenda.evaluations.find((row) => row.family === 'plan-placement')?.ageMs).toBe(300_000);
    expect(previous.lastEffect?.at).toBe(at);
  });

  it('raises an acceptance obligation for a plan the holder delegated and never declared on', async () => {
    const result = await read(withWorklist([worklistPlan('delegated-plan', closure('open'))]));

    // The holder declared itself on plan-a only; before D-012 item 2 the
    // delegated plan carried no acceptance obligation at all.
    expect(result.planSlugs).toEqual(['plan-a', 'delegated-plan']);
    expect(result.agenda.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'independent-verification',
          scope: expect.objectContaining({ planSlug: 'delegated-plan' }),
        }),
      ]),
    );
  });

  it('drops a worklist plan whose closure is already closed', async () => {
    const result = await read(
      withWorklist([worklistPlan('closed-plan', closure('closed')), worklistPlan('open-plan', closure('open'), 2)]),
    );

    expect(result.planSlugs).toEqual(['plan-a', 'open-plan']);
  });

  it('does not request acceptance repair for a superseded worklist plan', async () => {
    const abandoned = worklistPlan('superseded-plan', closure('open'));
    abandoned.status = 'superseded';
    const planAcceptance = vi.fn(async () => ({
      satisfied: false,
      code: 'acceptance_bar_contract_not_ready' as const,
      message: 'bar_snapshot_rubric_unresolved',
    }));
    const result = await read(
      withWorklist([abandoned, worklistPlan('active-plan', closure('open'), 2)]),
      { planAcceptance },
    );

    expect(result.planSlugs).toEqual(['plan-a', 'active-plan']);
    expect(planAcceptance).not.toHaveBeenCalledWith('ws', 'superseded-plan');
    expect(result.agenda.evaluations.some(row => row.scope.planSlug === 'superseded-plan')).toBe(false);
    expect(result.agenda.primary).toContainEqual(expect.objectContaining({
      family: 'independent-verification',
      scope: expect.objectContaining({ planSlug: 'active-plan' }),
      status: 'due',
      action: expect.objectContaining({ kind: 'repair' }),
    }));
  });

  it.each(['open', 'partial', 'unknown'] as const)(
    'keeps a worklist plan whose closure is %s in scope',
    async (state) => {
      const result = await read(withWorklist([worklistPlan('p', closure(state))]));
      expect(result.planSlugs).toContain('p');
    },
  );

  it('keeps an in-flight plan (closure null) in scope — null is never a reading of closed', async () => {
    const result = await read(withWorklist([worklistPlan('in-flight', null)]));
    expect(result.planSlugs).toContain('in-flight');
  });

  it('does not re-add the plan the holder already declared on', async () => {
    const result = await read(withWorklist([worklistPlan('plan-a', closure('open'))]));

    expect(result.planSlugs).toEqual(['plan-a']);
  });

  it('spends the existing cost bound on plans awaiting closure before plans still in flight', async () => {
    // Ten candidates for seven remaining slots (plan-a takes the first), with
    // the in-flight plans deliberately placed FIRST in worklist order: if the
    // cap were spent in raw order the awaiting-closure plans — P-026's whole
    // population — would be the ones dropped.
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => worklistPlan(`in-flight-${i}`, null, i + 1)),
      ...Array.from({ length: 5 }, (_, i) => worklistPlan(`awaiting-${i}`, closure('open'), i + 6)),
    ];

    const result = await read(withWorklist(entries));

    expect(result.planSlugs).toHaveLength(PLAN_CONTEXT_MAX);
    expect(result.planSlugs.slice(0, 6)).toEqual([
      'plan-a',
      'awaiting-0',
      'awaiting-1',
      'awaiting-2',
      'awaiting-3',
      'awaiting-4',
    ]);
    expect(result.planSlugs).not.toContain('in-flight-2');
  });

  it('reads the worklist acceptance gates WITHOUT delaying independent canonical reads', async () => {
    // The worklist slugs are only knowable after the portfolio resolves, so the
    // reader chains off that promise instead of awaiting it. A refactor that
    // "simplifies" this into `await portfolioPromise` before building the rest
    // of the wave serialises independent reads behind the portfolio. Launch
    // feasibility deliberately waits for the selected action and its fleet.
    let releasePortfolio: () => void = () => {};
    const portfolioGate = new Promise<void>((resolve) => {
      releasePortfolio = resolve;
    });
    const started: string[] = [];
    const brief = withWorklist([worklistPlan('delegated-plan', closure('open'))]);

    const pending = read(brief, {
      goalPortfolio: vi.fn(async () => {
        started.push('portfolio');
        await portfolioGate;
        return brief;
      }),
      goalLaunch: vi.fn(async () => {
        started.push('launch');
        return launch();
      }),
      planFleet: vi.fn(async (): Promise<GoalPlanFleetObservation> => {
        started.push('fleet');
        return { status: 'known', alert: null, applicablePlanCount: 0 };
      }),
      waitingOn: vi.fn(async () => {
        started.push('waiting-on');
        return [];
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(expect.arrayContaining(['portfolio', 'fleet', 'waiting-on']));
    expect(started).not.toContain('launch');

    releasePortfolio();
    const result = await pending;
    expect(result.planSlugs).toContain('delegated-plan');
  });
});

describe('default goalPortfolio dep reads only what the agenda consumes (EI-25306440159635835)', () => {
  afterEach(() => {
    vi.doUnmock('./goal-launch-settings');
  });

  it('skips the claim-floor count and rubric stewardship, the two sections that each blew the 900ms budget', async () => {
    const readGoalPortfolioBrief = vi.fn(async () => null);
    vi.doMock('./goal-launch-settings', () => ({ readGoalPortfolioBrief }));

    await defaultAgentObligationReaderDeps().goalPortfolio('ws', 'goal-a');

    expect(readGoalPortfolioBrief).toHaveBeenCalledTimes(1);
    expect(readGoalPortfolioBrief).toHaveBeenCalledWith({
      workspaceId: 'ws', goalId: 'goal-a', claimability: 'skip', rubricStewardship: 'skip',
    });
    expect(AGENT_OBLIGATION_PORTFOLIO_PROJECTION).toEqual({ claimability: 'skip', rubricStewardship: 'skip' });
  });
});

describe('default goalSubject dep stage timings', () => {
  afterEach(() => {
    vi.doUnmock('./modes/store');
    vi.doUnmock('./modes/goal-session');
  });

  it('measures mode imports and the getModes read when a stage runner is supplied', async () => {
    const getModes = vi.fn(async () => [{ mode: 'auto', subject: null }]);
    const goalIdFromModes = vi.fn(() => 'goal-1');
    vi.doMock('./modes/store', () => ({ getModes }));
    vi.doMock('./modes/goal-session', () => ({ goalIdFromModes }));
    const stages: string[] = [];
    const runStage = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      stages.push(`${name}:active`);
      const value = await work();
      stages.push(`${name}:completed`);
      return value;
    };

    await expect(defaultAgentObligationReaderDeps().goalSubject('ws', 'owner', runStage)).resolves.toBe('goal-1');
    expect(getModes).toHaveBeenCalledExactlyOnceWith('ws', 'owner');
    expect(stages).toEqual(expect.arrayContaining([
      'goal-subject-mode-store-import:active', 'goal-subject-mode-store-import:completed',
      'goal-subject-goal-session-import:active', 'goal-subject-goal-session-import:completed',
      'goal-subject-get-modes:active', 'goal-subject-get-modes:completed',
    ]));
  });
});

describe('default planAcceptance dep serves the persisted gate verdict (D-039, WI-10004673)', () => {
  afterEach(() => {
    vi.doUnmock('./goals/plan-closure-observations');
    vi.doUnmock('./plan-acceptance-gate');
  });

  // The inline gate cost 1.0–1.8s of main-thread CPU per agenda read on bg-host. The
  // gate spy is the regression guard: no outcome of this dep may run it.
  function mockObservation(observation: PlanClosureObservationRead | undefined) {
    const evaluatePlanAcceptanceGate = vi.fn();
    const refreshPlanClosureObservations = vi.fn(() => []);
    const readPlanClosureObservations = vi.fn(async () =>
      new Map(observation ? [[observation.planSlug, observation]] : []));
    vi.doMock('./plan-acceptance-gate', () => ({ evaluatePlanAcceptanceGate }));
    vi.doMock('./goals/plan-closure-observations', () => ({ readPlanClosureObservations, refreshPlanClosureObservations }));
    return { evaluatePlanAcceptanceGate, refreshPlanClosureObservations, readPlanClosureObservations };
  }

  it('returns a fresh observation, rubric and grader included, without running the gate', async () => {
    const gate = { satisfied: true, code: undefined, rubricId: 'acceptance-plan-a', gradedBy: 'su-grader' };
    const spies = mockObservation({ planSlug: 'plan-a', status: 'fresh', gate, observedAt: NOW.toISOString() });

    await expect(defaultAgentObligationReaderDeps().planAcceptance('ws', 'plan-a')).resolves.toEqual(gate);
    expect(spies.readPlanClosureObservations).toHaveBeenCalledWith({ workspaceId: 'ws', planSlugs: ['plan-a'] });
    expect(spies.refreshPlanClosureObservations).not.toHaveBeenCalled();
    expect(spies.evaluatePlanAcceptanceGate).not.toHaveBeenCalled();
  });

  it.each(['fresh', 'stale', 'absent'] as const)(
    'keeps a declared superseded plan out of the actionable agenda with a %s gate observation',
    async (status) => {
      const spies = mockObservation(status === 'fresh'
        ? { planSlug: 'plan-a', planStatus: 'superseded', status,
            gate: { satisfied: false, code: 'acceptance_bar_contract_not_ready' }, observedAt: NOW.toISOString() }
        : { planSlug: 'plan-a', planStatus: 'superseded', status, detail: 'old verdict is unavailable' });
      const result = await readAgentObligationAgenda({
        workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
        deps: deps({ planAcceptance: defaultAgentObligationReaderDeps().planAcceptance }),
      });

      const obligation = result.agenda.evaluations.find(row => row.family === 'independent-verification')!;
      expect(obligation).toMatchObject({ status: 'not-applicable', applicableDemand: 0 });
      expect(obligation.reason).toContain('superseded');
      expect(obligation.action).toBeUndefined();
      expect(result.agenda.primary.some(row => row.family === 'independent-verification')).toBe(false);
      expect(result.degradedSources).toEqual([]);
      expect(spies.refreshPlanClosureObservations).not.toHaveBeenCalled();
      expect(spies.evaluatePlanAcceptanceGate).not.toHaveBeenCalled();
    },
  );

  it('does not suppress author repair for an active plan with the same contract refusal', async () => {
    const spies = mockObservation({ planSlug: 'plan-a', planStatus: 'active', status: 'fresh',
      gate: { satisfied: false, code: 'acceptance_bar_contract_not_ready' }, observedAt: NOW.toISOString() });
    const result = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      deps: deps({ planAcceptance: defaultAgentObligationReaderDeps().planAcceptance }),
    });
    expect(result.agenda.primary).toContainEqual(expect.objectContaining({
      family: 'independent-verification', status: 'due', action: expect.objectContaining({ kind: 'repair' }),
    }));
    expect(spies.refreshPlanClosureObservations).not.toHaveBeenCalled();
  });

  it.each(['stale', 'absent'] as const)('rejects a %s observation and refreshes it in the background', async (status) => {
    const spies = mockObservation({ planSlug: 'plan-a', status, detail: `observation is ${status}` });

    await expect(defaultAgentObligationReaderDeps().planAcceptance('ws', 'plan-a')).rejects.toThrow(`observation is ${status}`);
    expect(spies.refreshPlanClosureObservations).toHaveBeenCalledWith(['plan-a']);
    expect(spies.evaluatePlanAcceptanceGate).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous slug without a refresh, which could not disambiguate it either', async () => {
    const spies = mockObservation({ planSlug: 'plan-a', status: 'ambiguous', detail: 'resolves in 2 harnesses' });

    await expect(defaultAgentObligationReaderDeps().planAcceptance('ws', 'plan-a')).rejects.toThrow('resolves in 2 harnesses');
    expect(spies.refreshPlanClosureObservations).not.toHaveBeenCalled();
    expect(spies.evaluatePlanAcceptanceGate).not.toHaveBeenCalled();
  });

  it('keeps the provider episode and grader evidence when the verdict comes from an observation', async () => {
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      deps: deps({
        planAcceptance: vi.fn(async () => ({ satisfied: true, rubricId: 'acceptance-plan-a', gradedBy: 'su-grader' })),
      }),
    });

    const obligation = read.agenda.evaluations.find((row) => row.family === 'independent-verification')!;
    expect(obligation.status).toBe('satisfied');
    expect(obligation.episode).toBe(`accepted:acceptance-plan-a:${obligation.sourceGeneration}`);
    expect(obligation.evidence[0]?.note).toBe('graded by su-grader');
  });

  it('reads a rejected observation as an explicit unknown, never as satisfied or absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', now: NOW,
      deps: deps({ planAcceptance: vi.fn(async () => { throw new Error("no acceptance-gate verdict has been recorded for 'plan-a' yet"); }) }),
    });
    warn.mockRestore();

    const obligation = read.agenda.evaluations.find((row) => row.family === 'independent-verification')!;
    expect(obligation.status).toBe('unknown');
    expect(obligation.reason).toContain("no acceptance-gate verdict has been recorded for 'plan-a' yet");
  });
});

describe('consultation reporting retirement', () => {
  it('does not query consult follow-through or put reporting obligations on the agenda', async () => {
    const readDeps = deps({});
    const legacyRead = vi.fn(async () => [{ consultId: 'old-consult', phase: 'answered' }]);
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-me', now: NOW,
      deps: Object.assign(readDeps, { consultReconciliations: legacyRead }),
    });
    expect(legacyRead).not.toHaveBeenCalled();
    expect(read.agenda.evaluations.map(row => row.family)).not.toContain('consult-reconciliation');
    expect(read.degradedSources.some(source => source.includes('consult reconciliation'))).toBe(false);
  });
});

describe('bounded obligation source reads', () => {
  it('keeps plan placement and owner-directive failures explicit when controlled reads exceed their deadline', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 80));
    const read = await readAgentObligationAgenda({
      workspaceId: 'ws', ownerId: 'su-goal', goalId: 'goal-1', now: NOW, sourceTimeoutMs: 20,
      deps: deps({
        planSlugs: vi.fn(async () => { await delay(); return ['plan-a']; }),
        ownerDirectives: vi.fn(async () => { await delay(); return []; }),
      }),
    });

    const placement = read.agenda.evaluations.find(row => row.ruleId === 'goal-plan-placement');
    const directives = read.agenda.evaluations.find(row => row.ruleId === 'owner-directive-disposition');
    expect(placement).toMatchObject({ status: 'unknown' });
    expect(placement?.measurementFailure?.detail).toContain('plan context');
    expect(directives).toMatchObject({ status: 'unknown' });
    expect(directives?.measurementFailure?.detail).toContain('owner directives');
    expect(read.degradedSources).toEqual(expect.arrayContaining([
      expect.stringContaining('plan context'),
      expect.stringContaining('owner directives'),
    ]));
  });
});
