import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { validateToolDeliveryCleanBlocks, validateToolDeliveryCleanBoundary, toolDeliveryModuleFile, installToolDeliveryModuleGuard,
  toolDeliveryMandatorySources, validateToolDeliveryCleanCensus, toolDeliveryBlockLedgerIdentity, validateToolDeliveryBlockLedgerIdentity,
  toolDeliveryIgnoredCensus,
  type ToolDeliveryCleanBoundary, type ToolDeliveryCleanPin, type ToolDeliveryControllerPin } from './tool-delivery-clean-runtime';
import cleanRegistration from './llm-testing/fixtures/tool-delivery-clean-runtime-candidate-20261023.json';
import fidelityRegistration from './llm-testing/fixtures/tool-delivery-fidelity-candidate-20261023.json';
import sourceV2Registration from './llm-testing/fixtures/tool-delivery-clean-source-v2-20261023.json';
import sourceV3Registration from './llm-testing/fixtures/tool-delivery-clean-source-v3-20261024.json';
import { toolDeliveryPreregistration } from './tool-delivery-acceptance';
import { findBoxIdentityPaths, findOwnerNameLeaks } from '../../../scripts/lib/identity-leak-patterns.mjs';
import { assertCleanCohortAuthority, assertCleanCohortCatalogDefinitions, assertCleanCohortCapturedInputs,
  claimCleanCohort, parseCleanCohortArgs } from './llm-testing/tool-delivery-clean-cohort.mjs';

const cleanup: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});

