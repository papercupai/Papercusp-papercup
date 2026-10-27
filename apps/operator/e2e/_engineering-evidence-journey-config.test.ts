import { describe, expect, it } from 'vitest';
import { validateEngineeringJourneyInputs } from './_engineering-evidence-journey-config';

const input = () => ({ workspaceId: 'workspace-fixture', clientId: 'session-fixture', buildSha: 'a'.repeat(40), plan: 'ee-feature', item: 'P-001', harness: 'papercusp',
  symbol: { path: 'src/feature.ts', name: 'feature' }, spec: { id: 'EE-1', revision: 2 }, decisionId: 'D-001',
  runId: 72101, caseKey: 'exact-case', occurrence: 2,
  observation: { invocationId: 'invocation-fixture', traceId: 'b'.repeat(32), spanId: 'c'.repeat(16),
    sourceFingerprint: 'd'.repeat(64), artifactFingerprint: 'e'.repeat(64), environmentFingerprint: 'f'.repeat(64) },
  sourcePins: [{ path: 'src/feature.ts', sha256: 'd'.repeat(64) }],
  stale: { plan: 'ee-feature', item: 'P-002' }, unobserved: { plan: 'ee-feature', item: 'P-003' } });
describe('live engineering journey proof admission', () => {
  it('requires frozen exact identities and negative controls rather than a saved pass or guessed trace', () => {
    expect(validateEngineeringJourneyInputs(input())).toEqual(input());
    for (const patch of [{ workspaceId: '' }, { clientId: '' }, { buildSha: 'a'.repeat(10) }, { runId: 0 }, { occurrence: 0 }, { spec: { id: 'EE-1' } },
      { observation: {} }, { sourcePins: [] }, { stale: null }, { unobserved: null }])
      expect(() => validateEngineeringJourneyInputs({ ...input(), ...patch })).toThrow(/exact canonical/);
  });
  it('refuses escaping or duplicate accepted-source paths and malformed source/trace hashes', () => {
    for (const path of ['/private/feature.ts', '../feature.ts', 'src/../feature.ts'])
      expect(() => validateEngineeringJourneyInputs({ ...input(), sourcePins: [{ path, sha256: 'd'.repeat(64) }] })).toThrow();
    expect(() => validateEngineeringJourneyInputs({ ...input(), sourcePins: [...input().sourcePins, ...input().sourcePins] })).toThrow();
    expect(() => validateEngineeringJourneyInputs({ ...input(), observation: { ...input().observation, spanId: 'invented' } })).toThrow();
  });
});
