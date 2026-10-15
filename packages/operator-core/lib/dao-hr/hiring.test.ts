import { describe, expect, it } from 'vitest';
import { looksLikeEmployment, offerPreview, type HiringTerms } from './hiring';
const pay = { amount: '5000', currency: 'USD', cadence: 'monthly' as const };
const signals = { engagementType: 'contractor' as const, pay, managerPersonId: 'PER-manager', exclusive: true };
describe('SPEC-P-005-C/D — contractor employment signals', () => {
  it('flags only the conjunction of all three employment signals', () => {
    expect(looksLikeEmployment(signals)).toBe(true);
    expect(looksLikeEmployment({ ...signals, engagementType: 'employee' })).toBe(false);
  });
  it.each([
    ['no-fixed-cadence', { ...signals, pay: { ...pay, cadence: 'per-milestone' as const } }],
    ['no-manager', { ...signals, managerPersonId: null }],
    ['not-exclusive', { ...signals, exclusive: false }],
  ])('%s carries no employment flag', (_, input) => expect(looksLikeEmployment(input)).toBe(false));
});
describe('SPEC-P-005 / E — offer shares and fully diluted preview', () => {
  const terms: HiringTerms = { engagementType: 'contractor', jurisdiction: 'US', pay, employmentLike: false,
    equity: { shares: 1000, vestingDays: 1460, cliffDays: 365, startRule: 'start_date', policyVersion: 1 } };
  it('includes the proposed grant, and changes when the chain reader totals change', () => {
    expect(offerPreview(terms, { issuedShares: '8000', reservedShares: '1000' })).toMatchObject({ offeredShares: '1000', proposedFullyDilutedShares: '10000', fullyDilutedPercent: '10.00' });
    expect(offerPreview(terms, { issuedShares: '18000', reservedShares: '1000' }).fullyDilutedPercent).toBe('5.00');
  });
});
