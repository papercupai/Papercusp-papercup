#!/usr/bin/env node
/**
 * with-test-pg — run a command against a THROWAWAY, fully-migrated Postgres.
 *
 *   node scripts/with-test-pg.mjs -- node scripts/affected-tests.mjs --all
 *
 * Why this exists (WI-123's other half): ~30 "unit"-tier suites never touch PG
 * directly, but the app code they import resolves a pool through
 * libs/papercusp/libs/db/src/connection.ts. With no env set that chain lands on the
 * native `localhost:5432/papercusp`. CI already papers over this by running a
 * postgres service container + scripts/ci-provision-pg.mjs ("dev-box parity"); a dev
 * box papers over it by happening to run native PG. A PACKAGED install has neither,
 * so those suites ECONNREFUSE there — ~200 reds that are pure environment, not defects.
 *
 * This gives any host the same parity without a service container: the packaged app
 * already ships the PG binaries (@embedded-postgres/*) and all the migrations, so we
 * boot our own postmaster on a free port, into a temp datadir, and point the child at
 * it by env.
 *
 * It is deliberately NOT the product's embedded PG. That one holds the user's real
 * pot; a test suite must never open a pool against it. Ordinary mode removes
 * inherited product DSN pins and selects the owned server through
 * PAPERCUSP_PG_PORT + PAPERCUSP_SKIP_PG_DISCOVERY. This leaves env-resolution
 * tests free to set their own pins. Isolated runtime mode also supplies explicit
 * HARNESS_*_DATABASE_URL for its private product processes.
 *
 * Teardown is best-effort but unconditional: the postmaster is stopped and the temp
 * datadir removed on normal exit, on a failing child, and on SIGINT/SIGTERM.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { access, stat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { constants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { resolveFsMutexLockRoot } from './lib/fs-mutex.mjs';
import { snapshotMigrationSource } from './lib/with-test-pg-migrations.mjs';
import { ensureRequiredEmbeddedExtensions } from './install-embedded-pgvector.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sep = process.argv.indexOf('--');
const cmd = sep >= 0 ? process.argv.slice(sep + 1) : [];
const rawOptions = sep >= 0 ? process.argv.slice(2, sep) : process.argv.slice(2);
const managedTasks = rawOptions.includes('--managed-tasks');
const options = rawOptions.filter(option => option !== '--managed-tasks');
const operatorApi = options.length === 1 && options[0] === '--isolated-runtime=operator-api';
const isolatedRuntime = operatorApi || (options.length === 1 && options[0] === '--isolated-runtime');
if (cmd.length === 0 || (options.length > 0 && !isolatedRuntime) || (managedTasks && !operatorApi)) {
  console.error('usage: node scripts/with-test-pg.mjs [--isolated-runtime[=operator-api]] [--managed-tasks (operator-api only)] -- <command> [args...]');
  process.exit(2);
}

// This internal mode sends admission/teardown receipts to its supervising
// verifier. A plain CLI has no receiver: reject before allocating private state
// rather than discovering the missing channel after a successful test child.
if (process.env.PC_ISOLATED_RUNTIME_PROOF === '1' &&
    (!isolatedRuntime || !process.connected || typeof process.send !== 'function')) {
  console.error('[with-test-pg] proof preflight failed: PC_ISOLATED_RUNTIME_PROOF requires an isolated runtime and a connected parent IPC channel');
  process.exit(1);
}

// An explicit-but-empty sink commonly comes from expanding an unset shell
// variable. Refuse before allocating PG instead of silently losing evidence.
if (process.env.PAPERCUSP_TEST_RUNS_DB_URL !== undefined && !process.env.PAPERCUSP_TEST_RUNS_DB_URL.trim()) {
  console.error('[with-test-pg] evidence preflight failed: PAPERCUSP_TEST_RUNS_DB_URL must not be blank');
  process.exit(1);
}
// A resolver returns { url, ...metadata }; assigning that object to a child env
// turns it into "[object Object]". The reporter cannot construct its client and
// loses the ledger receipt after the entire suite. Reject invalid explicit
// sinks here without printing their potentially credential-bearing contents.
if (process.env.PAPERCUSP_TEST_RUNS_DB_URL !== undefined) {
  try {
    const sink = new URL(process.env.PAPERCUSP_TEST_RUNS_DB_URL.trim());
    if (sink.protocol !== 'postgres:' && sink.protocol !== 'postgresql:') throw new Error('unsupported protocol');
  } catch {
    console.error('[with-test-pg] evidence preflight failed: PAPERCUSP_TEST_RUNS_DB_URL must be a valid PostgreSQL URL');
    process.exit(1);
  }
}

// Evidence must outlive the private database. Require an explicit reporter-only
// sink before bootstrapping when the caller asks for durable ledger receipts.
// Never derive it from a product URL or silently claim a private insert survived.
const durableEvidenceRequested = ['PAPERCUSP_TEST_RUN_RECEIPT_FILE',
  'PC_EXECUTED_SOURCE_MAP_RESULT', 'PC_EXECUTED_SOURCE_MAP_OUT']
  .some(key => process.env[key]?.trim());
if (durableEvidenceRequested && !process.env.PAPERCUSP_TEST_RUNS_DB_URL?.trim()) {
  console.error('[with-test-pg] evidence preflight failed: PAPERCUSP_TEST_RUNS_DB_URL is required for durable test receipts');
  process.exit(1);
}

// Capture reporter attribution BEFORE replacing the product workspace below.
// A shared-ledger insert under test-runtime-* survives cleanup but cannot be
// read or bound by the caller's workspace. Nested wrappers retain this pin.
const callerTestRunWorkspace = (process.env.PAPERCUSP_TEST_RUN_WORKSPACE ||
  process.env.PAPERCUSP_WORKSPACE_ID || process.env.PAPERCUSP_WORKSPACE)?.trim();
if (isolatedRuntime && (
  (process.env.PAPERCUSP_TEST_RUN_WORKSPACE !== undefined && !process.env.PAPERCUSP_TEST_RUN_WORKSPACE.trim()) ||
  (process.env.PAPERCUSP_TEST_RUNS_DB_URL?.trim() && !callerTestRunWorkspace)
)) {
  console.error('[with-test-pg] evidence preflight failed: isolated shared-ledger runs require a nonblank caller workspace (PAPERCUSP_TEST_RUN_WORKSPACE, PAPERCUSP_WORKSPACE_ID or PAPERCUSP_WORKSPACE)');
  process.exit(1);
}

// spawn below runs from ROOT. Resolve that SAME executable before allocating
// or migrating Postgres, and pin the path used by spawn. A package-relative
// command must not burn an entire bootstrap before discovering ENOENT.
async function resolveExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return await realpath(candidate);
    } catch { /* try the next installation */ }
  }
  return undefined;
}
try {
  const candidates = /[/\\]/.test(cmd[0]) ? [resolve(ROOT, cmd[0])] :
    (process.env.PATH ?? '').split(delimiter).map(dir => resolve(ROOT, dir, cmd[0]));
  const executable = await resolveExecutable(candidates);
  if (!executable) throw new Error('child executable is missing or not executable from repository root: ' + cmd[0]);
  cmd[0] = executable;
} catch (error) {
  console.error('[with-test-pg] child preflight failed: ' + error.message);
  process.exit(1);
}

