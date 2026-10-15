/** P003: placement is a scoped member claim, never just a launch/leader/WIP receipt. */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';

const subject: typeof import('./goal-launch-settings') = process.env.PAPERCUSP_PLAN_PLACEMENT_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_PLAN_PLACEMENT_PROBE).href)
  : await import('./goal-launch-settings');
const NOW = new Date('2026-09-23T11:00:00.000Z');
const lane = { itemId: 'P-001', ownerId: 'su-worker', fleetSlug: 'alpha-fleet', holderLive: true,
  expiresAt: '2026-09-23T11:05:00.000Z', workItemId: 'WI-fixture' };
const fleet = { slug: 'alpha-fleet', controlState: 'active', leaderOwnerId: 'su-leader', leaderLive: true,
  liveMembers: 2, target: 2, claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'alpha' } } },
  launchTransaction: { transactionId: 'tx-existing', state: 'verified' } };
const claimScenarios = ['expired-lease', 'leader-only', 'member-claim-and-lease', 'wrong-member-or-filter'] as const;
type ClaimScenario = typeof claimScenarios[number];
const claimControl = process.env.PAPERCUSP_PLACEMENT_CLAIM_CONTROL;
if (claimControl && !claimScenarios.includes(claimControl as ClaimScenario)) {
  throw new Error(`Unknown permanent placement claim control: ${claimControl}`);
}
function compile(source: Record<string, unknown> = {}, faultyControl = claimControl) {
  const observed = { claims: [lane], fleet, goalHolderOwnerIds: ['su-goal'], ...source };
  // Reuse the lifecycle control protocol below: one faulty claim adapter per
  // acceptance scenario, selected only in an intentional counterexample run.
  // Literal assertions remain unchanged and the unresolved-plan calibration
  // calls the production compiler directly, independently of this adapter.
  if (faultyControl === 'member-claim-and-lease') observed.claims = [];
  if (faultyControl === 'leader-only') {
    observed.claims = observed.claims.map((claim) => claim.ownerId === fleet.leaderOwnerId
      ? { ...claim, ownerId: lane.ownerId } : claim);
  }
  if (faultyControl === 'wrong-member-or-filter') {
    observed.claims = observed.claims.map((claim) => ({ ...claim, fleetSlug: fleet.slug }));
  }
  if (faultyControl === 'expired-lease') {
    observed.claims = observed.claims.map((claim) => ({ ...claim, expiresAt: lane.expiresAt }));
  }
  return subject.compileGoalPlanPlacement({ plan: { harness: 'fixture', slug: 'alpha', ambiguousMatches: 1 },
    status: 'started', itemStatuses: ['wip'], actionableItemId: 'P-001', now: NOW,
    source: observed });
}

const lifecycleScenarios = [
  'draft-refusal', 'dependency-blocker', 'eligible-control',
  'shipped-without-closure', 'satisfied-closure',
] as const;
type LifecycleScenario = typeof lifecycleScenarios[number];
const lifecycleControl = process.env.PAPERCUSP_PLACEMENT_LIFECYCLE_CONTROL;
if (lifecycleControl && !lifecycleScenarios.includes(lifecycleControl as LifecycleScenario)) {
  throw new Error(`Unknown permanent placement lifecycle control: ${lifecycleControl}`);
}
const satisfiedClosure = {
  state: 'closed' as const, evidenceSatisfied: true, reason: 'acceptance satisfied',
  legs: { terminalEvidence: 'pass' as const, verificationReadBack: 'pass' as const,
    independentRegrade: 'pass' as const, measuredReport: 'pass' as const },
};
function lifecyclePlacement(scenario: LifecycleScenario, wrong = false) {
  const shipped = scenario === 'shipped-without-closure' || scenario === 'satisfied-closure';
  const args: Parameters<typeof subject.compileGoalPlanPlacement>[0] = {
    plan: { harness: 'fixture', slug: 'alpha', ambiguousMatches: 1 },
    status: shipped ? 'shipped' : scenario === 'draft-refusal' ? 'draft' : 'active',
    itemStatuses: shipped ? ['done'] : ['todo'],
    actionableItemId: shipped || scenario === 'dependency-blocker' ? null : 'P-001',
    source: {}, now: NOW,
    closure: scenario === 'satisfied-closure' ? satisfiedClosure : null,
  };
  // Permanent wrong implementations exercise one acceptance failure each;
  // neither the production module nor the shared tree is mutated for a probe.
  if (wrong) {
    if (scenario === 'draft-refusal') args.status = 'active';
    if (scenario === 'dependency-blocker') args.actionableItemId = 'P-001';
    if (scenario === 'eligible-control') args.actionableItemId = null;
    if (scenario === 'shipped-without-closure') args.closure = satisfiedClosure;
    if (scenario === 'satisfied-closure') args.closure = null;
  }
  return subject.compileGoalPlanPlacement(args);
}

