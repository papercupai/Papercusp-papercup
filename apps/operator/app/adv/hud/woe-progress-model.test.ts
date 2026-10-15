import { describe, expect, it } from 'vitest';
import { completionSeries, filterAndSort, planState, progressRows } from './woe-progress-model';
import type { WorklistRow } from './ongoing-work-draft';

const row = (over: Partial<WorklistRow>): WorklistRow => ({ id: 'plan:h/x', selected: true, label: 'X', state: null,
  reason: null, counts: { todo: 0, wip: 0, blocked: 0, needsHuman: 0, done: 0 }, ...over });
const c = (todo: number, wip: number, blocked: number, needsHuman: number, done: number) => ({ todo, wip, blocked, needsHuman, done });

describe('woe progress model (WI-10007603)', () => {
  it('derives plain-language states from measured counts before placement', () => {
    expect(planState(row({ counts: null })).key).toBe('unknown');
    expect(planState(row({ counts: c(0, 0, 0, 0, 0) })).key).toBe('empty');
    expect(planState(row({ counts: c(3, 1, 0, 2, 0) })).key).toBe('moving');
    expect(planState(row({ counts: c(3, 0, 0, 2, 0) })).key).toBe('you');
    expect(planState(row({ counts: c(0, 0, 0, 0, 5) })).key).toBe('signoff');
    expect(planState(row({ counts: c(0, 0, 2, 0, 1) })).key).toBe('stuck');
    expect(planState(row({ counts: c(2, 0, 0, 0, 1), state: 'blocked' })).key).toBe('stuck');
    // An unpicked plan is "blocked" for placement only; its own items are ready.
    const out = planState(row({ selected: false, counts: c(2, 0, 0, 0, 1), state: 'blocked' }));
    expect(out).toMatchObject({ key: 'idle', label: 'Ready · nobody on it' });
    expect(out.why).toContain('add it to the worklist');
  });

  it('ranks only picked rows and sorts the worklist ahead of the rest', () => {
    const rows = progressRows([row({ id: 'a', label: 'A', counts: c(1, 0, 0, 0, 0) }),
      row({ id: 'b', label: 'B', selected: false, counts: c(9, 0, 0, 0, 0) }), row({ id: 'c', label: 'C', counts: c(5, 0, 0, 0, 0) })]);
    expect(rows.map((r) => r.rank)).toEqual([0, -1, 1]);
    const opts = { scope: 'all' as const, state: null, showEmpty: false, query: '' };
    expect(filterAndSort(rows, { ...opts, sort: 'left' }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(filterAndSort(rows, { ...opts, sort: 'rank' }).map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(filterAndSort(rows, { ...opts, sort: 'name', scope: 'out' }).map((r) => r.id)).toEqual(['b']);
    expect(filterAndSort(rows, { ...opts, sort: 'name', query: 'c' }).map((r) => r.id)).toEqual(['c']);
  });

  it('fills the measured window with zero days and stays unmeasured when the server omits it', () => {
    const nowMs = Date.parse('2026-10-08T23:00:00Z');
    expect(completionSeries({ completedByDay: { windowDays: 3, days: [{ day: '2026-10-07', done: 4 }] } }, nowMs))
      .toEqual([{ day: '2026-10-06', done: 0 }, { day: '2026-10-07', done: 4 }, { day: '2026-10-08', done: 0 }]);
    expect(completionSeries({}, nowMs)).toBeNull();
  });
});
