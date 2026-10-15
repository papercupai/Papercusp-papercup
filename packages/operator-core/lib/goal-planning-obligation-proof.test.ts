/** Independent P002 intent oracles; optional subject is a copy-out mutant, never an in-tree edit. */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { compileGoalPlanPlacement, type GoalLaunchRefusal, type GoalPortfolioBrief } from './goal-launch-settings';
import type { ExactPlanAdmission } from './agent-tools/plans/plan-admission-preflight';
import { goalPlanningPortfolioFingerprint, type GoalPlanningReview } from './goal-planning-review';
import type { GoalPlanningProviderInput } from './agent-obligation-providers';

const subject: typeof import('./agent-obligation-providers') = process.env.PAPERCUSP_GOAL_OBLIGATION_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_GOAL_OBLIGATION_PROBE).href)
  : await import('./agent-obligation-providers');
const NOW = '2026-09-23T10:00:00.000Z';
const base = { workspaceId: 'fixture', ownerId: 'su-goal', goalId: 'goal-local', observedAt: NOW, sourceGeneration: 'measured-input' };

function portfolio(populated = false, ready = true): GoalPortfolioBrief {
  const placement = compileGoalPlanPlacement({ plan: { harness: 'fixture', slug: 'existing', ambiguousMatches: 1 },
    status: ready ? 'ready' : 'draft', itemStatuses: ['todo'], actionableItemId: 'P-001', source: {}, now: new Date(NOW) });
  return {
    schemaVersion: 1, assembledAt: NOW,
    goal: { id: base.goalId, title: 'Goal', body: 'Recover checkout', status: 'active', standing: true, parentId: null, killCriterion: null },
    worklist: populated ? [{ ref: 'plan:fixture/existing', ordinal: 1, harness: 'fixture', slug: 'existing', title: 'Existing',
      status: ready ? 'ready' : 'draft', next: { id: 'P-001', text: 'Implement recovery', phase: 'Build', blockedBy: [] },
      counts: { todo: 1, wip: 0, blocked: 0, needsHuman: 0, done: 0 }, ambiguousMatches: 1, placement }] : [],
    pots: [], drainFleet: { slug: null, exists: false, controlState: null, leaderOwnerId: null, live: 0, working: 0 },
    queue: { total: 0, terminal: 0, inFlight: 0, blocked: 0, needsHuman: 0, claimable: 0, claimabilityScope: 'none' },
    launch: { settings: null, ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 0, fleet: null } },
    budget: { budgetCents: null, spentCents: null, unmeasuredPricedSpend: false, spentCentsAt: null,
      spentCentsSource: null, interactiveUsageFreshnessStatus: null,
      interactiveUsageLastIngestedAtMs: null, budgetWindowSec: null },
    tripwires: [], pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null }, priorities: [], degradedReasons: [],
  };
}

function input(p = portfolio(), disposition: GoalPlanningReview['disposition'] = 'plan-needed'): GoalPlanningProviderInput {
  return { ...base, read: { status: 'known', value: {
    portfolio: p, reviewIntervalMs: 3_600_000,
    review: { schemaVersion: 1, goalId: base.goalId, disposition, rationale: 'Review of the named fixture outcome.',
      evidenceRefs: ['goal:goal-local'], planRefs: ['plan:fixture/existing'],
      ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Recover checkout' } : {}),
      ...(disposition === 'existing-plans-sufficient' || disposition === 'no-eligible-work'
        ? { coverage: [{ need: 'checkout recovery', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'plan:fixture/existing' }] } : {}),
      portfolioFingerprint: goalPlanningPortfolioFingerprint(p), reviewedAt: NOW },
    authorities: { fixture: { allowed: true, reason: 'caller-goal-owns-pot', ownerGoalId: base.goalId, ownerGoalTitle: 'Goal' } },
  } } };
}
function known(i: GoalPlanningProviderInput) {
  if (i.read.status !== 'known') throw new Error('Expected known fixture');
  return i.read.value;
}

