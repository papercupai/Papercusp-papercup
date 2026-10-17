import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createHiringOffer, looksLikeEmployment, offerPreview, runHiringAction, type HiringTerms } from './hiring';
const pay = { amount: '5000', currency: 'USD', cadence: 'monthly' as const };
const signals = { engagementType: 'contractor' as const, pay, managerPersonId: 'PER-manager', exclusive: true };
describe('SPEC-P-005-B — required pay fields before side effects', () => {
  it('calibrates the storage sentinel with a complete valid-pay control', async () => {
    const storageReached = new Error('calibration: valid pay reached storage');
    const query = vi.fn(() => { throw storageReached; });
    await expect(createHiringOffer({ workspaceId: 'ws-hiring-unit', daoSlug: 'hiring-dao',
      roleId: 'role', personId: 'PER-candidate', actorPersonId: 'PER-author',
      engagementType: 'contractor', jurisdiction: 'US', pay }, { sql: query as unknown as Sql }))
      .rejects.toBe(storageReached);
    expect(query).toHaveBeenCalled();
  });

  it.each(['amount', 'currency', 'cadence'] as const)('%s-missing is rejected before identity or database access', async field => {
    const missing: Record<string, unknown> = { ...pay };
    delete missing[field];
    const query = vi.fn(() => { throw new Error('Invalid pay must not reach storage'); });
    const viewerGithubId = vi.fn(async () => 101);
    const deps = { sql: query as unknown as Sql, viewerGithubId };
    const key = { workspaceId: 'ws-hiring-unit', daoSlug: 'hiring-dao' };
    const terms = { roleId: 'role', personId: 'PER-candidate', engagementType: 'contractor' as const,
      jurisdiction: 'US', pay: missing as unknown as HiringTerms['pay'] };

    await expect(createHiringOffer({ ...key, ...terms, actorPersonId: 'PER-author' }, deps))
      .rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining(field) });
    await expect(runHiringAction(key, { action: 'offer', ...terms }, deps))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(viewerGithubId).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
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
