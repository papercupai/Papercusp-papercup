/**
 * CAP-CONTRACT-P002-YIELD-SAME-JOB@1 — capability:bash ordinary calls start one
 * durable job, wait for fast completion, and yield that same job at the bounded
 * response window without killing or relaunching it.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unwrapToolResult } from '@papercusp/tooldef';
import type { Sql } from 'postgres';
import * as bashJobs from './bash-jobs';
import * as enrollSync from '../../task-manager/enroll-sync';
import * as taskStore from '../../task-manager/store';
import * as taskProvenance from './bash-task-provenance';
import { listTasks } from '../../task-manager/store';

vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxPolicy: vi.fn(async () => ({
    enabled: false,
    required: false,
    profile: { kind: 'trusted', reason: 'start-once-yield-test' },
  })),
}));

import bashTool from './bash';
import bashOutputTool from './bash_output';
import { __resetBashJobs, getJob, TIMEOUT_SIGTERM_GRACE_MS } from './bash-jobs';
import { FOREGROUND_TIMEOUT_CEILING_MS } from './foreground-transport-cap';

type ToolResult = {
  content: Array<{ text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<ToolResult> };
type ArgsSchema = { safeParse: (value: unknown) => { success: boolean } };

const bash = bashTool as unknown as Tool;
const bashOutput = bashOutputTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-start-once-'));

function makeCtx(options: { signal?: AbortSignal; codeMode?: boolean; emitted?: string[]; dispatchCallId?: string } = {}) {
  return {
    projectDir: STATE,
    stateDir: STATE,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    signal: options.signal ?? new AbortController().signal,
    emit: (event: string, chunk: string) => {
      if (event === 'output') options.emitted?.push(chunk);
    },
    role: 'operator',
    ...(options.dispatchCallId ? { dispatchCallId: options.dispatchCallId } : {}),
    ...(options.codeMode ? { codeMode: true } : {}),
  } as never;
}

function jsonPayload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function readUntilTerminal(bashId: string): Promise<{ payload: Record<string, unknown>; output: string }> {
  let output = '';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await bashOutput.handler({ bash_id: bashId }, makeCtx());
    const payload = jsonPayload(result);
    output += String(payload.output ?? '');
    if (payload.status !== 'running') return { payload, output };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${bashId} did not reach a terminal status`);
}

afterEach(() => {
  __resetBashJobs();
});

describe('capability:bash — start once and yield the same durable job (P-002)', () => {
  it('carries the API parent through validated provenance into the real child enrollment', async () => {
    const provenance = vi.spyOn(taskProvenance, 'resolveCapabilityBashTaskProvenance').mockResolvedValue({
      launchedBy: 'owner', sessionId: 'owner', harnessSlug: 'papercusp', workItemId: 'WI-current',
      planSlug: null, goalRef: 'WI-current', parentTaskId: 'parent123',
    });
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});
    const live = vi.spyOn(taskStore, 'listLiveTasks').mockResolvedValue([]);
    try {
      const raw = await bash.handler({ command: 'printf CHILD-LINEAGE', timeout: 5_000,
        parent_task_id: 'parent123', work_item_id: 'WI-current' }, makeCtx({ codeMode: true }));
      const result = unwrapToolResult(raw as never);
      expect(provenance.mock.calls[0]?.[3]).toMatchObject({ explicitParentTaskId: 'parent123' });
      expect(complete.mock.calls[0]?.[1]).toMatchObject({ parentTaskId: 'parent123', workItemId: 'WI-current' });
      expect(result).toMatchObject({ status: 'completed', output: 'CHILD-LINEAGE' });
    } finally { provenance.mockRestore(); complete.mockRestore(); finish.mockRestore(); live.mockRestore(); }
  });

  it('dispatch correlation recovers a lost launch response without a second launch or enrollment', async () => {
    const dispatchCallId = 'server-owned-dispatch';
    const marker = join(STATE, `dispatch-correlation-${crypto.randomUUID()}.txt`);
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
      taskId: 'correlated-shell-task', enrolled: true, confined: false,
      unconfinedReason: 'no-scope-support', unitKind: 'scope', scopeUnit: null,
      registrationReady: null, wrap: (binary: string, argv: string[]) => ({ binary, argv }),
      releaseEnvironmentTransport: () => {},
    });
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});
    const launch = vi.spyOn(bashJobs, 'startBackground');
    const liveTasks = vi.spyOn(taskStore, 'listLiveTasks').mockResolvedValue([]);
    try {
      // Deliberately discard the entire launch response, including bash_id/task_id.
      await bash.handler({
        command: `printf 'once\\n' >> '${marker}'`, timeout: 5_000,
        run_in_background: true, dispatchCallId: 'client-forged-dispatch',
      }, makeCtx({ dispatchCallId, codeMode: true }));
      const enrolled = complete.mock.calls[0]![1];
      expect(enrolled.detail).toMatchObject({ dispatchCallId });
      expect(enrolled.detail?.dispatchCallId).not.toBe('client-forged-dispatch');
      const bashId = String(enrolled.detail?.bashJobId);
      const original = getJob(bashId)!;
      await readUntilTerminal(bashId);
      const queries: string[] = [];
      const params: unknown[] = [];
      const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
        const text = Array.from(strings).join('?');
        queries.push(text); params.push(...args);
        return Promise.resolve(text.includes('SELECT') ? [{
          task_id: 'correlated-shell-task', workspace_id: 'papercusp-workspace',
          root_task_id: 'correlated-shell-task', class: enrolled.class, title: enrolled.title,
          argv: enrolled.argv, launched_by: enrolled.launchedBy, state: 'exited',
          detail: enrolled.detail,
        }] : []);
      }) as unknown as Sql;
      const recovered = await listTasks({
        workspaceId: 'papercusp-workspace', dispatchCallId, includeEnded: true, limit: 1,
      }, sql);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ taskId: original.taskId, detail: { dispatchCallId, bashJobId: bashId } });
      expect(params).toContain(dispatchCallId);
      expect(queries.join('\n')).not.toMatch(/INSERT|UPDATE|DELETE/);
      expect(launch).toHaveBeenCalledOnce();
      expect(begin).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
      expect(getJob(bashId)).toBe(original);
      expect(readFileSync(marker, 'utf8')).toBe('once\n');
    } finally { liveTasks.mockRestore(); launch.mockRestore(); begin.mockRestore(); complete.mockRestore(); finish.mockRestore(); }
  });

  it('warns that an empty process table cannot prove a host process is gone', async () => {
    const result = await bash.handler(
      { command: 'ps -eo pid --no-headers', timeout: 5_000 },
      makeCtx({ codeMode: true }),
    );
    expect(result.content[0]!.text).toContain('NOTICE: Process-table output may be limited');
    expect(result.structuredContent?.process_table_notice).toContain('does not prove a host process is gone');
    expect(result.content[0]!.text).toContain('processes:list');
  });

  it('publishes a separate bounded response-window argument', () => {
    const args = (bashTool as unknown as { args: ArgsSchema }).args;
    expect(args.safeParse({ command: 'true', timeout: 60_000, yield_after_ms: 10 }).success).toBe(true);
    expect(
      args.safeParse({ command: 'true', timeout: 60_000, yield_after_ms: FOREGROUND_TIMEOUT_CEILING_MS }).success,
    ).toBe(true);
    expect(
      args.safeParse({ command: 'true', timeout: 60_000, yield_after_ms: FOREGROUND_TIMEOUT_CEILING_MS + 1 }).success,
    ).toBe(false);
  });

  it('refuses an unjoined shell child for ordinary calls before creating a durable task', async () => {
    const result = await bash.handler(
      { command: 'sleep 30 & echo detached', timeout: 5_000, yield_after_ms: 50 },
      makeCtx({ codeMode: true }),
    );
    const seen = jsonPayload(result);

    expect(result.isError).toBe(true);
    expect(seen).toMatchObject({ ok: false, reason: 'untracked_shell_background' });
    expect(String(seen.message)).toContain('without joining it');
    expect(seen.task_id).toBeUndefined();
  });

  it('returns fast completion as a terminal direct result with a complete-output reference', async () => {
    const emitted: string[] = [];
    const result = await bash.handler(
      { command: 'printf FAST-TERMINAL', timeout: 5_000, yield_after_ms: 2_000 },
      makeCtx({ emitted }),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('exit 0');
    expect(result.content[0]!.text).toContain('FAST-TERMINAL');
    expect(result.content[0]!.text).toContain('full output →');
    expect(emitted.join('')).toContain('FAST-TERMINAL');
  });

  it('yields one still-running job, then recovers later output and one execution through the same id', async () => {
    const marker = join(STATE, `start-once-marker-${crypto.randomUUID()}.txt`);
    const emitted: string[] = [];
    const result = await bash.handler(
      {
        command:
          `printf 'start\\n' >> ${JSON.stringify(marker)}; printf 'EARLY\\n'; ` +
          `sleep 0.5; printf 'LATE\\n'; printf 'done\\n' >> ${JSON.stringify(marker)}`,
        timeout: 5_000,
        yield_after_ms: 50,
      },
      makeCtx({ emitted, codeMode: true }),
    );
    const yielded = jsonPayload(result);

    expect(yielded).toMatchObject({
      ok: true,
      status: 'running',
      running: true,
      yielded: true,
      response_window_ms: 50,
      timeout_ms: 5_000,
    });
    expect(result.structuredContent).toEqual(yielded);
    expect(typeof yielded.bash_id).toBe('string');
    expect(typeof yielded.task_id).toBe('string');
    expect(typeof yielded.log_path).toBe('string');

    const bashId = String(yielded.bash_id);
    const originalJob = getJob(bashId);
    const originalPid = originalJob?.child.pid;
    const emittedAtYield = emitted.join('');
    expect(originalJob?.taskId).toBe(yielded.task_id);
    expect(originalPid).toBeTypeOf('number');

    const later = await readUntilTerminal(bashId);
    const sameJob = getJob(bashId);
    const combinedOutput = String(yielded.output ?? '') + later.output;
    expect(later.payload).toMatchObject({ status: 'completed', exit_code: 0, running: false });
    expect(sameJob).toBe(originalJob);
    expect(sameJob?.child.pid).toBe(originalPid);
    expect(combinedOutput).toContain('EARLY');
    expect(combinedOutput).toContain('LATE');
    expect(emitted.join('')).toBe(emittedAtYield);
    expect(emitted.join('')).not.toContain('LATE');
    expect(readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['start', 'done']);
    expect(readFileSync(String(yielded.log_path), 'utf8')).toContain('LATE');
  });

  // WI-10003863: the response window must leave room for the deadline's whole-tree
  // cleanup, not just the deadline itself. The deadline marks the job `timed_out` at
  // 1s, but the call only returns terminal once the child's `close` arrives
  // (SIGTERM, then SIGKILL after TIMEOUT_SIGTERM_GRACE_MS). With a 2s window, a
  // loaded gate host delivered `close` after the window and the call yielded. A
  // window past the SIGKILL escalation makes the terminal result certain; the call
  // still returns at `close` (about 1s on an idle host), so the test stays fast.
  const TIMEOUT_MS = 1_000;
  const RESPONSE_WINDOW_MS = TIMEOUT_MS + TIMEOUT_SIGTERM_GRACE_MS + 10_000;
  it(
    'keeps timeout as the independent execution deadline',
    async () => {
      const result = await bash.handler(
        {
          command: 'printf BEFORE-TIMEOUT; sleep 30',
          timeout: TIMEOUT_MS,
          yield_after_ms: RESPONSE_WINDOW_MS,
        },
        makeCtx({ codeMode: true }),
      );
      const seen = unwrapToolResult(result as never) as Record<string, unknown>;

      expect(seen).toMatchObject({
        ok: false,
        status: 'timed_out',
        running: false,
        yielded: false,
        timeout_ms: TIMEOUT_MS,
        response_window_ms: RESPONSE_WINDOW_MS,
      });
      expect(String(seen.output)).toContain('BEFORE-TIMEOUT');
      expect(String(seen.log_path)).toContain('bash-');
    },
    RESPONSE_WINDOW_MS + 10_000,
  );

  it('treats caller abort as cancellation of that same whole process tree', async () => {
    const orphanMarker = join(STATE, `abort-orphan-${crypto.randomUUID()}.txt`);
    const releaseMarker = join(STATE, `abort-release-${crypto.randomUUID()}.txt`);
    const emitted: string[] = [];
    const controller = new AbortController();
    const resultPromise = bash.handler(
      {
        command: `(printf 'CHILD-READY\\n'; while test ! -e ${JSON.stringify(releaseMarker)}; do sleep 0.02; done; printf orphan > ${JSON.stringify(orphanMarker)}) & wait`,
        timeout: 5_000,
        yield_after_ms: 10_000,
      },
      makeCtx({ signal: controller.signal, codeMode: true, emitted }),
    );
    // Abort only after observing the child. A fixed 100ms timer can fire after
    // its old 800ms payload already finished during synchronous job setup.
    await vi.waitFor(() => expect(emitted.join('')).toContain('CHILD-READY'), { timeout: 5_000 });
    controller.abort();

    const result = await resultPromise;
    const seen = unwrapToolResult(result as never) as Record<string, unknown>;
    expect(seen.status).toBe('killed');
    expect(seen.running).toBe(false);
    expect(typeof seen.bash_id).toBe('string');
    expect(getJob(String(seen.bash_id))?.status).toBe('killed');

    // Release any survivor: a detached child would now write the orphan marker.
    writeFileSync(releaseMarker, 'release');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(orphanMarker)).toBe(false);
  });
});
