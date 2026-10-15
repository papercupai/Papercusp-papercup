/**
 * now-note-staleness.ts — derived-status-not-hand-written-2026-10-12 P-003.
 *
 * A plan's Now note is hand-written judgment. Nothing tells a reader how far
 * the plan has moved since the note was written, so a note from forty item
 * transitions ago reads exactly like one written a minute ago. This module
 * derives that distance from the plan-event log instead of estimating it from
 * the note's text:
 *
 *   transitionsSinceNote = item + plan status-change events recorded after the
 *                          latest `now_updated` event for the plan.
 *
 * Sources (reuse, not a parallel log): `plans:set-now` emits `now_updated`
 * (set-now.ts), every stored item transition — including one reflected from a
 * linked work item — emits `item_status_changed` (set-status.ts), and
 * `plans:set-plan-status` emits `status_changed`. The read goes through the
 * existing bounded single-plan reader `readPlanEvents`, never the whole log.
 *
 * Honesty rules (the P-003 falsifier is "estimated from text, counts events
 * from before the note, or misses an item status change recorded after it"):
 * - No `now_updated` in the plan's history ⇒ the note's write time is unknown,
 *   so `transitionsSinceNote` is `null` with basis `note-not-in-event-log` —
 *   never a count of the plan's whole history.
 * - The reader is a newest-N window. When the window is full and holds no
 *   `now_updated`, the note predates the window: every status change in the
 *   window is after it, so the count is reported as a FLOOR
 *   (`truncatedByLimit: true`, basis `note-before-window`), never as a total.
 * - A read that cannot run is `unavailable`, never a zero.
 */

import type { CoordEnvelope } from '@papercusp/coordination/core';

/** Plan-event types that count as a status transition. */
export const NOTE_STALENESS_TRANSITION_EVENTS = ['item_status_changed', 'status_changed'] as const;

/** The newest-N window requested from the single-plan reader (its own ceiling is 1000). */
export const NOTE_STALENESS_READ_LIMIT = 1000;

export type NoteStalenessBasis =
  | 'events-after-note'
  | 'note-before-window'
  | 'note-not-in-event-log'
  | 'unavailable';

export interface NoteStaleness {
  /** Status-change events recorded after the note was written; null when that is unknown. */
  transitionsSinceNote: number | null;
  /** When the note was last written (`now_updated` event time); null when not in the event log. */
  noteWrittenAt: string | null;
  basis: NoteStalenessBasis;
  itemStatusChanges: number;
  planStatusChanges: number;
  /** True when the read window was full: `transitionsSinceNote` is a floor, not a total. */
  truncatedByLimit: boolean;
  /** One line a reader can quote. */
  text: string;
}

type PlanEventLike = Pick<CoordEnvelope, 'ts'> & { event?: unknown };

function stalenessText(s: Omit<NoteStaleness, 'text'>): string {
  if (s.basis === 'unavailable') return 'note age unavailable: the plan-event read failed';
  if (s.transitionsSinceNote === null) return 'note age unknown: the note was not written through plans:set-now';
  const n = s.transitionsSinceNote;
  const count = s.truncatedByLimit ? `at least ${n}` : String(n);
  const noun = n === 1 && !s.truncatedByLimit ? 'status change' : 'status changes';
  return `${count} ${noun} since this note was written`;
}

/**
 * Pure: derive the note's age from a plan's events, sorted ascending as
 * `readPlanEvents` returns them. `windowFull` says the reader hit its bound.
 */
