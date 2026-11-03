import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { promisify } from 'node:util';
import { committedWorkRootDependencyDonor, OWNER_MARKER } from '../lint-as-committed.mjs';
import { censusSpawnArgs, interpretRestrictedHoldPreflight } from './restricted-hold-preflight.mjs';
import { admitTaskDeadline, readTaskDeadlineEpochMs } from './task-deadline.mjs';
import { verifierTaskBudget } from './verify-tauri-deadline.mjs';
import { isolatedRuntimeEnv } from './isolation-child-env.mjs';

// Sequential parent readiness commands (deadline, identity, types, census),
// PostgreSQL init/start/stop/start, and portal setup precede the native rig.
// They must not spend the rig's own launch clock.
const nativeTypecheckTimeoutMs = 15_000 + 120_000 + 10_000 + 5_000;
// Completed-runtime certification checks these subjects and calibration inputs
// against the original verifier receipt. A caller's repair-only input list must
// not replace this population: a successful native run would be uncertifiable.
const desktopPortalNativeInputs = Object.freeze([
  'apps/operator-vite/desktop-portal-candidate.ts',
  'apps/operator-vite/desktop-portal-plugin.ts',
  'apps/operator/bin/desktop-portal-host.ts',
  'apps/operator/bin/desktop-portal-lifecycle.ts',
  'papercusp-desktop/src-tauri/src/env_switch.rs',
  'papercusp-desktop/src-tauri/src/main.rs',
  'apps/operator/bin/desktop-portal-native.test.ts',
  'apps/operator/bin/desktop-portal-persistence.test.ts',
  'apps/operator/vitest.e2e.config.ts',
  'packages/operator-core/lib/testing-native-runtime.ts',
  'scripts/lib/verify-tauri-native-env.mjs',
  'scripts/test-files.mjs',
  'scripts/verify-tauri-headless.sh',
]);
/** @param {NodeJS.ProcessEnv} [env] */
export function desktopPortalNativeTimingForEnv(env = process.env) {
  const budget = verifierTaskBudget({ env: {
    ...env,
    VERIFY_TAURI_PREPARE_ESTIMATE_MS: env.VERIFY_TAURI_PREPARE_ESTIMATE_MS || '1200000',
    VERIFY_TAURI_ASSERT_ESTIMATE_MS: env.VERIFY_TAURI_ASSERT_ESTIMATE_MS || '360000',
  }, assertionMode: '1' });
  // Native19's fixed 45-minute allocation had only one minute beyond the
  // forecast and spent it during copying. Reserve forecast uncertainty for
  // the whole journey, using the same calibrated work as the shell guard.
  return Object.freeze({
    prepareEstimateMs: budget.prepareMs,
    nativeTimeoutMs: Math.ceil(budget.knownEstimateMs * 1.25),
    typecheckTimeoutMs: nativeTypecheckTimeoutMs,
    setupTimeoutMs: 15_000 + 45_000 + nativeTypecheckTimeoutMs + 125_000 + 4 * 20_000 + 60_000,
    cleanupTimeoutMs: 60_000,
  });
}
export const desktopPortalNativeTiming = desktopPortalNativeTimingForEnv({});

/** @param {NodeJS.ProcessEnv} [env] */
export function desktopPortalNativeTestTimeoutMs(env = process.env) {
  const timing = desktopPortalNativeTimingForEnv(env);
  return timing.setupTimeoutMs + timing.nativeTimeoutMs + timing.cleanupTimeoutMs;
}

export function admitDesktopPortalNativeParent(env = process.env, nowMs = Date.now()) {
  const testTimeoutMs = desktopPortalNativeTestTimeoutMs(env);
  const fileTimeoutMs = testTimeoutMs + 120_000;
  if (Number(env.PAPERCUSP_TEST_FILE_TIMEOUT_MS ?? 600_000) < fileTimeoutMs) {
    throw new Error(`Native profile requires PAPERCUSP_TEST_FILE_TIMEOUT_MS>=${fileTimeoutMs}; refusing before PostgreSQL or dependency copying`);
  }
  return admitTaskDeadline({ env, nowMs, knownEstimateMs: testTimeoutMs,
    knownTasks: 3, unknownTasks: 0 });
}

