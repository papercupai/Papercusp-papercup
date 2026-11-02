/**
 * Locate the BUNDLED node runtime as an absolute path.
 *
 * ## Why an absolute path is required, not a bare `node`
 *
 * A packaged install is not guaranteed to have node on PATH *at all*. The app
 * ships its own runtime — on macOS at
 * `/Applications/Papercusp GUI.app/Contents/Resources/sidecar/bin/node` — and
 * `main.rs` exports that directory as `PAPERCUSP_SIDECAR_BIN` for every
 * packaged/dev-sidecar boot. Any code that hands a bare `node` to a
 * *grandchild* process (a spawn whose PATH we do not control — notably git's
 * `ext::` transport command) therefore works on the dev box and fails on a real
 * install. Resolve the binary here and pass the absolute path instead.
 *
 * ## Why `process.execPath` is gated behind a basename check (EI-2114)
 *
 * In a PACKAGED Tauri build `process.execPath` is the Tauri/sidecar binary, not
 * node — handing it to something that expects a node interpreter breaks exactly
 * the installs this resolver exists to serve. It is only a valid candidate when
 * it really is a node binary. The basename filters candidates; an interpreter
 * probe establishes identity, including when a Bun executable is named node.
 *
 * The returned binary is always a plain node (never a tsx/loader wrapper), so a
 * caller whose stdout is a binary protocol can rely on it booting quietly —
 * provided the caller also strips `NODE_OPTIONS` from the child env.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The BUNDLED node, resolved cwd-independently. `null` when this process can't
 * see it (an extracted dev-source operator whose env lacks
 * PAPERCUSP_SIDECAR_BIN and whose execPath is a tsx wrapper, not plain `node`).
 */
export async function resolveBundledNode(): Promise<string | null> {
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  const execBase = path.basename(process.execPath).toLowerCase();
  const execIsNode = execBase === 'node' || execBase === 'node.exe';
  const bundledNames = process.platform === 'win32' ? ['node.exe', 'node'] : ['node', 'node.exe'];
  const candidates = [
    ...(sidecarBin ? bundledNames.map(name => path.join(sidecarBin, name)) : []),
    execIsNode ? process.execPath : '',
  ].filter(Boolean).map(candidate => path.resolve(candidate));
  for (const c of candidates) {
    if (!(await pathExists(c))) continue;
    try {
      if ((await measureRuntimePin(c)).name === 'node') return c;
    } catch { /* Unusable or unidentified runtimes never become a Node boundary. */ }
  }
  return null;
}

export type ApplicationRuntimeName = 'node' | 'bun';

export interface ApplicationRuntimePin {
  name: ApplicationRuntimeName;
  executable: string;
  binarySha256: string;
  version: string;
  platform: string;
  arch: string;
}

export interface ApplicationRuntimeCandidate {
  candidateSha256: string;
  sourceSha: string;
  roles: string[];
  entrypoint: string;
  entrypointSha256: string;
  /** Package-attested bootstrap code; arbitrary runtime preload arguments remain forbidden. */
  preload?: { path: string; sha256: string };
  node: ApplicationRuntimePin;
  bun?: ApplicationRuntimePin;
}

/** Supplied by the canonical acceptance reader, never inferred from a file's existence. */
export interface ApplicationRuntimeAcceptance {
  verdict: 'accepted';
  evidenceRef: string;
  candidateSha256: string;
  sourceSha: string;
  role: string;
  binarySha256: string;
  nodeBinarySha256: string;
  entrypointSha256: string;
  validUntil: number;
}

export interface ApplicationRuntimeLaunchRequest {
  candidate: ApplicationRuntimeCandidate;
  role: string;
  runtime?: ApplicationRuntimeName;
  purpose?: 'operational' | 'isolated-candidate' | 'rollback';
  runtimeArgs?: string[];
  args?: string[];
  env?: NodeJS.ProcessEnv;
  acceptanceRef?: string;
  /** The caller must resolve this reference through the existing acceptance authority. */
  verifyAcceptance?: (ref: string) => Promise<ApplicationRuntimeAcceptance | null>;
}

// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedExecRuntime: typeof execFile.__promisify__ | undefined;
const execRuntime = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedExecRuntime ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const SHA256 = /^[a-f0-9]{64}$/;
const RUNTIME_IDENTITY = `process.stdout.write(JSON.stringify({
  name:process.versions.bun?'bun':'node',version:process.versions.bun||process.versions.node,
  executable:process.execPath,platform:process.platform,arch:process.arch
}))`;

function assertRuntimePin(pin: ApplicationRuntimePin, name: ApplicationRuntimeName): void {
  if (!pin || pin.name !== name || !path.isAbsolute(pin.executable ?? '')
    || !SHA256.test(pin.binarySha256 ?? '')
    || [pin.version, pin.platform, pin.arch].some(value => typeof value !== 'string' || !value)) {
    throw new Error(`A complete explicit ${name} runtime pin is required`);
  }
}

async function measureRuntimePin(candidate: string, expectedSha256?: string): Promise<ApplicationRuntimePin> {
  const executable = await realpath(candidate);
  const binarySha256 = sha256(await readFile(executable));
  // A pinned executable must be checked before any identity subprocess can run.
  if (expectedSha256 && binarySha256 !== expectedSha256) throw new Error('Runtime binary digest mismatch');
  // Identity probes must not inherit credentials, preloads, or a loader from the host.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const { stdout } = await execRuntime(executable, ['-e', RUNTIME_IDENTITY], {
    env, timeout: 5000, maxBuffer: 8192, windowsHide: true,
  });
  const measured = JSON.parse(stdout);
  const pin = { ...measured, executable, binarySha256 } as ApplicationRuntimePin;
  if (!['node', 'bun'].includes(measured.name)) throw new Error('Unknown runtime interpreter');
  assertRuntimePin(pin, measured.name);
  if (await realpath(measured.executable) !== executable
    || sha256(await readFile(executable)) !== binarySha256) {
    throw new Error('Runtime binary changed during measurement');
  }
  return pin;
}

async function verifyRuntimePin(pin: ApplicationRuntimePin): Promise<ApplicationRuntimePin> {
  const measured = await measureRuntimePin(pin.executable, pin.binarySha256);
  if (measured.binarySha256 !== pin.binarySha256) throw new Error('Runtime binary digest mismatch');
  if (measured.name !== pin.name || measured.version !== pin.version
    || measured.platform !== pin.platform || measured.arch !== pin.arch) {
    throw new Error('Runtime identity does not match its pin');
  }
  return measured;
}

/** Measure package-attested bytes before exposing them to the launch selector. */
export async function measurePinnedApplicationRuntime(
  executable: string,
  binarySha256: string,
): Promise<ApplicationRuntimePin> {
  if (!path.isAbsolute(executable) || !SHA256.test(binarySha256)) {
    throw new Error('An absolute runtime path and package digest are required');
  }
  return measureRuntimePin(executable, binarySha256);
}

/**
 * Extend bundled-runtime resolution for application launches. Node tooling above
 * retains its existing resolver. This returns an argv vector, never a shell command.
 * The caller owns artifact immutability, isolated-candidate confinement, and spawning;
 * resolving a descriptor is not evidence that the host or a platform passed acceptance.
 */