describe('placement lifecycle causal contracts (WI-1074216)', () => {
  it.each(lifecycleScenarios)('outer control catches placement adapter: %s', (scenario) => {
    const expectedState = scenario === 'eligible-control' ? 'unplaced'
      : scenario === 'satisfied-closure' ? 'terminal'
      : scenario === 'shipped-without-closure' ? 'awaiting-closure' : 'blocked';
    expect(lifecyclePlacement(scenario, false).state).toBe(expectedState);
    expect(() => expect(lifecyclePlacement(scenario, true).state).toBe(expectedState)).toThrowError();
  });
  it('placement calibration: unresolved plan identity never launches', () => {
    expect(subject.compileGoalPlanPlacement({
      plan: { harness: null, slug: 'alpha', ambiguousMatches: 1 },
      status: 'active', itemStatuses: ['todo'], actionableItemId: 'P-001', source: {}, now: NOW,
    })).toMatchObject({ state: 'blocked', reconciliation: { action: 'resolve-plan-identity', toolCall: null } });
  });
  it.each(lifecycleScenarios)('repaired placement contract: %s', (scenario) => {
    const row = lifecyclePlacement(scenario, lifecycleControl === scenario);
    if (scenario === 'eligible-control') {
      expect(row, `placement-contract:${scenario}`).toMatchObject({
        state: 'unplaced', reconciliation: { action: 'launch-plan-fleet', consistent: false,
          toolCall: { tool: 'fleet:launch-on-plan', args: { plan: 'alpha' } } },
      });
    } else if (scenario === 'satisfied-closure') {
      expect(row, `placement-contract:${scenario}`).toMatchObject({
        state: 'terminal', reconciliation: { action: 'none', consistent: true, toolCall: null },
      });
    } else if (scenario === 'shipped-without-closure') {
      expect(row, `placement-contract:${scenario}`).toMatchObject({
        state: 'awaiting-closure', reconciliation: { action: 'close-plan', consistent: false, toolCall: null },
      });
    } else {
      expect(row, `placement-contract:${scenario}`).toMatchObject({
        state: 'blocked', reconciliation: { action: 'resolve-plan-blockers', consistent: false, toolCall: null },
      });
      expect(row.reconciliation.reason).toMatch(scenario === 'draft-refusal' ? /draft.*cannot launch/i : /dependency-free todo/i);
    }
  });
});

describe('actual delegated plan-member pickup', () => {
  it.each(claimScenarios)('outer control catches claim adapter: %s', (scenario) => {
    const source = scenario === 'leader-only' ? { claims: [{ ...lane, ownerId: fleet.leaderOwnerId }] }
      : scenario === 'wrong-member-or-filter' ? { claims: [{ ...lane, fleetSlug: 'other-fleet' }] }
      : scenario === 'expired-lease' ? { claims: [{ ...lane, expiresAt: '2026-09-23T10:59:00.000Z' }] } : {};
    const assertState = (row: ReturnType<typeof compile>) => scenario === 'member-claim-and-lease'
      ? expect(row.state).toBe('working') : expect(row.state).not.toBe('working');
    assertState(compile(source, ''));
    expect(() => assertState(compile(source, scenario))).toThrowError();
  });
  it('recognizes a live member with matching work-item and TTL plan lease in a positively scoped independent fleet', () => {
    expect(compile()).toMatchObject({ state: 'working', reconciliation: { action: 'none', consistent: true } });
  });
  it('does not call a leader-only lease productive member pickup', () => {
    const row = compile({ claims: [{ ...lane, ownerId: fleet.leaderOwnerId }] });
    expect(row.state).not.toBe('working');
    expect(row.reconciliation.consistent).toBe(false);
    expect(row.reconciliation.toolCall).toBeNull();
  });
  it('does not accept a WIP label and plan lease without a matching work-item claim', () => {
    const row = compile({ claims: [{ ...lane, workItemId: null }] });
    expect(row.state).not.toBe('working');
    expect(row.reconciliation.consistent).toBe(false);
  });
  it('does not credit a claim made by a different fleet', () => {
    const row = compile({ claims: [{ ...lane, fleetSlug: 'other-fleet' }] });
    expect(row.state).not.toBe('working');
    expect(row.reconciliation.consistent).toBe(false);
  });
  it('rejects a goal steward masquerading as the independent leader', () => {
    const row = compile({ fleet: { ...fleet, leaderOwnerId: 'su-goal' } });
    expect(row.state).not.toBe('working');
    expect(row.reconciliation.consistent).toBe(false);
  });
  it.each([null, { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'different' } } }])(
    'does not credit an unmeasured or wrong positive plan filter', (claimSpec) => {
      const row = compile({ fleet: { ...fleet, claimSpec } });
      expect(row.state).not.toBe('working');
      expect(row.reconciliation.consistent).toBe(false);
    },
  );
  it('does not launch a duplicate fleet merely because an existing verified fleet has no member claim yet', () => {
    const row = compile({ claims: [] });
    expect(row).toMatchObject({ state: 'admitting', reconciliation: { consistent: false, toolCall: null } });
    expect(row.reconciliation.reason).toMatch(/claim/i);
  });
  it('does not credit a different plan-item lane or an expired member lease', () => {
    for (const claims of [[{ ...lane, itemId: 'P-999' }], [{ ...lane, expiresAt: '2026-09-23T10:59:00.000Z' }]]) {
      const row = compile({ claims });
      expect(row.state).not.toBe('working');
      expect(row.reconciliation.consistent).toBe(false);
    }
  });
});
