/**
 * managed-spawn-registration-recovery.test.ts — EI-24485471567611961.
 *
 * A transient failure before the fork must not leave a live, managed scope
 * permanently unowned. Recovery retries the same task id and scope, so it can
 * adopt the reconciler's placeholder; if the child exits first, its close is
 * held until the ledger row is restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';

const M = vi.hoisted(() => ({
  registerTask: vi.fn(async (..._args: unknown[]) => ({})),
  markSpawned: vi.fn(async (..._args: unknown[]) => {}),
  closeTask: vi.fn(async (..._args: unknown[]) => true),
  inspectTaskUnitTerminals: vi.fn(async (..._args: unknown[]) => new Map()),
  resetFailedTaskUnit: vi.fn(async (..._args: unknown[]) => false),
}));

vi.mock('./enabled', () => ({
  isTaskManagerEnabled: async () => true,
  taskManagerEnabledSync: () => true,
  warmTaskManagerFlag: () => {},
  setTaskManagerEnabledForTest: () => {},
}));

vi.mock('./store', () => ({
  registerTask: (...args: unknown[]) => M.registerTask(...args),
  markSpawned: (...args: unknown[]) => M.markSpawned(...args),
  closeTask: (...args: unknown[]) => M.closeTask(...args),
}));

vi.mock('./scope-terminal-state', () => ({
  inspectTaskUnitTerminals: (...args: unknown[]) => M.inspectTaskUnitTerminals(...args),
  resetFailedTaskUnit: (...args: unknown[]) => M.resetFailedTaskUnit(...args),
}));

import { managedSpawn, SCOPE_HANDOFF_GRACE_MS, SCOPE_HANDOFF_RECHECK_MS } from './managed-spawn';
import { reconcile, type ScannedProcess } from './reconcile';
import { CGROUP_ROOT, type CgroupFs } from './cgroup-read';
import { classifyScope } from './scope-class';
import { scopeCgroupRelPath, scopeUnitForTask, type TaskRow, type TaskSpec } from './types';

const MGR = '/user.slice/user-1000.slice/user@1000.service';
const OWN_CGROUP = `0::${MGR}/papercup-dev-api.service\n`;
const PID = 987_654;

const SPEC: TaskSpec = {
  class: 'sidecar',
  title: 'voice whisper-server',
  argv: ['node', 'local-whisper-service.js'],
  launchedBy: 'system:whisper-server',
};

let registeredRow: TaskRow | null = null;

function makeTaskRow(taskId: string, spec: TaskSpec): TaskRow {
  const now = new Date().toISOString();
  return {
    taskId,
    workspaceId: 'papercusp-workspace',
    rootTaskId: taskId,
    class: spec.class,
    title: spec.title,
    argv: [...spec.argv],
    launchedBy: spec.launchedBy,
    scopeUnit: scopeUnitForTask(taskId),
    cgroupPath: null,
    pid: null,
    processIdentity: null,
    confined: true,
    state: 'pending',
    startedAt: now,
    lastSeenAt: now,
    detail: { ...(spec.detail ?? {}) },
  };
}

function makeFs(taskId: string, procs: number[] | null): CgroupFs {
  const scopePath = scopeCgroupRelPath(MGR, 'sidecar', scopeUnitForTask(taskId));
  const scopeAbs = `${CGROUP_ROOT}${scopePath}`;
  return {
    readFile(path: string): string | null {
      if (path === `/proc/${process.pid}/cgroup`) return OWN_CGROUP;
      if (path === `${scopeAbs}/cgroup.procs`) return procs === null ? null : procs.join('\n');
      if (path === `${scopeAbs}/pids.current`) return procs === null ? null : String(procs.length);
      return null;
    },
    readDir: () => [],
    isDir: (path: string) => path === scopeAbs && procs !== null,
  };
}

function scannedProcess(taskId: string): ScannedProcess {
  const cgroupPath = `${MGR}/papercusp.slice/papercusp-sidecar.slice/${scopeUnitForTask(taskId)}`;
  return {
    pid: PID,
    cgroupPath,
    processIdentity: `linux:boot:${PID}`,
    cmdline: 'whisper-server',
    owned: true,
    ...classifyScope(cgroupPath, true),
  };
}

async function launch(taskId: string, procs: number[] | null, stage?: (name: string) => void) {
  const emitter = new EventEmitter();
  Object.assign(emitter, { pid: PID, kill: () => true });
  const spawnFn = (() => emitter as unknown as ChildProcess) as unknown as typeof nodeSpawn;
  const result = await managedSpawn('node', ['local-whisper-service.js'], SPEC, {
    taskId,
    stage,
    scopeAvailable: true,
    spawnFn,
    fs: makeFs(taskId, procs),
  });
  return { emitter, result };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  registeredRow = null;
  M.registerTask.mockReset();
  M.markSpawned.mockReset().mockImplementation(async (...args: unknown[]) => {
    const taskId = String(args[0]);
    const facts = args[1] as Partial<TaskRow>;
    if (registeredRow?.taskId === taskId) {
      registeredRow = { ...registeredRow, ...facts, state: 'running' };
    }
  });
  M.closeTask.mockReset().mockResolvedValue(true);
  M.inspectTaskUnitTerminals.mockReset().mockResolvedValue(new Map());
  M.resetFailedTaskUnit.mockReset().mockResolvedValue(false);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('managedSpawn ledger registration recovery', () => {
  it('does not fork a metered execution if required durable enrollment fails', async () => {
    M.registerTask.mockRejectedValueOnce(new Error('fixture ledger offline'));
    const spawnFn = vi.fn();
    await expect(managedSpawn('codex', [], { ...SPEC, class: 'agent-session' }, {
      taskId: 'requiredenroll1', requireRegistration: true, scopeAvailable: false, spawnFn: spawnFn as never,
    })).rejects.toThrow(/Required task enrollment failed; no process started/);
    expect(spawnFn).not.toHaveBeenCalled(); expect(M.markSpawned).not.toHaveBeenCalled();
  });
  it('identifies a pending ledger registration before the native fork', async () => {
    const stages: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    M.registerTask.mockImplementation(async () => {
      await pending;
      return makeTaskRow('traceregister1', SPEC);
    });
    const result = launch('traceregister1', null, (name) => stages.push(name));
    await flushMicrotasks();
    expect(stages.at(-1)).toBe('spawn-register-task');
    expect(stages).not.toContain('spawn-fork');
    release();
    await result;
    expect(stages).toContain('spawn-fork');
    expect(stages.at(-1)).toBe('spawn-mark-running');
  });
  it('retries the same task id and scope, then reconciliation matches the recovered row', async () => {
    const taskId = 'recover1234';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    M.registerTask.mockImplementation(async (...args: unknown[]) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary database failure');
      const spec = args[0] as TaskSpec;
      const options = args[1] as { taskId: string };
      registeredRow = makeTaskRow(options.taskId, spec);
      return registeredRow;
    });

    const { result } = await launch(taskId, [PID]);
    expect(attempts).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawning UNLEDGERED'));
    expect(result.row.detail).toMatchObject({ unledgered: true, reason: expect.stringContaining('temporary database failure') });
    expect(M.markSpawned).not.toHaveBeenCalled();

    // Registration recovery is paced and does not hold managedSpawn's return.
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(attempts).toBe(2);
    expect(M.registerTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          managedSpawnRegistrationRecovery: expect.objectContaining({
            firstFailure: 'temporary database failure',
            failures: ['temporary database failure'],
            attempts: 2,
          }),
        }),
      }),
      { taskId, workspaceId: undefined, reserveScope: true },
    );
    expect(M.markSpawned).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ scopeUnit: scopeUnitForTask(taskId), confined: true }),
    );
    expect(registeredRow).toMatchObject({ state: 'running', class: 'sidecar', launchedBy: 'system:whisper-server' });

    const reconciled = reconcile([registeredRow!], [scannedProcess(taskId)], { now: Date.now() });
    expect(reconciled.alive).toMatchObject([{ taskId, matchedBy: 'scope', pidsSeen: 1 }]);
    expect(reconciled.unaccounted).toEqual([]);
  });

  it('attempts final registration on exit and closes the row after prior retry failures', async () => {
    const taskId = 'exitrecover1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    M.registerTask.mockImplementation(async (...args: unknown[]) => {
      attempts += 1;
      if (attempts < 3) throw new Error(`database failure ${attempts}`);
      const spec = args[0] as TaskSpec;
      const options = args[1] as { taskId: string };
      registeredRow = makeTaskRow(options.taskId, spec);
      return registeredRow;
    });

    const { emitter, result } = await launch(taskId, null);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawning UNLEDGERED'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);

    // The scope has drained. Exit forces one immediate final registration attempt
    // instead of leaving a missing row or a pending close behind the timer.
    emitter.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(SCOPE_HANDOFF_GRACE_MS + SCOPE_HANDOFF_RECHECK_MS + 1);
    await flushMicrotasks();

    expect(attempts).toBe(3);
    expect(registeredRow?.detail.managedSpawnRegistrationRecovery).toMatchObject({
      firstFailure: 'database failure 1',
      failures: ['database failure 1', 'database failure 2'],
      attempts: 3,
    });
    expect(M.markSpawned).toHaveBeenCalledWith(taskId, expect.objectContaining({ scopeUnit: scopeUnitForTask(taskId) }));
    expect(M.closeTask).toHaveBeenCalledWith(taskId, expect.objectContaining({ state: 'exited', exitCode: 0 }));
    await expect(result.waitForCompletion()).resolves.toEqual({ status: 'recorded' });
  });

  it('does not claim a queued terminal write was recorded when registration still fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    M.registerTask.mockRejectedValue(new Error('fixture ledger offline'));
    const { emitter, result } = await launch('pendingclose1', null);
    const completion = result.waitForCompletion();
    emitter.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(SCOPE_HANDOFF_GRACE_MS + SCOPE_HANDOFF_RECHECK_MS + 1);
    await expect(completion).resolves.toEqual({ status: 'unavailable', reason: 'ledger registration pending' });
    expect(M.closeTask).not.toHaveBeenCalled();
    vi.clearAllTimers();
  });
});