export async function resolveApplicationRuntimeLaunch(request: ApplicationRuntimeLaunchRequest) {
  if (!request?.candidate || !Array.isArray(request.candidate.roles)
    || (request.runtimeArgs !== undefined && !Array.isArray(request.runtimeArgs))
    || (request.args !== undefined && !Array.isArray(request.args))) {
    throw new Error('Malformed application runtime selection');
  }
  const { role, verifyAcceptance, acceptanceRef } = request;
  const runtime = request.runtime ?? 'node';
  const purpose = request.purpose ?? 'operational';
  // Snapshot caller data before invoking asynchronous filesystem/acceptance readers.
  const candidate = { ...request.candidate, node: { ...request.candidate.node },
    bun: request.candidate.bun ? { ...request.candidate.bun } : undefined,
    preload: request.candidate.preload ? { ...request.candidate.preload } : undefined,
    roles: [...(request.candidate.roles ?? [])] };
  const runtimeArgs = [...(request.runtimeArgs ?? [])];
  const args = [...(request.args ?? [])];
  const env = { ...(request.env ?? process.env) };
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(role)
    || !['node', 'bun'].includes(runtime)
    || !['operational', 'isolated-candidate', 'rollback'].includes(purpose)) {
    throw new Error('Invalid application runtime selection');
  }
  if (!SHA256.test(candidate.candidateSha256) || !/^[a-f0-9]{40,64}$/.test(candidate.sourceSha)
    || !path.isAbsolute(candidate.entrypoint) || !SHA256.test(candidate.entrypointSha256)) {
    throw new Error('An explicit pinned application artifact is required');
  }
  if (candidate.preload && (!path.isAbsolute(candidate.preload.path)
    || !SHA256.test(candidate.preload.sha256))) {
    throw new Error('An explicit pinned application preload is required');
  }
  if (!candidate.roles.length || candidate.roles.some(value => !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    || new Set(candidate.roles).size !== candidate.roles.length || !candidate.roles.includes(role)) {
    throw new Error('Runtime role is absent from the candidate role census');
  }
  assertRuntimePin(candidate.node, 'node');
  if (purpose === 'rollback' && runtime !== 'node') throw new Error('Rollback selects retained Node');
  if (runtime === 'bun') assertRuntimePin(candidate.bun!, 'bun');
  const allowedArgs = runtime === 'node' ? ['--enable-source-maps', '--expose-gc'] : ['--smol'];
  if (runtimeArgs.some(arg => !allowedArgs.includes(arg))
    || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Unsupported runtime or application arguments');
  }
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS)$/i.test(key)) delete env[key];
  }
  let accepted: ApplicationRuntimeAcceptance | null = null;
  const assertAcceptance = () => {
    if (!accepted || accepted.verdict !== 'accepted' || accepted.evidenceRef !== acceptanceRef
      || accepted.candidateSha256 !== candidate.candidateSha256 || accepted.sourceSha !== candidate.sourceSha
      || accepted.role !== role || accepted.binarySha256 !== candidate.bun!.binarySha256
      || accepted.nodeBinarySha256 !== candidate.node.binarySha256
      || accepted.entrypointSha256 !== candidate.entrypointSha256
      || !Number.isFinite(accepted.validUntil) || accepted.validUntil <= Date.now()) {
      throw new Error('Matching current candidate acceptance is required for operational Bun');
    }
  };
  if (runtime === 'bun' && purpose === 'operational') {
    if (!acceptanceRef || !verifyAcceptance) throw new Error('Canonical Bun acceptance reader and reference required');
    const receipt = await verifyAcceptance(acceptanceRef);
    accepted = receipt ? { ...receipt } : null;
    assertAcceptance();
  }
  const verifyEntrypoint = async () => {
    if (sha256(await readFile(candidate.entrypoint)) !== candidate.entrypointSha256) {
      throw new Error('Application entrypoint digest mismatch');
    }
    if (candidate.preload && sha256(await readFile(candidate.preload.path)) !== candidate.preload.sha256) {
      throw new Error('Application preload digest mismatch');
    }
  };
  await verifyEntrypoint();
  // A Bun selection must keep the explicitly pinned Node rollback executable usable.
  const node = await verifyRuntimePin(candidate.node);
  const selected = runtime === 'node' ? node : await verifyRuntimePin(candidate.bun!);
  await verifyEntrypoint();
  if (accepted) assertAcceptance();
  const preloadArgs = candidate.preload
    ? [runtime === 'bun' ? '--preload' : '--require', candidate.preload.path] : [];
  return { executable: selected.executable, args: [...runtimeArgs, ...preloadArgs, candidate.entrypoint, ...args], env,
    runtime: selected, nodeRollback: node, candidateSha256: candidate.candidateSha256,
    role, purpose, acceptanceRef: accepted?.evidenceRef ?? null };
}
