/**
 * P-005 / D-030 step 5: computeFleetUnderStaffedAlert. Every "unknown" input must
 * yield undefined (never a fabricated all-clear), every not-held cause must be
 * named in the reason with its own repair, and each suppression has a positive
 * control: the same state with the one suppressing input flipped DOES fire.
 */
import { describe, expect, it } from 'vitest';
import type { FleetHeadcountState } from '../agent-fleets-store';
import type { ResolvedFleetTopUpRule } from './top-up-rule';
import { computeFleetUnderStaffedAlert } from './under-staffed-alert';

function state(over: Partial<FleetHeadcountState> = {}): FleetHeadcountState {
  return {
    enabled: true,
    target: 3,
    current: 1,
    shortfall: 2,
    underStrength: true,
    verdict: 'under-strength',
    held: false,
    notHeldBecause: 'supervise-not-granted',
    topUpRule: { status: 'none', kind: null, inherited: null, ratifiedBy: null, reason: null, until: null },
    basis: {
      kind: 'agent-origin-execution-attested',
      liveRosterMembers: 1,
      executingMembers: 1,
      transactionWorkerReadyMembers: null,
    },
    countEvidence: { productive: null, liveRoster: null, transactionWorkerReady: null, note: '' },
    ...over,
  };
}

const ACTIVE = { controlState: 'active' } as const;

describe('computeFleetUnderStaffedAlert (P-005 / D-030)', () => {
  it('fires below target and names the unheld cause with its repair', () => {
    const r = computeFleetUnderStaffedAlert({ headcount: state(), ...ACTIVE });
    expect(r).toMatchObject({ alert: true, current: 1, target: 3, shortfall: 2, held: false });
    expect(r?.reason).toContain('1 of 3 target worker(s) are productive (short 2)');
    expect(r?.reason).toContain('supervise was never granted');
    expect(r?.repair).toBe('fleet:headcount-target { target, supervise:true }');
  });

  it('does not fire at or above target', () => {
    expect(computeFleetUnderStaffedAlert({ headcount: state({ current: 3 }), ...ACTIVE })).toMatchObject({
      alert: false, shortfall: 0,
    });
    expect(computeFleetUnderStaffedAlert({ headcount: state({ current: 5 }), ...ACTIVE })).toMatchObject({
      alert: false, shortfall: 0,
    });
  });

  it('with no target, fires only at zero productive workers (the D-008 incident)', () => {
    const noTarget = { enabled: false, target: null, verdict: 'disabled' as const, notHeldBecause: 'no-target' as const };
    const zero = computeFleetUnderStaffedAlert({ headcount: state({ ...noTarget, current: 0 }), ...ACTIVE });
    expect(zero).toMatchObject({ alert: true, current: 0, target: null, shortfall: null });
    expect(zero?.reason).toContain('0 productive workers and no headcount target');
    expect(zero?.reason).toContain('No headcount target is set');
    expect(zero?.repair).toContain('fleet:wind-down');
    expect(computeFleetUnderStaffedAlert({ headcount: state({ ...noTarget, current: 2 }), ...ACTIVE })).toMatchObject({
      alert: false,
    });
  });

  it('a held fleet still alarms but says the governor is restoring it', () => {
    const r = computeFleetUnderStaffedAlert({
      headcount: state({ held: true, notHeldBecause: null }),
      ...ACTIVE,
    });
    expect(r?.alert).toBe(true);
    expect(r?.reason).toContain('governor holds this fleet');
    expect(r?.repair).toBe('none needed while the governor is restoring it');
  });

  it('unknown held is said out loud, not read as held', () => {
    const r = computeFleetUnderStaffedAlert({ headcount: state({ held: null, notHeldBecause: null }), ...ACTIVE });
    expect(r?.alert).toBe(true);
    expect(r?.reason).toContain('could not be read');
  });

  it('names the governor flag when it is off', () => {
    const r = computeFleetUnderStaffedAlert({
      headcount: state({ notHeldBecause: 'governor-flag-off' }),
      ...ACTIVE,
    });
    expect(r?.reason).toContain('FLEET_HEADCOUNT_GOVERNOR is OFF');
    expect(r?.repair).toContain('fleet:launch-on-plan');
  });

  describe('a no-top-up rule is named with its ratifier', () => {
    const rule = (over: Partial<ResolvedFleetTopUpRule>): ResolvedFleetTopUpRule => ({
      status: 'in-force',
      kind: 'target-disabled',
      inherited: false,
      ratifiedBy: 'su-leader',
      reason: 'plan paused for review',
      until: Date.UTC(2026, 9, 7, 0, 0, 0),
      ...over,
    });
    const ruled = (r: ResolvedFleetTopUpRule) =>
      state({
        enabled: false, target: null, current: 0, verdict: 'disabled',
        notHeldBecause: 'top-up-rule', topUpRule: r,
      });

    it('in force: ratifier, reason and until; repair offers re-ratify or restore', () => {
      const r = computeFleetUnderStaffedAlert({ headcount: ruled(rule({})), ...ACTIVE });
      expect(r?.reason).toContain('ratified by su-leader: "plan paused for review"');
      expect(r?.reason).toContain('until 2026-10-07T00:00:00.000Z');
      expect(r?.reason).not.toContain('previous leader');
      expect(r?.repair).toContain('re-ratify');
    });

    it('inherited: says the current leader has not re-ratified it', () => {
      const r = computeFleetUnderStaffedAlert({
        headcount: ruled(rule({ inherited: true, ratifiedBy: 'su-old-leader' })),
        ...ACTIVE,
      });
      expect(r?.reason).toContain('su-old-leader (a previous leader');
    });

    it('expired: says it lapses on the next tick', () => {
      const r = computeFleetUnderStaffedAlert({ headcount: ruled(rule({ status: 'expired' })), ...ACTIVE });
      expect(r?.reason).toContain('expired at 2026-10-07T00:00:00.000Z');
      expect(r?.reason).toContain('lapses it on its next tick');
    });

    it('malformed: says it holds nothing', () => {
      const r = computeFleetUnderStaffedAlert({
        headcount: ruled(rule({ status: 'expired', malformed: true, ratifiedBy: null, reason: null, until: null })),
        ...ACTIVE,
      });
      expect(r?.reason).toContain('unreadable');
    });
  });

  describe('unknown or not applicable is undefined, never a clean false', () => {
    it.each([
      ['no headcount read', { headcount: undefined, controlState: 'active' }],
      ['null headcount', { headcount: null, controlState: 'active' }],
      ['profile read failed', { headcount: state({ enabled: null }), controlState: 'active' }],
      ['current unknown', { headcount: state({ current: null }), controlState: 'active' }],
      ['control state unknown', { headcount: state(), controlState: null }],
      ['winding down', { headcount: state(), controlState: 'winding-down' }],
      ['paused', { headcount: state(), controlState: 'active', fleetPaused: true }],
    ] as const)('%s', (_label, input) => {
      expect(computeFleetUnderStaffedAlert(input)).toBeUndefined();
    });

    it('positive control: the same under-strength state fires when active, unpaused and fully read', () => {
      expect(computeFleetUnderStaffedAlert({ headcount: state(), controlState: 'active', fleetPaused: false })?.alert)
        .toBe(true);
    });
  });
});
