import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifierSourceFiles } from './verifier-source';

const sourcePreview = vi.hoisted(() => ({ prepareVerifierSource: vi.fn(), prepareVerifierDependencies: vi.fn() }));
vi.mock('../../../scripts/source-preview.mjs', () => sourcePreview);

import { produceCommittedReaderOriginalPreparation, qualifyCommittedReaderOriginalPreparation,
  withCommittedReaderOriginalPreparation } from '../test/private-http-workspace-preflight';
import type { CommittedReaderCallerContract } from '../test/private-http-workspace-preflight';
import type { CommittedReaderObservationCohort, CommittedReaderObservationIdentity,
  CommittedReaderPreparationHandoff } from '../test/isolated-integration-proof';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
const testPath = 'packages/operator-core/lib/agent-tools/plans/committed-tree-reader-http.integration.test.ts';
const helperPaths = ['packages/operator-core/test/staging-first-http-fixture.ts', 'apps/operator/bin/bundle-host.sh'];
const configPaths = ['package.json', 'packages/operator-core/vitest.integration.config.ts'];

function fixtureSource(root: string, sourceCommit: string) {
  const paths = [testPath, ...helperPaths, ...configPaths, 'src/main.ts'];
  for (const path of paths) {
    const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `// ${path}\n`);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reader-preparation-fixture', private: true }));
  const builder = join(root, 'apps/operator/bin/bundle-host.sh');
  writeFileSync(builder, `#!/bin/bash
set -e
mkdir -p "$(dirname "$2")"
printf 'independent-bundle' > "$2"
cat > "$2.meta.json" <<'GRAPH'
{"inputs":{"src/main.ts":{"imports":[{"path":"example","external":true}]}},"outputs":{"hono-host.mjs":{"imports":[{"path":"example","external":true}]}}}
GRAPH
`);
  chmodSync(builder, 0o755);
  const sourceManifest = { schemaVersion: 'verifier-source-v1', sourceCommit,
    testedInputs: [{ path: testPath, sha256: digest(readFileSync(join(root, testPath))) }],
    files: verifierSourceFiles(root), submodules: [] };
  writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(sourceManifest));
  return sourceManifest;
}

beforeEach(() => {
  vi.clearAllMocks();
  sourcePreview.prepareVerifierSource.mockImplementation(async ({ ref, dest }: { ref: string; dest: string }) =>
    fixtureSource(dest, ref));
  sourcePreview.prepareVerifierDependencies.mockImplementation(async ({ dest }: { dest: string }) => {
    const example = join(dest, 'node_modules/example'); mkdirSync(example, { recursive: true });
    writeFileSync(join(example, 'package.json'), JSON.stringify({ name: 'example', main: 'index.js' }));
    writeFileSync(join(example, 'index.js'), 'module.exports = 1;');
  });
});

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** These are synthetic contract controls, not evidence of an actual collected
 * loader/config/schema/environment cohort or an independently qualified host. */
function originalFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'reader-original-preparation-test-')); roots.push(parent);
  const repositoryRoot = join(parent, 'repo'); mkdirSync(repositoryRoot);
  const root = join(parent, 'original-source'); mkdirSync(root);
  const selectedCommit = 'a'.repeat(40);
  const source = fixtureSource(root, selectedCommit);
  const dependency = join(root, 'node_modules/example'); mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'index.js'), 'module.exports = 1;');
  const schema = { 'harness_shared.tool_invocations.args_json': digest('jsonb:not-null') };
  const environment = { PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_SKIP_PG_DISCOVERY: '1' };
  const inputs = { sourceCommit: selectedCommit, phase: 'planned', testPaths: [testPath],
    helperPaths: [...helperPaths].sort(), configPaths: [...configPaths].sort(), executedImports: ['src/main.ts'],
    dependencyFiles: verifierSourceFiles(join(root, 'node_modules')),
    externalResolutions: { example: 'node_modules/example/index.js' }, copiedSources: [], copiedArtifacts: [],
    schema, environment: Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, digest(value)])),
    omitted: [] as string[], opaque: [] as string[] };
  const handoff: CommittedReaderPreparationHandoff = { root, selectedCommit,
    sourceReceiptPath: join(parent, 'source.json'), sourceReceiptSha256: '',
    inputReceiptPath: join(parent, 'inputs.json'), inputReceiptSha256: '',
    observationReceiptPath: join(parent, 'observations.json'), observationReceiptSha256: '' };
  const identity = { sourceCommit: selectedCommit, runId: 'original-reference-run',
    process: { pid: 42, identity: 'original-reference-process-start' } };
  const values = { source, dependencies: { files: inputs.dependencyFiles, externalResolutions: inputs.externalResolutions },
    config: inputs.configPaths, imports: inputs.executedImports, schema, environment: inputs.environment };
  const cohort: CommittedReaderObservationCohort = { ...structuredClone(identity), sourceRoot: root,
    sourceReceipt: { path: handoff.sourceReceiptPath, sha256: '' },
    inputReceipt: { path: handoff.inputReceiptPath, sha256: '' },
    observations: Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, { ...structuredClone(identity), value: structuredClone(value) }])) as CommittedReaderObservationCohort['observations'],
    omitted: [], opaque: [] };
  const save = () => {
    writeFileSync(handoff.sourceReceiptPath, JSON.stringify(source));
    writeFileSync(handoff.inputReceiptPath, JSON.stringify(inputs));
    handoff.sourceReceiptSha256 = digest(readFileSync(handoff.sourceReceiptPath));
    handoff.inputReceiptSha256 = digest(readFileSync(handoff.inputReceiptPath));
    cohort.sourceReceipt.sha256 = handoff.sourceReceiptSha256;
    cohort.inputReceipt.sha256 = handoff.inputReceiptSha256;
    writeFileSync(handoff.observationReceiptPath, JSON.stringify(cohort));
    handoff.observationReceiptSha256 = digest(readFileSync(handoff.observationReceiptPath));
  };
  save();
  const options = { repositoryRoot, workRoot: join(parent, 'consumer-preparation'), selectedCommit,
    testPath, helperPaths, configPaths, schema, environment, original: { handoff, identity } };
  const noEffects = () => {
    expect(sourcePreview.prepareVerifierSource).not.toHaveBeenCalled();
    expect(sourcePreview.prepareVerifierDependencies).not.toHaveBeenCalled();
    expect(existsSync(options.workRoot)).toBe(false);
    expect(existsSync(join(root, 'apps/operator/dist-verify/original-hono-host.mjs'))).toBe(false);
  };
  return { options, handoff, identity, inputs, cohort, source, save, noEffects };
}

