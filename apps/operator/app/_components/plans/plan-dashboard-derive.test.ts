// plan-dashboard-derive (plan-dashboard-mission-control-2026-08-31 P-001):
// the pure derivations behind the direction-A dashboard — status counts,
// item grouping, newest-decisions, and the activity noise collapse.
import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@/app/admin/plans/plans-api';
import {
  collapsePlanActivity,
  derivedStatusViewOf,
  groupPlanItems,
  newestDecisions,
  noteAgeOf,
  statusCountsOf,
  type DashboardDerivedStatus,
  type DashboardNoteStaleness,
  type PlanActivityFeedRow,
} from './plan-dashboard-derive';

function item(id: string, effectiveStatus: PlanItem['effectiveStatus']): PlanItem {
  return { id, storedStatus: effectiveStatus, effectiveStatus, text: `text ${id}` };
}

describe('statusCountsOf', () => {
  it('buckets by effectiveStatus; blocked + needs-human are attention; total counts every item', () => {
    const c = statusCountsOf([
      item('P-001', 'done'), item('P-002', 'done'),
      item('P-003', 'wip'),
      item('P-004', 'todo'), item('P-005', 'todo'),
      item('P-006', 'blocked'), item('P-007', 'needs-human'),
      item('P-008', 'dropped'),
    ])!;
    expect(c).toEqual({ done: 2, wip: 1, todo: 2, attention: 2, dropped: 1, total: 8 });
  });

  it('returns null for empty/undefined (no band renders)', () => {
    expect(statusCountsOf(undefined)).toBeNull();
    expect(statusCountsOf([])).toBeNull();
  });
});

