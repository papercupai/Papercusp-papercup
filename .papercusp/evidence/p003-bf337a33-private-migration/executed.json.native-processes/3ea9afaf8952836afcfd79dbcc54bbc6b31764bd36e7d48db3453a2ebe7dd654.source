/**
 * P-001 semantic capability receipts. These are bounded measurements, not an
 * acceptance authority or a proof cache. Callers retain them in existing evidence
 * artifacts/ledgers and join them to the source-derived capability population.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const RUNTIME_FIELDS = ['name', 'version', 'executable', 'binarySha256', 'platform', 'arch'];
const CANDIDATE_FIELDS = ['sourceSha', 'lockfileSha256', 'configurationSha256', 'dependencyGeneration'];
const PREFIX = 'PAPERCUSP_CAPABILITY:';

const PROOF_HASH_FIELDS = ['binarySha256', 'nativeDependencyGeneration', 'lockfileSha256', 'configurationSha256'];
const PROOF_FIELDS = [...RUNTIME_FIELDS, ...PROOF_HASH_FIELDS.slice(1)];
const runtimeAbsolute = (runtime) => typeof runtime?.executable === 'string'
  && (runtime.platform === 'win32' ? win32 : posix).isAbsolute(runtime.executable);
function insideRuntimeClosure(runtime, root) {
  const path = runtime?.platform === 'win32' ? win32 : posix;
  if (typeof root !== 'string' || !path.isAbsolute(root) || !runtimeAbsolute(runtime)) return false;
  const relative = path.relative(root, runtime.executable);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/** A proof needs the actual interpreter and the installed native/lock/configuration generation. */
export function validRuntimeProofIdentity(runtime) {
  return Boolean(runtime && ['node', 'bun'].includes(runtime.name)
    && PROOF_FIELDS.every((key) => typeof runtime[key] === 'string' && runtime[key].trim() !== '')
    && runtimeAbsolute(runtime)
    && PROOF_HASH_FIELDS.every((key) => HASH.test(runtime[key])));
}

/** Stable across object property order; absent identity never produces a reusable key. */
export function runtimeProofFingerprint(runtime) {
  return validRuntimeProofIdentity(runtime)
    ? `runtime-v1 ${digest(JSON.stringify(PROOF_FIELDS.map((key) => [key, runtime[key]])))}`
    : null;
}

function currentRuntime() {
  const executable = realpathSync(process.execPath);
  return { name: process.versions.bun ? 'bun' : 'node',
    version: process.versions.bun || process.versions.node, executable,
    binarySha256: digest(readFileSync(executable)), platform: process.platform, arch: process.arch };
}

// A standalone expression so the probed interpreter measures itself without importing
// a parent-side cache, selector, loader, or dependency graph.
const RUNTIME_PROBE = `
  import { createHash } from 'node:crypto';
  import { readFileSync, realpathSync } from 'node:fs';
  const executable = realpathSync(process.execPath);
  process.stdout.write(JSON.stringify({ name: process.versions.bun ? 'bun' : 'node',
    version: process.versions.bun || process.versions.node, executable,
    binarySha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    platform: process.platform, arch: process.arch }));
`;

/**
 * Bind setup-release-checkout.sh's materialized pin (identity/source). The full
 * schema/closure/snapshot manifest lives in the generation store, not node_modules.
 * Mutable/unpublished installs have no pin and must run fresh.
 */
function proofIdentity(root, environment, readRuntime) {
  const marker = readFileSync(join(root, 'node_modules/.papercusp-dependency-generation'), 'utf8');
  const records = marker.trim().split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    if (index <= 0) throw new Error('Malformed dependency-generation field');
    return [line.slice(0, index), line.slice(index + 1)];
  });
  if (new Set(records.map(([key]) => key)).size !== records.length) return null;
  const fields = Object.fromEntries(records);
  if (records.length !== 2 || !HASH.test(fields.source)
      || fields.identity !== `v1-${fields.source}`) return null;
  const identity = { ...readRuntime(),
    nativeDependencyGeneration: digest(marker),
    lockfileSha256: digest(readFileSync(join(root, 'package-lock.json'))),
    configurationSha256: digest(JSON.stringify(['BUN_OPTIONS', 'NODE_OPTIONS', 'NODE_PATH']
      .map((key) => [key, environment?.[key] ?? null]))),
  };
  return validRuntimeProofIdentity(identity) ? identity : null;
}

