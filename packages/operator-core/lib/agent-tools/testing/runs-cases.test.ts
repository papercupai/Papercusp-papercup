/**
 * test-rubric-unification-2026-10-12 P-001 (R-1): testing:runs { cases:true } reads the
 * per-case rows the Vitest reporter writes to harness_shared.test_case_runs (migration 1478).
 */
import { describe, expect, it } from 'vitest';
import { loadTestCaseResults } from './runs';

type Sql = Parameters<typeof loadTestCaseResults>[0];

/** A tagged-template fake that records the bound id array and answers with `respond()`. */
function fakeSql(respond: () => Promise<unknown>) {
  const calls: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push([strings.join('?'), ...values]);
    return respond();
  }) as unknown as Sql;
  return { sql, calls };
}

describe('loadTestCaseResults', () => {
  it('groups case rows by run id in the order the query returns them', async () => {
    const fake = fakeSql(async () => [
      { test_run_id: '11', case_key: 'suite > a', occurrence: 1, status: 'pass', duration_ms: 3, error_tail: null },
      { test_run_id: '11', case_key: 'suite > b', occurrence: 1, status: 'fail', duration_ms: 5, error_tail: 'boom' },
      { test_run_id: '12', case_key: 'suite > a', occurrence: 1, status: 'skip', duration_ms: null, error_tail: null },
    ]);
    const { byRun, notMigrated } = await loadTestCaseResults(fake.sql, [11, 12, 13]);
    expect(notMigrated).toBe(false);
    expect(byRun.get(11)).toEqual([
      { caseKey: 'suite > a', occurrence: 1, status: 'pass', durationMs: 3, errorTail: null },
      { caseKey: 'suite > b', occurrence: 1, status: 'fail', durationMs: 5, errorTail: 'boom' },
    ]);
    expect(byRun.get(12)).toEqual([
      { caseKey: 'suite > a', occurrence: 1, status: 'skip', durationMs: null, errorTail: null },
    ]);
    // A run without case rows is absent from the map, never an empty list.
    expect(byRun.has(13)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(String(fake.calls[0]![0])).toContain('harness_shared.test_case_runs');
    expect(String(fake.calls[0]![0])).toContain('ORDER BY test_run_id, case_index');
    expect(fake.calls[0]![1]).toEqual(['11', '12', '13']);
  });

  it('does not query when no rows were returned', async () => {
    const fake = fakeSql(async () => { throw new Error('must not query'); });
    expect(await loadTestCaseResults(fake.sql, [])).toEqual({ byRun: new Map(), notMigrated: false });
    expect(fake.calls).toHaveLength(0);
  });

  it('reports a ledger without migration 1478 as not-migrated rather than failing the read', async () => {
    const missing = Object.assign(new Error('relation "harness_shared.test_case_runs" does not exist'), { code: '42P01' });
    const fake = fakeSql(async () => { throw missing; });
    expect(await loadTestCaseResults(fake.sql, [1])).toEqual({ byRun: new Map(), notMigrated: true });
  });

  it('surfaces any other database error', async () => {
    const fake = fakeSql(async () => { throw Object.assign(new Error('timeout'), { code: '57014' }); });
    await expect(loadTestCaseResults(fake.sql, [1])).rejects.toThrow('timeout');
  });
});
