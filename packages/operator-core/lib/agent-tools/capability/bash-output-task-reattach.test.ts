/**
 * WI-38433 / P-002 — carry-safe attachment to a managed capability:bash job.
 *
 * A cold successor retains the durable task_id but not the launching worker's
 * process-local bash_id. Attachment must resolve the existing ledger identity,
 * reuse the existing BashOutput path, and never turn a miss into a second job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskRow } from '../../task-manager/types';
import type { BashJob } from './bash-jobs';
import { formatJobLogEndMarker } from './bash-jobs';

const store = vi.hoisted(() => ({
  getTask: vi.fn(),
  getTaskByBashJobId: vi.fn(),
}));
const jobs = vi.hoisted(() => ({
  getJob: vi.fn(),
  readJobOutput: vi.fn(),
  startBackground: vi.fn(),
}));

vi.mock('../../task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/store')>()),
  getTask: store.getTask,
  getTaskByBashJobId: store.getTaskByBashJobId,
}));
vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  getJob: jobs.getJob,
  readJobOutput: jobs.readJobOutput,
  // The assertion below is the recurrence guard: the attachment module has no
  // reason to call the launch seam, even when resolution fails.
  startBackground: jobs.startBackground,
}));
vi.mock('../../process-identity', () => ({
  readProcessIdentity: vi.fn(() => 'linux:boot-test:4242'),
}));
vi.mock('../../task-manager/cgroup-read', () => ({
  readProcessCgroupPath: vi.fn(() => '/papercusp.slice/pc-task-carry-1.scope'),
  readProcessCmdline: vi.fn(() => 'bash -o pipefail -c sleep 60'),
}));

import bashOutputTool from './bash_output';

type ToolResultish = { content: Array<{ text: string }>; isError?: boolean };
type Tool = {
  args: { safeParse(value: unknown): { success: boolean } };
  handler: (args: unknown, ctx: unknown) => Promise<ToolResultish>;
};
const bashOutput = bashOutputTool as unknown as Tool;

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
    pid: 4242,
    processIdentity: 'linux:boot-test:4242',
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

function ctx(workspaceId = 'ws-current', stateDir = '/tmp/task-reattach-state') {
  return {
    workspaceId,
    stateDir,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getTask.mockResolvedValue(taskRow());
  store.getTaskByBashJobId.mockResolvedValue(null);
  jobs.getJob.mockReturnValue(liveJob());
  jobs.readJobOutput.mockReturnValue('still working\n');
});

describe('capability:bash_output — durable task attachment', () => {
  // EI-21240465530065342: capability:bash returns BOTH ids, so an agent holding
  // the launch result naturally sends both back. Requiring exactly one put a
  // schema error on the recovery path — the path that matters most, because the
  // JOBS map is worker-local and a read is routinely served by a worker that
  // never saw the launch. At least one handle is the real requirement.
  it('accepts either handle alone AND both together, and requires at least one', () => {
    expect(bashOutput.args.safeParse({ bash_id: 'bash-1' }).success).toBe(true);
    expect(bashOutput.args.safeParse({ task_id: 'task-1' }).success).toBe(true);
    expect(bashOutput.args.safeParse({ bash_id: 'bash-1', task_id: 'task-1' }).success).toBe(true);
    expect(bashOutput.args.safeParse({}).success).toBe(false);
    expect(bashOutput.args.safeParse({ filter: '^keep' }).success).toBe(false);
    expect(bashOutput.args.safeParse({ bash_id: '', task_id: 'task-1' }).success).toBe(false);
  });

  it('resolves through task_id when both handles are supplied and agree', async () => {
    const result = await bashOutput.handler(
      { bash_id: 'bash-carry-1', task_id: 'task-carry-1' },
      ctx(),
    );
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(jobs.getJob).toHaveBeenCalledWith('bash-carry-1');
    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-carry-1',
      task_id: 'task-carry-1',
      status: 'running',
      running: true,
      output: 'still working\n',
    });
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  // Accepting both handles must not become "silently believe the durable one".
  // A bash_id naming a different job means the caller is confused about WHICH
  // job it is polling; answering with the task_id job's output would hand back
  // the wrong job's bytes under an id the caller trusts.
  it('refuses two handles that name different jobs, reading nothing', async () => {
    const result = await bashOutput.handler(
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
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(jobs.readJobOutput).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('reattaches by task_id to the existing job and never launches a duplicate', async () => {
    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(store.getTask).toHaveBeenCalledWith('task-carry-1');
    expect(jobs.getJob).toHaveBeenCalledWith('bash-carry-1');
    expect(store.getTaskByBashJobId).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-carry-1',
      task_id: 'task-carry-1',
      status: 'running',
      running: true,
      output: 'still working\n',
    });
  });

  it('returns a normal running recovery when the registry misses but the ledger proves the process alive', async () => {
    jobs.getJob.mockReturnValue(null);

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-carry-1',
      task_id: 'task-carry-1',
      status: 'running',
      running: true,
      recovered_from_ledger: true,
      tracking_lost: true,
      output_recoverable: false,
      output_is_tail: true,
      output: '',
    });
    expect(payload).not.toHaveProperty('reason', 'tracking_lost_process_alive');
    // EI-22185525501280167: no on-disk log was ever created at either candidate
    // path, so this reply must never advertise a growing tail or a readable path.
    expect(payload).not.toHaveProperty('log_path');
    expect(String(payload.advice)).toContain('UNRECOVERABLE');
    expect(String(payload.advice)).not.toContain('will keep growing');
    expect(String(payload.advice)).not.toContain('read log_path directly');
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('keeps a confirmed-live task running when its output contains an earlier JOB END marker', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-live-stale-end-marker-'));
    const logPath = join(stateDir, 'live.log');
    try {
      writeFileSync(
        logPath,
        `earlier task output${formatJobLogEndMarker('completed', 0, Date.UTC(2026, 9, 2, 11, 17, 33))}`,
      );
      store.getTask.mockResolvedValue(
        taskRow({
          startedAt: new Date(Date.UTC(2026, 9, 2, 11, 48, 47)).toISOString(),
          logPath,
        }),
      );
      jobs.getJob.mockReturnValue(null);

      const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx('ws-current', stateDir));
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(result.isError).toBeUndefined();
      expect(payload).toMatchObject({ status: 'running', running: true, recovered_from_ledger: true });
      expect(payload).not.toHaveProperty('recovered_from_log_marker');
      expect(jobs.startBackground).not.toHaveBeenCalled();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('keeps a scope-active task running when its output contains an earlier JOB END marker', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-scope-live-stale-end-marker-'));
    const logPath = join(stateDir, 'live.log');
    try {
      const fakeBin = join(stateDir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      const fakeSystemctl = join(fakeBin, 'systemctl');
      writeFileSync(fakeSystemctl, '#!/bin/sh\nprintf "active\\n"\n');
      chmodSync(fakeSystemctl, 0o755);
      writeFileSync(
        logPath,
        `earlier task output${formatJobLogEndMarker('completed', 0, Date.UTC(2026, 9, 2, 11, 17, 33))}`,
      );
      store.getTask.mockResolvedValue(
        taskRow({
          taskId: 'tskcarry5678',
          rootTaskId: 'tskcarry5678',
          pid: null,
          processIdentity: null,
          cgroupPath: null,
          scopeUnit: 'pc-tskcarry5678.service',
          logPath,
        }),
      );
      jobs.getJob.mockReturnValue(null);
      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

      try {
        const result = await bashOutput.handler({ task_id: 'tskcarry5678' }, ctx('ws-current', stateDir));
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

        expect(result.isError).toBeUndefined();
        expect(payload).toMatchObject({ status: 'running', running: true, recovered_from_scope: true });
        expect(payload).not.toHaveProperty('recovered_from_log_marker');
        expect(jobs.startBackground).not.toHaveBeenCalled();
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // EI-22185525501280167: the exact reported shape — systemd CONFIRMS the job's
  // durable service is active, but neither the ledger-recorded log path nor the
  // worker-local scratch log exists on disk. Before the fix this returned
  // `log_path` pointing at a file that would 404, plus advice promising the tail
  // "will keep growing" and inviting a "read log_path directly" — an
  // unrecoverable-output job reading identically to a merely-quiet one.
  it('marks output unrecoverable and omits log_path when scope-active recovery finds no log anywhere', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-scope-unrecoverable-'));
    try {
      const fakeBin = join(stateDir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      const fakeSystemctl = join(fakeBin, 'systemctl');
      writeFileSync(fakeSystemctl, '#!/bin/sh\nprintf "active\\n"\n');
      chmodSync(fakeSystemctl, 0o755);
      const queuedRow = taskRow({
        taskId: 'tskcarry5678',
        rootTaskId: 'tskcarry5678',
        pid: null,
        processIdentity: null,
        cgroupPath: null,
        scopeUnit: 'pc-tskcarry5678.service',
        logPath: join(stateDir, 'never-written.log'),
      });
      store.getTask.mockResolvedValue(queuedRow);
      jobs.getJob.mockReturnValue(null);
      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

      try {
        const result = await bashOutput.handler({ task_id: 'tskcarry5678' }, ctx('ws-current', stateDir));
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

        expect(result.isError).toBeUndefined();
        expect(payload).toMatchObject({
          ok: true,
          task_id: 'tskcarry5678',
          status: 'running',
          running: true,
          recovered_from_ledger: true,
          recovered_from_scope: true,
          liveness_proof: 'systemd_active_state',
          tracking_lost: true,
          output_recoverable: false,
          output_is_tail: true,
          output: '',
        });
        expect(payload).not.toHaveProperty('log_path');
        expect(String(payload.advice)).toContain('UNRECOVERABLE');
        expect(String(payload.advice)).toContain('CONFIRMED ACTIVE');
        expect(String(payload.advice)).not.toContain('will keep growing');
        expect(String(payload.advice)).not.toContain('read log_path directly');
        expect(jobs.startBackground).not.toHaveBeenCalled();
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('prefers the ledger log path over a stale same-id local-worker log', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-ledger-log-precedence-'));
    const ledgerLogPath = join(stateDir, 'authoritative.log');
    try {
      mkdirSync(join(stateDir, 'scratch'), { recursive: true });
      writeFileSync(join(stateDir, 'scratch', 'bash-bash-carry-1.log'), 'stale local worker bytes\n');
      writeFileSync(ledgerLogPath, 'authoritative growing bytes\n');
      store.getTask.mockResolvedValue(taskRow({ logPath: ledgerLogPath }));
      jobs.getJob.mockReturnValue(null);

      const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx('ws-current', stateDir));
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(payload.output_tail).toBe('authoritative growing bytes\n');
      expect(payload.output).toBe('authoritative growing bytes\n');
      expect(payload.log_path).toBe(ledgerLogPath);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('recovers a queued service-backed job from ActiveState and preserves its durable tail', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-scope-recovery-'));
    const output = 'queued behind pc-heavy\n';
    try {
      mkdirSync(join(stateDir, 'scratch'), { recursive: true });
      writeFileSync(join(stateDir, 'scratch', 'bash-bash-carry-1.log'), output);
      const fakeBin = join(stateDir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      const fakeSystemctl = join(fakeBin, 'systemctl');
      writeFileSync(fakeSystemctl, '#!/bin/sh\nprintf "active\\n"\n');
      chmodSync(fakeSystemctl, 0o755);
      const queuedRow = taskRow({
        taskId: 'tskcarry1234',
        rootTaskId: 'tskcarry1234',
        pid: null,
        processIdentity: null,
        cgroupPath: null,
        scopeUnit: 'pc-tskcarry1234.service',
      });
      store.getTask.mockResolvedValue(queuedRow);
      jobs.getJob.mockReturnValue(null);
      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

      try {
        const result = await bashOutput.handler({ task_id: 'tskcarry1234' }, ctx('ws-current', stateDir));
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

        expect(result.isError).toBeUndefined();
        expect(payload).toMatchObject({
          ok: true,
          bash_id: 'bash-carry-1',
          task_id: 'tskcarry1234',
          status: 'running',
          running: true,
          recovered_from_ledger: true,
          recovered_from_scope: true,
          liveness_proof: 'systemd_active_state',
          tracking_lost: true,
          output_is_tail: true,
          scope_unit: 'pc-tskcarry1234.service',
          output_tail: output,
          output,
          total_bytes_written: Buffer.byteLength(output),
        });
        expect(payload.advice).toEqual(expect.stringContaining('queued behind pc-heavy'));
        expect(jobs.startBackground).not.toHaveBeenCalled();
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('does not downgrade an alive service job when its early cgroup pin is stale', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-scope-stale-pin-'));
    const output = 'still queued but alive\n';
    try {
      mkdirSync(join(stateDir, 'scratch'), { recursive: true });
      writeFileSync(join(stateDir, 'scratch', 'bash-bash-carry-1.log'), output);
      const fakeBin = join(stateDir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      const fakeSystemctl = join(fakeBin, 'systemctl');
      writeFileSync(fakeSystemctl, '#!/bin/sh\nprintf "active\\n"\n');
      chmodSync(fakeSystemctl, 0o755);
      // Synchronous enrollment records the systemd-run client cgroup before the
      // payload has moved into its service. The service ActiveState is the
      // durable liveness proof for this exact running-job shape.
      const runningRow = taskRow({
        taskId: 'tskcarry1234',
        rootTaskId: 'tskcarry1234',
        pid: 4242,
        processIdentity: 'linux:boot-test:4242',
        cgroupPath: '/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-dev-api.service',
        scopeUnit: 'pc-tskcarry1234.service',
      });
      store.getTask.mockResolvedValue(runningRow);
      jobs.getJob.mockReturnValue(null);
      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;

      try {
        const result = await bashOutput.handler({ task_id: 'tskcarry1234' }, ctx('ws-current', stateDir));
        const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

        expect(result.isError).toBeUndefined();
        expect(payload).toMatchObject({
          ok: true,
          bash_id: 'bash-carry-1',
          task_id: 'tskcarry1234',
          status: 'running',
          running: true,
          recovered_from_ledger: true,
          recovered_from_scope: true,
          liveness_proof: 'systemd_active_state',
          tracking_lost: true,
          output_is_tail: true,
          pid: 4242,
          output_tail: output,
          output,
        });
        expect(payload.reason).not.toBe('job_liveness_unknown');
        expect(jobs.startBackground).not.toHaveBeenCalled();
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('hides a cross-workspace task as unknown and does not touch the job registry', async () => {
    store.getTask.mockResolvedValue(taskRow({ workspaceId: 'ws-other' }));

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('unknown_task_id');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('refuses non-bash ledger rows without creating a replacement', async () => {
    store.getTask.mockResolvedValue(taskRow({ class: 'agent', detail: {} }));

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('task_not_attachable');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('recovers a terminal bash row when its durable detail lacks bashJobId', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-terminal-without-handle-'));
    const logPath = join(stateDir, 'terminal.log');
    try {
      writeFileSync(logPath, 'completed output\n');
      store.getTask.mockResolvedValue(
        taskRow({
          state: 'exited',
          exitCode: 0,
          detail: {},
          logPath,
        }),
      );
      jobs.getJob.mockReturnValue(null);

      const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(result.isError).toBeUndefined();
      expect(payload).toMatchObject({
        ok: true,
        task_id: 'task-carry-1',
        status: 'completed',
        exit_code: 0,
        running: false,
        recovered_from_ledger: true,
        log_path: logPath,
        output_tail: 'completed output\n',
        output: 'completed output\n',
      });
      expect(payload).not.toHaveProperty('reason', 'task_not_attachable');
      expect(jobs.getJob).not.toHaveBeenCalled();
      expect(jobs.startBackground).not.toHaveBeenCalled();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('prefers the terminal ledger verdict over a conflicting JOB END marker', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-terminal-marker-conflict-'));
    const logPath = join(stateDir, 'terminal.log');
    try {
      writeFileSync(
        logPath,
        [
          'extractor build complete',
          formatJobLogEndMarker('completed', 0, Date.UTC(2026, 8, 13, 15, 0, 0)),
          formatJobLogEndMarker('failed', 1, Date.UTC(2026, 8, 13, 15, 0, 1)),
        ].join('\n'),
      );
      store.getTask.mockResolvedValue(
        taskRow({
          state: 'exited',
          exitCode: 0,
          logPath,
        }),
      );
      jobs.getJob.mockReturnValue(null);

      const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx('ws-current', stateDir));
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(result.isError).toBeUndefined();
      expect(payload).toMatchObject({
        ok: true,
        task_id: 'task-carry-1',
        status: 'completed',
        exit_code: 0,
        running: false,
        recovered_from_ledger: true,
      });
      expect(payload).not.toHaveProperty('recovered_from_log_marker');
      expect(jobs.startBackground).not.toHaveBeenCalled();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('trusts a durable JOB END when the ledger only knows the process ended unobserved', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-unobserved-with-end-marker-'));
    const logPath = join(stateDir, 'terminal.log');
    try {
      writeFileSync(logPath, `publication complete${formatJobLogEndMarker('completed', 0, Date.UTC(2026, 8, 19, 13, 15, 33))}`);
      store.getTask.mockResolvedValue(taskRow({ state: 'ended_unobserved', exitCode: null, logPath }));
      jobs.getJob.mockReturnValue(null);

      const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx('ws-current', stateDir));
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(result.isError).toBeUndefined();
      expect(payload).toMatchObject({
        ok: true,
        status: 'completed',
        exit_code: 0,
        recovered_from_log_marker: true,
      });
      expect(payload).not.toHaveProperty('reason', 'job_process_gone');
      expect(jobs.startBackground).not.toHaveBeenCalled();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('uses a failed JOB END marker to resolve a stale nonterminal ledger row as an error', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bash-stale-marker-failure-'));
    const logPath = join(stateDir, 'stale.log');
    try {
      writeFileSync(logPath, `partial output${formatJobLogEndMarker('failed', 1, Date.UTC(2026, 8, 13, 15, 1, 0))}`);
      store.getTask.mockResolvedValue(
        taskRow({
          state: 'running',
          pid: null,
          processIdentity: null,
          cgroupPath: null,
          logPath,
        }),
      );
      jobs.getJob.mockReturnValue(null);

      const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx('ws-current', stateDir));
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(result.isError).toBe(true);
      expect(payload).toMatchObject({
        ok: false,
        task_id: 'task-carry-1',
        status: 'failed',
        exit_code: 1,
        running: false,
        recovered_from_log_marker: true,
      });
      expect(jobs.startBackground).not.toHaveBeenCalled();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('keeps live bash rows without a durable handle non-attachable', async () => {
    store.getTask.mockResolvedValue(taskRow({ detail: {} }));

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('task_not_attachable');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('reports ledger failure as unknown, never as a healthy miss or a restart', async () => {
    store.getTask.mockRejectedValue(new Error('db unavailable'));

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('task_ledger_unavailable');
    expect(String(payload.advice)).toContain('NOT restarted');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });
});
