/**
 * R-1 (plan-verification-profiles-2026-10-17): the resolver returns a non-empty module
 * set for every cell of the profile-by-deliverable matrix, and for every inferred
 * signal it reads today. See ./plan-verification-profile.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DELIVERABLE_KINDS,
  DOMAIN_MODULES,
  EXECUTABLE_PROOF_CRITERIA,
  INFERRED_PLAN_PROFILE,
  PROFILE_DEFAULT_DELIVERABLE,
  VERIFICATION_MODULES,
  VERIFICATION_MODULE_CHECKS,
  VERIFICATION_PROFILES,
  describeVerificationProfile,
  executableProofExemption,
  isNonAutomatedBehaviorClass,
  isNonCodeAuditVerdict,
  isNonCodeWorkItemKind,
  isReasonedNonCodeAudit,
  modulesFor,
  resolveVerification,
  unfinishedItemsAreAuditedNonCode,
} from './plan-verification-profile';
import { ADEQUACY_CRITERIA } from './agent-tools/plans/spec-test-adequacy';

describe('resolveVerification: the declared profile x deliverable matrix', () => {
  for (const profile of VERIFICATION_PROFILES) {
    for (const deliverable of DELIVERABLE_KINDS) {
      it(`${profile} x ${deliverable} yields a module set`, () => {
        const r = resolveVerification({ verificationProfile: profile }, { deliverable });
        expect(r.profile).toBe(profile);
        expect(r.profileSource).toBe('declared');
        expect(r.deliverable).toBe(deliverable);
        expect(r.deliverableSource).toBe('declared');
        expect(r.modules.length).toBeGreaterThan(0);
        expect(r.modules[0]).toBe('generic-core');
        // D-001: the code module follows the deliverable, never the profile.
        expect(r.modules.includes('code')).toBe(deliverable === 'code');
        expect(r.codeDeliverable).toBe(deliverable === 'code');
      });
    }
  }

  it('every profile default yields a module set, and only coding defaults to code', () => {
    for (const profile of VERIFICATION_PROFILES) {
      const r = resolveVerification({ verificationProfile: profile }, {});
      expect(r.deliverableSource).toBe('profile-default');
      expect(r.deliverable).toBe(PROFILE_DEFAULT_DELIVERABLE[profile]);
      expect(r.modules.length).toBeGreaterThan(0);
      expect(r.codeDeliverable).toBe(profile === 'coding');
    }
  });

  it('opt-in domain modules are added in a stable order, on top of the core', () => {
    const r = resolveVerification(
      { verificationProfile: 'general' },
      { deliverable: 'artifact', domainModules: ['packaged-artifact', 'design-evidence'] },
    );
    expect(r.modules).toEqual(['generic-core', 'design-evidence', 'packaged-artifact']);
    expect(modulesFor(true, [...DOMAIN_MODULES])).toEqual(['generic-core', 'code', ...DOMAIN_MODULES]);
  });

  it('a declared deliverable outranks a contrary inferred signal', () => {
    const r = resolveVerification({}, { deliverable: 'code', auditVerdict: 'not-code', workItemKind: 'task' });
    expect(r.deliverableSource).toBe('declared');
    expect(r.codeDeliverable).toBe(true);
  });
});

describe('resolveVerification: P-001 inference from today\'s signals (no declared fields)', () => {
  it('infers the coding profile for every undeclared plan', () => {
    expect(INFERRED_PLAN_PROFILE).toBe('coding');
    const r = resolveVerification({}, {});
    expect(r).toMatchObject({ profile: 'coding', profileSource: 'inferred', deliverable: 'code', codeDeliverable: true });
    expect(r.modules).toEqual(['generic-core', 'code']);
  });

  it('a not-code audit verdict makes the item non-code with the core module only', () => {
    const r = resolveVerification({}, { auditVerdict: 'not-code' });
    expect(r).toMatchObject({ deliverable: null, codeDeliverable: false, deliverableSource: 'audit-verdict' });
    expect(r.modules).toEqual(['generic-core']);
  });

  it('a task work-item kind makes the item non-code, matching the existing case-insensitive rule', () => {
    for (const kind of ['task', ' TASK ', 'Task']) {
      const r = resolveVerification({}, { workItemKind: kind });
      expect(r).toMatchObject({ codeDeliverable: false, deliverableSource: 'work-item-kind' });
      expect(r.modules).toEqual(['generic-core']);
    }
  });

  it('every other audit verdict and work-item kind leaves the item a code deliverable', () => {
    for (const auditVerdict of ['implemented', 'partial', 'missing', 'dropped', null, undefined]) {
      for (const workItemKind of ['bug', 'change', 'feature', '', null, undefined]) {
        const r = resolveVerification({}, { auditVerdict, workItemKind });
        expect(r.codeDeliverable).toBe(true);
        expect(r.modules).toEqual(['generic-core', 'code']);
      }
    }
  });

  it('values outside the vocabulary are ignored, never thrown on and never module-less', () => {
    const r = resolveVerification({ verificationProfile: 'bogus' }, { deliverable: 'spreadsheet' });
    expect(r).toMatchObject({ profile: 'coding', profileSource: 'inferred', deliverableSource: 'profile-default' });
    expect(r.modules.length).toBeGreaterThan(0);
  });
});

describe('the module list', () => {
  it('names checks for every module, and the generic core carries independent grading (D-002)', () => {
    for (const module of VERIFICATION_MODULES) {
      expect(VERIFICATION_MODULE_CHECKS[module].length).toBeGreaterThan(0);
    }
    expect(VERIFICATION_MODULE_CHECKS['generic-core']).toEqual(
      expect.arrayContaining(['independent-grading', 'implementer-verdict', 'rubric-vetting']),
    );
    expect(VERIFICATION_MODULE_CHECKS.code).toEqual(
      expect.arrayContaining(['code-truth-audit', 'spec-test-adequacy']),
    );
  });

  it('every executable-proof criterion is a real adequacy criterion', () => {
    for (const criterion of EXECUTABLE_PROOF_CRITERIA) expect(ADEQUACY_CRITERIA).toContain(criterion);
  });
});

describe('the routed exemption predicates', () => {
  it('match their signal exactly', () => {
    expect(isNonCodeAuditVerdict('not-code')).toBe(true);
    expect(isNonCodeAuditVerdict('Not-Code')).toBe(false);
    expect(isNonCodeAuditVerdict(undefined)).toBe(false);
    expect(isNonCodeWorkItemKind(' TASK ')).toBe(true);
    expect(isNonCodeWorkItemKind('bug')).toBe(false);
    expect(isNonCodeWorkItemKind(null)).toBe(false);
    expect(isNonAutomatedBehaviorClass('non-automated')).toBe(true);
    expect(isNonAutomatedBehaviorClass('happy-path')).toBe(false);
    expect(isReasonedNonCodeAudit({ verdict: 'not-code', note: 'a doc' })).toBe(true);
    expect(isReasonedNonCodeAudit({ verdict: 'not-code', note: '   ' })).toBe(false);
    expect(isReasonedNonCodeAudit({ verdict: 'implemented', note: 'x' })).toBe(false);
    expect(isReasonedNonCodeAudit(undefined)).toBe(false);
  });

  it('executableProofExemption checks the kind first, then a non-automated clause with no layers', () => {
    expect(executableProofExemption({ workItemKind: 'task', behaviorClass: 'happy-path', requiredTestLayers: ['unit'] }))
      .toBe('non-code-work-item-kind');
    expect(executableProofExemption({ behaviorClass: 'non-automated', requiredTestLayers: [] }))
      .toBe('non-automated-clause');
    expect(executableProofExemption({ behaviorClass: 'non-automated', requiredTestLayers: ['unit'] })).toBeNull();
    expect(executableProofExemption({ workItemKind: 'bug', behaviorClass: 'happy-path', requiredTestLayers: [] })).toBeNull();
  });

  it('unfinishedItemsAreAuditedNonCode needs every unfinished item audited not-code', () => {
    const audits = [
      { entry: { itemId: 'P-001', verdict: 'not-code' } },
      { entry: { itemId: 'P-002', verdict: 'implemented' } },
    ];
    expect(unfinishedItemsAreAuditedNonCode([{ itemId: 'P-001' }], audits)).toBe(true);
    expect(unfinishedItemsAreAuditedNonCode([{ itemId: 'P-001' }, { itemId: 'P-002' }], audits)).toBe(false);
    expect(unfinishedItemsAreAuditedNonCode([{ itemId: 'P-003' }], audits)).toBe(false);
    expect(unfinishedItemsAreAuditedNonCode([], audits)).toBe(false);
  });
});

describe('describeVerificationProfile (P-004: every refusal names the profile)', () => {
  it('names a stamped profile with its recorded source', () => {
    expect(describeVerificationProfile({ verificationProfile: 'general', verificationProfileSource: 'declared' }))
      .toBe("Verification profile 'general' (declared)");
    expect(describeVerificationProfile({ verificationProfile: 'coding', verificationProfileSource: 'harness-default' }))
      .toBe("Verification profile 'coding' (harness-default)");
    expect(describeVerificationProfile({ verificationProfile: 'coding', verificationProfileSource: 'backfill' }))
      .toBe("Verification profile 'coding' (backfill)");
  });

  it('says "stamped" when the profile is valid but its source is not a known one', () => {
    expect(describeVerificationProfile({ verificationProfile: 'general', verificationProfileSource: null }))
      .toBe("Verification profile 'general' (stamped)");
    expect(describeVerificationProfile({ verificationProfile: 'general', verificationProfileSource: 'bogus' }))
      .toBe("Verification profile 'general' (stamped)");
  });

  it('names the inferred coding profile for an unstamped or invalid profile', () => {
    expect(describeVerificationProfile({})).toBe("Verification profile 'coding' (unstamped, inferred)");
    expect(describeVerificationProfile({ verificationProfile: 'weird', verificationProfileSource: 'declared' }))
      .toBe("Verification profile 'coding' (unstamped, inferred)");
  });
});
