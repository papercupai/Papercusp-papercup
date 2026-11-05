import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';
import { linuxProcessIdentityFromStat } from '../lib/process-identity';
import { verifierSourceFiles } from '../lib/verifier-source';
import { preparePrivateOperatorApiBundle, produceCommittedReaderPrivateApiBundle, qualifyCommittedReaderSource,
  resolvePreparedCommittedReaderSource, resolvePreparedPrivateApiBundle, preparePrivateWorkerSources,
  observeCommittedReaderLoadedSources, privateBundleRuntimeEnv,
  type CommittedReaderClosure, type CommittedReaderPreparationInputs } from './private-http-workspace-preflight';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reader-source-preflight-')); temporary.push(dir);
  const root = join(dir, 'source'); const prepared = join(dir, 'prepare');
  mkdirSync(root); mkdirSync(prepared);
  for (const name of ['reader.test.ts', 'helper.ts', 'config.ts', 'import.ts', 'asset.sql']) writeFileSync(join(root, name), name);
  const source = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
    testedInputs: [{ path: 'reader.test.ts', sha256: digest('reader.test.ts') }], files: verifierSourceFiles(root) };
  writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(source));
  const sourceReceiptPath = join(dir, 'source-receipt.json'); writeFileSync(sourceReceiptPath, JSON.stringify(source));
  const modules = join(root, 'node_modules'); mkdirSync(modules);
  mkdirSync(join(modules, 'example'));
  writeFileSync(join(modules, 'example', 'package.json'), JSON.stringify({ name: 'example', main: 'index.js' }));
  writeFileSync(join(modules, 'example', 'index.js'), 'module.exports = 1');
  symlinkSync('../helper.ts', join(modules, 'workspace-helper'));
  // Match the private worker's maintained dependency resolution from its bundle.
  symlinkSync(modules, join(dir, 'node_modules'), 'dir');
  const bundle = join(prepared, 'hono-host.mjs'); writeFileSync(bundle, 'export const host = 1;');
  const copiedAsset = join(prepared, 'asset.sql'); writeFileSync(copiedAsset, 'asset.sql');
  const graph = { inputs: {
    'helper.ts': { imports: [{ path: 'import.ts' }, { path: 'example', external: true }, { path: 'node:fs', external: true }] },
    'import.ts': { imports: [] },
  }, outputs: { 'hono-host.mjs': { imports: [{ path: 'example', external: true }] } } };
  writeFileSync(`${bundle}.meta.json`, JSON.stringify(graph));
  const closure: CommittedReaderClosure = { sourceCommit: source.sourceCommit, sha256: digest(readFileSync(bundle)),
    metafileSha256: digest(readFileSync(`${bundle}.meta.json`)), testPaths: ['reader.test.ts'],
    helperPaths: ['helper.ts'], configPaths: ['config.ts'], executedImports: ['helper.ts', 'import.ts'],
    dependencyFiles: verifierSourceFiles(modules, { symlinkRoot: root }), externalResolutions: { example: 'node_modules/example/index.js' },
    copiedSources: ['asset.sql'], artifacts: [
      ...[bundle, `${bundle}.meta.json`].map(path => ({ path, sha256: digest(readFileSync(path)) })),
      { path: copiedAsset, sha256: digest('asset.sql'), sourcePath: 'asset.sql' },
    ],
    schema: { 'harness_shared.tool_invocations.args_json': digest('jsonb:not-null') },
    environment: { PAPERCUSP_BACKGROUND_WORKERS: digest('0') }, omitted: [], opaque: [] };
  const receiptPath = join(dir, 'operator-api-preflight.json');
  const save = () => writeFileSync(receiptPath, JSON.stringify(closure)); save();
  vi.stubEnv('VERIFY_TAURI_SOURCE_REF', source.sourceCommit);
  return { dir, root, bundle, closure, save, options: { root, bundle, receiptPath, sourceReceiptPath,
    selectedCommit: source.sourceCommit, schema: { ...closure.schema }, environment: { PAPERCUSP_BACKGROUND_WORKERS: '0' } } };
}

function prepareBuilder(f: ReturnType<typeof fixture>, script = 'test -f "$2"\n') {
  const bin = join(f.root, 'apps/operator/bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bundle-host.sh'), script);
  const source = JSON.parse(readFileSync(f.options.sourceReceiptPath, 'utf8'));
  source.files = verifierSourceFiles(f.root, { runtimeArtifacts: true });
  writeFileSync(join(f.root, '.verifier-source.json'), JSON.stringify(source));
  writeFileSync(f.options.sourceReceiptPath, JSON.stringify(source));
}

function producerFixture(extraScript = '') {
  const f = fixture();
  writeFileSync(join(f.root, 'builder-graph.json'), readFileSync(`${f.bundle}.meta.json`));
  prepareBuilder(f, 'printf "build\\n" >> "$2.builds"\nprintf "%s" "export const host = 1;" > "$2"\n'
    + 'cp builder-graph.json "$2.meta.json"\ncp asset.sql "$(dirname "$2")/asset.sql"\n' + extraScript);
  for (const name of ['hono-host.mjs', 'hono-host.mjs.meta.json', 'asset.sql']) rmSync(join(f.dir, 'prepare', name));
  const { sha256: _bundle, metafileSha256: _graph, artifacts: _artifacts, ...pins } = f.closure;
  const inputs: CommittedReaderPreparationInputs = { ...pins, phase: 'planned',
    copiedArtifacts: [{ path: 'asset.sql', sourcePath: 'asset.sql' }] };
  const inputReceiptPath = join(f.dir, 'operator-api-preflight.json');
  const saveInputs = () => writeFileSync(inputReceiptPath, JSON.stringify(inputs)); saveInputs();
  const selected = { inputReceiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
    selectedCommit: f.options.selectedCommit };
  const produce = () => produceCommittedReaderPrivateApiBundle(f.root, join(f.dir, 'prepare'), selected);
  const consume = () => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
    receiptPath: join(f.dir, 'prepare/operator-api-preflight.json'),
    sourceReceiptPath: join(f.dir, 'prepare/verifier-source.json'), selectedCommit: selected.selectedCommit,
  } });
  return { ...f, inputs, saveInputs, selected, produce, consume };
}