describe('D050 caller entry before allocations', () => {
  const contract = (f: ReturnType<typeof originalFixture>): CommittedReaderCallerContract => ({
    selectedCommit: f.options.selectedCommit, original: f.options.original,
    testPath, helperPaths: [...helperPaths], configPaths: [...configPaths],
    schema: structuredClone(f.options.schema), environment: { ...f.options.environment },
  });
  const effects = () => vi.fn(async () => 'allocation callback reached');

  it.each(['contract', 'selection', 'original', 'schema', 'environment'] as const)(
    'refuses missing %s before allocation callbacks', async missing => {
      const f = originalFixture(); const supplied = contract(f);
      const allocate = effects();
      if (missing !== 'contract') delete (supplied as Partial<CommittedReaderCallerContract>)[
        missing === 'selection' ? 'selectedCommit' : missing];
      await expect(withCommittedReaderOriginalPreparation(missing === 'contract' ? undefined : supplied, allocate))
        .rejects.toThrow(/required|missing/i);
      expect(allocate).not.toHaveBeenCalled(); f.noEffects();
    });

  it('permits the callback only after validating synthetic pinned originals and preserves their identity', async () => {
    const f = originalFixture(); const bytes = readFileSync(f.handoff.observationReceiptPath);
    const allocate = vi.fn(async (preparation: CommittedReaderPreparationHandoff & { identity: CommittedReaderObservationIdentity }) => {
      expect(preparation).toEqual({ ...f.handoff, identity: f.identity });
      expect(qualifyCommittedReaderOriginalPreparation(preparation, preparation.identity).bytes).toEqual(bytes);
      return 'explicit callback result';
    });
    await expect(withCommittedReaderOriginalPreparation(contract(f), allocate)).resolves.toBe('explicit callback result');
    expect(allocate).toHaveBeenCalledTimes(1); f.noEffects();
  });

  it('refuses undelivered actual HTTP caller input before any private proof or schema allocation', async () => {
    const privateProof = vi.fn(async () => { throw new Error('private proof allocation reached'); });
    const schemaDb = vi.fn(async () => { throw new Error('schema allocation reached'); });
    // Import the real entrypoint without registering/running its HTTP experiment.
    vi.doMock('vitest', () => ({ expect, it: vi.fn() }));
    vi.doMock('../test/isolated-integration-proof', () => ({
      isolatedWorkerOptions: () => ({ testTimeoutMs: 1 }),
      captureIsolatedWorker: vi.fn(), recordIsolatedIntegrationProof: privateProof,
    }));
    vi.doMock('../test/_org-test-db', () => ({ createOrgTestDb: schemaDb }));
    try {
      const { measureCommittedReaderHttp } = await import('./agent-tools/plans/committed-tree-reader-http.integration.test');
      await expect(measureCommittedReaderHttp()).rejects.toThrow(/explicit.*contract.*required.*allocations/i);
      expect(privateProof).not.toHaveBeenCalled();
      expect(schemaDb).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('vitest'); vi.doUnmock('../test/isolated-integration-proof'); vi.doUnmock('../test/_org-test-db');
    }
  });

  it.each(['selection', 'identity', 'pin', 'population', 'schema-default', 'environment-default'] as const)(
    'refuses mismatched %s before allocation callbacks', async mismatch => {
      const f = originalFixture(); const supplied = contract(f); const allocate = effects();
      if (mismatch === 'selection') supplied.selectedCommit = 'b'.repeat(40);
      if (mismatch === 'identity') supplied.original.identity.process.identity = 'other-process';
      if (mismatch === 'pin') supplied.original.handoff.observationReceiptSha256 = '0'.repeat(64);
      if (mismatch === 'population') supplied.helperPaths = [];
      if (mismatch === 'schema-default') supplied.schema = { ...supplied.schema, callerDefault: digest('static') };
      if (mismatch === 'environment-default') supplied.environment.PAPERCUSP_BACKGROUND_WORKERS = 'caller-default';
      await expect(withCommittedReaderOriginalPreparation(supplied, allocate)).rejects.toThrow(/differs|changed|required/i);
      expect(allocate).not.toHaveBeenCalled(); f.noEffects();
    });

  it.each(['sourceReceiptPath', 'inputReceiptPath', 'observationReceiptPath'] as const)(
    'refuses retained %s drift before allocation callbacks', async path => {
      const f = originalFixture(); const supplied = contract(f); const allocate = effects();
      writeFileSync(f.handoff[path], readFileSync(f.handoff[path], 'utf8') + '\n');
      await expect(withCommittedReaderOriginalPreparation(supplied, allocate)).rejects.toThrow(/receipt.*changed/i);
      expect(allocate).not.toHaveBeenCalled(); f.noEffects();
    });

  it('refuses a missing original dimension instead of promoting explicit caller constraints', async () => {
    const f = originalFixture(); const supplied = contract(f); const allocate = effects();
    delete (f.cohort.observations as Partial<typeof f.cohort.observations>).environment; f.save();
    await expect(withCommittedReaderOriginalPreparation(supplied, allocate)).rejects.toThrow(/dimension identity is missing/i);
    expect(allocate).not.toHaveBeenCalled(); f.noEffects();
  });

  it('preserves callback failures after successful read-only validation', async () => {
    const f = originalFixture(); const failure = new Error('explicit callback failure');
    const allocate = vi.fn(async () => { throw failure; });
    await expect(withCommittedReaderOriginalPreparation(contract(f), allocate)).rejects.toBe(failure);
    expect(allocate).toHaveBeenCalledTimes(1); f.noEffects();
  });
});

