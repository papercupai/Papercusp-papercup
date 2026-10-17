import { describe, expect, it, vi } from 'vitest';
import { resolveScorecardInstrumentSnapshots } from './scorecards';
import { platformComputedInstrumentKeys, getRegisteredInstrument } from './rubric-instrument-registry';
import { measureProviderPackageAcceptance, measureProviderVerificationClaims, measureRequestedProviderAdditions,
  PROVIDER_PACKAGE_INSTRUMENT_KEYS as keys, PROVIDER_PACKAGE_PLAN } from './integrations/provider-package-acceptance';
import type { Rubric } from './rubrics';

const rubric = { workspaceId: 'ws', subjectHarnessSlug: 'papercusp', subjectPlan: PROVIDER_PACKAGE_PLAN,
  criteria: Object.entries(keys).map(([key, instrumentKey]) => ({ key, check: { kind: 'instrument', instrumentKey } })) } as unknown as Rubric;
const subject = { kind: 'plan' as const, ref: PROVIDER_PACKAGE_PLAN };
const measured = () => ({ root: '/measured-serving-tree', additions: measureRequestedProviderAdditions([]), claims: measureProviderVerificationClaims([]) });

describe('registered provider-package outcome instruments', () => {
  it('registers both computed keys', () => {
    for (const key of Object.values(keys)) {
      expect(platformComputedInstrumentKeys()).toContain(key);
      expect(getRegisteredInstrument(key)?.evaluator).toBe('platform');
    }
  });
  it('overrides a supplied pass with one measured population failure and unknown claims', async () => {
    const providerPackages = vi.fn(async () => measured());
    const supplied = Object.fromEntries(Object.values(keys).map(key => [key, { verdict: 'pass' as const, measuredAt: '2026-10-16T00:00:00Z', provenance: 'platform-computed' as const }]));
    const result = await resolveScorecardInstrumentSnapshots({ rubric, subject, supplied }, { providerPackages });
    expect(providerPackages).toHaveBeenCalledTimes(1);
    expect(result?.[keys.additions]).toMatchObject({ verdict: 'fail', provenance: 'platform-computed', value: { root: '/measured-serving-tree' } });
    expect(result?.[keys.claims]).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed' });
  });
  it('refuses wrong-plan evidence and read failures without preserving supplied success', async () => {
    const providerPackages = vi.fn(async () => { throw new Error('unreadable'); });
    const wrong = await resolveScorecardInstrumentSnapshots({ rubric, subject: { ...subject, ref: 'another-plan' } }, { providerPackages });
    expect(wrong?.[keys.additions]?.verdict).toBe('unknown');
    expect(providerPackages).not.toHaveBeenCalled();
    const failed = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { providerPackages });
    expect(failed?.[keys.additions]?.verdict).toBe('unknown');
    expect(failed?.[keys.claims]?.verdict).toBe('unknown');
    expect(providerPackages).toHaveBeenCalledTimes(1);
  });
  it('never promotes a tree-only claims pass into whole-R7 acceptance', async () => {
    const measurement = measured();
    measurement.claims = { ...measurement.claims, verdict: 'pass', unknown: [] };
    const result = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { providerPackages: async () => measurement });
    expect(result?.[keys.claims]).toMatchObject({ verdict: 'unknown', value: { verdict: 'unknown', treeVerdict: 'pass',
      unresolved: ['Independent completion/report claims and live-run/approval evidence review.'] } });
  });
  it('the real current tree is measured through the same production reader', async () => {
    const measurement = await measureProviderPackageAcceptance();
    const result = await resolveScorecardInstrumentSnapshots({ rubric, subject });
    expect(result?.[keys.additions]?.verdict).toBe(measurement.additions.verdict);
    expect(result?.[keys.claims]?.verdict).toBe(measurement.claims.verdict === 'pass' ? 'unknown' : measurement.claims.verdict);
    expect(result?.[keys.additions]?.value).toMatchObject({ root: measurement.root, population: measurement.additions.population });
  });
});
