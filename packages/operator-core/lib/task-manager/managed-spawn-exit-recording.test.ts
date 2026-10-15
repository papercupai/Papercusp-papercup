/**
 * managed-spawn-exit-recording.test.ts — WI-37509.
 *
 * THE PROPERTY: for a CONFINED task, the exit of the process we hold is EVIDENCE
 * about the payload, never a verdict. A row may only go terminal when the task's
 * own scope is not still holding processes.
 *
 * WHY: `buildTaskScopeArgv` wraps every confined task in `systemd-run --user
 * --scope`, and systemd-run FORKS the payload into the new scope. The `ChildProcess`
 * we hold is therefore the CLIENT. Normally it lives exactly as long as its payload,
 * which is why watching it worked for so long — but the two can be separated (a
 * signal delivered to the client, its spawner's cgroup torn down), and then the
 * client's death says nothing at all about the work.
 *
 * Filed as terminal, the row stops being reapable (reapers act on live rows) and
 * `upsertUnaccounted` deliberately preserves a terminal state, so the survivor never
 * shows up in the pane either — it just re-enters the reconciler's `unaccounted` set
 * every 30s, forever. Measured live 2026-08-09: two `fleet spawner sidecar` tasks
 * recorded `killed / signal SIGTERM` 7s and 12s after launch, all six of their
 * processes still alive 5.5h and 9.4h later, feeding a fleet-wide alarm that could
 * never clear.
 *
 * THE ASYMMETRY IS THE DESIGN, and it is asserted in both directions below: only a
 * scope we can POSITIVELY see is populated suppresses the close. Empty, missing and
 * unreadable all still close, because failing the other way would invent rows that
 * never close at all — a worse failure than the one being fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';

const L = vi.hoisted(() => ({
  closed: [] as { taskId: string; state: string; exitCode: number | null; exitReason: string | null }[],
  marked: [] as { cgroupPath: string | null; confined: boolean }[],
  terminal: [] as unknown[],
  markDelay: undefined as (() => Promise<void>) | undefined,
  closeDelay: undefined as (() => Promise<void>) | undefined,
  enabled: true,
  // Rest-typed so the pass-through mocks below can spread their `unknown[]` args in:
  // a zero-parameter vi.fn() makes `L.fn(...args)` a TS2556 spread error.
  inspectTaskUnitTerminals: vi.fn(async (..._args: unknown[]) => new Map()),
  resetFailedTaskUnit: vi.fn(async (..._args: unknown[]) => false),
}));

vi.mock('./enabled', () => ({
  isTaskManagerEnabled: async () => L.enabled,
  taskManagerEnabledSync: () => true,
  warmTaskManagerFlag: () => {},
  setTaskManagerEnabledForTest: () => {},
}));

vi.mock('./store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId?: string }) => ({
    taskId: opts?.taskId ?? 'task-test',
    state: 'pending',
  }),
  markSpawned: async (_id: string, v: { cgroupPath: string | null; confined: boolean }) => {
    L.marked.push(v);
    await L.markDelay?.();
  },
  closeTask: async (taskId: string, v: { state: string; exitCode?: number | null; exitReason: string | null }) => {
    await L.closeDelay?.();
    L.closed.push({ taskId, state: v.state, exitCode: v.exitCode ?? null, exitReason: v.exitReason });
    L.terminal.push((v as { terminalProvenance?: unknown }).terminalProvenance ?? null);
    return true;
  },
}));

vi.mock('./scope-terminal-state', () => ({
  inspectTaskUnitTerminals: (...args: unknown[]) => L.inspectTaskUnitTerminals(...args),
  resetFailedTaskUnit: (...args: unknown[]) => L.resetFailedTaskUnit(...args),
}));

import {
  managedSpawn,
  markManagedSpawnTeardown,
  SCOPE_HANDOFF_GRACE_MS,
  SCOPE_HANDOFF_RECHECK_MS,
} from './managed-spawn';
import { notifyTaskKillRequested } from './kill-notify';
import { CGROUP_ROOT, type CgroupFs } from './cgroup-read';
import { scopeCgroupRelPath, scopeUnitForTask, type TaskSpec } from './types';

const MGR = '/user.slice/user-1000.slice/user@1000.service';
const OWN_CGROUP = `0::${MGR}/papercup-dev-api.service\n`;

// Typed as TaskSpec deliberately (not `as never`): the fixture then goes RED at the
// next required field rather than silently stale — the trap lint:required-field-strands
// exists for, and the reason this file avoids mock casts entirely.
const SIDECAR_SPEC: TaskSpec = {
  class: 'sidecar',
  title: 'fleet spawner sidecar',
  argv: ['tsx', 'apps/operator/bin/spawner-sidecar.ts'],
  launchedBy: 'system:spawner-sidecar',
};

function makeChild(pid = 4242): { emitter: EventEmitter; child: ChildProcess } {
  const emitter = new EventEmitter();
  Object.assign(emitter, { pid, kill: () => true });
  return { emitter, child: emitter as unknown as ChildProcess };
}

/**
 * The scope's contents, resolved lazily so the fs can be built BEFORE the task id
 * (and therefore the scope path) exists.
 *
 * `procs: null` models a scope directory that is GONE — systemd collected it, the
 * ordinary healthy ending — which is deliberately distinct from `[]`, a scope that
 * still exists but has been emptied. Both must still close the row.
 */