describe('groupPlanItems', () => {
  it('orders attention → wip → todo → doneish, omits empty groups, keeps document order inside a group', () => {
    const groups = groupPlanItems([
      item('P-001', 'done'),
      item('P-002', 'todo'),
      item('P-003', 'wip'),
      item('P-004', 'needs-human'),
      item('P-005', 'todo'),
      item('P-006', 'dropped'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['attention', 'wip', 'todo', 'doneish']);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(['P-002', 'P-005']);
    // done + dropped share the terminal group.
    expect(groups[3]!.items.map((i) => i.id)).toEqual(['P-001', 'P-006']);
    expect(groupPlanItems([item('P-001', 'wip')]).map((g) => g.key)).toEqual(['wip']);
  });
});

describe('newestDecisions', () => {
  it('sorts by numeric D-id descending and caps at n', () => {
    const out = newestDecisions(
      [{ id: 'D-002' }, { id: 'D-015' }, { id: 'D-009' }],
      2,
    );
    expect(out.map((d) => d.id)).toEqual(['D-015', 'D-009']);
  });
});

/* ── collapsePlanActivity ────────────────────────────────────────────────
   Feed rows arrive NEWEST-FIRST (plan-activity-feed.ts mergeActivityRows). */

function editRow(over: Partial<PlanActivityFeedRow> & { text: string }): PlanActivityFeedRow {
  return { kind: 'edit', tsMs: 1000, who: 'su-aaaaa', ...over };
}
function workRow(over?: Partial<PlanActivityFeedRow>): PlanActivityFeedRow {
  return { kind: 'work', tsMs: 5000, text: 'WI-1 wip — thing', ref: 'WI-1', who: 'su-aaaaa', ...over };
}

describe('collapsePlanActivity', () => {
  it('folds ≥2 consecutive generic edits by the same author into one run with rev + time range', () => {
    const out = collapsePlanActivity([
      workRow({ tsMs: 9000 }),
      editRow({ text: 'Plan edited (rev 34)', ref: 'rev:34', tsMs: 8000 }),
      editRow({ text: 'Plan edited (rev 33)', ref: 'rev:33', tsMs: 7000 }),
      editRow({ text: 'Plan edited (rev 32)', ref: 'rev:32', tsMs: 6000 }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['row', 'run']);
    const run = out[1]! as Extract<(typeof out)[number], { type: 'run' }>;
    expect(run.count).toBe(3);
    expect(run.revLo).toBe(32);
    expect(run.revHi).toBe(34);
    expect(run.tsNewestMs).toBe(8000);
    expect(run.tsOldestMs).toBe(6000);
    expect(run.who).toBe('su-aaaaa');
  });

  it('a SINGLETON generic edit stays a plain row (never a ×1 run)', () => {
    const out = collapsePlanActivity([
      editRow({ text: 'Plan edited (rev 12)', ref: 'rev:12' }),
      workRow(),
    ]);
    expect(out.map((e) => e.type)).toEqual(['row', 'row']);
    expect((out[0] as { row: PlanActivityFeedRow }).row.text).toBe('Plan edited (rev 12)');
  });

  it('an author change breaks the run', () => {
    const out = collapsePlanActivity([
      editRow({ text: 'Plan edited (rev 4)', ref: 'rev:4', who: 'su-aaaaa' }),
      editRow({ text: 'Plan edited (rev 3)', ref: 'rev:3', who: 'su-aaaaa' }),
      editRow({ text: 'Plan edited (rev 2)', ref: 'rev:2', who: 'su-bbbbb' }),
      editRow({ text: 'Plan edited (rev 1)', ref: 'rev:1', who: 'su-bbbbb' }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['run', 'run']);
    expect((out[0] as { who?: string }).who).toBe('su-aaaaa');
    expect((out[1] as { who?: string }).who).toBe('su-bbbbb');
  });

  it('a substantive rationale is promoted to a note and interrupts a run', () => {
    const out = collapsePlanActivity([
      editRow({ text: 'Plan edited (rev 6)', ref: 'rev:6', tsMs: 6000 }),
      editRow({ text: 'Plan edited (rev 5)', ref: 'rev:5', tsMs: 5000 }),
      editRow({ text: 'Records the first powered acceptance measurement.', ref: 'rev:4', tsMs: 4000 }),
      editRow({ text: 'Plan edited (rev 3)', ref: 'rev:3', tsMs: 3000 }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['run', 'note', 'row']);
  });

  it('work rows pass through untouched, and a bare "Plan edited" (no rev) is still generic', () => {
    const out = collapsePlanActivity([
      workRow({ tsMs: 9000, ref: 'WI-9' }),
      editRow({ text: 'Plan edited', ref: undefined, tsMs: 8000 }),
      editRow({ text: 'Plan edited', ref: undefined, tsMs: 7000 }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['row', 'run']);
    const run = out[1]! as Extract<(typeof out)[number], { type: 'run' }>;
    expect(run.revLo).toBeNull();
    expect(run.revHi).toBeNull();
  });

  it('handles empty input', () => {
    expect(collapsePlanActivity(undefined)).toEqual([]);
    expect(collapsePlanActivity([])).toEqual([]);
  });
});

// derived-status-not-hand-written-2026-10-12 P-005: the status card and the
// note's age, derived from plans:get `derivedStatus` and `now.staleness`.
function staleness(over: Partial<DashboardNoteStaleness> = {}): DashboardNoteStaleness {
  return {
    transitionsSinceNote: 0,
    noteWrittenAt: '2026-10-12T20:00:00.000Z',
    basis: 'events-after-note',
    itemStatusChanges: 0,
    planStatusChanges: 0,
    truncatedByLimit: false,
    text: '0 status changes since this note was written',
    ...over,
  };
}

function summaryItem(id: string, effectiveStatus: 'todo' | 'wip' | 'blocked' | 'needs-human', heldBy: string[] = []) {
  return { id, effectiveStatus, importance: 'normal' as const, phase: null, heldBy };
}

function derivedStatus(over: Partial<DashboardDerivedStatus> = {}): DashboardDerivedStatus {
  return {
    counts: { todo: 1, wip: 1, blocked: 1, 'needs-human': 1, done: 2, dropped: 0, total: 6, terminal: 2, nonTerminal: 4 } as DashboardDerivedStatus['counts'],
    actionable: [summaryItem('P-004', 'todo', ['su-aaaaaaaa-0000'])],
    inFlight: [summaryItem('P-003', 'wip', ['su-bbbbbbbb-0000'])],
    blocked: [{ ...summaryItem('P-005', 'blocked'), blockedOn: ['P-003'], external: false }],
    awaitingHuman: [summaryItem('P-006', 'needs-human')],
    truncated: { actionable: false, inFlight: false, blocked: false, awaitingHuman: false },
    next: { itemId: 'P-004', reason: 'actionable', text: 'next: P-004' } as DashboardDerivedStatus['next'],
    latestDecision: null,
    lifecycle: null,
    holdersMeasured: true,
    text: '2 of 6 done; 1 in flight, 1 actionable, 1 blocked, 1 awaiting a human',
    ...over,
  };
}

describe('noteAgeOf (P-005)', () => {
  it('is null when the read carried no staleness', () => {
    expect(noteAgeOf(undefined)).toBeNull();
    expect(noteAgeOf(null)).toBeNull();
  });

  it('marks the note moved past when transitionsSinceNote is above zero', () => {
    const age = noteAgeOf(staleness({ transitionsSinceNote: 2, itemStatusChanges: 2, text: '2 status changes since this note was written' }));
    expect(age).toEqual({
      state: 'moved-past',
      text: '2 status changes since this note was written',
      writtenAt: '2026-10-12T20:00:00.000Z',
      transitionsSinceNote: 2,
    });
  });

  it('keeps a note current when no status changed after it', () => {
    expect(noteAgeOf(staleness())?.state).toBe('current');
  });

  it('reports an unknown count as unknown, never as current', () => {
    const age = noteAgeOf(
      staleness({ transitionsSinceNote: null, noteWrittenAt: null, basis: 'note-not-in-event-log', text: 'note age unknown: the note was not written through plans:set-now' }),
    );
    expect(age?.state).toBe('unknown');
    expect(age?.writtenAt).toBeNull();
  });

  it('treats a floor count (read window full) above zero as moved past', () => {
    expect(noteAgeOf(staleness({ transitionsSinceNote: 200, truncatedByLimit: true }))?.state).toBe('moved-past');
  });
});

describe('derivedStatusViewOf (P-005)', () => {
  it('is null when the read carried no derivedStatus', () => {
    expect(derivedStatusViewOf(undefined)).toBeNull();
    expect(derivedStatusViewOf(null)).toBeNull();
  });

  it('orders rows in-flight, actionable, blocked, awaiting-human and carries holders and blockers', () => {
    const view = derivedStatusViewOf(derivedStatus());
    expect(view?.text).toBe('2 of 6 done; 1 in flight, 1 actionable, 1 blocked, 1 awaiting a human');
    expect(view?.rows.map((r) => [r.kind, r.id])).toEqual([
      ['in-flight', 'P-003'],
      ['actionable', 'P-004'],
      ['blocked', 'P-005'],
      ['awaiting-human', 'P-006'],
    ]);
    expect(view?.rows[1]?.holders).toEqual(['su-aaaaaaaa-0000']);
    expect(view?.rows[2]).toMatchObject({ blockedOn: ['P-003'], external: false });
    expect(view?.hiddenRows).toBe(0);
    expect(view?.shipGate).toBeNull();
  });

  it('collapses rows past the cap and flags a server-truncated list', () => {
    const many = Array.from({ length: 5 }, (_, i) => summaryItem(`P-1${i}`, 'todo'));
    const view = derivedStatusViewOf(
      derivedStatus({ actionable: many, truncated: { actionable: true, inFlight: false, blocked: false, awaitingHuman: false } }),
      3,
    );
    expect(view?.rows).toHaveLength(3);
    expect(view?.hiddenRows).toBe(5);
    expect(view?.listTruncated).toBe(true);
  });

  it('projects the ship-gate step with its repair verb, and a skipped gate as skipped', () => {
    const gate = {
      source: 'plan-acceptance-gate' as const,
      satisfied: false,
      code: 'acceptance_ungraded',
      skipped: null,
      message: 'no independent grade',
      nextRepair: { kind: 'grade', verb: 'scorecards:emit', nextVerb: null, instruction: 'grade it' },
      guardsNotChecked: [],
      confirmWith: { name: 'plans:set-plan-status' as const, args: {} },
      reusedShipReadiness: false,
      unavailableReason: null,
      text: 'ship refused: acceptance_ungraded',
    };
    const refused = derivedStatusViewOf(derivedStatus({ shipGate: gate }));
    expect(refused?.shipGate).toEqual({
      satisfied: false,
      skipped: false,
      text: 'ship refused: acceptance_ungraded',
      repairVerb: 'scorecards:emit',
    });
    const skipped = derivedStatusViewOf(derivedStatus({ shipGate: { ...gate, skipped: 'plan-shipped', nextRepair: null } }));
    expect(skipped?.shipGate).toMatchObject({ skipped: true, repairVerb: null });
  });
});
