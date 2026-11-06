import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxProcStateFromStat, readProcessIdentity } from '../process-identity';
import { newTaskId, scopeUnitForTask } from '../task-manager/types';
import { managedSpawn, markManagedSpawnTeardown } from '../task-manager/managed-spawn';
import { killScopeUnit } from '../task-manager/control';
import { buildTaskScopeArgv, userManagerBusReachable } from '../systemd-scope';
import { runQualificationCommand } from './checkpoint-qualification-command';
import {
  beginQualificationTransaction,
  checkpointPidIdentity,
  configureRunnerLivenessProber,
  observeQualificationProgress,
  probeRunnerLiveness,
  qualificationProgressFence,
  recordQualificationRunnerProgress,
  reserveQualificationRunner,
  type recordStoredQualificationChildScope,
} from './checkpoint-qualification-transaction';

// This integration suite exercises real OS boundaries. Only the task ledger is replaced. The payloads, systemd scopes, cgroups,
// cancellation, timeout and scope-death control path are real OS operations.
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../task-manager/store', () => ({ registerTask: vi.fn(async () => ({})),
  markSpawned: vi.fn(async () => ({})), closeTask: vi.fn(async () => true) }));

function running(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
  } catch { return false; }
}
async function until(check: () => boolean, timeoutMs: number) {
  const cutoff = Date.now() + timeoutMs;
  while (!check() && Date.now() < cutoff) await new Promise(resolve => setTimeout(resolve, 25));
  expect(check()).toBe(true);
}
const payload = `
  const { spawn } = require('node:child_process');
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],
    { detached: true, stdio: 'ignore' });
  console.log(JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 100);
`;