function observedBuildFixture(extraScript = '') {
  const f = producerFixture('test -f "$(dirname "$2")/operator-api-inputs.json"\n' + extraScript);
  const observedSource = { sourceReceiptPath: f.selected.sourceReceiptPath,
    sourceReceiptSha256: digest(readFileSync(f.selected.sourceReceiptPath)), selectedCommit: f.selected.selectedCommit };
  const produceObserved = () => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { observedSource });
  return { ...f, observedSource, produceObserved };
}

function loadedFixture(source?: string, admit = true, buildObservationOnly = false) {
  let f: ReturnType<typeof fixture>;
  if (buildObservationOnly) {
    const observed = observedBuildFixture(); observed.produceObserved(); f = observed;
  } else f = fixture();
  const traceOut = join(f.dir, 'host-source.json');
  if (source !== undefined) {
    writeFileSync(f.bundle, source);
    f.closure.sha256 = digest(source);
    f.closure.artifacts.find(artifact => artifact.path === f.bundle)!.sha256 = f.closure.sha256;
    f.save();
  }
  const traceRoot = traceOut + '.native-processes';
  const startedAtMs = Date.now();
  const environment = privateBundleRuntimeEnv({ ...process.env, NODE_OPTIONS: '', NODE_PATH: '',
    PAPERCUSP_TEST_CONFIGURATION_SECRET: 'private-entry-value' }, {
    traceOut, pinnedSources: admit ? [{ path: f.bundle, sha256: f.closure.sha256,
      byteLength: readFileSync(f.bundle).length }] : [],
  });
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(resolve(import.meta.dirname,
    '../../../scripts/lib/vitest-startup-trace.mjs')).href, f.bundle], {
    cwd: f.root, env: environment,
    encoding: 'utf8', timeout: 15_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const options = { ...f.options, traceOut, pid: child.pid, startedAtMs, finishedAtMs: Date.now(),
    configuration: captureConfigurationSnapshot(environment),
    ...(buildObservationOnly ? { preparationOnly: true as const, buildObservationOnly,
      receiptPath: join(f.dir, 'prepare/operator-api-preflight.json') } : {}) };
  const rows = readdirSync(traceRoot).filter(name => name.endsWith('.json'))
    .map(name => ({ name, row: JSON.parse(readFileSync(join(traceRoot, name), 'utf8')) }));
  const kernelProcessIdentity: string | undefined = rows.find(({ row }) => row.event === 'node-entry')?.row.kernelProcessIdentity;
  const replace = (event: string, mutate: (row: any) => void) => {
    const entry = rows.find(({ row }) => row.event === event)!;
    rmSync(join(traceRoot, entry.name)); mutate(entry.row);
    const bytes = JSON.stringify(entry.row);
    writeFileSync(join(traceRoot, digest(bytes) + '.json'), bytes);
  };
  const replaceAll = (mutate: (row: any) => void) => {
    for (const entry of rows) {
      rmSync(join(traceRoot, entry.name)); mutate(entry.row);
      const bytes = JSON.stringify(entry.row);
      entry.name = digest(bytes) + '.json';
      writeFileSync(join(traceRoot, entry.name), bytes);
    }
  };
  return { ...f, traceRoot, options, rows, replace, replaceAll, environment, nativeOutput: child.stdout,
    kernelProcessIdentity,
    observe: () => observeCommittedReaderLoadedSources(options) };
}

