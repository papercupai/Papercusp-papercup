/** Original lifetime proof for disposable with-test-pg workers. Reuses runHarness retention. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readlinkSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { defaultEvidenceRoot, runHarness } from '@papercusp/verification-harness';
import { resolveTestRunHarnessSlug, resolveTestRunWorkspaceId } from '@papercusp/test-config/admin-test-runs-reporter';
import { linuxPpidFromProcStat, readProcessIdentity } from '../lib/process-identity';
import { readCommittedFiles } from '../lib/agent-tools/plans/committed-tree-reader';
import { qualifyCommittedReaderOriginalPreparation as qualifyOriginalPreparation } from './private-http-workspace-preflight';
import { it } from 'vitest';
// @ts-ignore -- reuse the maintained JS router's deadline contract.
import { testFileListTimeoutMs, testFileRunTimeoutMs, MAX_TEST_FILE_RUN_TIMEOUT_MS, TEST_FILE_KILL_GRACE_MS, TEST_FILE_SCOPE_STOP_TIMEOUT_SEC } from '../../../scripts/test-files.mjs';
// @ts-ignore -- same progress watchdog used by that router.
import { createProgressAwareWatchdog } from '../../../scripts/lib/batch-watchdog.mjs';

/** Own the parent reader's delayed telemetry until it has been flushed. The
 * child runtime's private DB does not route getOrgPg() in this process. Reuse
 * the migrated org fixture and its canonical pool/URL pinning, preserving the
 * live-target guard and the reader's ordinary sidecar/fallback behavior. */
export async function withIsolatedIntegrationSourceObserver<T>(
  capture: (sql: import('postgres').Sql) => Promise<T>,
) {
  const { createOrgTestDb } = await import('./_org-test-db');
  const { setupBaselineCoordFixture } = await import('../lib/_baseline-coord-fixture');
  const { flushFallbackObservations } = await import('../lib/degradation/fallback-observations');
  const db = await createOrgTestDb();
  const previous = {
    HARNESS_DATABASE_URL: process.env.HARNESS_DATABASE_URL,
    HARNESS_ADMIN_DATABASE_URL: process.env.HARNESS_ADMIN_DATABASE_URL,
  };
  let fixture: Awaited<ReturnType<typeof setupBaselineCoordFixture>> | undefined;
  try {
    fixture = await setupBaselineCoordFixture({ dsn: db.adminDsn });
    const value = await capture(db.adminSql);
    const flush = await flushFallbackObservations({ sql: db.adminSql });
    assert.equal(flush.failed, 0, 'private parent fallback observations must persist');
    return { value, database: db.dbName, flush };
  } finally {
    try {
      // Also drain observations when capture throws, before retiring its pool.
      const flush = await flushFallbackObservations({ sql: db.adminSql });
      assert.equal(flush.failed, 0, 'private parent fallback observations must persist at teardown');
    } finally {
      try { await fixture?.dispose(); }
      finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await db.cleanup();
      }
    }
  }
}

/** Shared with the cheap context guard so the expensive fixture uses the tested API. */
export const isolatedIntegrationCases = it.for([false, true]);

/** Cleanup logs must not displace a worker's original structured assertion. */
export function isolatedWorkerFailureDetail(output: string): string {
  const lines = output.split('\n');
  const failures = lines.filter(line => /^[A-Z][A-Z0-9_]*_FAILURE /.test(line));
  if (failures.length) return failures.map(line => line.slice(0, 4_000)).join('\n');
  const fatal = lines.findIndex(line => /^\w*Error(?: \[[^\]]+\])?:/.test(line.trim()));
  return fatal >= 0 ? lines.slice(fatal, fatal + 12).join('\n').slice(0, 4_000) : output.slice(-4_000);
}

/** Prefer semantic work over cleanup chatter when an execute deadline fires. */
export function isolatedWorkerPendingStage(evidenceDir: string) {
  const path = join(evidenceDir, 'worker-progress.ndjson');
  if (!existsSync(path)) return null;
  const active = new Map<string, Record<string, unknown>>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.stage !== 'string') continue;
      if (row.stage.endsWith('-start')) active.set(row.stage.slice(0, -6), row);
      else if (row.stage.endsWith('-complete')) active.delete(row.stage.slice(0, -9));
      else if (row.stage.endsWith('-failed')) active.delete(row.stage.slice(0, -7));
    } catch { /* A killed writer may leave an incomplete final line. */ }
  }
  return [...active.values()].at(-1) ?? null;
}

