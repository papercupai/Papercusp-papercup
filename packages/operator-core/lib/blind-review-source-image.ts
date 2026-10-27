/** Host-only producer. Reviewer tool arguments must never select these paths or refs. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, stat, symlink, writeFile,
  type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gzipSync } from 'node:zlib';
import { verifierSourceFiles, type VerifierSourceFile } from '@papercusp/test-config/verifier-source';
import { captureVerifierDependencies, prepareVerifierDependencies, prepareVerifierSource, runVerifierDependencyCommand,
  verifyVerifierSource } from '../../../scripts/source-preview.mjs';
import { buildRuntimeGeneratedInputs, verifyRuntimeGeneratedInputs,
  runtimeInputsMustBeRetained, type RuntimeGeneratedInputs } from './blind-review-generated-inputs';
import { sealRuntimeSourceHandle } from './blind-review-source-seal';

type SourceReceipt = Awaited<ReturnType<typeof prepareVerifierSource>>;
type DependencyReceipt = ReturnType<typeof captureVerifierDependencies>;
export const BROKER_CLOSURE_MANIFEST = '.broker-closure.json.gz';
const DEPENDENCIES = '.broker-dependencies.json';
const SOURCE_RECEIPT = '.verifier-source.json';
const BUILD_RECEIPT = '.broker-build.json';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
// Must agree with verify_manifest in blind-review-sealed-source.py. Refuse
// before copying inputs rather than discover an inadmissible closure at boot.
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_MANIFEST_BYTES = 128 * 1024 * 1024;
export function encodeRuntimeClosureManifest(manifest: {
  version: 1; sourceCommit: string; sourceReceiptSha256: string;
  dependenciesReceiptSha256: string; files: VerifierSourceFile[];
}): Buffer {
  requireValue(manifest.files.length > 0 && manifest.files.length <= 500_000,
    'broker_manifest_population_invalid');
  const bytes = Buffer.from(JSON.stringify(manifest));
  requireValue(bytes.length <= MAX_DECODED_MANIFEST_BYTES, 'broker_manifest_size_invalid');
  const encoded = gzipSync(bytes, { level: 1 });
  requireValue(encoded.length <= MAX_MANIFEST_BYTES, 'broker_manifest_size_invalid');
  return encoded;
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const preparedOrigins = new WeakMap<RuntimeSourceImage, {
  repositoryRoot: string; sourceReceiptSha256: string; generatedSha256: string;
}>();
/** Host-only provenance, absent for low-level or reconstructed image objects. */
export function runtimeSourceImageOrigin(image: RuntimeSourceImage) {
  const origin = preparedOrigins.get(image);
  requireValue(origin, 'broker_source_origin_unavailable');
  return origin;
}
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
export type RuntimeSourceImage = {
  /** Remains open after its pathname and every mutable preparation tree are removed. */
  handle: FileHandle;
  sourceImageNonce: string;
  sourceCommit: string;
  sourceTreeHash: string;
  sourceInputsHash: string;
  imageSha256: string;
  imageBytes: number;
  manifestSha256: string;
};

