import { describe, it, expect } from 'vitest';
import { defaultDaoLaunchSections, projectDaoLaunch, daoLaunchSectionsSchema, createDaoLaunchSchema, updateDaoLaunchSchema, daoFundingExample, type DaoLaunchRecord } from './dao-launch';

export function preparedDaoRecord(): DaoLaunchRecord {
  const sections = defaultDaoLaunchSections('Founder');
  sections.purpose = 'Build together';
  sections.governance.prepared = true;
  sections.funding.prepared = true;
  sections.funding.agreementReference = 'agreement-v1';
  sections.legal = { route: 'existing', country: 'US', entityName: 'Example LLC', registrationReference: 'registration-1', documentReference: 'charter-1', advisor: 'Counsel', reviewState: 'prepared' };
  sections.banking = { provider: 'Business bank', applicationReference: 'application-1', reservePlan: 'Operating, credits, taxes, refunds, DAO payable', chain: 'Base', safeAddress: '', signers: ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40), '0x' + '3'.repeat(40)], threshold: 2, prepared: true };
  return { id: 'org-1', name: 'Example', creatorId: 'user-1', revision: 3, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', sections, reviewedRevision: null };
}

describe('DAO launch preparation', () => {
  it('starts with one genuine founding record and no invented approvals or balance', () => {
    const record = preparedDaoRecord(); record.sections = defaultDaoLaunchSections('Current person'); record.sections.purpose = 'Our purpose';
    const projection = projectDaoLaunch(record);
    expect(projection.completedSteps).toBe(1);
    expect(projection.sections.founders).toEqual([{ name: 'Current person', contact: '', role: 'owner' }]);
    expect(projection.steps.find(s => s.id === 'governance')?.state).toBe('next');
    expect(projection.treasuryBalance).toBeNull();
    expect(projection.fundingActive).toBe(false);
  });
  it('keeps prepared banking waiting on legal preparation, even if its fields are complete', () => {
    const record = preparedDaoRecord(); record.sections.legal.reviewState = 'in-review';
    expect(projectDaoLaunch(record).steps.find(s => s.id === 'banking')?.state).toBe('waiting');
    expect(projectDaoLaunch(record).preparationReady).toBe(false);
  });
  it('requires a revenue agreement and an eligible ownership register for those models', () => {
    const record = preparedDaoRecord(); record.sections.funding.agreementReference = ''; record.sections.governance.voting = 'ownership';
    const step = projectDaoLaunch(record).steps.find(s => s.id === 'governance')!;
    expect(step.missing).toContain('Revenue agreement reference');
    expect(step.missing).toContain('Ownership register reference');
    record.sections.funding.basis = 'contributions';
    expect(projectDaoLaunch(record).steps.find(s => s.id === 'governance')?.missing).not.toContain('Revenue agreement reference');
  });
  it('binds review to an exact version and never enables funding through preparation', () => {
    const record = preparedDaoRecord(); record.reviewedRevision = record.revision;
    expect(projectDaoLaunch(record).completedSteps).toBe(5);
    expect(projectDaoLaunch(record).preparationReady).toBe(true);
    expect(projectDaoLaunch(record).fundingActive).toBe(false);
    record.revision++;
    expect(projectDaoLaunch(record).preparationReady).toBe(false);
  });
  it('rejects contradictory numeric rules and duplicate signer identities', () => {
    const sections = preparedDaoRecord().sections;
    sections.governance.approvalBps = 5000;
    expect(daoLaunchSectionsSchema.safeParse(sections).success).toBe(false);
    sections.governance.approvalBps = 6700;
    sections.banking.signers = ['0x' + 'a'.repeat(40), '0x' + 'A'.repeat(40)];
    expect(daoLaunchSectionsSchema.safeParse(sections).success).toBe(false);
    sections.banking.signers = ['0x' + '1'.repeat(40)];
    expect(daoLaunchSectionsSchema.safeParse(sections).success).toBe(false);
  });
  it.each([
    ['quorumBps', 1, 10_000], ['approvalBps', 5_001, 10_000], ['votingDays', 1, 365],
  ] as const)('accepts %s bounds and rejects values outside them or fractional values', (field, min, max) => {
    const sections = preparedDaoRecord().sections;
    for (const value of [min, max]) {
      sections.governance[field] = value;
      expect(daoLaunchSectionsSchema.safeParse(sections).success).toBe(true);
    }
    for (const value of [min - 1, max + 1, min + 0.5]) {
      sections.governance[field] = value;
      expect(daoLaunchSectionsSchema.safeParse(sections).success).toBe(false);
    }
  });
  it('preserves both delegation settings and rejects non-boolean choices', () => {
    const sections = preparedDaoRecord().sections;
    for (const delegation of [true, false]) {
      sections.governance.delegation = delegation;
      const parsed = daoLaunchSectionsSchema.parse(sections);
      expect(parsed.governance.delegation).toBe(delegation);
    }
    expect(daoLaunchSectionsSchema.safeParse({ ...sections, governance: { ...sections.governance, delegation: 'false' } }).success).toBe(false);
  });
  it('rejects workspace overrides, fabricated verification and empty organization names', () => {
    expect(createDaoLaunchSchema.safeParse({ name: ' ', purpose: 'Test' }).success).toBe(false);
    expect(createDaoLaunchSchema.safeParse({ name: 'Example', purpose: 'Test', workspaceId: 'other' }).success).toBe(false);
    expect(updateDaoLaunchSchema.safeParse({ name: 'Example', expectedRevision: 1, sections: preparedDaoRecord().sections, fundingActive: true }).success).toBe(false);
  });
  it('calculates integer-cent examples with conserved amounts and refuses invalid shares', () => {
    expect(daoFundingExample(1000)).toEqual({ eligibleCents: 100000, daoCents: 10000, remainingCents: 90000 });
    const fractional = daoFundingExample(3333, 101);
    expect(fractional.daoCents + fractional.remainingCents).toBe(101);
    expect(() => daoFundingExample(-1)).toThrow();
    expect(() => daoFundingExample(10_001)).toThrow();
  });
});
