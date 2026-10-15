/**
 * plan-dashboard-derive — pure derivations behind PlanDashboard's direction-A
 * ("mission control") layout (plan-dashboard-mission-control-2026-08-31 P-001).
 *
 * Everything here is presentation-shaping over data the surface ALREADY
 * fetches (plans.get full mode / planActivity.list) — no fetching, no React.
 * Kept out of PlanDashboard.tsx so the collapse/grouping rules are unit-testable
 * without the component's heavy import graph (launchAgent, css, modals).
 */
import type { PlanDecision, PlanGetResult, PlanItem } from '@/app/admin/plans/plans-api';

/** One planActivity.list wire row (P-004 — PlanActivityRow). Declared here so
 *  both the component and these derivations share one shape. */
export interface PlanActivityFeedRow {
  kind?: 'edit' | 'work';
  tsMs?: number;
  text?: string;
  who?: string;
  ref?: string;
}

/* ── Item status counts (the segmented progress band) ──────────────────── */

export interface ItemStatusCounts {
  done: number;
  wip: number;
  todo: number;
  /** blocked + needs-human — the "someone must look" bucket. */
  attention: number;
  dropped: number;
  total: number;
}

/** Counts by `effectiveStatus`, same field progressOfItems reads (P-003 of the
 *  2026-08-30 windowing fix): every item counts toward total, done means
 *  `effectiveStatus === 'done'` — the band cannot disagree with the header. */
export function statusCountsOf(
  items: Array<Pick<PlanItem, 'effectiveStatus'>> | undefined,
): ItemStatusCounts | null {
  if (!items || items.length === 0) return null;
  const c: ItemStatusCounts = { done: 0, wip: 0, todo: 0, attention: 0, dropped: 0, total: items.length };
  for (const it of items) {
    switch (it.effectiveStatus) {
      case 'done': c.done += 1; break;
      case 'wip': c.wip += 1; break;
      case 'blocked':
      case 'needs-human': c.attention += 1; break;
      case 'dropped': c.dropped += 1; break;
      default: c.todo += 1; break;
    }
  }
  return c;
}

/* ── Item grouping (the left substance column) ─────────────────────────── */

export type PlanItemGroupKey = 'attention' | 'wip' | 'todo' | 'doneish';

export interface PlanItemGroup {
  key: PlanItemGroupKey;
  label: string;
  items: PlanItem[];
}

/** Direction-A grouping, most-actionable first: needs-attention (blocked /
 *  needs-human), in progress, up next, then done+dropped. Empty groups are
 *  omitted; within a group the plan's own document order is preserved. */
export function groupPlanItems(items: PlanItem[] | undefined): PlanItemGroup[] {
  const buckets: Record<PlanItemGroupKey, PlanItem[]> = {
    attention: [], wip: [], todo: [], doneish: [],
  };
  for (const it of items ?? []) {
    switch (it.effectiveStatus) {
      case 'blocked':
      case 'needs-human': buckets.attention.push(it); break;
      case 'wip': buckets.wip.push(it); break;
      case 'done':
      case 'dropped': buckets.doneish.push(it); break;
      default: buckets.todo.push(it); break;
    }
  }
  const labels: Record<PlanItemGroupKey, string> = {
    attention: 'Needs attention',
    wip: 'In progress',
    todo: 'Up next',
    doneish: 'Done',
  };
  const out: PlanItemGroup[] = [];
  for (const key of ['attention', 'wip', 'todo', 'doneish'] as const) {
    if (buckets[key].length > 0) out.push({ key, label: labels[key], items: buckets[key] });
  }
  return out;
}

/* ── Decisions (the rail card) ─────────────────────────────────────────── */

/** Newest-N decisions by numeric D-id (document order is oldest-first; the
 *  rail wants the latest rulings). Non-numeric ids sort last, stably. */
export function newestDecisions(
  decisions: PlanDecision[] | undefined,
  n: number,
): PlanDecision[] {
  const numOf = (id: string): number => {
    const m = /^D-(\d+)$/.exec(id);
    return m ? Number(m[1]) : -1;
  };
  return [...(decisions ?? [])]
    .sort((a, b) => numOf(b.id) - numOf(a.id))
    .slice(0, Math.max(0, n));
}