function population(source: SourceReceipt, dependencies: DependencyReceipt,
  generated?: RuntimeGeneratedInputs): VerifierSourceFile[] {
  const rows = [...source.files, ...dependencies.trees.flatMap(tree => tree.files.map(file =>
    ({ ...file, path: tree.path + '/' + file.path }))), ...(generated?.files ?? [])];
  const seen = new Map<string, VerifierSourceFile>();
  for (const row of rows) {
    requireValue(row.path && !row.path.includes('\\') && !row.path.includes('\0') &&
      !row.path.split('/').some(part => !part || part === '.' || part === '..') &&
      ![SOURCE_RECEIPT, DEPENDENCIES, BUILD_RECEIPT, BROKER_CLOSURE_MANIFEST, '.broker-closure.json'].includes(row.path) &&
      !seen.has(row.path) && ['file', 'symlink'].includes(row.kind) &&
      typeof row.executable === 'boolean' && /^[a-f0-9]{64}$/.test(row.sha256), 'invalid_closure_population');
    seen.set(row.path, row);
  }
  // Never create a destination file through an earlier symlink or file entry.
  for (const row of rows) {
    const parts = row.path.split('/');
    for (let end = 1; end < parts.length; end++)
      requireValue(!seen.has(parts.slice(0, end).join('/')), 'closure_path_collision');
  }
  requireValue(rows.length > 0 && rows.length <= 499_998, 'invalid_closure_population');
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export class RuntimeSourcePackFailure extends Error {
  retainVerifierTree = false;
  retainedInputRoot: string | null = null;
  constructor(readonly diagnostics: {
    exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
    aborted: boolean; elapsedMs: number; stderrTail: string; spawnErrorCode: string | null;
  }) {
    super('source_image_pack_failed:' + JSON.stringify({ ...diagnostics, stderrTail: undefined }));
    this.name = 'RuntimeSourcePackFailure';
  }
}

/** Host-only stage entry for focused verification; never a reviewer command surface. */
export async function packRuntimeSourceClosure(root: string, image: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolvePack, reject) => {
    const started = performance.now();
    let stderr = Buffer.alloc(0), timedOut = false, spawnErrorCode: string | null = null;
    // The executable is host-selected; a shell, ambient startup options and
    // donor executables are not part of image creation.
    const child = spawn('/usr/bin/mksquashfs', [root, image, '-noappend', '-no-progress',
      '-processors', '4', '-all-root', '-all-time', '0', '-mkfs-time', '0', '-no-xattrs',
      '-comp', 'zstd', '-Xcompression-level', '9', '-b', '1M'],
    { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'pipe'], signal });
    // An explicit deadline distinguishes the host's cutoff from a compressor
    // failure. Kill the single compressor process rather than waiting forever
    // for a child which ignores SIGTERM; no input cleanup runs before close.
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    child.stderr!.on('data', (bytes: Buffer) => {
      stderr = Buffer.concat([stderr, bytes]).subarray(-8192);
    });
    child.once('error', (error: NodeJS.ErrnoException) => { spawnErrorCode = error.code ?? error.name; });
    child.once('close', (exitCode, terminationSignal) => {
      clearTimeout(timer);
      if (exitCode === 0 && !timedOut && !spawnErrorCode && !signal?.aborted) resolvePack();
      else reject(new RuntimeSourcePackFailure({ exitCode, signal: terminationSignal,
        timedOut, aborted: signal?.aborted === true, elapsedMs: Math.round(performance.now() - started),
        stderrTail: stderr.toString('utf8'), spawnErrorCode }));
    });
  });
}

/**
 * Re-measure the existing verifier contracts, copy ONLY their recorded bytes,
 * and publish an open image handle. Packing may race a donor mutation; the
 * kernel helper's census of the sealed image is still mandatory before admission.
 * This function alone NEVER returns censusStatus:admit or writes a lease receipt.
 * The caller must have persisted workspace/resource intent before invoking it.
 */
