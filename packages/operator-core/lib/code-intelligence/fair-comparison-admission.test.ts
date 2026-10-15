import { describe, expect, it } from 'vitest';
import { admitArm, ARM_ADMISSIONS, INCUMBENT_ARM_ID, type ArmAdmission } from './fair-comparison-admission';

/** A recorded, hash-pinned third-party candidate; tests vary only its licence. */
const candidate: ArmAdmission = {
  armId: 'example-candidate',
  upstream: 'example/candidate',
  spdx: 'PolyForm-Noncommercial-1.0.0',
  licence: 'noncommercial',
  licenceSha256Prefix: '0123456789abcdef',
  telemetryDefault: 'none',
  telemetryOffEnv: {},
};

describe('P-017 arm admission (D-011)', () => {
  it('admits every recorded arm and returns its telemetry-off environment', () => {
    for (const a of ARM_ADMISSIONS) expect(() => admitArm(a.armId)).not.toThrow();
    expect(admitArm('codegraph').env).toEqual({ CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' });
    expect(admitArm('trace-mcp').env).toEqual({ TRACE_MCP_TELEMETRY: 'off' });
  });

  it('resolves a versioned arm id to its engine admission', () => {
    expect(admitArm('gitnexus@1.6.9').admission.licence).toBe('noncommercial');
  });

  it('refuses an arm whose licence was never read', () => {
    expect(() => admitArm('sverklo')).toThrow(/no admission record/);
  });

  it('refuses a candidate whose licence is not permissive (SPEC-P-017)', () => {
    expect(() => admitArm('example-candidate@1.0.0', [...ARM_ADMISSIONS, candidate])).toThrow(/not a permissive licence/);
    // Positive control: the identical record under a permissive licence is admitted,
    // so the refusal above is about the licence and not about the injected record.
    const permissive = { ...candidate, spdx: 'MIT', licence: 'permissive' as const };
    expect(admitArm('example-candidate', [...ARM_ADMISSIONS, permissive]).admission.spdx).toBe('MIT');
  });

  it('refuses a candidate whose LICENSE file was never pinned', () => {
    const unpinned = { ...candidate, spdx: 'MIT', licence: 'permissive' as const, licenceSha256Prefix: null };
    expect(() => admitArm('example-candidate', [...ARM_ADMISSIONS, unpinned])).toThrow(/without a pinned LICENSE hash/);
  });

  it('admits exactly one non-permissive engine: the incumbent', () => {
    const nonPermissive = ARM_ADMISSIONS.filter((a) => a.licence !== 'permissive' && a.licence !== 'first-party');
    expect(nonPermissive.map((a) => a.armId)).toEqual([INCUMBENT_ARM_ID]);
    expect(() => admitArm(INCUMBENT_ARM_ID)).not.toThrow();
  });

  it('classifies licences consistently with their SPDX id', () => {
    for (const a of ARM_ADMISSIONS) {
      if (a.spdx === 'first-party') expect(a.licence).toBe('first-party');
      else if (/Noncommercial/i.test(a.spdx)) expect(a.licence).toBe('noncommercial');
      else expect(a.licence).toBe('permissive');
    }
  });

  it('records an opt-out for every engine whose telemetry is on by default', () => {
    const on = ARM_ADMISSIONS.filter((a) => /^ON\b/.test(a.telemetryDefault));
    expect(on.map((a) => a.armId).sort()).toEqual(['codegraph', 'trace-mcp']);
    for (const a of on) expect(Object.keys(a.telemetryOffEnv).length).toBeGreaterThan(0);
  });
});
