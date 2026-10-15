/**
 * Pure policy rules (dao-hr-people-2026-10-11 P-003). Database + chain behaviour lives in
 * equity-policy.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { EQUITY_V2_FUNCTION_CLASSES } from '../equity/v2-function-classes';
import {
  DEFAULT_EQUITY_POLICY,
  EQUITY_V2_CEILINGS,
  EquityPolicyError,
  POLICY_SETTING_KEYS,
  changedPolicyFields,
  planChainPolicyCalls,
  resolveOfferTermsFrom,
  validatePolicySettings,
  type EquityPolicySettings,
} from './equity-policy';

const base = (): EquityPolicySettings => structuredClone(DEFAULT_EQUITY_POLICY) as EquityPolicySettings;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EquityPolicyError);
    return (error as EquityPolicyError).code;
  }
  throw new Error('expected an EquityPolicyError');
}

describe('SPEC-P-003 — a policy value above its immutable maximum is rejected', () => {
  it('rejects a return rate above 1000 bps, an interval outside 30–365 days, a grant over 3650 days and a limit over the deployment cap', () => {
    expect(code(() => validatePolicySettings({ ...base(), returnRateBps: 1001 }))).toBe('above_immutable_max');
    expect(code(() => validatePolicySettings({ ...base(), returnIntervalDays: 29 }))).toBe('above_immutable_max');
    expect(code(() => validatePolicySettings({ ...base(), returnIntervalDays: 366 }))).toBe('above_immutable_max');
    const longGrant = { ...base(), vestingDays: 3651, offerBounds: { ...base().offerBounds, vestingDaysMax: 3650 } };
    expect(code(() => validatePolicySettings(longGrant))).toBe('above_immutable_max');
    expect(code(() => validatePolicySettings({ ...base(), perGrantLimitShares: 50_001 }, { maxGrantLimit: 50_000n }))).toBe('above_immutable_max');
  });

  it('accepts every value exactly at its immutable maximum', () => {
    const atCeiling = {
      ...base(),
      returnRateBps: 1000,
      returnIntervalDays: 365,
      perGrantLimitShares: 50_000,
      offerBounds: { ...base().offerBounds, vestingDaysMax: 3650, sharesMax: 50_000 },
    };
    const saved = validatePolicySettings(atCeiling, { maxGrantLimit: 50_000n });
    expect(saved.returnRateBps).toBe(EQUITY_V2_CEILINGS.annualReturnCapBps);
    expect(saved.returnIntervalDays).toBe(EQUITY_V2_CEILINGS.maxReturnIntervalDays);
    expect(saved.perGrantLimitShares).toBe(50_000);
  });
});

describe('SPEC-P-003-B — an offer override outside the policy bounds is rejected', () => {
  const policy = validatePolicySettings({ ...base(), defaultGrants: [{ role: 'Engineer', level: 'L2', shares: 4_000 }] });

  it('refuses shares, vesting or cliff outside the offer bounds and an unknown override', () => {
    expect(code(() => resolveOfferTermsFrom(policy, 3, { role: 'Engineer', level: 'L2', overrides: { shares: 10_001 } }))).toBe('override_out_of_bounds');
    expect(code(() => resolveOfferTermsFrom(policy, 3, { role: 'Engineer', level: 'L2', overrides: { vestingDays: 364 } }))).toBe('override_out_of_bounds');
    expect(code(() => resolveOfferTermsFrom(policy, 3, { role: 'Engineer', level: 'L2', overrides: { cliffDays: 366 } }))).toBe('override_out_of_bounds');
    expect(code(() => resolveOfferTermsFrom(policy, 3, { role: 'Engineer', level: 'L2', overrides: { salaryVisibility: 'hidden' } }))).toBe('unknown_field');
  });

  it('accepts overrides inside the bounds and fills the rest from the policy', () => {
    expect(resolveOfferTermsFrom(policy, 3, { role: 'engineer', level: 'l2' })).toEqual({
      shares: 4_000, vestingDays: 1460, cliffDays: 365, startRule: 'start_date', policyVersion: 3,
    });
    expect(resolveOfferTermsFrom(policy, 3, { role: 'Engineer', level: 'L2', overrides: { shares: 10_000, vestingDays: 365, cliffDays: 0 } })).toMatchObject({
      shares: 10_000, vestingDays: 365, cliffDays: 0,
    });
  });
});

describe('SPEC-P-003-D — the policy settings schema has no field that controls who can see equity or pay terms', () => {
  it('lists no visibility-shaped field among the policy or offer-bound keys', () => {
    const fields = [...POLICY_SETTING_KEYS, ...Object.keys(DEFAULT_EQUITY_POLICY.offerBounds)];
    for (const field of fields) expect(field).not.toMatch(/visib|viewer|audience|see|show|hid|private|public|access|reveal|disclos/i);
  });

  it('refuses a visibility setting as an unknown field rather than storing it', () => {
    for (const key of ['compensationVisibility', 'equityVisibleTo', 'hidePayTerms']) {
      expect(code(() => validatePolicySettings({ ...base(), [key]: 'admins' }))).toBe('unknown_field');
    }
  });
});

describe('policy changes and chain calls', () => {
  it('reports exactly the changed fields', () => {
    const next = validatePolicySettings({ ...base(), cliffDays: 180, returnRateBps: 500 });
    expect(changedPolicyFields(base(), next)).toEqual(['cliffDays', 'returnRateBps']);
  });

  it('ignores object key order, as a document read back from jsonb has its keys reordered', () => {
    const b = base().offerBounds;
    const reordered = { ...base(), offerBounds: { cliffDaysMax: b.cliffDaysMax, sharesMin: b.sharesMin, vestingDaysMax: b.vestingDaysMax, cliffDaysMin: b.cliffDaysMin, sharesMax: b.sharesMax, vestingDaysMin: b.vestingDaysMin } };
    expect(changedPolicyFields(reordered, base())).toEqual([]);
  });

  it('plans only admin-class contract calls, and none for an off-chain change', () => {
    const offChain = validatePolicySettings({ ...base(), cliffDays: 180 });
    expect(planChainPolicyCalls(base(), offChain)).toEqual([]);
    const onChain = validatePolicySettings({ ...base(), perGrantLimitShares: 9_000, offerBounds: { ...base().offerBounds, sharesMax: 9_000 }, returnRateBps: 500, returnIntervalDays: 45 });
    const calls = planChainPolicyCalls(base(), onChain);
    expect(calls).toEqual([
      { functionName: 'setGrantLimit', args: ['9000'] },
      { functionName: 'setReturnPolicy', args: ['500', String(45 * 86_400)] },
    ]);
    for (const call of calls) expect(EQUITY_V2_FUNCTION_CLASSES[call.functionName].class).toBe('admin');
  });
});
