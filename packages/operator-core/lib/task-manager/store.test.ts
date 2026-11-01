import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { classifyTerminalClose, closeTask, getTask, listTasks, listTasksPage, markEndedUnobserved, markRecoveredFromJobLog, markStranded,
  reopenStrandedTask, type CloseTaskEffectsForTask } from './store';
import type { TaskTerminalProvenance } from './types';

function fakeSql(row: Record<string, unknown>): Sql {
  return (async () => [row]) as unknown as Sql;
}

describe('service timeout evidence', () => {
  const terminal: TaskTerminalProvenance = {
    capturedAt: '2026-10-25T01:52:22.650Z', scopeUnit: 'pc-timeout-phase.service',
    cgroupPath: null, invocationId: 'timeout-phase', loadState: 'loaded', activeState: 'failed',
    serviceResult: 'timeout', execMainCode: 1, execMainStatus: 0,
    memoryMaxBytes: null, peakMemoryBytes: null, peakMemorySource: 'unknown',
  };

  it('keeps successful main exit separate from a failed service without guessing its timeout phase', () => {
    const result = classifyTerminalClose({ state: 'exited', exitCode: 1, terminalProvenance: terminal }, null);
    expect(result).toMatchObject({ state: 'timed_out', exitCode: 0, exitReason: 'service-timeout-main-exit-0' });
    expect(result.terminalProvenance).toMatchObject({ serviceResult: 'timeout', execMainCode: 1, execMainStatus: 0 });
  });

  it('retains an observed execution deadline when the signal handler exits zero', () => {
    expect(classifyTerminalClose({ state: 'timed_out', exitCode: 0,
      exitReason: 'exceeded 180000ms timeout', terminalProvenance: terminal }, null)).toMatchObject({
      state: 'timed_out', exitCode: 0, exitReason: 'exceeded 180000ms timeout',
    });
  });

  it.each([
    { execMainCode: 2, execMainStatus: 15, expectedExit: 143 },
    { execMainCode: 1, execMainStatus: 1, expectedExit: 1 },
    { execMainCode: 0, execMainStatus: 0, expectedExit: 1 },
    { execMainCode: null, execMainStatus: null, expectedExit: 1 },
  ])('does not infer successful main exit from $execMainCode/$execMainStatus', ({ expectedExit, ...main }) => {
    expect(classifyTerminalClose({ state: 'exited', exitCode: 1,
      terminalProvenance: { ...terminal, ...main } }, null)).toMatchObject({
      state: 'timed_out', exitCode: expectedExit, exitReason: 'timeout',
    });
  });
});

describe('task-manager/store row mapping', () => {
  it('parses JSONB detail when the worker returns it as a string', async () => {
    const row = await getTask(
      'task-json-detail',
      fakeSql({
        task_id: 'task-json-detail',
        workspace_id: 'workspace-1',
        root_task_id: 'task-json-detail',
        class: 'bash-job',
        title: 'background task',
        argv: '[]',
        launched_by: 'test',
        confined: true,
        state: 'exited',
        detail: JSON.stringify({ bashJobId: 'bash-json-detail' }),
      }),
    );

    expect(row?.detail).toEqual({ bashJobId: 'bash-json-detail' });
  });

  it('uses an empty object for malformed or non-object detail', async () => {
    const malformed = await getTask(
      'task-bad-detail',
      fakeSql({
        task_id: 'task-bad-detail',
        workspace_id: 'workspace-1',
        root_task_id: 'task-bad-detail',
        class: 'bash-job',
        title: 'background task',
        argv: [],
        launched_by: 'test',
        confined: true,
        state: 'running',
        detail: '{not-json',
      }),
    );
    const array = await getTask(
      'task-array-detail',
      fakeSql({
        task_id: 'task-array-detail',
        workspace_id: 'workspace-1',
        root_task_id: 'task-array-detail',
        class: 'bash-job',
        title: 'background task',
        argv: [],
        launched_by: 'test',
        confined: true,
        state: 'running',
        detail: '[]',
      }),
    );

    expect(malformed?.detail).toEqual({});
    expect(array?.detail).toEqual({});
  });
});

describe('reopenStrandedTask', () => {
  it('reopens only an ended stranded row and clears its terminal tuple', async () => {
    const calls: Array<{ text: string; args: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      calls.push({ text: Array.from(strings).join('?'), args });
      return Promise.resolve([{ task_id: 'stranded-task' }]);
    }) as unknown as Sql;

    await expect(reopenStrandedTask('stranded-task', sql)).resolves.toBe(true);

    const query = calls[0]!.text;
    expect(query).toContain("SET state = 'running'");
    expect(query).toContain('exit_code = NULL');
    expect(query).toContain('exit_reason = NULL');
    expect(query).toContain('ended_at = NULL');
    expect(query).toContain("state = 'stranded'");
    expect(query).toContain('ended_at IS NOT NULL');
    expect(calls[0]!.args).toContain('stranded-task');
  });
});

