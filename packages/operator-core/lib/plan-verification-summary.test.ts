/**
 * summarizePlanVerification — the checklist plans:get shows (plan-verification-profiles P-002, R-4).
 */
import { describe, expect, it } from 'vitest';
import { summarizePlanVerification } from './plan-verification-profile';

describe('summarizePlanVerification', () => {
  it('a declared general plan defaults items to a non-code deliverable held to the generic core only', () => {
    const s = summarizePlanVerification({ verificationProfile: 'general', verificationProfileSource: 'declared' }, [
      { id: 'P-001' },
    ]);
    expect(s).toEqual({
      profile: 'general',
      profileSource: 'declared',
      defaultDeliverable: 'artifact',
      defaultModules: ['generic-core'],
      overrides: [],
    });
  });

  it('a code item inside a general plan is listed as an override that pulls in the code module (D-001)', () => {
    const s = summarizePlanVerification({ verificationProfile: 'general', verificationProfileSource: 'harness-default' }, [
      { id: 'P-001', deliverable: 'code' },
      { id: 'P-002', deliverable: null },
      { id: 'P-003', deliverable: 'doc' },
    ]);
    expect(s.profileSource).toBe('harness-default');
    expect(s.overrides).toEqual([
      { id: 'P-001', deliverable: 'code', modules: ['generic-core', 'code'] },
      { id: 'P-003', deliverable: 'doc', modules: ['generic-core'] },
    ]);
  });

  it('an unstamped plan reports the inferred coding profile as unstamped', () => {
    const s = summarizePlanVerification({ verificationProfile: null, verificationProfileSource: null }, []);
    expect(s.profile).toBe('coding');
    expect(s.profileSource).toBe('unstamped');
    expect(s.defaultModules).toEqual(['generic-core', 'code']);
  });

  it('includes namespaced built-ins with the same modules as their aliases', () => {
    const s = summarizePlanVerification({ verificationProfile: 'general' }, [
      { id: 'P-001', deliverable: 'papercusp/doc' },
      { id: 'P-002', deliverable: 'papercusp/code' },
    ]);
    expect(s.overrides).toEqual([
      { id: 'P-001', deliverable: 'papercusp/doc', modules: ['generic-core'] },
      { id: 'P-002', deliverable: 'papercusp/code', modules: ['generic-core', 'code'] },
    ]);
  });

  it('ignores an unknown profile, source or deliverable word instead of inventing a checklist', () => {
    const s = summarizePlanVerification({ verificationProfile: 'lenient', verificationProfileSource: 'declared' }, [
      { id: 'P-001', deliverable: 'vibes' },
    ]);
    expect(s.profile).toBe('coding');
    expect(s.profileSource).toBe('unstamped');
    expect(s.overrides).toEqual([]);
    const badSource = summarizePlanVerification({ verificationProfile: 'general', verificationProfileSource: 'magic' }, []);
    expect(badSource.profile).toBe('general');
    expect(badSource.profileSource).toBe('unstamped');
  });
});