interface ScopeState {
  rel: string;
  procs: number[] | null;
  pidsCurrent?: number | null;
}

function makeFs(scope: ScopeState): CgroupFs {
  return {
    readFile(path: string): string | null {
      // The operator's own cgroup — what the user-manager root is derived from.
      if (path === `/proc/${process.pid}/cgroup`) return OWN_CGROUP;
      if (!scope.rel) return null;
      const abs = `${CGROUP_ROOT}${scope.rel}`;
      if (path === `${abs}/cgroup.procs`) return scope.procs == null ? null : scope.procs.join('\n');
      if (path === `${abs}/pids.current`) {
        return scope.pidsCurrent == null ? null : String(scope.pidsCurrent);
      }
      return null;
    },
    readDir: () => [],
    isDir: (path: string) => Boolean(scope.rel && path === `${CGROUP_ROOT}${scope.rel}` && scope.procs !== null),
  };
}

async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

async function flushAfterHandoff(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SCOPE_HANDOFF_GRACE_MS + SCOPE_HANDOFF_RECHECK_MS));
  await flush();
}

/** Spawn one confined sidecar against a scope whose contents the caller controls. */
async function spawnConfined(procs: number[] | null, pidsCurrent?: number | null) {
  const { emitter, child } = makeChild();
  const scope: ScopeState = { rel: '', procs, pidsCurrent };
  const result = await managedSpawn('tsx', ['spawner-sidecar.ts'], SIDECAR_SPEC, {
    scopeAvailable: true,
    spawnFn: (() => child) as unknown as typeof nodeSpawn,
    fs: makeFs(scope),
  });
  // The path is fully determined by task id + class, so it is knowable the moment
  // managedSpawn returns — the same derivation the subject itself performs.
  scope.rel = scopeCgroupRelPath(MGR, 'sidecar', result.scopeUnit!);
  return { emitter, result, scopeRel: scope.rel, scope };
}

