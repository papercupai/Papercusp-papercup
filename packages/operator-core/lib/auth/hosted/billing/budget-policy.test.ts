import { describe, expect, it } from 'vitest';
import { evaluateHostedBudget, settleHostedReservation, type HostedBudgetPolicy, type HostedBudgetPosition } from './budget-policy';

const policy: HostedBudgetPolicy = { policyId: 'policy-a', revision: 2, budgetKey: 'consumption.usd_cents',
  effectiveFromMs: 100, effectiveUntilMs: 200, warningBps: 8000 };
const position: HostedBudgetPosition = { fundedMicros: 100_000, spentMicros: 20_000,
  openReservedMicros: 10_000, retainedReserveMicros: 10_000, unreconciled: false };
const decide = (change: Partial<Parameters<typeof evaluateHostedBudget>[0]> = {}) => evaluateHostedBudget({
  policy, position, entitlements: { budgets: { 'consumption.usd_cents': 10 } }, maximumCostMicros: 60_000, asOfMs: 100, ...change,
});
const settle = (change: Partial<Parameters<typeof settleHostedReservation>[0]> = {}) => settleHostedReservation({
  reservedMicros: 60_003, observedCostMicros: 20_001, costSource: 'provider-billed', providerFinal: true,
  evidenceRef: 'provider:bill-1', ...change,
});

describe('hosted budget admission policy (transaction caller required)', () => {
  it('admits exactly the funded cap after spend, open holds and continuing resource reserve', () => {
    expect(decide()).toEqual({ admitted: true, reason: null, capMicros: 100_000, availableMicros: 60_000,
      reserveMicros: 60_000, warning: true });
    expect(decide({ maximumCostMicros: 60_001 })).toMatchObject({ admitted: false, reason: 'budget-exhausted', reserveMicros: 0 });
  });

  it('uses the tighter entitlement and funding ceilings; never creates an automatic top-up', () => {
    expect(decide({ position: { ...position, fundedMicros: 50_000 } })).toMatchObject({ admitted: false, capMicros: 50_000, availableMicros: 10_000 });
    expect(decide({ entitlements: { budgets: { 'consumption.usd_cents': 5 } } })).toMatchObject({ admitted: false, capMicros: 50_000 });
    expect(decide({ position: { ...position, fundedMicros: 0 } })).toMatchObject({ admitted: false, capMicros: 0 });
  });

  it('does not treat an absent or inherited entitlement budget as unlimited', () => {
    expect(decide({ entitlements: { budgets: {} } }).reason).toBe('unconfigured-budget');
    expect(decide({ entitlements: { budgets: Object.create({ 'consumption.usd_cents': 10 }) } }).reason).toBe('unconfigured-budget');
  });

  it('keeps crash/retry and cancelled-but-unbilled exposure in the committed position', () => {
    const held = { ...position, openReservedMicros: 70_000 };
    expect(decide({ position: held, maximumCostMicros: 1 })).toMatchObject({ admitted: false, availableMicros: 0 });
    expect(decide({ position: held, maximumCostMicros: 0 }).admitted).toBe(true);
    expect(decide({ position: { ...held, spentMicros: 20_001 }, maximumCostMicros: 0 }).admitted).toBe(false);
  });

  it('fails closed on unaccounted charges or an unbounded retained resource', () => {
    expect(decide({ position: { ...position, unreconciled: true } }).reason).toBe('unreconciled-charge');
    expect(decide({ position: { ...position, retainedReserveMicros: null } }).reason).toBe('unbounded-retained-cost');
  });

  it('honors the exact policy window and configured warning threshold', () => {
    expect(decide({ asOfMs: 99 }).reason).toBe('inactive-policy');
    expect(decide({ asOfMs: 199 }).admitted).toBe(true);
    expect(decide({ asOfMs: 200 }).reason).toBe('inactive-policy');
    expect(decide({ maximumCostMicros: 39_999 }).warning).toBe(false);
    expect(decide({ maximumCostMicros: 40_000 }).warning).toBe(true);
    expect(decide({ policy: { ...policy, warningBps: 9000 }, maximumCostMicros: 40_000 }).warning).toBe(false);
  });

  it('uses exact arithmetic when valid individual counters sum beyond safe integer range', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(decide({ position: { ...position, fundedMicros: max, spentMicros: max, openReservedMicros: max }, maximumCostMicros: 0 }))
      .toMatchObject({ admitted: false, reason: 'budget-exhausted', availableMicros: 0 });
  });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maximum cost %s', maximumCostMicros => {
    expect(() => decide({ maximumCostMicros })).toThrow(/maximum cost/);
  });

  it('rejects invalid caps, conversion overflow, policy pins and position counters', () => {
    expect(() => decide({ entitlements: { budgets: { 'consumption.usd_cents': 0.5 } } })).toThrow(/entitlement cap/);
    expect(() => decide({ entitlements: { budgets: { 'consumption.usd_cents': Number.MAX_SAFE_INTEGER } } })).toThrow(/conversion/);
    expect(() => decide({ policy: { ...policy, revision: 0 } })).toThrow(/policy/);
    expect(() => decide({ policy: { ...policy, effectiveUntilMs: 100 } })).toThrow(/interval/);
    expect(() => decide({ policy: { ...policy, warningBps: 10_001 } })).toThrow(/policy/);
    expect(() => decide({ position: { ...position, openReservedMicros: -1 } })).toThrow(/holds/);
  });
});

