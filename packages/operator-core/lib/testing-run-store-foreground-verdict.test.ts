/**
 * getForegroundRunVerdictAsync — a foreground testing:run released by a
 * host-shutdown handoff can die at its scope RuntimeMaxSec without writing a
 * ledger row. The verdict must say LOST, not leave readers on an ambiguous
 * "unknown" forever (WI-6554700010018414).
 */

import { describe, expect, it } from 'vitest';
import { getForegroundRunVerdictAsync, TestingRunSnapshotUnavailableError } from './testing-run-store';

type TaskRow = { task_id: string; state: string; started_at: number | null; ended_at: number | null; exit_code: number | null };

/** A tagged-template fake that answers the two reads the verdict makes. */
function fakeSql(opts: { tasks: TaskRow[] | 'throw'; ledgerRows: number | 'throw' }) {
  const seen: string[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown> => {
    const text = strings.join('?');
    seen.push(text);
    if (text.includes('harness_shared.task_ledger')) {
      expect(values).toContain('testing:run:run-1');
      return opts.tasks === 'throw' ? Promise.reject(new Error('pg down')) : Promise.resolve(opts.tasks);
    }
    if (text.includes('harness_shared.test_runs')) {
      return opts.ledgerRows === 'throw'
        ? Promise.reject(new Error('pg down'))
        : Promise.resolve([{ n: opts.ledgerRows }]);
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return { sql, seen };
}

const task = (state: string): TaskRow => ({ task_id: 'task-1', state, started_at: 1000, ended_at: 2000, exit_code: null });

describe('getForegroundRunVerdictAsync', () => {
  it('reports LOST when the foreground task ended without any ledger row', async () => {
    const { sql } = fakeSql({ tasks: [task('ended_unobserved')], ledgerRows: 0 });
    const out = await getForegroundRunVerdictAsync('run-1', sql);
    expect(out).toMatchObject({ runId: 'run-1', taskId: 'task-1', taskState: 'ended_unobserved', ledgerRows: 0, verdict: 'lost' });
  });

  it.each(['killed', 'timed_out', 'exited'])('reports LOST for terminal state %s with zero rows', async (state) => {
    const { sql } = fakeSql({ tasks: [task(state)], ledgerRows: 0 });
    expect((await getForegroundRunVerdictAsync('run-1', sql))?.verdict).toBe('lost');
  });

  it('reports RUNNING while the task is live and no row exists yet', async () => {
    const { sql } = fakeSql({ tasks: [task('running')], ledgerRows: 0 });
    expect((await getForegroundRunVerdictAsync('run-1', sql))?.verdict).toBe('running');
  });

  it('reports RECORDED whenever ledger rows exist, whatever the task state', async () => {
    const { sql } = fakeSql({ tasks: [task('ended_unobserved')], ledgerRows: 3 });
    expect(await getForegroundRunVerdictAsync('run-1', sql)).toMatchObject({ verdict: 'recorded', ledgerRows: 3 });
  });

  it('returns null when no foreground task exists for the run id', async () => {
    const { sql, seen } = fakeSql({ tasks: [], ledgerRows: 0 });
    expect(await getForegroundRunVerdictAsync('run-1', sql)).toBeNull();
    expect(seen.some((q) => q.includes('test_runs'))).toBe(false);
  });

  it('refuses to call an ambiguous or unreadable lookup lost', async () => {
    await expect(getForegroundRunVerdictAsync('run-1', fakeSql({ tasks: [task('exited'), task('exited')], ledgerRows: 0 }).sql))
      .rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
    await expect(getForegroundRunVerdictAsync('run-1', fakeSql({ tasks: 'throw', ledgerRows: 0 }).sql))
      .rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
    await expect(getForegroundRunVerdictAsync('run-1', fakeSql({ tasks: [task('exited')], ledgerRows: 'throw' }).sql))
      .rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });
});