describe('closeTask terminal event', () => {
  it.each(['stranded', 'unobserved', 'recovered'] as const)(
    'retains the exact task and blocked close phase through a %s batch', async (kind) => {
      const taskId = `batch-${kind}`;
      const sql = fakeSql({ task_id: taskId, workspace_id: 'workspace-1', class: 'other',
        state: 'running', ended_at: null, launched_by: 'fixture' });
      const stages: Array<{ taskId: string; name: string }> = [];
      const emit = vi.fn();
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const effects: CloseTaskEffectsForTask = (id) => ({
        stage: (name) => stages.push({ taskId: id, name }),
        cleanupVerifierDirectories: async () => { enter(); await gate; },
        emitTerminal: emit,
      });
      const closing = kind === 'stranded' ? markStranded([{ taskId, reason: 'gone' }], sql, effects)
        : kind === 'unobserved' ? markEndedUnobserved([{ taskId, reason: 'released' }], sql, effects)
          : markRecoveredFromJobLog([{ taskId, state: 'exited', exitCode: 2, reason: 'runner-log' }], sql, effects);
      try {
        await entered;
        expect(stages.at(-1)).toEqual({ taskId, name: 'task-close-cleanup' });
        expect(emit).not.toHaveBeenCalled();
      } finally { release(); }
      await expect(closing).resolves.toBe(1);
      expect(stages.at(-1)).toEqual({ taskId, name: 'task-close-event-complete' });
      expect(emit).toHaveBeenCalledOnce();
    },
  );

  it.each(['read', 'cleanup', 'update', 'event'] as const)(
    'identifies a blocked %s phase without reporting later close phases or returning early', async (blockedPhase) => {
      const row = { task_id: 'phase-task', workspace_id: 'workspace-1', class: 'other',
        state: 'running', ended_at: null, launched_by: 'fixture' };
      const stages: string[] = [];
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const pause = async (phase: typeof blockedPhase) => {
        if (phase === blockedPhase) { enter(); await gate; }
      };
      const sql = (async (strings: TemplateStringsArray) => {
        await pause(strings.join('').includes('UPDATE harness_shared.task_ledger') ? 'update' : 'read');
        return [row];
      }) as unknown as Sql;
      let finished = false;
      const closing = closeTask('phase-task', { state: 'exited', exitCode: 0 }, sql, {
        stage: (name) => { stages.push(name); },
        cleanupVerifierDirectories: async () => { await pause('cleanup'); },
        emitTerminal: async () => { await pause('event'); },
      }).then((result) => { finished = true; return result; });
      try {
        await entered;
        expect(stages.at(-1)).toBe(`task-close-${blockedPhase}`);
        expect(stages).not.toContain(`task-close-${blockedPhase}-complete`);
        expect(finished).toBe(false);
      } finally { release(); }
      await expect(closing).resolves.toBe(true);
      expect(stages).toEqual(['task-close-client-init', 'task-close-read', 'task-close-read-complete',
        'task-close-cleanup', 'task-close-cleanup-complete', 'task-close-update', 'task-close-update-complete',
        'task-close-event', 'task-close-event-complete']);
    },
  );

  it('retains the live ledger row and emits nothing when verifier cleanup fails, then retries before UPDATE', async () => {
    const row = { task_id: 'cleanup-task', workspace_id: 'workspace-1', class: 'bash-job',
      state: 'running', ended_at: null, launched_by: 'fixture' };
    let updates = 0;
    const sql = (async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('SET state =')) updates++;
      return [row];
    }) as unknown as Sql;
    const emitTerminal = vi.fn();
    const cleanupVerifierDirectories = vi.fn().mockRejectedValueOnce(new Error('cleanup IO failure'))
      .mockImplementationOnce(async () => { expect(updates).toBe(0); });
    const effects = { emitTerminal, cleanupVerifierDirectories };
    await expect(closeTask('cleanup-task', { state: 'killed', exitCode: 137 }, sql, effects))
      .rejects.toThrow('cleanup IO failure');
    expect(updates).toBe(0);
    expect(emitTerminal).not.toHaveBeenCalled();
    await expect(closeTask('cleanup-task', { state: 'killed', exitCode: 137 }, sql, effects)).resolves.toBe(true);
    expect(updates).toBe(1);
    expect(cleanupVerifierDirectories).toHaveBeenCalledTimes(2);
    expect(emitTerminal).toHaveBeenCalledOnce();
  });

  it('emits the exact first terminal transition and never emits for an idempotent replay', async () => {
    const emitTerminal = vi.fn();
    const row = {
      task_id: 'task-terminal-1',
      workspace_id: 'workspace-1',
      harness_slug: 'papercusp',
      class: 'pty',
      launched_by: 'su-a',
    };
    const firstSql = (async (strings: TemplateStringsArray) => strings.join('').includes('AS revision')
      ? [{ ...row, state: 'exited', exit_code: 0, exit_reason: null, revision: 1 }]
      : [row]) as unknown as Sql;
    const replaySql = (async () => []) as unknown as Sql;

    await expect(
      closeTask('task-terminal-1', { state: 'exited', exitCode: 0 }, firstSql, { emitTerminal }),
    ).resolves.toBe(true);
    expect(emitTerminal).toHaveBeenCalledOnce();
    expect(emitTerminal).toHaveBeenCalledWith({
      taskId: 'task-terminal-1',
      workspaceId: 'workspace-1',
      harnessSlug: 'papercusp',
      taskClass: 'pty',
      launchedBy: 'su-a',
      state: 'exited',
      exitCode: 0,
      exitReason: null,
      revision: 1,
    });

    await expect(
      closeTask('task-terminal-1', { state: 'exited', exitCode: 0 }, replaySql, { emitTerminal }),
    ).resolves.toBe(false);
    expect(emitTerminal).toHaveBeenCalledTimes(1);
  });
});

