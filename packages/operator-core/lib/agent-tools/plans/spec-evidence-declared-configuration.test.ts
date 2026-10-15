/**
 * P-011 (verification-system-improvements-2026-10-10), SPEC-P-011-NULL-FINGERPRINT: evidence
 * without a declared-configuration fingerprint never counts as current for a bar that declares
 * a production configuration. Covers the pure classifier dimension and the per-read resolver
 * that decides which pinned BARs declare one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';

import {
  classifySpecEvidenceCurrentness,
  declaredConfigurationReadSeam,
  resolveDeclaredConfigurations,
} from './spec-evidence-store';
import { declaredConfigurationFingerprint } from './declared-configuration';

const VIDEO = FLAGS.VIDEO_CHANNELS;
const DECLARED = { flags: { [VIDEO]: !FLAG_DEFAULTS[VIDEO] } };
const DECLARED_FP = declaredConfigurationFingerprint(DECLARED);
const OTHER_FP = declaredConfigurationFingerprint({ flags: { [VIDEO]: FLAG_DEFAULTS[VIDEO] } });

function row(details?: Record<string, unknown>) {
  return {
    spec_is_current: true,
    source_fingerprint: 'git:a',
    test_fingerprint: null,
    fixture_fingerprint: null,
    rubric_fingerprint: null,
    environment_fingerprint: null,
    coverage_evidence_ref: null,
    coverage_evidence_present: false,
    test_run_id: null,
    test_run_present: false,
    evidence_kind: 'test' as const,
    ...(details ? { details } : {}),
  };
}

const stamped = (declaredFingerprint: string, fingerprint = declaredFingerprint) => ({
  declaredConfiguration: { required: true, testRunId: 9, declaredFingerprint, fingerprint },
});

const classify = (r: ReturnType<typeof row>, declaredConfiguration?: Parameters<typeof classifySpecEvidenceCurrentness>[2] extends infer O ? O extends { declaredConfiguration?: infer D } ? D : never : never) =>
  classifySpecEvidenceCurrentness(r, { evidenceKind: 'test', evidenceRef: 'test_runs:9', sourceFingerprint: 'git:a' }, {
    provenance: 'server-measured',
    ...(declaredConfiguration ? { declaredConfiguration } : {}),
  });

describe('SPEC-P-011-NULL-FINGERPRINT: currentness of evidence for a configuration-declaring bar', () => {
  it('CONTROL: a bar that declares nothing classifies exactly as before, with no configuration dimension', () => {
    const result = classify(row());
    expect(result.overall).toBe('current');
    expect(result.dimensions).not.toHaveProperty('configuration');
  });

  it('never counts fingerprint-less evidence as current when the bar declares a configuration', () => {
    const result = classify(row(), { declaredFingerprint: DECLARED_FP });
    expect(result.dimensions.configuration).toBe('unknown');
    expect(result.overall).not.toBe('current');
    expect(result.unknownReasons).toContain('declared-configuration-fingerprint-not-recorded');
  });

  it('counts a bind-checked, stamped binding under the same declaration as current', () => {
    const result = classify(row(stamped(DECLARED_FP)), { declaredFingerprint: DECLARED_FP });
    expect(result.dimensions.configuration).toBe('current');
    expect(result.overall).toBe('current');
  });

  it('marks a stamp made under a different declaration stale', () => {
    const result = classify(row(stamped(OTHER_FP)), { declaredFingerprint: DECLARED_FP });
    expect(result.dimensions.configuration).toBe('stale');
    expect(result.staleReasons).toContain('configuration-stale');
  });

  it('does not trust a stamp whose run fingerprint differs from its declaration', () => {
    const result = classify(row(stamped(DECLARED_FP, 'sha256-declared-config-v1:forged')), {
      declaredFingerprint: DECLARED_FP,
    });
    expect(result.dimensions.configuration).toBe('unknown');
    expect(result.overall).not.toBe('current');
  });

  it('treats an unreadable declaration as unknown, never as "declares nothing"', () => {
    const result = classify(row(stamped(DECLARED_FP)), { unresolved: 'rubric read failed' });
    expect(result.dimensions.configuration).toBe('unknown');
    expect(result.unknownReasons).toContain('declared-configuration-unresolved:rubric read failed');
  });
});

describe('SPEC-P-011-NULL-FINGERPRINT: resolving which pinned BARs declare a configuration', () => {
  afterEach(() => {
    delete declaredConfigurationReadSeam.loadRubricCriteria;
  });

  const pin = (barKey: string, revision = 4) => ({
    source_rubric_slug: 'acceptance-config-plan',
    source_rubric_revision: revision,
    source_bar_key: barKey,
  });

  it('reads each pinned rubric revision once and keys declarations by BAR', async () => {
    const load = vi.fn(async () => [
      { key: 'R-11', productionConfiguration: DECLARED },
      { key: 'R-12' },
    ]);
    declaredConfigurationReadSeam.loadRubricCriteria = load;
    const resolved = await resolveDeclaredConfigurations([pin('R-11'), pin('R-12'), pin('R-11'), { source_bar_key: null }]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('acceptance-config-plan', 4);
    expect([...resolved.entries()]).toEqual([
      ['acceptance-config-plan@4:R-11', { declaredFingerprint: DECLARED_FP }],
    ]);
  });

  it('treats a BAR whose rubric revision is gone as declaring nothing', async () => {
    declaredConfigurationReadSeam.loadRubricCriteria = vi.fn(async () => null);
    expect((await resolveDeclaredConfigurations([pin('R-11')])).size).toBe(0);
  });

  it('marks a pin unresolved when the rubric read throws or the declaration is malformed', async () => {
    declaredConfigurationReadSeam.loadRubricCriteria = vi.fn(async (_slug: string, revision: number) => {
      if (revision === 5) throw new Error('db down');
      return [{ key: 'R-11', productionConfiguration: { flags: { [VIDEO]: 'yes' } } }];
    });
    const resolved = await resolveDeclaredConfigurations([pin('R-11', 4), pin('R-11', 5)]);
    expect(resolved.get('acceptance-config-plan@4:R-11')).toEqual({ unresolved: expect.stringMatching(/must be a boolean/) });
    expect(resolved.get('acceptance-config-plan@5:R-11')).toEqual({ unresolved: 'db down' });
  });
});
