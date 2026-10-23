/**
 * P-001 semantic capability receipts. These are bounded measurements, not an
 * acceptance authority or a proof cache. Callers retain them in existing evidence
 * artifacts/ledgers and join them to the source-derived capability population.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const RUNTIME_FIELDS = ['name', 'version', 'executable', 'binarySha256', 'platform', 'arch'];
const CANDIDATE_FIELDS = ['sourceSha', 'lockfileSha256', 'configurationSha256', 'dependencyGeneration'];
const PREFIX = 'PAPERCUSP_CAPABILITY:';

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
      || !HASH.test(runtime.binarySha256) || !isAbsolute(runtime.executable)) {
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