/**
 * The label pushdown (EI-21555395534019608).
 *
 * A label lookup that filters AFTER a capped `limit` silently misses matching rows
 * outside the window — on this box, five figures of ledger rows against a default
 * window of 200. These pin that the predicate actually reaches SQL, and that it uses
 * the operator that treats the prefix literally.
 */
function recordingSql(results: Array<Record<string, unknown>> = []) {
  const calls: Array<{ text: string; args: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    calls.push({ text: Array.from(strings).join('?'), args });
    return Promise.resolve(results);
  }) as unknown as Sql;
  (sql as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;
  return { sql, calls, text: () => calls.map((c) => c.text).join('\n') };
}

describe('listTasks pushes a label prefix into the query', () => {
  it('emits a starts_with predicate carrying the prefix as a bound parameter', async () => {
    const { sql, calls, text } = recordingSql();
    const prefix = 'acceptance-grader:acceptance-my_plan.v2-2026-08-26:';

    await listTasks({ workspaceId: 'ws-1', includeEnded: true, limit: 200, labelPrefix: prefix }, sql);

    expect(text()).toContain("starts_with(detail ->> 'label'");
    // Bound, not interpolated into the SQL text.
    expect(calls.flatMap((c) => c.args)).toContain(prefix);
    expect(text()).not.toContain(prefix);
  });

  it('NEGATIVE CONTROL: no label predicate is emitted when none was asked for', async () => {
    // Without this, the assertion above would pass just as happily against a query
    // that always filters by label, or against a scan that matched nothing.
    const { sql, text } = recordingSql();
    await listTasks({ workspaceId: 'ws-1', includeEnded: true, limit: 200 }, sql);
    expect(text()).not.toContain('starts_with');
  });

  it('uses starts_with rather than LIKE, because a label prefix contains `_`', async () => {
    // `_` is a single-character LIKE wildcard, so `LIKE prefix || '%'` matches labels
    // that merely RESEMBLE the prefix: verified against PostgreSQL 18.4,
    // 'acceptance-grader:xZy:1' LIKE 'acceptance-grader:x_y:%' is true. Real prefixes
    // carry `_` and `.` verbatim from the rubric ref, so this is reachable, not
    // theoretical. starts_with takes the operand literally.
    const { sql, text } = recordingSql();
    await listTasks({ workspaceId: 'ws-1', labelPrefix: 'acceptance-grader:a_b:' }, sql);
    expect(text()).toContain('starts_with');
    expect(text()).not.toMatch(/LIKE/i);
  });
});

