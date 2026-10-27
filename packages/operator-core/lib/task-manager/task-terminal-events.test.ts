import { describe, expect, it, vi } from 'vitest';
import { emitTaskTerminalEvent, taskTerminalEventKey } from './task-terminal-events';

describe('task terminal awaited events', () => {
  it('builds the task-scoped key and emits the complete observed terminal tuple', async () => {
    const emit = vi.fn(async () => ({ ok: true }));
    expect(taskTerminalEventKey('tsk-123')).toBe('task:terminal:tsk-123');

    const delivered = await emitTaskTerminalEvent(
      {
        taskId: 'tsk-123',
        workspaceId: 'workspace-a',
        harnessSlug: 'papercusp',
        taskClass: 'pty',
        launchedBy: 'su-a',
        state: 'exited',
        exitCode: 0,
        exitReason: null,
      },
      { emit },
    );
    expect(delivered).toBe(true);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({
      key: 'task:terminal:tsk-123',
      summary: 'Managed pty task tsk-123 entered terminal state exited.',
      payload: {
        taskId: 'tsk-123',
        state: 'exited',
        exitCode: 0,
        exitReason: null,
        taskClass: 'pty',
        harness: 'papercusp',
        launchedBy: 'su-a',
      },
      source: 'task-manager',
      workspaceId: 'workspace-a',
    });
  });

  it('preserves the original error stack when terminal delivery fails during module initialization', async () => {
    const cause = new ReferenceError('Cannot access event module before initialization');
    cause.stack = `${cause.name}: ${cause.message}\n    at initializeEventModule (/source/events/await/engine.ts:42:7)`;
    const warn = vi.fn();

    await emitTaskTerminalEvent(
      {
        taskId: 'tsk-import-failed',
        workspaceId: 'workspace-a',
        harnessSlug: null,
        taskClass: 'bash-job',
        launchedBy: 'su-a',
        state: 'killed',
        exitCode: 137,
        exitReason: 'oom-kill',
      },
      { emit: async () => { throw cause; }, warn },
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal event failed for tsk-import-failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(cause.stack));
  });

  it('fails soft when wake delivery is unavailable', async () => {
    const warn = vi.fn();
    await emitTaskTerminalEvent(
      {
        taskId: 'tsk-failed',
        workspaceId: 'workspace-a',
        harnessSlug: null,
        taskClass: 'bash-job',
        launchedBy: 'su-a',
        state: 'killed',
        exitCode: 143,
        exitReason: 'signal',
      },
      { emit: async () => { throw new Error('wake backend down'); }, warn },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wake backend down'));
  });

  it('retains pending intent when the engine succeeds without a durable latch', async () => {
    await expect(emitTaskTerminalEvent({
      taskId: 'tsk-latch-failed', workspaceId: 'workspace-a', harnessSlug: null,
      taskClass: 'bash-job', launchedBy: 'su-a', state: 'exited', exitCode: 0, exitReason: null,
    }, { emit: async () => ({ ok: true, latchRecorded: false }) })).resolves.toBe(false);
  });
});