describe('tool-delivery module guard runtime boundary', () => {
  const interpreters = [{ executable: process.execPath, name: 'node' },
    ...(process.env.PAPERCUSP_RUNTIME_TEST_BUN
      ? [{ executable: process.env.PAPERCUSP_RUNTIME_TEST_BUN, name: 'bun' }] : [])];

  it.each(interpreters)('imports validators under $name while reserving hook enforcement for Node', ({ executable, name }) => {
    const root = mkdtempSync(join(tmpdir(), 'tool-delivery-interpreter-')); cleanup.push(root);
    const runner = join(root, 'runtime.mjs');
    const subject = fileURLToPath(new URL('./tool-delivery-clean-runtime.ts', import.meta.url));
    buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { installToolDeliveryModuleGuard, toolDeliveryModuleFile } from ${JSON.stringify(subject)};
const result = { name: process.versions.bun ? 'bun' : 'node', executable: process.execPath,
  builtin: toolDeliveryModuleFile(process.argv[2], 'node:fs') };
try {
  const guard = installToolDeliveryModuleGuard(process.argv[2]);
  guard.deregister();
  result.guard = 'installed';
} catch (error) { result.guard = 'refused'; result.reason = error.message; }
process.stdout.write(JSON.stringify(result));
` }, outfile: runner, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
    const observed = JSON.parse(execFileSync(executable, [runner, root], {
      env: {}, encoding: 'utf8', timeout: 15_000,
    }));
    expect(realpathSync(observed.executable)).toBe(realpathSync(executable));
    expect(observed).toMatchObject({ name, builtin: null, guard: name === 'node' ? 'installed' : 'refused' });
    if (name === 'bun') expect(observed.reason).toContain('requires Node with synchronous module hooks');
  }, 30_000);

  it('refuses Bun even if its compatibility module exposes a hook-shaped function', () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: 'compatibility-fixture' } });
    expect(() => installToolDeliveryModuleGuard('/must-not-be-read')).toThrow(
      'requires Node with synchronous module hooks');
  });
});
function fixture() {
  const root = '/synthetic-retained-checkout';
  const pin: ToolDeliveryCleanPin = { sourceRoot: root, cwd: root, commit: 'a'.repeat(40), porcelain: '',
    stagedDiff: '', unstagedDiff: '', submoduleStatus: ` ${'b'.repeat(40)} libs/tooldef (heads/staging)\n`, untracked: [],
    ignoredCensusSha256: 'c'.repeat(64), disallowedIgnoredFiles: [], sourceHashes: { 'sut.ts': 'd'.repeat(64) },
    moduleHashes: { 'sut.ts': 'd'.repeat(64), 'node_modules/dependency/index.js': 'e'.repeat(64) },
    installSha256: 'f'.repeat(64), environmentSha256: '1'.repeat(64), executableSha256: '2'.repeat(64), nodeVersion: 'v25.0.0',
    loadedBuildSha: 'a'.repeat(40), configGenerationSha256: '1'.repeat(64) };
  const boundary = (time: number): ToolDeliveryCleanBoundary => ({ ...structuredClone(pin), pid: 1234,
    processStartTicks: '789', sut: { transport: 'in-process', pid: 1234, processStartTicks: '789' }, monotonicNs: String(time) });
  const expectedBlocks = [0, 1, 2, 3, 4].flatMap(i => ['compact', 'full'].map(arm => ({ scenario: `S${i}`,
    arm, variantId: `new-${arm}` })));
  const blocks = expectedBlocks.map((block, i) => ({ ...block, runIds: [0, 1, 2].map(j => `${i}:${j}`),
    before: boundary(i * 10), after: boundary(i * 10 + 9), requestManifestSha256: '3'.repeat(64) }));
  return { pin, expectedBlocks, blocks, runIds: blocks.flatMap(b => b.runIds), judgedCells: expectedBlocks.map(b =>
    ({ scenario: b.scenario, arm: b.variantId, judged: 3, unmeasured: 0 })) };
}

describe('prospective clean tool-delivery execution admission', () => {
  function controllerFixture() {
    const f = fixture();
    const entrypoint = 'measurement/launcher.mjs';
    const controller: ToolDeliveryControllerPin = { ...structuredClone(f.pin), sourceRoot: '/synthetic-controller',
      commit: '9'.repeat(40), loadedBuildSha: '9'.repeat(40),
      entrypoint, sourceHashes: { [entrypoint]: '4'.repeat(64) }, moduleHashes: { [entrypoint]: '4'.repeat(64) } };
    f.pin.controller = structuredClone(controller);
    for (const block of f.blocks) for (const boundary of [block.before, block.after]) boundary.controller = structuredClone(controller);
    return { ...f, controllerRequired: true, sourceCommit: f.pin.commit!, controllerLauncher: entrypoint,
      controllerMarker: { buildSha: controller.commit, sourceBuildSha: f.pin.commit,
        pinSha256: createHash('sha256').update(JSON.stringify(f.pin)).digest('hex') } };
  }
  it('binds an unchanged captured SUT to a separate committed controller across the complete cohort', () => {
    const f = controllerFixture();
    expect(validateToolDeliveryCleanBlocks(f)).toBeUndefined();
    const missing = structuredClone(f); delete missing.pin.controller;
    expect(validateToolDeliveryCleanBlocks(missing)).toMatch(/controller receipt/);
    expect(validateToolDeliveryCleanBlocks({ ...f, sourceCommit: 'other' })).toBe('Captured source commit differs.');
    expect(validateToolDeliveryCleanBlocks({ ...f, controllerLauncher: 'other.mjs' })).toMatch(/controller receipt/);
    expect(validateToolDeliveryCleanBlocks({ ...f, controllerMarker: { ...f.controllerMarker, sourceBuildSha: 'other' } }))
      .toMatch(/controller receipt/);
    expect(validateToolDeliveryCleanBlocks({ ...f, controllerMarker: { ...f.controllerMarker, buildSha: 'other' } }))
      .toMatch(/controller receipt/);
    expect(validateToolDeliveryCleanBlocks({ ...f, controllerMarker: undefined })).toMatch(/controller receipt/);
  });
  it.each(['dirty', 'ignored', 'gitlink', 'commit', 'entrypoint', 'source', 'environment', 'overlap', 'changed', 'missing'])(
    'rejects %s measurement-controller proof without replacing a block', mode => {
      const f = controllerFixture(), boundary = f.blocks[4]!.after, controller = boundary.controller!;
      if (mode === 'dirty') controller.porcelain = ' M source.ts';
      if (mode === 'ignored') controller.disallowedIgnoredFiles.push('.env');
      if (mode === 'gitlink') controller.submoduleStatus = '+wrong libs/a';
      if (mode === 'commit') controller.loadedBuildSha = 'other';
      if (mode === 'entrypoint') controller.entrypoint = '../escape.mjs';
      if (mode === 'source') controller.sourceHashes[controller.entrypoint] = 'other';
      if (mode === 'environment') controller.environmentSha256 = 'other';
      if (mode === 'overlap') controller.sourceRoot = `${boundary.sourceRoot}/controller`;
      if (mode === 'changed') controller.moduleHashes['newly-loaded.mjs'] = '5'.repeat(64);
      if (mode === 'missing') delete boundary.controller;
      expect(validateToolDeliveryCleanBlocks(f)).toBeDefined();
    });
  it('freezes captured dependencies and source, admitting only registered measurement and portable bytes', () => {
    const captured = { installSha256: 'install', executableSha256: 'node', nodeVersion: 'v25',
      moduleHashes: { 'sut.ts': 'sut', 'reader.ts': 'old-reader', 'node_modules/a.js': 'dependency' } };
    const actual = { ...captured, moduleHashes: { ...captured.moduleHashes, 'reader.ts': 'new-reader', 'registration.json': 'portable' } };
    const hashes: Record<string, string> = { ...actual.moduleHashes };
    const input = { captured, actual, fixture: 'registration.json', portableSha256: 'portable',
      amendment: { addedFiles: {}, sourceReplacements: { 'reader.ts': { sha256: 'new-reader' } } },
      readHash: (path: string) => hashes[path]! };
    expect(() => assertCleanCohortCapturedInputs(input)).not.toThrow();
    for (const key of ['installSha256', 'executableSha256', 'nodeVersion'] as const)
      expect(() => assertCleanCohortCapturedInputs({ ...input, actual: { ...actual, [key]: 'drift' } })).toThrow('Captured runtime input changed');
    for (const path of ['sut.ts', 'node_modules/a.js']) {
      hashes[path] = 'drift';
      expect(() => assertCleanCohortCapturedInputs(input)).toThrow('Captured module changed');
      hashes[path] = captured.moduleHashes[path as keyof typeof captured.moduleHashes];
    }
    expect(() => assertCleanCohortCapturedInputs({ ...input, actual: { ...actual,
      moduleHashes: { ...actual.moduleHashes, 'unregistered.ts': 'new-source' } } })).toThrow('Unregistered loaded source');
    expect(() => assertCleanCohortCapturedInputs({ ...input, portableSha256: 'other' })).toThrow('Unregistered loaded source');
    expect(() => assertCleanCohortCapturedInputs({ ...input, amendment: { addedFiles: {}, sourceReplacements: {} } })).toThrow('Captured module changed');
  });
  it('compares actual request JSON while rejecting model-visible guidance and schema drift', () => {
    const expected = [{ type: 'function', name: 'sample', parameters: {
      type: 'object', properties: { value: { type: 'string' } },
    } }];
    const actual = [{ ...expected[0], description: undefined, parameters: {
      ...expected[0]!.parameters, description: undefined,
      properties: { value: { type: 'string', description: undefined } },
    } }];
    // JSON equality is the provider-facing contract, even when raw JS shapes differ.
    expect(actual).not.toStrictEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(() => assertCleanCohortCatalogDefinitions(actual, expected)).not.toThrow();
    expect(() => assertCleanCohortCatalogDefinitions([
      { ...actual[0], description: 'Changed model-visible guidance' },
    ], expected)).toThrow('Model-facing catalog request differs');
    expect(() => assertCleanCohortCatalogDefinitions([
      { ...actual[0], parameters: { ...actual[0]!.parameters, required: ['value'] } },
    ], expected)).toThrow('Model-facing catalog request differs');
  });
  it('selects only registered cohorts and keeps preparation separate from execution', () => {
    const args = ['retained', 'private'];
    expect(parseCleanCohortArgs(args).readinessPath).toBeUndefined();
    const v2 = parseCleanCohortArgs([...args, '--registration', sourceV2Registration.experiment.id]);
    expect(v2.fixture).toMatch(/tool-delivery-clean-source-v2-20261023.json$/);
    expect(v2.readinessPath).toBeUndefined();
    const v3 = parseCleanCohortArgs([...args, '--registration', sourceV3Registration.experiment.id]);
    expect(v3.fixture).toMatch(/tool-delivery-clean-source-v3-20261024.json$/);
    expect(v3.readinessPath).toBeUndefined();
    expect(parseCleanCohortArgs([...args, '--execute', 'approval.json', '--registration', sourceV2Registration.experiment.id])
      .readinessPath).toBe('approval.json');
    for (const options of [['--registration', '../../private.json'], ['--registration', 'toString'],
      ['--execute'], ['--execute', 'a', '--execute', 'b'], ['--override', 'b']])
      expect(() => parseCleanCohortArgs([...args, ...options])).toThrow();
  });
  it('retains the exact machine-readable D079 catalog delta under a distinct current-source identity', () => {
    expect(toolDeliveryPreregistration(sourceV2Registration.experiment.id)).toEqual(sourceV2Registration);
    expect(sourceV2Registration.experiment.id).not.toBe(cleanRegistration.experiment.id);
    expect(sourceV2Registration.configuration).toEqual(fidelityRegistration.configuration);
    expect(sourceV2Registration.experiment.manifestContract.compactDefinitions)
      .toEqual(fidelityRegistration.experiment.manifestContract.compactDefinitions);
    const restored = structuredClone(sourceV2Registration.experiment.manifestContract.fullDefinitions);
    expect(sourceV2Registration.treatmentDelta.changes).toHaveLength(1);
    for (const delta of sourceV2Registration.treatmentDelta.changes) {
      expect(delta.arm).toBe('full');
      const index = Number(delta.path.split('/')[1]);
      expect(restored[index]!.name).toBe('code__run');
      expect(delta.path).toBe(`/${index}/parameters/properties/inputs/description`);
      const inputs = (restored[index]!.parameters.properties as Record<string, { description?: string }>).inputs!;
      expect(inputs.description).toBe(delta.after);
      inputs.description = delta.before;
    }
    expect(restored).toEqual(fidelityRegistration.experiment.manifestContract.fullDefinitions);
    expect(findBoxIdentityPaths(JSON.stringify(sourceV2Registration))).toEqual([]);
    expect(findOwnerNameLeaks(JSON.stringify(sourceV2Registration))).toEqual([]);
    for (const arm of Object.values(sourceV2Registration.variants)) expect(arm.configDelta).not.toHaveProperty('systemPromptText');
  });
  it('keeps the source-v3 wire delta complete, unselected and digest-only', () => {
    expect(toolDeliveryPreregistration(sourceV3Registration.experiment.id)).toEqual(sourceV3Registration);
    expect(sourceV3Registration.configuration).toEqual(sourceV2Registration.configuration);
    expect(sourceV3Registration.experiment.manifestContract.compactDefinitions)
      .toEqual(sourceV2Registration.experiment.manifestContract.compactDefinitions);
    const restored = structuredClone(sourceV3Registration.experiment.manifestContract.fullDefinitions);
    const descriptions = new Set(['kernel', 'inputs', 'work_item_id']);
    expect(sourceV3Registration.treatmentDelta.catalogDeltas).toHaveLength(3);
    for (const delta of sourceV3Registration.treatmentDelta.catalogDeltas) {
      const [, index, parameters, properties, field, description] = delta.path.split('/');
      expect(delta.arm).toBe('full');
      expect([parameters, properties, description]).toEqual(['parameters', 'properties', 'description']);
      expect(descriptions.delete(field!)).toBe(true);
      expect(restored[Number(index)]!.name).toBe('code__run');
      const property = (restored[Number(index)]!.parameters.properties as Record<string, { description: string }>)[field!]!;
      expect(property.description).toBe(delta.after);
      property.description = delta.before;
    }
    expect(descriptions.size).toBe(0);
    expect(restored).toEqual(sourceV2Registration.experiment.manifestContract.fullDefinitions);
    expect(sourceV3Registration.sourceGraphQualification.status).toBe('PENDING_EXACT_REVIEW');
    expect(sourceV3Registration.executionPolicy.measurementController).toBe('separate-root');
    expect(findBoxIdentityPaths(JSON.stringify(sourceV3Registration))).toEqual([]);
    expect(findOwnerNameLeaks(JSON.stringify(sourceV3Registration))).toEqual([]);
    for (const arm of Object.values(sourceV3Registration.variants)) expect(arm.configDelta).not.toHaveProperty('systemPromptText');
  });
  function authorityFixture() {
    const registration = structuredClone(cleanRegistration);
    const expected = { experimentId: registration.experiment.id, portableSha256: 'a'.repeat(64), buildSha: 'b'.repeat(40),
      plan: { version: 999, contentHash: 'c'.repeat(64) }, auditSeq: 99,
      rubric: { revision: 99, criteriaHash: 'd'.repeat(64) }, critic: 'independent-critic' };
    const live = { buildSha: expected.buildSha, readerSourceSha256: registration.measurementAmendment.sourceReplacements[
      'packages/operator-core/lib/tool-delivery-acceptance.ts'].sha256,
    plan: structuredClone(expected.plan), audit: { seq: 99, ...expected.plan },
    rubric: { ...expected.rubric, criteriaCount: 10, selections: { 'R-6': expected.experimentId, 'R-9': expected.experimentId } },
    vetting: { satisfied: true, reason: 'current', attestedRevision: 99, attestedCriteriaHash: expected.rubric.criteriaHash,
      critique: { critics: [expected.critic] } }, implementer: 'author',
    r10: ['AUTO-BAR-R-10-P-013', 'AUTO-BAR-R-10-P-015'].map(specId => ({ specId, verdict: 'pass', wouldBlock: [],
      mechanicalProof: { verdict: 'pass', gaps: [] } })) };
    return { registration, expected, live };
  }
  it('admits only an exact live prospective approval, current full rubric and rollout', () => {
    const { registration, expected, live } = authorityFixture();
    expect(() => assertCleanCohortAuthority(registration, expected.portableSha256, expected, live)).not.toThrow();
    expect(() => assertCleanCohortAuthority(registration, expected.portableSha256, undefined, live)).toThrow();
  });
  it.each(['experiment', 'portable', 'reader', 'build', 'plan', 'audit', 'rubric', 'population', 'selection', 'vetting',
    'critic', 'self-review', 'r10', 'r10-population'])('rejects %s authority drift before creating any execution marker', mode => {
    const { registration, expected, live } = authorityFixture();
    if (mode === 'experiment') expected.experimentId = 'historical';
    if (mode === 'portable') expected.portableSha256 = 'wrong';
    if (mode === 'reader') live.readerSourceSha256 = 'wrong';
    if (mode === 'build') live.buildSha = 'wrong';
    if (mode === 'plan') live.plan.version++;
    if (mode === 'audit') live.audit.contentHash = 'wrong';
    if (mode === 'rubric') live.rubric.criteriaHash = 'wrong';
    if (mode === 'population') live.rubric.criteriaCount--;
    if (mode === 'selection') live.rubric.selections['R-9'] = 'historical';
    if (mode === 'vetting') live.vetting.satisfied = false;
    if (mode === 'critic') live.vetting.critique.critics = ['other'];
    if (mode === 'self-review') live.implementer = expected.critic;
    if (mode === 'r10') live.r10[0]!.mechanicalProof.gaps.push('missing proof' as never);
    if (mode === 'r10-population') live.r10[0]!.specId = 'wrong';
    expect(() => assertCleanCohortAuthority(registration, 'a'.repeat(64), expected, live)).toThrow();
  });
  it('retains a started marker and rejects both duplicate and crash-recovery execution', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tool-delivery-once-')); cleanup.push(directory);
    claimCleanCohort(directory, { experimentId: 'new', status: 'started' });
    expect(() => claimCleanCohort(directory, { experimentId: 'new', status: 'retry' })).toThrow(/EEXIST/);
  });
  it('keeps the new cohort distinct and the entire D079 treatment unchanged', () => {
    expect(toolDeliveryPreregistration(cleanRegistration.experiment.id)).toEqual(cleanRegistration);
    expect(cleanRegistration.experiment.id).not.toBe(fidelityRegistration.experiment.id);
    expect(cleanRegistration.experiment.manifestContract).toEqual(fidelityRegistration.experiment.manifestContract);
    expect(cleanRegistration.configuration).toEqual(fidelityRegistration.configuration);
    expect(cleanRegistration.executionPolicy.requireCleanRuntime).toBe(true);
    expect(cleanRegistration.capture.privateCapture.originalSha256).toBe('59dbe40408cc761e879e3ea56d9c47431246684de5608914806c28f9622bfb40');
    expect(findBoxIdentityPaths(JSON.stringify(cleanRegistration))).toEqual([]);
    expect(findOwnerNameLeaks(JSON.stringify(cleanRegistration))).toEqual([]);
    for (const arm of Object.values(cleanRegistration.variants)) expect(arm.configDelta).not.toHaveProperty('systemPromptText');
  });
  it('accepts a complete sequential clean population with stable recorder/SUT identity', () => {
    expect(validateToolDeliveryCleanBlocks(fixture())).toBeUndefined();
  });
  it('rejects swapped arms, reordered same-scenario rows, reused rows and changed boundary digests', () => {
    const f = fixture(), first = f.blocks[0]!, second = f.blocks[1]!;
    const identity = toolDeliveryBlockLedgerIdentity('new', 0, first);
    expect(validateToolDeliveryBlockLedgerIdentity(identity, 'new', 0, first)).toBeUndefined();
    // jsonb reorders object keys; identical custody values must survive its round trip.
    expect(validateToolDeliveryBlockLedgerIdentity(Object.fromEntries(Object.entries(identity).reverse()), 'new', 0, first)).toBeUndefined();
    expect(validateToolDeliveryBlockLedgerIdentity(toolDeliveryBlockLedgerIdentity('new', 1, second), 'new', 0, first)).toBeDefined();
    expect(validateToolDeliveryBlockLedgerIdentity(identity, 'new', 1, first)).toBeDefined();
    expect(validateToolDeliveryBlockLedgerIdentity(identity, 'new', 2, f.blocks[2]!)).toBeDefined();
    expect(validateToolDeliveryBlockLedgerIdentity({ ...identity, beforeSha256: 'f'.repeat(64) }, 'new', 0, first)).toBeDefined();
    expect(validateToolDeliveryBlockLedgerIdentity({ ...identity, requestManifestSha256: 'f'.repeat(64) }, 'new', 0, first)).toBeDefined();
  });
  it.each(['launcher.cjs', 'node_modules/tsx/dist/loader.mjs',
    'packages/operator-core/lib/dependency-generation-proof.ts',
    'apps/operator/bin/release/dependency-generation.sh',
    'packages/operator-core/lib/llm-testing/targets/codex-responses-tool-loop.ts',
    'apps/operator/scripts/tool-delivery.generated.mjs', 'scenario.ts'])('rejects omission of mandatory %s even from an otherwise consistent pin', path => {
    const registration = { sourcePins: { files: { 'apps/operator/scripts/tool-delivery.generated.mjs': 'a' },
      scenarioPaths: { scenario: 'scenario.ts' } }, executionPolicy: { launcherPath: 'launcher.cjs' } };
    const f = fixture(), boundary = f.blocks[0]!.before;
    boundary.sourceHashes = Object.fromEntries(toolDeliveryMandatorySources(registration).map(p => [p, 'a'.repeat(64)]));
    boundary.moduleHashes = { ...boundary.sourceHashes };
    expect(validateToolDeliveryCleanCensus(boundary, registration)).toBeUndefined();
    delete boundary.sourceHashes[path];
    expect(validateToolDeliveryCleanCensus(boundary, registration)).toMatch(/Mandatory source census/);
    boundary.sourceHashes[path] = 'a'.repeat(64);
    delete boundary.moduleHashes['packages/operator-core/lib/llm-testing/test-run-ledger.ts'];
    expect(validateToolDeliveryCleanCensus(boundary, registration)).toMatch(/Mandatory loaded module/);
    boundary.moduleHashes['packages/operator-core/lib/llm-testing/test-run-ledger.ts'] = 'a'.repeat(64);
    delete boundary.moduleHashes['packages/operator-core/lib/dependency-generation-proof.ts'];
    expect(validateToolDeliveryCleanCensus(boundary, registration)).toMatch(/Mandatory loaded module/);
  });
  it('rejects pre-existing ignored config inputs and changed runtime/config generations', () => {
    const f = fixture(); f.blocks[0]!.before.disallowedIgnoredFiles = ['.config/loader.mjs'];
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/ignored execution input/);
    const g = fixture(); g.blocks[0]!.before.loadedBuildSha = 'b'.repeat(40);
    expect(validateToolDeliveryCleanBlocks(g)).toMatch(/generation differs/);
    const h = fixture(); h.blocks[0]!.before.configGenerationSha256 = '2'.repeat(64);
    expect(validateToolDeliveryCleanBlocks(h)).toMatch(/generation differs/);
  });
  it('includes ignored redirect inputs inside nested gitlinks in the whole-checkout census', () => {
    const status = ` ${'a'.repeat(40)} libs/outer (heads/staging)\n ${'b'.repeat(40)} libs/outer/nested (heads/staging)\n`;
    const ignored = toolDeliveryIgnoredCensus(status, directory => directory.endsWith('/nested')
      ? ['.config/redirect.mjs'] : ['node_modules/package/index.mjs']);
    expect(ignored).toContain('libs/outer/nested/.config/redirect.mjs');
    const f = fixture(); f.blocks[0]!.before.disallowedIgnoredFiles = ignored.filter(path => !path.split('/').includes('node_modules'));
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/ignored execution input/);
    expect(() => toolDeliveryIgnoredCensus('unreadable gitlink', () => [])).toThrow(/unavailable/);
  });
  it.each(['porcelain', 'stagedDiff', 'unstagedDiff'] as const)('rejects dirty %s before model admission', field => {
    const f = fixture(); f.blocks[0]!.before[field] = 'M sut.ts';
    expect(validateToolDeliveryCleanBoundary(f.blocks[0]!.before, f.pin)).toMatch(/not globally clean/);
  });
  it('rejects untracked files and an uninitialized or moved gitlink', () => {
    const f = fixture(); f.blocks[0]!.before.untracked = ['untracked.ts'];
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/not globally clean/);
    const g = fixture(); g.blocks[0]!.before.submoduleStatus = '+wrong libs/tooldef';
    expect(validateToolDeliveryCleanBlocks(g)).toMatch(/gitlink/);
  });
  it.each(['commit', 'sourceHashes', 'moduleHashes', 'installSha256', 'environmentSha256',
    'executableSha256', 'cwd', 'nodeVersion', 'ignoredCensusSha256'] as const)('rejects changed %s at the post-block boundary', field => {
    const f = fixture(); Object.assign(f.blocks[4]!.after, { [field]: field.endsWith('Hashes') ? { changed: '0'.repeat(64) } : 'changed' });
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/identity changed|generation differs/);
  });
  it('invalidates the entire cohort when one post-block receipt is missing', () => {
    const f = fixture(); delete (f.blocks[3] as Partial<typeof f.blocks[3]>)!.after;
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/Missing block boundary/);
  });
  it('rejects a restarted recorder or a different SUT process', () => {
    const f = fixture(); f.blocks[2]!.after.processStartTicks = '790'; f.blocks[2]!.after.sut.processStartTicks = '790';
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/generation changed/);
    const g = fixture(); g.blocks[2]!.after.sut.pid++;
    expect(validateToolDeliveryCleanBlocks(g)).toMatch(/Recorder\/SUT process identity differs/);
  });
  it('rejects overlapping monotonic block intervals', () => {
    const f = fixture(); f.blocks[1]!.before.monotonicNs = '8';
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/overlap/);
  });
  it('rejects an earlier experiment marker or a replacement attempt', () => {
    const f = fixture(); f.blocks[0]!.variantId = 'historical-compact';
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/Mixed experiment/);
    const g = fixture(); g.blocks[9]!.runIds[0] = 'replacement';
    expect(validateToolDeliveryCleanBlocks(g)).toMatch(/omits or replaces/);
  });
  it('rejects extra, hidden and duplicate candidate population rows', () => {
    for (const mode of ['extra', 'hidden', 'duplicate']) {
      const f = fixture();
      if (mode === 'extra') f.runIds.push('extra');
      if (mode === 'hidden') f.runIds.pop();
      if (mode === 'duplicate') f.runIds[0] = f.runIds[1]!;
      expect(validateToolDeliveryCleanBlocks(f), mode).toMatch(/population/);
    }
  });
  it('rejects a missing manifest or zero-judged scenario/arm cell', () => {
    const f = fixture(); f.blocks[0]!.requestManifestSha256 = '';
    expect(validateToolDeliveryCleanBlocks(f)).toMatch(/manifest checksum/);
    const g = fixture(); g.judgedCells[7]!.judged = 0;
    expect(validateToolDeliveryCleanBlocks(g)).toMatch(/not completely judged/);
  });
  it('checks actual module realpaths and rejects symlink escape into the shared tree', () => {
    const base = mkdtempSync(join(tmpdir(), 'tool-delivery-modules-')); cleanup.push(base);
    const root = join(base, 'retained'), outside = join(base, 'shared');
    mkdirSync(root); mkdirSync(outside); writeFileSync(join(root, 'good.mjs'), 'export const good = true;');
    writeFileSync(join(outside, 'dirty.mjs'), 'export const dirty = true;');
    symlinkSync(outside, join(root, 'workspace-package'), 'dir');
    expect(toolDeliveryModuleFile(root, pathToFileURL(join(root, 'good.mjs')).href)).toBe(join(root, 'good.mjs'));
    expect(toolDeliveryModuleFile(root, 'node:fs')).toBeNull();
    expect(() => toolDeliveryModuleFile(root, pathToFileURL(join(root, 'workspace-package/dirty.mjs')).href)).toThrow(/escaped/);
    expect(() => toolDeliveryModuleFile(root, 'https://unregistered.invalid/module.mjs')).toThrow(/no local source/);
  });
  it('enforces containment on a real Node import and permits it only after removing the guard', () => {
    const base = mkdtempSync(join(tmpdir(), 'tool-delivery-node-hook-')); cleanup.push(base);
    const root = join(base, 'retained'), outside = join(base, 'shared');
    mkdirSync(root); mkdirSync(outside);
    const good = join(root, 'good.cjs'), escaped = join(root, 'dependency/escaped.cjs');
    writeFileSync(good, 'module.exports = 23;');
    writeFileSync(join(outside, 'escaped.cjs'), 'module.exports = 42;');
    symlinkSync(outside, join(root, 'dependency'), 'dir');
    const require = createRequire(import.meta.url);
    const guard = installToolDeliveryModuleGuard(root);
    try {
      expect(require(good)).toBe(23);
      expect(guard.urls.has(pathToFileURL(good).href)).toBe(true);
      expect(() => require(escaped)).toThrow(/escaped the retained/);
    } finally { guard.deregister(); }
    expect(require(escaped)).toBe(42);
  });
  it('tracks actual imports in two explicit roots and rejects a third root or overlapping roots', () => {
    const base = mkdtempSync(join(tmpdir(), 'tool-delivery-controller-')); cleanup.push(base);
    const source = join(base, 'source'), controller = join(base, 'controller'), outside = join(base, 'outside');
    for (const root of [source, controller, outside]) {
      mkdirSync(root); writeFileSync(join(root, 'module.cjs'), 'module.exports = 7;');
    }
    symlinkSync(outside, join(controller, 'escape'), 'dir');
    const require = createRequire(import.meta.url), guard = installToolDeliveryModuleGuard(source, controller);
    try {
      expect(require(join(source, 'module.cjs'))).toBe(7);
      expect(require(join(controller, 'module.cjs'))).toBe(7);
      expect(guard.urls).toEqual(new Set([pathToFileURL(join(source, 'module.cjs')).href]));
      expect(guard.controllerUrls).toEqual(new Set([pathToFileURL(join(controller, 'module.cjs')).href]));
      expect(() => require(join(controller, 'escape/module.cjs'))).toThrow(/escaped/);
    } finally { guard.deregister(); }
    expect(() => installToolDeliveryModuleGuard(source, source)).toThrow(/disjoint/);
    const nested = join(source, 'nested'); mkdirSync(nested);
    expect(() => installToolDeliveryModuleGuard(source, nested)).toThrow(/disjoint/);
  });
});