describe('confined task exit recording (WI-37509)', () => {
  beforeEach(() => {
    L.closed.length = 0;
    L.marked.length = 0;
    L.terminal.length = 0;
    L.markDelay = undefined;
    L.closeDelay = undefined;
    L.enabled = true;
    L.inspectTaskUnitTerminals.mockReset().mockResolvedValue(new Map());
    L.resetFailedTaskUnit.mockReset().mockResolvedValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records a child that exits while the post-spawn ledger write is pending', async () => {
    const { emitter, child } = makeChild();
    let entered!: () => void;
    let release!: () => void;
    const marking = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    L.markDelay = async () => { entered(); await pending; };
    const launching = managedSpawn('true', [], SIDECAR_SPEC, {
      confine: false, spawnFn: (() => child) as unknown as typeof nodeSpawn,
    });
    await marking;
    emitter.emit('exit', 0, null);
    release();
    const result = await launching;
    await flush();
    expect(L.closed).toEqual([{
      taskId: result.taskId, state: 'exited', exitCode: 0, exitReason: null,
    }]);
  });

  it('awaits delayed terminal persistence before a caller can finish', async () => {
    const { emitter, child } = makeChild();
    let release!: () => void;
    L.closeDelay = () => new Promise<void>((resolve) => { release = resolve; });
    const result = await managedSpawn('true', [], SIDECAR_SPEC, {
      confine: false, spawnFn: (() => child) as unknown as typeof nodeSpawn,
    });
    emitter.emit('exit', 0, null);
    emitter.emit('close', 0, null);
    let finished = false;
    const completion = result.waitForCompletion().then((outcome) => { finished = true; return outcome; });
    await flush();
    expect(finished).toBe(false);
    expect(L.closed).toEqual([]);
    release();
    await expect(completion).resolves.toEqual({ status: 'recorded' });
    expect(L.closed).toMatchObject([{ taskId: result.taskId, exitCode: 0 }]);
  });

  it('reports a persistence failure without inventing terminal evidence', async () => {
    L.closeDelay = async () => { throw new Error('fixture terminal store offline'); };
    const { emitter, child } = makeChild();
    const result = await managedSpawn('true', [], SIDECAR_SPEC, {
      confine: false, spawnFn: (() => child) as unknown as typeof nodeSpawn,
    });
    emitter.emit('exit', 0, null);
    await expect(result.waitForCompletion()).resolves.toEqual({ status: 'unavailable', reason: 'fixture terminal store offline' });
    expect(L.closed).toEqual([]);
  });

  it('reports disabled accounting after the unledgered child exits', async () => {
    L.enabled = false;
    const { emitter, child } = makeChild();
    const result = await managedSpawn('true', [], SIDECAR_SPEC, { spawnFn: (() => child) as unknown as typeof nodeSpawn });
    emitter.emit('exit', 0, null);
    await expect(result.waitForCompletion()).resolves.toEqual({ status: 'unavailable', reason: 'task manager disabled' });
    expect(L.closed).toEqual([]);
  });

  it('does NOT close the row when the client dies but the scope still holds processes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitter, result, scopeRel } = await spawnConfined([3204532, 3204609, 3204726]);
    expect(result.confined).toBe(true);
    expect(scopeRel).toContain('/papercusp.slice/papercusp-sidecar.slice/');

    // The exact shape measured live: client SIGTERMed, payload untouched.
    emitter.emit('exit', null, 'SIGTERM');
    await flushAfterHandoff();

    expect(L.closed).toEqual([]);
    // The suppression must be AUDIBLE. A row silently left open looks identical to
    // one nobody ever wired, which is how this class hid for so long in the first place.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/scope still holds processes/);
  });

  it('does not warn when a clean client exit hands a populated scope to the reconciler', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { emitter, result } = await spawnConfined([3204532, 3204609, 3204726]);

    emitter.emit('exit', 0, null);
    await flushAfterHandoff();

    expect(L.closed).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toMatch(/scope still holds processes/);
    await expect(result.waitForCompletion()).resolves.toMatchObject({ status: 'delegated' });
  });

  it('downgrades a populated-scope signal during intentional teardown to info', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { emitter, result } = await spawnConfined([3204532, 3204609, 3204726]);

    markManagedSpawnTeardown(result.child);
    emitter.emit('exit', null, 'SIGTERM');
    await flushAfterHandoff();

    expect(L.closed).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toMatch(/Intentional teardown/);
    expect(String(info.mock.calls[0]![0])).toMatch(/scope still holds processes/);
  });

  it('preserves the intentional marker across the delayed scope handoff window', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { emitter, result, scope } = await spawnConfined([]);

    markManagedSpawnTeardown(result.child);
    emitter.emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(SCOPE_HANDOFF_RECHECK_MS - 1);
    scope.procs = [3204532, 3204609, 3204726];
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(L.closed).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toMatch(/Intentional teardown/);
  });

  // WI-10004434: su-session-stdio-peer's close() SIGKILLs its own engine through
  // killTask without marking the handle. killTask announces every kill on the
  // kill-notify seam before signalling, so that announcement alone must be
  // enough to make the deliberate kill an intentional teardown.
  it('treats a killTask-announced signal for this task as intentional teardown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { emitter, result } = await spawnConfined([3204532, 3204609, 3204726]);

    notifyTaskKillRequested(result.taskId, 'SIGKILL');
    emitter.emit('exit', null, 'SIGKILL');
    await flushAfterHandoff();

    expect(L.closed).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toMatch(/Intentional teardown/);
    expect(String(info.mock.calls[0]![0])).toMatch(/signal SIGKILL/);
  });

  it('records an explicit kill request as cancelled even when the client exits with code 2', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { emitter, result } = await spawnConfined(null);

    notifyTaskKillRequested(result.taskId, 'SIGTERM');
    // systemd-run's client exit is not the verdict for the task; the task may
    // have exited with a designed non-zero code after the kill request arrived.
    emitter.emit('exit', 2, null);
    await flushAfterHandoff();

    expect(L.closed).toEqual([
      {
        taskId: result.taskId,
        state: 'killed',
        exitCode: 143,
        exitReason: 'processes:kill requested SIGTERM',
      },
    ]);
    expect(L.terminal).toEqual([null]);
  });

  it('keeps an unannounced signal loud when only a different task was killed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { emitter, result } = await spawnConfined([3204532, 3204609, 3204726]);

    notifyTaskKillRequested(`${result.taskId}-other`, 'SIGKILL');
    emitter.emit('exit', null, 'SIGKILL');
    await flushAfterHandoff();

    expect(L.closed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/scope still holds processes/);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/Intentional teardown/);
  });

  it('waits for a delayed scope handoff instead of closing a live task row', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { emitter, scope } = await spawnConfined([]);

    // systemd-run can report its client gone before the payload has joined the
    // named scope. The first read is therefore empty even though the scope is
    // about to become live.
    emitter.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(SCOPE_HANDOFF_RECHECK_MS - 1);
    expect(L.closed).toEqual([]);

    scope.procs = [3204532, 3204609, 3204726];
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(L.closed).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toMatch(/scope still holds processes/);
  });

  it('closes a scope that drains during the handoff window without warning', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitter, scope } = await spawnConfined([3204532, 3204609, 3204726]);

    emitter.emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(SCOPE_HANDOFF_RECHECK_MS - 1);
    scope.procs = [];
    await vi.advanceTimersByTimeAsync(SCOPE_HANDOFF_GRACE_MS);
    await Promise.resolve();

    expect(L.closed).toHaveLength(1);
    expect(L.closed[0]!.state).toBe('killed');
    expect(warn).not.toHaveBeenCalled();
  });

  it('DOES close the row when the scope is gone — the ordinary healthy ending', async () => {
    const { emitter } = await spawnConfined(null);

    emitter.emit('exit', 0, null);
    await flushAfterHandoff();

    expect(L.closed).toHaveLength(1);
    expect(L.closed[0]!.state).toBe('exited');
  });

  it('DOES close the row when the scope exists but has been emptied', async () => {
    const { emitter } = await spawnConfined([]);

    emitter.emit('exit', null, 'SIGKILL');
    await flushAfterHandoff();

    expect(L.closed).toHaveLength(1);
    expect(L.closed[0]!.state).toBe('killed');
    expect(L.closed[0]!.exitReason).toBe('signal SIGKILL');
  });

  it('attaches and then releases a retained systemd OOM verdict before it disappears', async () => {
    const terminal = {
      capturedAt: '2026-08-24T16:00:00.000Z',
      scopeUnit: 'placeholder',
      cgroupPath: null,
      invocationId: 'invocation-oom',
      loadState: 'loaded',
      activeState: 'failed',
      serviceResult: 'oom-kill',
      execMainCode: 2,
      execMainStatus: 9,
      memoryMaxBytes: 32 * 1024 * 1024,
      peakMemoryBytes: 32 * 1024 * 1024,
      peakMemorySource: 'systemd' as const,
    };
    const { emitter, result } = await spawnConfined([]);
    terminal.scopeUnit = result.scopeUnit!;
    L.inspectTaskUnitTerminals.mockResolvedValueOnce(new Map([[result.scopeUnit!, terminal]]));

    emitter.emit('exit', 137, null);
    await flushAfterHandoff();

    expect(L.terminal).toEqual([terminal]);
    expect(L.resetFailedTaskUnit).toHaveBeenCalledWith(terminal);
  });

  it('counts a payload that made its own sub-cgroups, via recursive pids.current', async () => {
    // `cgroup.procs` is flat, so a payload sitting only in a CHILD cgroup reads as
    // empty there; `pids.current` is recursive in cgroup v2 and still sees it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitter } = await spawnConfined([], 3);

    emitter.emit('exit', null, 'SIGTERM');
    await flushAfterHandoff();

    expect(L.closed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("records the SCOPE cgroup, never the spawner's own cgroup", async () => {
    // The live bug: `readProcessCgroupPath(child.pid)` right after spawn returns the
    // SPAWNER's cgroup, because systemd-run has not moved into the scope yet. Two
    // real rows recorded `app.slice/papercup-dev-api.service` and a GNOME Terminal
    // `vte-spawn-*.scope` as the task's own cgroup.
    const { result } = await spawnConfined([]);

    expect(L.marked).toHaveLength(1);
    expect(L.marked[0]!.cgroupPath).toBe(scopeCgroupRelPath(MGR, 'sidecar', result.scopeUnit!));
    expect(L.marked[0]!.cgroupPath).not.toContain('papercup-dev-api.service');
    expect(L.marked[0]!.cgroupPath).not.toContain('vte-spawn');
  });

  it('CALIBRATION: identical exit, opposite verdicts — the scope is what decides', async () => {
    // The falsifiability check, run against the REAL code path rather than a stub.
    // Both halves emit the SAME exit event on the SAME implementation; the only
    // difference is what the scope holds. The pre-fix rule ("the child exited,
    // therefore the task ended") cannot produce this split — it closes both — so a
    // regression to it turns this test red rather than leaving it vacuously green.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const populated = await spawnConfined([3204532, 3204609, 3204726]);
    populated.emitter.emit('exit', null, 'SIGTERM');
    await flushAfterHandoff();
    const closedWhilePopulated = L.closed.length;

    L.closed.length = 0;
    const drained = await spawnConfined([]);
    drained.emitter.emit('exit', null, 'SIGTERM');
    await flushAfterHandoff();
    const closedWhenDrained = L.closed.length;

    expect(closedWhilePopulated).toBe(0);
    expect(closedWhenDrained).toBe(1);
    expect(closedWhilePopulated).not.toBe(closedWhenDrained);
    warn.mockRestore();
  });
});

describe('scope unit naming is the shared authority', () => {
  it('derives the same scope unit the argv builder uses', () => {
    const unit = scopeUnitForTask('0msldixpfupa5t8454l');
    expect(unit).toBe('pc-0msldixpfupa5t8454l.scope');
    expect(scopeCgroupRelPath(MGR, 'sidecar', unit)).toBe(
      `${MGR}/papercusp.slice/papercusp-sidecar.slice/pc-0msldixpfupa5t8454l.scope`,
    );
  });
});