describe('P002 goal planning behavioral falsifiers', () => {
  it.each([false, true])('requires planning for an uncovered outcome with populated=%s', (populated) => {
    const row = subject.goalPlanningObligation(input(portfolio(populated)));
    expect(row).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'continue' } });
    expect(row.reason).toContain('Recover checkout');
  });
  it('does not manufacture new-plan demand after a supported sufficient review', () => {
    expect(subject.goalPlanningObligation(input(portfolio(true), 'existing-plans-sufficient'))).toMatchObject({ status: 'satisfied', applicableDemand: 0 });
  });
  it('reviews the standing frontier after terminal work instead of declaring the goal finished', () => {
    const p = portfolio(true);
    // Controlled terminal-placement input; this is not a claim of plan-closure integration.
    p.worklist[0]!.placement.state = 'terminal';
    const i = input(p); known(i).review = null;
    const row = subject.goalPlanningObligation(i);
    expect(row.status).toBe('due');
    expect(row.action?.summary).toContain('standing goal frontier');
  });
  it.each(['caller-goal-owns-pot', 'no-active-owner'] as const)('permits guarded reuse when authority is %s', (reason) => {
    const i = input(portfolio(), 'adopt-plan');
    known(i).authorities.fixture = { allowed: true, reason, ownerGoalId: reason === 'no-active-owner' ? null : base.goalId, ownerGoalTitle: null };
    const row = subject.goalPlanningObligation(i);
    expect(row).toMatchObject({ status: 'due', action: { kind: 'continue', targetRef: 'plan:fixture/existing' } });
    expect(row.action?.summary).toMatch(/not a clone.*ownership, CAS, budget and admission/);
  });
  it('never instructs local adoption when another active goal owns the candidate', () => {
    const i = input(portfolio(), 'adopt-plan');
    known(i).authorities.fixture = { allowed: false, reason: 'different-active-goal-owns-pot', ownerGoalId: 'foreign', ownerGoalTitle: 'Other' };
    const row = subject.goalPlanningObligation(i);
    expect(row).toMatchObject({ status: 'due', action: { kind: 'report' } });
    expect(row.reason).toContain('foreign');
    expect(row.action?.summary).toContain('do not adopt or duplicate');
  });
  // AUTO-BAR-R-8 rev 4: "original proposal/plan/goal links ... are lost".
  it('links.preserved: adoption keeps the goal scope and targets the original canonical plan ref, never a new one', () => {
    const i = input(portfolio(), 'adopt-plan');
    const row = subject.goalPlanningObligation(i);
    expect(row.scope).toMatchObject({ ownerId: base.ownerId, goalId: base.goalId });
    expect(row.action?.targetRef).toBe('plan:fixture/existing');
    expect(known(i).review!.planRefs).toContain(row.action?.targetRef);
  });
  it.each([true, false])('keeps existing plan work ahead of new planning, executable=%s', (ready) => {
    const p = portfolio(true, ready);
    const agenda = subject.buildAgentObligationAgenda({ goalPlanning: input(p), planPlacement: {
      ...base, read: { status: 'known', value: { portfolio: p, evidenceRef: 'fixture:placement', alert: null,
        launch: { goalId: base.goalId, settings: null, goalBrief: null, effective: {}, ceilings: p.launch.ceilings,
          headcount: p.launch.headcount, budget: null, refusal: null, degraded: false, degradedReasons: [] } } },
    } }, NOW);
    expect(agenda.primary[0]).toMatchObject({ family: 'plan-placement', status: ready ? 'due' : 'blocked' });
    expect(agenda.primary[0]?.action?.tool).toBe(ready ? 'fleet:launch-on-plan' : undefined);
    expect(agenda.primary.findIndex((r) => r.family === 'planning-needed')).toBeGreaterThan(0);
  });

  // AUTO-BAR-R-9 rev 4: "changed planning inputs or an expired review interval incorrectly leave
  // the review obligation satisfied" / "observation-clock-only changes must not manufacture a new
  // review need" / "unsupported review assertions receive credit".
  it('review.interval-expired: a supported sufficient review older than the interval is due again', () => {
    const i = input(portfolio(true), 'existing-plans-sufficient');
    known(i).review!.reviewedAt = new Date(Date.parse(NOW) - 3_600_000).toISOString();
    expect(subject.goalPlanningObligation(i)).toMatchObject({ status: 'due', title: 'Review uncovered goal needs' });
  });
  it('review.inputs-changed: a changed goal outcome invalidates the prior sufficient review', () => {
    const p = portfolio(true);
    const i = input(p, 'existing-plans-sufficient');
    known(i).portfolio = { ...p, goal: { ...p.goal, body: 'Recover checkout and refunds' } };
    expect(subject.goalPlanningObligation(i)).toMatchObject({ status: 'due', title: 'Review uncovered goal needs' });
  });
  it('review.clock-only: a later observation within the interval does not manufacture a review need', () => {
    const p = portfolio(true);
    const i = input(p, 'existing-plans-sufficient');
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    known(i).portfolio = { ...p, assembledAt: later };
    expect(subject.goalPlanningObligation({ ...i, observedAt: later })).toMatchObject({ status: 'satisfied', applicableDemand: 0 });
  });
  it('review.future-dated: a review stamped after the observation earns no credit', () => {
    const i = input(portfolio(true), 'existing-plans-sufficient');
    known(i).review!.reviewedAt = new Date(Date.parse(NOW) + 60_000).toISOString();
    expect(subject.goalPlanningObligation(i).status).toBe('due');
  });
  it('source.unreadable: an unreadable planning source is unknown, never no demand', () => {
    const failure = { code: 'fixture-read-failed', detail: 'fixture read failed', retry: 'retry the read' };
    const row = subject.goalPlanningObligation({ ...base, read: { status: 'unknown', failure } } as GoalPlanningProviderInput);
    expect(row).toMatchObject({ status: 'unknown', applicableDemand: 0 });
    expect(row.status).not.toBe('satisfied');
  });
});

