import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { unmeasuredSourceEvidence, type CodeIntelAnswer } from './contracts';
import { sourceRuntimeProvenance } from './source-runtime-provenance';

const captured = createHash('sha256').update('captured compiler input').digest('hex');
const edited = createHash('sha256').update('later edit').digest('hex');
const artifact = 'a'.repeat(40);
const root = '/native-runtime-private-fixture';
const answer = (count = 1): CodeIntelAnswer => {
  const base: CodeIntelAnswer = { backend: 'typescript-service', intent: 'definition', query: 'target', sites: [],
    truncation: { truncated: false, totalAvailable: 0, continuation: null },
    freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null };
  const evidence = unmeasuredSourceEvidence(base, { repositoryId: 'private-repo', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
  return { ...base, evidence: { ...evidence, sourceScope: { ...evidence.sourceScope, sourceFingerprint: captured,
    supportingFiles: Array.from({ length: count }, (_, i) => ({ path: `source${i}.ts`, contentHash: captured,
      language: 'typescript', representation: 'full-source' })) } } };
};
const pipeline = (contains = false) => ({ repoRoot: root, submodule: null,
  acceptedSource: { expectedSha256: captured, observedSha256: captured, matches: true,
    runtimeContainment: { 'release-operator': contains, 'staging-operator': true } },
  servingRuntimes: [
    { runtime: 'release-operator', buildSha: artifact, codeSource: 'release-checkout', method: 'blob', containsChange: contains },
    { runtime: 'staging-operator', buildSha: 'b'.repeat(40), codeSource: 'staging-checkout', method: 'blob', containsChange: true },
  ] });

describe('native P017 captured source to selected runtime join', () => {
  it('keeps a newer source distinct from the release artifact even when staging contains it', async () => {
    const dispatch = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(pipeline()) }] }));
    const result = await sourceRuntimeProvenance(answer(), 'release-operator', root, dispatch);
    expect(result).toMatchObject({ repositoryId: 'private-repo', sourceFingerprint: captured,
      files: [{ capturedSourceSha256: captured, editedSourceSha256: captured,
        artifact: { buildSha: artifact }, containsCapturedSource: false }] });
    expect(dispatch).toHaveBeenCalledWith('dev:pipeline_position', expect.objectContaining({ path: 'source0.ts', expectedSourceSha256: captured,
      sourceRuntimeOnly: true }));
    expect(dispatch).not.toHaveBeenCalledWith('dev:pipeline_position', expect.objectContaining({ view: expect.anything() }));
    expect(result.files[0]!.artifact.buildSha).not.toBe(result.sourceFingerprint);
    expect((await sourceRuntimeProvenance(answer(), 'staging-operator', root, dispatch)).files[0]!.containsCapturedSource).toBe(true);
  });

  it('preserves the captured hash and artifact identity when a later edit invalidates the join', async () => {
    const data = pipeline(true);
    data.acceptedSource.observedSha256 = edited;
    data.acceptedSource.matches = false;
    const result = await sourceRuntimeProvenance(answer(), 'release-operator', root, async () => ({ data }));
    expect(result.files[0]).toMatchObject({ capturedSourceSha256: captured, editedSourceSha256: edited,
      artifact: { buildSha: artifact }, containsCapturedSource: null });
    expect(result.files[0]!.reason).toMatch(/differs/);
  });

  it.each(['repository', 'binding', 'identity', 'containment', 'scope', 'error'] as const)(
    'refuses an untrustworthy %s measurement', async fault => {
      const data = pipeline(true);
      if (fault === 'repository') data.repoRoot = '/different-repository';
      if (fault === 'binding') data.acceptedSource.expectedSha256 = edited;
      if (fault === 'identity') data.servingRuntimes[0]!.buildSha = '';
      if (fault === 'containment') data.servingRuntimes[0]!.containsChange = false;
      if (fault === 'scope') data.servingRuntimes = data.servingRuntimes.slice(1);
      const result = await sourceRuntimeProvenance(answer(), 'release-operator', root,
        async () => fault === 'error' ? { isError: true, data } : { structuredContent: data });
      expect(result.files[0]!.containsCapturedSource).toBeNull();
      expect(result.files[0]!.reason).toBeTruthy();
    });

  it('bounds supporting-file probes and reports the unmeasured remainder', async () => {
    const dispatch = vi.fn(async () => pipeline());
    const result = await sourceRuntimeProvenance(answer(6), 'release-operator', root, dispatch, 2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.files).toHaveLength(2);
    expect(result.omittedFiles).toBe(4);
    expect(result.limitations.join(' ')).toMatch(/omitted files remain unmeasured/);
  });

  it('answers with explicit uncertainty when transport is missing or a probe never settles', async () => {
    expect((await sourceRuntimeProvenance(answer(), 'release-operator', root)).files[0]!.reason).toMatch(/transport/);
    const result = await sourceRuntimeProvenance(answer(), 'release-operator', root, () => new Promise(() => {}), 1, 5);
    expect(result.files[0]).toMatchObject({ containsCapturedSource: null, artifact: { buildSha: null } });
    expect(result.files[0]!.reason).toMatch(/budget/);
  });
});