/** Persist at the observation boundary, before a timeout can erase private state. */
export function retainIsolatedWorkerProgress(evidenceDir: string, stage: string, evidence: Record<string, unknown> = {}) {
  appendFileSync(join(evidenceDir, 'worker-progress.ndjson'), JSON.stringify({
    stage, observedAt: new Date().toISOString(), ...evidence,
  }) + '\n');
}

/** Snapshot native child diagnostics while its disposable home still exists.
 * Missing or shrinking files are explicit and never erase captured output. */
export function retainIsolatedNativeTaskDiagnostics(evidenceDir: string, task: Record<string, unknown>,
  sources: Partial<Record<'stdout' | 'normalized' | 'boot', string>>) {
  const files = Object.fromEntries(Object.entries(sources).map(([kind, source]) => {
    try {
      const bytes = readFileSync(source);
      const retained = join(evidenceDir, `native-task-${kind}.log`);
      const retainedBytes = existsSync(retained) ? statSync(retained).size : 0;
      if (bytes.length < retainedBytes)
        return [kind, { source, bytes: bytes.length, retainedBytes, captured: false, reason: 'source-shrank' }];
      writeFileSync(retained, bytes, { mode: 0o600 });
      return [kind, { source, bytes: bytes.length, captured: true }];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [kind, { source, captured: false, reason: 'missing' }];
    }
  }));
  writeFileSync(join(evidenceDir, 'native-task-diagnostics.json'), JSON.stringify({
    observedAt: new Date().toISOString(), task, files,
  }), { mode: 0o600 });
}

/** Launch may return a refusal receipt or throw after enrolling a task. Capture
 * either outcome before the caller can dispose of its native home. A failed
 * diagnostic must remain visible without replacing the original launch error. */
export async function withIsolatedNativeLaunchDiagnostics<T>(evidenceDir: string,
  launch: () => Promise<T>, capture: () => Promise<void>): Promise<T> {
  let launchFailed = false;
  try { return await launch(); }
  catch (error) { launchFailed = true; throw error; }
  finally {
    try { await capture(); }
    catch (error) {
      retainIsolatedWorkerProgress(evidenceDir, 'launch-diagnostics-failed', { error: String(error) });
      if (!launchFailed) throw error;
    }
  }
}

/** A reaped signal termination proves cleanup, while the execute verdict stays failed. */
export function assertIsolatedWorkerReaped(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  ended: { runtimeRemoved?: boolean; pgDataRemoved?: boolean } | undefined) {
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'original supervisor must be reaped');
  assert.ok(ended?.runtimeRemoved && ended.pgDataRemoved, 'original private runtime and database cleanup required');
}

type WorkerPhase = 'bootstrap' | 'execute' | 'teardown';
type WorkerDeadlines = { bootstrapMs: number; bootstrapMaxMs?: number; executeMs: number; teardownMs: number; teardownMaxMs?: number; executeMaxMs?: number };

/** Compose the actual nested router contract; startup consumes none of its
 * collection/execution allowance. Teardown allows the router's cgroup stop,
 * the private API's five-second stop, and a thirty-second PG progress checkpoint.
 * Actual PG write progress can extend cleanup within the configured file ceiling;
 * repeated stages, logs and unchanged IO cannot renew it. No budget is proof of cleanup.
 */
export function isolatedWorkerOptions(executeMs: number, env: NodeJS.ProcessEnv = process.env, executeMaxMs = executeMs) {
  const listMs = testFileListTimeoutMs(env);
  const teardownMs = TEST_FILE_SCOPE_STOP_TIMEOUT_SEC * 1000 + 5_000 + 30_000;
  const phaseTimeouts: WorkerDeadlines = {
    // Collection time is a progress checkpoint, not a maximum PG boot time.
    // Use the configured single-file verification allowance as the absolute
    // preparation ceiling; only distinct observed boot stages can extend it.
    bootstrapMs: listMs,
    bootstrapMaxMs: Math.max(listMs, testFileRunTimeoutMs(env, 1)),
    executeMs,
    executeMaxMs,
    teardownMs,
    teardownMaxMs: Math.max(teardownMs, testFileRunTimeoutMs(env, 1)),
  };
  return { phaseTimeouts, killGraceMs: teardownMs, drainGraceMs: 5_000,
    testTimeoutMs: phaseTimeouts.bootstrapMaxMs! + phaseTimeouts.executeMaxMs! + phaseTimeouts.teardownMaxMs! + teardownMs + 20_000 };
}

