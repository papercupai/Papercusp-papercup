import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { closeTask, getTask, listTasks, reopenStrandedTask } from './store';

function fakeSql(row: Record<string, unknown>): Sql {
  return (async () => [row]) as unknown as Sql;
}

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
  it('retains the live ledger row and emits nothing when verifier cleanup fails, then retries before UPDATE', async () => {
    const row = { task_id: 'cleanup-task', workspace_id: 'workspace-1', class: 'bash-job',
      state: 'running', ended_at: null, launched_by: 'fixture' };
    let updates = 0;
    const sql = (async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('UPDATE harness_shared.task_ledger')) updates++;
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
    const firstSql = (async () => [row]) as unknown as Sql;
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
function recordingSql() {
  const calls: Array<{ text: string; args: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    calls.push({ text: Array.from(strings).join('?'), args });
    return Promise.resolve([]);
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