/** Validate private candidate bytes before preparation; optionally freeze only declared SPA files. */
export function verifyDesktopPortalCandidateSpa(repoRoot, env = process.env, output) {
  if (!env.PAPERCUSP_SHARED_SPA_DIST) return null;
  const manifest = env.PAPERCUSP_DESKTOP_CANDIDATE_MANIFEST;
  const digest = env.VERIFY_TAURI_CANDIDATE_MANIFEST_SHA256;
  if (!manifest || !digest) throw new Error('VERIFY_TAURI_SPA_UNBOUND: candidate manifest and digest required');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifestBytes = readFileSync(manifest);
  if (hash(manifestBytes) !== digest) throw new Error('VERIFY_TAURI_SPA_UNBOUND: candidate manifest hash mismatch');
  const receipt = JSON.parse(manifestBytes.toString());
  const commitSha = execFileSync('git', ['rev-parse', env.VERIFY_TAURI_SOURCE_REF || 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384,
  }).trim();
  if (receipt.schemaVersion !== 'desktop-portal-private-candidate-v1'
    || receipt.desktopSource?.commitSha !== commitSha || receipt.desktopSource?.worktreeDirty !== false) {
    throw new Error('VERIFY_TAURI_SPA_UNBOUND: candidate must name the clean selected desktop commit');
  }
  const directory = dirname(resolve(manifest));
  const spa = join(directory, 'spa');
  if (env.PAPERCUSP_DESKTOP_INTERFACE !== 'portal-candidate'
    || resolve(env.PAPERCUSP_SHARED_SPA_DIST) !== spa
    || receipt.environment?.PAPERCUSP_DESKTOP_INTERFACE !== 'portal-candidate'
    || receipt.environment?.PAPERCUSP_SPA_DIST !== spa
    || receipt.environment?.PAPERCUSP_DESKTOP_PORTAL_HOST_BUNDLE !== join(directory, 'desktop-portal.cjs')) {
    throw new Error('VERIFY_TAURI_SPA_UNBOUND: candidate SPA selection differs from its manifest');
  }
  if (realpathSync(directory) !== directory || realpathSync(manifest) !== resolve(manifest)) {
    throw new Error('VERIFY_TAURI_SPA_UNBOUND: candidate cannot traverse a symlink');
  }
  const paths = new Set();
  const spaFiles = [];
  if (!Array.isArray(receipt.files)) throw new Error('VERIFY_TAURI_SPA_UNBOUND: candidate files required');
  for (const file of receipt.files) {
    const path = file.path;
    if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(path)) {
      throw new Error('VERIFY_TAURI_SPA_UNBOUND: unsafe candidate path');
    }
    paths.add(path);
    const target = join(directory, path);
    if (realpathSync(target) !== target || !lstatSync(target).isFile()) {
      throw new Error('VERIFY_TAURI_SPA_UNBOUND: candidate file is not regular or traverses a symlink');
    }
    const bytes = readFileSync(target);
    if (hash(bytes) !== file.sha256) throw new Error(`VERIFY_TAURI_SPA_UNBOUND: candidate hash mismatch: ${path}`);
    if (path.startsWith('spa/')) spaFiles.push({ path: path.slice(4), bytes, sha256: file.sha256 });
  }
  for (const path of ['spa/index.html', 'spa/wordmark.svg', 'desktop-portal.cjs']) {
    if (!paths.has(path)) throw new Error(`VERIFY_TAURI_SPA_UNBOUND: candidate missing ${path}`);
  }
  if (!spaFiles.some(file => file.path.startsWith('assets/'))
    || !readFileSync(join(spa, 'index.html'), 'utf8').includes('content="portal-candidate"')) {
    throw new Error('VERIFY_TAURI_SPA_UNBOUND: candidate frontend is incomplete');
  }
  // Copy verified buffers, not paths that may change after the hash check.
  // Unlisted files are never served and a later source change cannot alter this run.
  if (output !== undefined) {
    mkdirSync(output, { recursive: true });
    for (const file of spaFiles) {
      const target = join(output, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { flag: 'wx' });
      if (hash(readFileSync(target)) !== file.sha256) throw new Error('Candidate SPA copy hash mismatch');
    }
  }
  return { commitSha, manifestSha256: digest, files: paths.size, spaDist: output ?? spa };
}

