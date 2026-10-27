/** Host-only build stage; a generated-input receipt is never runtime admission. */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { verifierSourceFiles, type VerifierSourceFile } from '@papercusp/test-config/verifier-source';
import { captureVerifierDependencies, runVerifierDependencyCommand, verifyVerifierSource,
  type prepareVerifierSource } from '../../../scripts/source-preview.mjs';
import { captureRuntimeTools, type RuntimeToolSources } from './blind-review-runtime-tools';
import { buildRuntimeDesktop, type RuntimeDesktopToolchain } from './blind-review-runtime-desktop';

type Source = Awaited<ReturnType<typeof prepareVerifierSource>>;
type Dependencies = ReturnType<typeof captureVerifierDependencies>;
export type RuntimeGeneratedInputs = Readonly<{
  version: 1; sourceReceiptSha256: string; dependenciesSha256: string;
  files: readonly Readonly<VerifierSourceFile>[];
}>;
const produced = new WeakSet<object>();
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A failed process-group fence reserves its inputs for reconciliation. */
export function runtimeInputsMustBeRetained(error: unknown, seen = new Set<object>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const failure = error as { retainVerifierTree?: unknown; cause?: unknown; errors?: unknown };
  return failure.retainVerifierTree === true || runtimeInputsMustBeRetained(failure.cause, seen) ||
    (Array.isArray(failure.errors) && failure.errors.some(item => runtimeInputsMustBeRetained(item, seen)));
}
const DIRECTORIES = ['apps/operator/dist-verify',
  'apps/operator/public/wake-runtime', 'apps/operator/public/vad-runtime',
  'apps/operator/public/vditor', 'apps/operator/public/vditor-local',
  'apps/operator/public/monaco', 'apps/operator/public/excalidraw',
  'apps/operator/public/porcupine', 'apps/operator/public/elevenlabs-runtime'];
const FILES = ['apps/operator-vite/src/routeTree.gen.ts',
  'apps/operator/public/silero_vad_v5.onnx', 'apps/operator/public/silero_vad_legacy.onnx',
  'apps/operator/public/vad.worklet.bundle.min.js'];