describe('committed reader loader-return source binding', () => {
  it('binds native pinned engine outer execution while an uncalled function stays unobserved', () => {
    const f = loadedFixture('export function uncalled() { return 4; } export const host = "🌱";');
    const observed = f.observe();
    expect(observed.engineExecution).toMatchObject({ status: 'observed', gaps: [],
      sourceTextSha256: f.closure.sha256 });
    expect(observed.engineExecution.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'uncalled', count: 0 }));
    expect(observed.pending).toContain('module-evaluation');
  });

  it('bounds pinned engine ranges without promoting partial coverage to full module closure', () => {
    const f = loadedFixture(Array.from({ length: 180 }, (_, i) => `export function uncalled${i}() { return ${i}; }`).join('\n'));
    const observed = f.observe();
    expect(observed.engineExecution).toMatchObject({ status: 'observed', coverageRangesComplete: false });
    expect(observed.engineExecution.coverageRanges).toHaveLength(128);
    expect(observed.pending).toContain('module-evaluation');
  });

  it.each(['missing', 'digest', 'zero', 'offset', 'duplicate', 'isolate'] as const)(
    'keeps %s engine evidence unknown without weakening loader binding', mode => {
      const f = loadedFixture();
      if (mode === 'missing') rmSync(join(f.traceRoot, f.rows.find(({ row }) => row.event === 'engine-script-execution')!.name));
      else f.replace('engine-script-execution', row => {
        const script = row.observation.scripts[0];
        if (mode === 'digest') script.sourceTextSha256 = '0'.repeat(64);
        if (mode === 'zero') for (const range of script.coverageRanges) range.count = 0;
        if (mode === 'offset') script.coverageRanges[0].endOffset = script.sourceTextLength + 1;
        if (mode === 'duplicate') row.observation.scripts.push(script);
        if (mode === 'isolate') row.threadId = 1;
      });
      expect(f.observe()).toMatchObject({ status: 'bound', engineExecution: { status: 'unknown' } });
      expect(f.observe().engineExecution.gaps.length).toBeGreaterThan(0);
    });

  it.skipIf(process.platform !== 'linux')('binds a kernel process identity independently of the trace UUID', () => {
    const f = loadedFixture(`import { readFileSync } from 'node:fs';
      console.log(JSON.stringify({ boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
        stat: readFileSync('/proc/self/stat', 'utf8') }));`);
    const raw = JSON.parse(f.nativeOutput);
    const expected = linuxProcessIdentityFromStat(raw.boot, raw.stat);
    expect(expected).toMatch(/^linux:/);
    const observed = observeCommittedReaderLoadedSources({ ...f.options, kernelProcessIdentity: expected! });
    expect(observed).toMatchObject({ status: 'bound', gaps: [], kernelProcessIdentity: expected });
    expect(observed.processIdentity).toBe(f.rows.find(({ row }) => row.event === 'node-entry')!.row.processIdentity);
    expect(observed.processIdentity).not.toBe(expected);
    expect(observeCommittedReaderLoadedSources({ ...f.options,
      kernelProcessIdentity: observed.processIdentity! }).status).toBe('unknown');
  });

  it.each(['missing', 'wrong-pin', 'reused', 'mixed'] as const)(
    'keeps %s kernel process identity evidence unknown', control => {
      const f = loadedFixture();
      const expected = f.kernelProcessIdentity;
      expect(expected).toEqual(expect.any(String));
      if (control === 'missing') f.replace('node-entry', row => { delete row.kernelProcessIdentity; });
      if (control === 'reused') f.replaceAll(row => { row.kernelProcessIdentity = expected + '-reused'; });
      if (control === 'mixed') f.replace('module-load-return', row => { row.kernelProcessIdentity = expected + '-reused'; });
      const observed = observeCommittedReaderLoadedSources({ ...f.options,
        kernelProcessIdentity: control === 'wrong-pin' ? expected + '-wrong' : expected });
      expect(observed.status).toBe('unknown');
      expect(observed.gaps).toEqual(expect.arrayContaining([expect.stringContaining('kernel')]));
      expect(observed.pending).toContain('complete-runtime-closure');
    });

  it('binds original host entry inputs without retaining raw secret values or qualifying resolved config', () => {
    const f = loadedFixture("process.env.PAPERCUSP_TEST_CONFIGURATION_SECRET = 'changed-after-entry';");
    const observed = f.observe();
    expect(observed).toMatchObject({ status: 'bound', configurationInputs: {
      scope: 'native-node-entry-configuration-inputs', status: 'matched', gaps: [],
      snapshot: { envSha256: { PAPERCUSP_TEST_CONFIGURATION_SECRET: digest('private-entry-value') } },
    } });
    expect(observed.pending).toContain('runtime-config');
    expect(JSON.stringify(f.rows)).not.toContain('private-entry-value');
  });

  it('keeps a differing prelaunch configuration unknown without confusing it with source binding', () => {
    const f = loadedFixture();
    f.options.configuration = captureConfigurationSnapshot({ ...f.environment,
      PAPERCUSP_TEST_CONFIGURATION_SECRET: 'different-launch-input' });
    expect(f.observe()).toMatchObject({ status: 'bound', configurationInputs: {
      status: 'unknown', gaps: [expect.stringContaining('configuration inputs differ')],
    } });
  });

  it.each(['missing', 'altered'] as const)('keeps %s entry configuration unknown instead of using parent inputs', mode => {
    const f = loadedFixture();
    f.replace('node-entry', row => {
      if (mode === 'missing') delete row.configuration;
      else row.configuration.envSha256.PAPERCUSP_TEST_CONFIGURATION_SECRET = digest('altered');
    });
    expect(f.observe()).toMatchObject({ status: 'bound', configurationInputs: {
      status: 'unknown', snapshot: null, gaps: ['host entry configuration snapshot missing or invalid'],
    } });
  });

  it('cannot infer independent launch pins from a valid host entry snapshot', () => {
    const f = loadedFixture();
    expect(observeCommittedReaderLoadedSources({ ...f.options, configuration: undefined }))
      .toMatchObject({ status: 'bound', configurationInputs: { status: 'unknown',
        gaps: ['independent prelaunch configuration snapshot missing or invalid'] } });
  });

  it('binds original build observations while preserving missing preparation and runtime qualification', () => {
    const f = loadedFixture(undefined, true, true);
    expect(f.observe()).toMatchObject({ status: 'bound', gaps: [],
      sources: [{ sha256: f.closure.sha256 }], pending: expect.arrayContaining([
        'preparation-qualification', 'observed-imports', 'module-evaluation', 'runtime-config',
        'private-pg', 'sidecars', 'complete-runtime-closure']) });
    expect(() => qualifyCommittedReaderSource({ ...f.options, preparationOnly: true })).toThrow();
  });

  it('binds an independently pinned product-sized bundle above both generic byte ceilings', () => {
    // The measured private operator bundle was 81,830,447 bytes. Keep this
    // regression large enough to exercise both the old 16MiB and 64MiB limits.
    const source = '/*' + ' '.repeat(81_830_447) + '*/export const host = 1;';
    const f = loadedFixture(source);
    const observed = f.observe();
    expect(observed).toMatchObject({ status: 'bound', gaps: [],
      sources: [{ sha256: digest(source), byteLength: Buffer.byteLength(source) }] });
    expect(observed.pending).toContain('complete-runtime-closure');
    // Existing files must not backfill altered loader artifacts.
    const load = f.rows.find(({ row }) => row.event === 'module-load-return')!.row;
    writeFileSync(join(f.traceRoot, load.source.ref), 'altered retained bytes');
    expect(f.observe().status).toBe('unknown');
  });

  it('keeps an unadmitted large source unknown with the original generic limits', () => {
    const f = loadedFixture('/*' + ' '.repeat(16 * 1024 ** 2) + '*/', false);
    expect(f.observe()).toMatchObject({ status: 'unknown',
      limits: { sourceBytes: 16 * 1024 ** 2, processBytes: 64 * 1024 ** 2 } });
    expect(f.rows.find(({ row }) => row.event === 'module-load-return')!.row.source.status).toBe('limit');
  });

  it('binds real Node returned bundle bytes and preserves all broader runtime gaps', () => {
    const f = loadedFixture();
    const observed = f.observe();
    expect(observed).toMatchObject({ status: 'bound', scope: 'node-loader-returned-source', gaps: [],
      sourceCommit: f.options.selectedCommit, population: { complete: true }, exitObserved: true,
      sources: [{ url: pathToFileURL(f.bundle).href, sha256: f.closure.sha256,
        byteLength: readFileSync(f.bundle).length }] });
    expect(observed.processIdentity).toBe(f.rows.find(({ row }) => row.event === 'node-entry')!.row.processIdentity);
    expect(observed.pending).toEqual(['module-evaluation', 'runtime-config', 'private-pg', 'sidecars',
      'descendant-imports', 'complete-runtime-closure']);
    expect(observeCommittedReaderLoadedSources({ ...f.options, kernelProcessIdentity: 'another-process' }).status).toBe('unknown');
  });

  it.each(['bytes', 'artifact', 'limit', 'load-limit', 'pending', 'entry', 'identity', 'cwd', 'unpinned', 'event-hash'] as const)(
    'keeps %s evidence unknown instead of substituting the current file', control => {
      const f = loadedFixture();
      const load = f.rows.find(({ row }) => row.event === 'module-load-return')!.row;
      if (control === 'bytes') f.replace('module-load-return', row => {
        const bytes = 'different loader return'; const sha256 = digest(bytes);
        writeFileSync(join(f.traceRoot, sha256 + '.source'), bytes);
        row.source = { ...row.source, sha256, ref: sha256 + '.source', byteLength: Buffer.byteLength(bytes) };
      });
      if (control === 'artifact') rmSync(join(f.traceRoot, load.source.ref));
      if (control === 'limit') f.replace('module-load-return', row => { row.source.status = 'limit'; });
      if (control === 'load-limit') {
        const entry = f.rows.find(({ row }) => row.event === 'node-entry')!.row;
        const bytes = JSON.stringify({ ...entry, event: 'module-load-limit', limit: 128 });
        writeFileSync(join(f.traceRoot, digest(bytes) + '.json'), bytes);
      }
      if (control === 'entry') rmSync(join(f.traceRoot, f.rows.find(({ row }) => row.event === 'node-entry')!.name));
      if (control === 'pending') {
        const entry = f.rows.find(({ row }) => row.event === 'module-load-return')!;
        rmSync(join(f.traceRoot, entry.name));
      }
      if (control === 'identity') f.replace('module-load-return', row => { row.processIdentity = 'reused-pid'; });
      if (control === 'cwd') f.replace('node-entry', row => { row.cwd = f.dir; });
      if (control === 'unpinned') {
        const url = pathToFileURL(join(f.root, 'unobserved.mjs')).href;
        f.replace('module-load-start', row => { row.url = url; });
        f.replace('module-load-return', row => { row.url = url; });
      }
      if (control === 'event-hash') {
        const entry = f.rows.find(({ row }) => row.event === 'node-entry')!;
        writeFileSync(join(f.traceRoot, entry.name), JSON.stringify({ ...entry.row, cwd: f.dir }));
      }
      const observed = f.observe();
      expect(observed.status).toBe('unknown');
      expect(observed.gaps.length).toBeGreaterThan(0);
      expect(observed.pending).toContain('complete-runtime-closure');
      expect(readFileSync(f.bundle, 'utf8')).toBe('export const host = 1;');
    });

  it('refuses drifted independent preparation rather than qualifying a loader claim', () => {
    const f = loadedFixture();
    writeFileSync(f.bundle, 'changed artifact');
    expect(() => f.observe()).toThrow(/Prepared artifact changed/);
  });
});

