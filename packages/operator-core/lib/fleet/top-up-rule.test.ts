import { describe, expect, it } from 'vitest';
import type { FleetHeadcountTarget } from '../agent-fleets-store';
import {
  parseFleetTopUpRule,
  resolveFleetHeadcountHeld,
  resolveFleetTopUpRule,
  type FleetHeadcountGovernance,
  type FleetTopUpRule,
} from './top-up-rule';

const NOW = 1_800_000_000_000;
const rule: FleetTopUpRule = {
  kind: 'target-disabled',
  ratifiedBy: 'su-old-leader',
  ratifiedAt: NOW - 3_600_000,
  reason: 'D-001: no waves or top-ups',
  until: NOW + 3_600_000,
  suspendedTarget: 3,
  suspendedSupervise: true,
};

function profile(over: Partial<FleetHeadcountTarget> & { supervise?: boolean; topUpRule?: unknown } = {}): FleetHeadcountTarget {
  const { supervise, topUpRule, ...rest } = over;
  return {
    workspaceId: 'ws',
    fleetSlug: 'fleet-a',
    enabled: true,
    target: 3,
    config: {
      harness: 'papercusp',
      agent: 'claude',
      ...(supervise !== undefined ? { supervise } : {}),
      ...(topUpRule !== undefined ? { topUpRule } : {}),
    },
    nextAttemptAt: null,
    backoffMs: 0,
    lastError: null,
    ...rest,
  } as FleetHeadcountTarget;
}

const governance = (over: Partial<FleetHeadcountGovernance> = {}): FleetHeadcountGovernance => ({
  governorFlagOn: true,
  controlState: 'active',
  leaderOwnerId: 'su-new-leader',
  now: NOW,
  ...over,
});

describe('parseFleetTopUpRule', () => {
  it('reads a complete rule', () => {
    expect(parseFleetTopUpRule(rule)).toEqual(rule);
  });

  it.each([
    ['no kind', { ...rule, kind: 'freeze' }],
    ['blank ratifier', { ...rule, ratifiedBy: '  ' }],
    ['blank reason', { ...rule, reason: '' }],
    ['no until', { ...rule, until: undefined }],
    ['non-finite until', { ...rule, until: Number.POSITIVE_INFINITY }],
  ])('refuses an unattributable or unbounded rule (%s)', (_label, raw) => {
    expect(parseFleetTopUpRule(raw)).toBeNull();
  });

  it('drops an unusable suspended target instead of restoring garbage', () => {
    expect(parseFleetTopUpRule({ ...rule, suspendedTarget: 0, suspendedSupervise: 'yes' })).toMatchObject({
      suspendedTarget: null,
      suspendedSupervise: null,
    });
  });
});

describe('resolveFleetTopUpRule', () => {
  it('reports no rule as none', () => {
    expect(resolveFleetTopUpRule({ rule: undefined, leaderOwnerId: 'su-new-leader', now: NOW }).status).toBe('none');
  });

  it('names an inherited rule and its ratifier while it is in force', () => {
    expect(resolveFleetTopUpRule({ rule, leaderOwnerId: 'su-new-leader', now: NOW })).toEqual({
      status: 'in-force',
      kind: 'target-disabled',
      inherited: true,
      ratifiedBy: 'su-old-leader',
      reason: 'D-001: no waves or top-ups',
      until: NOW + 3_600_000,
    });
  });

  it('is not inherited once the current leader re-ratifies it', () => {
    expect(
      resolveFleetTopUpRule({ rule: { ...rule, ratifiedBy: 'su-new-leader' }, leaderOwnerId: 'su-new-leader', now: NOW })
        .inherited,
    ).toBe(false);
  });

  it('expires at until, whoever ratified it', () => {
    expect(resolveFleetTopUpRule({ rule, leaderOwnerId: 'su-old-leader', now: rule.until }).status).toBe('expired');
  });

  it('reports an unreadable stored rule as expired and malformed, never in force', () => {
    expect(resolveFleetTopUpRule({ rule: { kind: 'target-disabled' }, leaderOwnerId: null, now: NOW })).toMatchObject({
      status: 'expired',
      malformed: true,
    });
  });
});

describe('resolveFleetHeadcountHeld', () => {
  it('answers unknown when the profile read failed or governance was not supplied', () => {
    expect(resolveFleetHeadcountHeld(undefined, governance())).toEqual({ held: null, notHeldBecause: null, topUpRule: null });
    expect(resolveFleetHeadcountHeld(profile({ supervise: true }), undefined)).toEqual({
      held: null,
      notHeldBecause: null,
      topUpRule: null,
    });
  });

  it('holds a fleet with a target, a supervise grant and the flag on', () => {
    expect(resolveFleetHeadcountHeld(profile({ supervise: true }), governance())).toMatchObject({
      held: true,
      notHeldBecause: null,
      topUpRule: { status: 'none' },
    });
  });

  it('does not hold a default-launched fleet: a target without a grant is a number nobody acts on', () => {
    expect(resolveFleetHeadcountHeld(profile(), governance())).toMatchObject({
      held: false,
      notHeldBecause: 'supervise-not-granted',
    });
  });

  it('names a missing target, and the rule when one disabled it', () => {
    expect(resolveFleetHeadcountHeld(null, governance())).toMatchObject({ held: false, notHeldBecause: 'no-target' });
    expect(resolveFleetHeadcountHeld(profile({ enabled: false }), governance())).toMatchObject({
      held: false,
      notHeldBecause: 'no-target',
    });
    expect(resolveFleetHeadcountHeld(profile({ enabled: false, topUpRule: rule }), governance())).toMatchObject({
      held: false,
      notHeldBecause: 'top-up-rule',
      topUpRule: { status: 'in-force', inherited: true, ratifiedBy: 'su-old-leader' },
    });
  });

  it('names a supervise-revoked rule over the bare missing grant', () => {
    expect(
      resolveFleetHeadcountHeld(
        profile({ supervise: false, topUpRule: { ...rule, kind: 'supervise-revoked' } }),
        governance(),
      ),
    ).toMatchObject({ held: false, notHeldBecause: 'top-up-rule', topUpRule: { kind: 'supervise-revoked' } });
  });

  it('puts winding-down ahead of everything and reports the master flag', () => {
    expect(resolveFleetHeadcountHeld(profile({ supervise: true }), governance({ controlState: 'winding-down' })))
      .toMatchObject({ held: false, notHeldBecause: 'winding-down' });
    expect(resolveFleetHeadcountHeld(profile({ supervise: true }), governance({ governorFlagOn: false })))
      .toMatchObject({ held: false, notHeldBecause: 'governor-flag-off' });
    // An unreadable flag is unknown, never a confident "held".
    expect(resolveFleetHeadcountHeld(profile({ supervise: true }), governance({ governorFlagOn: null })))
      .toMatchObject({ held: null, notHeldBecause: null });
  });
});