// A real native verifier is a separate runtime. Its assertion runner will
// establish its own test environment later. Keep the parent's unit database
// rail in the parent, and do not let Vitest enable an injected census here.
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ timeoutMs?: number, nowMs?: number, repoRoot?: string }} [launch]
 */
export function nativeVerifierEnv(env, launch) {
  const child = { ...env };
  if (launch?.repoRoot !== undefined) {
    const source = resolve(launch.repoRoot);
    const explicitGeneration = Boolean(child.PAPERCUSP_DEPENDENCY_GENERATION_ROOT);
    const donor = explicitGeneration ? source : committedWorkRootDependencyDonor(source);
    const modules = join(donor, 'node_modules');
    if (!explicitGeneration && (!existsSync(modules) || !lstatSync(modules).isDirectory()
      || existsSync(join(donor, OWNER_MARKER)))) {
      throw new Error('Native verifier requires a physical installed dependency donor');
    }
    // The invoked wrapper remains in the tested checkout. Pin its Git source
    // separately: changing REPO_DIR alone would copy the mutable donor's code.
    const sourceRef = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: source, encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384,
    }).trim();
    if (child.VERIFY_TAURI_SOURCE_REF && child.VERIFY_TAURI_SOURCE_REF !== sourceRef) {
      throw new Error('Native verifier source ref must match the invoked checkout');
    }
    if (explicitGeneration) {
      const helper = join(source, 'papercusp-desktop/bin/lib/pinned-deps.sh');
      if (!existsSync(helper) || !/^\s*preflight-generation\s*\)/m.test(readFileSync(helper, 'utf8')))
        throw new Error('Native source does not support immutable verifier generations');
      const check = spawnSync('bash', [helper, 'preflight-generation', source, source], {
        env: { ...child, NODE_OPTIONS: '', NODE_PATH: '', DEPENDENCY_GENERATION_NODE: process.execPath },
        encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
      });
      if (check.error || check.status !== 0)
        throw new Error('Native verifier generation preflight failed: ' + (check.error?.message || check.stderr || check.status));
      child.VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE = 'copy';
    }
    child.PAPERCUSP_REPO_DIR = donor;
    child.VERIFY_TAURI_SOURCE_REF = sourceRef;
    // source-preview validates both channels against the selected commit before
    // copying or booting. Preserve custom paths and an inputs-file selector,
    // while always qualifying the product dependencies in the same receipt.
    child.VERIFY_TAURI_SOURCE_INPUTS = [...new Set([
      ...(child.VERIFY_TAURI_SOURCE_INPUTS ?? '').split(',').map(path => path.trim()).filter(Boolean),
      ...desktopPortalNativeInputs,
    ])].join(',');
  }
  if (launch?.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(launch.timeoutMs) || launch.timeoutMs <= 0) {
      throw new Error('Native verifier launch timeout must be a positive integer');
    }
    const nowMs = launch.nowMs ?? Date.now();
    child.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = String(Math.min(
      readTaskDeadlineEpochMs(env) ?? Infinity, nowMs + launch.timeoutMs,
    ));
  }
  // Hermetic worker setup removes the live workspace pin but retains the
  // original test-run attribution. The real native child needs that source
  // workspace for its lock census; restore it only in this copied child env.
  const workspace = [child.PAPERCUSP_WORKSPACE_ID, child.PAPERCUSP_WORKSPACE,
    child.PAPERCUSP_TEST_RUN_WORKSPACE].find(value => typeof value === 'string' && value.trim());
  if (workspace) child.PAPERCUSP_WORKSPACE_ID = workspace.trim();
  return isolatedRuntimeEnv(child);
}

