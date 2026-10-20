/**
 * bug-inflow.test.ts — the stored inflow-vs-closes rollup behind the work.bugInflow cell
 * (bug-inflow-one-problem-one-row-2026-10-18 P-007 / R-6).
 *
 * R-6 acceptance: "The inflow state cell returns filed-per-day by source and
 * closed-per-day from stored values without a live aggregate query." So these tests pin
 * (1) the reader issues ONE SELECT on bug_inflow_daily and never touches work_items,
 * (2) the shaping keeps per-source and per-status counts and never fills a missing day
 * with zero, (3) freshness is an explicit assessment, and (4) the cell is registered
 * against the read-only resolver tool with that assessment.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BUG_INFLOW_READ_SQL,
  BUG_INFLOW_REFRESH_SQL,
  BUG_INFLOW_STALE_AFTER_MS,
  BUG_INFLOW_TABLE,
  formatBugInflowLine,
  readBugInflowDaily,
  refreshBugInflowDaily,
  shapeBugInflow,
  type BugInflowRow,
} from './bug-inflow';
import { BUILTIN_CELLS, WORK_BUG_INFLOW_CELL } from '../../cell-registrations';
import { validateCellSpec } from '../../cell-registry';

const NOW = new Date('2026-10-20T12:00:00Z');

function row(day: string, over: Partial<BugInflowRow> = {}): BugInflowRow {
  return {
    day,
    filed_total: 10,
    filed_by_source: { watchdog: 6, 'role:su': 4 },
    closed_total: 7,
    closed_by_status: { done: 5, dropped: 2 },
    computed_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    ...over,
  } as BugInflowRow;
}

function fakeSql(rows: unknown[]) {
  const unsafe = vi.fn(async (_q: string, _p: unknown[]) => rows);
  return { sql: { unsafe } as never, unsafe };
}

describe('shapeBugInflow — stored rows to the cell reading', () => {
  it('sums filed by source and closed by status across stored days, newest first', () => {
    const r = shapeBugInflow([
      row('2026-10-20'),
      row('2026-10-19', { filed_total: 3, filed_by_source: { watchdog: 3 }, closed_total: 9, closed_by_status: { done: 9 } }),
    ], { now: NOW, windowDays: 2 });
    expect(r.assessment).toBe('measured');
    expect(r.reasons).toEqual([]);
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-20', '2026-10-19']);
    expect(r.days[0]).toMatchObject({ filedTotal: 10, closedTotal: 7, net: 3 });
    expect(r.totals).toEqual({
      filed: 13,
      closed: 16,
      net: -3,
      filedBySource: { watchdog: 9, 'role:su': 4 },
      closedByStatus: { done: 14, dropped: 2 },
    });
    expect(r.missingDays).toEqual([]);
    expect(r.storage).toBe(BUG_INFLOW_TABLE);
  });

  it('lists a day with no stored row in missingDays and never counts it as zero', () => {
    const r = shapeBugInflow([row('2026-10-20'), row('2026-10-18')], { now: NOW, windowDays: 3 });
    expect(r.missingDays).toEqual(['2026-10-19']);
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-20', '2026-10-18']);
    expect(r.days.some((d) => d.day === '2026-10-19')).toBe(false);
  });

  it('is unmeasured with no stored rows (0 must not read as "no inflow")', () => {
    const r = shapeBugInflow([], { now: NOW, windowDays: 7 });
    expect(r.assessment).toBe('unmeasured');
    expect(r.days).toEqual([]);
    expect(r.missingDays).toHaveLength(7);
    expect(r.reasons[0]).toMatch(/no stored row/);
    expect(r.computedAt).toBeNull();
  });

  it('is stale when today has no stored row', () => {
    const r = shapeBugInflow([row('2026-10-19')], { now: NOW, windowDays: 2 });
    expect(r.assessment).toBe('stale');
    expect(r.reasons.join(' ')).toMatch(/no stored row for today \(2026-10-20\)/);
  });

  it('is stale when the newest row is older than the staleness bound', () => {
    const old = new Date(NOW.getTime() - BUG_INFLOW_STALE_AFTER_MS - 60_000).toISOString();
    const r = shapeBugInflow([row('2026-10-20', { computed_at: old })], { now: NOW, windowDays: 1 });
    expect(r.assessment).toBe('stale');
    expect(r.ageMs).toBeGreaterThan(BUG_INFLOW_STALE_AFTER_MS);
  });
});

describe('readBugInflowDaily — stored values only', () => {
  it('issues one SELECT on bug_inflow_daily and no aggregate over work_items', async () => {
    const { sql, unsafe } = fakeSql([row('2026-10-20')]);
    const r = await readBugInflowDaily('ws-1', { days: 7, now: NOW, sql });
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [query, params] = unsafe.mock.calls[0];
    expect(query).toBe(BUG_INFLOW_READ_SQL);
    expect(query).toMatch(/^\s*SELECT\b/);
    expect(query).toContain(BUG_INFLOW_TABLE);
    expect(query).not.toMatch(/work_items/);
    expect(query).not.toMatch(/\b(count|sum)\s*\(/i);
    expect(params).toEqual(['ws-1', '2026-10-14', '2026-10-20']);
    expect(r.assessment).toBe('measured');
  });

  it('clamps the window to 1..30 days', async () => {
    const { sql, unsafe } = fakeSql([]);
    await readBugInflowDaily('ws-1', { days: 400, now: NOW, sql });
    expect(unsafe.mock.calls[0][1]).toEqual(['ws-1', '2026-09-21', '2026-10-20']);
  });
});

describe('refreshBugInflowDaily — the tick writer', () => {
  it('recomputes today and yesterday by default with matching day and epoch-ms bounds', async () => {
    const { sql, unsafe } = fakeSql([{ day: '2026-10-19' }, { day: new Date('2026-10-20T00:00:00Z') }]);
    const out = await refreshBugInflowDaily('ws-1', { now: NOW, sql });
    const [query, params] = unsafe.mock.calls[0];
    expect(query).toBe(BUG_INFLOW_REFRESH_SQL);
    expect(query).toMatch(/ON CONFLICT \(workspace_id, day\) DO UPDATE/);
    expect(query).toMatch(/lane IS DISTINCT FROM 'observation'/);
    expect(params).toEqual([
      'ws-1', '2026-10-19', '2026-10-21',
      Date.parse('2026-10-19T00:00:00Z'), Date.parse('2026-10-21T00:00:00Z'),
    ]);
    expect(out.days).toEqual(['2026-10-19', '2026-10-20']);
  });
});

describe('formatBugInflowLine — the fleet brief line', () => {
  it('shows filed by top source next to closed by status and the net', () => {
    const line = formatBugInflowLine(shapeBugInflow([row('2026-10-20')], { now: NOW, windowDays: 1 }));
    expect(line).toBe('bug inflow 1d: filed 10 (watchdog 6, role:su 4) vs closed 7 (done 5, dropped 2) · net +3 · 2026-10-20: filed 10 / closed 7');
  });

  it('says unmeasured instead of printing zeros', () => {
    expect(formatBugInflowLine(shapeBugInflow([], { now: NOW, windowDays: 7 }))).toMatch(/^bug inflow: unmeasured — /);
  });

  it('carries the stale reason inline', () => {
    expect(formatBugInflowLine(shapeBugInflow([row('2026-10-19')], { now: NOW, windowDays: 2 }))).toMatch(/⚠ stale: no stored row for today/);
  });
});

describe('work.bugInflow cell registration', () => {
  it('is a built-in that validates with zero rejections', () => {
    expect(BUILTIN_CELLS).toContain(WORK_BUG_INFLOW_CELL);
    expect(validateCellSpec(WORK_BUG_INFLOW_CELL)).toEqual([]);
  });

  it('polls the read-only improvements:bug-inflow resolver and assesses every reading outcome', () => {
    expect(WORK_BUG_INFLOW_CELL.changeSignal).toEqual({ kind: 'poll', tool: 'improvements:bug-inflow', path: 'inflow' });
    expect(WORK_BUG_INFLOW_CELL.assessment?.path).toBe('assessments.bugInflow');
    expect(Object.keys(WORK_BUG_INFLOW_CELL.assessment?.codes ?? {}).sort()).toEqual(['measured', 'stale', 'unmeasured']);
  });
});