describe('private worker source selection before allocation', () => {
  const committedEnv = { NODE_OPTIONS: '--import=/repo/scripts/lib/committed-source-loader.mjs' };
  it('refuses mutable private proof even when named HEAD bytes match', () => {
    const f = fixture();
    rmSync(join(f.root, '.verifier-source.json'));
    const reader = vi.fn(() => Buffer.from('helper.ts'));
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], committedEnv, reader))
      .toThrow(/independent verifier source receipt/);
    expect(reader).not.toHaveBeenCalled();
  });
  it('refuses a frozen private proof without its independent receipt before any HEAD read', () => {
    const f = fixture(); const reader = vi.fn(() => Buffer.from('helper.ts'));
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], {}, reader))
      .toThrow(/independent verifier source receipt/);
    expect(reader).not.toHaveBeenCalled();
  });
  it('rejects a changed worker helper that the inherited loader would replace with HEAD', () => {
    const f = fixture();
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'],
      { ...committedEnv, VERIFY_TAURI_SOURCE_RECEIPT: f.options.sourceReceiptPath },
      () => Buffer.from('older helper'))).toThrow(/different HEAD bytes: helper.ts/);
  });
  it('records exact matching committed inputs and fails closed when their HEAD read fails', () => {
    const f = fixture();
    const env = { ...committedEnv, VERIFY_TAURI_SOURCE_RECEIPT: f.options.sourceReceiptPath };
    expect(preparePrivateWorkerSources(f.root, ['helper.ts'], env,
      () => Buffer.from('helper.ts'))).toMatchObject({ loader: 'committed-source',
      files: [{ path: 'helper.ts', sha256: digest('helper.ts') }] });
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], env,
      () => { throw new Error('HEAD unreadable'); })).toThrow('HEAD unreadable');
  });
  it('pins the frozen receipt without a HEAD loader and refuses selected source drift', () => {
    const f = fixture(); const reader = vi.fn(() => { throw new Error('must not read HEAD'); });
    const env = { VERIFY_TAURI_SOURCE_RECEIPT: f.options.sourceReceiptPath,
      VERIFY_TAURI_SOURCE_REF: f.options.selectedCommit };
    expect(preparePrivateWorkerSources(f.root, ['helper.ts'], env, reader)).toMatchObject({
      loader: 'verifier-source', files: [{ path: 'helper.ts', sha256: digest('helper.ts') }],
      frozenSource: { sourceCommit: f.options.selectedCommit, receiptPath: f.options.sourceReceiptPath,
        receiptSha256: digest(readFileSync(f.options.sourceReceiptPath)) },
    });
    expect(reader).not.toHaveBeenCalled();
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], { ...env, VERIFY_TAURI_SOURCE_REF: 'b'.repeat(40) }))
      .toThrow(/selected source differs/);
    writeFileSync(join(f.root, 'helper.ts'), 'peer drift');
    expect(() => preparePrivateWorkerSources(f.root, ['helper.ts'], env, reader))
      .toThrow(/tampered verification source archive: changed helper.ts/);
    expect(reader).not.toHaveBeenCalled();
  });
  it('preserves working-source execution without invoking a committed reader when no loader selects HEAD', () => {
    const f = fixture(); const reader = vi.fn(() => { throw new Error('must not read HEAD'); });
    rmSync(join(f.root, '.verifier-source.json'));
    expect(preparePrivateWorkerSources(f.root, ['helper.ts'], {}, reader).loader).toBe('working-source');
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('original build observations without runtime qualification', () => {
  it('admits archive workspace links through preparation and dependency recheck', () => {
    const f = observedBuildFixture();
    const built = f.produceObserved();
    const inputs = JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-inputs.json'), 'utf8'));
    expect(inputs.dependencyFiles).toContainEqual({ path: 'workspace-helper', kind: 'symlink',
      executable: true, sha256: digest('../helper.ts') });
    expect(built.qualification).toEqual({ status: 'pending' });
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it('refuses an escaping workspace link before invoking the compiler', () => {
    const f = observedBuildFixture();
    writeFileSync(join(f.dir, 'external.ts'), 'external');
    const link = join(f.root, 'node_modules/workspace-helper');
    rmSync(link); symlinkSync('../../external.ts', link);
    expect(() => f.produceObserved()).toThrow(/archive symlink escapes source root/);
    expect(existsSync(`${f.bundle}.builds`)).toBe(false);
  });

  it('refuses workspace link retargeting during compilation', () => {
    const f = observedBuildFixture('rm node_modules/workspace-helper\nln -s ../import.ts node_modules/workspace-helper\n');
    expect(() => f.produceObserved()).toThrow(/Materialized dependencies changed during build/);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
  });

  it('retains independent inputs before compilation and refuses them at the qualified consumer', () => {
    const f = observedBuildFixture();
    const built = f.produceObserved();
    const inputs = JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-inputs.json'), 'utf8'));
    expect(inputs).toEqual({ phase: 'build-observation', sourceCommit: f.selected.selectedCommit,
      dependencyFiles: f.closure.dependencyFiles });
    expect(built).toMatchObject({ path: f.bundle, qualification: { status: 'pending' },
      receiptSha256: digest(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'))) });
    expect(() => f.consume()).toThrow();
    expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + built.sha256,
      '--prepared-receipt-sha=' + built.receiptSha256], join(f.dir, 'execute'))).toThrow();
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    expect(() => f.produceObserved()).toThrow(/fresh preparation directory/);
  });

  it.each(['source', 'dependencies', 'inputs'] as const)(
    'retains original inputs and refuses %s drift during compilation', dimension => {
      const script = dimension === 'source' ? 'printf changed > helper.ts\n'
        : dimension === 'dependencies' ? 'printf changed > node_modules/example/index.js\n'
        : 'printf changed > "$(dirname "$2")/operator-api-inputs.json"\n';
      const f = observedBuildFixture(script);
      expect(() => f.produceObserved()).toThrow();
      expect(existsSync(join(f.dir, 'prepare/verifier-source.json'))).toBe(true);
      expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
      expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    });

  it('refuses a changed selected receipt before invoking the compiler', () => {
    const f = observedBuildFixture();
    writeFileSync(f.selected.sourceReceiptPath, readFileSync(f.selected.sourceReceiptPath, 'utf8') + '\n');
    expect(() => f.produceObserved()).toThrow(/Pinned selected source receipt changed/);
    expect(existsSync(`${f.bundle}.builds`)).toBe(false);
  });

  it('uses the same retained inputs with the maintained asynchronous builder', async () => {
    const f = observedBuildFixture();
    const built = await preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), {
      observedSource: f.observedSource, builder: { timeoutMs: 2000, maxMs: 5000 },
    });
    expect(built.qualification).toEqual({ status: 'pending' });
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    expect(() => f.consume()).toThrow();
  });
});

describe('retained committed reader producer and consumer', () => {
  it('builds once at the allocated path and consumes the original pinned artifacts without rebuilding', () => {
    const f = producerFixture();
    expect(f.inputs).not.toHaveProperty('sha256');
    expect(f.inputs).not.toHaveProperty('metafileSha256');
    const produced = f.produce();
    const original = readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'));
    expect(f.consume()).toEqual(produced);
    expect(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toEqual(original);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    expect(produced.path).toBe(f.bundle);
    const receipt = JSON.parse(String(original));
    expect(receipt).toMatchObject({ phase: 'produced', inputReceipt: {
      path: join(f.dir, 'prepare/operator-api-inputs.json'), sha256: digest(readFileSync(f.selected.inputReceiptPath)),
    }, qualification: { status: 'preparation-qualified',
      pending: ['actual-private-schema', 'actual-private-environment', 'loaded-host'] } });
    expect(receipt.artifactCensus.map((file: { path: string }) => file.path)).toEqual([
      'asset.sql', 'hono-host.mjs', 'hono-host.mjs.builds', 'hono-host.mjs.meta.json',
      'operator-api-build-result.json', 'operator-api-build.log',
    ]);
    expect(() => f.produce()).toThrow(/fresh allocated/);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it.each(['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'dependencyFiles',
    'externalResolutions', 'schema', 'environment', 'copiedArtifacts'] as const)(
    'refuses missing independent %s before builder or runtime allocation', dimension => {
      const f = producerFixture(); delete (f.inputs as Partial<CommittedReaderPreparationInputs>)[dimension]; f.saveInputs();
      const allocateRuntime = vi.fn();
      expect(() => { f.produce(); allocateRuntime(); }).toThrow();
      expect(allocateRuntime).not.toHaveBeenCalled();
      expect(existsSync(`${f.bundle}.builds`)).toBe(false);
      expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
    });

  it.each(['omitted', 'opaque'] as const)('refuses unresolved independent %s before compiling', dimension => {
    const f = producerFixture(); f.inputs[dimension] = ['unobserved child imports']; f.saveInputs();
    expect(() => f.produce()).toThrow(new RegExp(dimension));
    expect(existsSync(`${f.bundle}.builds`)).toBe(false);
  });

  it.each(['../asset.sql', 'operator-api-inputs.json', 'hono-host.mjs'])('refuses invalid or reserved copy output %s', path => {
    const f = producerFixture(); f.inputs.copiedArtifacts[0].path = path; f.saveInputs();
    expect(() => f.produce()).toThrow(/artifact path|reserved preparation path/);
    expect(existsSync(`${f.bundle}.builds`)).toBe(false);
  });

  it.each(['hono-host.mjs', 'hono-host.mjs.meta.json', 'asset.sql', 'operator-api-inputs.json',
    'verifier-source.json'])( 'refuses retained %s drift without a consumer rebuild', path => {
      const f = producerFixture(); f.produce();
      writeFileSync(join(f.dir, 'prepare', path), readFileSync(join(f.dir, 'prepare', path), 'utf8') + '\n');
      const allocateRuntime = vi.fn();
      expect(() => { f.consume(); allocateRuntime(); }).toThrow();
      expect(allocateRuntime).not.toHaveBeenCalled();
      expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    });

  it('refuses a valid-looking partial output receipt at both consumer and sanitized worker handoffs', () => {
    const f = producerFixture(); f.produce();
    const path = join(f.dir, 'prepare/operator-api-preflight.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.qualification = { status: 'pending' };
    writeFileSync(path, JSON.stringify(receipt));
    expect(() => f.consume()).toThrow(/Partial produced preparation/);
    expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + receipt.sha256,
      '--prepared-receipt-sha=' + digest(readFileSync(path))], join(f.dir, 'execute')))
      .toThrow(/Partial produced preparation/);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it('retains pending output after a graph gap and refuses it instead of falling back to a generic build', () => {
    const f = producerFixture(); f.inputs.executedImports = ['helper.ts']; f.saveInputs();
    expect(() => f.produce()).toThrow(/absent from observed import closure/);
    const path = join(f.dir, 'prepare/operator-api-preflight.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).qualification).toEqual({ status: 'pending' });
    expect(() => f.consume()).toThrow(/Partial produced preparation/);
    expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
  });

  it.each(['consumer', 'worker'] as const)('refuses downgraded producer phase at the %s handoff', handoff => {
    for (const phase of [undefined, 'planned', 'legacy']) {
      const f = producerFixture(); f.produce();
      const path = join(f.dir, 'prepare/operator-api-preflight.json');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      receipt.phase = phase; receipt.qualification = { status: 'pending' };
      writeFileSync(path, JSON.stringify(receipt));
      const allocateRuntime = vi.fn();
      const consume = () => handoff === 'consumer' ? f.consume()
        : resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + receipt.sha256,
          '--prepared-receipt-sha=' + digest(readFileSync(path))], join(f.dir, 'execute'));
      expect(() => { consume(); allocateRuntime(); }).toThrow(/Produced preparation phase is required/);
      expect(allocateRuntime).not.toHaveBeenCalled();
      expect(readFileSync(`${f.bundle}.builds`, 'utf8')).toBe('build\n');
    }
  });

  it.each(['inputReceipt', 'artifactCensus', 'qualification'] as const)(
    'refuses a legacy-looking receipt carrying producer %s without a producer phase', dimension => {
      const f = fixture();
      const selected = { receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
        selectedCommit: f.options.selectedCommit };
      preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: selected });
      const path = join(f.dir, 'prepare/operator-api-preflight.json');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      delete receipt.qualification;
      receipt[dimension] = dimension === 'qualification' ? { status: 'pending' } : null;
      writeFileSync(path, JSON.stringify(receipt));
      expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
        ...selected, receiptPath: path, sourceReceiptPath: join(f.dir, 'prepare/verifier-source.json'),
      } })).toThrow(/Produced preparation phase is required/);
      expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + receipt.sha256,
        '--prepared-receipt-sha=' + digest(readFileSync(path))], join(f.dir, 'execute')))
        .toThrow(/Produced preparation phase is required/);
    });

  it('rejects an independently digested input receipt whose required pins disagree with produced claims', () => {
    const f = producerFixture(); f.produce();
    const inputPath = join(f.dir, 'prepare/operator-api-inputs.json');
    const path = join(f.dir, 'prepare/operator-api-preflight.json');
    const inputs = JSON.parse(readFileSync(inputPath, 'utf8')); inputs.executedImports = ['helper.ts'];
    writeFileSync(inputPath, JSON.stringify(inputs));
    const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.inputReceipt.sha256 = digest(readFileSync(inputPath));
    writeFileSync(path, JSON.stringify(receipt));
    expect(() => f.consume()).toThrow(/Produced input pin differs: executedImports/);
  });
});

