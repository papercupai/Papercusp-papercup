/**
 * WI-6810 — capability:bash_kill must survive loss of the worker-local JOBS map.
 *
 * A successor can retain the durable task_id even when the process-local
 * bash_id registry was rebuilt after carry or an operator restart. The kill
 * path must resolve the existing ledger row, delegate to task-manager's
 * cgroup/pid safety rails, and never launch or signal by an unverified handle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../../task-manager/types';
import type { BashJob } from './bash-jobs';

const store = vi.hoisted(() => ({
  getTask: vi.fn(),
  getTaskByBashJobId: vi.fn(),
}));
const control = vi.hoisted(() => ({
  killTask: vi.fn(),
}));
const jobs = vi.hoisted(() => ({
  getJob: vi.fn(),
  killJob: vi.fn(),
  readJobOutput: vi.fn(),
}));
const fs = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));

vi.mock('../../task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/store')>()),
  getTask: store.getTask,
  getTaskByBashJobId: store.getTaskByBashJobId,
}));
vi.mock('../../task-manager/control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/control')>()),
  killTask: control.killTask,
}));
vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  getJob: jobs.getJob,
  killJob: jobs.killJob,
  readJobOutput: jobs.readJobOutput,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: fs.readFileSync,
}));

import bashKillTool from './bash_kill';

type ToolResultish = { content: Array<{ text: string }>; isError?: boolean };
type Tool = {
  args: { safeParse(value: unknown): { success: boolean } };
  handler: (args: unknown, ctx: unknown) => Promise<ToolResultish>;
};
const bashKill = bashKillTool as unknown as Tool;

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'task-carry-1',
    workspaceId: 'ws-current',
    rootTaskId: 'task-carry-1',
    class: 'bash-job',
    title: 'long verification',
    argv: ['bash', '-o', 'pipefail', '-c', 'sleep 60'],
    confined: true,
    scopeUnit: 'pc-task-carry-1.scope',
    cgroupPath: '/papercusp.slice/pc-task-carry-1.scope',
    state: 'running',
    startedAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
    launchedBy: 'su-test',
    logPath: '/tmp/bash-carry-1.log',
    detail: { bashJobId: 'bash-carry-1' },
    ...overrides,
  };
}

function liveJob(): BashJob {
  return {
    id: 'bash-carry-1',
    taskId: 'task-carry-1',
    command: 'sleep 60',
    cwd: '/repo',
    child: {} as BashJob['child'],
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    buffer: 'still working\n',
    totalBytes: 14,
    logPath: '/tmp/bash-carry-1.log',
    readCursor: 0,
    logStream: null,
  };
}

function ctx(workspaceId = 'ws-current') {
  return {
    workspaceId,
    stateDir: '/tmp/task-reattach-state',
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getTask.mockResolvedValue(taskRow());
  store.getTaskByBashJobId.mockResolvedValue(taskRow());
  control.killTask.mockResolvedValue({
    ok: true,
    taskId: 'task-carry-1',
    action: 'kill',
    detail: 'scope pc-task-carry-1.scope signalled SIGTERM — verified empty',
  });
  jobs.getJob.mockReturnValue(null);
  jobs.killJob.mockReturnValue({ alreadyDone: false });
  jobs.readJobOutput.mockReturnValue('still working\n');
  fs.readFileSync.mockReturnValue('still working\n');
});

describe('capability:bash_kill — durable task attachment', () => {
  // EI-21240465530065342: capability:bash returns BOTH ids, so sending both
  // back is the natural stop call. Requiring exactly one rejected it on shape.
  it('accepts either handle alone AND both together, and requires at least one', () => {
    expect(bashKill.args.safeParse({ bash_id: 'bash-1' }).success).toBe(true);
    expect(bashKill.args.safeParse({ task_id: 'task-1' }).success).toBe(true);
    expect(bashKill.args.safeParse({ bash_id: 'bash-1', task_id: 'task-1' }).success).toBe(true);
    expect(bashKill.args.safeParse({}).success).toBe(false);
    expect(bashKill.args.safeParse({ bash_id: '', task_id: 'task-1' }).success).toBe(false);
  });

  it('stops the job through task_id when both handles are supplied and agree', async () => {
    const result = await bashKill.handler(
      { bash_id: 'bash-carry-1', task_id: 'task-carry-1' },
      ctx(),
    );
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(control.killTask).toHaveBeenCalledWith('task-carry-1');
    expect(payload).toMatchObject({ ok: true, task_id: 'task-carry-1', bash_id: 'bash-carry-1' });
  });

  // The safety property that makes accepting both handles acceptable at all:
  // disagreeing handles must kill NOTHING. Resolving the durable one anyway
  // would terminate a job the caller did not name — unrecoverable.
  it('refuses two handles that name different jobs and kills nothing', async () => {
    const result = await bashKill.handler(
      { bash_id: 'bash-some-other-job', task_id: 'task-carry-1' },
      ctx(),
    );
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      reason: 'handle_mismatch',
      bash_id: 'bash-some-other-job',
      task_id: 'task-carry-1',
      durable_bash_id: 'bash-carry-1',
    });
    expect(control.killTask).not.toHaveBeenCalled();
    expect(jobs.killJob).not.toHaveBeenCalled();
  });

  it('reattaches a missing bash_id through the durable ledger and task-manager kill path', async () => {
    const result = await bashKill.handler({ bash_id: 'bash-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(store.getTaskByBashJobId).toHaveBeenCalledWith('bash-carry-1', { workspaceId: 'ws-current' });
    expect(control.killTask).toHaveBeenCalledWith('task-carry-1');
    expect(jobs.killJob).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-carry-1',
      task_id: 'task-carry-1',
      status: 'killed',
      tail: 'still working\n',
    });
  });

  it('uses task_id as the successor handle and does not repeat the bash-id lookup', async () => {
    const result = await bashKill.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(store.getTask).toHaveBeenCalledWith('task-carry-1');
    expect(store.getTaskByBashJobId).not.toHaveBeenCalled();
    expect(control.killTask).toHaveBeenCalledWith('task-carry-1');
    expect(payload).toMatchObject({ ok: true, task_id: 'task-carry-1', bash_id: 'bash-carry-1' });
  });

  it('rejects a task_id from another workspace without touching the registry or control path', async () => {
    store.getTask.mockResolvedValue(taskRow({ workspaceId: 'ws-other' }));

    const result = await bashKill.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('unknown_task_id');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(control.killTask).not.toHaveBeenCalled();
  });

  it('refuses a non-bash ledger row and never turns it into a kill', async () => {
    store.getTask.mockResolvedValue(taskRow({ class: 'agent', detail: {} }));

    const result = await bashKill.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('task_not_attachable');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(control.killTask).not.toHaveBeenCalled();
  });

  it('keeps the process-local path intact when the launching worker still has the job', async () => {
    jobs.getJob.mockReturnValue(liveJob());

    const result = await bashKill.handler({ bash_id: 'bash-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(store.getTaskByBashJobId).not.toHaveBeenCalled();
    expect(control.killTask).not.toHaveBeenCalled();
    expect(jobs.killJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'bash-carry-1' }));
    expect(payload).toMatchObject({ ok: true, bash_id: 'bash-carry-1', task_id: 'task-carry-1' });
  });
});
