import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runQualificationCommand, type QualificationCommandOptions } from './checkpoint-qualification-command';
import type { managedSpawn } from '../task-manager/managed-spawn';
import type { recordStoredQualificationChildScope } from './checkpoint-qualification-transaction';
import type { killScopeUnit } from '../task-manager/control';

const setup = () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const calls: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 4242, kill: vi.fn() }) as unknown as ChildProcess;
  const record = vi.fn<typeof recordStoredQualificationChildScope>(async (_target, change) => {
    calls.push(change.operation);
    return { status: 'updated', transaction: {} } as Awaited<ReturnType<typeof recordStoredQualificationChildScope>>;
  }) as unknown as typeof recordStoredQualificationChildScope;
  const kill = vi.fn<typeof killScopeUnit>(async () => {
    calls.push('kill'); child.emit('close', null, 'SIGKILL');
    return { ok: true } as Awaited<ReturnType<typeof killScopeUnit>>;
  });
  const spawn = vi.fn<typeof managedSpawn>(async (_cmd, _args, _spec, options) => {
    calls.push('fork'); options!.onSpawn!(child, 'child123');
    return { child, confined: true, scopeUnit: 'pc-child123.scope', waitForCompletion: async () => {
      calls.push('handoff-verified'); return { status: 'recorded' as const };
    } } as Awaited<ReturnType<typeof managedSpawn>>;
  }) as unknown as typeof managedSpawn;
  const input: QualificationCommandOptions = { target: { workspaceId: 'w', installSlug: 'h' },
    progress: { attemptId: 'a', candidate: 'c', runnerId: 'r', runId: 'run', pidIdentity: 'boot:42',
      repairHead: null, root: '/repo', taskKey: 'q', runnerIdentity: 'native', updates: [],
      manifest: { schemaVersion: 1, units: [{ id: 'test:a', path: 'a', kind: 'test' }] }, retryStates: [],
      runContext: 'green-checkpoint' }, deadlineEpochMs: 11000, cwd: '/repo', env: {} };
  return { calls, child, input, deps: { spawn, record, kill, taskId: () => 'child123', now: Date.now } };
};
afterEach(() => vi.useRealTimers());