describe('selected committed reader preparation closure', () => {
  it('qualifies preparation without claiming actual private schema, environment or loaded-host proof', () => {
    const f = fixture();
    const receipt = qualifyCommittedReaderSource({ ...f.options, preparationOnly: true });
    expect(receipt.pending).toEqual(['actual-private-schema', 'actual-private-environment', 'loaded-host']);
    expect(receipt.checked).not.toContain('required-private-schema');
    expect(receipt.checked).not.toContain('required-environment');
    expect(() => qualifyCommittedReaderSource({ ...f.options, environment: {} })).toThrow(/environment missing/);
  });

  it('refuses missing independent selection before invoking a bundle builder', () => {
    const f = fixture();
    expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
      sourceReceiptPath: f.options.sourceReceiptPath, receiptPath: join(f.dir, 'missing-closure.json'),
      selectedCommit: f.options.selectedCommit,
    } })).toThrow(/missing-closure.json/);
    expect(readFileSync(f.bundle, 'utf8')).toBe('export const host = 1;');
  });

  it.each(['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'dependencyFiles',
    'externalResolutions', 'artifacts', 'schema', 'environment', 'sha256', 'metafileSha256'] as const)(
    'refuses a missing %s pin before the builder has side effects', dimension => {
      const f = fixture();
      prepareBuilder(f, 'touch "$2.builder-started"\n');
      delete (f.closure as Partial<CommittedReaderClosure>)[dimension]; f.save();
      expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
        receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
        selectedCommit: f.options.selectedCommit,
      } })).toThrow();
      expect(existsSync(`${f.bundle}.builder-started`)).toBe(false);
      expect(existsSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toBe(false);
    });

  it.each(['schema', 'environment'] as const)('refuses empty required %s before compilation', dimension => {
    const f = fixture(); prepareBuilder(f, 'touch "$2.builder-started"\n');
    f.closure[dimension] = {}; f.save();
    expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
      receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
      selectedCommit: f.options.selectedCommit,
    } })).toThrow();
    expect(existsSync(`${f.bundle}.builder-started`)).toBe(false);
  });

  it.each(['sha256', 'metafileSha256'] as const)('refuses malformed %s before compilation', dimension => {
    const f = fixture(); prepareBuilder(f, 'touch "$2.builder-started"\n');
    f.closure[dimension] = 'unknown'; f.save();
    expect(() => preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
      receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath,
      selectedCommit: f.options.selectedCommit,
    } })).toThrow();
    expect(existsSync(`${f.bundle}.builder-started`)).toBe(false);
  });

  it('retains independent preparation pins across the sanitized worker boundary and rejects receipt drift', () => {
    const f = fixture();
    // Preparation-only builder fixture: preserve the already pinned artifacts.
    prepareBuilder(f);
    const source = JSON.parse(readFileSync(f.options.sourceReceiptPath, 'utf8'));
    const prepared = preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'), { committedReader: {
      receiptPath: f.options.receiptPath, sourceReceiptPath: f.options.sourceReceiptPath, selectedCommit: source.sourceCommit,
    } });
    const execute = join(f.dir, 'execute'); mkdirSync(execute);
    const argv = ['--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256];
    const selection = resolvePreparedCommittedReaderSource(argv, execute);
    expect(selection).toEqual({ sourceReceiptPath: join(f.dir, 'prepare/verifier-source.json'), selectedCommit: source.sourceCommit,
      sourceReceiptSha256: digest(readFileSync(f.options.sourceReceiptPath)), receiptSha256: prepared.receiptSha256 });
    const retained = JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), 'utf8'));
    expect(retained).toMatchObject({ ...f.closure, selectedSource: prepared.selectedSource,
      qualification: { pending: ['actual-private-schema', 'actual-private-environment', 'loaded-host'] } });
    writeFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), JSON.stringify({ ...retained, sourceCommit: 'b'.repeat(40) }));
    expect(() => resolvePreparedCommittedReaderSource(argv, execute)).toThrow(/receipt changed/);
    expect(() => qualifyCommittedReaderSource({ ...f.options, ...selection,
      receiptPath: join(f.dir, 'prepare/operator-api-preflight.json') })).toThrow(/Pinned preparation receipt changed/);
    writeFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), JSON.stringify(retained));
    writeFileSync(selection.sourceReceiptPath, readFileSync(selection.sourceReceiptPath, 'utf8') + '\n');
    expect(() => qualifyCommittedReaderSource({ ...f.options, ...selection,
      receiptPath: join(f.dir, 'prepare/operator-api-preflight.json') })).toThrow(/Pinned selected source receipt changed/);
  });

  it.each(['source-receipt.json', 'operator-api-preflight.json'])('refuses %s drift during preparation before publishing the handoff', name => {
    const f = producerFixture(`printf '\\n' >> "$(dirname "$2")/../${name}"\n`);
    expect(() => f.produce()).toThrow(/receipt changed during preparation/);
    expect(() => readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'))).toThrow(/ENOENT/);
  });

  it('preserves the generic preparation and digest-only worker handoff without a committed-reader selection', () => {
    const f = fixture(); prepareBuilder(f);
    const prepared = preparePrivateOperatorApiBundle(f.root, join(f.dir, 'prepare'));
    expect(JSON.parse(readFileSync(join(f.dir, 'prepare/operator-api-preflight.json'), 'utf8')))
      .toEqual({ path: f.bundle, sha256: digest(readFileSync(f.bundle)) });
    expect(resolvePreparedPrivateApiBundle(['--prepared-api-sha=' + prepared.sha256], join(f.dir, 'execute')))
      .toBe(f.bundle);
    expect(() => resolvePreparedCommittedReaderSource(['--prepared-api-sha=' + prepared.sha256], join(f.dir, 'execute')))
      .toThrow(/pinned preparation receipt/);
  });

  it('accepts matching independent source, build, external, dependency, schema and environment pins as preparation only', () => {
    const f = fixture();
    expect(qualifyCommittedReaderSource(f.options)).toMatchObject({ sourceCommit: 'a'.repeat(40),
      sha256: f.closure.sha256, omitted: [], opaque: [], hostStarted: false, httpStarted: false });
  });

  it.each(['helper.ts', 'config.ts', 'import.ts', 'asset.sql'])('refuses changed required %s before host startup', path => {
    const f = fixture(); writeFileSync(join(f.root, path), 'changed');
    const startHost = vi.fn();
    expect(() => { qualifyCommittedReaderSource(f.options); startHost(); }).toThrow(/tampered verification source archive/);
    expect(startHost).not.toHaveBeenCalled();
  });

  it('refuses a missing required source member', () => {
    const f = fixture(); rmSync(join(f.root, 'import.ts'));
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/missing import.ts/);
  });

  it.each(['omitted', 'opaque'] as const)('refuses unresolved required %s without starting a host', dimension => {
    const f = fixture(); f.closure[dimension] = ['subprocess imports']; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(new RegExp(dimension));
  });

  it('refuses a missing config dimension instead of treating it as an empty census', () => {
    const f = fixture(); delete (f.closure as Partial<CommittedReaderClosure>).configPaths; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/dimension missing: configPaths/);
  });

  it('refuses a build input outside the independently recorded import closure', () => {
    const f = fixture(); f.closure.executedImports = ['helper.ts']; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/absent from observed import closure: import.ts/);
  });

  it('refuses dependency bytes changed after independent preparation', () => {
    const f = fixture(); writeFileSync(join(f.root, 'node_modules/example/index.js'), 'module.exports = 2');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Materialized dependency census differs/);
  });

  it('refuses an omitted external resolution pin', () => {
    const f = fixture(); f.closure.externalResolutions = {}; f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/External resolution census differs/);
  });

  it.each(['bundle', 'graph'] as const)('refuses changed prepared %s bytes', artifact => {
    const f = fixture(); writeFileSync(artifact === 'bundle' ? f.bundle : `${f.bundle}.meta.json`, 'changed');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/changed/);
  });

  it('refuses a schema mismatch rather than using migration source presence', () => {
    const f = fixture(); f.options.schema['harness_shared.tool_invocations.args_json'] = digest('text:nullable');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Applied required private schema differs/);
  });

  it('refuses an omitted copied-source artifact mapping', () => {
    const f = fixture(); f.closure.artifacts = f.closure.artifacts.filter(artifact => !artifact.sourcePath); f.save();
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/Copied source lacks retained artifact mapping/);
  });

  it('refuses a changed required environment setting', () => {
    const f = fixture(); f.options.environment.PAPERCUSP_BACKGROUND_WORKERS = '1';
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/environment differs/);
  });

  it('refuses a sibling selected commit', () => {
    const f = fixture(); f.options.selectedCommit = 'b'.repeat(40);
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/differs from selected committed source/);
  });

  it('refuses a closure receipt inside the archive', () => {
    const f = fixture(); f.options.receiptPath = join(f.root, '.verifier-source.json');
    expect(() => qualifyCommittedReaderSource(f.options)).toThrow(/must be independent/);
  });
});