describe.runIf(process.platform === 'linux' && userManagerBusReachable())('qualification real process bounds', () => {
  const target = { workspaceId: 'test-process-custody', installSlug: 'test-process-custody' };
  async function launch(taskId = newTaskId()) {
    const unit = scopeUnitForTask(taskId);
    let output = '';
    const managed = await managedSpawn(process.execPath, ['-e', payload], {
      class: 'test-run', title: 'Qualification custody fixture', argv: [process.execPath, '-e', payload],
      cwd: process.cwd(), launchedBy: 'test:qualification-custody', runtimeMaxSec: 20,
    }, { taskId, workspaceId: target.workspaceId, requireConfinement: true, requireRegistration: true,
      scopeAvailable: true, spawnOptions: { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
      onSpawn(child) { child.stdout!.on('data', bytes => { output += bytes.toString(); }); } });
    try {
      await until(() => output.includes('\n'), 5000);
      const pids = JSON.parse(output.trim()) as number[];
      expect(pids).toHaveLength(2);
      expect(pids.every(running)).toBe(true);
      const nowMs = Date.now();
      const tx = reserveQualificationRunner(beginQualificationTransaction(null, {
        attemptId: 'custody-attempt', candidate: 'custody-candidate', nowMs,
      }).transaction, { attemptId: 'custody-attempt', runnerId: 'custody-runner', runId: 'custody-run',
        unit, pid: pids[0], pidIdentity: checkpointPidIdentity(pids[0]!), leaseDurationMs: 1000, nowMs }).transaction;
      return { taskId, unit, pids, tx, managed };
    } catch (error) {
      markManagedSpawnTeardown(managed.child);
      await killScopeUnit(unit, { signal: 'SIGKILL' });
      await managed.waitForCompletion();
      throw error;
    }
  }
  async function drain(fixture: Awaited<ReturnType<typeof launch>>) {
    markManagedSpawnTeardown(fixture.managed.child);
    await killScopeUnit(fixture.unit, { signal: 'SIGKILL' });
    await until(() => fixture.pids.every(pid => !running(pid)), 5000);
    await fixture.managed.waitForCompletion();
  }

  it('pre-enrollment-crash: a killed controller cannot fork before its enrollment commits', async () => {
    const taskId = newTaskId(), unit = scopeUnitForTask(taskId);
    const root = mkdtempSync(join(tmpdir(), 'qualification-before-enrollment-'));
    const artifact = join(root, 'forbidden-payload');
    const moduleUrl = new URL('./checkpoint-qualification-command.ts', import.meta.url).href;
    const controller = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { runQualificationCommand } = await import(${JSON.stringify(moduleUrl)});
      setInterval(() => {}, 100);
      await runQualificationCommand(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(artifact)}, 'forked')`)}], {
        target: ${JSON.stringify(target)}, deadlineEpochMs: null, cwd: process.cwd(), env: process.env,
        progress: { attemptId: 'pending', candidate: 'pending', runnerId: 'pending', runId: 'pending',
          pidIdentity: 'pending', repairHead: null, root: process.cwd(), taskKey: 'pending',
          runnerIdentity: 'pending', updates: [], retryStates: [], runContext: 'green-checkpoint',
          manifest: { schemaVersion: 1, units: [{ id: 'pending', kind: 'test', path: 'pending' }] } },
      }, { record: async (_target, change) => {
        process.send({ stage: 'enrollment-pending', unit: change.unit });
        return new Promise(() => {});
      }, spawn: async () => { process.send({ stage: 'forbidden-fork' }); throw new Error('forked'); },
        kill: async () => {}, taskId: () => ${JSON.stringify(taskId)}, now: Date.now });
    `], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const stages: unknown[] = [];
    let diagnostics = '';
    controller.on('message', message => stages.push(message));
    controller.stderr!.on('data', bytes => { diagnostics += bytes.toString(); });
    try {
      await vi.waitFor(() => {
        expect(controller.exitCode, diagnostics).toBeNull();
        expect(stages, diagnostics).toEqual([{ stage: 'enrollment-pending', unit }]);
      }, { timeout: 12_000 });
      const identity = checkpointPidIdentity(controller.pid!);
      const exited = once(controller, 'exit');
      controller.kill('SIGKILL'); await exited;
      expect(stages).toEqual([{ stage: 'enrollment-pending', unit }]);
      expect(existsSync(artifact)).toBe(false);
      await expect(probeRunnerLiveness({ id: 'pending', candidate: 'pending', reservedAtMs: 0,
        evidenceRefs: [], phase: 'suite', unit, pid: controller.pid!, pidIdentity: identity })).resolves.toBe('dead');
    } finally {
      if (controller.exitCode === null && controller.signalCode === null) {
        const exited = once(controller, 'exit');
        controller.kill('SIGKILL'); await exited;
      }
      await killScopeUnit(unit, { signal: 'SIGKILL' });
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('pid-scope-reuse: a real replacement under the same unit rejects the predecessor fence', async () => {
    const first = await launch();
    let second: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      const oldFence = qualificationProgressFence(first.tx, target);
      // A recycled PID identity alone cannot declare the occupied scope dead.
      await expect(probeRunnerLiveness({ ...first.tx.currentPhysicalRunner!, pidIdentity: 'other-boot:other-start' })).resolves.toBe('live');
      await drain(first);
      await expect(probeRunnerLiveness(first.tx.currentPhysicalRunner)).resolves.toBe('dead');
      second = await launch(first.taskId);
      expect(second.unit).toBe(first.unit);
      expect(second.tx.currentPhysicalRunner!.pidIdentity).not.toBe(first.tx.currentPhysicalRunner!.pidIdentity);
      expect(observeQualificationProgress(second.tx, target, { fence: oldFence, observerGeneration: 'old',
        sequence: 1, sampledAtMs: Date.now(), monotonicAtMs: 1000, telemetryHealthy: true }))
        .toMatchObject({ status: 'conflict', refusalReason: 'observer-fence-mismatch' });
      expect(second.pids.every(running)).toBe(true);
    } finally { await drain(second ?? first); }
  }, 20_000);

  it('returning-controller: delayed progress from a dead real controller cannot alter its successor', async () => {
    const first = await launch();
    try {
      const delayed = { attemptId: first.tx.attemptId, runnerId: first.tx.currentPhysicalRunner!.id,
        runId: first.tx.runId!, pidIdentity: first.tx.currentPhysicalRunner!.pidIdentity,
        phase: 'suite' as const, nowMs: Date.now() + 1000 };
      await drain(first);
      const liveness = await probeRunnerLiveness(first.tx.currentPhysicalRunner);
      expect(liveness).toBe('dead');
      const successor = reserveQualificationRunner(first.tx, { attemptId: first.tx.attemptId,
        runnerId: 'successor', runId: 'successor-run', pid: process.pid, pidIdentity: checkpointPidIdentity(process.pid),
        leaseDurationMs: 1000, incumbentLiveness: liveness, nowMs: Date.now() }).transaction;
      expect(successor.currentPhysicalRunner!.id).toBe('successor');
      const rejected = recordQualificationRunnerProgress(successor, delayed);
      expect(rejected).toMatchObject({ status: 'conflict' });
      expect(rejected.transaction).toBe(successor);
    } finally { await drain(first); }
  }, 15_000);

  it('partial-scope-read: an unreadable enrolled sibling retains custody despite a dead parent scope', async () => {
    const first = await launch();
    let sibling: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      sibling = await launch();
      await drain(first);
      await expect(probeRunnerLiveness(first.tx.currentPhysicalRunner)).resolves.toBe('dead');
      await expect(probeRunnerLiveness(sibling.tx.currentPhysicalRunner)).resolves.toBe('live');
      const tx = structuredClone(first.tx);
      tx.currentPhysicalRunner!.childScopeUnits = [first.unit, sibling.unit];
      tx.currentPhysicalRunner!.childScopeReservedAtMs = 0;
      const reads: string[] = [];
      // Inject only the inaccessible scope read; both OS populations were independently measured above.
      configureRunnerLivenessProber(async runner => {
        reads.push(runner.unit!);
        return runner.unit === first.unit ? 'dead' : 'unknown';
      });
      const liveness = await probeRunnerLiveness(tx.currentPhysicalRunner);
      expect(liveness).toBe('unknown');
      expect(reads).toEqual([first.unit, sibling.unit]);
      expect(reserveQualificationRunner(tx, { attemptId: tx.attemptId, runnerId: 'forbidden-successor',
        leaseDurationMs: 1000, incumbentLiveness: liveness, nowMs: Date.now() }).status).toBe('conflict');
      expect(sibling.pids.every(running)).toBe(true);
      expect(tx.currentPhysicalRunner!.childScopeUnits).toEqual([first.unit, sibling.unit]);
    } finally {
      configureRunnerLivenessProber(null);
      await Promise.all([drain(first), ...(sibling ? [drain(sibling)] : [])]);
    }
  }, 20_000);

  it.each(['inherited', 'builtin-only'])('kills a hung worker and its detached descendant before releasing custody (%s)', async variant => {
    const taskId = newTaskId(), unit = scopeUnitForTask(taskId), pids: number[] = [], operations: string[] = [];
    const kills: Awaited<ReturnType<typeof killScopeUnit>>[] = [];
    const identity = (pid: number) => {
      try { return { pid, identity: readProcessIdentity(pid), state: linuxProcStateFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8')),
        cgroup: readFileSync(`/proc/${pid}/cgroup`, 'utf8') }; }
      catch { return { pid, identity: null }; }
    };
    let launched: ReturnType<typeof identity>[] = [];
    const record = vi.fn<typeof recordStoredQualificationChildScope>(async (_target, change) => {
      operations.push(change.operation);
      if (change.operation === 'release') {
        expect(pids, JSON.stringify({ unit, kills, launched })).toHaveLength(2);
        expect(pids.every(pid => !running(pid)),
          JSON.stringify({ unit, kills, launched, releasing: pids.map(identity) })).toBe(true);
      }
      return { status: 'updated', transaction: {} } as Awaited<ReturnType<typeof recordStoredQualificationChildScope>>;
    });
    let output = '';
    let failure: unknown;
    try {
      try { await runQualificationCommand(process.execPath, ['-e', payload], {
        target: { workspaceId: 'test-process-bounds', installSlug: 'test-process-bounds' },
        progress: { attemptId: 'test', candidate: 'test', runnerId: 'test', runId: 'test', pidIdentity: 'test',
          repairHead: null, root: process.cwd(), taskKey: 'test', runnerIdentity: 'test', updates: [],
          manifest: { schemaVersion: 1, units: [{ id: 'test:worker', kind: 'test', path: 'worker' }] },
          retryStates: [], runContext: 'green-checkpoint' },
        // Keep inherited startup hooks in the reproduction; the builtin-only
        // variant distinguishes startup-hook behavior without replacing it.
        cwd: process.cwd(), env: { ...process.env, ...(variant === 'builtin-only' ? { NODE_OPTIONS: '' } : {}) },
        // Inherited hooks took longer than 750ms in the measured controls.
        // Give that fixture the independently fixed 4s worker bound used by the
        // stalled-process fixture; the death-before-release predicate is exact.
        deadlineEpochMs: Date.now() + 10_000, timeoutMs: variant === 'builtin-only' ? 750 : 4000,
        onOutput(stream, chunk) {
          if (stream !== 'stdout') return;
          output += chunk;
          if (!pids.length && output.includes('\n')) {
            pids.push(...JSON.parse(output.trim()));
            launched = pids.map(identity);
          }
        },
      }, { spawn: (cmd, args, spec, options) => managedSpawn(cmd, args, spec, { ...options, scopeAvailable: true }),
        record, kill: async (...args: Parameters<typeof killScopeUnit>) => {
          const outcome = await killScopeUnit(...args); kills.push(outcome); return outcome;
        }, taskId: () => taskId, now: Date.now }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message, JSON.stringify({ variant, unit, kills, launched, releasing: pids.map(identity) }))
        .toContain('qualification-worker-timeout');
      expect(pids, JSON.stringify({ unit, kills, output })).toHaveLength(2);
      expect(pids.every(pid => !running(pid))).toBe(true);
      expect(operations).toEqual(['enroll', 'release']);
    } finally { await killScopeUnit(unit, { signal: 'SIGKILL' }); }
  }, 20_000);

  it('enforces the OS orphan fuse after the launching parent dies', async () => {
    const taskId = newTaskId(), unit = scopeUnitForTask(taskId);
    const argv = buildTaskScopeArgv([process.execPath, '-e', payload], { unit, slice: 'papercusp-test.slice', runtimeMaxSec: 3,
      extraProperties: ['TimeoutStopSec=1s', 'SendSIGKILL=yes'] });
    const parent = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))},
        { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
      setInterval(() => {}, 100);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostics = '';
    parent.stdout!.setEncoding('utf8'); // boundary-safe decode (WI-6728)
    parent.stderr!.setEncoding('utf8');
    parent.stdout!.on('data', chunk => { output += chunk; });
    parent.stderr!.on('data', chunk => { diagnostics += chunk; });
    try {
      await until(() => output.includes('\n'), 5000);
      const pids = JSON.parse(output.trim()) as number[];
      expect(pids).toHaveLength(2);
      expect(pids.every(running), diagnostics).toBe(true);
      const nowMs = Date.now();
      const transaction = beginQualificationTransaction(null, { attemptId: 'orphan-scope', nowMs }).transaction;
      const runner = reserveQualificationRunner(transaction, {
        attemptId: 'orphan-scope', runnerId: 'orphan-launcher', unit,
        pid: parent.pid!, pidIdentity: checkpointPidIdentity(parent.pid!),
        leaseDurationMs: 60_000, nowMs,
      }).transaction.currentPhysicalRunner!;
      const exit = once(parent, 'exit');
      parent.kill('SIGKILL'); await exit;
      // A reaped launcher is not a dead managed scope: its confined payload
      // and detached descendant must keep the qualification single-flight.
      await expect(probeRunnerLiveness(runner)).resolves.toBe('live');
      // No JS cleanup remains in the launcher. systemd must kill both the
      // TERM-resistant payload and its detached descendant at its own bound.
      await until(() => pids.every(pid => !running(pid)), 6000);
    } finally {
      parent.kill('SIGKILL');
      await killScopeUnit(unit, { signal: 'SIGKILL' });
    }
  }, 15_000);
});