/* ── Activity collapse (the rail feed) ─────────────────────────────────── */

/**
 * The rendered shape of one feed slot after noise collapse:
 *  - `row`  — a work row, or a SINGLETON generic edit (kept verbatim);
 *  - `note` — an edit row whose text is a substantive rationale (a checkpoint
 *    note / handoff note), promoted to a card;
 *  - `run`  — ≥2 CONSECUTIVE generic "Plan edited (rev N)" rows by the SAME
 *    author, folded into one line with the rev + time range.
 */
export type PlanActivityEntry =
  | { type: 'row'; row: PlanActivityFeedRow }
  | { type: 'note'; row: PlanActivityFeedRow }
  | {
      type: 'run';
      count: number;
      who?: string;
      /** rev range, when the refs parsed (`rev:<seq>`); null otherwise. */
      revLo: number | null;
      revHi: number | null;
      /** Feed is newest-first: newest = the run's first row, oldest = its last. */
      tsNewestMs: number | null;
      tsOldestMs: number | null;
    };

/** The resolver's own generic-edit line (plan-activity-feed.ts mapEditRows:
 *  `rationale || "Plan edited (rev N)"`) — a rationale is free text, so ONLY
 *  the exact generated shape counts as noise. */
const GENERIC_EDIT_RE = /^Plan edited(?: \(rev \d+\))?$/;

function revOf(ref: string | undefined): number | null {
  const m = /^rev:(\d+)$/.exec(ref ?? '');
  return m ? Number(m[1]) : null;
}

interface Run {
  who: string;
  rows: PlanActivityFeedRow[];
}

export function collapsePlanActivity(
  rows: readonly PlanActivityFeedRow[] | undefined,
): PlanActivityEntry[] {
  const out: PlanActivityEntry[] = [];
  let run: Run | null = null;

  const flush = () => {
    if (!run) return;
    if (run.rows.length === 1) {
      out.push({ type: 'row', row: run.rows[0]! });
    } else {
      const revs = run.rows.map((r) => revOf(r.ref)).filter((v): v is number => v !== null);
      const times = run.rows
        .map((r) => (typeof r.tsMs === 'number' ? r.tsMs : null))
        .filter((v): v is number => v !== null);
      out.push({
        type: 'run',
        count: run.rows.length,
        ...(run.who ? { who: run.who } : {}),
        revLo: revs.length ? Math.min(...revs) : null,
        revHi: revs.length ? Math.max(...revs) : null,
        tsNewestMs: times.length ? Math.max(...times) : null,
        tsOldestMs: times.length ? Math.min(...times) : null,
      });
    }
    run = null;
  };

  for (const row of rows ?? []) {
    const generic = row?.kind === 'edit' && GENERIC_EDIT_RE.test(row.text ?? '');
    if (generic) {
      const who = row.who ?? '';
      if (run && run.who === who) {
        run.rows.push(row);
      } else {
        flush();
        run = { who, rows: [row] };
      }
      continue;
    }
    flush();
    if (row?.kind === 'edit') out.push({ type: 'note', row });
    else out.push({ type: 'row', row });
  }
  flush();
  return out;
}

// ── derived-status-not-hand-written-2026-10-12 P-005 ────────────────────────
// The dashboard renders the plan's status DERIVED from its item graph
// (`plans:get` → `derivedStatus`, P-001/P-002) and the Now note with its age
// (`now.staleness`, P-003), instead of only the hand-written prose.

/** `PlanGetResult['derivedStatus']`, non-null. */
export type DashboardDerivedStatus = NonNullable<PlanGetResult['derivedStatus']>;
/** `now.staleness`, non-null. */
export type DashboardNoteStaleness = NonNullable<NonNullable<PlanGetResult['now']>['staleness']>;

/**
 * `current`: no status change since the note was written. `moved-past`: at least
 * one item or plan status change landed after it. `unknown`: the count is not
 * known (the note was not written through plans:set-now, or the read failed) —
 * never rendered as current.
 */
