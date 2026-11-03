import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReplayOracleRuntimeQualified, freezeQualifiedReplayConfig, qualifyReplayOracleRuntime, replayHash, replayLoadedRuntime, replayOracleFingerprint,
  replayRuntimeHeapArgs, replayRuntimeLaunch, replaySourceFingerprint, type DaemonReplayConfig, type ReplayRuntimeWitness } from './lsp-fleet-replay-runtime';
import { readProcessIdentity } from '../process-identity';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { buildSync } from 'esbuild';
import { buildTaskScopeArgvWithTransport, SYSTEMD_ENV_RUNNER_PATH, SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from '../systemd-scope';

const scopeProbeArgv = ['--user', '--scope', '--quiet', ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS, '--', 'true'];

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(extension = 'mjs', source = 'console.log("executed");') {
  const root = mkdtempSync(join(tmpdir(), 'lsp-load-witness-')); roots.push(root);
  const entry = join(root, `entry.${extension}`);
  writeFileSync(entry, source);
  const launch = replayRuntimeLaunch(entry, root, 'witness-test');
  return { root, entry, launch };
}
function receipts(root: string) {
  const names = readdirSync(root).filter(name => name.endsWith('.jsonl'));
  return names.flatMap(name => readFileSync(join(root, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
}
async function withLiveRuntime(f: ReturnType<typeof fixture>, check: (pids: number[], root: ChildProcess) => Promise<void> | void) {
  const child = spawn(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stderr!.on('data', chunk => { errors += chunk; });
  try {
    const pids = await new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`runtime startup timeout: ${errors}`)), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`runtime exited ${code}: ${errors}`)); });
      child.stdout!.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).pids); }
      });
    });
    await check([child.pid!, ...pids], child);
  } finally {
    // Each instrumented process has its own PID receipt; fixture teardown must
    // reap descendants too, including when the assertion before shutdown fails.
    for (const row of receipts(f.root).filter(row => row.kind === 'bootstrap')) {
      try { process.kill(row.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    child.kill();
    await closed;
  }
}
function liveWitness(f: ReturnType<typeof fixture>, files: string[]) {
  const library = '/test-native-mapping';
  const witness: ReplayRuntimeWitness = { directory: f.root, runId: 'witness-test',
    bootstraps: { [f.entry]: f.launch.evalSha256 },
    files: { ...Object.fromEntries(files.map(path => [path, replayHash(readFileSync(path))])), [library]: replayHash('fixture native') } };
  // Native mapping access is independently tested below. Here it is an explicit
  // fixture; cmdline, stat, process identity and source receipts are real.
  const reader = { identity: readProcessIdentity, link: () => '', bytes: () => Buffer.from('fixture native'),
    text: (path: string) => path.endsWith('/maps') ? `1-2 r-xp 0 00:01 9 ${library}\n` : readFileSync(path, 'utf8') };
  return { witness, reader };
}
describe('independent parent oracle producer', () => {
  it('preserves only validated heap arguments, with Node argv precedence and no preload arguments', () => {
    expect(replayRuntimeHeapArgs(['--max_old_space_size', '384', '--import=/foreign.mjs'],
      '--require=/foreign.cjs --max-old-space-size=256')).toEqual(['--max-old-space-size=384']);
    expect(replayRuntimeHeapArgs([], '--import="/foreign --max-old-space-size=2048"')).toEqual([]);
    expect(replayRuntimeHeapArgs([], '--require "--max-old-space-size=2048"')).toEqual([]);
    expect(replayRuntimeHeapArgs([], '--max-old-space-size=256 --max-old-space-size=320'))
      .toEqual(['--max-old-space-size=320']);
    expect(replayRuntimeHeapArgs(['--eval', '--max-old-space-size=1024'], '')).toEqual([]);
    for (const value of ['0', '-1', '256.5', '9007199254740992', '256x'])
      expect(() => replayRuntimeHeapArgs([], `--max-old-space-size=${value}`)).toThrow('invalid-replay-runtime-heap-budget');
  });
  describe('maintained compiler integration', () => {
    let prepared: { root: string; cli: string; inputPath: string; outputPath: string; optionsPath: string;
      witnessDirectory: string; compilerEntries: string[] };
    let integrationRoot: string | undefined;
    afterAll(() => { if (integrationRoot) rmSync(integrationRoot, { recursive: true, force: true }); });
    beforeAll(() => {
    const startedAt = performance.now();
    const f = fixture('cjs');
    integrationRoot = f.root;
    roots.splice(roots.indexOf(f.root), 1); // Shared setup belongs to this suite's afterAll.
    const sourceRoot = join(f.root, 'source'); mkdirSync(sourceRoot);
    writeFileSync(join(sourceRoot, 'source.ts'), 'export function hot() {}\nhot();\n');
    writeFileSync(join(sourceRoot, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const require = createRequire(import.meta.url);
    const compiler = require.resolve('typescript');
    const compilerRoot = dirname(dirname(compiler));
    // The pinned package is an executable shim, not the compiler implementation.
    // Resolve its declared delegate before the child runs, never from receipts.
    const delegate = createRequire(compiler).resolve('@typescript/old');
    const delegateRoot = dirname(dirname(delegate));
    mkdirSync(join(f.root, 'node_modules'));
    symlinkSync(compilerRoot, join(f.root, 'node_modules', 'typescript'));
    const cli = join(f.root, 'cli.cjs');
    buildSync({ entryPoints: [fileURLToPath(new URL('./lsp-saturation-bench-cli.ts', import.meta.url))],
      outfile: cli, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      // Bundle the workspace source the startup graph reaches eagerly: lib/verifier-source.ts
      // re-exports @papercusp/test-config/verifier-source and self-imports operator-core by bare
      // specifier (58ede1a50e), and this tmpdir holds only typescript in node_modules.
      alias: {
        '@papercusp/test-config/vitest-failure-classification': fileURLToPath(new URL('../../../../libs/test-config/src/vitest-failure-classification.mjs', import.meta.url)),
        '@papercusp/test-config': fileURLToPath(new URL('../../../../libs/test-config/src', import.meta.url)),
        '@papercusp/operator-core': fileURLToPath(new URL('../..', import.meta.url)),
        'shell-quote': require.resolve('shell-quote'),
      },
      banner: { js: 'process.umask(0);' },
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(cli).href) }, logLevel: 'silent' });
    console.info(JSON.stringify({ kind: 'oracle-fixture-phase', phase: 'bundle-complete', elapsedMs: performance.now() - startedAt }));
    writeFileSync(join(f.root, 'lsp-replay-runtime-witness.cjs'),
      readFileSync(fileURLToPath(new URL('./lsp-replay-runtime-witness.cjs', import.meta.url))));
    const inputPath = join(f.root, 'input.json');
    writeFileSync(inputPath, JSON.stringify({ runId: 'actual-compiler-producer', rootPath: sourceRoot,
      socketPath: join(f.root, 'socket'), workspaceId: 'fixture', levels: [1], requestTimeoutMs: 1000,
      tsconfigPath: 'tsconfig.json', definition: { file: 'source.ts', line1: 1, character: 17 },
      references: { file: 'source.ts', line1: 1, character: 17 }, runtimeFiles: [], evidenceRef: 'authored-before-launch' }));
    const optionsPath = join(f.root, 'options.json');
    const witnessDirectory = join(f.root, 'native-receipts');
    const compilerEntries = [compiler, delegate, join(dirname(delegate), '_typescript.js')].filter(existsSync);
    writeFileSync(optionsPath, JSON.stringify({ freezerEntry: cli, compilerEntries,
      runtimePaths: [compilerRoot, delegateRoot], witnessDirectory, timeoutMs: 15_000 }));
    const outputPath = join(f.root, 'qualified.json');
    prepared = { root: f.root, cli, inputPath, outputPath, optionsPath, witnessDirectory, compilerEntries };
    }, 30_000);
    it('checks the complete bundled startup graph before launching a compiler', () => {
    const startedAt = performance.now();
    const { cli, inputPath, outputPath } = prepared;
    // Check the whole bundled startup graph without launching a compiler. A
    // missing dependency must retain its diagnostic, not surface as no receipts.
    let preflight = '';
    try { execFileSync(process.execPath, [cli, '--freeze-replay-child', inputPath, outputPath],
      { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 5000 }); }
    catch (error) { preflight = String((error as { stderr?: Buffer | string }).stderr ?? error); }
    expect(preflight).toContain('replay-oracle-parent-channel-required');
    console.info(JSON.stringify({ kind: 'oracle-fixture-phase', phase: 'startup-preflight-complete', elapsedMs: performance.now() - startedAt }));
    });
    it('runs the actual compiler with the kernel native-mapping evaluator and parent heap argv', () => {
    const { cli, inputPath, outputPath, optionsPath, witnessDirectory, compilerEntries } = prepared;
    // Elevation is an explicit integration-run choice. Ordinary CI still checks
    // fail-closed behavior when the kernel denies mapped-inode reads.
    const privileged = process.env.PAPERCUSP_REPLAY_NATIVE_PROOF === 'required';
    const launcher = privileged ? 'sudo' : process.execPath;
    // This survives sudo's environment sanitization, then must survive the
    // producer's separate child launch without enabling any ambient preload.
    const args = ['--max-old-space-size=512', cli, '--freeze-qualified-replay', inputPath, outputPath, optionsPath];
    if (privileged) args.unshift('-n', process.execPath);
    let failure = '';
    try { execFileSync(launcher, args, { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 25_000 }); }
    catch (error) { failure = String((error as { stderr?: Buffer | string }).stderr ?? error); }
    expect(existsSync(witnessDirectory), failure).toBe(true);
    if (privileged) execFileSync('sudo', ['-n', 'chmod', '-R', 'a+rX', witnessDirectory]);
    const rows = receipts(witnessDirectory);
    for (const entry of compilerEntries) expect(rows).toContainEqual(expect.objectContaining({
      kind: 'commonjs-compile', path: entry, sha256: replayHash(readFileSync(entry)) }));
    const boot = rows.find(row => row.kind === 'bootstrap');
    expect(boot).toBeDefined();
    expect(boot.execArgv.slice(0, -2)).toEqual(['--max-old-space-size=512']);
    expect(boot.nodeOptions).toBe('');
    expect(readProcessIdentity(boot.pid)).toBeNull();
    if (failure) {
      expect(privileged, failure).toBe(false);
      expect(failure).toContain('unreadable-native-mappings');
      expect(failure).not.toContain('unfrozen-loaded-bytes');
      expect(existsSync(outputPath)).toBe(false);
    } else {
      const qualified = JSON.parse(readFileSync(outputPath, 'utf8')) as DaemonReplayConfig;
      expect(() => assertReplayOracleRuntimeQualified(qualified)).not.toThrow();
      expect(qualified.corpus['hot-references'].oracle.sites).toEqual([
        { path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }]);
      expect(qualified.oracleProvenance.runtime!.process.loadedModules).toMatchObject({ unknown: [], native: expect.any(Array) });
      expect(JSON.parse(readFileSync(join(witnessDirectory, 'terminal.json'), 'utf8'))).toMatchObject({ code: 0, signal: null });
    }
  }, 30_000);
  });
  function producer(suffix = '') {
    const f = fixture('cjs', `const fs=require('node:fs');require('./compiler.cjs');
      const input=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
      const config=JSON.parse(fs.readFileSync(input.configPath,'utf8'));
      const candidatePath=process.argv[4];
      const bytes=JSON.stringify(config);fs.writeFileSync(candidatePath,bytes,{flag:'wx'});
      const sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      process.on('message',row=>{
        if(row.kind!=='replay-oracle-release'||row.sha256!==sha256||row.runId!==input.runId)process.exit(9);
        else process.disconnect();
      });
      ${suffix}
      process.send({kind:'replay-oracle-frozen',runId:input.runId,candidatePath,sha256});`);
    const sourceRoot = join(f.root, 'source'); mkdirSync(sourceRoot);
    const source = join(sourceRoot, 'source.ts'); writeFileSync(source, 'export function hot() {}\n');
    const compiler = join(f.root, 'compiler.cjs'); writeFileSync(compiler, 'module.exports={version:"fixture-compiler"};');
    const library = join(f.root, 'fixture-native'); writeFileSync(library, 'fixture native');
    const files = { [source]: replayHash(readFileSync(source)) };
    const sites = [{ path: 'source.ts', line1: 1 }];
    const corpus = { cursor: { file: source, line1: 1, character: 17 },
      oracle: { sites, sourceFingerprint: replaySourceFingerprint(files), oracleFingerprint: replayOracleFingerprint({ sites }) } };
    const config: DaemonReplayConfig = { schemaVersion: 'lsp-daemon-replay-config-v1', runId: 'parent-producer',
      rootPath: sourceRoot, socketPath: join(f.root, 'socket'), workspaceId: 'fixture', levels: [1], requestTimeoutMs: 1000,
      oracleProvenance: { method: 'source-authored fixture', evidenceRef: 'authored-before-launch', compilerVersion: 'fixture-compiler' },
      files, corpus: { definition: corpus, 'hot-references': corpus } };
    const configPath = join(sourceRoot, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
    const inputPath = join(f.root, 'input.json'); writeFileSync(inputPath, JSON.stringify({ ...config, configPath,
      definition: corpus.cursor, references: corpus.cursor, evidenceRef: config.oracleProvenance.evidenceRef }));
    const outputPath = join(f.root, 'qualified.json');
    const options = { freezerEntry: f.entry, compilerEntries: [compiler], runtimePaths: [library],
      witnessDirectory: join(f.root, 'receipts'), timeoutMs: 10_000 };
    // Only native mapping is simulated. The producer launches and qualifies a
    // real child using actual argv, PID epoch, executable and compile/read bytes.
    const processReader = { identity: readProcessIdentity, link: readlinkSync,
      bytes: (path: string) => path.includes('/map_files/') ? readFileSync(library) : readFileSync(path),
      text: (path: string) => path.endsWith('/maps') ? `1-2 r-xp 0 00:01 9 ${library}\n` : readFileSync(path, 'utf8') };
    return { ...f, source, inputPath, outputPath, options, deps: { processReader, nativeDependencies: () => [] } };
  }
  it('predeclares source/compiler/freezer closure, qualifies the live child, then publishes after successful exit', async () => {
    const f = producer();
    const qualified = await freezeQualifiedReplayConfig(f.inputPath, f.outputPath, f.options, f.deps);
    expect(() => assertReplayOracleRuntimeQualified(qualified)).not.toThrow();
    expect(JSON.parse(readFileSync(f.outputPath, 'utf8'))).toEqual(qualified);
    const declaration = JSON.parse(readFileSync(join(f.options.witnessDirectory, 'declaration.json'), 'utf8'));
    expect(declaration.witness.files[f.source]).toBe(qualified.files[f.source]);
    expect(JSON.parse(readFileSync(join(f.options.witnessDirectory, 'terminal.json'), 'utf8'))).toMatchObject({ code: 0, signal: null });
    expect(readProcessIdentity(qualified.oracleProvenance.runtime!.process.pid)).toBeNull();
    await expect(freezeQualifiedReplayConfig(f.inputPath, f.outputPath, f.options, f.deps)).rejects.toThrow('replay-oracle-output-exists');
  });
  it('carries the configured heap into the actual child while dropping ambient preloads', async () => {
    const f = producer(`fs.writeFileSync(require('node:path').join(require('node:path').dirname(candidatePath),'heap.json'),
      JSON.stringify({limit:require('node:v8').getHeapStatistics().heap_size_limit,
        nodeOptions:process.env.NODE_OPTIONS,execArgv:process.execArgv}));`);
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=256 --import=/must-not-load.mjs --require=/must-not-load.cjs');
    const qualified = await freezeQualifiedReplayConfig(f.inputPath, f.outputPath, f.options, f.deps);
    expect(() => assertReplayOracleRuntimeQualified(qualified)).not.toThrow();
    const heap = JSON.parse(readFileSync(join(f.options.witnessDirectory, 'heap.json'), 'utf8'));
    const expected = Number(execFileSync(process.execPath, ['--max-old-space-size=256', '-p',
      'require("node:v8").getHeapStatistics().heap_size_limit'], { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' }));
    expect(heap.limit).toBe(expected);
    expect(heap.nodeOptions).toBe('');
    expect(heap.execArgv.slice(0, -2)).toEqual(['--max-old-space-size=256']);
  });
  it('hashes unused native providers but traverses dependencies of explicit runtime roots', async () => {
    const f = producer();
    const unused = join(dirname(f.source), 'unused-gpu-provider.so');
    writeFileSync(unused, 'provider whose optional host library is unavailable');
    const nativeDependencies = (file: string) => {
      if (file === unused) throw new Error('unavailable-provider-library');
      return [];
    };
    const qualified = await freezeQualifiedReplayConfig(f.inputPath, f.outputPath, f.options,
      { ...f.deps, nativeDependencies });
    expect(qualified.oracleProvenance.runtime!.declaration.witness.files[unused]).toBe(replayHash(readFileSync(unused)));
    expect(() => assertReplayOracleRuntimeQualified(qualified)).not.toThrow();
    await expect(freezeQualifiedReplayConfig(f.inputPath, join(f.root, 'explicit.json'), {
      ...f.options, runtimePaths: [...f.options.runtimePaths, unused], witnessDirectory: join(f.root, 'explicit-receipts'),
    }, { ...f.deps, nativeDependencies })).rejects.toThrow('unavailable-provider-library');
    expect(JSON.parse(readFileSync(join(f.root, 'explicit-receipts', 'terminal.json'), 'utf8')))
      .toMatchObject({ pid: null, phase: 'declaring-runtime', error: expect.stringContaining('unavailable-provider-library') });
  });
  it('retains complete stderr and signal termination when the child fails before a candidate', async () => {
    const f = producer();
    writeFileSync(f.entry, `process.stderr.write('original compiler failure\\n'+'x'.repeat(10000),
      ()=>process.kill(process.pid,'SIGTERM'));`);
    await expect(freezeQualifiedReplayConfig(f.inputPath, f.outputPath, f.options, f.deps))
      .rejects.toThrow('replay-oracle-child-exited:null:SIGTERM');
    const terminal = JSON.parse(readFileSync(join(f.options.witnessDirectory, 'terminal.json'), 'utf8'));
    expect(terminal).toMatchObject({ signal: 'SIGTERM', phase: 'waiting-for-candidate' });
    expect(terminal.stderr).not.toContain('original compiler failure');
    expect(readFileSync(join(f.options.witnessDirectory, 'stderr.log'), 'utf8'))
      .toBe('original compiler failure\n'+'x'.repeat(10000));
    expect(readProcessIdentity(terminal.pid)).toBeNull();
    expect(existsSync(f.outputPath)).toBe(false);
    expect(existsSync(join(f.options.witnessDirectory, 'candidate.json'))).toBe(false);
  });
  it.each([
    ['compiler drift after load', "fs.writeFileSync(require.resolve('./compiler.cjs'),'changed');", 'changed-file'],
    ['source drift', 'fs.writeFileSync(Object.keys(config.files)[0],"changed");', 'changed-file'],
    ['handoff hash mismatch', 'fs.appendFileSync(candidatePath," ");', 'replay-oracle-candidate-hash-mismatch'],
    ['foreign run handoff', 'input.runId="foreign";', 'replay-oracle-invalid-child-handoff'],
    ['service witness mismatch', `config.runtimeWitness={directory:"/foreign",runId:input.runId,bootstraps:{},files:{}};
      const altered=JSON.stringify(config);fs.writeFileSync(candidatePath,altered);
      const send=process.send.bind(process);process.send=row=>send({...row,
        sha256:require('node:crypto').createHash('sha256').update(altered).digest('hex')});`, 'replay-oracle-candidate-input-mismatch'],
    ['authored config mismatch', `config.workspaceId="foreign";
      const altered=JSON.stringify(config);fs.writeFileSync(candidatePath,altered);
      const send=process.send.bind(process);process.send=row=>send({...row,
        sha256:require('node:crypto').createHash('sha256').update(altered).digest('hex')});`, 'replay-oracle-candidate-input-mismatch'],
    ['early child exit', 'process.exit(7);', 'replay-oracle-child-exited'],
    ['failed terminal', "process.removeAllListeners('message');process.on('message',()=>process.exit(8));", 'replay-oracle-child-terminal'],
  ])('does not publish on %s', async (_name, suffix, error) => {
    const f = producer(suffix);
    await expect(freezeQualifiedReplayConfig(f.inputPath, f.outputPath, f.options, f.deps)).rejects.toThrow(error);
    expect(existsSync(f.outputPath)).toBe(false);
    const boot = receipts(f.options.witnessDirectory).find(row => row.kind === 'bootstrap');
    expect(boot).toBeDefined();
    expect(readProcessIdentity(boot.pid)).toBeNull();
    const terminal = JSON.parse(readFileSync(join(f.options.witnessDirectory, 'terminal.json'), 'utf8'));
    expect(terminal.error).toContain(error);
    expect(terminal.pid).toBe(boot.pid);
    expect(readFileSync(join(f.options.witnessDirectory, 'phases.jsonl'), 'utf8')).toContain('waiting-for-candidate');
  });
  it('refuses a missing compiler load without expanding the predeclared witness', async () => {
    const f = producer();
    const unused = join(f.root, 'unused.cjs'); writeFileSync(unused, 'module.exports=1;');
    await expect(freezeQualifiedReplayConfig(f.inputPath, f.outputPath, { ...f.options, compilerEntries: [unused] }, f.deps))
      .rejects.toThrow(`unloaded-oracle-code:${unused}`);
    expect(existsSync(f.outputPath)).toBe(false);
  });
  it('reaps a child that never offers a candidate and retains exclusive attempt/output identities', async () => {
    const f = producer('process.send=()=>{};');
    await expect(freezeQualifiedReplayConfig(f.inputPath, f.outputPath, { ...f.options, timeoutMs: 1000 }, f.deps))
      .rejects.toThrow('replay-oracle-producer-timeout');
    expect(existsSync(f.outputPath)).toBe(false);
    const boot = receipts(f.options.witnessDirectory).find(row => row.kind === 'bootstrap');
    expect(readProcessIdentity(boot.pid)).toBeNull();
    expect(JSON.parse(readFileSync(join(f.options.witnessDirectory, 'terminal.json'), 'utf8')))
      .toMatchObject({ phase: 'waiting-for-candidate', signal: 'SIGKILL', error: expect.stringContaining('replay-oracle-producer-timeout') });
    await expect(freezeQualifiedReplayConfig(f.inputPath, f.outputPath, f.options, f.deps)).rejects.toThrow('EEXIST');
    await expect(freezeQualifiedReplayConfig(f.inputPath, f.source, { ...f.options, witnessDirectory: join(f.root, 'new') }, f.deps))
      .rejects.toThrow('replay-oracle-output-inside-source');
  });
});
describe('actual replay load-byte witness', () => {
  it('qualifies predeclared executable compiler/freezer bytes and rejects metadata-only, replaced and unbound oracle proof', async () => {
    const f = fixture('cjs', 'require("./compiler.cjs");console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);');
    const compiler = join(f.root, 'compiler.cjs'); writeFileSync(compiler, 'module.exports = {version:"fixture-compiler"};');
    const metadata = join(f.root, 'package.json'); writeFileSync(metadata, '{"version":"fixture-compiler"}');
    const library = join(f.root, 'fixture-native'); writeFileSync(library, 'fixture native');
    const source = join(f.root, 'source.ts'); writeFileSync(source, 'export function hot() {}\n');
    // Every expected byte is authored before the real child starts. Only the
    // native mapping is a fixture; kernel PID/epoch/argv and JS loads are real.
    const witness: ReplayRuntimeWitness = { directory: f.root, runId: 'witness-test',
      bootstraps: { [f.entry]: f.launch.evalSha256 }, files: Object.fromEntries(
        [f.entry, compiler, metadata, library, process.execPath].map(file => [file, replayHash(readFileSync(file))])) };
    const files = { [source]: replayHash(readFileSync(source)) };
    const sites = [{ path: 'source.ts', line1: 1 }];
    const corpus = { cursor: { file: source, line1: 1, character: 17 },
      oracle: { sites, sourceFingerprint: replaySourceFingerprint(files), oracleFingerprint: replayOracleFingerprint({ sites }) } };
    const config: DaemonReplayConfig = { schemaVersion: 'lsp-daemon-replay-config-v1', runId: witness.runId,
      rootPath: f.root, socketPath: join(f.root, 'socket'), workspaceId: 'fixture', levels: [1], requestTimeoutMs: 1000,
      oracleProvenance: { method: 'source-authored fixture', evidenceRef: 'authored-before-launch', compilerVersion: 'fixture-compiler' },
      files, corpus: { definition: corpus, 'hot-references': corpus } };
    await withLiveRuntime(f, ([pid]) => {
      const reader = { identity: readProcessIdentity, link: readlinkSync,
        bytes: (path: string) => path.includes('/map_files/') ? readFileSync(library) : readFileSync(path),
        text: (path: string) => path.endsWith('/maps') ? `1-2 r-xp 0 00:01 9 ${library}\n` : readFileSync(path, 'utf8') };
      const declaration = { witness, compilerEntries: [compiler], freezerEntry: f.entry };
      const qualified = qualifyReplayOracleRuntime(config, declaration, pid, reader);
      expect(qualified.oracleProvenance.runtime!.process.identity).toBe(readProcessIdentity(pid));
      expect(qualified.oracleProvenance.runtime!.process.loadedModules).not.toBe('unmeasured');
      expect(() => assertReplayOracleRuntimeQualified(qualified)).not.toThrow();
      expect(() => qualifyReplayOracleRuntime(config, { ...declaration, compilerEntries: [metadata] }, pid, reader))
        .toThrow(`unloaded-oracle-code:${metadata}`);
      expect(() => qualifyReplayOracleRuntime(config, { ...declaration, compilerEntries: [] }, pid, reader))
        .toThrow('invalid-replay-oracle-runtime-declaration');
      expect(() => assertReplayOracleRuntimeQualified({ ...qualified, requestTimeoutMs: 1001 }))
        .toThrow('replay-oracle-runtime-proof-mismatch');
      expect(() => assertReplayOracleRuntimeQualified({ ...qualified, oracleProvenance: {
        ...qualified.oracleProvenance, compilerVersion: 'other-compiler' } })).toThrow('replay-oracle-runtime-proof-mismatch');
      const replaced = { ...reader, identity: () => 'replaced-kernel-process' };
      expect(() => qualifyReplayOracleRuntime(config, declaration, pid, replaced)).toThrow('unwitnessed-runtime-bootstrap');
      writeFileSync(compiler, 'module.exports = {version:"replaced"};');
      expect(() => assertReplayOracleRuntimeQualified(qualified)).toThrow(`replay-oracle-runtime-drift:changed-file:${compiler}`);
      // A later disk hash cannot repair the already-loaded compiler identity.
      const retrospective = { ...declaration, witness: { ...witness,
        files: { ...witness.files, [compiler]: replayHash(readFileSync(compiler)) } } };
      expect(() => qualifyReplayOracleRuntime(config, retrospective, pid, reader)).toThrow(`unfrozen-loaded-bytes:${compiler}`);
    });
  });
  it('records the executed ESM bytes, config reads and argv-anchored bootstrap in a real Node process', () => {
    const f = fixture('mjs', 'import {readFileSync} from "node:fs"; console.log(readFileSync(new URL("./config.json",import.meta.url),"utf8"));');
    const config = join(f.root, 'config.json'); writeFileSync(config, '{"value":7}');
    expect(execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' })).toContain('"value":7');
    const rows = receipts(f.root);
    expect(rows[0]).toMatchObject({ kind: 'bootstrap', evalSha256: f.launch.evalSha256 });
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'esm-load-return', path: f.entry, sha256: replayHash(readFileSync(f.entry)) }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'file-read', path: config, sha256: replayHash(readFileSync(config)) }));
    expect(rows.filter(row => row.kind === 'unknown')).toEqual([]);
  });
  it('records the actual CommonJS compile source and JSON consumer bytes', () => {
    const f = fixture('cjs', 'console.log(require("./config.json").value);');
    const config = join(f.root, 'config.json'); writeFileSync(config, '{"value":9}');
    expect(execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' })).toContain('9');
    const rows = receipts(f.root);
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'commonjs-compile', path: f.entry, sha256: replayHash(readFileSync(f.entry)) }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'json-load', path: config, sha256: replayHash(readFileSync(config)) }));
  });
  it('qualifies real default-loader deferred CommonJS only after its actual compile', async () => {
    const f = fixture('cjs', 'require("./worker.js");console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);');
    const worker = join(f.root, 'worker.js'); writeFileSync(worker, 'module.exports = 42;');
    await withLiveRuntime(f, pids => {
      const { witness, reader } = liveWitness(f, [f.entry, worker]);
      const rows = receipts(f.root);
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'commonjs-load-pending', path: worker }));
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'commonjs-compile', path: worker, sha256: witness.files[worker] }));
      expect(rows.filter(row => row.kind === 'unknown')).toEqual([]);
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown).toEqual([]);
    });
  });
  it('records and validates exact kernel metadata reads without freezing volatile proc files', async () => {
    const f = fixture('mjs', `import {readFileSync,readFile} from 'node:fs';import {readFile as readPromise} from 'node:fs/promises';
      readFileSync('/proc/sys/kernel/random/boot_id','utf8');
      await readPromise('/proc/self/cgroup','utf8');
      await new Promise((resolve,reject)=>readFile('/proc/'+process.pid+'/stat','utf8',error=>error?reject(error):resolve()));
      readFileSync('/proc/version','utf8');console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const pid = pids[0];
      const { witness, reader } = liveWitness(f, [f.entry]);
      const command = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
      const qualify = (r = reader) => replayLoadedRuntime(pid, reader.identity(pid), command, witness, r).unknown;
      expect(receipts(f.root).filter(row => row.kind === 'kernel-metadata')).toHaveLength(3);
      expect(qualify()).toEqual(['unfrozen-loaded-bytes:/proc/version']);
      const changed = { ...reader, text: (path: string) => path.endsWith('/cgroup') ? '0::/different\n' : reader.text(path) };
      expect(qualify(changed).some(reason => reason.startsWith('unqualified-kernel-metadata:/proc/self/cgroup:'))).toBe(true);
      const receiptPath = join(f.root, `${pid}.jsonl`);
      const rows = receipts(f.root);
      const stat = rows.find(row => row.kind === 'kernel-metadata' && row.path.endsWith('/stat'));
      stat.subjectIdentity = 'different-process-epoch';
      writeFileSync(receiptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.startsWith(`unqualified-kernel-metadata:/proc/${pid}/stat:`))).toBe(true);
    });
  });
  it('qualifies main-task children reads and refuses changed bytes, process epochs and task paths', async () => {
    const f = fixture('mjs', `import {readFileSync} from 'node:fs';import {readFile} from 'node:fs/promises';
      readFileSync('/proc/'+process.pid+'/task/'+process.pid+'/children');
      await readFile('/proc/self/task/'+process.pid+'/children','utf8');
      console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const pid = pids[0];
      const { witness, reader } = liveWitness(f, [f.entry]);
      const command = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
      const qualify = (r = reader) => replayLoadedRuntime(pid, reader.identity(pid), command, witness, r).unknown;
      const rows = receipts(f.root);
      const metadata = rows.filter(row => row.kind === 'kernel-metadata');
      expect(metadata).toHaveLength(2);
      for (const row of metadata) {
        expect(row).toMatchObject({ subjectPid: pid, subjectIdentity: reader.identity(pid),
          text: reader.text(`/proc/${pid}/task/${pid}/children`) });
        expect(row.sha256).toBe(replayHash(row.text));
      }
      expect(qualify()).toEqual([]);
      const changed = { ...reader, text: (path: string) => path.endsWith('/children') ? `${pid} ` : reader.text(path) };
      expect(qualify(changed).some(reason => reason.includes('kernel control input changed'))).toBe(true);
      const receiptPath = join(f.root, `${pid}.jsonl`);
      const rewrite = (mutate: (row: Record<string, unknown>) => void) => {
        const copy = JSON.parse(JSON.stringify(rows));
        mutate(copy.find((row: Record<string, unknown>) => row.kind === 'kernel-metadata'));
        writeFileSync(receiptPath, copy.map((row: Record<string, unknown>) => JSON.stringify(row)).join('\n') + '\n');
      };
      for (const mutate of [
        (row: Record<string, unknown>) => { row.sha256 = replayHash('altered bytes'); },
        (row: Record<string, unknown>) => { row.subjectIdentity = 'different-process-epoch'; },
        (row: Record<string, unknown>) => { row.path = `/proc/${pid}/task/${pid + 1}/children`; },
        (row: Record<string, unknown>) => { row.path = `/proc/${pid}/task/${pid}/status`; },
      ]) {
        rewrite(mutate);
        expect(qualify().some(reason => reason.startsWith('unqualified-kernel-metadata:'))).toBe(true);
      }
      rewrite(row => { row.text = `${pid} `; row.sha256 = replayHash(String(row.text)); });
      expect(qualify().some(reason => reason.includes('kernel control input changed'))).toBe(true);
    });
  });
  it('refuses altered metadata bytes and stat identity even when a receipt hash is recomputed', async () => {
    const f = fixture('mjs', `import {readFileSync} from 'node:fs';readFileSync('/proc/'+process.pid+'/stat','utf8');
      console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const pid = pids[0];
      const { witness, reader } = liveWitness(f, [f.entry]);
      const command = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
      const qualify = () => replayLoadedRuntime(pid, reader.identity(pid), command, witness, reader).unknown;
      expect(qualify()).toEqual([]);
      const rows = receipts(f.root);
      const stat = rows.find(row => row.kind === 'kernel-metadata');
      const path = join(f.root, `${pid}.jsonl`);
      stat.sha256 = replayHash('altered bytes');
      writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.startsWith('unqualified-kernel-metadata:'))).toBe(true);
      const fields = stat.text.slice(stat.text.lastIndexOf(')') + 2).split(' '); fields[19] = '0';
      stat.text = stat.text.slice(0, stat.text.lastIndexOf(')') + 2) + fields.join(' '); stat.sha256 = replayHash(stat.text);
      writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.includes('stat epoch or parent mismatch'))).toBe(true);
    });
  });
  it('qualifies a declared symlink launcher through its recorded canonical loaded entry', async () => {
    const f = fixture();
    const entry = join(f.root, 'launcher.mjs'); symlinkSync('entry.mjs', entry);
    writeFileSync(f.entry, 'console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);');
    const linked = { ...f, entry, launch: replayRuntimeLaunch(entry, f.root, 'witness-test') };
    await withLiveRuntime(linked, pids => {
      const { witness, reader } = liveWitness(linked, [entry, f.entry]);
      expect(receipts(f.root)[0]).toMatchObject({ entry, entryCanonical: f.entry });
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown).toEqual([]);
      const incomplete = { ...witness, files: { [entry]: witness.files[entry], '/test-native-mapping': witness.files['/test-native-mapping'] } };
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, incomplete, reader).unknown).toContain('unfrozen-runtime-entry-alias');
    });
  });
  it('refuses preloads and later loader registration instead of claiming final executed bytes', () => {
    const f = fixture('mjs', 'import {registerHooks} from "node:module"; registerHooks({});');
    expect(() => execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '--no-warnings' }, stdio: 'pipe' })).toThrow();
    expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: 'unsupported-loader-or-preload' }));
    const second = fixture('mjs', 'import {registerHooks} from "node:module"; registerHooks({});');
    expect(() => execFileSync(process.execPath, second.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' })).toThrow();
    expect(receipts(second.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: 'later-loader-registration' }));
  });
  it('retains an explicit unknown when a consumer bypasses complete file reads', () => {
    const f = fixture('cjs', 'const fs=require("node:fs"); const fd=fs.openSync(__filename,"r"); fs.readSync(fd,Buffer.alloc(4),0,4,0); fs.closeSync(fd);');
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: 'incomplete-file-reader:readSync' }));
  });
  it('restores the reader guard after a default ESM load and a failed complete read', () => {
    const f = fixture('mjs', 'import fs from "node:fs"; try { fs.readFileSync("/missing-witness-fixture"); } catch {} const fd=fs.openSync(new URL(import.meta.url),"r"); fs.readSync(fd,Buffer.alloc(4),0,4,0); fs.closeSync(fd);');
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    expect(receipts(f.root).filter(row => row.kind === 'unknown')).toEqual([
      expect.objectContaining({ reason: 'incomplete-file-reader:readSync' }),
    ]);
  });
  it.each(['implicit', 'explicit', 'options', 'esm'] as const)('qualifies complete streamed bytes without changing consumer buffers (%s)', async route => {
    const f = fixture(route === 'esm' ? 'mjs' : 'cjs');
    const input = join(f.root, 'input.bin');
    const bytes = Buffer.from(Array.from({ length: 130_019 }, (_, i) => i % 251));
    writeFileSync(input, bytes);
    const read = route === 'explicit' ? 'fs.readSync(fd,view,1,4093,total)' : route === 'options' ?
      'fs.readSync(fd,view,{offset:1,length:4093,position:null})' : 'fs.readSync(fd,view,1,4093,null)';
    writeFileSync(f.entry, `${route === 'esm' ? 'import * as fs from "node:fs";' : 'const fs=require("node:fs");'}
      const fd=fs.openSync(${JSON.stringify(input)},'r');const view=new Uint8Array(4095);let total=0;let n;
      while((n=${read})>0){for(let i=0;i<n;i++)if(view[i+1]!==((total+i)%251))throw Error('consumer bytes changed');total+=n;}
      if(total!==130019)throw Error('consumer length changed');fs.closeSync(fd);
      console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const rows = receipts(f.root);
      expect(rows.filter(row => row.kind === 'unknown')).toEqual([]);
      const completed = rows.find(row => row.kind === 'file-read' && row.reader === 'readSync');
      expect(completed).toMatchObject({ path: input, sha256: replayHash(bytes), byteLength: bytes.length });
      const { witness, reader } = liveWitness(f, [f.entry, input]);
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      const qualify = () => replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown;
      expect(qualify()).toEqual([]);
      const receiptPath = join(f.root, `${pids[0]}.jsonl`);
      // Removing the close proof, duplicating it or moving it before the open
      // must not convert a partial live read into a qualified frozen input.
      for (const altered of [rows.filter(row => row !== completed), [...rows, completed],
        [rows[0], completed, ...rows.slice(1).filter(row => row !== completed)]]) {
        writeFileSync(receiptPath, altered.map(row => JSON.stringify(row)).join('\n') + '\n');
        expect(qualify()).toContain(`unclosed-or-unqualified-file-reader:readSync:${input}`);
      }
    });
  });
  it.each([
    ['partial', 'fs.readSync(fd,b,0,4,null);fs.closeSync(fd);', 'incomplete-file-reader'],
    ['no EOF', 'fs.readSync(fd,b,0,8,null);fs.closeSync(fd);', 'incomplete-file-reader'],
    ['skipped prefix', 'fs.readSync(fd,b,0,4,4);fs.closeSync(fd);', 'nonsequential-file-reader'],
    ['repeated prefix', 'fs.readSync(fd,b,0,4,0);fs.readSync(fd,b,0,4,0);fs.closeSync(fd);', 'nonsequential-file-reader'],
    ['explicit then implicit', 'fs.readSync(fd,b,0,4,0);fs.readSync(fd,b,0,4,null);fs.closeSync(fd);', 'nonsequential-file-reader'],
    ['zero length', 'fs.readSync(fd,b,0,0,null);fs.closeSync(fd);', 'unsupported-file-reader'],
    ['changed inode', 'while(fs.readSync(fd,b,0,8,null)>0){}fs.unlinkSync(input);fs.writeFileSync(input,"abcdefgh");fs.closeSync(fd);', 'changed-file-reader'],
    ['changed contents', 'while(fs.readSync(fd,b,0,8,null)>0){}fs.writeFileSync(input,"12345678");fs.closeSync(fd);', 'changed-file-reader'],
    ['failed read', 'try{fs.readSync(fd,b,99,8,null);}catch{}fs.closeSync(fd);', 'unsupported-file-reader'],
  ])('refuses incomplete or unstable descriptor bytes (%s)', (_name, action, reason) => {
    const f = fixture('cjs');
    const input = join(f.root, 'input.bin'); writeFileSync(input, 'abcdefgh');
    writeFileSync(f.entry, `const fs=require('node:fs');const input=${JSON.stringify(input)};
      const fd=fs.openSync(input,'r');const b=Buffer.alloc(8);${action}`);
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    const rows = receipts(f.root);
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: `${reason}:readSync` }));
    expect(rows.filter(row => row.kind === 'file-read' && row.reader === 'readSync')).toEqual([]);
  });
  it('keeps a fully consumed but unclosed live descriptor unqualified', async () => {
    const f = fixture('cjs', `const fs=require('node:fs');const fd=fs.openSync(__filename,'r');const b=Buffer.alloc(1024);
      while(fs.readSync(fd,b,0,b.length,null)>0){}console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const { witness, reader } = liveWitness(f, [f.entry]);
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown)
        .toContain(`unclosed-or-unqualified-file-reader:readSync:${f.entry}`);
    });
  });
  it('handles empty files and reused descriptors without mixing their consumed-byte hashes', () => {
    const f = fixture('cjs');
    const empty = join(f.root, 'empty'); const populated = join(f.root, 'populated');
    writeFileSync(empty, ''); writeFileSync(populated, 'abcdefgh');
    writeFileSync(f.entry, `const fs=require('node:fs');for(const input of ${JSON.stringify([empty, populated])}){
      const fd=fs.openSync(input,'r');const b=Buffer.alloc(3);while(fs.readSync(fd,b)>0){}fs.closeSync(fd);}`);
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    const rows = receipts(f.root);
    expect(rows.filter(row => row.kind === 'unknown')).toEqual([]);
    const reads = rows.filter(row => row.kind === 'file-read' && row.reader === 'readSync');
    expect(reads).toEqual([
      expect.objectContaining({ path: empty, sha256: replayHash(''), byteLength: 0 }),
      expect.objectContaining({ path: populated, sha256: replayHash('abcdefgh'), byteLength: 8 }),
    ]);
    expect(new Set(reads.map(row => row.readId)).size).toBe(2);
  });
  it('propagates through real forks and shebang grandchildren, preserving IPC, argv and memory flags', async () => {
    const f = fixture();
    const worker = join(f.root, 'worker.cjs');
    const leaf = join(f.root, 'leaf.cjs');
    writeFileSync(leaf, '#!/usr/bin/env node\nconsole.log(JSON.stringify({pid:process.pid,arg:process.argv[2]}));setInterval(()=>{},1000);', { mode: 0o700 });
    writeFileSync(worker, `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(leaf)},['leaf-argument'],{stdio:['ignore','pipe','pipe']});c.stdout.on('data',chunk=>process.send({leaf:JSON.parse(String(chunk)),worker:process.pid,argv:process.argv,execArgv:process.execArgv}));`);
    writeFileSync(f.entry, `import {fork} from 'node:child_process';const c=fork(${JSON.stringify(worker)},['worker-argument'],{silent:true,execArgv:['--max-old-space-size=128'],stdio:['pipe','pipe','pipe','ipc']});c.on('message',m=>{if(m.leaf.arg!=='leaf-argument'||m.argv[2]!=='worker-argument'||m.execArgv[0]!=='--max-old-space-size=128')throw Error('lost fork semantics');console.log(JSON.stringify({pids:[m.worker,m.leaf.pid]}));});`);
    await withLiveRuntime(f, pids => {
      const { witness, reader } = liveWitness(f, [f.entry, worker, leaf]);
      expect(pids).toHaveLength(3);
      for (const pid of pids) {
        const cmdline = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
        expect(replayLoadedRuntime(pid, reader.identity(pid), cmdline, witness, reader).unknown).toEqual([]);
      }
      const workerRows = receipts(f.root).filter(row => row.pid === pids[1]);
      expect(workerRows[0]).toMatchObject({ parent: { pid: pids[0] }, ppid: pids[0] });
      expect(workerRows).toContainEqual(expect.objectContaining({ kind: 'child-launch', entry: leaf }));
      // Even adding a child hash to the trusted-root map cannot bypass a
      // missing parent launch or a wrong parent process epoch.
      const receiptPath = join(f.root, `${pids[0]}.jsonl`);
      const original = readFileSync(receiptPath, 'utf8');
      writeFileSync(receiptPath, original.split('\n').filter(line => !line || JSON.parse(line).kind !== 'child-launch').join('\n'));
      const childCommand = reader.text(`/proc/${pids[1]}/cmdline`).split('\0').filter(Boolean);
      const expanded = { ...witness, bootstraps: { ...witness.bootstraps, [worker]: workerRows[0].evalSha256 } };
      expect(replayLoadedRuntime(pids[1], reader.identity(pids[1]), childCommand, expanded, reader).unknown)
        .toContain('unwitnessed-runtime-bootstrap');
      writeFileSync(receiptPath, original);
      const wrongEpoch = { ...reader, identity: (pid: number) => pid === pids[0] ? 'another epoch' : reader.identity(pid) };
      expect(replayLoadedRuntime(pids[1], reader.identity(pids[1]), childCommand, witness, wrongEpoch).unknown)
        .toContain('unwitnessed-runtime-bootstrap');
    });
  }, 20_000);
  it.each(['spawn', 'fork', 'execFile'] as const)('records anchored %s child exit codes and signals without requiring a live child', async route => {
    for (const termination of ['code', 'signal'] as const) {
      const f = fixture();
      const worker = join(f.root, 'terminal-worker.cjs');
      writeFileSync(worker, termination === 'code' ? 'process.exit(7);' : 'console.log("ready");setInterval(()=>{},1000);');
      const args = route === 'fork' ? JSON.stringify(worker) : `process.execPath,[${JSON.stringify(worker)}]`;
      const options = route === 'fork' ? '{silent:true}' : '{stdio:["ignore","pipe","pipe"]}';
      writeFileSync(f.entry, `import {${route}} from 'node:child_process';
        const c=${route}(${args},${options});
        ${termination === 'signal' ? 'c.stdout.once("data",()=>c.kill("SIGTERM"));' : ''}
        c.once('exit',()=>{console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);});`);
      await withLiveRuntime(f, pids => {
        const rows = receipts(f.root).filter(row => row.pid === pids[0]);
        const started = rows.find(row => row.kind === 'child-started');
        const terminal = rows.filter(row => row.kind === 'child-exit');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({ launchId: started.launchId, childPid: started.childPid,
          childIdentity: started.childIdentity, code: termination === 'code' ? 7 : null,
          signal: termination === 'signal' ? 'SIGTERM' : null });
        expect(terminal[0].atMs).toBeGreaterThan(0);
        const { witness, reader } = liveWitness(f, [f.entry, worker]);
        const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
        const qualify = () => replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown;
        expect(qualify()).toEqual([]);
        const rootPath = join(f.root, `${pids[0]}.jsonl`);
        const original = readFileSync(rootPath, 'utf8');
        for (const [field, value] of [['launchId', 'another-launch'], ['childIdentity', 'reused-epoch'],
          ['atMs', null], ['code', -1], ['signal', 'invalid-signal']] as const) {
          const saved = terminal[0][field];
          terminal[0][field] = value;
          writeFileSync(rootPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
          expect(qualify()).toContain('unqualified-child-terminal');
          terminal[0][field] = saved;
        }
        writeFileSync(rootPath, [...rows, terminal[0]].map(row => JSON.stringify(row)).join('\n') + '\n');
        expect(qualify()).toContain('unqualified-child-terminal');
        writeFileSync(rootPath, original);
        expect(qualify()).toEqual([]);
      });
    }
  }, 20_000);
  it.each((['spawn', 'fork', 'execFile'] as const).flatMap(route =>
    [false, true].map(decoded => ({ route, decoded }))))('preserves bounded $route stderr diagnostics without stealing consumer bytes (decoded=$decoded)', async ({ route, decoded }) => {
    const f = fixture();
    const worker = join(f.root, 'stderr-worker.cjs');
    const bytes = Buffer.concat([Buffer.alloc(12_000, 120), Buffer.from('\nFATAL ERROR: fixture diagnostic 👋\n')]);
    writeFileSync(worker, `const bytes=Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64');
      process.stderr.write(bytes.subarray(0,bytes.length-3),()=>
        process.stderr.write(bytes.subarray(bytes.length-3),()=>process.exit(7)));`);
    const args = route === 'fork' ? JSON.stringify(worker) : `process.execPath,[${JSON.stringify(worker)}]`;
    const options = route === 'fork' ? '{silent:true}' : '{stdio:["ignore","pipe","pipe"]}';
    writeFileSync(f.entry, `import {${route}} from 'node:child_process';import {createHash} from 'node:crypto';
      const c=${route}(${args},${options});const chunks=[];
      ${route !== 'execFile' ? 'if(c.stderr.readableFlowing!==null)throw Error("recorder changed stderr flow");' : ''}
      ${decoded ? "c.stderr.setEncoding('utf8');" : ''}
      c.stderr.on('data',chunk=>chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
      c.once('close',()=>{if(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')!==${JSON.stringify(replayHash(bytes))})
        throw Error('diagnostic recorder changed consumer stderr');
        console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);});`);
    await withLiveRuntime(f, pids => {
      const rows = receipts(f.root).filter(row => row.pid === pids[0]);
      const started = rows.find(row => row.kind === 'child-started');
      const diagnostics = rows.filter(row => row.kind === 'child-stderr');
      expect(diagnostics).toHaveLength(1);
      const diagnostic = diagnostics[0];
      const tail = bytes.subarray(-8192);
      expect(diagnostic).toMatchObject({ launchId: started.launchId, childPid: started.childPid,
        childIdentity: started.childIdentity, piped: true, totalBytes: bytes.length,
        tailBase64: tail.toString('base64'), sha256: replayHash(tail) });
      expect(diagnostic.atMs).toBeGreaterThanOrEqual(rows.find(row => row.kind === 'child-exit').atMs);
      const { witness, reader } = liveWitness(f, [f.entry, worker]);
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      const qualify = () => replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown;
      expect(qualify()).toEqual([]);
      const rootPath = join(f.root, `${pids[0]}.jsonl`);
      const rewrite = () => writeFileSync(rootPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      for (const [field, value] of [['launchId', 'another-launch'], ['childPid', -1],
        ['childIdentity', 'reused-epoch'], ['atMs', null], ['atMs', 1], ['piped', false], ['piped', 'yes'],
        ['totalBytes', 1], ['totalBytes', -1], ['totalBytes', 1.5],
        ['tailBase64', '!not-base64!'], ['tailBase64', tail.toString('base64') + '\n'],
        ['sha256', replayHash('changed')]] as const) {
        const saved = diagnostic[field]; diagnostic[field] = value; rewrite();
        expect(qualify()).toContain('unqualified-child-stderr');
        diagnostic[field] = saved;
      }
      writeFileSync(rootPath, [...rows, diagnostic].map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify()).toContain('unqualified-child-stderr');
      rewrite();
      expect(qualify()).toEqual([]);
      writeFileSync(rootPath, rows.filter(row => row.kind !== 'child-exit').map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify()).toContain('unqualified-child-stderr');
      rewrite();
    });
  }, 20_000);
  it.each(['pipe', 'ignore'] as const)('qualifies empty %s stderr after child close', async stderr => {
    const f = fixture();
    const worker = join(f.root, 'empty-stderr-worker.cjs');
    writeFileSync(worker, 'process.exit(0);');
    writeFileSync(f.entry, `import {spawn} from 'node:child_process';
      const c=spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:['ignore','ignore',${JSON.stringify(stderr)}]});
      c.once('close',()=>{console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);});`);
    await withLiveRuntime(f, pids => {
      const rows = receipts(f.root).filter(row => row.pid === pids[0]);
      const diagnostics = rows.filter(row => row.kind === 'child-stderr');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ piped: stderr === 'pipe', totalBytes: 0,
        tailBase64: '', sha256: replayHash(Buffer.alloc(0)) });
      const { witness, reader } = liveWitness(f, [f.entry, worker]);
      const command = reader.text(`/proc/${pids[0]}/cmdline`).split('\0').filter(Boolean);
      expect(replayLoadedRuntime(pids[0], reader.identity(pids[0]), command, witness, reader).unknown).toEqual([]);
    });
  }, 20_000);
  it('records child launch errors while preserving handled and unhandled error behavior', () => {
    for (const handled of [true, false]) {
      const f = fixture();
      const worker = join(f.root, 'worker.cjs'); writeFileSync(worker, 'process.exit(0);');
      writeFileSync(f.entry, `import {spawn} from 'node:child_process';
        const c=spawn(process.execPath,[${JSON.stringify(worker)}],{cwd:${JSON.stringify(join(f.root, 'missing-directory'))}});
        ${handled ? 'c.once("error",()=>console.log("handled"));' : ''}`);
      const execute = () => execFileSync(process.execPath, f.launch.args,
        { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', stdio: 'pipe' });
      if (handled) expect(execute()).toContain('handled');
      else expect(execute).toThrow();
      const rows = receipts(f.root);
      const started = rows.find(row => row.kind === 'child-started');
      const terminal = rows.filter(row => row.kind === 'child-error');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ launchId: started.launchId, childPid: null, childIdentity: null });
      expect(terminal[0].error).toContain('ENOENT');
      expect(terminal[0].atMs).toBeGreaterThan(0);
    }
  });
  it('instruments the actual exact-env runner and its payload when the environment is replaced', async () => {
    const f = fixture();
    const runner = fileURLToPath(new URL('../systemd-scope-env-runner.mjs', import.meta.url));
    const environment = join(f.root, 'payload.env');
    const payload = join(f.root, 'payload.mjs');
    writeFileSync(environment, `PATH=${process.env.PATH}\0NODE_OPTIONS=\0WITNESS_EXACT=payload\0`);
    writeFileSync(payload, 'if(process.env.WITNESS_EXACT!=="payload"||process.env.WITNESS_OUTER)throw Error("env mismatch");console.log(JSON.stringify({pids:[process.ppid,process.pid]}));setInterval(()=>{},1000);');
    writeFileSync(f.entry, `import {spawn} from 'node:child_process';spawn(process.execPath,[${JSON.stringify(runner)},'--env-fd-path',${JSON.stringify(environment)},'--',process.execPath,${JSON.stringify(payload)}],{env:{...process.env,WITNESS_OUTER:'outer'},stdio:'inherit'});setInterval(()=>{},1000);`);
    await withLiveRuntime(f, pids => {
      const { witness, reader } = liveWitness(f, [f.entry, runner, environment, payload]);
      for (const pid of pids) {
        const cmdline = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
        expect(replayLoadedRuntime(pid, reader.identity(pid), cmdline, witness, reader).unknown).toEqual([]);
      }
      expect(receipts(f.root).filter(row => row.kind === 'bootstrap').map(row => row.entry).sort())
        .toEqual([f.entry, runner, payload].sort());
    });
  }, 20_000);
  it('retains unknown for an unsupported child loader rather than replacing its launch flags', () => {
    const f = fixture('mjs', 'import {spawn} from "node:child_process"; const c=spawn(process.execPath,["--import","data:text/javascript,", "--eval","console.log(1)"],{stdio:"ignore"});await new Promise(resolve=>c.on("exit",resolve));');
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: `unsupported-child-launch:${process.execPath}` }));
  });
  it('propagates on the real managed systemd scope argv, including its nested runner separator', async () => {
    const f = fixture();
    const payload = join(f.root, 'scoped-payload.mjs');
    writeFileSync(payload, 'if(process.env.WITNESS_EXACT!=="scoped")throw Error("env mismatch");console.log(JSON.stringify({pids:[process.ppid,process.pid]}));setInterval(()=>{},1000);');
    const launch = buildTaskScopeArgvWithTransport([process.execPath, payload], {
      unit: `lsp-witness-${process.pid}-${Date.now()}`, slice: 'papercusp-sidecar.slice',
      env: { PATH: process.env.PATH, NODE_OPTIONS: '', WITNESS_EXACT: 'scoped' },
    });
    try {
      writeFileSync(f.entry, `import {spawn} from 'node:child_process';spawn(${JSON.stringify(launch.argv[0])},${JSON.stringify(launch.argv.slice(1))},{stdio:'inherit'});setInterval(()=>{},1000);`);
      await withLiveRuntime(f, pids => {
        const { witness, reader } = liveWitness(f, [f.entry, SYSTEMD_ENV_RUNNER_PATH, launch.transport!.sourcePath, payload]);
        for (const pid of pids) {
          const cmdline = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
          expect(replayLoadedRuntime(pid, reader.identity(pid), cmdline, witness, reader).unknown).toEqual([]);
        }
        expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'child-launch', route: 'systemd-scope', entry: SYSTEMD_ENV_RUNNER_PATH }));
      });
    } finally { launch.transport?.release(); }
  }, 20_000);
  it('witnesses the exact managed availability probe as terminal control evidence and rejects incomplete or altered proof', async () => {
    const f = fixture('mjs', `import {spawn} from 'node:child_process';
      const c=spawn('systemd-run',${JSON.stringify(scopeProbeArgv)},{stdio:['ignore','ignore','pipe']});
      let errors='';c.stderr.on('data',chunk=>errors+=chunk);c.on('exit',code=>{if(code!==0)throw Error(errors);
      console.log(JSON.stringify({pids:[]}));setInterval(()=>{},1000);});`);
    await withLiveRuntime(f, pids => {
      const pid = pids[0];
      const { witness, reader } = liveWitness(f, [f.entry, process.execPath]);
      const command = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
      const qualify = () => replayLoadedRuntime(pid, reader.identity(pid), command, witness, reader).unknown;
      expect(qualify()).toEqual([]);
      const rows = receipts(f.root).filter(row => row.pid === pid);
      const launch = rows.find(row => row.kind === 'child-launch');
      expect(launch).toMatchObject({ controlPurpose: 'systemd-scope-availability', originalArgv: scopeProbeArgv });
      expect(receipts(f.root).filter(row => row.pid !== pid).map(row => row.kind)).toEqual(['bootstrap','control-complete']);
      const rootPath = join(f.root, `${pid}.jsonl`);
      const original = readFileSync(rootPath, 'utf8');
      for (const field of ['originalArgv', 'argv']) {
        const saved = launch[field];
        launch[field] = saved.filter((arg: string) => arg !== '--property=CollectMode=inactive-or-failed');
        writeFileSync(rootPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        expect(qualify().some(reason => reason.includes('unsupported control launch'))).toBe(true);
        launch[field] = saved;
        writeFileSync(rootPath, original);
      }
      const unfrozen = { ...witness, files: { ...witness.files } }; delete unfrozen.files[process.execPath];
      expect(replayLoadedRuntime(pid, reader.identity(pid), command, unfrozen, reader).unknown
        .some(reason => reason.startsWith('unqualified-control-probe:'))).toBe(true);
      writeFileSync(rootPath, rows.filter(row => row.kind !== 'control-exit').map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.startsWith('unqualified-control-probe:'))).toBe(true);
      writeFileSync(rootPath, original);
      const control = receipts(f.root).find(row => row.kind === 'control-complete');
      const controlPath = join(f.root, `${control.pid}.jsonl`);
      const controlRows = receipts(f.root).filter(row => row.pid === control.pid);
      const originalControl = readFileSync(controlPath, 'utf8');
      controlRows[1].ancestry[0].identity = 'reused-process-epoch';
      writeFileSync(controlPath, controlRows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.includes('unanchored control ancestry'))).toBe(true);
      writeFileSync(controlPath, originalControl);
      controlRows[1].ancestry[0].identity = controlRows[0].identity;
      controlRows[1].executableSha256 = replayHash('unfrozen executable');
      writeFileSync(controlPath, controlRows.map(row => JSON.stringify(row)).join('\n') + '\n');
      expect(qualify().some(reason => reason.includes('unwitnessed control completion'))).toBe(true);
    });
  }, 20_000);
  it.each([
    [...scopeProbeArgv, 'extra'],
    scopeProbeArgv.map(arg => arg === '--property=CollectMode=inactive-or-failed' ? '--property=CollectMode=inactive' : arg),
    scopeProbeArgv.filter(arg => arg !== '--property=CollectMode=inactive-or-failed'),
  ])('keeps altered native availability commands unqualified (%j)', (...argv) => {
    const f = fixture('mjs', `import {spawn} from 'node:child_process';
      const c=spawn('systemd-run',${JSON.stringify(argv)},{stdio:'ignore'});
      await new Promise(resolve=>c.on('exit',resolve));`);
    execFileSync(process.execPath, f.launch.args, { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' });
    expect(receipts(f.root)).toContainEqual(expect.objectContaining({ kind: 'unknown', reason: 'unsupported-child-launch:true' }));
    expect(receipts(f.root).some(row => row.controlPurpose)).toBe(false);
  });
});

describe('fail-closed runtime qualification', () => {
  function proof() {
    const f = fixture();
    const base = { schemaVersion: 'lsp-replay-runtime-receipt-v1', pid: 42, identity: 'epoch', runId: 'run' };
    const rows: Record<string, unknown>[] = [ { ...base, kind: 'bootstrap', entry: f.entry, nodeOptions: '', evalSha256: f.launch.evalSha256 },
      { ...base, kind: 'ready' }, { ...base, kind: 'esm-load-return', path: f.entry, sha256: replayHash(readFileSync(f.entry)) } ];
    const library = '/lib/native.so';
    const witness: ReplayRuntimeWitness = { directory: f.root, runId: 'run', bootstraps: { [f.entry]: f.launch.evalSha256 },
      files: { [f.entry]: replayHash(readFileSync(f.entry)), [library]: replayHash('mapped inode') } };
    const reader = { identity: () => 'epoch', link: () => '', bytes: () => Buffer.from('mapped inode'),
      text: (path: string) => path.endsWith('/maps') ? `1-2 r-xp 0 00:01 9 ${library}\n` : rows.map(row => JSON.stringify(row)).join('\n') + '\n' };
    return { f, rows, witness, reader };
  }
  it('qualifies matching executed bytes and actual mapped inode bytes', () => {
    const p = proof();
    expect(replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, p.reader).unknown).toEqual([]);
  });
  it('refuses deferred CommonJS without the matching compile bytes', () => {
    const p = proof();
    p.rows.push({ ...p.rows[2], kind: 'commonjs-load-pending' });
    const qualify = () => replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, p.reader);
    expect(qualify().unknown).toContain(`uncompleted-commonjs-load:${p.f.entry}`);
    p.rows.push({ ...p.rows[2], kind: 'commonjs-compile', sha256: replayHash('different source') });
    expect(qualify().unknown).toContain(`uncompleted-commonjs-load:${p.f.entry}`);
    p.rows[p.rows.length - 1].sha256 = p.rows[2].sha256;
    expect(qualify().unknown).toEqual([]);
  });
  it('opens canonical map_files ranges without padding or 64-bit address rounding', () => {
    for (const [printed, canonical] of [
      ['00400000-00420000', '400000-420000'],
      ['00fffffffffffff1-00fffffffffffff3', 'fffffffffffff1-fffffffffffff3'],
    ]) {
      const p = proof();
      const reads: string[] = [];
      const reader = { ...p.reader,
        text: (path: string) => path.endsWith('/maps') ? `${printed} r-xp 0 00:01 9 /lib/native.so\n` : p.reader.text(path),
        bytes: (path: string) => {
          reads.push(path);
          if (path !== `/proc/42/map_files/${canonical}`) throw new Error('mapping does not exist');
          return Buffer.from('mapped inode');
        },
      };
      expect(replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, reader).unknown).toEqual([]);
      expect(reads).toEqual([`/proc/42/map_files/${canonical}`]);
    }
  });
  it('refuses stale process receipts, unfrozen vendor bytes and a substituted recorder', () => {
    const p = proof(); p.rows[2].sha256 = replayHash('changed vendor');
    const result = replayLoadedRuntime(42, 'another epoch', [process.execPath, '--eval', 'different recorder'], p.witness, p.reader);
    expect(result.unknown).toContain('runtime-receipt-identity-mismatch');
    expect(result.unknown).toContain('unwitnessed-runtime-bootstrap');
    expect(result.unknown).toContain(`unfrozen-loaded-bytes:${p.f.entry}`);
    expect(result.unknown).toContain('process-replaced-during-runtime-witness');
  });
  it('keeps missing native access and truncated receipts unknown without disk fallbacks', () => {
    const p = proof();
    const reader = { ...p.reader, bytes: () => { throw new Error('permission denied'); },
      text: (path: string) => path.endsWith('/maps') ? p.reader.text(path) : p.reader.text(path).trim() };
    const result = replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, reader);
    expect(result.unknown).toContain('incomplete-runtime-receipt');
    expect(result.unknown.some(reason => reason.startsWith('unreadable-native-mappings'))).toBe(true);
  });
  it('refuses an empty native mapping census', () => {
    const p = proof();
    const reader = { ...p.reader, text: (path: string) => path.endsWith('/maps') ? '' : p.reader.text(path) };
    expect(replayLoadedRuntime(42, 'epoch', [process.execPath, ...p.f.launch.args], p.witness, reader).unknown)
      .toContain('empty-native-mapping-census');
  });
});