describe('hosted reservation provider evidence settlement', () => {
  it('preserves submicro final charges and the exact released difference', () => {
    expect(settle({ reservedMicros: 1, observedCostMicros: 0, observedCostMicrosExact: '0.1234567890123456789' }))
      .toMatchObject({ state: 'settled', chargedMicros: 0, chargedMicrosExact: '0.1234567890123456789',
        releasedMicros: 0, releasedMicrosExact: '0.8765432109876543211', suspend: false });
  });

  it.each([true, false])('detects a fractional overrun even when its integer projection is zero (final=%s)', providerFinal => {
    expect(settle({ reservedMicros: 1, observedCostMicros: 1, observedCostMicrosExact: '1.0000000000000000001',
      providerFinal, costSource: providerFinal ? 'provider-billed' : 'provider-reported' }))
      .toMatchObject({ state: providerFinal ? 'settled' : 'pending', overrunMicros: 0,
        overrunMicrosExact: '0.0000000000000000001', suspend: true,
        heldMicros: providerFinal ? 0 : 1, releasedMicros: 0 });
  });

  it('deducts exact aggregate liability before admitting a whole-micro provider bound', () => {
    const fractional = { ...position, spentMicros: 20_000, spentMicrosExact: '20000.1' };
    expect(decide({ position: fractional })).toMatchObject({ admitted: false, availableMicros: 59_999,
      availableMicrosExact: '59999.9' });
    expect(decide({ position: fractional, maximumCostMicros: 59_999 }).admitted).toBe(true);
    expect(decide({ position: { ...position, fundedMicros: 40_000, fundedMicrosExact: '40000.1' }, maximumCostMicros: 0 }))
      .toMatchObject({ admitted: true, capMicros: 40_000, capMicrosExact: '40000.1', availableMicros: 0, availableMicrosExact: '0.1' });
  });

  it('keeps fractional overspend and warning comparisons exact', () => {
    expect(decide({ position: { ...position, fundedMicros: 40_000, spentMicrosExact: '20000.0000000000000000001' }, maximumCostMicros: 0 }))
      .toMatchObject({ admitted: false, reason: 'budget-exhausted' });
    const justBelow = { ...position, spentMicros: 19_999, spentMicrosExact: '19999.9999999999999999999' };
    expect(decide({ position: justBelow, maximumCostMicros: 40_000 }).warning).toBe(false);
    expect(decide({ maximumCostMicros: 40_000 }).warning).toBe(true);
  });

  it('rejects mismatched, noncanonical or unknown exact settlement amounts', () => {
    for (const exact of ['20002.1', '20001.00', '-1', '1e-3', '9007199254740991.1']) {
      expect(() => settle({ observedCostMicrosExact: exact })).toThrow();
    }
    expect(() => settle({ observedCostMicros: null, observedCostMicrosExact: '0.1' })).toThrow();
    expect(() => decide({ position: { ...position, spentMicrosExact: '20000.00' } })).toThrow();
  });

  it('settles exact billed micros, including sub-cent residue, and releases only the measured difference', () => {
    expect(settle()).toEqual({ state: 'settled', chargedMicros: 20_001, heldMicros: 0,
      releasedMicros: 40_002, overrunMicros: 0, suspend: false, evidenceRef: 'provider:bill-1' });
    expect(settle({ observedCostMicros: 0 })).toMatchObject({ state: 'settled', chargedMicros: 0, releasedMicros: 60_003 });
  });

  it.each(['estimate', 'provider-reported', 'unpriced'] as const)('retains the entire hold for %s through cancellation or restart', costSource => {
    expect(settle({ costSource, observedCostMicros: costSource === 'unpriced' ? null : 0 }))
      .toMatchObject({ state: 'pending', chargedMicros: 0, heldMicros: 60_003, releasedMicros: 0 });
  });

  it('retains the hold for an incomplete bill or unknown amount', () => {
    expect(settle({ providerFinal: false })).toMatchObject({ state: 'pending', heldMicros: 60_003, releasedMicros: 0 });
    expect(settle({ observedCostMicros: null })).toMatchObject({ state: 'pending', heldMicros: 60_003 });
  });

  it('records the full final overrun and suspends admission instead of hiding provider liability', () => {
    expect(settle({ observedCostMicros: 60_004 })).toMatchObject({ state: 'settled', chargedMicros: 60_004,
      releasedMicros: 0, overrunMicros: 1, suspend: true });
    expect(settle({ costSource: 'provider-reported', observedCostMicros: 60_004, providerFinal: false }))
      .toMatchObject({ state: 'pending', heldMicros: 60_003, overrunMicros: 1, suspend: true });
  });

  it('rejects malformed or unsafe settlement evidence rather than assuming a free cancellation', () => {
    expect(() => settle({ evidenceRef: '' })).toThrow(/evidence/);
    expect(() => settle({ observedCostMicros: -1 })).toThrow(/cost/);
    expect(() => settle({ costSource: 'unpriced', observedCostMicros: 0 })).toThrow(/evidence/);
    expect(() => settle({ reservedMicros: NaN })).toThrow(/reserve/);
  });
});