export function isolatedTestFileWorkerOptions(env: NodeJS.ProcessEnv, fileCount: number) {
  const listMs = testFileListTimeoutMs(env);
  return isolatedWorkerOptions(listMs + testFileRunTimeoutMs(env, fileCount) + TEST_FILE_KILL_GRACE_MS,
    env, listMs + MAX_TEST_FILE_RUN_TIMEOUT_MS + TEST_FILE_KILL_GRACE_MS);
}

/** Retain original output before termination can interrupt the fixture. A
 * descendant holding stdio must not turn a completed supervisor into a wait
 * without a deadline. Failure receipts never stand in for successful cleanup.
 */
export function captureIsolatedWorker(child: ChildProcess, evidenceDir: string, options: {
  timeoutMs?: number; phaseTimeouts?: WorkerDeadlines; killGraceMs?: number; drainGraceMs?: number;
  cleanupFromStdout?: boolean;
}) {
  assert.ok((options.timeoutMs === undefined) !== (options.phaseTimeouts === undefined), 'one deadline contract is required');
  const deadlines = options.phaseTimeouts;
  for (const ms of [options.timeoutMs, ...Object.values(deadlines ?? {}), options.killGraceMs, options.drainGraceMs]) {
    assert.ok(ms === undefined || Number.isSafeInteger(ms) && ms > 0, 'deadlines must be positive safe integers');
  }
  assert.ok(!deadlines || !deadlines.executeMaxMs || deadlines.executeMaxMs >= deadlines.executeMs);
  assert.ok(!deadlines || !deadlines.bootstrapMaxMs || deadlines.bootstrapMaxMs >= deadlines.bootstrapMs);
  assert.ok(!deadlines || !deadlines.teardownMaxMs || deadlines.teardownMaxMs >= deadlines.teardownMs);
  let ownsProcessGroup = false;
  if (process.platform === 'linux' && child.pid) {
    try {
      const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      ownsProcessGroup = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[2]) === child.pid;
    } catch { /* child already exited; retain its observed exit */ }
  }
  const killWorker = (signal: NodeJS.Signals) => {
    if (ownsProcessGroup && child.pid) {
      try { process.kill(-child.pid, signal); } catch { /* owned group already exited */ }
    } else child.kill(signal);
  };
  const fd = openSync(join(evidenceDir, 'worker.log'), 'wx');
  const grace = options.killGraceMs ?? TEST_FILE_SCOPE_STOP_TIMEOUT_SEC * 1000 + 5_000 + 30_000;
  const drainGrace = options.drainGraceMs ?? options.killGraceMs ?? 5_000;
  let output = '';
  let timedOut = false;
  let phase: WorkerPhase = 'bootstrap';
  let timeoutPhase: WorkerPhase | null = null;
  let exitWaitTimedOut = false;
  let stdioDrainTimedOut = false;
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
    timeoutPhase: WorkerPhase | null; exitWaitTimedOut: boolean; stdioDrainTimedOut: boolean; output: string }>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let progressWatchdog: ReturnType<typeof createProgressAwareWatchdog> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let exitWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const bootStages = new Set<string>();
    const cleanupStages = new Set<string>();
    const cleanupIo = new Map<string, { writes: bigint; bytes: bigint }>();
    let cleanupLine = '';
    const capture = (chunk: string) => {
      output += chunk; writeSync(fd, chunk);
      if (phase === 'execute') progressWatchdog?.noteProgress();
      if (options.cleanupFromStdout && deadlines) {
        cleanupLine += chunk;
        const lines = cleanupLine.split('\n');
        cleanupLine = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith('[with-test-pg] cleanup ')) continue;
          try {
            const value = JSON.parse(line.slice('[with-test-pg] cleanup '.length));
            if (value.kind !== 'isolated-runtime-cleanup' || value.supervisorPid !== child.pid) continue;
            // Ordinary CLI runs have no original-worker IPC admission. Their
            // structured cleanup start still separates boot from teardown;
            // this controls deadlines only and creates no lifetime proof.
            if (value.stage === 'start' && phase !== 'teardown') armPhase('teardown');
            message(value);
          } catch { /* incomplete or unrelated output is not lifecycle evidence */ }
        }
      }
    };
    const armPhase = (next: WorkerPhase) => {
      clearTimeout(timeout);
      progressWatchdog?.stop();
      phase = next;
      const ms = deadlines![next === 'bootstrap' ? 'bootstrapMs' : next === 'execute' ? 'executeMs' : 'teardownMs'];
      if (next === 'bootstrap' && deadlines!.bootstrapMaxMs) {
        progressWatchdog = createProgressAwareWatchdog({ timeoutMs: ms, maxMs: deadlines!.bootstrapMaxMs,
          stallWindowMs: ms, extensionMs: ms, onKill: terminate });
      } else if (next === 'execute' && deadlines!.executeMaxMs) {
        progressWatchdog = createProgressAwareWatchdog({ timeoutMs: ms, maxMs: deadlines!.executeMaxMs,
          stallWindowMs: 5 * 60_000, extensionMs: 5 * 60_000, onKill: terminate });
      } else if (next === 'teardown' && deadlines!.teardownMaxMs) {
        progressWatchdog = createProgressAwareWatchdog({ timeoutMs: ms, maxMs: deadlines!.teardownMaxMs,
          stallWindowMs: ms, extensionMs: ms, onKill: terminate });
      } else timeout = setTimeout(terminate, ms);
    };
    const message = (value: unknown) => {
      appendFileSync(join(evidenceDir, 'runtime-events.ndjson'), JSON.stringify(value) + '\n');
      if (!deadlines || timedOut || !value || typeof value !== 'object') return;
      const kind = (value as { kind?: string }).kind;
      const stage = (value as { stage?: unknown }).stage;
      if (phase === 'bootstrap' && kind === 'isolated-runtime-bootstrap-progress' && typeof stage === 'string' &&
          /^(initdb(?::sync)?|postmaster|database|migration:[\w.-]+|profile:[\w:-]+)$/.test(stage) && !bootStages.has(stage)) {
        bootStages.add(stage);
        progressWatchdog?.noteProgress();
      }
      // Repeated or out-of-order IPC cannot renew a phase's deadline.
      if (kind === 'isolated-runtime-start' && phase === 'bootstrap') armPhase('execute');
      else if ((kind === 'isolated-runtime-stopping' || kind === 'isolated-runtime-end') && phase === 'execute') armPhase('teardown');
      if (phase === 'teardown' && kind === 'isolated-runtime-cleanup') {
        if (typeof stage === 'string' && /^(start|profile-stop|pg-stop|pg-stopped|remove-private-state|complete)$/.test(stage) && !cleanupStages.has(stage)) {
          cleanupStages.add(stage);
          progressWatchdog?.noteProgress();
        }
        if (stage === 'pg-stop-observation' && Array.isArray((value as any).processes)) {
          for (const sample of (value as any).processes) {
            if (!Number.isSafeInteger(sample.pid) || sample.pid <= 0 || !/^\d+$/.test(sample.startTicks ?? '') ||
                !/^\d+$/.test(sample.io?.syscw ?? '') || !/^\d+$/.test(sample.io?.write_bytes ?? '')) continue;
            const key = `${sample.pid}:${sample.startTicks}`;
            const next = { writes: BigInt(sample.io.syscw), bytes: BigInt(sample.io.write_bytes) };
            const previous = cleanupIo.get(key);
            // New identities establish baselines; PID reuse and a replayed old
            // sample cannot manufacture progress on an already observed lifetime.
            if (previous && next.writes >= previous.writes && next.bytes >= previous.bytes &&
                (next.writes > previous.writes || next.bytes > previous.bytes)) progressWatchdog?.noteProgress();
            if (!previous || next.writes >= previous.writes && next.bytes >= previous.bytes) cleanupIo.set(key, next);
          }
        }
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      progressWatchdog?.stop();
      clearTimeout(forceTimer);
      clearTimeout(exitWaitTimer);
      clearTimeout(drainTimer);
      child.stdout?.off('data', capture);
      child.stderr?.off('data', capture);
      child.off('message', message);
      child.off('exit', onExit);
      child.off('close', onClose);
      child.off('error', onError);
      closeSync(fd);
      const result = { code: child.exitCode, signal: child.signalCode, timedOut, timeoutPhase, exitWaitTimedOut, stdioDrainTimedOut };
      writeFileSync(join(evidenceDir, 'worker-result.json'), JSON.stringify({ ...result,
        pendingStage: isolatedWorkerPendingStage(evidenceDir), error: error?.message ?? null }), { flag: 'wx' });
      if (error) reject(error);
      else resolve({ ...result, output });
    };
    const stopDraining = () => {
      stdioDrainTimedOut = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.connected) child.disconnect();
      finish();
    };
    const onExit = () => {
      clearTimeout(timeout); progressWatchdog?.stop(); clearTimeout(forceTimer); clearTimeout(exitWaitTimer); clearTimeout(drainTimer);
      drainTimer = setTimeout(stopDraining, drainGrace);
    };
    const onClose = () => finish();
    const onError = (error: Error) => finish(error);
    const terminate = () => {
      if (timedOut || settled) return;
      timedOut = true;
      timeoutPhase = phase;
      killWorker('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killWorker('SIGKILL');
        // Pipe drainage begins at observed exit, not when a signal was merely
        // sent. Otherwise a delayed kernel exit loses its actual signal/code.
        // Keep non-acknowledgement bounded and explicitly uncertified.
        exitWaitTimer = setTimeout(() => {
          exitWaitTimedOut = true;
          stopDraining();
        }, TEST_FILE_SCOPE_STOP_TIMEOUT_SEC * 1000);
      }, grace);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('message', message);
    child.once('exit', onExit);
    child.once('close', onClose);
    child.once('error', onError);
    if (deadlines) armPhase('bootstrap');
    else timeout = setTimeout(terminate, options.timeoutMs);
  });
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function processPin(pid: number) {
  const identity = readProcessIdentity(pid);
  const parentPid = linuxPpidFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  assert.ok(identity && parentPid, 'kernel process identity must be measured while alive');
  return { pid, identity, parentPid };
}