export function summarizeNoteStaleness(
  events: readonly PlanEventLike[],
  opts: { windowFull: boolean; noteWrittenAt?: string | null },
): NoteStaleness {
  // Blind review #14 G-2: the baseline is the DISPLAYED note's own write time. A content edit
  // writes a replacement note with no now_updated event, so the latest now_updated can predate
  // the note a reader sees; counting from that event mislabels the note's age (and a
  // content-written note with no event history read as "unknown"). The event-log search below
  // is only the fallback for a legacy note that carries no write time.
  const baseline = opts.noteWrittenAt ? Date.parse(opts.noteWrittenAt) : Number.NaN;
  if (Number.isFinite(baseline)) {
    let itemStatusChanges = 0;
    let planStatusChanges = 0;
    for (const e of events) {
      if (!(Date.parse(e.ts) > baseline)) continue;
      if (e.event === 'item_status_changed') itemStatusChanges++;
      else if (e.event === 'status_changed') planStatusChanges++;
    }
    // A full newest-N window whose oldest event is already after the note may have dropped
    // earlier post-note changes: the count is then a floor.
    const oldest = events.length > 0 ? Date.parse(events[0]!.ts) : Number.NaN;
    const truncatedByLimit = opts.windowFull && !(oldest <= baseline);
    const base = {
      transitionsSinceNote: itemStatusChanges + planStatusChanges,
      noteWrittenAt: new Date(baseline).toISOString(),
      basis: truncatedByLimit ? ('note-before-window' as const) : ('events-after-note' as const),
      itemStatusChanges,
      planStatusChanges,
      truncatedByLimit,
    };
    return { ...base, text: stalenessText(base) };
  }
  let noteIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.event === 'now_updated') {
      noteIndex = i;
      break;
    }
  }
  const noteKnown = noteIndex >= 0;
  if (!noteKnown && !opts.windowFull) {
    const base = {
      transitionsSinceNote: null,
      noteWrittenAt: null,
      basis: 'note-not-in-event-log' as const,
      itemStatusChanges: 0,
      planStatusChanges: 0,
      truncatedByLimit: false,
    };
    return { ...base, text: stalenessText(base) };
  }
  let itemStatusChanges = 0;
  let planStatusChanges = 0;
  for (let i = noteIndex + 1; i < events.length; i++) {
    const ev = events[i]!.event;
    if (ev === 'item_status_changed') itemStatusChanges++;
    else if (ev === 'status_changed') planStatusChanges++;
  }
  const base = {
    transitionsSinceNote: itemStatusChanges + planStatusChanges,
    noteWrittenAt: noteKnown ? events[noteIndex]!.ts : null,
    basis: noteKnown ? ('events-after-note' as const) : ('note-before-window' as const),
    itemStatusChanges,
    planStatusChanges,
    truncatedByLimit: !noteKnown,
  };
  return { ...base, text: stalenessText(base) };
}

export function unavailableNoteStaleness(): NoteStaleness {
  const base = {
    transitionsSinceNote: null,
    noteWrittenAt: null,
    basis: 'unavailable' as const,
    itemStatusChanges: 0,
    planStatusChanges: 0,
    truncatedByLimit: false,
  };
  return { ...base, text: stalenessText(base) };
}

export type ReadPlanEventsForNote = (opts: {
  planSlugs: string[];
  limit: number;
}) => Promise<readonly PlanEventLike[]>;

async function defaultReadPlanEvents(opts: { planSlugs: string[]; limit: number }) {
  const { readPlanEvents } = await import('../coordination/plan-events');
  return readPlanEvents(opts);
}

/** Read one plan's events and derive its note's age. Never throws. */
export async function readNoteStaleness(
  planSlug: string,
  deps: { read?: ReadPlanEventsForNote } = {},
  noteWrittenAt: string | null = null,
): Promise<NoteStaleness> {
  const read = deps.read ?? defaultReadPlanEvents;
  try {
    const events = await read({ planSlugs: [planSlug], limit: NOTE_STALENESS_READ_LIMIT });
    return summarizeNoteStaleness(events, { windowFull: events.length >= NOTE_STALENESS_READ_LIMIT, noteWrittenAt });
  } catch {
    return unavailableNoteStaleness();
  }
}

/**
 * Attach `now.staleness` to each `plans:get` result that carries a Now note.
 * Replaces `now` with a copy, so a shared (cached) result object is never
 * mutated in place; results without a note are left untouched and cost no read.
 */
export async function attachNoteStaleness(
  results: Array<Record<string, unknown>>,
  deps: { read?: ReadPlanEventsForNote } = {},
): Promise<void> {
  await Promise.all(
    results.map(async (result) => {
      const now = result.now;
      const slug = result.slug;
      if (!now || typeof now !== 'object' || typeof slug !== 'string') return;
      // The displayed note's write time, when plans:get exposed it (`now.note.writtenAt`).
      const writtenAt = (now as { note?: { writtenAt?: unknown } }).note?.writtenAt;
      const staleness = await readNoteStaleness(slug, deps, typeof writtenAt === 'string' ? writtenAt : null);
      result.now = { ...(now as Record<string, unknown>), staleness };
    }),
  );
}
