/**
 * Pure presentation model for the Work-on-everything progress table
 * (WI-10007603, plan woe-progress-table-2026-10-08, design A).
 *
 * Every number here is derived from the goal-detail payload the server already
 * returns; nothing is invented. A row without measured counts stays
 * "Not measured" rather than reading as empty or finished.
 */
import type { GoalDetailInput } from './goal-detail-model';
import type { WorklistRow } from './ongoing-work-draft';

export type ProgressCounts = { todo: number; wip: number; blocked: number; needsHuman: number; done: number };
export type PlanStateKey = 'you' | 'stuck' | 'moving' | 'idle' | 'signoff' | 'empty' | 'unknown';
export type ScopeFilter = 'all' | 'in' | 'out';
export type SortKey = 'left' | 'pct' | 'rank' | 'name';

export const STATE_KEYS = ['you', 'stuck', 'moving', 'idle', 'signoff'] as const;
export const STATE_LABEL: Record<PlanStateKey, string> = {
  you: 'Waiting on you', stuck: 'Stuck', moving: 'In progress', idle: 'Ready · nobody on it',
  signoff: 'Finished · needs sign-off', empty: 'No items yet', unknown: 'Not measured',
};

export const total = (c: ProgressCounts) => c.todo + c.wip + c.blocked + c.needsHuman + c.done;
export const remaining = (c: ProgressCounts) => total(c) - c.done;
export const percent = (c: ProgressCounts) => (total(c) ? Math.round((100 * c.done) / total(c)) : 0);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * Plain-language state from measured counts first, placement second. A plan
 * outside the worklist is reported by what its items are doing — the server
 * marks every unpicked plan "blocked" for placement, which is not a fact about
 * the plan's own progress.
 */
export function planState(row: WorklistRow): { key: PlanStateKey; label: string; why: string } {
  const c = row.counts;
  const make = (key: PlanStateKey, why: string) => ({ key, label: STATE_LABEL[key], why });
  if (!c) return make('unknown', row.reason ?? 'Task progress has not been measured for this plan.');
  if (total(c) === 0) return make('empty', 'This plan has no items yet.');
  if (c.wip > 0 || (row.selected && row.liveLaneOwner)) {
    return make('moving', c.wip > 0 ? `${plural(c.wip, 'item')} being worked on now` : 'An agent holds this plan now');
  }
  if (c.needsHuman > 0) return make('you', `${plural(c.needsHuman, 'item')} need${c.needsHuman === 1 ? 's' : ''} your decision`);
  if (remaining(c) === 0 || row.state === 'awaiting-closure') {
    return make('signoff', 'All items are done; it needs grading and acceptance to ship');
  }
  if ((c.blocked > 0 && c.todo === 0) || (row.selected && row.state === 'blocked')) {
    return make('stuck', 'Nothing can start: every remaining item waits on another item');
  }
  return make('idle', row.selected
    ? `${plural(c.todo, 'item')} ready to start; no agent is on it`
    : `${plural(c.todo, 'item')} ready; add it to the worklist to have the steward work on it`);
}

export type ProgressRow = WorklistRow & { rank: number; st: ReturnType<typeof planState> };

/** Ranks are worklist priority (0-based) for selected rows, -1 otherwise. */
export function progressRows(rows: readonly WorklistRow[]): ProgressRow[] {
  let next = 0;
  return rows.map((row) => ({ ...row, rank: row.selected ? next++ : -1, st: planState(row) }));
}

export function sumCounts(rows: readonly ProgressRow[]): ProgressCounts {
  const t: ProgressCounts = { todo: 0, wip: 0, blocked: 0, needsHuman: 0, done: 0 };
  for (const r of rows) if (r.counts) for (const k of Object.keys(t) as Array<keyof ProgressCounts>) t[k] += r.counts[k];
  return t;
}

export function inScope(row: ProgressRow, scope: ScopeFilter) {
  return scope === 'all' || (scope === 'in') === row.selected;
}

export function filterAndSort(rows: readonly ProgressRow[], opts: {
  scope: ScopeFilter; state: PlanStateKey | null; showEmpty: boolean; query: string; sort: SortKey;
}): ProgressRow[] {
  const q = opts.query.trim().toLowerCase();
  const left = (r: ProgressRow) => (r.counts ? remaining(r.counts) : -1);
  const pct = (r: ProgressRow) => (r.counts && total(r.counts) ? percent(r.counts) : 101);
  const cmp: Record<SortKey, (a: ProgressRow, b: ProgressRow) => number> = {
    left: (a, b) => Number(b.selected) - Number(a.selected) || left(b) - left(a) || a.label.localeCompare(b.label),
    pct: (a, b) => pct(a) - pct(b) || left(b) - left(a),
    rank: (a, b) => Number(b.selected) - Number(a.selected) || a.rank - b.rank || left(b) - left(a),
    name: (a, b) => a.label.localeCompare(b.label),
  };
  return rows.filter((r) => inScope(r, opts.scope) && (opts.showEmpty || r.st.key !== 'empty') &&
    (!opts.state || r.st.key === opts.state) &&
    (!q || `${r.label} ${r.planSlug ?? ''} ${r.harness ?? ''}`.toLowerCase().includes(q)))
    .sort(cmp[opts.sort]);
}

/** Fill the measured window so a quiet day renders as 0, ending today (UTC). */
export function completionSeries(data: Pick<GoalDetailInput, 'completedByDay'>, nowMs: number) {
  const measured = data.completedByDay;
  if (!measured) return null;
  const byDay = new Map(measured.days.map((d) => [d.day, d.done]));
  return Array.from({ length: measured.windowDays }, (_, i) => {
    const day = new Date(nowMs - (measured.windowDays - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, done: byDay.get(day) ?? 0 };
  });
}

/**
 * Why the table cannot render, in words the owner can act on. Null means the
 * collection loaded. Never returns a blank state.
 */
export function loadProblem(data: GoalDetailInput): { title: string; detail: string } | null {
  const goalData = data.goalData;
  if (!goalData) {
    return { title: 'Goal data did not load', detail: 'The goal was read, but its data section was missing from the reply. Retry; if it stays missing, the server may be restarting.' };
  }
  if (!('collections' in goalData) || goalData.collections == null) {
    return { title: 'The server is older than this app',
      detail: 'This panel needs plan progress that the server you are connected to does not send yet. It will fill in once that server runs a newer build; nothing is wrong with your goal.' };
  }
  const entries = Object.values(goalData.collections);
  const plans = entries.find((c) => c.selection.ok && c.selection.configured &&
    c.selection.collection.source === 'active-workspace-plans');
  if (plans) return null;
  const failed = entries.find((c) => !c.selection.ok);
  if (failed && !failed.selection.ok) {
    return { title: 'Plans could not be loaded', detail: `The server reported: ${failed.selection.reason}. Retry; your saved worklist is unchanged.` };
  }
  if (goalData.error) return { title: 'Goal data could not be read', detail: goalData.error };
  return { title: 'This goal has no plan worklist', detail: 'Its data does not declare an active-plan worklist, so there is nothing to show here.' };
}
