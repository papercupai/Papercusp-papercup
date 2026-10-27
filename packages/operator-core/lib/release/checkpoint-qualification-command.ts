import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { managedSpawn, markManagedSpawnTeardown } from '../task-manager/managed-spawn';
import { killScopeUnit } from '../task-manager/control';
import { newTaskId, scopeUnitForTask } from '../task-manager/types';
import { TASK_DEADLINE_EPOCH_MS_ENV } from '../systemd-scope';
import { recordStoredQualificationChildScope, type QualificationWorkProgressInput } from './checkpoint-qualification-transaction';
import type { GateVerdictTarget } from './gate-verdict-target';

export interface QualificationCommandOptions {
  target: GateVerdictTarget;
  progress: QualificationWorkProgressInput;
  /** Cleanup must finish before this fixed caller/OS cutoff. */
  deadlineEpochMs: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutResetsOnProgress?: boolean;
  hardTimeoutMs?: number;
  onSpawn?: (child: { pid: number; command: string[]; cwd: string }) => void;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  onProgress?: () => void;
}

/** The qualification owner enrolls a scope before fork and retains custody until
 * the stored transition independently verifies death. All descendants, including
 * detached test workers, remain inside managedSpawn's OS-enforced scope. */
export async function runQualificationCommand(command: string, args: string[], input: QualificationCommandOptions,
  deps = { spawn: managedSpawn, record: recordStoredQualificationChildScope, kill: killScopeUnit,
    taskId: newTaskId, now: Date.now }) {
  const options = { ...input, target: structuredClone(input.target), progress: structuredClone(input.progress),
    env: { ...input.env } };
  const callerDeadline = Number(options.env[TASK_DEADLINE_EPOCH_MS_ENV]);
  if (Number.isSafeInteger(callerDeadline) && callerDeadline > 0)
    options.deadlineEpochMs = Math.min(options.deadlineEpochMs, callerDeadline);
  const argv = [command, ...args], taskId = deps.taskId(), unit = scopeUnitForTask(taskId);
  const fence = { attemptId: options.progress.attemptId, runnerId: options.progress.runnerId,
    runId: options.progress.runId, pidIdentity: options.progress.pidIdentity, unit };
  const controller = new AbortController();
  const cleanupController = new AbortController();
  let child: ChildProcess | undefined;
  let stdout = '', stderr = '', closed = false, launchSettled = false;
  let stopReason: Error | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const arm = (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, Math.max(0, ms)); timers.add(timer); return timer;
  };
  const bounded = <T>(operation: Promise<T>, cleanup = false): Promise<T> => {
    const signal = cleanup ? cleanupController.signal : controller.signal;
    if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(stopReason ?? new Error('qualification-command-aborted')); }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(stopReason ?? new Error('qualification-command-aborted'));
      signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  };
  let finishChild!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let failChild!: (error: Error) => void;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    finishChild = resolve; failChild = reject;
  });
  // A spawn error can precede return from managedSpawn's post-fork bookkeeping.
  void completion.catch(() => {});
  const stop = (reason: string) => {
    if (stopReason) return;
    stopReason = new Error(reason); controller.abort();
    if (child) {
      markManagedSpawnTeardown(child);
      // Death is verified again by the stored release; an accepted signal is not proof.
      void deps.kill(unit, { signal: 'SIGKILL' }).catch(() => {});
    }
  };
  const abort = () => stop('qualification-command-aborted');
  const startIdle = () => {
    if (!options.timeoutMs) return;
    if (idleTimer) { clearTimeout(idleTimer); timers.delete(idleTimer); }
    idleTimer = arm(() => stop('qualification-worker-timeout'), options.timeoutMs);
  };
  if (!Number.isSafeInteger(options.deadlineEpochMs) || options.deadlineEpochMs - deps.now() < 2000)
    throw new Error('qualification-command-deadline-exhausted');
  const relativeCwd = path.relative(options.progress.root, options.cwd);
  if (relativeCwd === '..' || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd))
    throw new Error('qualification-command-root-mismatch');
  if (options.signal?.aborted) throw new Error('qualification-command-aborted');
  const deadlineTimer = arm(() => { stop('qualification-command-deadline'); cleanupController.abort(); },
    options.deadlineEpochMs - deps.now());
  options.signal?.addEventListener('abort', abort, { once: true });
  let enrolled = false;
  try {
    const enrollment = await bounded(deps.record(options.target, { ...fence, operation: 'enroll' }));
    if (enrollment.status !== 'updated' && enrollment.status !== 'idempotent')
      throw new Error('qualification-child-enrollment-refused');
    enrolled = true;
    controller.signal.throwIfAborted();
    if (options.deadlineEpochMs - deps.now() < 2000) throw new Error('qualification-command-deadline-exhausted');
    const inheritedDeadline = Number(options.env[TASK_DEADLINE_EPOCH_MS_ENV]);
    options.env[TASK_DEADLINE_EPOCH_MS_ENV] = String(Number.isSafeInteger(inheritedDeadline) && inheritedDeadline > 0
      ? Math.min(inheritedDeadline, options.deadlineEpochMs) : options.deadlineEpochMs);
    const launch = deps.spawn(command, argv.slice(1), {
      class: 'test-run', title: 'Frozen qualification command', argv, cwd: options.cwd,
      launchedBy: 'green-checkpoint:qualification',
      runtimeMaxSec: Math.floor((options.deadlineEpochMs - deps.now()) / 1000),
    }, { taskId, workspaceId: options.target.workspaceId, requireConfinement: true, requireRegistration: true,
      signal: controller.signal, deadlineEpochMs: options.deadlineEpochMs,
      spawnOptions: { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] },
      onSpawn: spawned => {
        child = spawned;
        const capture = (stream: 'stdout' | 'stderr', bytes: Buffer | string) => {
          const text = bytes.toString();
          if (stream === 'stdout') stdout += text; else stderr += text;
          try { options.onOutput?.(stream, text); options.onProgress?.(); } catch { /* diagnostic */ }
          if (options.timeoutResetsOnProgress && !closed) startIdle();
        };
        spawned.stdout?.on('data', bytes => capture('stdout', bytes));
        spawned.stderr?.on('data', bytes => capture('stderr', bytes));
        spawned.once('error', failChild);
        spawned.once('close', (code, signal) => { closed = true; finishChild({ code, signal }); });
        if (spawned.pid !== undefined) {
          try { options.onSpawn?.({ pid: spawned.pid, command: [...argv], cwd: options.cwd }); } catch { /* diagnostic */ }
        }
        startIdle();
        if (options.hardTimeoutMs) hardTimer = arm(() => stop('qualification-worker-hard-timeout'), options.hardTimeoutMs);
        if (controller.signal.aborted) {
          markManagedSpawnTeardown(spawned);
          void deps.kill(unit, { signal: 'SIGKILL' }).catch(() => {});
        }
      },
    });
    // This handler remains attached if the bound wins while registration waits.
    void launch.then(() => { launchSettled = true; }, () => { launchSettled = true; });
    const managed = await bounded(launch);
    if (!managed.confined || managed.scopeUnit !== unit) throw new Error('qualification-child-confinement-unmeasured');
    const result = await bounded(completion);
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    // wireExit waits through systemd's launch handoff before delegating live residue.
    await bounded(managed.waitForCompletion());
    return { ...result, stdout, stderr };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    // Keep the absolute deadline armed through scope teardown and the DB release.
    // An unmeasured/late launch retains its reservation for death-aware recovery.
    try {
      if (enrolled && launchSettled) {
        if (child) {
          markManagedSpawnTeardown(child);
          const awaitingHandoff = !closed;
          await bounded(deps.kill(unit, { signal: 'SIGKILL' }), true);
          if (awaitingHandoff) {
            // The systemd-run client can still be attaching a payload when an
            // early kill observes an empty/collected scope. Keep custody until
            // that exact client's close, then drain the scope again. The fixed
            // cleanup deadline remains armed across both barriers.
            await bounded(completion, true);
            await bounded(deps.kill(unit, { signal: 'SIGKILL' }), true);
          }
        }
        const released = await bounded(deps.record(options.target, { ...fence, operation: 'release' }), true);
        if (released.status !== 'updated' && released.status !== 'idempotent')
          throw new Error('qualification-child-death-unmeasured');
      }
    } finally {
      clearTimeout(deadlineTimer);
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
      cleanupController.abort();
    }
  }
}