// Exercise the same committed-source census used by the bundle gate before
// PostgreSQL initialization, dependency copying or compilation. This is a
// readiness check only: the real build still checks its exact inputs later.
export function preflightNativeVerifier(repoRoot, env, spawn = spawnSync) {
  const root = resolve(repoRoot);
  const child = nativeVerifierEnv(env, { repoRoot: root });
  verifyDesktopPortalCandidateSpa(root, child);
  if (!child.PAPERCUSP_WORKSPACE_ID?.trim()) {
    throw new Error('Native verifier requires a source workspace before preparation');
  }
  const census = censusSpawnArgs(['--tree', root], child);
  const verdict = interpretRestrictedHoldPreflight(spawn(process.execPath, census.argv, {
    cwd: root, env: census.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
  }));
  if (verdict.verdict !== 'admit') {
    throw new Error(`Native verifier census is not ready: ${verdict.hint}`);
  }
}

/**
 * Own a short-lived service for the exact tested checkout. The caller runs this helper in
 * the same bounded systemd scope as its checker; neither compiler outlives readiness.
 * A retained source must never silently ask the tower's fixed-root service or fall back.
 * @template T
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 * @param {(env: NodeJS.ProcessEnv) => Promise<T>} check
 * @returns {Promise<T>}
 */
export async function withNativeVerifierTypeService(repoRoot, env, check) {
  const root = realpathSync(repoRoot);
  // A systemd-escaped checkout path can exceed the Unix socket path limit.
  const directory = mkdtempSync('/tmp/pc-native-tsc-');
  const childEnv = { ...env, PAPERCUSP_TSC_SERVICE: '1', PAPERCUSP_TSC_SERVICE_REQUIRED: '1',
    PAPERCUSP_TSC_SERVICE_ROOT: root, PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE: '',
    PAPERCUSP_TSC_SERVICE_SOCKET: join(directory, 'service.sock') };
  const child = spawn(process.execPath, [join(root, 'scripts/tsc-service/server.mjs')], {
    cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = chunk => { output = (output + chunk.toString()).slice(-8192); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Native TypeScript service startup timed out: ${output}`)), 15_000);
      const ready = () => {
        if (!output.includes('listening on ')) return;
        clearTimeout(timer);
        child.stdout.off('data', ready);
        resolve(undefined);
      };
      child.stdout.on('data', ready);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Native TypeScript service exited code=${code} signal=${signal}: ${output}`));
      });
    });
    return await check(childEnv);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await closed;
    clearTimeout(kill);
    rmSync(directory, { recursive: true, force: true });
  }
}

if (isCliEntry(import.meta.url)) {
  try {
    if (!process.argv[3]) throw new Error('Native verifier requires a repo root');
    if (process.argv[2] === '--candidate-spa') {
      console.log(JSON.stringify(verifyDesktopPortalCandidateSpa(process.argv[3], process.env, process.argv[4])));
    } else if (process.argv[2] === '--typecheck') {
      const root = resolve(process.argv[3]);
      await withNativeVerifierTypeService(root, process.env, async env => {
        const child = promisify(execFile)(process.execPath, [join(root, 'scripts/lint-tsc-operator.mjs'),
          '--files=apps/operator/bin/desktop-portal-native.test.ts'], {
          cwd: root, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
        });
        child.child.stdout.on('data', data => process.stdout.write(data));
        child.child.stderr.on('data', data => process.stderr.write(data));
        await child;
      });
      console.log('VERIFY_TAURI_NATIVE_TYPES ready=1');
    } else if (process.argv[2] === '--preflight') {
      preflightNativeVerifier(process.argv[3], process.env);
      console.log('VERIFY_TAURI_NATIVE_PREFLIGHT admitted=1');
    } else {
      throw new Error('usage: verify-tauri-native-env.mjs --preflight|--candidate-spa|--typecheck <repo-root> [output]');
    }
  } catch (error) {
    console.error(error.message);
    console.error(`VERIFY_TAURI_NATIVE_FAILURE ${JSON.stringify({ step: process.argv[2],
      code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? null })}`);
    process.exitCode = 2;
  }
}