describe('D047 pinned original preparation provenance', () => {
  it.each(['static graph and caller values', 'caller values without schema'])(
    'refuses %s before archive, dependency, compiler or private allocation', async variant => {
      const f = originalFixture();
      const options = { ...f.options, original: undefined,
        ...(variant === 'caller values without schema' ? { schema: {} } : {}) };
      await expect(produceCommittedReaderOriginalPreparation(options)).rejects.toThrow(/original.*handoff.*required|Required original preparation handoff is missing/i);
      f.noEffects();
    });

  it('preserves supplied original identity and exact bytes without synthesizing an observation or building', async () => {
    const f = originalFixture();
    const paths = [f.handoff.sourceReceiptPath, f.handoff.inputReceiptPath, f.handoff.observationReceiptPath];
    const bytes = paths.map(path => readFileSync(path));
    const prepared = await produceCommittedReaderOriginalPreparation(f.options);
    expect(prepared).toEqual({ ...f.handoff, identity: f.identity });
    expect(prepared.identity.process.pid).not.toBe(process.pid);
    paths.forEach((path, index) => expect(readFileSync(path)).toEqual(bytes[index]));
    const qualified = qualifyCommittedReaderOriginalPreparation(prepared, f.identity);
    expect(qualified.planned.inputs).toEqual(f.inputs);
    expect(qualified.bytes).toEqual(bytes[2]);
    f.noEffects();
  });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses missing original %s rather than filling from static/caller inputs', async dimension => {
      const f = originalFixture(); delete (f.cohort.observations as Partial<typeof f.cohort.observations>)[dimension]; f.save();
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/dimension identity is missing/);
      f.noEffects();
    });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses an original %s from a different process/run', async dimension => {
      const f = originalFixture(); f.cohort.observations[dimension].runId = 'other-run'; f.save();
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/cohort identity differs/);
      f.noEffects();
    });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses mismatched original %s values even with valid receipt digests', async dimension => {
      const f = originalFixture(); f.cohort.observations[dimension].value = ['static-substitution']; f.save();
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(new RegExp(`Original ${dimension} observation differs`));
      f.noEffects();
    });

  it.each(['sourceReceiptSha256', 'inputReceiptSha256', 'observationReceiptSha256'] as const)(
    'refuses missing original %s before effects', async pin => {
      const f = originalFixture(); f.handoff[pin] = '';
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/receipt digest is required/);
      f.noEffects();
    });

  it.each(['sourceReceiptPath', 'inputReceiptPath', 'observationReceiptPath'] as const)(
    'refuses original receipt drift at %s before effects', async path => {
      const f = originalFixture(); writeFileSync(f.handoff[path], readFileSync(f.handoff[path], 'utf8') + '\n');
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/receipt.*changed/i);
      f.noEffects();
    });

  it.each(['omitted', 'opaque'] as const)('preserves refusal of unknown %s dimensions', async key => {
    const f = originalFixture(); f.cohort[key] = ['unobserved-descendant']; f.save();
    await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(new RegExp(`has ${key} dimensions`));
    f.noEffects();
  });

  it('refuses selected commit disagreement instead of relabeling the original cohort', async () => {
    const f = originalFixture(); f.options.selectedCommit = 'b'.repeat(40);
    await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/selected.*differs/i);
    f.noEffects();
  });

  it.each(['configPaths', 'executedImports'] as const)('reuses planned archive membership for %s', async key => {
    const f = originalFixture(); f.inputs[key] = ['outside.ts'];
    f.cohort.observations[key === 'configPaths' ? 'config' : 'imports'].value = f.inputs[key]; f.save();
    await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/outside selected archive/);
    f.noEffects();
  });

  it('refuses changed materialized dependencies instead of reconstructing observations', async () => {
    const f = originalFixture(); writeFileSync(join(f.handoff.root, 'node_modules/example/index.js'), 'changed');
    await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/dependency census differs/);
    f.noEffects();
  });

  it.each(['sourceReceiptPath', 'inputReceiptPath', 'observationReceiptPath'] as const)(
    'rechecks original %s bytes after qualification', path => {
      const f = originalFixture(); const qualified = qualifyCommittedReaderOriginalPreparation(f.handoff, f.identity);
      writeFileSync(f.handoff[path], readFileSync(f.handoff[path], 'utf8') + '\n');
      expect(() => qualified.recheck()).toThrow(/receipt.*changed/i);
      f.noEffects();
    });
});