async function census(root: string, source: Source): Promise<VerifierSourceFile[]> {
  const includedPaths = new Set<string>();
  const include = (path: string) => {
    const parts = path.split('/');
    for (let end = 1; end <= parts.length; end++) includedPaths.add(parts.slice(0, end).join('/'));
  };
  async function visit(path: string, optional = false): Promise<void> {
    const info = await lstat(join(root, path)).catch(error => {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return;
    // Generated files must be independent bytes, never redirects into a donor.
    if (!info.isDirectory() && !info.isFile()) throw new Error('broker_generated_input_redirect');
    include(path);
    if (info.isDirectory()) for (const name of await readdir(join(root, path))) await visit(path + '/' + name);
  }
  for (const path of [...DIRECTORIES, ...FILES]) await visit(path, true);
  for (const name of await readdir(join(root, 'apps/operator/public')))
    if (/^ort-wasm-[^/]+\.(?:wasm|mjs)$/.test(name)) await visit('apps/operator/public/' + name);
  const recorded = new Set(source.files.map(file => file.path));
  const rows = verifierSourceFiles(root, { includedPaths, symlinkRoot: root }).filter(file => !recorded.has(file.path));
  const paths = new Set(rows.map(file => file.path));
  for (const path of ['apps/operator/dist-verify/hono-host.mjs', 'apps/operator/dist-verify/spa/index.html'])
    if (!paths.has(path) || !(await lstat(join(root, path))).size)
      throw new Error('broker_generated_build_incomplete:' + path);
  if (!rows.some(file => file.path.startsWith('apps/operator/dist-verify/spa/assets/')))
    throw new Error('broker_generated_build_incomplete:apps/operator/dist-verify/spa/assets/');
  return rows;
}

export class RuntimeBuildDependencyDrift extends Error {
  readonly retainVerifierTree = true;
  constructor(readonly stage: string, readonly changes: readonly string[]) {
    super('broker_build_dependencies_changed');
    this.name = 'RuntimeBuildDependencyDrift';
  }
}

async function verifyInputs(root: string, source: Source, dependencies: Dependencies, stage = 'closure'): Promise<void> {
  await verifyVerifierSource(root, source, { runtimeArtifacts: true });
  const current = captureVerifierDependencies({ dest: root, receipt: source });
  if (!isDeepStrictEqual(current, dependencies)) {
    const flatten = (receipt: Dependencies) => new Map(receipt.trees.flatMap(tree => tree.files.map(file =>
      [tree.path + '/' + file.path, file] as const)));
    const prior = flatten(dependencies), after = flatten(current);
    const changes = [...new Set([...prior.keys(), ...after.keys()])].sort()
      .filter(path => !isDeepStrictEqual(prior.get(path), after.get(path)));
    // A refusal without its differing population used to discard the only
    // evidence and force another whole native build just to diagnose it.
    throw new RuntimeBuildDependencyDrift(stage, Object.freeze(changes.slice(0, 100)));
  }
}

/** Re-census before copying; JSON-shaped or cross-build receipts cannot qualify outputs. */
export async function verifyRuntimeGeneratedInputs(root: string, source: Source, dependencies: Dependencies,
  receipt: RuntimeGeneratedInputs): Promise<void> {
  if (!produced.has(receipt) || receipt.sourceReceiptSha256 !== sha(source) ||
      receipt.dependenciesSha256 !== sha(dependencies)) throw new Error('broker_generated_provenance_invalid');
  await verifyInputs(root, source, dependencies);
  if (!isDeepStrictEqual(await census(root, source), receipt.files)) throw new Error('broker_generated_inputs_changed');
}

/** Fixed maintained build commands. No reviewer argv, environment or output selector. */
export async function buildRuntimeGeneratedInputs(options: {
  root: string; repositoryRoot: string; custodyRoot: string; source: Source; dependencies: Dependencies;
  signal?: AbortSignal;
  /** Host-only full runtime preparation; low-level build fixtures may omit it. */
  runtimeTools?: RuntimeToolSources;
  /** Production includes a desktop; fixtures may supply a tiny toolchain. */
  nativeDesktop?: { toolchain?: RuntimeDesktopToolchain };
}): Promise<RuntimeGeneratedInputs> {
  const { source, dependencies, signal } = options;
  signal?.throwIfAborted();
  const root = await realpath(options.root);
  await verifyInputs(root, source, dependencies);
  // Never adopt pre-existing generated output as evidence of this invocation.
  for (const path of DIRECTORIES) {
    const info = await lstat(join(root, path)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && !source.files.some(file => file.path.startsWith(path + '/')))
      throw new Error('broker_generated_output_already_exists');
  }
  const work = await mkdtemp(join(await realpath(options.custodyRoot), 'broker-build-'));
  await chmod(work, 0o700);
  let retain = false;
  try {
    const home = join(work, 'home'); await mkdir(home);
    const temporary = join(work, 'tmp'); await mkdir(temporary);
    const receiptPath = join(work, 'source.json');
    await writeFile(receiptPath, JSON.stringify(source), { flag: 'wx', mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PATH: dirname(process.execPath) + ':/usr/bin:/bin',
      HOME: home, TMPDIR: temporary, LANG: 'C.UTF-8', NODE_OPTIONS: '', NODE_PATH: '',
      VERIFY_TAURI_SOURCE_REF: source.sourceCommit, VERIFY_TAURI_SOURCE_RECEIPT: receiptPath,
      VITE_BUILD_OUT_ROOT: join(work, 'spa-build'),
      VITE_BUILD_LOG: join(work, 'spa-build.log'), PAPERCUSP_RETAIN_DIST_CHUNKS: '0' };
    const run = (args: string[]) => runVerifierDependencyCommand('/bin/bash', args,
      { cwd: root, env, signal });
    await run(['apps/operator/scripts/setup-porcupine-runtime.sh', '--source',
      join(await realpath(options.repositoryRoot), 'apps/operator/public/porcupine/porcupine_params.pv')]);
    await run(['scripts/pc-heavy.sh', '--', 'npm', '--workspace', '@papercusp/operator-vite', 'run', 'prebuild']);
    await verifyInputs(root, source, dependencies, 'prebuild');
    await run(['scripts/pc-heavy.sh', '--', 'npm', '--ignore-scripts', '--workspace', '@papercusp/operator-vite', 'run', 'build']);
    // The maintained singleflight wrapper owns its staged output variables and
    // publishes <VITE_BUILD_OUT_ROOT>/dist. Copy only that completed tree into
    // the measured closure; private markers and build logs stay outside it.
    await cp(join(work, 'spa-build/dist'), join(root, 'apps/operator/dist-verify/spa'),
      { recursive: true, force: false, errorOnExist: true });
    await verifyInputs(root, source, dependencies, 'spa');
    await run(['apps/operator/bin/bundle-host.sh', 'bin/hono-host.ts',
      join(root, 'apps/operator/dist-verify/hono-host.mjs')]);
    await verifyInputs(root, source, dependencies, 'host');
    if (options.nativeDesktop) await buildRuntimeDesktop({ root, work, sourceCommit: source.sourceCommit,
      env, signal, toolchain: options.nativeDesktop.toolchain });
    if (options.runtimeTools) await captureRuntimeTools(join(root, 'apps/operator/dist-verify/runtime'),
      options.runtimeTools, signal);
    await verifyInputs(root, source, dependencies, 'runtime-tools');
    const files = (await census(root, source)).map(file => Object.freeze(file));
    const receipt = Object.freeze({ version: 1 as const, sourceReceiptSha256: sha(source),
      dependenciesSha256: sha(dependencies), files: Object.freeze(files) });
    produced.add(receipt);
    return receipt;
  } catch (error) {
    retain = runtimeInputsMustBeRetained(error);
    throw error;
  } finally { if (!retain) await rm(work, { recursive: true, force: true }); }
}