/** Admit the original private worker only after pinning its actual lifetime. */
export function observeIsolatedWorkerLifetime(child: ChildProcess, root: string, evidenceDir: string, runId?: string) {
  const observation: { lifecycle?: any; ended?: any; observationError?: unknown } = {};
  child.on('message', (message: any) => {
    if (message.kind !== 'isolated-runtime-start' && message.kind !== 'isolated-runtime-end') return;
    try {
      if (message.kind === 'isolated-runtime-start') {
        assert.ok(!observation.lifecycle, 'one start per run');
        assert.equal(message.supervisorPid, child.pid);
        assert.equal(message.root, root);
        const observer = processPin(process.pid);
        const supervisor = processPin(child.pid!);
        const worker = processPin(message.childPid);
        assert.equal(supervisor.parentPid, observer.pid);
        assert.equal(worker.parentPid, supervisor.pid);
        assert.equal(readlinkSync(`/proc/${worker.pid}/cwd`), root);
        const env = Object.fromEntries(readFileSync(`/proc/${worker.pid}/environ`, 'utf8')
          .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
        assert.equal(env.PAPERCUSP_WORKSPACE_ID, message.workspace);
        assert.equal(env.HOME, join(message.runtimeRoot, 'home'));
        assert.equal(env.PAPERCUSP_PG_PORT, String(message.pgPort));
        assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
        assert.ok(/^test-runtime-/.test(message.workspace));
        const pgFile = readFileSync(join(message.dataDir, 'postmaster.pid'), 'utf8').split('\n');
        assert.equal(Number(pgFile[3]), message.pgPort);
        const database = processPin(Number(pgFile[0]));
        assert.equal(database.parentPid, supervisor.pid);
        const argv = readFileSync(`/proc/${worker.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        observation.lifecycle = { schemaVersion: 1, runId, host: hostname(), observedAt: new Date().toISOString(),
          observer, supervisor, worker, database, argv, cwd: root, workspace: message.workspace,
          runtimeRoot: message.runtimeRoot, dataDir: message.dataDir, pgPort: message.pgPort };
      } else {
        assert.ok(observation.lifecycle && !observation.ended);
        assert.equal(message.childPid, observation.lifecycle.worker.pid);
        observation.ended = { ...message, observedAt: new Date().toISOString() };
      }
    } catch (error) { observation.observationError = error; }
    writeFileSync(join(evidenceDir, 'lifecycle-observation.json'), JSON.stringify({
      lifecycle: observation.lifecycle ?? null, ended: observation.ended ?? null,
      observationError: observation.observationError instanceof Error ? observation.observationError.message
        : observation.observationError ? String(observation.observationError) : null,
    }));
    if (message.kind === 'isolated-runtime-start') child.send({ kind: 'isolated-runtime-observed',
      childPid: message.childPid, token: message.token,
      accepted: !observation.observationError && !!observation.lifecycle });
  });
  return observation;
}

/** Preserve the superproject's pinned submodule identity, rather than its checkout HEAD. */
export async function isolatedIntegrationSourceFiles(root: string, commit: string, paths: string[]) {
  const sourcePaths = [...new Set(paths)];
  const launcher = 'scripts/with-test-pg.mjs';
  // The launcher owns teardown. Its extracted helper belongs to the same
  // source receipt even when an older caller only declares the launcher.
  // Read the actual import so historical launchers with inline cleanup keep
  // their original source population; a missing imported helper fails closed.
  if (sourcePaths.includes(launcher) &&
      /\b(?:from\s*|import\s*\(\s*)['"]\.\/lib\/with-test-pg-cleanup\.mjs['"]/.test(
        readFileSync(join(root, launcher), 'utf8'))) {
    if (!sourcePaths.includes('scripts/lib/with-test-pg-cleanup.mjs'))
      sourcePaths.push('scripts/lib/with-test-pg-cleanup.mjs');
  }
  const files = sourcePaths.map(path => {
    assert.ok(path && !path.startsWith('/') && !path.split('/').some(p => p === '..' || p === '.'));
    return { path, sha256: hash(readFileSync(join(root, path))) };
  });
  // Uncommitted local tests remain usable, but missing Git identity cannot certify live proof.
  const committed = await readCommittedFiles(root, commit, sourcePaths).catch(() => new Map());
  return files.map(file => ({ ...file, gitSha256: committed.get(file.path)?.sha256 ?? null }));
}

export interface CommittedReaderObservationIdentity {
  sourceCommit: string;
  runId: string;
  process: { pid: number; identity: string };
}

/** The original observation receipt pins the existing planned/source receipts.
 * Each measured dimension carries its original identity, preventing stitching
 * observations from different runs or processes into a consumer's claims. */
export interface CommittedReaderObservationCohort extends CommittedReaderObservationIdentity {
  sourceRoot: string;
  sourceReceipt: { path: string; sha256: string };
  inputReceipt: { path: string; sha256: string };
  observations: {
    [K in 'source' | 'dependencies' | 'config' | 'imports' | 'schema' | 'environment']:
      CommittedReaderObservationIdentity & { value: unknown };
  };
  omitted: string[];
  opaque: string[];
}

export interface CommittedReaderPreparationHandoff {
  root: string;
  selectedCommit: string;
  sourceReceiptPath: string;
  sourceReceiptSha256: string;
  inputReceiptPath: string;
  inputReceiptSha256: string;
  observationReceiptPath: string;
  observationReceiptSha256: string;
}

/** Retain observed cleanup independently of the final source-integrity verdict. */
export async function retainIsolatedLifecycleBeforeSourceCheck(evidenceDir: string,
  lifecycle: Record<string, unknown>, ended: unknown, verifySource: () => void) {
  lifecycle.ended = ended;
  await writeFile(join(evidenceDir, 'lifecycle.json'), JSON.stringify(lifecycle), { flag: 'wx' });
  verifySource();
}


export async function recordIsolatedIntegrationProof(options: {
  root: string; filePath: string; sourcePaths: string[];
  /** Required original receipts, relative to the run directory. Missing files fail retention. */
  retainedArtifacts?: readonly string[];
  prepare?: (evidenceDir: string) => Promise<void | CommittedReaderPreparationHandoff> | void | CommittedReaderPreparationHandoff;
  requiredPreparation?: CommittedReaderObservationIdentity;
  execute: (observe: (child: ChildProcess) => void, evidenceDir: string) => Promise<void>;
}): Promise<string> {
  const { root, filePath } = options;
  const paths = [...new Set([filePath, 'scripts/lib/isolated-runtime-start.mjs', ...options.sourcePaths])].sort();
  let source: any;
  let lifecycle: any;
  let ended: any;
  let observationError: unknown;
  let observation: ReturnType<typeof observeIsolatedWorkerLifetime> | undefined;
  let observedChild: ChildProcess | undefined;
  let original: ReturnType<typeof qualifyOriginalPreparation> | undefined;
  let retainedPreparationDir: string | undefined;
  const retainedArtifacts = [...new Set(['phases/prepare/source.json', 'phases/execute/lifecycle.json',
    ...(options.requiredPreparation ? ['phases/prepare/verifier-source.json', 'phases/prepare/operator-api-inputs.json',
      'phases/prepare/original-observations.json'] : []), ...(options.retainedArtifacts ?? [])])];
  const recheckPreparation = () => {
    if (!original) return;
    original.recheck();
    for (const [name, bytes] of [['verifier-source.json', original.planned.sourceBytes],
      ['operator-api-inputs.json', original.planned.inputBytes], ['original-observations.json', original.bytes]] as const)
      assert.deepEqual(readFileSync(join(retainedPreparationDir!, name)), bytes, 'Retained original preparation bytes changed');
  };
  const result = await runHarness({
    contract: { name: 'isolated-integration', phases: [
      { id: 'prepare' }, { id: 'execute', dependsOn: ['prepare'] }, { id: 'teardown' },
    ] }, evidenceRoot: defaultEvidenceRoot('isolated-integration'),
    retainedArtifacts,
    runPhase: async ctx => {
      if (ctx.phase === 'prepare') {
        // Required originals must be validated and retained before allocating
        // the parent observer. Legacy void callbacks retain their old order.
        if (options.requiredPreparation) {
          original = qualifyOriginalPreparation(await options.prepare?.(ctx.evidenceDir), options.requiredPreparation);
          retainedPreparationDir = ctx.evidenceDir;
          for (const [name, bytes] of [['verifier-source.json', original.planned.sourceBytes],
            ['operator-api-inputs.json', original.planned.inputBytes], ['original-observations.json', original.bytes]] as const)
            await writeFile(join(ctx.evidenceDir, name), bytes, { flag: 'wx' });
          recheckPreparation();
        }
        const commit = original?.handoff.selectedCommit
          ?? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const observed = await withIsolatedIntegrationSourceObserver(async () => {
          if (!original) return isolatedIntegrationSourceFiles(root, commit, paths);
          recheckPreparation();
          return original.planned.source.files;
        });
        recheckPreparation();
        const files = observed.value;
        source = { schemaVersion: 1, runId: ctx.runId, sourceCommit: commit, repoRoot: root, filePath,
          runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
          workspaceId: resolveTestRunWorkspaceId(),
          harnessSlug: resolveTestRunHarnessSlug(), files,
          parentObserver: { database: observed.database, flush: observed.flush },
          ...(original ? { repoRoot: original.handoff.root, originalPreparation: {
            identity: options.requiredPreparation, handoff: original.handoff,
            retained: { sourceReceiptSha256: original.planned.sourceReceiptSha256,
              inputReceiptSha256: original.planned.inputReceiptSha256, observationReceiptSha256: hash(original.bytes) },
          } } : {}) };
        await writeFile(join(ctx.evidenceDir, 'source.json'), JSON.stringify(source), { flag: 'wx' });
        if (!options.requiredPreparation) {
          const handoff = await options.prepare?.(ctx.evidenceDir);
          assert.equal(handoff, undefined, 'Original preparation handoff requires an explicit original identity');
        }
      } else if (ctx.phase === 'execute') {
        recheckPreparation();
        try {
          await options.execute(child => {
            assert.ok(!observedChild, 'one lifecycle per run');
            observedChild = child;
            observation = observeIsolatedWorkerLifetime(child, root, ctx.evidenceDir, ctx.runId);
          }, ctx.evidenceDir);
        } finally {
          // Teardown uses the original observer even when the journey rejects.
          // A failed assertion must not erase an already observed cleanup.
          ({ lifecycle, ended, observationError } = observation ?? {});
          // Persist the original observation before a journey rejection escapes
          // this phase. Incomplete cleanup remains explicit and cannot pass the
          // validation below; no lifecycle is invented when start was absent.
          if (lifecycle) await retainIsolatedLifecycleBeforeSourceCheck(
            ctx.evidenceDir, lifecycle, ended ?? null, () => {});
        }
        if (observationError) throw observationError;
        assert.ok(lifecycle && ended, 'original start and cleanup observations are required');
        assert.ok(!ended.signal && ended.runtimeRemoved && ended.pgDataRemoved);
        assert.ok(!existsSync(lifecycle.runtimeRoot) && !existsSync(lifecycle.dataDir));
        assert.notEqual(readProcessIdentity(lifecycle.worker.pid), lifecycle.worker.identity);
        assert.notEqual(readProcessIdentity(lifecycle.database.pid), lifecycle.database.identity);
        if (original) recheckPreparation();
        else for (const file of source.files) assert.equal(hash(readFileSync(join(root, file.path))), file.sha256);
      } else {
        // Preserve available original diagnostics even if cleanup validation
        // rejects: that rejection is exactly when the observations matter.
        const runDir = join(ctx.evidenceDir, '../..');
        for (const receipt of isolatedIntegrationDiagnosticArtifacts(runDir))
          if (!retainedArtifacts.includes(receipt)) retainedArtifacts.push(receipt);
        // A failed preparation allocated no worker or private database.
        if (!observedChild) {
          assert.ok(!lifecycle && !ended);
          return { ok: true };
        }
        assert.ok(lifecycle && ended);
        assertIsolatedWorkerReaped(observedChild, ended);
        assert.ok(!existsSync(lifecycle.runtimeRoot) && !existsSync(lifecycle.dataDir));
      }
      return { ok: true };
    },
  });
  assert.equal(result.verdict, 'pass', JSON.stringify({
    runId: result.runId,
    firstFailure: result.firstFailure,
    phaseFailures: result.phases
      .filter((phase) => phase.status === 'failed' || phase.status === 'blocked')
      .map(({ phase, step, reasonCode, detail }) => ({ phase, step, reasonCode, detail })),
  }));
  return result.runId;
}

/** Common small diagnostics emitted by the maintained private worker/browser boundary. */
export function isolatedIntegrationDiagnosticArtifacts(runDir: string): string[] {
  return ['phases/prepare/operator-api-preflight.json', 'phases/prepare/operator-api-build-result.json',
    'phases/prepare/operator-api-inputs.json',
    'phases/prepare/verifier-source.json', 'phases/execute/worker-result.json',
    'phases/execute/lifecycle-observation.json',
    // Keep the builder's original streams and journal when the assertion tail
    // is dominated by cleanup output. build.log also covers older fixtures.
    'phases/prepare/operator-api-build.log', 'phases/prepare/hono-host.mjs.build-steps.jsonl',
    'phases/execute/build.log', 'phases/execute/operator-api-build.log',
    'phases/execute/hono-host.mjs.build-steps.jsonl',
    'phases/execute/worker.log', 'phases/execute/worker-progress.ndjson',
    'phases/execute/roster-stop-cleanup.jsonl', 'phases/execute/roster-stop-resources.json',
    'phases/execute/roster-stop-native.jsonl',
    'phases/execute/native-task-diagnostics.json', 'phases/execute/native-task-stdout.log',
    'phases/execute/native-task-normalized.log', 'phases/execute/native-task-boot.log',
    'phases/execute/native-result.json', 'phases/execute/operator-api-build-result.json',
    'phases/execute/portal-browser-source.json', 'phases/execute/portal-browser-receipt.json',
    'phases/execute/portal-health-reads.json', 'phases/execute/portal-health-writes.json',
    'phases/execute/portal-health-seed.json', 'phases/execute/portal-health-publication.json',
    'phases/execute/portal-cloud-health-observations.json',
    'phases/execute/browser-inputs.json'].filter(path => existsSync(join(runDir, path)));
}