export async function packRuntimeSourceImage(options: {
  root: string; custodyRoot: string; source: SourceReceipt; dependencies: DependencyReceipt; signal?: AbortSignal;
  generated?: RuntimeGeneratedInputs;
  repositoryRoot?: string;
}): Promise<RuntimeSourceImage> {
  const { source, dependencies, signal, generated } = options;
  signal?.throwIfAborted();
  const root = await realpath(options.root);
  requireValue((!source.gitCheckout || generated) && !source.operatorApiInputs && /^[a-f0-9]{40,64}$/.test(source.sourceCommit),
    'unsupported_broker_source_receipt');
  await verifyVerifierSource(root, source, { runtimeArtifacts: true });
  requireValue(isDeepStrictEqual(captureVerifierDependencies({ dest: root, receipt: source }), dependencies),
    'broker_dependencies_changed');
  if (generated) await verifyRuntimeGeneratedInputs(root, source, dependencies, generated);
  const rows = population(source, dependencies, generated);
  const sourceBytes = await readFile(join(root, SOURCE_RECEIPT));
  requireValue(isDeepStrictEqual(JSON.parse(sourceBytes.toString()), source), 'broker_source_receipt_changed');
  const sourceReceiptSha256 = digest(JSON.stringify(source));
  requireValue(dependencies.sourceReceiptSha256 === sourceReceiptSha256 && dependencies.root === root &&
    dependencies.sourceCommit === source.sourceCommit, 'broker_receipts_disagree');
  // The runtime needs measured input bytes, never the host's private path names.
  const dependencyBytes = Buffer.from(JSON.stringify({ ...dependencies, root: '/source' }) + '\n');
  const dependenciesReceiptSha256 = digest(dependencyBytes);
  const buildBytes = generated ? Buffer.from(JSON.stringify(generated) + '\n') : undefined;
  const files = [...rows,
    { path: SOURCE_RECEIPT, kind: 'file' as const, executable: false, sha256: digest(sourceBytes) },
    { path: DEPENDENCIES, kind: 'file' as const, executable: false, sha256: dependenciesReceiptSha256 },
    ...(buildBytes ? [{ path: BUILD_RECEIPT, kind: 'file' as const, executable: false, sha256: digest(buildBytes) }] : []),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const manifestBytes = encodeRuntimeClosureManifest({ version: 1, sourceCommit: source.sourceCommit,
    sourceReceiptSha256, dependenciesReceiptSha256, files });
  const manifestSha256 = digest(manifestBytes);
  const owned = await mkdtemp(join(await realpath(options.custodyRoot), 'broker-source-'));
  await chmod(owned, 0o700);
  let handle: FileHandle | undefined;
  try {
    const closure = join(owned, 'closure');
    await mkdir(closure, { mode: 0o700 });
    let inputBytes = 0;
    const privateCopies = new Map<string, string>();
    for (const row of rows) {
      signal?.throwIfAborted();
      const from = join(root, row.path), to = join(closure, row.path);
      await mkdir(dirname(to), { recursive: true });
      const info = await lstat(from);
      inputBytes += info.size;
      requireValue((row.kind === 'symlink' ? info.isSymbolicLink() : info.isFile()) &&
        Boolean(info.mode & 0o111) === row.executable, 'broker_input_type_changed');
      if (row.kind === 'symlink') await symlink(await readlink(from), to);
      else {
        // Only identical bytes AND mode may share a private inode. Never link
        // to a donor/generation; the full private census below still measures
        // every recorded path before the sealed image can be admitted.
        const key = row.sha256 + ':' + row.executable;
        const copied = privateCopies.get(key);
        if (copied) await link(copied, to);
        else {
          await copyFile(from, to, constants.COPYFILE_EXCL);
          await chmod(to, row.executable ? 0o755 : 0o644);
          privateCopies.set(key, to);
        }
      }
    }
    await writeFile(join(closure, SOURCE_RECEIPT), sourceBytes, { flag: 'wx', mode: 0o644 });
    await writeFile(join(closure, DEPENDENCIES), dependencyBytes, { flag: 'wx', mode: 0o644 });
    if (buildBytes) await writeFile(join(closure, BUILD_RECEIPT), buildBytes, { flag: 'wx', mode: 0o644 });
    // Explicit inclusion records generated manifests too; the shared default
    // source census deliberately excludes .verifier-source.json.
    const includedPaths = new Set<string>();
    for (const file of files) {
      const parts = file.path.split('/');
      for (let end = 1; end <= parts.length; end++) includedPaths.add(parts.slice(0, end).join('/'));
    }
    // The shared census walks directory siblings; compare the population in
    // canonical path order (operator/ and operator-vite/ interleave globally).
    requireValue(isDeepStrictEqual(verifierSourceFiles(closure, { includedPaths, symlinkRoot: closure })
      .sort((a, b) => a.path.localeCompare(b.path)), files),
      'broker_copy_census_changed');
    await writeFile(join(closure, BROKER_CLOSURE_MANIFEST), manifestBytes, { flag: 'wx', mode: 0o644 });
    const image = join(owned, 'source.squashfs');
    const attempt = { version: 1, sourceCommit: source.sourceCommit, manifestSha256,
      inputFiles: files.length + 1, inputBytes, startedAt: new Date().toISOString() };
    const attemptPath = join(owned, 'pack-attempt.json');
    await writeFile(attemptPath, JSON.stringify(attempt), { flag: 'wx', mode: 0o600 });
    try { await packRuntimeSourceClosure(closure, image, signal); }
    catch (error) {
      if (error instanceof RuntimeSourcePackFailure) {
        // The child has closed. Retain its exact measured closure for a focused
        // diagnostic retry; it grants no image, admission or runtime authority.
        error.retainVerifierTree = true;
        error.retainedInputRoot = owned;
        try {
          await writeFile(attemptPath, JSON.stringify({ ...attempt, status: 'failed',
            finishedAt: new Date().toISOString(), diagnostics: error.diagnostics }), { mode: 0o600 });
        } catch (receiptError) { throw new AggregateError([error, receiptError], 'source_image_pack_receipt_failed'); }
      }
      throw error;
    }
    handle = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    requireValue(info.isFile() && info.size > 0 && info.size <= MAX_IMAGE_BYTES, 'broker_image_size_invalid');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    requireValue(offset === info.size, 'broker_image_changed');
    const imageSha256 = hash.digest('hex');
    const sealed = await sealRuntimeSourceHandle(handle, imageSha256, offset, signal);
    await handle.close();
    handle = sealed;
    signal?.throwIfAborted();
    // The result exposes no mutable image pathname to the subsequent census.
    await rm(owned, { recursive: true, force: true });
    const result = Object.freeze({ handle, sourceImageNonce: randomUUID(), sourceCommit: source.sourceCommit,
      sourceTreeHash: digest(JSON.stringify(source.files)), sourceInputsHash: manifestSha256,
      imageSha256, imageBytes: offset, manifestSha256 });
    if (options.repositoryRoot && source.gitCheckout && buildBytes) preparedOrigins.set(result, Object.freeze({
      repositoryRoot: await realpath(options.repositoryRoot), sourceReceiptSha256, generatedSha256: digest(buildBytes) }));
    return result;
  } catch (error) {
    await handle?.close();
    if (!runtimeInputsMustBeRetained(error)) await rm(owned, { recursive: true, force: true });
    throw error;
  }
}

/** The canonical entry point: the host resolves its repository and exact commit. */
export async function prepareRuntimeSourceImage(options: {
  repositoryRoot: string; sourceCommit: string; custodyRoot: string; inputs: string[]; signal?: AbortSignal;
}): Promise<RuntimeSourceImage> {
  requireValue(/^[a-f0-9]{40,64}$/.test(options.sourceCommit), 'broker_requires_exact_commit');
  const custodyRoot = await realpath(options.custodyRoot);
  const owned = await mkdtemp(join(custodyRoot, 'broker-prepare-'));
  await chmod(owned, 0o700);
  let retain = false;
  try {
    const repositoryRoot = await realpath(options.repositoryRoot);
    if ((await stat(repositoryRoot)).dev !== (await stat(custodyRoot)).dev) {
      // Cross-device snapshots consume an immutable dependency generation.
      // Publish/select the exact ref through the maintained install reader
      // before materializing source, rather than failing halfway through it.
      await runVerifierDependencyCommand(process.execPath,
        [join(repositoryRoot, 'scripts/npm-install-safe.mjs'), '--exec-under-lock', '--', '/bin/bash',
          join(repositoryRoot, 'apps/operator/bin/release/dependency-generation.sh'),
          '--integration', repositoryRoot, '--ensure-ref', options.sourceCommit],
        { cwd: repositoryRoot, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, signal: options.signal });
      options.signal?.throwIfAborted();
    }
    const root = join(owned, 'source');
    const source = await prepareVerifierSource({ repo: resolve(options.repositoryRoot), ref: options.sourceCommit,
      dest: root, inputs: options.inputs, gitCheckout: true });
    const dependencies = await prepareVerifierDependencies({ donor: options.repositoryRoot, dest: root,
      receipt: source, signal: options.signal });
    const generated = await buildRuntimeGeneratedInputs({ root, repositoryRoot: options.repositoryRoot,
      custodyRoot, source, dependencies, signal: options.signal, runtimeTools: {}, nativeDesktop: {} });
    return await packRuntimeSourceImage({ root, custodyRoot, source, dependencies, generated,
      repositoryRoot: options.repositoryRoot, signal: options.signal });
  } catch (error) {
    retain = runtimeInputsMustBeRetained(error);
    throw error;
  } finally { if (!retain) await rm(owned, { recursive: true, force: true }); }
}