/** Measure the selected child, including a Bun executable named `node` on PATH. */
export function captureRuntimeProofIdentity({ root, cwd = root, environment = process.env, executable = 'node' }) {
  try {
    return proofIdentity(root, environment, () => {
      const runtime = JSON.parse(execFileSync(executable, ['--input-type=module', '-e', RUNTIME_PROBE], {
        cwd, env: environment, encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
      validateRuntime(runtime);
      if (realpathSync(runtime.executable) !== runtime.executable
          || digest(readFileSync(runtime.executable)) !== runtime.binarySha256) {
        throw new Error('Runtime binary changed during identity measurement');
      }
      return runtime;
    });
  } catch { return null; }
}

/** Recorder/skip consumers measure their own process rather than trusting a parent claim. */
export function captureCurrentRuntimeProofIdentity({ root, environment = process.env }) {
  try { return proofIdentity(root, environment, currentRuntime); }
  catch { return null; }
}

// The child measures itself after the awaited operation. Module import success
// cannot create this receipt. Parent still waits for CLOSE (including late
// failures and pipe drains), and verifies the actual child PID and binary bytes.
const CHILD = `
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [nonce, capabilityId, probe] = process.argv.slice(1);
const actual = probe ? await (await import(pathToFileURL(probe).href)).perform() : null;
const executable = realpathSync(process.execPath);
const runtime = {
  name: process.versions.bun ? 'bun' : 'node',
  version: process.versions.bun || process.versions.node,
  executable,
  binarySha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  platform: process.platform, arch: process.arch,
};
process.stdout.write(${JSON.stringify(PREFIX)} + JSON.stringify({
  nonce, capabilityId, completed: true, pid: process.pid, runtime, actual,
}) + '\\n');
`;

function validateRuntime(runtime) {
  if (!runtime || !['node', 'bun'].includes(runtime.name)
      || RUNTIME_FIELDS.some((field) => typeof runtime[field] !== 'string' || !runtime[field])
      || !HASH.test(runtime.binarySha256) || !runtimeAbsolute(runtime)) {
    throw new Error('A complete, pinned Node/Bun runtime identity is required');
  }
}

/** An absent identity field is never a wildcard. */
export function evaluateCapability({ capabilityId, expected, runtime, candidate }, observation) {
  validateRuntime(runtime);
  if (!candidate || CANDIDATE_FIELDS.some((field) => typeof candidate[field] !== 'string' || !candidate[field])
      || !/^[a-f0-9]{40,64}$/.test(candidate.sourceSha)
      || !HASH.test(candidate.lockfileSha256) || !HASH.test(candidate.configurationSha256)) {
    throw new Error('Source, lockfile, configuration and native dependency generation must be pinned');
  }
  if (!capabilityId || expected === undefined) throw new Error('Capability id and semantic expectation are required');
  const reasons = [];
  if (observation.error) reasons.push(observation.error);
  if (observation.timedOut) reasons.push('timeout');
  if (observation.overflow) reasons.push('output-limit');
  if (observation.exitCode !== 0 || observation.signal) reasons.push('abnormal-exit');
  if (observation.receipts.length !== 1) reasons.push('missing-or-duplicate-completion');
  const receipt = observation.receipts.length === 1 ? observation.receipts[0] : null;
  if (receipt) {
    if (receipt.completed !== true || receipt.capabilityId !== capabilityId
        || receipt.nonce !== observation.nonce || receipt.pid !== observation.pid) reasons.push('completion-identity');
    if (RUNTIME_FIELDS.some((field) => receipt.runtime?.[field] !== runtime[field])) reasons.push('wrong-interpreter');
    if (!isDeepStrictEqual(receipt.actual, expected)) reasons.push('incorrect-result');
  }
  if (observation.binarySha256 !== runtime.binarySha256) reasons.push('binary-changed');
  return {
    schema: 'papercusp-runtime-capability-v1', capabilityId, candidate: { ...candidate }, runtime: { ...runtime },
    status: reasons.length ? 'failed' : 'passed', reasons, expected, actual: receipt?.actual ?? null,
    observation,
  };
}

const INSTALL_SCENARIOS = ['clean-install', 'upgrade', 'restart', 'node-rollback'];
const HOST_PATH_CASES = ['absent', 'poisoned'];
const installedCapabilityId = (cellId, scenario, hostRuntimePath) =>
  `installed:${cellId}:${scenario}:${hostRuntimePath}`;

/**
 * Join installed execution receipts to an independently source-derived scope and
 * frozen artifact pins. Fixture receipts can test this detector, but cannot supply
 * installed evidence. Never infer a missing server/architecture from a sibling.
 */
export function evaluateInstalledArtifactMatrix({ requiredScope, bindings, receipts }) {
  if (!Array.isArray(requiredScope) || !requiredScope.length
      || requiredScope.some((id) => !/^(gui|server):(linux|macos|windows)-(x86_64|arm64)$/.test(id))
      || new Set(requiredScope).size !== requiredScope.length
      || !Array.isArray(bindings) || !Array.isArray(receipts)) {
    throw new Error('An explicit unique configured installed-artifact scope is required');
  }
  const pins = new Map();
  for (const binding of bindings) {
    if (!requiredScope.includes(binding.cellId) || pins.has(binding.cellId)
        || !['installerSha256', 'artifactSha256', 'previousArtifactSha256'].every((key) => HASH.test(binding[key]))
        || !HASH.test(binding.candidate?.dependencyGeneration)
        || typeof binding.runtimeRegistrationId !== 'string' || !binding.runtimeRegistrationId.trim()
        || INSTALL_SCENARIOS.some((scenario) => binding.expected?.[scenario] === undefined)
        || binding.runtime?.name !== 'bun' || binding.rollbackRuntime?.name !== 'node'
        || binding.runtime.platform !== binding.rollbackRuntime.platform
        || binding.runtime.arch !== binding.rollbackRuntime.arch
        || ![binding.runtime, binding.rollbackRuntime].every((runtime) =>
          insideRuntimeClosure(runtime, binding.runtimeClosureRoot))) {
      throw new Error('Each installed cell needs unique artifact, registration, semantic and runtime pins');
    }
    for (const runtime of [binding.runtime, binding.rollbackRuntime]) {
      evaluateCapability({ capabilityId: 'validate-installed-pins', expected: null,
        runtime, candidate: binding.candidate }, { receipts: [], exitCode: null });
    }
    pins.set(binding.cellId, binding);
  }
  const reasons = [];
  if (receipts.some((receipt) => !requiredScope.includes(receipt?.cellId))) reasons.push('unexpected-cell');
  const cells = requiredScope.map((cellId) => {
    const binding = pins.get(cellId);
    const cellReasons = [];
    if (!binding) cellReasons.push('missing-artifact-binding');
    const rows = receipts.filter((receipt) => receipt?.cellId === cellId);
    if (rows.some((row) => !INSTALL_SCENARIOS.includes(row.scenario)
        || !HOST_PATH_CASES.includes(row.hostRuntimePath))) cellReasons.push('unexpected-scenario');
    for (const scenario of INSTALL_SCENARIOS) for (const hostRuntimePath of HOST_PATH_CASES) {
      const leg = `${scenario}:${hostRuntimePath}`;
      const matches = rows.filter((row) => row.scenario === scenario && row.hostRuntimePath === hostRuntimePath);
      if (matches.length !== 1) {
        cellReasons.push(`${leg}:missing-or-duplicate-receipt`);
        continue;
      }
      if (!binding) continue;
      const observation = matches[0].observation;
      if (!observation || !Number.isSafeInteger(observation.pid) || observation.pid <= 0
          || typeof observation.nonce !== 'string' || !observation.nonce.trim()
          || typeof observation.timedOut !== 'boolean' || typeof observation.overflow !== 'boolean'
          || !Array.isArray(observation.receipts)) {
        cellReasons.push(`${leg}:invalid-process-observation`);
        continue;
      }
      const expected = { cellId, scenario, hostRuntimePath, offline: true,
        installerSha256: binding.installerSha256, artifactSha256: binding.artifactSha256,
        previousArtifactSha256: scenario === 'upgrade' ? binding.previousArtifactSha256 : null,
        candidate: binding.candidate, runtimeRegistrationId: binding.runtimeRegistrationId,
        runtimeClosureRoot: binding.runtimeClosureRoot,
        semantic: binding.expected[scenario] };
      try {
        const result = evaluateCapability({
          capabilityId: installedCapabilityId(cellId, scenario, hostRuntimePath), expected,
          candidate: binding.candidate,
          runtime: scenario === 'node-rollback' ? binding.rollbackRuntime : binding.runtime,
        }, observation);
        cellReasons.push(...result.reasons.map((reason) => `${leg}:${reason}`));
      } catch { cellReasons.push(`${leg}:invalid-capability-observation`); }
    }
    return { cellId, status: cellReasons.length ? 'failed' : 'passed', reasons: cellReasons };
  });
  return { schema: 'papercusp-installed-artifact-matrix-v1',
    status: reasons.length || cells.some((cell) => cell.status !== 'passed') ? 'failed' : 'passed',
    reasons, cells, coverage: { population: [...requiredScope],
      checked: cells.filter((cell) => cell.status === 'passed').map((cell) => cell.cellId),
      notChecked: cells.filter((cell) => cell.status !== 'passed').map((cell) => cell.cellId),
      notApplicable: [], residue: [] } };
}

async function execute(executable, probePath, capabilityId, { timeoutMs = 10_000, cwd, env = {}, maxOutputBytes = 64 * 1024 } = {}) {
  if (!isAbsolute(executable) || (probePath && !isAbsolute(probePath))) throw new Error('Absolute executable/probe paths required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Probe timeout must be 1..60000ms');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) throw new Error('Invalid output budget');
  const nonce = randomUUID();
  const resolved = realpathSync(executable);
  const initialDigest = digest(readFileSync(resolved));
  const probeSha256 = probePath ? digest(readFileSync(probePath)) : null;
  // Do not inherit live service credentials or interpreter preload flags. An
  // operational probe can explicitly receive its isolated data/socket identity.
  const childEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS)$/i.test(key)) childEnv[key] = value;
  }
  return await new Promise((resolve) => {
    const observation = { nonce, pid: null, exitCode: null, signal: null, timedOut: false,
      overflow: false, error: null, receipts: [], stderr: '', binarySha256: initialDigest,
      probePath, probeSha256 };
    let stdout = '', bytes = 0;
    const child = spawn(resolved, ['--input-type=module', '-e', CHILD, nonce, capabilityId, probePath ?? ''], {
      cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    observation.pid = child.pid ?? null;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH') observation.error = `cleanup:${error.code}`; }
    };
    const timer = setTimeout(() => { observation.timedOut = true; kill(); }, timeoutMs);
    const consume = (chunk, stream) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { observation.overflow = true; kill(); return; }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else observation.stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => consume(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => consume(chunk, 'stderr'));
    child.on('error', (error) => { observation.error = `spawn:${error.code}`; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      observation.exitCode = code; observation.signal = signal;
      for (const line of stdout.split('\n')) {
        if (!line.startsWith(PREFIX)) continue;
        try { observation.receipts.push(JSON.parse(line.slice(PREFIX.length))); }
        catch { observation.error = 'malformed-completion'; }
      }
      try {
        observation.binarySha256 = digest(readFileSync(resolved));
        if (observation.binarySha256 !== initialDigest) observation.error = 'binary-changed-during-probe';
      } catch { observation.error = 'binary-unreadable-after-probe'; }
      if (probePath) {
        try {
          if (digest(readFileSync(probePath)) !== probeSha256) observation.error = 'probe-changed-during-operation';
        } catch { observation.error = 'probe-unreadable-after-operation'; }
      }
      resolve(observation);
    });
  });
}

/** Capture a pin from the interpreter itself, never from its filename or PATH. */
export async function measureRuntime(executable, options) {
  const observation = await execute(executable, null, 'runtime-identity', options);
  const receipt = observation.receipts[0];
  if (observation.error || observation.timedOut || observation.overflow || observation.exitCode !== 0
      || observation.signal || observation.receipts.length !== 1 || receipt.nonce !== observation.nonce
      || receipt.pid !== observation.pid || receipt.completed !== true
      || receipt.runtime?.executable !== realpathSync(executable)
      || receipt.runtime?.binarySha256 !== observation.binarySha256) {
    throw new Error(`Runtime identity measurement failed: ${JSON.stringify(observation)}`);
  }
  validateRuntime(receipt.runtime);
  return receipt.runtime;
}

export async function runCapability(request, options) {
  validateRuntime(request.runtime);
  if (typeof request.probePath !== 'string' || !isAbsolute(request.probePath)) {
    throw new Error('A semantic probe module with an absolute path is required');
  }
  // Validate the candidate before executing any operation.
  evaluateCapability(request, { receipts: [], exitCode: null });
  const observation = await execute(request.runtime.executable, request.probePath, request.capabilityId, options);
  return evaluateCapability(request, observation);
}