export type NoteAgeState = 'current' | 'moved-past' | 'unknown';

export interface NoteAgeView {
  state: NoteAgeState;
  /** The server's one-line age text, verbatim. */
  text: string | null;
  writtenAt: string | null;
  transitionsSinceNote: number | null;
}

/** The Now note's age. Null when the read carried no staleness (no note, or a read that skips the step). */
export function noteAgeOf(staleness: DashboardNoteStaleness | null | undefined): NoteAgeView | null {
  if (!staleness) return null;
  const n = staleness.transitionsSinceNote;
  const state: NoteAgeState = n === null ? 'unknown' : n > 0 ? 'moved-past' : 'current';
  return {
    state,
    text: staleness.text?.trim() || null,
    writtenAt: staleness.noteWrittenAt,
    transitionsSinceNote: n,
  };
}

export type DerivedStatusRowKind = 'in-flight' | 'actionable' | 'blocked' | 'awaiting-human';

export interface DerivedStatusRow {
  kind: DerivedStatusRowKind;
  id: string;
  /** Holders of the item's claimed linked work items (owner ids). */
  holders: string[];
  /** In-plan blockers; only set on `blocked` rows. */
  blockedOn: string[];
  /** A `blocked` row with no in-plan cause (stored `blocked`, blocker outside the plan). */
  external: boolean;
}

export interface DerivedShipGateView {
  satisfied: boolean;
  /** Set ⇒ the gate did not apply (nothing was checked) — never a pass. */
  skipped: boolean;
  text: string;
  /** The verb that repairs the refusal, when the gate names one. */
  repairVerb: string | null;
}

export interface DerivedStatusView {
  text: string;
  rows: DerivedStatusRow[];
  /** Rows past `DERIVED_STATUS_ROW_CAP`, plus any the server's own list cap cut. */
  hiddenRows: number;
  /** True when the server cut a list: `hiddenRows` is then a floor. */
  listTruncated: boolean;
  holdersMeasured: boolean;
  shipGate: DerivedShipGateView | null;
}

/** Rows the status card shows before collapsing the rest into "+N more". */
export const DERIVED_STATUS_ROW_CAP = 8;

/**
 * The status card's rows, in reading order: who is working (in flight), what can
 * be picked up (actionable, with any holder of a linked work item), what is stuck
 * (blocked, with its blockers), and what waits on a human.
 */
export function derivedStatusViewOf(
  status: DashboardDerivedStatus | null | undefined,
  cap = DERIVED_STATUS_ROW_CAP,
): DerivedStatusView | null {
  if (!status) return null;
  const all: DerivedStatusRow[] = [
    ...(status.inFlight ?? []).map((i) => ({ kind: 'in-flight' as const, id: i.id, holders: [...i.heldBy], blockedOn: [], external: false })),
    ...(status.actionable ?? []).map((i) => ({ kind: 'actionable' as const, id: i.id, holders: [...i.heldBy], blockedOn: [], external: false })),
    ...(status.blocked ?? []).map((i) => ({
      kind: 'blocked' as const,
      id: i.id,
      holders: [...i.heldBy],
      blockedOn: [...i.blockedOn],
      external: i.external,
    })),
    ...(status.awaitingHuman ?? []).map((i) => ({ kind: 'awaiting-human' as const, id: i.id, holders: [...i.heldBy], blockedOn: [], external: false })),
  ];
  const limit = Math.max(0, cap);
  const t = status.truncated;
  const listTruncated = Boolean(t && (t.actionable || t.inFlight || t.blocked || t.awaitingHuman));
  const gate = status.shipGate;
  return {
    text: status.text,
    rows: all.slice(0, limit),
    hiddenRows: Math.max(0, all.length - limit),
    listTruncated,
    holdersMeasured: status.holdersMeasured,
    shipGate: gate
      ? {
          satisfied: gate.satisfied,
          skipped: gate.skipped !== null,
          text: gate.text,
          repairVerb: gate.nextRepair?.verb ?? null,
        }
      : null,
  };
}