/**
 * P005 AUTO-BAR-R-5 falsifiers (scenario ids in the test names). Independent
 * oracles over the same env-overridable subject, so a copy-out mutant of the
 * provider's refusal mapping is measurable without touching the shared tree.
 */
describe('P005 refusal-to-action falsifiers', () => {
  function placementRead(p: GoalPortfolioBrief, extra: { refusal?: GoalLaunchRefusal | null;
    admissions?: Record<string, ExactPlanAdmission | null> }) {
    return { ...base, read: { status: 'known' as const, value: { portfolio: p, evidenceRef: 'fixture:placement', alert: null,
      ...(extra.admissions ? { admissions: extra.admissions } : {}),
      launch: { goalId: base.goalId, settings: null, goalBrief: null, effective: {}, ceilings: p.launch.ceilings,
        headcount: p.launch.headcount, budget: null, refusal: extra.refusal ?? null, degraded: false, degradedReasons: [] } } } };
  }
  const refusal = (reason: GoalLaunchRefusal['reason']): GoalLaunchRefusal => ({ reason,
    current: reason === 'goal_budget_unmeasurable' ? null : 10, limit: 10, requested: 1,
    currentScope: 'fixture:typed-refusal', message: `Refused: ${reason}` });
  // Headcount remedies must never answer an unmeasured spend. A ceiling may be
  // named only inside the explicit prohibition ("do not ... raise a ceiling").
  const HEADCOUNT_REMEDY = /headcount|free (?:an )?agent|reallocate|within the declared/i;

  it('budget.unmeasured: unknown spend asks for measurement repair, never headcount or ceiling relief', () => {
    const row = subject.planPlacementObligation(placementRead(portfolio(true), { refusal: refusal('goal_budget_unmeasurable') }));
    expect(row).toMatchObject({ status: 'blocked', action: { kind: 'repair', targetRef: `goal:${base.goalId}` } });
    expect(row.action?.tool).toBeUndefined();
    expect(row.title).toMatch(/budget measurement/i);
    expect(row.action?.summary).toMatch(/repair the authoritative goal spend measurement/i);
    expect(row.action?.summary).toMatch(/unknown spend is not available headroom/i);
    expect(`${row.title} ${row.action?.summary}`).not.toMatch(HEADCOUNT_REMEDY);
    expect(row.action?.summary).toMatch(/do not [^;]*raise a ceiling/i);
  });
  it('budget.exceeded: a measured overrun asks for owner budget direction and does not raise the cap', () => {
    const row = subject.planPlacementObligation(placementRead(portfolio(true), { refusal: refusal('goal_budget_exceeded') }));
    expect(row).toMatchObject({ status: 'blocked', action: { kind: 'repair' } });
    expect(row.action?.tool).toBeUndefined();
    expect(row.action?.summary).toMatch(/owner budget direction/i);
    expect(row.action?.summary).toMatch(/do not increase the cap autonomously/i);
    expect(row.title).not.toMatch(/headcount/i);
  });
  it.each(['goal_max_agents', 'fleet_max_agents'] as const)('capacity.full: %s reallocates within the ceiling without a duplicate launch', (reason) => {
    const row = subject.planPlacementObligation(placementRead(portfolio(true), { refusal: refusal(reason) }));
    expect(row).toMatchObject({ status: 'blocked', action: { kind: 'repair' } });
    expect(row.action?.tool).toBeUndefined();
    expect(row.title).toMatch(reason === 'goal_max_agents' ? /goal headcount/i : /fleet headcount/i);
    expect(row.action?.summary).toMatch(/do not duplicate a launch or raise the ceiling/i);
    expect(`${row.title} ${row.action?.summary}`).not.toMatch(/budget|spend/i);
  });
  it.each(['floor-gated', 'insufficient-executable-width', 'promotion-lag'] as const)(
    'admission.blocked: exact-plan %s is repaired before any launch is offered', (reason) => {
      const p = portfolio(true);
      const admission = { ready: false, status: 'blocked', reason, message: `measured ${reason}`, plan: 'existing',
        requestedSeats: 1, executableWidth: 0 } as unknown as ExactPlanAdmission;
      const row = subject.planPlacementObligation(placementRead(p, { admissions: { [p.worklist[0]!.ref]: admission } }));
      expect(row).toMatchObject({ status: 'blocked', action: { kind: 'repair', targetRef: p.worklist[0]!.ref } });
      expect(row.action?.tool).toBeUndefined();
      expect(row.reason).toContain(reason);
    });
});
