/** Daemon execution and qualification for the existing saturation CLI, P-012. */
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SEMANTIC_COMPLETION_COMMAND, SEMANTIC_COMPLETION_TYPESCRIPT_VERSION, semanticCompletionPlugins,
  type SemanticProjectPopulation, type SemanticCompletionContext,
  type SemanticCompletionPluginDeclaration } from './lsp-semantic-completion';
import type { readLspDaemonAdmission } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { classifyReplayAnswer, evaluateReplayLadder, runReplay, scoreReplay, REPLAY_CLASSES,
  type ReplayClass, type ReplayMode, type ReplayOracle, type ReplayReport, type ReplayTriplet } from './lsp-fleet-replay';
import type { LspFacadeArgs } from './lsp-facade';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { taskIdFromScopeUnit } from '../task-manager/types';
import { createTextCollector } from '../child-output';
import { absCgroupDir, parseProcCgroup, walkCgroupTree, type CgroupFs } from '../task-manager/cgroup-read';
import { linuxPpidFromProcStat, linuxProcessIdentityFromStat, readProcessIdentity } from '../process-identity';
import { SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from '../systemd-scope';
import { verifyVerifierSourceSync, type VerifierSourceReceipt } from '../verifier-source';
import type * as Ts from 'typescript';

const replayScopeProbeArgv = ['--user', '--scope', '--quiet', ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS, '--', 'true'];

export interface ReplayCorpus {
  readonly cursor: Required<Pick<LspFacadeArgs, 'file' | 'line1' | 'character'>>;
  readonly oracle: ReplayOracle;
}
/** Authored independently from subject answers, frozen before any measurement. */
export interface DaemonReplayConfig {
  readonly schemaVersion: 'lsp-daemon-replay-config-v1';
  readonly runId: string;
  readonly rootPath: string;
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly levels: readonly number[];
  readonly requestTimeoutMs: number;
  readonly oracleProvenance: {
    readonly method: string;
    readonly evidenceRef: string;
    readonly compilerVersion?: string;
    /** Captured by the independent parent while the freezer is still alive. */
    readonly runtime?: ReplayOracleRuntimeQualification;
  };
  /** Complete declared source/config/binary population, SHA256 keyed by absolute path. */
  readonly files: Readonly<Record<string, string>>;
  readonly corpus: Readonly<Record<ReplayClass, ReplayCorpus>>;
  readonly sourceSnapshot?: ReplayOracleInput['sourceSnapshot'];
  /** Independently captured compiler graph; never authored by native projectInfo. */
  readonly semanticGraph?: ReplaySemanticGraph;
  readonly semanticCompletionPlugin?: SemanticCompletionPluginDeclaration;
  /** Predeclared runtime population and command-line-anchored recorder launches.
   * Kept separate from the independently authored source oracle. */
  readonly runtimeWitness?: ReplayRuntimeWitness;
}
export interface ReplaySemanticGraph {
  readonly schemaVersion: 'lsp-replay-semantic-graph-v1';
  readonly compilerVersion: string;
  /** Executable shim and, when present, its maintained compiler delegate. */
  readonly compilerEntries: Readonly<Record<string, string>>;
  readonly projects: readonly (SemanticProjectPopulation & {
    rootNames: string[];
    configFiles: string[];
    compilerOptions: Readonly<Record<string, unknown>>;
  })[];
  readonly fingerprint: string;
}
export interface ReplayRuntimeWitness {
  readonly directory: string;
  readonly runId: string;
  readonly bootstraps: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, string>>;
}
export interface ReplayOracleRuntimeDeclaration {
  readonly witness: ReplayRuntimeWitness;
  readonly freezerEntry: string;
  /** Include executable compiler delegates, not just package metadata/types. */
  readonly compilerEntries: readonly string[];
}
export interface ReplayOracleRuntimeQualification {
  readonly declaration: ReplayOracleRuntimeDeclaration;
  readonly process: ReturnType<typeof replayProcessIdentity>;
  readonly configFingerprint: string;
  readonly compilerVersion: string;
  readonly proofFingerprint: string;
}
function replayOracleConfigFingerprint(config: DaemonReplayConfig): string {
  const { runtime: _runtime, ...oracleProvenance } = config.oracleProvenance;
  return replayHash(JSON.stringify({ ...config, oracleProvenance }));
}
/** Reuse the live kernel/argv/load evaluator. Disk hashes alone cannot qualify
 * a compiler which was already loaded before the declared byte census. */
export function qualifyReplayOracleRuntime(config: DaemonReplayConfig, declaration: ReplayOracleRuntimeDeclaration,
  pid: number, reader: ReplayProcessReader = replayProcessReader): DaemonReplayConfig {
  const { witness, freezerEntry, compilerEntries } = declaration;
  if (witness.runId !== config.runId || !isAbsolute(freezerEntry) || !compilerEntries.length ||
      compilerEntries.some(file => !isAbsolute(file)) || !config.oracleProvenance.compilerVersion)
    throw new Error('invalid-replay-oracle-runtime-declaration');
  validateDaemonReplayConfig(config);
  const process = replayProcessIdentity(pid, reader, witness);
  const runtime = process.loadedModules;
  const problems = [...process.unknown];
  if (config.semanticGraph) for (const [file, hash] of Object.entries(assertReplaySemanticGraph(config).compilerEntries)) {
    if (!compilerEntries.includes(file) || witness.files[file] !== hash)
      problems.push(`undeclared-oracle-compiler:${file}`);
  }
  if (!process.executable || witness.files[process.executable.path] !== process.executable.sha256)
    problems.push('unfrozen-oracle-executable');
  if (runtime === 'unmeasured') problems.push('unmeasured-oracle-runtime');
  else {
    problems.push(...runtime.unknown);
    if (runtime.receipts[0]?.entry !== freezerEntry) problems.push('unmatched-oracle-freezer-entry');
    for (const file of [freezerEntry, ...compilerEntries]) {
      if (!witness.files[file] || !runtime.receipts.some(row =>
        ['esm-load-return', 'commonjs-compile'].includes(String(row.kind)) &&
        row.path === file && row.sha256 === witness.files[file])) problems.push(`unloaded-oracle-code:${file}`);
    }
  }
  problems.push(...replayFileMismatches(witness.files));
  if (problems.length) throw new Error(`replay-oracle-runtime-refused:${[...new Set(problems)].join(';')}`);
  const proof = { declaration, process, configFingerprint: replayOracleConfigFingerprint(config),
    compilerVersion: config.oracleProvenance.compilerVersion };
  return { ...config, oracleProvenance: { ...config.oracleProvenance,
    runtime: { ...proof, proofFingerprint: replayHash(JSON.stringify(proof)) } } };
}
/** Saved source-only oracles remain inspectable, but cannot start a qualified
 * repository replay. Historical missing compiler receipts stay unknown. */
export function assertReplayOracleRuntimeQualified(config: DaemonReplayConfig): void {
  const runtime = config.oracleProvenance.runtime;
  if (!runtime) throw new Error('replay-oracle-runtime-unmeasured');
  const { proofFingerprint, ...proof } = runtime;
  if (replayHash(JSON.stringify(proof)) !== proofFingerprint ||
      runtime.configFingerprint !== replayOracleConfigFingerprint(config) ||
      runtime.compilerVersion !== config.oracleProvenance.compilerVersion ||
      runtime.process.unknown.length || runtime.process.loadedModules === 'unmeasured' ||
      runtime.process.loadedModules.unknown.length)
    throw new Error('replay-oracle-runtime-proof-mismatch');
  const drift = replayFileMismatches(runtime.declaration.witness.files);
  if (drift.length) throw new Error(`replay-oracle-runtime-drift:${drift.join(';')}`);
}
/** Historical graphs remain absent, not retrospectively inferred from config.files.
 * This validates the declaration, not the subject's loaded graph or readiness. */
export function assertReplaySemanticGraph(config: DaemonReplayConfig): ReplaySemanticGraph {
  const graph = config.semanticGraph;
  if (!graph) throw new Error('replay-semantic-graph-unmeasured');
  const { fingerprint, ...declaration } = graph;
  if (graph.schemaVersion !== 'lsp-replay-semantic-graph-v1' ||
      replayHash(JSON.stringify(declaration)) !== fingerprint ||
      graph.compilerVersion !== SEMANTIC_COMPLETION_TYPESCRIPT_VERSION ||
      graph.compilerVersion !== config.oracleProvenance.compilerVersion)
    throw new Error('replay-semantic-graph-identity-mismatch');
  const entries = Object.entries(graph.compilerEntries ?? {});
  if (!entries.length || entries.some(([file, hash]) => !isAbsolute(file) || config.files[file] !== hash))
    throw new Error('replay-semantic-compiler-unfrozen');
  if (!Array.isArray(graph.projects) || graph.projects.length !== 1)
    throw new Error('replay-semantic-project-population-unsupported');
  for (const project of graph.projects) {
    const canonical = (files: string[]) => Array.isArray(files) && files.length > 0 &&
      files.every(file => typeof file === 'string' && isAbsolute(file) && !!config.files[file]) &&
      new Set(files).size === files.length;
    if (!project || typeof project.projectName !== 'string' || !isAbsolute(project.projectName) ||
        !project.compilerOptions || typeof project.compilerOptions !== 'object' ||
        !canonical(project.files) || !canonical(project.rootNames) ||
        !canonical(project.configFiles) || !project.configFiles.includes(project.projectName) ||
        !project.rootNames.includes(project.anchorFile))
      throw new Error('replay-semantic-project-population-incomplete');
    const population = new Set(project.files);
    if ([...project.rootNames, ...project.configFiles].some(file => !population.has(file)))
      throw new Error('replay-semantic-project-population-incomplete');
    if (Object.values(config.corpus).some(row => !population.has(resolve(config.rootPath, row.cursor.file))))
      throw new Error('replay-semantic-query-file-undeclared');
  }
  return graph;
}
/** Bind the independent source graph to the predeclared maintained plugin package. */
export function replaySemanticCompletionContext(config: DaemonReplayConfig): SemanticCompletionContext {
  const graph = assertReplaySemanticGraph(config);
  const plugin = config.semanticCompletionPlugin;
  if (!plugin) throw new Error('replay-semantic-plugin-unmeasured');
  semanticCompletionPlugins(plugin);
  for (const [file, hash] of Object.entries(plugin.files)) {
    if (config.files[file] !== hash || config.runtimeWitness?.files[file] !== hash)
      throw new Error(`replay-semantic-plugin-unfrozen:${file}`);
  }
  return { population: graph.projects.map(project => ({ projectName: project.projectName,
    anchorFile: project.anchorFile, files: [...project.files] })),
    plugin: { ...plugin, files: { ...plugin.files } } };
}
/** Reuse Node's load/compile boundaries with the maintained plain-Node bundle
 * route. The recorder runs from literal argv bytes, never a later self-disk read. */
export function replayRuntimeLaunch(entry: string, directory: string, runId: string, args: readonly string[] = []) {
  const recorder = readFileSync(fileURLToPath(new URL('./lsp-replay-runtime-witness.cjs', import.meta.url)), 'utf8');
  const code = `${recorder}\n;startReplayRuntime(${JSON.stringify({ entry: resolve(entry), directory: resolve(directory), runId, args,
    scopeProbeArgv: replayScopeProbeArgv })});`;
  return { args: ['--eval', code], evalSha256: replayHash(code), entry: resolve(entry) };
}
export interface ReplayOracleProducerOptions {
  readonly freezerEntry: string;
  readonly compilerEntries: readonly string[];
  /** Additional executable/package closures; the source tree is byte-frozen separately. */
  readonly runtimePaths: readonly string[];
  readonly witnessDirectory: string;
  readonly timeoutMs: number;
}
/** Child-side handoff: keep the actual compiler/freezer alive until the independent
 * parent has inspected kernel identity, argv, loaded bytes and mapped inodes. */
export async function holdReplayOracleForQualification(config: DaemonReplayConfig, candidatePath: string): Promise<void> {
  if (!process.send || !process.connected) throw new Error('replay-oracle-parent-channel-required');
  const bytes = JSON.stringify(config, null, 2);
  const sha256 = replayHash(bytes);
  writeFileSync(candidatePath, bytes, { flag: 'wx' });
  await new Promise<void>((accept, reject) => {
    const cleanup = () => { process.off('message', release); process.off('disconnect', disconnected); };
    const disconnected = () => { cleanup(); reject(new Error('replay-oracle-parent-disconnected')); };
    const release = (message: unknown) => {
      const row = message as { kind?: string; runId?: string; sha256?: string } | null;
      if (row?.kind !== 'replay-oracle-release' || row.runId !== config.runId || row.sha256 !== sha256) {
        cleanup(); reject(new Error('replay-oracle-invalid-parent-release')); return;
      }
      cleanup(); accept();
    };
    process.on('message', release);
    process.once('disconnect', disconnected);
    process.send!({ kind: 'replay-oracle-frozen', runId: config.runId, candidatePath, sha256 }, error => {
      if (error) { cleanup(); reject(error); }
    });
  });
  process.disconnect();
}
/** Parent-side producer. Nothing is published until a predeclared child closure
 * qualifies and the same child exits successfully. Failure leaves only diagnostic
 * candidate/receipts, never a qualified output or a retroactively expanded witness. */
export async function freezeQualifiedReplayConfig(inputPath: string, outputPath: string, options: ReplayOracleProducerOptions,
  deps: { processReader?: ReplayProcessReader; nativeDependencies?: (file: string) => readonly string[] } = {}): Promise<DaemonReplayConfig> {
  if (!isAbsolute(options.freezerEntry) || !options.compilerEntries.length ||
      options.compilerEntries.some(file => !isAbsolute(file)) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error('invalid-replay-oracle-producer-options');
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as ReplayOracleInput;
  const directory = resolve(options.witnessDirectory);
  if (insideReplayRoot(resolve(input.rootPath), directory) || insideReplayRoot(resolve(input.rootPath), resolve(outputPath)))
    throw new Error('replay-oracle-output-inside-source');
  if (existsSync(outputPath)) throw new Error('replay-oracle-output-exists');
  mkdirSync(directory); // Exclusive attempt directory, never merge earlier receipts.
  const candidatePath = join(directory, 'candidate.json');
  const launch = replayRuntimeLaunch(options.freezerEntry, directory, input.runId,
    ['--freeze-replay-child', resolve(inputPath), candidatePath]);
  // Hash unused optional providers without requiring their host libraries.
  // Only executable runtime roots contribute native dependencies. Loaded maps
  // must still match the complete prelaunch byte census before qualification.
  const sourceFiles = freezeReplayRuntimeFiles([input.rootPath], { nativeDependencies: () => [] });
  const files = { ...sourceFiles, ...freezeReplayRuntimeFiles([process.execPath, resolve(inputPath),
    options.freezerEntry, ...options.compilerEntries, ...options.runtimePaths], deps) };
  const witness: ReplayRuntimeWitness = { directory, runId: input.runId,
    bootstraps: { [launch.entry]: launch.evalSha256 }, files };
  const declaration = { witness, freezerEntry: launch.entry, compilerEntries: options.compilerEntries };
  writeFileSync(join(directory, 'declaration.json'), JSON.stringify(declaration, null, 2), { flag: 'wx' });
  const drift = replayFileMismatches(files);
  if (drift.length) throw new Error(`replay-oracle-prelaunch-drift:${drift.join(';')}`);
  const child = spawn(process.execPath, launch.args, { env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const stderr = createTextCollector(child.stderr, { maxChars: 8_192 });
  child.stdout!.on('data', chunk => appendFileSync(join(directory, 'stdout.log'), chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(accept =>
    child.once('close', (code, signal) => accept({ code, signal })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed: ((error: Error) => void) | undefined;
  const failure = new Promise<never>((_accept, reject) => { failed = reject;
    timer = setTimeout(() => reject(new Error('replay-oracle-producer-timeout')), options.timeoutMs); });
  child.once('error', error => failed?.(error));
  try {
    const candidate = new Promise<{ sha256: string; config: DaemonReplayConfig }>((accept, reject) => {
      child.once('exit', (code, signal) => reject(new Error(`replay-oracle-child-exited:${code}:${signal}:${stderr.peek()}`)));
      child.once('message', message => {
        try {
          const row = message as { kind?: string; runId?: string; candidatePath?: string; sha256?: string };
          if (row?.kind !== 'replay-oracle-frozen' || row.runId !== input.runId || row.candidatePath !== candidatePath ||
              !child.pid || !child.connected || child.exitCode !== null || child.signalCode !== null)
            throw new Error('replay-oracle-invalid-child-handoff');
          const bytes = readFileSync(candidatePath);
          if (replayHash(bytes) !== row.sha256) throw new Error('replay-oracle-candidate-hash-mismatch');
          const config = JSON.parse(bytes.toString('utf8')) as DaemonReplayConfig;
          if (['runId', 'rootPath', 'socketPath', 'workspaceId', 'levels', 'requestTimeoutMs', 'sourceSnapshot', 'semanticCompletionPlugin', 'runtimeWitness'].some(key =>
            JSON.stringify(config[key as keyof DaemonReplayConfig]) !== JSON.stringify(input[key as keyof ReplayOracleInput])) ||
            JSON.stringify(config.corpus.definition.cursor) !== JSON.stringify(input.definition) ||
            JSON.stringify(config.corpus['hot-references'].cursor) !== JSON.stringify(input.references) ||
            config.oracleProvenance.evidenceRef !== input.evidenceRef)
            throw new Error('replay-oracle-candidate-input-mismatch');
          if (Object.entries(config.files).some(([file, hash]) => witness.files[file] !== hash))
            throw new Error('replay-oracle-source-not-predeclared');
          accept({ sha256: row.sha256!, config });
        } catch (error) { reject(error); }
      });
    });
    const frozen = await Promise.race([candidate, failure]);
    const qualified = qualifyReplayOracleRuntime(frozen.config, declaration, child.pid!, deps.processReader);
    if (!child.connected || child.exitCode !== null || child.signalCode !== null)
      throw new Error('replay-oracle-child-ended-before-release');
    child.send({ kind: 'replay-oracle-release', runId: input.runId, sha256: frozen.sha256 });
    const terminal = await Promise.race([closed, failure]);
    const stderrText = stderr.text();
    writeFileSync(join(directory, 'terminal.json'), JSON.stringify({ ...terminal, stderr: stderrText }), { flag: 'wx' });
    if (terminal.code !== 0 || terminal.signal !== null) throw new Error(`replay-oracle-child-terminal:${terminal.code}:${terminal.signal}:${stderrText}`);
    assertReplayOracleRuntimeQualified(qualified);
    // wx also protects against an output created by a peer during qualification.
    writeFileSync(outputPath, JSON.stringify(qualified, null, 2), { flag: 'wx' });
    return qualified;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}
export const replayHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Runtime binaries can be large; hash their original bytes without a whole-file allocation. */
function replayFileHash(file: string, buffer: Buffer): string {
  const descriptor = openSync(file, 'r');
  try {
    const hash = createHash('sha256');
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}
export const replaySourceFingerprint = (files: DaemonReplayConfig['files']) => replayHash(JSON.stringify(Object.entries(files).sort()));
export const replayOracleFingerprint = (oracle: Pick<ReplayOracle, 'sites' | 'staleSites'>) => replayHash(JSON.stringify(oracle));
/** Freeze the declared dependency trees before launch, including canonical
 * symlink targets and the native libraries the selected executables require.
 * Loaded-byte verification still refuses anything outside this population. */
export function freezeReplayRuntimeFiles(paths: readonly string[], options: {
  nativeDependencies?: (file: string) => readonly string[];
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
} = {}): Record<string, string> {
  const files: Record<string, string> = {};
  const directories = new Set<string>();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let hostLibc: 'glibc' | 'musl' | null | undefined;
  const resolveHostLibc = () => {
    if (hostLibc === undefined) {
      const host = execFileSync('ldd', [process.execPath], { encoding: 'utf8', timeout: 10_000 });
      const glibc = /\blibc\.so\.6\b/.test(host);
      const musl = /\b(?:libc\.musl-|ld-musl-)/.test(host);
      hostLibc = glibc !== musl ? (glibc ? 'glibc' : 'musl') : null;
    }
    return hostLibc;
  };
  const dependencies = options.nativeDependencies ?? ((file: string) => {
    if (!/(?:\.node|\.so(?:\.\d+)*|\/node)$/.test(file)) return [];
    const fd = openSync(file, 'r');
    const header = Buffer.alloc(20);
    try { if (readSync(fd, header, 0, header.length, 0) !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return []; }
    finally { closeSync(fd); }
    // Packages can include foreign-architecture addons. Their bytes are frozen,
    // but only host ELF binaries have a dependency graph this loader can use.
    const machine = header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
    const hostMachines: Partial<Record<typeof process.arch, number>> = { x64: 62, arm64: 183, ia32: 3, arm: 40 };
    const hostMachine = hostMachines[process.arch];
    if (machine !== hostMachine) return [];
    // npm can retain optional packages for both libc variants on the same CPU.
    // Freeze both byte populations, but follow dependencies only for the ABI
    // selected by this Node executable. Unknown selectors/ABI stay fail-closed.
    for (let directory = dirname(file);; directory = dirname(directory)) {
      const metadata = join(directory, 'package.json');
      if (existsSync(metadata)) {
        const packageJson = JSON.parse(readFileSync(metadata, 'utf8'));
        // Maintained addon loaders select prebuilds by platform/architecture.
        // Android can share Linux's ELF machine and OSABI, so those headers
        // alone do not make its dependency graph loadable by this host.
        const prebuild = /^prebuilds\/(aix|android|darwin|freebsd|haiku|ios|linux|openbsd|sunos|win32)-(arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)(?:-(musl))?\//
          .exec(relative(directory, file));
        const hasPrebuildLoader = ['require-addon', 'bare-addon', 'node-gyp-build', 'node-gyp-build-optional-packages']
          .some(loader => typeof packageJson.dependencies?.[loader] === 'string' ||
            typeof packageJson.optionalDependencies?.[loader] === 'string');
        if (prebuild && hasPrebuildLoader && prebuild[2] === process.arch && prebuild[1] !== process.platform) return [];
        if (prebuild && hasPrebuildLoader && prebuild[1] === 'linux' && prebuild[2] === process.arch &&
            prebuild[3] === 'musl' && process.platform === 'linux' && resolveHostLibc() === 'glibc') return [];
        // NAPI packages can ship both libc variants in ONE package, without a
        // package-level libc field (e.g. tokenizers). Recognize only the declared
        // binary's maintained platform filenames; unknown names/hosts still use ldd.
        const binaryName: unknown = packageJson.napi?.binaryName;
        const napiAbi = typeof binaryName === 'string' && /^[\w-]+$/.test(binaryName) ?
          ['gnu', 'musl', 'gnueabihf', 'musleabihf'].find(abi =>
            relative(directory, file) === `${binaryName}.linux-${process.arch}-${abi}.node`) : undefined;
        if (napiAbi && process.platform === 'linux') {
          const libc = resolveHostLibc();
          if (libc && libc !== (napiAbi.startsWith('musl') ? 'musl' : 'glibc')) return [];
        }
        const declared: unknown = packageJson.libc;
        const selectors = typeof declared === 'string' ? [declared] : declared;
        if (Array.isArray(selectors) && selectors.length > 0 && selectors.every(selector =>
          typeof selector === 'string' && ['glibc', 'musl', '!glibc', '!musl', 'any'].includes(selector))) {
          resolveHostLibc();
          const allowed = selectors.filter(selector => !selector.startsWith('!'));
          if (hostLibc && (selectors.includes(`!${hostLibc}`) ||
              (allowed.length > 0 && !allowed.includes('any') && !allowed.includes(hostLibc)))) return [];
        }
        break;
      }
      if (dirname(directory) === directory) break;
    }
    const output = execFileSync('ldd', [file], { encoding: 'utf8', timeout: 10_000 });
    if (/=>\s+not found/.test(output)) throw new Error(`missing-replay-native-dependency:${file}`);
    return [...output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(match => match[1]);
  });
  const pending = paths.map(path => ({ path: resolve(path), root: realpathSync(path), ancestors: [] as string[] }));
  let completed = 0;
  while (pending.length) {
    const { path, root, ancestors } = pending.pop()!;
    const actual = realpathSync(path);
    if (!insideReplayRoot(root, actual)) throw new Error(`escaping-replay-runtime-link:${path}`);
    const before = statSync(actual, { bigint: true });
    if (before.isDirectory()) {
      // Keep every lexical package alias: consumers can read package.json
      // through a symlink even when Node loads JS from its canonical target.
      // A per-branch canonical ancestry rejects loops without erasing aliases.
      if (ancestors.includes(actual)) throw new Error(`cyclic-replay-runtime-link:${path}`);
      if (directories.has(path)) continue;
      directories.add(path);
      for (const entry of readdirSync(actual)) pending.push({ path: join(path, entry), root, ancestors: [...ancestors, actual] });
      continue;
    }
    if (!before.isFile()) throw new Error(`unsupported-replay-runtime-file:${path}`);
    if (files[actual]) { files[path] = files[actual]; continue; }
    const hash = replayFileHash(actual, buffer);
    const native = dependencies(actual);
    const after = statSync(actual, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]))
      throw new Error(`changed-during-replay-runtime-freeze:${actual}`);
    files[path] = hash; files[actual] = hash;
    for (const dependency of native) pending.push({ path: resolve(dependency), root: realpathSync(dependency), ancestors: [] });
    completed++;
    if (completed % 4096 === 0 || !pending.length)
      options.onProgress?.({ phase: 'runtime-files-frozen', completed, total: completed + pending.length });
  }
  return files;
}
export interface ReplayOracleInput {
  readonly runId: string;
  readonly rootPath: string;
  readonly socketPath: string;
  readonly workspaceId: string;
  readonly levels: readonly number[];
  readonly requestTimeoutMs: number;
  readonly tsconfigPath: string;
  /** Independently selected before freezing; defaults to this freezer's compiler. */
  readonly compilerEntry?: string;
  /** Canonical, predeclared package tree containing the compiler and its dependencies. */
  readonly compilerPackageRoot?: string;
  readonly definition: ReplayCorpus['cursor'];
  readonly references: ReplayCorpus['cursor'];
  /** Additional runtime binaries and loaded daemon/config source whose drift invalidates qualification. */
  readonly runtimeFiles: readonly string[];
  readonly evidenceRef: string;
  readonly semanticCompletionPlugin?: SemanticCompletionPluginDeclaration;
  /** Independent source/dependency copy; this does not establish loaded-runtime identity. */
  readonly sourceSnapshot?: { readonly manifestPath: string; readonly sha256: string };
  /** Declare the service runtime before freezing; later mutation invalidates oracle proof. */
  readonly runtimeWitness?: ReplayRuntimeWitness;
}

function insideReplayRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
}

/** Read the root and tracked submodule populations, including nonignored new
 * files. Match dependency_generation_is_foreign_checkout's product boundary:
 * an untracked embedded repository/worktree is a separate source tree. Report
 * every excluded boundary so a capture can retain its explicit population. */
export function replayRepositorySources(root: string, options: {
  onExcludedRepository?: (path: string) => void;
} = {}): string[] {
  const files = new Set<string>();
  const visit = (directory: string) => {
    const git = (args: string[]) => execFileSync('git', ['-C', directory, ...args],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(directory))
      throw new Error(`uninitialized-replay-submodule:${directory}`);
    for (const entry of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw new Error('invalid-replay-git-population');
      const path = resolve(directory, entry.slice(tab + 1));
      if (!insideReplayRoot(root, path)) throw new Error(`escaping-replay-source:${path}`);
      if (entry.startsWith('160000 ')) visit(path);
      else files.add(relative(root, path));
    }
    for (const entry of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
      const path = resolve(directory, entry);
      if (!insideReplayRoot(root, path)) throw new Error(`escaping-replay-source:${path}`);
      // Git collapses untracked embedded repositories to a trailing-slash
      // directory. It is not a file, nor a tracked gitlink we may recurse into.
      if (entry.endsWith('/')) {
        if (!lstatSync(path).isDirectory() || realpathSync(path) !== path ||
            !existsSync(join(path, '.git')))
          throw new Error(`unsupported-replay-repository-boundary:${path}`);
        const top = execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'],
          { encoding: 'utf8', timeout: 30_000 });
        if (realpathSync(top.trim()) !== path)
          throw new Error(`unsupported-replay-repository-boundary:${path}`);
        options.onExcludedRepository?.(relative(root, path));
      } else files.add(relative(root, path));
    }
  };
  visit(root);
  return [...files].sort();
}

/** Workspace launchers/exports can name ignored build output. The verifier's
 * broad source mirror preserves those inputs; a Git-only census must add them
 * from the existing package declarations rather than silently drop them.
 * Preallocation donor checks use this same selector as source materialization. */
export function replayPackageRuntimeSources(root: string, sources: string[], requiredTargets?: Set<string>): string[] {
  const files = new Set(sources);
  const recordedSources = new Set(sources);
  const visit = (path: string, matches?: (path: string) => boolean, required = false) => {
    if (!insideReplayRoot(root, path)) throw new Error(`escaping-replay-package-input:${path}`);
    const info = lstatSync(path);
    if (!info.isDirectory()) {
      if (!matches || matches(path)) {
        files.add(relative(root, path));
        if (required) requiredTargets?.add(relative(root, path));
      }
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['.git', '.papercusp', 'node_modules'].includes(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
      visit(join(path, entry.name), matches, required);
    }
  };
  const targets = (value: unknown): string[] => typeof value === 'string' ? [value] :
    value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
  for (const source of sources.filter(path => basename(path) === 'package.json')) {
    const file = resolve(root, source);
    if (!insideReplayRoot(root, file)) throw new Error(`escaping-replay-source:${source}`);
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const target of [pkg.main, pkg.module, pkg.exports, pkg.bin].flatMap(targets)) {
      // Node package targets are relative to their package; dependency names and
      // condition labels are not filesystem inputs.
      if (isAbsolute(target) || target.startsWith('#')) continue;
      const packageRoot = dirname(file);
      const normalized = target.replace(/^\.\//, '');
      const declaredPath = resolve(packageRoot, normalized);
      if (!insideReplayRoot(packageRoot, declaredPath)) throw new Error(`escaping-replay-package-input:${target}`);
      if (normalized.includes('*')) {
        // Node export substitutions may span path separators. Restrict the
        // census to the declared pattern, rather than its first path component.
        const pattern = new RegExp(`^${normalized.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        const prefix = normalized.slice(0, normalized.indexOf('*'));
        const directory = resolve(packageRoot, prefix.slice(0, prefix.lastIndexOf('/') + 1));
        if (existsSync(directory)) visit(directory, path => pattern.test(relative(packageRoot, path)));
      } else {
        const path = relative(root, declaredPath);
        // All recorded source comes from the immutable archive. A source
        // entry must not sweep newer live siblings into its output population.
        if (requiredTargets && recordedSources.has(path)) continue;
        if (!existsSync(declaredPath)) continue;
        requiredTargets?.add(path);
        if (requiredTargets && lstatSync(declaredPath).isDirectory()) {
          visit(declaredPath, undefined, true);
          continue;
        }
        // Preserve a build entry's sibling dependency closure. A root-level
        // entry names only itself, never the entire package directory.
        visit(dirname(declaredPath) === packageRoot || lstatSync(declaredPath).isDirectory() ?
          declaredPath : dirname(declaredPath));
      }
    }
  }
  return [...files].sort();
}

/** Extend the verifier's source-copy + locked pinned-dependency mechanism.
 * Copies have independent inodes, never a live symlink floor or Git worktree.
 * The manifest describes captured inputs, not an atomic commit or loaded JS. */
export function materializeReplaySource(input: ReplayOracleInput, destination: string, options: {
  /** Whole committed archive verified by the maintained source exporter. */
  sourceArchive?: { receipt: VerifierSourceReceipt; dependencyDonor: string };
  enumerateSources?: (root: string) => string[];
  snapshotDependencies?: (root: string, destination: string) => void;
  checkSourceHeadroom?: (root: string, destination: string, bytes: number) => void;
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
} = {}): ReplayOracleInput {
  const donor = realpathSync(input.rootPath);
  const target = join(realpathSync(dirname(resolve(destination))), basename(destination));
  const archive = options.sourceArchive;
  const dependencyDonor = archive ? realpathSync(archive.dependencyDonor) : donor;
  if (archive) {
    if (options.enumerateSources) throw new Error('replay-archive-custom-population-forbidden');
    if (archive.receipt.gitCheckout) throw new Error('replay-archive-must-be-source-only');
    verifyVerifierSourceSync(donor, archive.receipt);
    if (insideReplayRoot(dependencyDonor, target) || insideReplayRoot(target, dependencyDonor))
      throw new Error('replay-snapshot-must-be-disjoint');
  }
  if (input.sourceSnapshot) throw new Error('replay-source-already-materialized');
  if (insideReplayRoot(donor, target) || insideReplayRoot(target, donor))
    throw new Error('replay-snapshot-must-be-disjoint');
  const relocate = (file: string) => {
    const source = resolve(donor, file);
    if (!insideReplayRoot(donor, source)) throw new Error(`escaping-replay-cursor:${file}`);
    return relative(donor, source);
  };
  const tsconfigPath = relocate(input.tsconfigPath);
  const definition = { ...input.definition, file: relocate(input.definition.file) };
  const references = { ...input.references, file: relocate(input.references.file) };
  // An external entry is admissible only with its independently selected whole
  // package tree. Reuse runtime freezing and the existing isolated copy layout.
  let compilerEntry: string | undefined;
  let compilerPackageRoot: string | undefined;
  let compilerSourceRoot: string | undefined;
  const compilerPaths = new Map<string, string>();
  const compilerDirectories = new Map<string, ReturnType<typeof replaySourceAdmissionStat>>();
  let compilerHashes: Record<string, string> = {};
  if (input.compilerPackageRoot !== undefined) {
    const root = input.compilerPackageRoot;
    if (!input.compilerEntry || !isAbsolute(root) || realpathSync(root) !== resolve(root) ||
        !statSync(root).isDirectory() || !statSync(join(root, 'package.json')).isFile())
      throw new Error('replay-compiler-package-declaration-invalid');
    compilerSourceRoot = root;
    compilerPackageRoot = insideReplayRoot(donor, root) ? resolve(target, relative(donor, root)) :
      join(target, '.replay-runtime', replayHash(root));
    const pending = [root];
    while (pending.length) {
      const path = pending.pop()!;
      const info = replaySourceAdmissionStat(path);
      if (!insideReplayRoot(root, realpathSync(path))) throw new Error(`escaping-replay-compiler-package:${path}`);
      if (info.isDirectory()) {
        compilerDirectories.set(path, info);
        for (const entry of readdirSync(path).sort()) {
          if (entry === '.git') throw new Error(`unsupported-replay-compiler-package:${path}`);
          pending.push(join(path, entry));
        }
      } else if (info.isFile() || info.isSymbolicLink()) {
        compilerPaths.set(path, resolve(compilerPackageRoot, relative(root, path)));
      } else throw new Error(`unsupported-replay-compiler-package:${path}`);
    }
    compilerHashes = freezeReplayRuntimeFiles([root], { nativeDependencies: () => [] });
  }
  if (input.compilerEntry !== undefined) {
    if (!isAbsolute(input.compilerEntry)) throw new Error('replay-semantic-compiler-entry-absolute');
    const source = realpathSync(input.compilerEntry);
    if (compilerSourceRoot) {
      if (!insideReplayRoot(compilerSourceRoot, input.compilerEntry) || !insideReplayRoot(compilerSourceRoot, source) ||
          !compilerHashes[source]) throw new Error(`escaping-replay-compiler-entry:${source}`);
      compilerEntry = resolve(compilerPackageRoot!, relative(compilerSourceRoot, source));
    } else {
      if (!insideReplayRoot(donor, source)) throw new Error(`escaping-replay-compiler-entry:${source}`);
      compilerEntry = resolve(target, relocate(source));
    }
  }
  const plugin = input.semanticCompletionPlugin;
  const pluginPaths = new Map<string, string>();
  let semanticCompletionPlugin: SemanticCompletionPluginDeclaration | undefined;
  if (plugin) {
    semanticCompletionPlugins(plugin);
    const packageRoot = join(plugin.location, 'node_modules', plugin.name);
    const location = insideReplayRoot(donor, plugin.location) ? resolve(target, relative(donor, plugin.location)) :
      join(target, '.replay-runtime', replayHash(plugin.location));
    const declaredRuntimeFiles = new Set(input.runtimeFiles.map(file => resolve(donor, file)));
    const files: Record<string, string> = {};
    for (const [file, hash] of Object.entries(plugin.files)) {
      if (!isAbsolute(file) || !insideReplayRoot(packageRoot, file)) throw new Error(`escaping-replay-plugin-input:${file}`);
      if (!declaredRuntimeFiles.has(file)) throw new Error(`replay-plugin-input-undeclared:${file}`);
      const out = resolve(location, relative(plugin.location, file));
      pluginPaths.set(file, out);
      files[out] = hash;
    }
    semanticCompletionPlugin = { ...plugin, location, files };
  }
  // Admit the selected population before creating a capture. The dependency
  // phase has its own copy admission; source and external runtime bytes used
  // to bypass it entirely. Apparent sizes include sparse files; per-entry
  // overhead conservatively covers directories and the two source manifests.
  const excludedRepositories: string[] = [];
  const repositorySources = archive ? [...archive.receipt.files.map(file => file.path), '.verifier-source.json'].sort() :
    options.enumerateSources ? options.enumerateSources(donor) :
    replayRepositorySources(donor, { onExcludedRepository: path => excludedRepositories.push(path) });
  const sourcePopulation = { policy: archive ? 'verifier-source-v1' : options.enumerateSources ? 'caller-declared-files-v1' :
    'git-root-and-tracked-submodules-v1', excludedRepositories: excludedRepositories.sort(),
    ...(archive ? { sourceCommit: archive.receipt.sourceCommit, submodules: archive.receipt.submodules ?? [],
      receiptSha256: replayHash(readFileSync(join(donor, '.verifier-source.json'))),
      runtimeOutputPolicy: 'declared-package-ignored-inputs-v2', dependencyDonor } : {}) };
  const recordedSources = new Set(repositorySources);
  const packageDeclarations = repositorySources.filter(path => basename(path) === 'package.json');
  const archiveOutputPaths = () => {
    for (const path of packageDeclarations) {
      if (replayHash(readFileSync(resolve(dependencyDonor, path))) !== replayHash(readFileSync(resolve(donor, path))))
        throw new Error(`replay-archive-package-declaration-drift:${path}`);
    }
    const requiredTargets = new Set<string>();
    const candidates = replayPackageRuntimeSources(dependencyDonor, repositorySources, requiredTargets)
      .filter(path => !recordedSources.has(path));
    // Export patterns may cover newer live source. Only ignored build inputs
    // extend the archive; an exact unrecorded nonignored target still refuses.
    const outputs: string[] = [];
    const groups = new Map<string, string[]>();
    for (const path of candidates) {
      const submodule = [...(archive!.receipt.submodules ?? [])].sort((a, b) => b.path.length - a.path.length)
        .find(row => path.startsWith(`${row.path}/`))?.path ?? '';
      const group = groups.get(submodule) ?? []; group.push(path); groups.set(submodule, group);
    }
    for (const [submodule, paths] of groups) {
      const root = resolve(dependencyDonor, submodule);
      const relativePaths = paths.map(path => relative(root, resolve(dependencyDonor, path)));
      const result = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'],
        { input: `${relativePaths.join('\0')}\0`, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
      if (result.error || result.status !== 0 && result.status !== 1)
        throw new Error(`replay-archive-output-ignore-unmeasured:${result.error ?? result.stderr}`);
      const ignored = new Set(result.stdout.split('\0').filter(Boolean));
      const unexpected = relativePaths.find(path => !ignored.has(path) && requiredTargets.has(join(submodule, path)));
      if (unexpected) throw new Error(`replay-archive-unrecorded-source:${join(submodule, unexpected)}`);
      outputs.push(...paths.filter((_path, index) => ignored.has(relativePaths[index])));
    }
    return outputs.sort();
  };
  const outputPaths = archive ? archiveOutputPaths() : [];
  const outputSources = new Map(outputPaths.map(path => [path, resolve(dependencyDonor, path)]));
  const outputSourceFiles = new Set(outputSources.values());
  const paths = archive ? [...repositorySources, ...outputPaths].sort() : replayPackageRuntimeSources(donor, repositorySources);
  const sources = new Set<string>();
  for (const path of paths) {
    const source = outputSources.get(path) ?? resolve(donor, path);
    const sourceRoot = outputSources.has(path) ? dependencyDonor : donor;
    if (isAbsolute(path) || !insideReplayRoot(sourceRoot, source) || path.split('/').includes('.git'))
      throw new Error(`escaping-replay-source:${path}`);
    try { lstatSync(source); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }
    if (!insideReplayRoot(sourceRoot, realpathSync(dirname(source)))) throw new Error(`escaping-replay-source:${path}`);
    sources.add(source);
  }
  for (const file of input.runtimeFiles) sources.add(resolve(donor, file));
  for (const file of compilerPaths.keys()) sources.add(file);
  const admittedFiles = new Map<string, ReturnType<typeof replaySourceAdmissionStat>>();
  let sourceBytes = 8192;
  for (const source of sources) {
    const info = replaySourceAdmissionStat(source);
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`unsupported-replay-source:${source}`);
    admittedFiles.set(source, info);
    sourceBytes += Number(info.size) + 4096 * (relative(donor, source).split('/').length + 1);
    if (!Number.isSafeInteger(sourceBytes)) throw new Error('replay-source-size-unmeasured');
  }
  if (!options.snapshotDependencies) {
    // WI-41095: share the maintained source boundary and check .bin too,
    // before headroom admission or allocating evidence. The locked copy rechecks.
    execFileSync('bash', [join(donor, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'preflight', dependencyDonor, '-'],
      { encoding: 'utf8', input: JSON.stringify(paths.filter(path => sources.has(outputSources.get(path) ?? resolve(donor, path)))) });
  }
  (options.checkSourceHeadroom ?? ((root, out, bytes) => {
    // Reuse the host copy lease and donor-scoped reserve policy. Check-only
    // never invokes the generation reaper on retained replay evidence. This
    // lease protects the preflight measurement, not the subsequent JS writes.
    execFileSync('bash', ['-c', `source "$1" || exit $?
dependency_generation_record_reserve_fs "$2"
dependency_generation_acquire_copy_lock "replay source $3" || exit $?
trap dependency_generation_release_copy_lock EXIT
DEPENDENCY_GENERATION_HEADROOM_CHECK_ONLY=1 dependency_generation_check_headroom "$2" "$3" "$4"`,
      'replay-source-headroom', join(donor, 'apps/operator/bin/release/dependency-generation.sh'), root, out, String(bytes)],
    // The maintained copy-lock waiter owns stall/lock diagnostics and bounds.
    // A second elapsed-time deadline would kill a progressing lock holder wait.
    { encoding: 'utf8' });
  }))(dependencyDonor, target, sourceBytes);
  options.onProgress?.({ phase: 'source-admitted', completed: 0, total: paths.length });
  // Exclusive creation refuses a previous run; failures leave forensic inputs.
  mkdirSync(target, { mode: 0o700 });
  const hashes: Record<string, string> = {};
  const absent: string[] = [];
  const copy = (source: string, out: string) => {
    const before = lstatSync(source, { bigint: true });
    const admitted = admittedFiles.get(source);
    if (!admitted || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key =>
      before[key as keyof typeof before] !== admitted[key as keyof typeof admitted]))
      throw new Error(`changed-since-replay-admission:${source}`);
    mkdirSync(dirname(out), { recursive: true });
    if (before.isSymbolicLink()) {
      const link = readlinkSync(source);
      const resolved = realpathSync(source);
      const root = compilerPaths.has(source) ? compilerSourceRoot! :
        outputSourceFiles.has(source) ? dependencyDonor : donor;
      const destinationRoot = compilerPaths.has(source) ? compilerPackageRoot! : target;
      if (!insideReplayRoot(root, resolved)) throw new Error(`escaping-replay-symlink:${source}`);
      symlinkSync(isAbsolute(link) ? resolve(destinationRoot, relative(root, resolved)) : link, out);
      hashes[relative(target, out)] = replayHash(`symlink:${readlinkSync(out)}`);
    } else if (before.isFile()) {
      const bytes = readFileSync(source);
      writeFileSync(out, bytes, { flag: 'wx', mode: Number(before.mode & 0o777n) });
      hashes[relative(target, out)] = replayHash(bytes);
    } else throw new Error(`unsupported-replay-source:${source}`);
    const after = lstatSync(source, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]))
      throw new Error(`changed-during-replay-copy:${source}`);
  };
  for (const [index, path] of paths.entries()) {
    const source = outputSources.get(path) ?? resolve(donor, path);
    const sourceRoot = outputSources.has(path) ? dependencyDonor : donor;
    if (isAbsolute(path) || !insideReplayRoot(sourceRoot, source) || path.split('/').includes('.git'))
      throw new Error(`escaping-replay-source:${path}`);
    try { lstatSync(source); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent.push(path); continue; // tracked deletions are part of the captured population
    }
    if (!insideReplayRoot(sourceRoot, realpathSync(dirname(source)))) throw new Error(`escaping-replay-source:${path}`);
    copy(source, resolve(target, path));
    if ((index + 1) % 256 === 0 || index + 1 === paths.length)
      options.onProgress?.({ phase: 'source-copied', completed: index + 1, total: paths.length });
  }
  // Keep the completed phase even if a later dependency/containment phase fails.
  writeFileSync(join(target, '.replay-source-capture.json'), JSON.stringify({ runId: input.runId,
    donor, rootPath: target, sourcePopulation, sourceFiles: hashes, absent, loadedRuntime: 'unmeasured' }, null, 2), { flag: 'wx' });
  options.onProgress?.({ phase: 'dependencies-copy-started', completed: 0, total: 1 });
  (options.snapshotDependencies ?? ((root, out) => {
    execFileSync('bash', [join(donor, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'snapshot-locked', root, out, 'copy',
      join(out, '.replay-source-capture.json')],
      // The maintained helper detects stalled copy I/O and cleans up its child.
      // A whole-snapshot deadline includes mutex waits and every dependency tree,
      // so it can terminate a healthy copy without a completed snapshot stamp.
      { stdio: 'inherit' });
  }))(dependencyDonor, target);
  const dependencyStamp = join(target, '.papercusp-pinned-deps');
  if (!/^mode=copy$/m.test(readFileSync(dependencyStamp, 'utf8')))
    throw new Error('replay-dependencies-not-independent-copies');
  hashes[relative(target, dependencyStamp)] = replayHash(readFileSync(dependencyStamp));
  options.onProgress?.({ phase: 'dependencies-copied', completed: 1, total: 1 });
  for (const [source, out] of compilerPaths) {
    if (!existsSync(out)) copy(source, out);
    const original = admittedFiles.get(source)!;
    const copied = lstatSync(out, { bigint: true });
    if (original.isSymbolicLink() !== copied.isSymbolicLink() || original.isFile() !== copied.isFile() ||
        (original.mode & 0o777n) !== (copied.mode & 0o777n))
      throw new Error(`replay-compiler-copy-layout-mismatch:${source}`);
    if (original.isSymbolicLink()) {
      const link = readlinkSync(source);
      const expected = isAbsolute(link) ? resolve(compilerPackageRoot!, relative(compilerSourceRoot!, realpathSync(source))) : link;
      if (readlinkSync(out) !== expected) throw new Error(`replay-compiler-copy-layout-mismatch:${source}`);
      hashes[relative(target, out)] = replayHash(`symlink:${expected}`);
    } else {
      if (replayFileHash(out, Buffer.allocUnsafe(64 * 1024)) !== compilerHashes[source])
        throw new Error(`replay-compiler-copy-byte-mismatch:${source}`);
      hashes[relative(target, out)] = compilerHashes[source];
    }
  }
  const runtimeFiles = input.runtimeFiles.map(file => {
    const source = resolve(donor, file);
    const out = compilerPaths.get(source) ?? pluginPaths.get(source) ?? (insideReplayRoot(donor, source) ? resolve(target, relative(donor, source)) :
      join(target, '.replay-runtime', replayHash(source), basename(source)));
    if (!existsSync(out)) copy(source, out);
    return out;
  });
  // A predeclared package keeps its layout and hashes inside the independent
  // copy. Never retain a live donor probe path or bless replacement bytes.
  if (semanticCompletionPlugin) {
    for (const [file, hash] of Object.entries(semanticCompletionPlugin.files)) {
      if (replayHash(readFileSync(file)) !== hash) throw new Error(`replay-plugin-copy-byte-mismatch:${file}`);
      hashes[relative(target, file)] = hash;
    }
    semanticCompletionPlugins(semanticCompletionPlugin);
  }
  // Preserved workspace links must resolve into the independent population.
  // A dependency tree may hide an absolute/live donor link several levels down.
  const pending = [target];
  let checked = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() && !insideReplayRoot(target, realpathSync(path)))
        throw new Error(`escaping-replay-snapshot-link:${path}`);
      if (entry.isDirectory()) pending.push(path);
      checked++;
      if (checked % 4096 === 0) options.onProgress?.({ phase: 'symlinks-checked', completed: checked, total: checked });
    }
  }
  // Added/deleted package members invalidate the complete-tree declaration too.
  for (const [path, before] of [...compilerDirectories, ...[...compilerPaths.keys()].map(path =>
    [path, admittedFiles.get(path)!] as const)]) {
    const after = replaySourceAdmissionStat(path);
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key =>
      before[key as keyof typeof before] !== after[key as keyof typeof after]))
      throw new Error(`changed-during-replay-compiler-copy:${path}`);
  }
  const compilerRuntimeFiles = Object.keys(compilerHashes).map(file =>
    resolve(compilerPackageRoot!, relative(compilerSourceRoot!, file)));
  if (archive) {
    verifyVerifierSourceSync(donor, archive.receipt);
    if (JSON.stringify(archiveOutputPaths()) !== JSON.stringify(outputPaths))
      throw new Error('changed-during-replay-archive-output-population');
    for (const [path, source] of outputSources) {
      const before = admittedFiles.get(source)!;
      const after = replaySourceAdmissionStat(source);
      if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key =>
        before[key as keyof typeof before] !== after[key as keyof typeof after]))
        throw new Error(`changed-during-replay-archive-output:${path}`);
    }
  } else if (!options.enumerateSources) {
    const finalExcluded: string[] = [];
    const finalSources = replayRepositorySources(donor, { onExcludedRepository: path => finalExcluded.push(path) });
    if (JSON.stringify(finalSources) !== JSON.stringify(repositorySources) ||
        JSON.stringify(finalExcluded.sort()) !== JSON.stringify(sourcePopulation.excludedRepositories))
      throw new Error('changed-during-replay-source-population');
  }
  const manifestPath = join(target, '.replay-source-snapshot.json');
  const manifest = JSON.stringify({ schemaVersion: 'lsp-replay-source-snapshot-v1', donor, rootPath: target,
    sourcePopulation, sourceFiles: hashes, absent, dependencyIsolation: 'independent-copy-under-install-mutex',
    loadedRuntime: 'unmeasured' }, null, 2);
  writeFileSync(manifestPath, manifest, { flag: 'wx' });
  return { ...input, rootPath: target, tsconfigPath, definition, references,
    runtimeFiles: [...new Set([...runtimeFiles, ...compilerRuntimeFiles, dependencyStamp, manifestPath])],
    ...(compilerEntry ? { compilerEntry } : {}),
    ...(compilerPackageRoot ? { compilerPackageRoot } : {}),
    ...(semanticCompletionPlugin ? { semanticCompletionPlugin } : {}),
    sourceSnapshot: { manifestPath, sha256: replayHash(manifest) } };
}

function replaySourceAdmissionStat(source: string) {
  return lstatSync(source, { bigint: true });
}

/**
 * Independent static source census: resolves lexical bindings with the compiler
 * checker, never calls the subject adapter/server or learns sites from a warmup.
 * The explicit config/roots bound the population and are retained in the archive.
 */
interface ReplayOracleProgress {
  phase: 'config-parsed' | 'compiler-loaded' | 'oracle-resolved' | 'references-scanned' | 'files-validating' | 'file-validated' | 'validated';
  completed: number;
  total: number;
  file?: string;
}
export function freezeCompilerReplayConfig(input: ReplayOracleInput, options: {
  onProgress?: (progress: ReplayOracleProgress) => void;
} = {}): DaemonReplayConfig {
  // Only plain config data crosses this boundary. Do not keep the compiler graph
  // reachable while rereading the complete source/config/binary population.
  const { config, sourceCount } = compilerReplayConfig(input, options);
  validateDaemonReplayConfig(config, options);
  options.onProgress?.({ phase: 'validated', completed: sourceCount, total: sourceCount });
  return config;
}
function compilerReplayConfig(input: ReplayOracleInput, options: {
  onProgress?: (progress: ReplayOracleProgress) => void;
}): { config: DaemonReplayConfig; sourceCount: number } {
  const tsconfigPath = resolve(input.rootPath, input.tsconfigPath);
  const require = createRequire(import.meta.url);
  if (input.compilerEntry !== undefined && !isAbsolute(input.compilerEntry))
    throw new Error('replay-semantic-compiler-entry-absolute');
  const compilerEntry = realpathSync(input.compilerEntry ?? require.resolve('typescript'));
  if (!statSync(compilerEntry).isFile()) throw new Error('replay-semantic-compiler-entry-invalid');
  const compilerPaths = [compilerEntry];
  // Capture the executable shim and maintained delegate BEFORE loading either.
  // Matching versions alone cannot establish matching library path identity.
  if (/require\(["']@typescript\/old["']\)/.test(readFileSync(compilerEntry, 'utf8')))
    compilerPaths.push(realpathSync(createRequire(compilerEntry).resolve('@typescript/old')));
  const compilerEntries: Record<string, string> = {};
  for (const file of compilerPaths) {
    if (input.sourceSnapshot && !insideReplayRoot(realpathSync(input.rootPath), file))
      throw new Error(`snapshot-input-escape:${file}`);
    compilerEntries[file] = replayFileHash(file, Buffer.allocUnsafe(64 * 1024));
  }
  const ts = require(compilerEntry) as typeof Ts;
  if (ts.version !== SEMANTIC_COMPLETION_TYPESCRIPT_VERSION)
    throw new Error('replay-semantic-compiler-version-unsupported');
  const loadedInputs = new Map<string, string>(Object.entries(compilerEntries));
  // Capture the very bytes handed to the compiler, not a later disk read.
  // Match TypeScript's BOM decoding while retaining the original byte hash.
  const readCompilerInput = (file: string): string | undefined => {
    let bytes: Buffer;
    try { bytes = readFileSync(file); } catch { return undefined; }
    const absolute = resolve(file);
    if (input.sourceSnapshot && !insideReplayRoot(input.rootPath, absolute))
      throw new Error(`snapshot-input-escape:${absolute}`);
    const hash = replayHash(bytes);
    const previous = loadedInputs.get(absolute);
    if (previous && previous !== hash) throw new Error(`changed-compiler-input:${absolute}`);
    loadedInputs.set(absolute, hash);
    if (bytes[0] === 254 && bytes[1] === 255)
      return Buffer.from(bytes.subarray(2, bytes.length & ~1)).swap16().toString('utf16le');
    if (bytes[0] === 255 && bytes[1] === 254) return bytes.toString('utf16le', 2);
    return bytes.toString('utf8', bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0);
  };
  const fatal: Ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined,
    { ...ts.sys, readFile: readCompilerInput, onUnRecoverableConfigFileDiagnostic: error => fatal.push(error) });
  if (!parsed || fatal.length) throw new Error(fatal.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  // A solution/reference graph needs one independently captured declaration per
  // configured project. Refuse it before compiler/native work until modeled.
  if (parsed.projectReferences?.length) throw new Error('replay-semantic-project-references-unsupported');
  const roots = [...new Set(parsed.fileNames.map(file => resolve(file)))].sort();
  if (!roots.length) throw new Error('replay-semantic-configured-roots-empty');
  options.onProgress?.({ phase: 'config-parsed', completed: 0, total: roots.length });
  const host = ts.createCompilerHost(parsed.options);
  host.readFile = readCompilerInput;
  const program = ts.createProgram({ rootNames: roots, options: parsed.options, host });
  options.onProgress?.({ phase: 'compiler-loaded', completed: program.getSourceFiles().length, total: program.getSourceFiles().length });
  const checker = program.getTypeChecker();
  const canonical = (symbol: Ts.Symbol | undefined): Ts.Symbol | undefined => {
    const seen = new Set<Ts.Symbol>();
    while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) { seen.add(symbol); symbol = checker.getAliasedSymbol(symbol); }
    return symbol;
  };
  const sourceFiles = program.getSourceFiles().filter(source => !source.isDeclarationFile &&
    !relative(input.rootPath, source.fileName).startsWith('..') && !source.fileName.includes('/node_modules/'));
  const files: Record<string, string> = Object.fromEntries(loadedInputs);
  // Declaration inputs and inherited configs affect symbol binding even though
  // they are not candidate reference sites. Their drift invalidates the oracle.
  for (const source of program.getSourceFiles()) if (!loadedInputs.has(resolve(source.fileName)))
    throw new Error(`unmeasured-compiler-input:${source.fileName}`);
  const configFile = parsed.options.configFile as (Ts.SourceFile & { extendedSourceFiles?: string[] }) | undefined;
  if (!configFile) throw new Error('replay-semantic-config-declaration-missing');
  const configFiles = [...new Set([tsconfigPath, ...(configFile.extendedSourceFiles ?? []).map(file => resolve(file))])].sort();
  const projectFiles = [...new Set([...program.getSourceFiles().map(source => resolve(source.fileName)), ...configFiles])].sort();
  if (configFiles.some(file => !loadedInputs.has(file))) throw new Error('replay-semantic-config-input-unmeasured');
  // The AST carries cycles and compiler caches; preserve only plain effective
  // options, retaining path-valued options exactly as used by this compiler.
  const { configFile: _configFile, ...plainOptions } = parsed.options;
  const compilerOptions = JSON.parse(JSON.stringify(plainOptions)) as Record<string, unknown>;
  const declaration = { schemaVersion: 'lsp-replay-semantic-graph-v1' as const, compilerVersion: ts.version,
    compilerEntries, projects: [{ projectName: tsconfigPath, anchorFile: roots.find(file =>
      file === resolve(input.rootPath, input.definition.file)) ?? roots[0], files: projectFiles,
    rootNames: roots, configFiles, compilerOptions }] };
  const semanticGraph: ReplaySemanticGraph = { ...declaration, fingerprint: replayHash(JSON.stringify(declaration)) };
  const hashBuffer = Buffer.allocUnsafe(64 * 1024);
  for (const file of input.runtimeFiles) {
    const absolute = resolve(input.rootPath, file);
    const hash = replayFileHash(absolute, hashBuffer);
    if (files[absolute] && files[absolute] !== hash) throw new Error(`changed-compiler-input:${absolute}`);
    files[absolute] = hash;
  }
  const sourceFingerprint = replaySourceFingerprint(files);
  const locate = (cursor: ReplayCorpus['cursor']) => {
    const source = program.getSourceFile(resolve(input.rootPath, cursor.file));
    if (!source) throw new Error(`oracle cursor outside compiler population:${cursor.file}`);
    const lines = source.getLineStarts();
    if (cursor.line1 < 1 || cursor.line1 > lines.length) throw new Error('oracle cursor line outside source');
    const offset = lines[cursor.line1 - 1] + cursor.character;
    let identifier: Ts.Identifier | undefined;
    const visit = (node: Ts.Node) => {
      if (offset < node.getStart(source) || offset >= node.end) return;
      if (ts.isIdentifier(node)) identifier = node;
      else ts.forEachChild(node, visit);
    };
    visit(source);
    const symbol = canonical(identifier ? checker.getSymbolAtLocation(identifier) : undefined);
    if (!symbol || !symbol.declarations?.length) throw new Error(`unresolved source oracle:${cursor.file}`);
    return symbol;
  };
  const site = (node: Ts.Node) => ({ path: relative(input.rootPath, node.getSourceFile().fileName).replaceAll('\\', '/'),
    line1: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  const unique = (sites: ReplayOracle['sites']) => [...new Map(sites.map(site => [JSON.stringify(site), site])).values()]
    .sort((a, b) => a.path.localeCompare(b.path) || (a.line1 ?? 0) - (b.line1 ?? 0));
  const cheap = locate(input.definition);
  const hot = locate(input.references);
  const definitions = unique(cheap.declarations!.map(site));
  const references: { path: string; line1: number }[] = [];
  options.onProgress?.({ phase: 'oracle-resolved', completed: 0, total: sourceFiles.length });
  for (const [index, source] of sourceFiles.entries()) {
    const visit = (node: Ts.Node) => {
      if (ts.isIdentifier(node)) {
        let symbol = canonical(checker.getSymbolAtLocation(node));
        // In `const [{ hot }] = await Promise.all([import('./source')])`,
        // the shorthand identifier binds a new LOCAL variable. The source
        // property still refers to the export; resolve it from the binding
        // pattern's type without treating later local uses as export sites.
        const binding = node.parent;
        if (ts.isBindingElement(binding) && binding.name === node &&
          !binding.propertyName && !binding.dotDotDotToken && ts.isObjectBindingPattern(binding.parent))
          symbol = canonical(checker.getTypeAtLocation(binding.parent).getProperty(node.text));
        if (symbol === hot) references.push(site(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if ((index + 1) % 64 === 0 || index + 1 === sourceFiles.length)
      options.onProgress?.({ phase: 'references-scanned', completed: index + 1, total: sourceFiles.length });
  }
  const corpus = (cursor: ReplayCorpus['cursor'], sites: ReplayOracle['sites']): ReplayCorpus => ({ cursor,
    oracle: { sites, sourceFingerprint, oracleFingerprint: replayOracleFingerprint({ sites }) } });
  const config: DaemonReplayConfig = { schemaVersion: 'lsp-daemon-replay-config-v1', runId: input.runId,
    rootPath: input.rootPath, socketPath: input.socketPath, workspaceId: input.workspaceId, levels: input.levels,
    requestTimeoutMs: input.requestTimeoutMs, files, semanticGraph,
    ...(input.semanticCompletionPlugin ? { semanticCompletionPlugin: input.semanticCompletionPlugin } : {}),
    oracleProvenance: { method: 'static TypeScript symbol-binding census over the frozen compiler source population; no daemon answers',
      evidenceRef: input.evidenceRef, compilerVersion: ts.version },
    corpus: { definition: corpus(input.definition, definitions), 'hot-references': corpus(input.references, unique(references)) },
    ...(input.sourceSnapshot ? { sourceSnapshot: input.sourceSnapshot } : {}),
    ...(input.runtimeWitness ? { runtimeWitness: input.runtimeWitness } : {}) };
  return { config, sourceCount: sourceFiles.length };
}
export function replayFileMismatches(files: DaemonReplayConfig['files'], options: {
  onProgress?: (progress: ReplayOracleProgress) => void;
} = {}): string[] {
  const entries = Object.entries(files);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const mismatches: string[] = [];
  options.onProgress?.({ phase: 'files-validating', completed: 0, total: entries.length });
  for (const [index, [file, hash]] of entries.entries()) {
    // Emit the exact pending file before opening it, so a stalled read remains
    // distinguishable from a completed reference scan or a successful freeze.
    options.onProgress?.({ phase: 'files-validating', file, completed: index, total: entries.length });
    try { if (replayFileHash(file, buffer) !== hash) mismatches.push(`changed-file:${file}`); }
    catch { mismatches.push(`unreadable-file:${file}`); }
    options.onProgress?.({ phase: 'file-validated', file, completed: index + 1, total: entries.length });
  }
  return mismatches;
}

export function validateDaemonReplayConfig(config: DaemonReplayConfig, options: {
  onProgress?: (progress: ReplayOracleProgress) => void;
} = {}): void {
  if (config.schemaVersion !== 'lsp-daemon-replay-config-v1' || !/^[a-zA-Z0-9_-]+$/.test(config.runId))
    throw new Error('invalid replay config identity');
  if (!isAbsolute(config.rootPath) || !isAbsolute(config.socketPath) || !config.workspaceId)
    throw new Error('replay requires absolute project/socket and explicit workspace');
  if (!config.levels.length || new Set(config.levels).size !== config.levels.length ||
      config.levels.some(level => !Number.isSafeInteger(level) || level < 1)) throw new Error('invalid declared ladder');
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1)
    throw new Error('invalid frozen request deadline');
  if (!config.oracleProvenance.method || !config.oracleProvenance.evidenceRef || !Object.keys(config.files).length)
    throw new Error('independent oracle provenance and frozen file population are required');
  for (const [file, hash] of Object.entries(config.files)) {
    if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid frozen source identity');
    if (config.sourceSnapshot && !insideReplayRoot(config.rootPath, file)) throw new Error(`snapshot-input-escape:${file}`);
  }
  if (config.sourceSnapshot && (!insideReplayRoot(config.rootPath, config.sourceSnapshot.manifestPath) ||
      config.files[config.sourceSnapshot.manifestPath] !== config.sourceSnapshot.sha256))
    throw new Error('unmatched-replay-source-snapshot');
  if (config.semanticGraph) assertReplaySemanticGraph(config);
  for (const queryClass of REPLAY_CLASSES) {
    const { cursor, oracle } = config.corpus[queryClass];
    const file = resolve(config.rootPath, cursor.file);
    if (!config.files[file] || !Number.isInteger(cursor.line1) || cursor.line1 < 1 ||
        !Number.isInteger(cursor.character) || cursor.character < 0) throw new Error(`invalid frozen cursor:${queryClass}`);
    if (!oracle.sites.length || !oracle.sourceFingerprint || !oracle.oracleFingerprint)
      throw new Error(`missing complete positive oracle:${queryClass}`);
    if (oracle.sourceFingerprint !== replaySourceFingerprint(config.files) ||
        oracle.oracleFingerprint !== replayOracleFingerprint({ sites: oracle.sites, ...(oracle.staleSites ? { staleSites: oracle.staleSites } : {}) }))
      throw new Error(`unmatched frozen fingerprint:${queryClass}`);
    const seen = new Set<string>();
    for (const site of oracle.sites) {
      if (!site.line1 || !Number.isInteger(site.line1) || site.line1 < 1 || isAbsolute(site.path) ||
          relative(config.rootPath, resolve(config.rootPath, site.path)).startsWith('..'))
        throw new Error(`invalid oracle site:${queryClass}`);
      if (!config.files[resolve(config.rootPath, site.path)]) throw new Error(`unfrozen oracle file:${site.path}`);
      const key = JSON.stringify([site.path, site.line1]);
      if (seen.has(key)) throw new Error(`duplicate oracle site:${queryClass}`);
      seen.add(key);
    }
  }
  if (config.corpus.definition.oracle.sourceFingerprint !== config.corpus['hot-references'].oracle.sourceFingerprint)
    throw new Error('unmatched source fingerprints');
  const drift = replayFileMismatches(config.files, options);
  if (drift.length) throw new Error(drift.join('\n'));
}

/** Actual wire occupancy, not caller wait overlap. Epoch clocks come from daemon evidence. */
function isReferenceWire(wire: NonNullable<LspDaemonAnswer['daemonEvidence']>['wire'][number]): boolean {
  return wire.method === 'textDocument/references' ||
    (wire.method === 'workspace/executeCommand' && wire.command === SEMANTIC_COMPLETION_COMMAND);
}

export function replayWireOverlap(report: ReplayReport): boolean {
  const cheap = report.samples.filter(row => row.request.queryClass === 'definition');
  const hot = report.samples.filter(row => row.request.queryClass === 'hot-references');
  return cheap.some(row => {
    const answer = row.answer as LspDaemonAnswer | null;
    const end = answer?.daemonEvidence?.respondedAtMs;
    return end !== null && end !== undefined && hot.some(reference =>
      (reference.answer as LspDaemonAnswer | null)?.daemonEvidence?.wire.some(wire =>
        isReferenceWire(wire) && wire.endedAtMs !== null &&
        wire.startedAtMs < end && end < wire.endedAtMs));
  });
}

export function replayEvidenceProblems(report: ReplayReport): string[] {
  const problems: string[] = [];
  for (const sample of report.samples) {
    const answer = sample.answer as LspDaemonAnswer | null;
    const evidence = answer?.daemonEvidence;
    if (!evidence || evidence.requestId !== sample.request.id) { problems.push(`missing-daemon-identity:${sample.request.id}`); continue; }
    const wire = evidence.wire.filter(row => sample.request.queryClass === 'definition'
      ? row.method === 'textDocument/definition' : isReferenceWire(row));
    if (!wire.length || wire.some(row => !row.taskId || !row.pid || row.endedAtMs === null || row.outcome !== 'response'))
      problems.push(`unsettled-wire:${sample.request.id}`);
    const receipts = evidence.events.filter(event => event.phase === 'durable-enqueued');
    if (!receipts.length || receipts.some(receipt => !receipt.receiptId || !evidence.events.some(event =>
      event.receiptId === receipt.receiptId && event.phase === 'durable-settled' && event.confirmed === true)))
      problems.push(`unconfirmed-durable-settlement:${sample.request.id}`);
    const terminal = Math.max(...evidence.events.filter(event => event.phase === 'durable-settled').map(event => event.atMs));
    const clientEnd = sample.clientSettledAtMs ?? sample.settledAtMs;
    if (!Number.isFinite(terminal) || terminal < sample.issuedAtMs || terminal > clientEnd || evidence.respondedAtMs === null ||
        evidence.respondedAtMs > clientEnd) problems.push(`invalid-settlement-order:${sample.request.id}`);
  }
  return problems;
}

interface ReplayProcessReader {
  identity(pid: number): string | null;
  text(path: string): string;
  bytes(path: string): Buffer;
  link(path: string): string;
}
const replayProcessReader: ReplayProcessReader = {
  identity: readProcessIdentity,
  text: path => readFileSync(path, 'utf8'),
  bytes: readFileSync,
  link: readlinkSync,
};
/** Kernel executable bytes and boot/start identity, not a later disk-path hash. */
export function replayProcessIdentity(pid: number, reader: ReplayProcessReader = replayProcessReader, witness?: ReplayRuntimeWitness) {
  const unknown: string[] = [];
  const before = reader.identity(pid);
  const read = <T>(label: string, fn: () => T): T | null => {
    try { return fn(); } catch (error) { unknown.push(`${label}:${String(error)}`); return null; }
  };
  const cmdline = read('cmdline', () => reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean)) ?? [];
  const cgroup = read('cgroup', () => reader.text(`/proc/${pid}/cgroup`).trim());
  const executable = read('executable', () => ({ path: reader.link(`/proc/${pid}/exe`), sha256: replayHash(reader.bytes(`/proc/${pid}/exe`)) }));
  const after = reader.identity(pid);
  if (!before || !after) unknown.push('process-identity-unavailable');
  else if (before !== after) unknown.push('process-replaced-during-snapshot');
  const runtime = witness ? replayLoadedRuntime(pid, before, cmdline, witness, reader) : null;
  return { pid, identity: before, cmdline, cgroup, executable,
    loadedModules: runtime ?? 'unmeasured' as const, unknown };
}

/** Never substitute disk filenames for executed bytes. Missing receipts,
 * unsupported readers/loaders, native mappings and process epochs fail closed. */
export function replayLoadedRuntime(pid: number, identity: string | null, cmdline: string[],
  witness: ReplayRuntimeWitness, reader: ReplayProcessReader = replayProcessReader) {
  const unknown: string[] = [];
  const receipts: Record<string, unknown>[] = [];
  const native: { path: string; sha256: string }[] = [];
  try {
    const text = reader.text(join(witness.directory, `${pid}.jsonl`));
    if (!text.endsWith('\n')) unknown.push('incomplete-runtime-receipt');
    for (const line of text.trim().split('\n')) receipts.push(JSON.parse(line));
  } catch (error) { unknown.push(`unreadable-runtime-receipts:${String(error)}`); }
  const bootstrap = receipts[0];
  const evalIndex = cmdline.indexOf('--eval');
  const evalSha256 = evalIndex < 0 ? null : replayHash(cmdline[evalIndex + 1] ?? '');
  // A descendant is not a second trusted root. Its literal eval bytes must be
  // authorized by a currently witnessed parent's launch and kernel ancestry,
  // recursively ending at the predeclared root command line.
  const anchored = (childPid: number, childIdentity: string | null, childCommand: string[],
    rows: Record<string, unknown>[], seen = new Set<number>()): boolean => {
    if (seen.has(childPid) || seen.size >= 64) return false;
    seen.add(childPid);
    const boot = rows[0];
    const index = childCommand.indexOf('--eval');
    const codeHash = index < 0 ? null : replayHash(childCommand[index + 1] ?? '');
    if (!childIdentity || !boot || boot.kind !== 'bootstrap' || boot.nodeOptions !== '' ||
        boot.pid !== childPid || boot.identity !== childIdentity || boot.runId !== witness.runId ||
        boot.evalSha256 !== codeHash || !codeHash) return false;
    if (!boot.parent) return witness.bootstraps[String(boot.entry)] === codeHash;
    try {
      const parent = boot.parent as { pid: number; identity: string; evalSha256: string; launchId: string };
      if (!Number.isSafeInteger(parent.pid) || reader.identity(parent.pid) !== parent.identity) return false;
      const parentText = reader.text(join(witness.directory, `${parent.pid}.jsonl`));
      if (!parentText.endsWith('\n')) return false;
      const parentRows: Record<string, unknown>[] = parentText.trim().split('\n').map(line => JSON.parse(line));
      const parentCommand = reader.text(`/proc/${parent.pid}/cmdline`).split('\0').filter(Boolean);
      if (parentRows[0]?.evalSha256 !== parent.evalSha256 ||
          !anchored(parent.pid, parent.identity, parentCommand, parentRows, seen) ||
          !parentRows.some(row => row.kind === 'ready') || parentRows.some(row => row.kind === 'unknown') ||
          parentRows.some(row => row.pid !== parent.pid || row.identity !== parent.identity || row.runId !== witness.runId ||
            row.schemaVersion !== 'lsp-replay-runtime-receipt-v1')) return false;
      const launches = parentRows.filter(row => row.kind === 'child-launch' && row.launchId === parent.launchId);
      const started = parentRows.filter(row => row.kind === 'child-started' && row.launchId === parent.launchId);
      if (launches.length !== 1 || started.length !== 1) return false;
      const launch = launches[0];
      const child = started[0];
      if (launch.entry !== boot.entry || launch.evalSha256 !== codeHash ||
          !Array.isArray(launch.nodeArgv) || JSON.stringify(launch.nodeArgv) !== JSON.stringify(childCommand.slice(1)) ||
          !Number.isSafeInteger(child.childPid) || typeof child.childIdentity !== 'string') return false;
      const ppid = (processPid: number) => {
        const stat = reader.text(`/proc/${processPid}/stat`);
        return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      };
      if (ppid(childPid) !== boot.ppid || reader.identity(Number(boot.ppid)) !== boot.parentIdentity) return false;
      if (launch.route !== 'systemd-scope')
        return ['spawn', 'fork'].includes(String(launch.route)) && child.childPid === childPid &&
          child.childIdentity === childIdentity && boot.ppid === parent.pid && boot.parentIdentity === parent.identity;
      // Scope launchers may exec the payload or retain a short intermediary
      // chain. A manager-parented service or reparented process fails closed.
      let current = childPid;
      const ancestors = new Set<number>();
      while (!ancestors.has(current) && ancestors.size < 16) {
        ancestors.add(current);
        if (current === child.childPid)
          return reader.identity(current) === child.childIdentity && ppid(current) === parent.pid;
        current = ppid(current);
        if (!Number.isSafeInteger(current) || current < 1 || current === parent.pid) break;
      }
      return false;
    } catch { return false; }
  };
  if (!bootstrap || bootstrap.kind !== 'bootstrap' || bootstrap.nodeOptions !== '' ||
      !evalSha256 || bootstrap.evalSha256 !== evalSha256 ||
      !anchored(pid, identity, cmdline, receipts)) unknown.push('unwitnessed-runtime-bootstrap');
  if (!receipts.some(row => row.kind === 'ready')) unknown.push('runtime-recorder-not-ready');
  const loads = receipts.filter(row => ['esm-load-return', 'commonjs-compile', 'json-load'].includes(String(row.kind)));
  const canonicalEntry = bootstrap?.entryCanonical ?? bootstrap?.entry;
  if (typeof canonicalEntry !== 'string' || typeof bootstrap?.entry !== 'string' ||
      !witness.files[bootstrap.entry] || witness.files[canonicalEntry] !== witness.files[bootstrap.entry])
    unknown.push('unfrozen-runtime-entry-alias');
  if (!loads.length || !loads.some(row => row.path === canonicalEntry)) unknown.push('runtime-entry-not-loaded');
  for (const launch of receipts.filter(row => row.kind === 'child-launch' && row.controlPurpose)) {
    try {
      if (launch.controlPurpose !== 'systemd-scope-availability' || launch.route !== 'systemd-scope' ||
          receipts.filter(row => row.kind === 'child-launch' && row.launchId === launch.launchId).length !== 1 ||
          JSON.stringify(launch.originalArgv) !== JSON.stringify(replayScopeProbeArgv) ||
          typeof launch.command !== 'string' || basename(launch.command) !== 'systemd-run' ||
          typeof launch.node !== 'string' || !witness.files[launch.node] || !Array.isArray(launch.nodeArgv) || launch.nodeArgv.length !== 2 ||
          launch.nodeArgv[0] !== '--eval' || typeof launch.nodeArgv[1] !== 'string' ||
          replayHash(launch.nodeArgv[1]) !== launch.evalSha256 ||
          JSON.stringify(launch.argv) !== JSON.stringify([...replayScopeProbeArgv.slice(0, -1), launch.node, ...launch.nodeArgv]))
        throw Error('unsupported control launch');
      const starts = receipts.filter(row => row.kind === 'child-started' && row.launchId === launch.launchId);
      const exits = receipts.filter(row => row.kind === 'control-exit' && row.launchId === launch.launchId);
      if (starts.length !== 1 || exits.length !== 1 || exits[0].code !== 0 || exits[0].signal !== null || exits[0].error ||
          !Number.isSafeInteger(starts[0].childPid) || typeof starts[0].childIdentity !== 'string')
        throw Error('control probe incomplete or failed');
      // Short-lived control children are qualified from their recorded kernel
      // ancestry and terminal result, never from a reused PID after exit.
      let matching = 0;
      for (const file of readdirSync(witness.directory).filter(file => /^\d+\.jsonl$/.test(file))) {
        const text = reader.text(join(witness.directory, file));
        if (!text.endsWith('\n')) continue;
        const rows: Record<string, unknown>[] = text.trim().split('\n').map(line => JSON.parse(line));
        const boot = rows[0];
        const parent = boot?.parent as Record<string, unknown> | undefined;
        if (!parent || parent.launchId !== launch.launchId || parent.pid !== pid) continue;
        matching++;
        const complete = rows.filter(row => row.kind === 'control-complete');
        if (boot.kind !== 'bootstrap' || boot.controlPurpose !== launch.controlPurpose || boot.nodeOptions !== '' ||
            boot.entry !== launch.entry || typeof complete[0]?.executableSha256 !== 'string' ||
            boot.evalSha256 !== launch.evalSha256 || parent.identity !== identity || parent.evalSha256 !== evalSha256 ||
            JSON.stringify(boot.execArgv) !== JSON.stringify(launch.nodeArgv) || complete.length !== 1 ||
            rows.length !== 2 || rows.some(row => row.schemaVersion !== 'lsp-replay-runtime-receipt-v1' ||
              row.pid !== boot.pid || row.identity !== boot.identity || row.runId !== witness.runId) ||
            complete[0].purpose !== launch.controlPurpose || complete[0].executableSha256 !== witness.files[launch.node])
          throw Error('unwitnessed control completion');
        const ancestry = complete[0].ancestry as { pid: number; identity: string; ppid: number }[];
        if (!Array.isArray(ancestry) || !ancestry.length || ancestry.length > 16 || ancestry[0].pid !== boot.pid ||
            ancestry[0].identity !== boot.identity || ancestry[0].ppid !== boot.ppid ||
            boot.parentIdentity !== (ancestry[1]?.identity ?? identity) ||
            ancestry.some((row, index) => !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid) ||
              typeof row.identity !== 'string' || row.ppid !== (ancestry[index + 1]?.pid ?? pid)) ||
            new Set(ancestry.map(row => row.pid)).size !== ancestry.length ||
            !ancestry.some(row => row.pid === starts[0].childPid && row.identity === starts[0].childIdentity))
          throw Error('unanchored control ancestry');
      }
      if (matching !== 1) throw Error('missing or ambiguous control receipt');
    } catch (error) { unknown.push(`unqualified-control-probe:${String(launch.launchId)}:${String(error)}`); }
  }
  // A repository-sized byte census can contain thousands of descriptors. Join
  // open/close proof once; scanning all receipts for each read is quadratic.
  type ReadBoundary = { row: Record<string, unknown>; index: number };
  const streamedReads = new Map<unknown, { starts: ReadBoundary[]; ends: ReadBoundary[] }>();
  receipts.forEach((row, index) => {
    if (row.kind !== 'file-read-start' && !(row.kind === 'file-read' && row.reader === 'readSync')) return;
    const group = streamedReads.get(row.readId) ?? { starts: [], ends: [] };
    (row.kind === 'file-read-start' ? group.starts : group.ends).push({ row, index });
    streamedReads.set(row.readId, group);
  });
  for (const [readId, { starts, ends }] of streamedReads) {
    const start = starts[0]; const end = ends[0];
    if (starts.length !== 1 || ends.length !== 1 || typeof readId !== 'string' || !readId ||
        typeof start.row.path !== 'string' || !Number.isSafeInteger(start.row.byteLength) ||
        Number(start.row.byteLength) < 0 || start.row.path !== end.row.path ||
        start.row.byteLength !== end.row.byteLength || start.row.reader !== 'readSync' ||
        end.row.reader !== 'readSync' || start.index >= end.index)
      unknown.push(`unclosed-or-unqualified-file-reader:readSync:${String(start?.row.path ?? end?.row.path)}`);
  }
  for (const row of receipts) {
    if (row.schemaVersion !== 'lsp-replay-runtime-receipt-v1' || row.pid !== pid || !identity ||
        row.identity !== identity || row.runId !== witness.runId) unknown.push('runtime-receipt-identity-mismatch');
    if (row.kind === 'unknown') unknown.push(String(row.reason));
    if (row.kind === 'file-read-start') continue;
    if (row.kind === 'kernel-metadata') {
      try {
        const path = String(row.path);
        const match = /^\/proc\/(self|[1-9]\d*)\/(?:(stat|cgroup)|task\/([1-9]\d*)\/(children))$/.exec(path);
        const subjectPid = match ? (match[1] === 'self' ? pid : Number(match[1])) : pid;
        const subjectIdentity = reader.identity(subjectPid);
        if ((!match && path !== '/proc/sys/kernel/random/boot_id') ||
            (match?.[3] && Number(match[3]) !== subjectPid) ||
            row.subjectPid !== subjectPid || !subjectIdentity || row.subjectIdentity !== subjectIdentity ||
            typeof row.text !== 'string' || replayHash(row.text) !== row.sha256)
          throw Error('metadata identity or bytes mismatch');
        if (match?.[2] === 'stat') {
          const current = reader.text(`/proc/${subjectPid}/stat`);
          const boot = reader.text('/proc/sys/kernel/random/boot_id');
          if (!row.text.startsWith(`${subjectPid} (`) || linuxProcessIdentityFromStat(boot, row.text) !== subjectIdentity ||
              linuxPpidFromProcStat(row.text) === null || linuxPpidFromProcStat(row.text) !== linuxPpidFromProcStat(current))
            throw Error('stat epoch or parent mismatch');
        } else if (reader.text(match?.[4] === 'children' ? `/proc/${subjectPid}/task/${subjectPid}/children` :
          match ? `/proc/${subjectPid}/cgroup` : path) !== row.text) {
          throw Error('kernel control input changed');
        }
        if (reader.identity(subjectPid) !== subjectIdentity) throw Error('process changed during metadata validation');
      } catch (error) { unknown.push(`unqualified-kernel-metadata:${String(row.path)}:${String(error)}`); }
      continue;
    }
    if (row.kind === 'commonjs-load-pending') {
      // A default load hook can defer the format decision until _compile.
      // Qualification requires that actual compile, with matching source
      // when nextLoad supplied it; a deferred receipt alone proves nothing.
      if (!loads.some(load => load.kind === 'commonjs-compile' && load.path === row.path &&
          (row.sha256 === null || row.sha256 === load.sha256)))
        unknown.push(`uncompleted-commonjs-load:${String(row.path)}`);
      if (typeof row.path !== 'string' || !witness.files[row.path] ||
          (row.sha256 !== null && witness.files[row.path] !== row.sha256))
        unknown.push(`unfrozen-loaded-bytes:${String(row.path)}`);
      continue;
    }
    if (['esm-load-return', 'commonjs-compile', 'json-load', 'file-read'].includes(String(row.kind))) {
      if (typeof row.path !== 'string' || witness.files[row.path] !== row.sha256)
        unknown.push(`unfrozen-loaded-bytes:${String(row.path)}`);
    } else if (row.kind === 'control-exit') {
      if (!receipts.some(launch => launch.kind === 'child-launch' && launch.launchId === row.launchId && launch.controlPurpose))
        unknown.push('orphan-control-exit');
    } else if (row.kind === 'child-stderr') {
      const launches = receipts.filter(launch => launch.kind === 'child-launch' && launch.launchId === row.launchId);
      const starts = receipts.filter(start => start.kind === 'child-started' && start.launchId === row.launchId);
      const diagnostics = receipts.filter(diagnostic => diagnostic.kind === 'child-stderr' && diagnostic.launchId === row.launchId);
      const terminals = receipts.filter(terminal => ['child-exit', 'child-error'].includes(String(terminal.kind)) &&
        terminal.launchId === row.launchId);
      const start = starts[0];
      const tail = typeof row.tailBase64 === 'string' ? Buffer.from(row.tailBase64, 'base64') : null;
      // Diagnostic integrity is separate from query success. Anchor to the
      // original launch/epoch and terminal event, including an empty stream.
      if (typeof row.launchId !== 'string' || launches.length !== 1 || launches[0].controlPurpose ||
          starts.length !== 1 || diagnostics.length !== 1 || terminals.length === 0 ||
          !Number.isSafeInteger(row.childPid) || Number(row.childPid) <= 0 ||
          typeof row.childIdentity !== 'string' || row.childIdentity.length === 0 ||
          row.childPid !== start?.childPid || row.childIdentity !== start?.childIdentity ||
          !Number.isFinite(start?.atMs) || Number(start?.atMs) <= 0 || !Number.isFinite(row.atMs) ||
          Number(row.atMs) < Number(start?.atMs) ||
          terminals.some(terminal => terminal.childPid !== row.childPid || terminal.childIdentity !== row.childIdentity ||
            !Number.isFinite(terminal.atMs) || Number(terminal.atMs) < Number(start?.atMs) || Number(terminal.atMs) > Number(row.atMs)) ||
          typeof row.piped !== 'boolean' || !Number.isSafeInteger(row.totalBytes) || Number(row.totalBytes) < 0 ||
          !tail || tail.toString('base64') !== row.tailBase64 || tail.length !== Math.min(Number(row.totalBytes), 8192) ||
          replayHash(tail) !== row.sha256 || (!row.piped && Number(row.totalBytes) !== 0))
        unknown.push('unqualified-child-stderr');
    } else if (row.kind === 'child-exit' || row.kind === 'child-error') {
      const launches = receipts.filter(launch => launch.kind === 'child-launch' && launch.launchId === row.launchId);
      const starts = receipts.filter(start => start.kind === 'child-started' && start.launchId === row.launchId);
      const exits = receipts.filter(exit => exit.kind === row.kind && exit.launchId === row.launchId);
      const start = starts[0];
      const validOutcome = row.kind === 'child-error' ? typeof row.error === 'string' && row.error.length > 0 :
        Number.isSafeInteger(row.childPid) && Number(row.childPid) > 0 && typeof row.childIdentity === 'string' &&
        row.childIdentity.length > 0 &&
        (row.code === null || (Number.isSafeInteger(row.code) && Number(row.code) >= 0)) &&
        (row.signal === null || (typeof row.signal === 'string' && /^SIG[A-Z0-9]+$/.test(row.signal))) &&
        ((row.code === null) !== (row.signal === null));
      if (typeof row.launchId !== 'string' || launches.length !== 1 || launches[0].controlPurpose ||
          starts.length !== 1 || exits.length !== 1 || row.childPid !== start?.childPid ||
          row.childIdentity !== start?.childIdentity || !Number.isFinite(row.atMs) ||
          !Number.isFinite(start?.atMs) || Number(start?.atMs) <= 0 || Number(row.atMs) < Number(start?.atMs) || !validOutcome)
        unknown.push('unqualified-child-terminal');
    } else if (!['bootstrap', 'ready', 'native-load', 'unknown', 'child-launch', 'child-started'].includes(String(row.kind))) unknown.push('unsupported-runtime-receipt');
  }
  // Kernel map_files names the mapped inode even after disk replacement/unlink.
  // Access failures are unknown; a later disk hash is never a fallback.
  try {
    const seen = new Set<string>();
    for (const line of reader.text(`/proc/${pid}/maps`).trim().split('\n')) {
      const match = /^(\S+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
      if (!match || !match[2].startsWith('/') || seen.has(match[2])) continue;
      const path = match[2]; seen.add(path);
      // maps pads low addresses, but map_files names use canonical hex. Keep
      // 64-bit addresses exact instead of rounding them through Number.
      const range = match[1].split('-').map(address => BigInt(`0x${address}`).toString(16)).join('-');
      const sha256 = replayHash(reader.bytes(`/proc/${pid}/map_files/${range}`));
      native.push({ path, sha256 });
      if (witness.files[path] !== sha256) unknown.push(`unfrozen-native-mapping:${path}`);
    }
    for (const row of receipts.filter(row => row.kind === 'native-load'))
      if (!native.some(mapping => mapping.path === row.path)) unknown.push(`unwitnessed-native-load:${String(row.path)}`);
    if (!native.length) unknown.push('empty-native-mapping-census');
  } catch (error) { unknown.push(`unreadable-native-mappings:${String(error)}`); }
  if (reader.identity(pid) !== identity) unknown.push('process-replaced-during-runtime-witness');
  return { receipts, native, unknown: [...new Set(unknown)] };
}

/** Reuse the managed cgroup walk, retaining unreadable branches as unknown. */
export function replayServerPopulation(pid: number, taskId: string, deps: {
  process?: ReplayProcessReader; fs?: CgroupFs; witness?: ReplayRuntimeWitness;
} = {}) {
  const processReader = deps.process ?? replayProcessReader;
  const root = replayProcessIdentity(pid, processReader, deps.witness);
  const unknown = [...root.unknown];
  const cgroup = root.cgroup ? parseProcCgroup(root.cgroup) : null;
  if (!cgroup || taskIdFromScopeUnit(basename(cgroup)) !== taskId)
    unknown.push('server-task-cgroup-mismatch');
  const absolute = cgroup ? absCgroupDir(cgroup) : null;
  const checked = <T>(path: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (error) { unknown.push(`unreadable-cgroup:${path}:${String(error)}`); return fallback; }
  };
  const rawFs: CgroupFs = deps.fs ?? {
    readFile: path => readFileSync(path, 'utf8'),
    readDir: path => readdirSync(path),
    isDir: path => statSync(path).isDirectory(),
  };
  const fs: CgroupFs = {
    readFile: path => {
      const value = checked(path, () => rawFs.readFile(path), null);
      if (value === null) unknown.push(`unreadable-cgroup:${path}`);
      return value;
    },
    readDir: path => checked(path, () => rawFs.readDir(path), [] as string[]),
    isDir: path => {
      const directory = checked(path, () => rawFs.isDir(path), false);
      if (directory && absolute && relative(absolute, path).split('/').filter(Boolean).length > 32) {
        unknown.push(`cgroup-depth-unmeasured:${path}`);
        return false;
      }
      return directory;
    },
  };
  // Do not census a broad foreign service cgroup when task provenance failed.
  const groups = absolute && !unknown.length ? walkCgroupTree(absolute, fs) : [];
  const pids = [...new Set(groups.flatMap(group => group.pids))].sort((a, b) => a - b);
  if (!pids.includes(pid)) unknown.push('server-missing-from-cgroup-census');
  const processes = pids.map(child => child === pid ? root : replayProcessIdentity(child, processReader, deps.witness));
  for (const child of processes) {
    unknown.push(...child.unknown.map(reason => `pid:${child.pid}:${reason}`));
    const childGroup = child.cgroup ? parseProcCgroup(child.cgroup) : null;
    if (!childGroup || !cgroup || (childGroup !== cgroup && !childGroup.startsWith(`${cgroup}/`)))
      unknown.push(`process-outside-server-cgroup:${child.pid}`);
  }
  for (const child of processes) if (processReader.identity(child.pid) !== child.identity)
    unknown.push(`process-replaced-during-census:${child.pid}`);
  const finalPids = absolute && cgroup && taskIdFromScopeUnit(basename(cgroup)) === taskId
    ? [...new Set(walkCgroupTree(absolute, fs).flatMap(group => group.pids))].sort((a, b) => a - b) : [];
  if (JSON.stringify(finalPids) !== JSON.stringify(pids)) unknown.push('cgroup-population-changed-during-census');
  return { taskId, rootPid: pid, cgroup, groups, processes, unknown: [...new Set(unknown)] };
}

export function replayPopulationFingerprint(population: ReturnType<typeof replayServerPopulation>) {
  return replayHash(JSON.stringify(population.processes.map(row => ({ pid: row.pid, identity: row.identity,
    cgroup: row.cgroup, cmdline: row.cmdline, executable: row.executable }))));
}

export function replayDurableReport(report: ReplayReport, oracles: Readonly<Record<ReplayClass, ReplayOracle>>): ReplayReport {
  const samples = report.samples.map(sample => {
    const events = (sample.answer as LspDaemonAnswer | null)?.daemonEvidence?.events ?? [];
    const terminal = Math.max(...events.filter(event => event.phase === 'durable-settled' && event.confirmed === true).map(event => event.atMs));
    return { ...sample, clientSettledAtMs: sample.settledAtMs,
      settledAtMs: Number.isFinite(terminal) ? terminal : sample.settledAtMs };
  });
  return scoreReplay(report.concurrency, report.mode, report.population, samples, oracles);
}

interface ReplayRuntimePopulation {
  processes: ReturnType<typeof replayProcessIdentity>[];
  populations: ReturnType<typeof replayServerPopulation>[];
}
export interface ReplayBoundary extends ReplayRuntimePopulation {
  label: string;
  atMs: number;
  health: LspDaemonAnswer;
  admission: Pick<Awaited<ReturnType<typeof readLspDaemonAdmission>>, 'queued' | 'inFlight' | 'settlementFailures'>;
  fileDrift: string[];
}
/** The same loaded-byte and settlement checks govern admission to load and
 * qualification afterward. A healthy RPC alone cannot qualify a runtime. */
export function replayBoundaryProblems(snapshot: ReplayBoundary, config: DaemonReplayConfig): string[] {
  const problems = [...snapshot.fileDrift];
  const runtime = snapshot.health.daemonRuntime;
  if (snapshot.health.error !== null || !runtime?.enabled ||
      !snapshot.processes.some(process => process.pid === runtime.pid) ||
      snapshot.processes.some(process => process.unknown.length || !process.cgroup))
    problems.push('unqualified-runtime-or-process');
  if (snapshot.populations.length !== 1 || snapshot.populations.some(population => population.unknown.length))
    problems.push('unqualified-server-descendant-population');
  for (const process of [...snapshot.processes, ...snapshot.populations.flatMap(population => population.processes)]) {
    if (!process.executable || config.files[process.executable.path] !== process.executable.sha256)
      problems.push(`unfrozen-running-executable:${process.pid}`);
    if (process.loadedModules === 'unmeasured') problems.push(`unqualified-loaded-module-population:${process.pid}`);
    else problems.push(...process.loadedModules.unknown.map(reason => `runtime:${process.pid}:${reason}`));
  }
  const servers = runtime?.servers.filter(server => resolve(server.rootPath) === resolve(config.rootPath));
  if (!servers || servers.length !== 1 || servers[0].health !== 'healthy' || !servers[0].taskId || !servers[0].pid)
    problems.push('unqualified-warm-server-population');
  for (const server of servers ?? []) {
    const process = snapshot.processes.find(process => process.pid === server.pid);
    const unit = process?.cgroup?.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!unit || taskIdFromScopeUnit(basename(unit)) !== server.taskId) problems.push('unqualified-server-task-cgroup');
    if (!snapshot.populations.some(population => population.taskId === server.taskId && population.rootPid === server.pid &&
        population.processes.some(process => process.pid === server.pid)))
      problems.push('unmatched-server-descendant-population');
  }
  if (snapshot.admission.queued || snapshot.admission.inFlight || snapshot.admission.settlementFailures.length)
    problems.push('unsettled-boundary');
  return [...new Set(problems)];
}

/** Archive is append-only and exclusively created; no prior evidence is overwritten. */
export async function runDaemonReplay(config: DaemonReplayConfig, archiveParent: string, deps: {
  captureRuntime?: (health: LspDaemonAnswer) => ReplayRuntimePopulation;
} = {}) {
  validateDaemonReplayConfig(config);
  // Small source-authored protocol controls retain their existing route. The
  // independent repository-copy acceptance route requires loaded oracle proof.
  if (config.sourceSnapshot) assertReplayOracleRuntimeQualified(config);
  const semanticCompletion = config.sourceSnapshot || config.semanticCompletionPlugin
    ? replaySemanticCompletionContext(config) : undefined;
  // Compiler-only freezing must not initialize daemon/task-store dependencies.
  const { callLspDaemonRpc, readLspDaemonAdmission } = await import('./lsp-daemon-client');
  const { lspEvidenceNow } = await import('./lsp-query-evidence');
  const directory = join(archiveParent, config.runId);
  if (existsSync(directory)) throw new Error(`archive already exists:${directory}`);
  mkdirSync(directory, { recursive: true });
  const configFingerprint = replayHash(JSON.stringify(config));
  const record = (name: string, value: unknown) => appendFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ configFingerprint, config }, null, 2), { flag: 'wx' });
  const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
  process.env[LSP_DAEMON_SOCKET_ENV] = config.socketPath;
  const query = (queryClass: ReplayClass, id: string, actorId: string) => callLspDaemonRpc(config.socketPath, {
    op: queryClass === 'definition' ? 'symbol' : 'references', workspaceId: config.workspaceId,
    args: { ...config.corpus[queryClass].cursor,
      file: resolve(config.rootPath, config.corpus[queryClass].cursor.file), rootPath: config.rootPath }, actorId, archive: true,
    deadlineAtMs: Date.now() + config.requestTimeoutMs,
    ...(semanticCompletion ? { semanticCompletion } : {}),
  }, config.requestTimeoutMs + 5_000, id);
  const boundary = async (label: string) => {
    const health = await callLspDaemonRpc(config.socketPath, { op: 'health', args: {}, archive: true,
      workspaceId: config.workspaceId }, 10_000, `${config.runId}/${label}`);
    const admission = await readLspDaemonAdmission(config.workspaceId);
    const runtime = health.daemonRuntime;
    const { processes, populations } = deps.captureRuntime ? deps.captureRuntime(health) : {
      processes: runtime ? [runtime.pid, ...runtime.servers.flatMap(server => server.pid ? [server.pid] : [])]
        .map(pid => replayProcessIdentity(pid, replayProcessReader, config.runtimeWitness)) : [],
      populations: runtime?.servers.filter(server => resolve(server.rootPath) === resolve(config.rootPath))
        .flatMap(server => server.pid && server.taskId ? [replayServerPopulation(server.pid, server.taskId, { witness: config.runtimeWitness })] : []) ?? [],
    };
    const snapshot = { label, atMs: Date.now(), health, admission, processes, populations,
      fileDrift: replayFileMismatches({ ...config.files, ...config.runtimeWitness?.files }) };
    record('boundaries.jsonl', snapshot);
    return snapshot;
  };
  const oracles = { definition: config.corpus.definition.oracle, 'hot-references': config.corpus['hot-references'].oracle };
  const triplets: ReplayTriplet[] = [];
  try {
    // Warm both intents independently; warmups remain visible but outside measured populations.
    const readinessProblems: string[] = [];
    for (const queryClass of REPLAY_CLASSES) {
      const answer = await query(queryClass, `${config.runId}/warm/${queryClass}`, 'warmup');
      const classification = classifyReplayAnswer(answer, oracles[queryClass]);
      record('warmups.jsonl', { queryClass, answer, classification });
      if (!classification.usefulCorrect) readinessProblems.push(...classification.reasons.map(reason => `${queryClass}:${reason}`));
    }
    record('preflights.jsonl', { phase: 'readiness', ready: readinessProblems.length === 0, reasons: readinessProblems });
    if (readinessProblems.length) throw new Error(`replay-readiness-refused:${readinessProblems.join(';')}`);
    for (const concurrency of config.levels) for (let trial = 0; trial < 3; trial += 1) {
      const trialId = `${config.runId}/c${concurrency}/t${trial}`;
      const start = await boundary(`c${concurrency}/t${trial}/start`);
      const startProblems = replayBoundaryProblems(start, config);
      record('preflights.jsonl', { phase: 'runtime', trialId, ready: startProblems.length === 0, reasons: startProblems });
      if (startProblems.length) throw new Error(`replay-start-boundary-refused:${startProblems.join(';')}`);
      const modes: ReplayMode[] = trial === 1 ? ['mixed', 'hot-references', 'definition'] : ['definition', 'hot-references', 'mixed'];
      const reports = new Map<ReplayMode, ReplayReport>();
      const problems: string[] = [];
      for (const mode of modes) {
        const report = replayDurableReport(await runReplay({ concurrency, mode, runId: `${trialId}/${mode}`, oracles,
          now: lspEvidenceNow, execute: request => query(request.queryClass, request.id, request.actorId) }), oracles);
        // Preserve every raw answer/ID/timestamp before scoring or inspecting qualification.
        record('runs.jsonl', report);
        reports.set(mode, report);
        problems.push(...replayEvidenceProblems(report));
        record('progress.jsonl', { trialId, mode, concurrency, complete: report.complete, classes: report.classes,
          failures: report.failures.length, certifiedFalseEmpty: report.certifiedFalseEmpty, certifiedStale: report.certifiedStale });
      }
      const end = await boundary(`c${concurrency}/t${trial}/end`);
      problems.push(...replayBoundaryProblems(end, config));
      if (JSON.stringify(start.health.daemonRuntime?.servers.map(server => [server.taskId, server.pid])) !==
          JSON.stringify(end.health.daemonRuntime?.servers.map(server => [server.taskId, server.pid]))) problems.push('changed-server-population');
      // Read receipts grow as new inputs are consumed; compare immutable process
      // identity separately and validate both complete receipt boundaries above.
      const identities = (rows: typeof start.processes) => rows.map(({ loadedModules: _loaded, ...row }) => row);
      if (JSON.stringify(identities(start.processes)) !== JSON.stringify(identities(end.processes)) ||
          JSON.stringify(start.populations.map(replayPopulationFingerprint)) !== JSON.stringify(end.populations.map(replayPopulationFingerprint)))
        problems.push('changed-runtime-process-identity');
      const mixed = reports.get('mixed')!;
      if (concurrency > 1 && !replayWireOverlap(mixed)) problems.push('no-measured-expensive-wire-overlap');
      const triplet: ReplayTriplet = { trialId, definition: reports.get('definition')!, references: reports.get('hot-references')!, mixed,
        qualification: { qualified: problems.length === 0, fingerprint: configFingerprint, reasons: [...new Set(problems)] } };
      triplets.push(triplet);
      record('triplets.jsonl', { trialId, qualification: triplet.qualification });
    }
    const result = evaluateReplayLadder(triplets, config.levels);
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ configFingerprint, result }, null, 2), { flag: 'wx' });
    return { directory, configFingerprint, result };
  } catch (error) {
    record('errors.jsonl', { atMs: Date.now(), error: String(error) });
    throw error;
  } finally {
    if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
    else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
  }
}