// R6 requires a real confined task. Opt in to ONLY the user manager's private
// control socket, never the desktop session bus or ambient product IPC. Reuse
// the task manager's systemd-run scope probe before importing runtime bootstrap
// dependencies or allocating PG. The worker still receives the private exact
// environment through the maintained systemd environment transport.
let managedTaskSocket;
let managedTaskBusAddress;
let runtimeRoot = null;
let runtimeTmpBase = null;
async function createIsolatedRuntimeRoot() {
  // PG and Vitest may use /dev/shm, but Linux SRT replaces /dev with a
  // private device namespace and deliberately skips /dev allowWrite mounts.
  // Native HOME/TMPDIR must survive that namespace. Resolve symlinks too;
  // changing PG's capacity-selected volume would not fix this placement rule.
  // Nested proof wrappers need sibling private roots on the same selected
  // volume. Recursively nesting beneath the parent's TMPDIR eventually exceeds
  // the Unix socket address limit even for an ordinary fixture socket.
  let base = await realpath(process.env.PAPERCUSP_TEST_RUNTIME_TMP_BASE?.trim() || tmpdir());
  const masked = path => process.platform === 'linux' && /^\/(dev|proc)(\/|$)/.test(path);
  if (masked(base)) {
    await mkdir('/tmp/pcv', { recursive: true });
    base = await realpath('/tmp/pcv');
    if (masked(base)) throw new Error('isolated native runtime temporary root resolves into the sandbox device namespace');
  }
  runtimeTmpBase = base;
  return mkdtemp(join(base, 'papercusp-test-runtime-'));
}
if (managedTasks) {
  try {
    if (process.platform !== 'linux' || !process.env.XDG_RUNTIME_DIR?.trim()) {
      throw new Error('an explicit Linux user-manager runtime directory is required');
    }
    const sourceRuntime = resolve(process.env.XDG_RUNTIME_DIR);
    // Select and probe one exact owned route. Some hosts have a stale private
    // manager socket while the manager is healthy through the session bus.
    // Never let the native client fall back to an unprobed ambient bus.
    runtimeRoot = await createIsolatedRuntimeRoot();
    const privateRuntime = join(runtimeRoot, 'xdg-runtime');
    await mkdir(join(privateRuntime, 'systemd'), { recursive: true, mode: 0o700 });
    const failures = [];
    for (const relativePath of ['systemd/private', 'bus']) {
      const candidate = join(sourceRuntime, relativePath);
      // systemd treats systemd/private as a direct peer, and bus as a
      // message bus. Aliasing a bus at the peer path selects the wrong protocol.
      const privateSocket = join(privateRuntime, relativePath);
      try {
        if (Buffer.byteLength(privateSocket) > 107) throw new Error('private managed-task socket exceeds native address capacity');
        const socket = await stat(candidate);
        if (!socket.isSocket() || socket.uid !== process.getuid()) throw new Error('user-manager control route must be an owned socket');
        await symlink(candidate, privateSocket);
        const probeEnv = { ...process.env, XDG_RUNTIME_DIR: privateRuntime,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${privateSocket}` };
        const probe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect',
          '--property=CollectMode=inactive-or-failed', '--', 'true'],
        { env: probeEnv, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'ignore', 'pipe'] });
        if (probe.error || probe.status !== 0)
          throw new Error(probe.error?.message ?? `private runtime scope probe exited ${probe.status}: ${probe.stderr.trim()}`);
        managedTaskSocket = candidate;
        managedTaskBusAddress = probeEnv.DBUS_SESSION_BUS_ADDRESS;
        break;
      } catch (error) {
        failures.push(`${candidate}: ${error.message}`);
        await rm(privateSocket, { force: true });
      }
    }
    if (!managedTaskSocket) throw new Error(failures.join('; '));
    console.log('[with-test-pg] managed task preflight passed (private user-manager control socket)');
  } catch (error) {
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
    console.error('[with-test-pg] managed task preflight failed: ' + error.message);
    process.exit(1);
  }
}

/** The migrations dir: the monorepo path, else the packaged sidecar's copy. */
function resolveSqlDir() {
  const candidates = [
    join(ROOT, 'libs/papercusp/libs/db/sql'),
    join(ROOT, 'sidecar/db-sql'),
    process.env.PAPERCUSP_PG_SQL_DIR,
  ].filter(Boolean);
  const hit = candidates.find((d) => existsSync(d));
  if (!hit) throw new Error(`no migrations dir found (looked in: ${candidates.join(', ')})`);
  // An explicit candidate SQL source is a custody assertion. ROOT wins the
  // resolution chain, so a mixed supervisor must fail before allocating PG
  // rather than silently seed a different migration inventory.
  const expected = process.env.PAPERCUSP_PG_SQL_DIR?.trim();
  if (expected && resolve(expected) !== resolve(hit)) {
    const inventory = dir => readdirSync(dir).filter(name => name.endsWith('.sql') || name.endsWith('.sql.forward-compat.json')).sort()
      .map(name => [name, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')]);
    if (JSON.stringify(inventory(hit)) !== JSON.stringify(inventory(expected))) {
      throw new Error(`migration source inventory mismatch: supervisor ${hit}; candidate ${expected}`);
    }
  }
  // Once verified, use the candidate itself as the capture source. This also
  // allows a caller's private source copy to outlive changes in the shared tree.
  return expected ? resolve(expected) : hit;
}

let sqlDir;
try { sqlDir = resolveSqlDir(); }
catch (error) {
  console.error('[with-test-pg] migration preflight failed: ' + error.message);
  process.exit(1);
}

// npm can replace the native tree after postinstall provisioned its extensions.
// Repair from the existing compatible host source, or refuse before allocating
// private state and applying migrations that require vector columns.
try { ensureRequiredEmbeddedExtensions({ root: ROOT }); }
catch (error) {
  console.error('[with-test-pg] extension preflight failed: ' + error.message);
  process.exit(1);
}

// Invalid commands and evidence pins need only Node builtins. Runtime imports
// can transform TypeScript and load container tooling, so keep that work behind
// the refusal boundary as well as the actual PostgreSQL allocation below.
const { default: AsyncExitHook } = await import('async-exit-hook');
const { ensurePapercuspTmpdir, tmpdirHasCriticalHeadroom } = await import('../libs/test-config/src/tmpdir-guard.ts');
const { SHARED_TEST_PG_DURABILITY_OFF } = await import('../libs/test-config/src/pg-container.ts');
const { browserCachePath } = await import('./lib/playwright-cache-path.mjs');
const { defaultEvidenceRoot } = await import('../libs/generic/verification-harness/src/evidence-root.ts');
const { processGroupLifetime } = await import('../packages/operator-core/lib/fleet/process-group-lifetime.ts');
const { cleanupOwnedTestState, unhookRegisteredExitSignals } = await import('./lib/with-test-pg-cleanup.mjs');

/** Ask the OS for a free TCP port. Never hardcode 5432 — that is the host's own PG. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const { startEmbeddedPostgresServer } = await import(
  '../libs/papercusp/packages/embedded-postgres-server/src/index.js'
);

// Reuse the test launcher's capacity policy before initdb or migration writes.
ensurePapercuspTmpdir();
if (!tmpdirHasCriticalHeadroom(tmpdir())) {
  throw new Error('private Postgres storage preflight failed: no temporary volume has critical headroom');
}
const dataDir = await mkdtemp(join(tmpdir(), 'papercusp-test-pg-'));
runtimeRoot ??= isolatedRuntime ? await createIsolatedRuntimeRoot() : null;
const runtimeId = isolatedRuntime ? `test-runtime-${randomUUID().slice(0, 12)}` : null;
const port = await freePort();

let pg = null;
let profileProcess = null;
let profileLifetime = null;
let child = null;
let childLifetime = null;
let childFinishPromise = null;
let cleanupPromise = null;
let terminatingSignal = null;
let cleanupStartedAt = null;
let managedTaskCleanupEnv = null;
const cleanupReceiptFailures = [];
const pendingCleanupReceipts = new Set();
function cleanupStage(stage, detail = {}) {
  // Cleanup is operational evidence for every isolated CLI. The proof flag
  // gates original-worker admission and detailed /proc sampling, not whether
  // a caller can distinguish a finished child from a still-stopping database.
  if (!isolatedRuntime) return;
  const message = { kind: 'isolated-runtime-cleanup', stage,
    elapsedMs: Date.now() - cleanupStartedAt,
    supervisorPid: process.pid, workspace: runtimeId, runtimeRoot, dataDir, pgPort: port, ...detail };
  console.log('[with-test-pg] cleanup ' + JSON.stringify(message));
  return sendCleanupReceipt(message);
}
function sendCleanupReceipt(message) {
  if (!isolatedRuntime || process.env.PC_ISOLATED_RUNTIME_PROOF !== '1') return;
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('private runtime proof IPC is disconnected'));
      return;
    }
    process.send(message, error => error ? reject(error) : resolve());
  });
}
function recordCleanupReceiptFailure(stage, cause) {
  cleanupReceiptFailures.push(new Error(stage + '-receipt: ' + (cause?.message ?? String(cause)), { cause }));
}
function queueCleanupStage(stage, detail = {}) {
  // PG logging and process sampling cannot await their receipts. Capture their
  // failures immediately and drain every outstanding callback before removal.
  const receipt = Promise.resolve().then(() => cleanupStage(stage, detail))
    .catch(cause => { recordCleanupReceiptFailure(stage, cause); });
  pendingCleanupReceipts.add(receipt);
  void receipt.then(() => pendingCleanupReceipts.delete(receipt));
}
async function drainCleanupReceipts() {
  while (pendingCleanupReceipts.size) await Promise.all(pendingCleanupReceipts);
}
function observePrivatePgStop() {
  if (!isolatedRuntime || process.env.PC_ISOLATED_RUNTIME_PROOF !== '1' || process.platform !== 'linux') return () => {};
  let postmasterPid;
  let postmasterStart;
  const stat = pid => {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(/\s+/);
    return { state: fields[0], parentPid: Number(fields[1]), startTicks: fields[19] };
  };
  try {
    const record = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
    postmasterPid = Number(record[0]);
    const pin = stat(postmasterPid);
    if (record[1] !== dataDir || Number(record[3]) !== port || pin.parentPid !== process.pid) {
      throw new Error('private postmaster identity does not match owned runtime');
    }
    postmasterStart = pin.startTicks;
  } catch (error) {
    queueCleanupStage('pg-stop-observation-unavailable', { error: error.message });
    return () => {};
  }
  const sample = () => {
    try {
      if (stat(postmasterPid).startTicks !== postmasterStart) throw new Error('private postmaster lifetime ended');
      const descendants = readFileSync(`/proc/${postmasterPid}/task/${postmasterPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      const processes = [postmasterPid, ...descendants].map(pid => {
        try {
          const pin = stat(pid);
          if (pid !== postmasterPid && pin.parentPid !== postmasterPid) throw new Error('PG child reparented');
          const io = Object.fromEntries(readFileSync(`/proc/${pid}/io`, 'utf8').trim().split('\n').map(line => line.split(':').map(s => s.trim())));
          return { pid, ...pin, command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(),
            waitChannel: readFileSync(`/proc/${pid}/wchan`, 'utf8').trim(), io };
        } catch (error) { return { pid, unavailable: error.message }; }
      });
      queueCleanupStage('pg-stop-observation', { processes });
    } catch (error) { queueCleanupStage('pg-stop-observation-unavailable', { error: error.message }); }
  };
  sample();
  const timer = setInterval(sample, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
async function cleanup() {
  // Signals and failed bootstrap may converge here. Every caller waits for
  // the same cleanup rather than mistaking "started" for "finished".
  return cleanupPromise ??= cleanupOwnedState();
}
async function cleanupOwnedState() {
  cleanupStartedAt = Date.now();
  // Keep failed exit fences visible while stopping the other owned resources.
  await cleanupOwnedTestState({ child, childLifetime, profileProcess, profileLifetime, pg,
    dataDir, runtimeRoot, isolatedRuntime, cleanupStage, observePrivatePgStop,
    receiptFailures: cleanupReceiptFailures, drainReceipts: drainCleanupReceipts,
    stopManagedTasks: managedTasks && managedTaskCleanupEnv ? stopPrivateManagedTasks : null });
}

async function stopPrivateManagedTasks() {
  // A task scope is outside the worker's process group. After that worker has
  // stopped, reuse the private ledger and maintained controller to reap exact
  // owned scopes, including terminal rows with surviving processes. Never
  // enumerate or signal ambient user-manager units.
  const script = `
    import assert from 'node:assert/strict';
    const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
    assert.match(workspace, /^test-runtime-/);
    const url = new URL(process.env.HARNESS_ADMIN_DATABASE_URL);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.port, process.env.PAPERCUSP_PG_PORT);
    assert.notEqual(url.port, '5432');
    const { getOrgPg } = await import('@papercusp/db-org');
    const { listTasks } = await import('./packages/operator-core/lib/task-manager/store.ts');
    const { killTask } = await import('./packages/operator-core/lib/task-manager/control.ts');
    const { absCgroupDir, walkCgroupTree } = await import('./packages/operator-core/lib/task-manager/cgroup-read.ts');
    try {
      const tasks = await listTasks({ workspaceId: workspace, includeEnded: true, limit: 2000 });
      assert.ok(tasks.length < 2000, 'private task census exceeded its bounded read');
      let reaped = 0;
      for (const task of tasks) {
        assert.equal(task.workspaceId, workspace);
        if (!task.confined || !task.cgroupPath || !task.scopeUnit) {
          assert.ok(task.endedAt || !task.pid, 'live private task has no verifiable scope');
          continue;
        }
        if (!walkCgroupTree(absCgroupDir(task.cgroupPath)).length) continue;
        const result = await killTask(task.taskId, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 });
        assert.equal(walkCgroupTree(absCgroupDir(task.cgroupPath)).length, 0,
          'private task scope survived stop: ' + JSON.stringify(result));
        reaped++;
      }
      console.log('PRIVATE_MANAGED_TASK_CLEANUP ' + JSON.stringify({ workspace, checked: tasks.length, reaped }));
    } finally { await getOrgPg().sql.end({ timeout: 1 }); }
  `;
  await new Promise((done, reject) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: ROOT, env: managedTaskCleanupEnv, timeout: 60000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error('private managed task cleanup failed: ' + error.message + '\n' + stderr.slice(-4000)));
        else { console.log(stdout.trim()); done(); }
      });
  });
}

// Maintained integration callers fork a dedicated process group. That group
// includes initdb, whose dependency does not expose a process handle. Verify
// ownership before signalling it; an ordinary CLI never targets its parent's
// group. Every isolated CLI owns its private cleanup, even when it shares the
// caller's group. Replace the dependency's signal-exit hook for both routes:
// it otherwise exits while startup/cleanup is still pending. Group ownership
// controls only whether we may signal the supervisor's entire process group.
const ownProcessGroup = isolatedRuntime && process.platform === 'linux' &&
  Number(readFileSync('/proc/self/stat', 'utf8').split(')').slice(1).join(')').trim().split(/\s+/)[2]) === process.pid;
if (isolatedRuntime) {
  unhookRegisteredExitSignals(AsyncExitHook);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (terminatingSignal) return;
    terminatingSignal = sig;
    // Once startEmbeddedPostgresServer has returned, cleanup owns the PG handle
    // and its supervisor. Let pg.stop() fence supervision before stopping the
    // postmaster; signalling our whole process group first makes the supervisor
    // observe the intentional code-0 shutdown as an unexpected death and queue a
    // restart during teardown. During bootstrap there is no handle to fence, so
    // retain the group signal to reap initdb/postmaster descendants.
    if (ownProcessGroup && (!pg || !child?.pid)) {
      // The repeated signal to this supervisor is ignored by the guard above;
      // its exact owned initdb/postmaster descendants receive it as well.
      // PG's maintained stop() uses SIGINT (fast shutdown). SIGTERM requests
      // smart shutdown and waits for our still-running migration connection.
      try { process.kill(-process.pid, 'SIGINT'); } catch { /* group already exited */ }
    }
    if (profileProcess?.pid) {
      try { process.kill(-profileProcess.pid, sig); } catch { /* already exited */ }
    }
    if (child?.pid) {
      if (isolatedRuntime) {
        // Cancellation cannot depend on a cooperative child exit: it may
        // ignore TERM, while its group still holds the private database.
        void finishChild(null, sig);
      } else child.kill(sig);
    }
  });
}
function assertNotTerminating() {
  if (terminatingSignal) throw new Error(`private runtime cancelled during bootstrap: ${terminatingSignal}`);
}

