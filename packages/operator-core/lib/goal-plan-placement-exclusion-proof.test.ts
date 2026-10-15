/** P006: causal controls for the remaining P001 placement assertions. */
import { describe, expect, it } from 'vitest';
import { compileGoalPlanPlacement } from './goal-launch-settings';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';

const NOW = new Date('2026-09-23T11:00:00.000Z');
const scenarios = ['holder-not-independent', 'independent-member-positive', 'existing-one-fleet'] as const;
type Scenario = typeof scenarios[number];
const controls = [...scenarios, 'drain-and-test-excluded'] as const;
const control = process.env.PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL;
if (control && !controls.includes(control as typeof controls[number])) {
  throw new Error(`Unknown permanent placement exclusion control: ${control}`);
}

function placement(scenario: Scenario, faultyControl = control) {
  const source = {
    goalHolderOwnerIds: ['su-goal'],
    claims: scenario === 'existing-one-fleet' ? [] : [{
      itemId: 'P-001', ownerId: 'su-member', fleetSlug: 'alpha-fleet', holderLive: true,
      expiresAt: '2026-09-23T11:05:00.000Z', workItemId: 'WI-fixture',
    }],
    fleet: {
      slug: 'alpha-fleet', controlState: 'active',
      leaderOwnerId: scenario === 'holder-not-independent' ? 'su-goal' : 'su-leader',
      leaderLive: true, liveMembers: 2, target: 2,
      claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'alpha' } } },
      launchTransaction: { transactionId: 'tx-existing', state: 'verified' },
    },
  };
  // Intentional wrong adapters keep the literal oracle intact. They lose one
  // canonical input at a time; calibration bypasses every adapter below.
  const observed: typeof source | Omit<typeof source, 'fleet'> = source;
  if (faultyControl === scenario) {
    if (scenario === 'holder-not-independent') source.goalHolderOwnerIds = [];
    if (scenario === 'independent-member-positive') source.claims = [];
    if (scenario === 'existing-one-fleet') delete (observed as Partial<typeof source>).fleet;
  }
  return compileGoalPlanPlacement({
    plan: { harness: 'fixture', slug: 'alpha', ambiguousMatches: 1 },
    status: 'started', itemStatuses: ['wip'], actionableItemId: 'P-001', source: observed, now: NOW,
  });
}

describe('placement exclusion causal contracts (WI-1074216)', () => {
  it.each(scenarios)('outer control catches exclusion adapter: %s', (scenario) => {
    const expectedState = scenario === 'holder-not-independent' ? 'blocked'
      : scenario === 'independent-member-positive' ? 'working' : 'admitting';
    expect(placement(scenario, '').state).toBe(expectedState);
    expect(() => expect(placement(scenario, scenario).state).toBe(expectedState)).toThrowError();
  });
  it('exclusion calibration: unresolved identity refuses launch independently of the control', () => {
    expect(compileGoalPlanPlacement({
      plan: { harness: null, slug: 'alpha', ambiguousMatches: 1 },
      status: 'active', itemStatuses: ['todo'], actionableItemId: 'P-001', source: {}, now: NOW,
    })).toMatchObject({ state: 'blocked', reconciliation: { action: 'resolve-plan-identity', toolCall: null } });
  });
  it('repaired exclusion contract: drain-and-test-excluded', () => {
    for (const activity of ['goal-drain', 'test-child']) {
      // Exercise the actual admission input; an opaque activity label alone
      // would be ignored by the compiler and could not falsify the exclusion.
      const source = {
        goalHolderOwnerIds: ['su-goal'],
        claims: [{ itemId: 'P-001', ownerId: 'su-member', fleetSlug: activity, holderLive: true,
          expiresAt: '2026-09-23T11:05:00.000Z', workItemId: 'WI-fixture' }],
        fleet: { slug: activity, controlState: 'active', leaderOwnerId: 'su-leader',
          leaderLive: true, liveMembers: 2, target: 2,
          claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter:
            control === 'drain-and-test-excluded'
              ? { field: 'plan', op: '=', value: 'alpha' }
              : { field: 'goal', op: '=', value: 'goal-fixture' } } },
          launchTransaction: { transactionId: 'tx-activity', state: 'verified' } },
      };
      expect(compileGoalPlanPlacement({
        plan: { harness: 'fixture', slug: 'alpha', ambiguousMatches: 1 }, status: 'started',
        itemStatuses: ['wip'], actionableItemId: 'P-001', source, now: NOW,
      }), `exclusion-contract:drain-and-test-excluded:${activity}`).toMatchObject({
        state: 'blocked', fleet: { slug: activity, planScoped: false, planAdmitted: false },
        reconciliation: { consistent: false, action: 'reconcile-plan-lane-holder', toolCall: null },
      });
    }
  });
  it.each(scenarios)('repaired exclusion contract: %s', (scenario) => {
    const row = placement(scenario);
    if (scenario === 'holder-not-independent') {
      expect(row, `exclusion-contract:${scenario}`).toMatchObject({
        state: 'blocked', reconciliation: { action: 'reconcile-plan-lane-holder', consistent: false, toolCall: null },
      });
    } else if (scenario === 'independent-member-positive') {
      expect(row, `exclusion-contract:${scenario}`).toMatchObject({
        state: 'working', activeLane: { ownerId: 'su-member', workItemId: 'WI-fixture' },
        reconciliation: { action: 'none', consistent: true, toolCall: null },
      });
    } else {
      expect(row, `exclusion-contract:${scenario}`).toMatchObject({
        state: 'admitting', activeLane: null, fleet: { slug: 'alpha-fleet' },
        launchTransaction: { transactionId: 'tx-existing', state: 'verified' },
        reconciliation: { action: 'reconcile-plan-lane-holder', consistent: false, toolCall: null },
      });
    }
  });
});
