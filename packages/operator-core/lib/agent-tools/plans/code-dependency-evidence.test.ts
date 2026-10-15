import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeIntelAnswer } from '../../code-intelligence/contracts';
import { assertCodeDependencyVersions, captureCodeDependencies, dependencyQueriesSchema } from './code-dependency-evidence';
import type { MeasurementPin } from './spec-evidence-store';

const roots: string[] = [];
const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const, sourcePaths: ['consumer.ts'] };
const selectors = [{ name: 'consumer', file: 'consumer.ts', paths: ['.'] }];
const digest = 'a'.repeat(64);
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-dependency-evidence-')));
  roots.push(root);
  const sources = ['consumer.ts', 'dependency.ts'].map(path => ({ path, contentHash: digest,
    language: 'typescript', representation: 'full-source' as const }));
  const answer: CodeIntelAnswer = { backend: 'typescript-service', intent: 'impact', query: 'consumer',
    sites: [{ path: 'consumer.ts', line1: 1, name: 'consumer', kind: 'function' }],
    truncation: { truncated: false, totalAvailable: 1, continuation: null },
    freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null,
    evidence: { schemaVersion: 1, sourceScope: {
      repositoryId: `local-root:${createHash('sha256').update(root).digest('hex')}`, identityKind: 'local-root',
      sourceFingerprint: digest, paths: ['.'], supportingFiles: sources },
      graphScope: { basis: 'compiler-project', sourceCompleteness: 'unverified', limitations: ['Bounded project.'] },
      languageCapabilities: [], siteIdentities: [], relationships: [
        { siteIndex: 0, kind: 'definition', origin: 'compiler', knowledge: 'observed', runtimeExecution: 'unknown' },
      ] },
  };
  const pin: MeasurementPin = { schemaVersion: 1,
    files: sources.map(source => ({ path: source.path, dimension: 'source' as const,
      sha256: digest, repo: '.', headBlob: null, clean: null })), repos: [] };
  return { root, answer, pin };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('native dependency evidence capture', () => {
  it('adds measured dependency files without changing test paths and preserves graph limitations', async () => {
    const f = await fixture();
    const captured = await captureCodeDependencies(f.root, { ...recipe, testPaths: ['test.ts'] }, selectors, async () => f.answer);
    expect(captured.measurement).toEqual({ ...recipe, sourcePaths: ['consumer.ts', 'dependency.ts'], testPaths: ['test.ts'] });
    expect(captured.evidence.snapshots[0]!.limitations).toEqual(['Bounded project.']);
    expect(() => assertCodeDependencyVersions(captured.evidence.sources, f.pin)).not.toThrow();
    f.pin.files[1]!.sha256 = 'b'.repeat(64);
    expect(() => assertCodeDependencyVersions(captured.evidence.sources, f.pin)).toThrow('does_not_match_measured_source');
  });
  it.each(['error', 'truncated', 'repository', 'stub', 'syntax'] as const)('refuses %s evidence', async fault => {
    const f = await fixture();
    const answer = { ...f.answer,
      ...(fault === 'error' ? { error: 'compiler failed' } : {}),
      ...(fault === 'truncated' ? { truncation: { ...f.answer.truncation, truncated: true } } : {}),
      evidence: { ...f.answer.evidence!, sourceScope: { ...f.answer.evidence!.sourceScope,
        ...(fault === 'repository' ? { repositoryId: 'other' } : {}),
        supportingFiles: f.answer.evidence!.sourceScope.supportingFiles.map(source => fault === 'stub'
          ? { ...source, representation: 'reexport-stub' as const } : source) },
        relationships: f.answer.evidence!.relationships.map(edge => fault === 'syntax'
          ? { ...edge, origin: 'syntax' as const } : edge) },
    };
    await expect(captureCodeDependencies(f.root, recipe, selectors, async () => answer)).rejects.toThrow('code_dependency_');
  });
  it('refuses missing pin proof and dependency selectors escaping the repository', async () => {
    const f = await fixture();
    expect(() => assertCodeDependencyVersions(f.answer.evidence!.sourceScope.supportingFiles)).toThrow('does_not_match');
    expect(dependencyQueriesSchema.safeParse([{ ...selectors[0], file: '../other.ts' }]).success).toBe(false);
    expect(dependencyQueriesSchema.safeParse([{ ...selectors[0], paths: ['/other'] }]).success).toBe(false);
  });
});