describe('listTasks taskId filter', () => {
  it('dispatch correlation binds the exact identity inside the workspace before a small LIMIT', async () => {
    const { sql, calls, text } = recordingSql();
    const dispatchCallId = "dispatch_%' OR true --";
    await listTasks({ workspaceId: 'own-workspace', dispatchCallId, includeEnded: true, limit: 1 }, sql);
    expect(text()).toContain("detail ->> 'dispatchCallId' = ?");
    expect(text()).toContain('workspace_id = ?');
    expect(text().indexOf("detail ->> 'dispatchCallId' = ?")).toBeLessThan(text().indexOf('LIMIT'));
    expect(calls.flatMap((c) => c.args)).toContain(dispatchCallId);
    expect(calls.flatMap((c) => c.args)).toContain('own-workspace');
    expect(text()).not.toContain(dispatchCallId);
    expect(text()).not.toMatch(/title\s*(=|LIKE)|dispatchCallId'\s+LIKE/i);
    expect(calls.at(-1)?.args.at(-1)).toBe(1);
  });

  it('dispatch correlation leaves legacy unfiltered reads unchanged when identity is absent', async () => {
    const { sql, text } = recordingSql();
    await listTasks({ workspaceId: 'own-workspace', limit: 1 }, sql);
    expect(text()).not.toContain('dispatchCallId');
    expect(text()).toContain('workspace_id = ?');
    expect(text()).toContain('ended_at IS NULL');
  });

  it('filters an exact identity batch before ordering and limiting', async () => {
    const { sql, text } = recordingSql();
    sql.array = vi.fn(() => 'bound-task-array') as unknown as typeof sql.array;
    await listTasks({ workspaceId: 'ws-1', includeEnded: true, taskIds: ['older', 'recent'], limit: 2 }, sql);
    expect(sql.array).toHaveBeenCalledWith(['older', 'recent'], 25);
    expect(text()).toContain('task_id = ANY');
    expect(text().indexOf('task_id = ANY')).toBeLessThan(text().indexOf('LIMIT'));
  });

  it('does not turn an empty identity batch into an unfiltered ledger read', async () => {
    const { sql, calls } = recordingSql();
    expect(await listTasks({ workspaceId: 'ws-1', taskIds: [] }, sql)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('emits an exact task_id predicate carrying the durable id as a bound parameter', async () => {
    const { sql, calls, text } = recordingSql();
    const taskId = 'task-to-kill';

    await listTasks({ workspaceId: 'ws-1', includeEnded: true, taskId }, sql);

    expect(text()).toContain('task_id = ?');
    expect(calls.flatMap((c) => c.args)).toContain(taskId);
    expect(text()).not.toContain(taskId);
  });

  it('does not emit a task_id predicate when no exact task is requested', async () => {
    const { sql, text } = recordingSql();

    await listTasks({ workspaceId: 'ws-1', includeEnded: true }, sql);

    expect(text()).not.toContain('task_id =');
  });
});

describe('listTasks exact systemd identity filters', () => {
  it('pushes the exact scope unit below the result limit', async () => {
    const { sql, calls, text } = recordingSql();
    const scopeUnit = 'papercup-green-checkpoint-manual-1fxzuva.service';

    await listTasks({ workspaceId: 'ws-1', includeEnded: true, limit: 2000, scopeUnit }, sql);

    expect(text()).toContain('scope_unit = ?');
    expect(text()).toContain("detail #>> '{terminalProvenance,scopeUnit}' = ?");
    expect(calls.flatMap((c) => c.args)).toContain(scopeUnit);
    expect(text()).not.toContain(scopeUnit);
  });

  it('pushes the exact terminal InvocationID below the result limit', async () => {
    const { sql, calls, text } = recordingSql();
    const invocationId = '8c91f74d2e6a4bbf90f44a71d142d095';

    await listTasks({ workspaceId: 'ws-1', includeEnded: true, limit: 2000, invocationId }, sql);

    expect(text()).toContain("detail #>> '{terminalProvenance,invocationId}' = ?");
    expect(calls.flatMap((c) => c.args)).toContain(invocationId);
    expect(text()).not.toContain(invocationId);
  });
});

describe('listTasksPage completeness metadata', () => {
  it('reports the exact filtered population separately from the capped rows', async () => {
    const { sql, calls, text } = recordingSql([
      {
        task_id: 'task-page-row', workspace_id: 'ws-1', root_task_id: 'task-page-row',
        class: 'bash-job', title: 'visible page row', argv: [], launched_by: 'su-test',
        confined: true, state: 'running', detail: {}, matching_count: 231,
      },
    ]);

    const page = await listTasksPage({ workspaceId: 'ws-1', includeEnded: true, limit: 200 }, sql);

    expect(page).toMatchObject({ totalCount: 231, limit: 200 });
    expect(page.rows).toHaveLength(1);
    expect(text()).toContain('COUNT(*) OVER() AS matching_count');
    expect(calls.at(-1)?.args.at(-1)).toBe(200);
  });

  it('reports zero matches when the bounded query returns no rows', async () => {
    const { sql } = recordingSql();

    await expect(listTasksPage({ workspaceId: 'ws-1', limit: 200 }, sql)).resolves.toMatchObject({
      rows: [], totalCount: 0, limit: 200,
    });
  });
});