async function main() {
// Product restarts must use the same bytes that seeded this private database.
// A live shared-tree migration arriving mid-test otherwise withholds the next
// request listener because the disposable DB never reserved that new file.
if (isolatedRuntime) sqlDir = snapshotMigrationSource(sqlDir, join(runtimeRoot, 'db-sql'));
console.log(`[with-test-pg] booting throwaway PG on :${port} (datadir ${dataDir})`);
console.log(`[with-test-pg] migrations: ${sqlDir}`);

pg = await startEmbeddedPostgresServer({ dataDir, port, dbSqlDir: sqlDir,
  // Every fixture client uses its explicit TCP URL. Avoid an unused socket
  // lock on /tmp, which may be full even when the private data volume is ready.
  // This cluster is always discarded after the child exits. Reuse the
  // maintained disposable test-PG policy instead of fsyncing thousands of
  // migrated files during its final checkpoint. Product PG retains its own
  // durability defaults; this override belongs only to our mkdtemp cluster.
  extraPostgresSettings: {
    ...Object.fromEntries(SHARED_TEST_PG_DURABILITY_OFF
      .filter((_, index) => index % 2 === 1)
      .map(setting => setting.split('='))),
    unix_socket_directories: '',
  },
  onLog: message => {
    // Preserve boot/migration progress as well as shutdown. A deadline before
    // start() returns otherwise erases the stage that actually consumed it.
    console.log('[with-test-pg] pg ' + String(message));
    if (!child && cleanupStartedAt === null && process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && process.connected) {
      const text = String(message);
      const migration = text.match(/^apply ([\w.-]+\.sql)$/)?.[1];
      const stage = text.startsWith('initialising data dir') ? 'initdb'
        : text.includes('syncing data to disk') ? 'initdb:sync'
        : text.startsWith('starting postgres on ') ? 'postmaster'
        : text.startsWith('creating database ') ? 'database'
        : migration ? 'migration:' + migration : null;
      if (stage) process.send({ kind: 'isolated-runtime-bootstrap-progress', stage }, () => {});
    }
    if (cleanupStartedAt !== null) queueCleanupStage('pg-log', { message });
} });
assertNotTerminating();
console.log(`[with-test-pg] ready — ${pg.urls.admin.replace(/:[^:@]*@/, ':***@')}`);

let runtimeEnv = {};
if (isolatedRuntime) {
  // This cluster uses its own settings, not the developer host's tuned PG.
  // Non-Vitest request hosts otherwise size each org pool for that host (52
  // here), exhausting the private cluster's 97 ordinary admission slots.
  // Budget the profile helper, command and request host together; retain the
  // existing policy's overhead reservation for browser/fixture connections.
  const { default: postgres } = await import('postgres');
  const { boundedOrgPoolMax, getResourceProfile } = await import('../libs/generic/resource-profile/src/index.ts');
  const capacitySql = postgres(pg.urls.admin, { max: 1 });
  try {
    const [capacity] = await capacitySql.unsafe("SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS reserved");
    const poolMax = boundedOrgPoolMax({ desired: getResourceProfile().pgPoolMax,
      maxConnections: capacity.max, superuserReserved: capacity.reserved, expectedProcesses: 3 });
    runtimeEnv.PAPERCUSP_DB_POOL_MAX = String(poolMax);
    console.log('[with-test-pg] private pool budget ' + JSON.stringify({
      maxConnections: capacity.max, superuserReserved: capacity.reserved, expectedProcesses: 3, poolMax,
    }));
  } finally { await capacitySql.end(); }
}
if (runtimeRoot && runtimeId) {
  // Installed executables are inputs, like the browser cache below. Resolve
  // them before replacing HOME: a maintained rg shim can use Claude's embedded
  // ripgrep through $HOME/.local/bin/claude. Retain only executable paths, never
  // its product HOME, credentials, or configuration.
  const originalHome = process.env.HOME;
  const rgOverride = process.env.PAPERCUSP_RG?.trim();
  const rgAsset = await resolveExecutable(rgOverride ? [rgOverride] : [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => resolve(ROOT, dir, 'rg')),
    ...(originalHome ? [join(originalHome, '.local/bin/rg'), join(originalHome, '.cargo/bin/rg')] : []),
    '/home/linuxbrew/.linuxbrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg',
  ]);
  const claudeAsset = await resolveExecutable([
    ...(process.env.CLAUDE_CODE_EXECPATH ? [process.env.CLAUDE_CODE_EXECPATH] : []),
    ...(originalHome ? [join(originalHome, '.local/bin/claude')] : []),
  ]);
  // Rustup shims depend on HOME/settings.toml. Capture the selected installed
  // executable while the caller's toolchain configuration is still available;
  // only its binary directory crosses into the private runtime, like rg above.
  // A parent wrapper already selected this executable before isolating HOME.
  // Revalidate that input instead of consulting the now-empty Rustup settings.
  const inheritedCargo = process.env.PAPERCUSP_TEST_CARGO?.trim();
  let cargoAsset = inheritedCargo ? await resolveExecutable([inheritedCargo]) : undefined;
  if (!cargoAsset) {
    const rustupAsset = await resolveExecutable((process.env.PATH ?? '').split(delimiter)
      .filter(Boolean).map(dir => resolve(ROOT, dir, 'rustup')));
    const cargoSelection = rustupAsset ? spawnSync(rustupAsset, ['which', 'cargo'], {
      cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 5000,
    }) : null;
    cargoAsset = cargoSelection?.status === 0
      ? await resolveExecutable([cargoSelection.stdout.trim()]) : undefined;
  }
  const home = join(runtimeRoot, 'home');
  const papercuspHome = join(home, '.papercusp');
  const workspacesRoot = join(runtimeRoot, 'workspaces');
  await Promise.all([
    mkdir(papercuspHome, { recursive: true }),
    mkdir(join(workspacesRoot, runtimeId), { recursive: true }),
    mkdir(join(runtimeRoot, 'xdg-runtime'), { recursive: true, mode: 0o700 }),
    mkdir(join(runtimeRoot, 'tmp'), { recursive: true }),
  ]);
  assertNotTerminating();
  await writeFile(join(workspacesRoot, 'registry.json'), JSON.stringify({
    current: runtimeId,
    workspaces: [{ id: runtimeId, name: 'Disposable background test', createdAt: Date.now() }],
  }), { mode: 0o600 });
  const httpPort = await freePort();
  const ptyPort = await freePort();
  assertNotTerminating();
  if (httpPort === ptyPort || httpPort === port || ptyPort === port) {
    console.error('[with-test-pg] isolated runtime port collision — refusing to launch');
    await cleanup();
    process.exit(1);
  }
  runtimeEnv = {
    ...runtimeEnv,
    ...(rgAsset ? { PAPERCUSP_RG: rgAsset } : {}),
    ...(claudeAsset ? { CLAUDE_CODE_EXECPATH: claudeAsset } : {}),
    ...(cargoAsset ? { PAPERCUSP_TEST_CARGO: cargoAsset, PATH: dirname(cargoAsset) + delimiter + (process.env.PATH ?? '') } : {}),
    HOME: home,
    PAPERCUSP_HOME: papercuspHome,
    // The mutex coordinates mutations against the shared checkout and host
    // package cache. Keep its caller's account-wide root even though this
    // isolated child has a private HOME; otherwise it can split the lock domain.
    PAPERCUSP_FS_MUTEX_LOCK_DIR: resolveFsMutexLockRoot(process.env),
    PAPERCUSP_IDENTITY_DIR: join(papercuspHome, 'identity'),
    PAPERCUSP_WORKSPACES_ROOT: workspacesRoot,
    PAPERCUSP_WORKSPACE: runtimeId,
    PAPERCUSP_WORKSPACE_ID: runtimeId,
    PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${httpPort}`,
    PAPERCUSP_API_BASE: `http://127.0.0.1:${httpPort}`,
    HARNESS_ADMIN_DATABASE_URL: pg.urls.admin,
    HARNESS_DATABASE_URL: pg.urls.app,
    PAPERCUSP_HONO_PORT: String(httpPort),
    OPERATOR_DEV_PORT: String(httpPort),
    OPERATOR_DEV_PTY_PORT: String(ptyPort),
    PAPERCUSP_BIND_HOST: '127.0.0.1',
    // Match the maintained host allocator launcher policy before first exec
    // (bin/malloc-arena-reexec.ts). Otherwise boot-malloc-arena repeats the
    // complete module load before a private readiness probe can succeed.
    MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? '2',
    PAPERCUSP_BACKGROUND_WORKERS: operatorApi ? '0' : '1',
    PAPERCUSP_DBOS_ENABLE: operatorApi ? '0' : '1',
    PAPERCUSP_DBOS_ORCHESTRATOR: operatorApi ? '0' : '1',
    // The test starts explicit background work; global scheduled routines may
    // otherwise act on the shared checkout or external services during boot.
    // The orchestrator's own tick has a separate opt-out: an unset harness
    // override schedules every harness even when routines and timers are off.
    PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none',
    PAPERCUSP_DBOS_ROUTINES: '0',
    PAPERCUSP_DBOS_TIMERS: '0',
    PAPERCUSP_DBOS_AUTOLOOP: '0',
    DBOS__VMID: runtimeId,
    DBOS__APPVERSION: runtimeId,
    PAPERCUSP_CLUSTER: '0',
    PAPERCUSP_CLUSTER_WORKERS: '0',
    PAPERCUSP_SPAWNER_SIDECAR: '0',
    PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '0',
    PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR: '0',
    PAPERCUSP_POT_GIT_SPAWN_SIDECAR: '0',
    PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR: '0',
    PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR: '0',
    XDG_DATA_HOME: join(runtimeRoot, 'xdg-data'),
    XDG_CACHE_HOME: join(runtimeRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: join(runtimeRoot, 'xdg-config'),
    XDG_STATE_HOME: join(runtimeRoot, 'xdg-state'),
    XDG_RUNTIME_DIR: join(runtimeRoot, 'xdg-runtime'),
    ...(managedTaskBusAddress ? { DBUS_SESSION_BUS_ADDRESS: managedTaskBusAddress } : {}),
    // Original proof receipts must survive this private HOME's teardown.
    // Pin the caller's maintained root before isolating product state; nested
    // wrappers inherit this same absolute root instead of nesting it in HOME.
    VH_EVIDENCE_ROOT_BASE: resolve(dirname(defaultEvidenceRoot('isolated-integration'))),
    // Browser installations are maintained executable assets, not mutable
    // operator state. Pin their original cache before isolating HOME/XDG;
    // otherwise Playwright silently resolves an empty runtime-local cache.
    PLAYWRIGHT_BROWSERS_PATH: browserCachePath(process.env),
    PAPERCUSP_PG_SQL_DIR: sqlDir,
    PAPERCUSP_TEST_RUNTIME_TMP_BASE: runtimeTmpBase,
    TMPDIR: join(runtimeRoot, 'tmp'),
  };
}

const childEnv = { ...process.env };
// A product DSN pin outranks PAPERCUSP_PG_PORT in both connection resolvers.
// Keeping an ambient DATABASE_URL made ordinary affected integration workers
// select the live server even though their private port was propagated correctly
// (EI-25710110190006866). Clear pins rather than injecting HARNESS_* overrides:
// tests exercising the resolution chain must be able to set their own values.
// The reporter's explicit PAPERCUSP_TEST_RUNS_DB_URL is a separate evidence sink.
for (const key of ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL']) {
  delete childEnv[key];
}
if (isolatedRuntime) {
  // Start from no ambient operator identity, endpoints, IPC or credentials.
  // HOME alone is insufficient: an inherited PAPERCUSP_SUBSTRATE_IPC_SOCKET,
  // API base or DHT bootstrap can still join the running operator.
  // The existing test reporters have a separate explicit ledger sink and
  // attribution contract. Preserve only those keys; product pools still receive
  // the private runtime URLs below, and unrelated PAPERCUSP_ keys stay scrubbed.
  const evidenceKeys = new Set([
    // Verifier ownership identifies the enclosing managed task, not the private
    // product identity. Its receipt must survive runtime isolation for cleanup.
    'PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID',
    // Optional receipts from the existing committed-source loader are evidence,
    // not an operator identity or endpoint. Retain them in the profile child.
    'PAPERCUSP_COMMITTED_SOURCE_AUDIT', 'PAPERCUSP_COMMITTED_SOURCE_NOTICES',
    // This is the test router's execution contract, not a product endpoint.
    // Multi-process proofs validate it before allocating their nested runtime.
    'PAPERCUSP_TEST_FILE_TIMEOUT_MS',
    'PAPERCUSP_TEST_RUNS_DB_URL', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
    'PAPERCUSP_TEST_RUN_WORKSPACE', 'PAPERCUSP_TEST_RUN_HARNESS',
    'PAPERCUSP_TEST_RUN_GROUP', 'PAPERCUSP_TEST_RUN_SOURCE',
    'PAPERCUSP_TEST_RUN_COMMIT', 'PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN',
    'PAPERCUSP_TEST_RUN_LOOP_LAG_P95_MS',
    // The reporter needs the maintained probe's phase and original checkout
    // to distinguish an expected mutant failure from an ordinary dirty run.
    'PAPERCUSP_MUTATION_PROBE', 'PAPERCUSP_MUTATION_PHASE',
    'PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT', 'PAPERCUSP_MUTATION_PROBE_SUBJECT',
    // What the probe mutated (libs/test-config/src/mutation-descriptor.ts).
    'PAPERCUSP_MUTATION_DESCRIPTOR',
    // The explicitly selected parser reader, source checkout and fail-closed
    // requirement are mutation evidence provenance, not product endpoints.
    'PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL',
    'PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO',
    'PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED',
  ]);
  for (const key of Object.keys(childEnv)) {
    if (evidenceKeys.has(key)) continue;
    if (/^(PAPERCUSP_|HARNESS_|DBOS__|PG[A-Z]|DATABASE_URL$|AWS_|AZURE_|GOOGLE_|GCP_|OPENAI_|ANTHROPIC_|GITHUB_|GH_|CLOUDSDK_|DOCKER_|GIT_ASKPASS$|GIT_CONFIG_|SSH_AUTH_SOCK$|CODEX_HOME$|VITEST(?:_|$)|DBUS_SESSION_BUS_ADDRESS$|GNOME_KEYRING_CONTROL$)/i.test(key)) {
      delete childEnv[key];
    }
  }
  if (callerTestRunWorkspace) childEnv.PAPERCUSP_TEST_RUN_WORKSPACE = callerTestRunWorkspace;
}
if (operatorApi) {
  // A request journey needs the same isolation as a background test, but must
  // not boot DBOS/substrate owners or load an ONNX model in the request host.
  // Reuse the actual registry and sidecar factory in a separate owned process;
  // never inherit the live sidecar, register the shared checkout, or disable
  // the host's memory watchdog. Preflight completes BEFORE the command starts.
  runtimeEnv.PAPERCUSP_POT_HOME_SLUG = runtimeId;
  // Tunnel connectors must use the host's maintained no-local-trust listener,
  // never the desktop loopback API (which can mint pairing tokens).
  let ingressPort;
  do { ingressPort = await freePort(); }
  while ([port, Number(runtimeEnv.PAPERCUSP_HONO_PORT), Number(runtimeEnv.OPERATOR_DEV_PTY_PORT)].includes(ingressPort));
  assertNotTerminating();
  runtimeEnv.PAPERCUSP_EXTERNAL_INGRESS_PORT = String(ingressPort);
  const profileSource = `
    import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
    const started = performance.now();
    const loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
    let activeStage = 'process-start';
    let activePhase = 'start';
    const send = (name, detail = {}) => process.send({ stage: name,
      childPid: process.pid, childElapsedMs: performance.now() - started,
      childEmittedAtMs: performance.timeOrigin + performance.now(),
      childEventLoopDelayMaxMs: loopDelay.max / 1e6, ...detail });
    const stage = (name, detail = {}) => {
      activeStage = name;
      activePhase = detail.phase ?? 'stage';
      send(name, detail);
    };
    // A child timestamp and heartbeat keep import execution separate from the
    // parent's IPC receive time. Neither heartbeat extends the readiness limit.
    const heartbeat = setInterval(() => send(activeStage,
      { heartbeat: true, phase: activePhase }), 1000);
    heartbeat.unref();
    const trackedImport = async (name, specifier) => {
      const importStarted = performance.now();
      stage(name, { phase: 'start' });
      try {
        const imported = await import(specifier);
        stage(name, { phase: 'ready', operationDurationMs: performance.now() - importStarted });
        return imported;
      } catch (error) {
        stage(name, { phase: 'failed', operationDurationMs: performance.now() - importStarted });
        throw error;
      }
    };
    import { mkdir } from 'node:fs/promises';
    import { join } from 'node:path';
    const { saveHarnessRegistry, loadHarnessRegistry } = await trackedImport('imports:harness-registry', './packages/operator-core/lib/harness-registry.ts');
    const { createEmbedSidecarServer } = await trackedImport('imports:embed-sidecar', './packages/operator-core/lib/memory/embed-sidecar-server.ts');
    const { getOrgPg, upsertRoutine } = await trackedImport('imports:db-org', '@papercusp/db-org');
    const { releaseGateTile } = await trackedImport('imports:device-monitoring', './packages/operator-core/lib/device-monitoring.ts');
    stage('private-registry');
    const id = process.env.PAPERCUSP_WORKSPACE_ID;
    const home = join(process.env.PAPERCUSP_WORKSPACES_ROOT, id, 'operator-home');
    await mkdir(home, { recursive: true });
    await saveHarnessRegistry({ projects: [{ slug: id, path: home, harness_kind: 'hive' }] }, id);
    const registry = await loadHarnessRegistry(id, { fresh: true });
    if (!registry.projects.some(p => p.slug === id && p.path === home)) throw new Error('private home harness was not registered');
    // The first native spawn signs before an MCP request can lazily mint the
    // verifier's key. Reuse fresh-database provisioning, before admitting work.
    stage('private-spawn-signing-key');
    const { premintSpawnSigningKey } = await trackedImport('imports:spawn-signing-key', './packages/operator-core/lib/gym/gym-db-init.ts');
    const { sql } = getOrgPg();
    await premintSpawnSigningKey(sql);
    const signingRows = await sql\`SELECT octet_length(decode(value_b64, 'base64')) AS bytes
      FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key'\`;
    if (signingRows.length !== 1 || signingRows[0].bytes !== 32) throw new Error('private spawn-signing key preflight failed');
    // Inbox refuses an unmeasured system source. An empty disposable database
    // has no pipeline at all, so register an explicitly PAUSED fixture through
    // the maintained routine store. Never manufacture a green verdict or arm
    // a release action against the developer's checkout.
    stage('paused-routine');
    await upsertRoutine(sql, { workspaceId: id, installSlug: id,
      name: 'green-checkpoint', triggerKind: 'api', triggerConfig: {},
      targetRole: 'operator', active: false, nextFireAt: null }, () => null);
    const pause = { reason: 'Disposable operator-api fixture; publication disabled',
      pausedBy: id, pausedAtMs: Date.now() };
    await sql\`UPDATE harness_shared.routines SET metadata = \${sql.json({ pause })}
      WHERE workspace_id = \${id} AND install_slug = \${id} AND name = 'green-checkpoint'\`;
    stage('measure-private-gate');
    const { fetchOrientPipeline } = await trackedImport('imports:pipeline-health', './packages/operator-core/lib/agent-tools/coordination/pipeline-health.ts');
    const { computePipelineHealth } = await trackedImport('imports:why-chain', './packages/operator-core/lib/why-chain.ts');
    const { gitPipelineSnapshot } = await trackedImport('imports:git-pipeline-stats', './packages/operator-core/lib/git-pipeline-stats.ts');
    const pendingGateSources = new Set();
    const gate = await releaseGateTile(id, { fetch: (slug) => fetchOrientPipeline(slug, {
      compute: (slug) => computePipelineHealth({ slug, harnessSlug: slug,
        loadSnapshot: () => gitPipelineSnapshot(slug, { useSpawnerSidecar: false,
          onProgress: (name) => {
            const [source, state] = name.split(':');
            if (state === 'start') pendingGateSources.add(source);
            else pendingGateSources.delete(source);
            stage('measure-private-gate:' + name, { pendingGateSources: [...pendingGateSources] });
          } }) }),
    }) });
    if (!gate || gate.gate !== 'wedged' || !gate.red) {
      throw new Error('private paused pipeline was not measured; refusing request journey');
    }
    stage('sidecar-listen');
    const sidecar = createEmbedSidecarServer({ port: 0, warmAtBoot: false });
    const port = await sidecar.listening;
    clearInterval(heartbeat);
    loopDelay.disable();
    process.on('SIGTERM', async () => { await sidecar.close(); process.exit(0); });
    process.send({ ready: true, url: 'http://127.0.0.1:' + port, homeHarness: id });
  `;
  try {
    const profileStartedAtMs = performance.timeOrigin + performance.now();
    const profileSourceSha256 = createHash('sha256').update(profileSource).digest('hex');
    profileProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', profileSource], {
      cwd: ROOT, env: { ...childEnv, ...runtimeEnv, PAPERCUSP_PG_PORT: String(port), PAPERCUSP_SKIP_PG_DISCOVERY: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
    });
    let errors = '';
    profileLifetime = processGroupLifetime(profileProcess, message => console.error('[with-test-pg] ' + message));
    for (const stream of [profileProcess.stdout, profileProcess.stderr]) {
      stream.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-6000); });
    }
    const ready = await new Promise((res, rej) => {
      let lastStage = 'process-start';
      let pendingGateSources = [];
      let lastTiming = null;
      let parentLoopLateMaxMs = 0;
      let expectedTick = performance.now() + 100;
      const loopSample = setInterval(() => {
        const now = performance.now();
        parentLoopLateMaxMs = Math.max(parentLoopLateMaxMs, now - expectedTick);
        expectedTick = now + 100;
      }, 100);
      const started = Date.now();
      const timer = setTimeout(() => failed(new Error('operator-api profile preflight timed out at ' + lastStage +
        '; pending gate sources=' + pendingGateSources.join(',') +
        '; timing=' + JSON.stringify({ lastTiming, parentLoopLateMaxMs, profileSourceSha256 }) + ': ' + errors)), 45000);
      const failed = (error) => { clearTimeout(timer); clearInterval(loopSample); rej(error); };
      profileProcess.once('error', failed);
      profileProcess.once('exit', (code, signal) => failed(new Error('operator-api profile exited ' + code + '/' + signal + ': ' + errors)));
      profileProcess.on('message', (message) => {
        if (typeof message?.stage === 'string') {
          if (!message.heartbeat) lastStage = message.stage;
          if (Array.isArray(message.pendingGateSources)) pendingGateSources = message.pendingGateSources;
          const parentReceivedAtMs = performance.timeOrigin + performance.now();
          lastTiming = { stage: message.stage, phase: message.phase ?? 'stage',
            heartbeat: message.heartbeat === true, childPid: message.childPid,
            childElapsedMs: message.childElapsedMs, childEmittedAtMs: message.childEmittedAtMs,
            childEventLoopDelayMaxMs: message.childEventLoopDelayMaxMs,
            operationDurationMs: message.operationDurationMs,
            parentReceivedAtMs, parentElapsedMs: parentReceivedAtMs - profileStartedAtMs,
            deliveryDelayMs: parentReceivedAtMs - message.childEmittedAtMs,
            parentLoopLateMaxMs, profileSourceSha256 };
          console.log('[with-test-pg] operator-api stage ' + lastStage + ' +' + (Date.now() - started) + 'ms' +
            (Array.isArray(message.pendingGateSources) ? ' pending=' + JSON.stringify(pendingGateSources) : '') +
            ' timing=' + JSON.stringify(lastTiming));
          if (!message.heartbeat && process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && process.connected) {
            process.send({ kind: 'isolated-runtime-bootstrap-progress', stage: 'profile:' + lastStage }, () => {});
          }
          return;
        }
        clearTimeout(timer);
        clearInterval(loopSample);
        res(message);
      });
    });
    assertNotTerminating();
    if (!ready?.ready || ready.homeHarness !== runtimeId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url)) {
      throw new Error('operator-api profile returned an invalid private identity');
    }
    const response = await fetch(ready.url + '/healthz', { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    if (!response.ok || health.pid !== profileProcess.pid || !health.capabilities?.includes('POST /embed')) {
      throw new Error('operator-api private embedding sidecar failed capability/owner preflight');
    }
    runtimeEnv.PAPERCUSP_EMBED_SIDECAR_URL = ready.url;
    console.log('[with-test-pg] operator-api preflight ready — private home harness, measured paused pipeline and embedding sidecar; background/DBOS disabled');
  } catch (error) {
    console.error('[with-test-pg] operator-api preflight failed: ' + (error?.stack ?? error));
    await cleanup();
    process.exit(1);
  }
}
assertNotTerminating();
const observedRuntime = isolatedRuntime && process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && process.send;
const startToken = observedRuntime ? randomUUID() : null;
if (observedRuntime && resolve(cmd[0]) !== process.execPath) {
  throw new Error('original lifetime proof requires the maintained Node worker route');
}
const childArgs = observedRuntime
  ? ['--import', join(ROOT, 'scripts/lib/isolated-runtime-start.mjs'), ...cmd.slice(1)] : cmd.slice(1);