describe('qualification confined command custody', () => {
  it('rejects an expired inherited caller deadline before enrollment', async () => {
    const { input, deps } = setup(); input.env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = '900';
    await expect(runQualificationCommand('npm', [], input, deps)).rejects.toThrow('deadline-exhausted');
    expect(deps.record).not.toHaveBeenCalled(); expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('retains an earlier inherited deadline throughout launch and OS confinement', async () => {
    const { input, deps, child } = setup(); input.env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS = '6000';
    const pending = runQualificationCommand('npm', [], input, deps);
    await vi.advanceTimersByTimeAsync(0); child.emit('close', 0, null);
    await pending;
    expect(deps.spawn).toHaveBeenCalledWith('npm', [], expect.objectContaining({ runtimeMaxSec: 5 }),
      expect.objectContaining({ deadlineEpochMs: 6000 }));
  });

  it('enrolls before fork, captures original argv/output, and verifies death before release', async () => {
    const { calls, child, input, deps } = setup();
    const output = vi.fn(); input.onOutput = output;
    const pending = runQualificationCommand('/repo/scripts/pc-heavy.sh', ['npm', 'run', 'test:affected'], input, deps);
    await vi.advanceTimersByTimeAsync(0);
    child.stdout!.emit('data', 'native completion\n'); child.stderr!.emit('data', 'diagnostic\n');
    child.emit('close', 0, null);
    await expect(pending).resolves.toEqual({ code: 0, signal: null, stdout: 'native completion\n', stderr: 'diagnostic\n' });
    expect(calls).toEqual(['enroll', 'fork', 'handoff-verified', 'kill', 'release']);
    expect(deps.spawn).toHaveBeenCalledWith('/repo/scripts/pc-heavy.sh', ['npm', 'run', 'test:affected'],
      expect.objectContaining({ runtimeMaxSec: 10 }), expect.objectContaining({
        requireRegistration: true, requireConfinement: true, deadlineEpochMs: 11000,
        spawnOptions: expect.objectContaining({ env: { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '11000' } }),
      }));
    expect(output).toHaveBeenCalledTimes(2);
  });

  it('refuses to fork after enrollment is rejected', async () => {
    const { input, deps } = setup();
    vi.mocked(deps.record).mockResolvedValueOnce({ status: 'conflict', transaction: {} } as Awaited<ReturnType<typeof deps.record>>);
    await expect(runQualificationCommand('npm', [], input, deps)).rejects.toThrow('enrollment-refused');
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('allows a candidate workspace cwd and rejects a sibling outside the candidate', async () => {
    const { child, input, deps } = setup();
    input.cwd = '/repo/packages/a';
    const pending = runQualificationCommand('npm', ['test'], input, deps);
    await vi.advanceTimersByTimeAsync(0); child.emit('close', 0, null);
    await expect(pending).resolves.toMatchObject({ code: 0 });
    input.cwd = '/repo-peer';
    await expect(runQualificationCommand('npm', ['test'], input, deps)).rejects.toThrow('root-mismatch');
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('retains custody when scope death is unknown, even after a zero exit', async () => {
    const { child, input, deps } = setup();
    vi.mocked(deps.record).mockResolvedValueOnce({ status: 'updated', transaction: {} } as Awaited<ReturnType<typeof deps.record>>)
      .mockResolvedValueOnce({ status: 'conflict', transaction: {} } as Awaited<ReturnType<typeof deps.record>>);
    const pending = runQualificationCommand('npm', [], input, deps);
    await vi.advanceTimersByTimeAsync(0); child.emit('close', 0, null);
    await expect(pending).rejects.toThrow('child-death-unmeasured');
  });

  it('kills and verifies the scope on caller cancellation, preserving cleanup time', async () => {
    const { child, input, deps, calls } = setup();
    const signal = new AbortController(); input.signal = signal.signal;
    const pending = runQualificationCommand('npm', [], input, deps);
    const rejected = expect(pending).rejects.toThrow('command-aborted');
    await vi.advanceTimersByTimeAsync(0); signal.abort(); child.emit('close', null, 'SIGKILL');
    await rejected;
    expect(calls).toEqual(['enroll', 'fork', 'kill', 'kill', 'release']);
  });

  it('bounds a blocked enrollment and prevents a later fork', async () => {
    const { input, deps } = setup();
    let finish!: (value: Awaited<ReturnType<typeof deps.record>>) => void;
    vi.mocked(deps.record).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = runQualificationCommand('npm', [], input, deps);
    const rejected = expect(pending).rejects.toThrow('command-deadline');
    await vi.advanceTimersByTimeAsync(10000); await rejected;
    finish({ status: 'updated', transaction: {} } as Awaited<ReturnType<typeof deps.record>>);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledTimes(1);
  });

  it('bounds one stalled command independently of unrelated output elsewhere', async () => {
    const { input, deps } = setup(); input.timeoutMs = 100;
    const pending = runQualificationCommand('npm', [], input, deps);
    const rejected = expect(pending).rejects.toThrow('worker-timeout');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(deps.kill).toHaveBeenCalledWith('pc-child123.scope', { signal: 'SIGKILL' });
    expect(deps.record).toHaveBeenLastCalledWith(input.target, expect.objectContaining({ operation: 'release' }));
  });

  it('retains custody through a late launch handoff after an early empty-scope kill', async () => {
    const { child, input, deps, calls } = setup(); input.timeoutMs = 100;
    vi.mocked(deps.kill).mockImplementation(async () => {
      calls.push('kill');
      return { ok: false, scopeUnit: 'pc-child123.scope', action: 'kill', error: 'already_gone' };
    });
    let settled = false;
    const pending = runQualificationCommand('npm', [], input, deps);
    const rejected = expect(pending).rejects.toThrow('worker-timeout');
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(deps.record).toHaveBeenCalledTimes(1);
    // The cleanup reservation outlives the idle bound, without moving the
    // immutable caller cutoff. A late exact-client close permits a new probe.
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.record).toHaveBeenCalledTimes(1);
    child.emit('close', null, 'SIGKILL');
    await rejected;
    expect(calls.slice(-2)).toEqual(['kill', 'release']);
    expect(deps.kill).toHaveBeenCalledTimes(3);
  });

  it('retains custody at the absolute cleanup cutoff when the launch client never closes', async () => {
    const { input, deps } = setup(); input.timeoutMs = 100;
    vi.mocked(deps.kill).mockResolvedValue({ ok: false, scopeUnit: 'pc-child123.scope', action: 'kill', error: 'already_gone' });
    const pending = runQualificationCommand('npm', [], input, deps);
    const rejected = expect(pending).rejects.toThrow('worker-timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(deps.record).toHaveBeenCalledTimes(1);
  });

  it('does not move the absolute cutoff when output refreshes an idle timer', async () => {
    const { child, input, deps } = setup(); input.timeoutMs = 2000; input.timeoutResetsOnProgress = true;
    const pending = runQualificationCommand('npm', [], input, deps);
    const rejected = expect(pending).rejects.toThrow('command-deadline');
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(900); child.stdout!.emit('data', 'still printing\n');
    }
    await vi.advanceTimersByTimeAsync(1000); await rejected;
    expect(deps.record).toHaveBeenCalledTimes(1);
  });
});