// Integration setup has its own admin resolver. Pin it to this supervisor's
// actual private cluster in every mode, without changing the product's
// HARNESS_* env-resolution cases in the ordinary wrapper.
const testAdminUrl = new URL(pg.urls.admin);
if (!['postgres:', 'postgresql:'].includes(testAdminUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(testAdminUrl.hostname) || testAdminUrl.port !== String(port) ||
    !testAdminUrl.username || !testAdminUrl.pathname.slice(1)) {
  throw new Error('private integration admin preflight failed: URL does not identify the owned Postgres');
}
if (managedTasks) managedTaskCleanupEnv = { ...childEnv, ...runtimeEnv,
  PAPERCUSP_PG_PORT: String(port), PAPERCUSP_SKIP_PG_DISCOVERY: '1' };
child = spawn(cmd[0], childArgs, {
  cwd: ROOT,
  stdio: observedRuntime ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
  env: {
    ...childEnv,
    // PAPERCUSP_PG_PORT is the repo's OWN isolation lever for "this process owns a
    // dedicated PG" (see connection.ts's two native fallbacks and its pgbouncer
    // opt-out, and harness-invoke-once.ts: "getHarnessAdminUrl() honors
    // PAPERCUSP_PG_PORT, so isolated ..."). Both resolvers build their fallback URL
    // from it, which is all the throwaway PG needs.
    //
    // Deliberately NOT exporting HARNESS_ADMIN_DATABASE_URL / HARNESS_DATABASE_URL:
    // those are step 1 of the resolution chain, and injecting them changes the
    // behaviour of the very code under test — it broke harness-invoke-once.test.ts's
    // env-resolution cases (52/52 → 2 failures) purely because the runner had set
    // them. A test harness must not perturb the tests it runs.
    PAPERCUSP_PG_PORT: String(port),
    // Belt-and-braces: the unit layer pins this too, but a non-vitest child (a script,
    // a CLI) must also never resolve the *product's* live embedded PG.
    PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    ...runtimeEnv,
    PAPERCUSP_TEST_PG_ADMIN_URL: testAdminUrl.toString(),
    ...(observedRuntime ? { PC_ISOLATED_RUNTIME_START_TOKEN: startToken } : {}),
  },
  detached: isolatedRuntime,
});
if (isolatedRuntime && child.pid) {
  childLifetime = processGroupLifetime(child, message => console.error('[with-test-pg] ' + message));
}

// The test parent measures these PIDs during their actual lifetime. Ordinary
// runs have no IPC observer and pay no receipt cost.
if (observedRuntime) {
  let announced = false;
  const acknowledge = message => {
    if (!announced || message?.kind !== 'isolated-runtime-observed' || message.childPid !== child.pid || message.token !== startToken) return;
    process.off('message', acknowledge);
    child.send({ kind: 'isolated-worker-observed', token: startToken, accepted: message.accepted === true });
  };
  process.on('message', acknowledge);
  child.on('message', message => {
    if (announced || message?.kind !== 'isolated-worker-ready' || message.token !== startToken) return;
    announced = true;
    process.send({ kind: 'isolated-runtime-start', supervisorPid: process.pid, childPid: child.pid,
      workspace: runtimeId, runtimeRoot, dataDir, pgPort: port, root: ROOT, token: startToken });
  });
  child.once('exit', () => process.off('message', acknowledge));
}

child.on('error', async (error) => {
  console.error(`[with-test-pg] child failed to start: ${error.message}`);
  // Cleanup may release the last event-loop handle. Set failure BEFORE it can
  // trigger a natural/exit-hook exit, and explicitly propagate it afterward.
  process.exitCode = 1;
  await cleanup();
  process.exit(1);
});

child.on('exit', async (code, signal) => {
  await finishChild(code, signal);
});
}

function finishChild(code, signal) {
  return childFinishPromise ??= finishChildOwned(code, signal).catch(error => {
    // Unverified descendants must retain the private state, never report a
    // successful cleanup or propagate the child's successful exit code.
    console.error('[with-test-pg] cleanup failed: ' + (error?.stack ?? error));
    process.exit(1);
  });
}
async function finishChildOwned(code, signal) {
  try {
    await sendCleanupReceipt({ kind: 'isolated-runtime-stopping', childPid: child.pid, exitCode: code, signal });
  } catch (cause) {
    // A failed stopping receipt must not bypass the actual owned stops.
    recordCleanupReceiptFailure('isolated-runtime-stopping', cause);
  }
  await cleanup();
  await sendCleanupReceipt({ kind: 'isolated-runtime-end', childPid: child.pid,
    exitCode: code, signal, runtimeRemoved: !existsSync(runtimeRoot), pgDataRemoved: !existsSync(dataDir) });
  if (signal) {
    // The forwarding handler has already run. Restore the native signal exit
    // after cleanup rather than forwarding the signal back to a dead child.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  else process.exit(code ?? 1);
}

main().catch(async error => {
  console.error(`[with-test-pg] bootstrap failed: ${error?.stack ?? error}`);
  await cleanup();
  process.exit(terminatingSignal === 'SIGTERM' ? 143 : terminatingSignal === 'SIGINT' ? 130 : 1);
});
