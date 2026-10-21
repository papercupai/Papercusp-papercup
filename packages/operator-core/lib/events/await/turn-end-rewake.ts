/**
 * turn-end-rewake — the per-agent timer half of the turn-end gate (WI-6554700010018567; report
 * rpt_24408ef5-04d2-45ca-b56a-27ee3cca8c98 item #2).
 *
 * The gate (turn-end-held-work-guard.ts) refuses a silent-halt stop ONCE. Both adapters drop the
 * next stop (`stop_hook_active`), so an agent that stops anyway still halts until the silent-halt
 * sweep reaches it, and that sweep wakes at most 5 sessions per pass. A voluntary stop is visible
 * right here, so the server sets a timer for that one agent at that moment: a one-shot bounded
 * await on a key nothing emits. The existing timed-await machinery (fireTimedOutAwaits → delivery
 * → wake executor) turns its deadline into a wake. No new scheduler.
 *
 * One timer per agent: each refused stop replaces the pending one (supersedePending), so the
 * deadline always counts from the latest stop. The gate cancels it when a later stop is safe.
 * Deadlines are jittered so a mass stop (a provider usage limit) does not wake everyone at once.
 *
 * Budget: after TURN_END_REWAKE_NO_PROGRESS_BUDGET timed rewakes with no progress on the held
 * items (work_items.last_progress_at), the timer is no longer armed. The silent-halt census still
 * counts the session. Nothing here pages anyone [owner 2026-10-15: "I don't want to be paged"].
 */

import type { Sql } from 'postgres';
import type { HeldWorkItem } from './wake-source-predicate';

/** Event-key prefix of the rewake timer. Nothing emits it: only its deadline fires. */
export const TURN_END_REWAKE_KEY_PREFIX = 'turn-end:rewake:';
/** Nominal delay before a stopped agent is woken. */
export const TURN_END_REWAKE_BASE_SEC = 900;
/** Deadlines spread uniformly over ±20% of the base delay. */
export const TURN_END_REWAKE_JITTER = 0.2;
/** Timed rewakes in a row without progress before the timer stops being armed. */
export const TURN_END_REWAKE_NO_PROGRESS_BUDGET = 2;
/** How many held ids the wake note names. */
const NOTE_LISTED_CAP = 5;

export function turnEndRewakeKey(ownerId: string): string {
  return TURN_END_REWAKE_KEY_PREFIX + ownerId;
}

export function isTurnEndRewakeKey(eventKey: string): boolean {
  return eventKey.startsWith(TURN_END_REWAKE_KEY_PREFIX);
}

/** A jittered deadline in seconds. `random` returns [0, 1). */
export function turnEndRewakeTimeoutSec(random: () => number = Math.random): number {
  const spread = TURN_END_REWAKE_BASE_SEC * TURN_END_REWAKE_JITTER;
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(TURN_END_REWAKE_BASE_SEC - spread + r * 2 * spread);
}

export type TurnEndRewakeOutcome =
  | { kind: 'armed'; attempt: number; timeoutSec: number }
  | { kind: 'exhausted'; firedWithoutProgress: number };

/** The decision for a refused stop, given how many timed rewakes already fired without progress. Pure. */
export function decideTurnEndRewake(
  firedWithoutProgress: number,
  random: () => number = Math.random,
): TurnEndRewakeOutcome {
  if (firedWithoutProgress >= TURN_END_REWAKE_NO_PROGRESS_BUDGET) {
    return { kind: 'exhausted', firedWithoutProgress };
  }
  return { kind: 'armed', attempt: firedWithoutProgress + 1, timeoutSec: turnEndRewakeTimeoutSec(random) };
}

/** The text the wake delivers when the timer fires. Pure. */
export function turnEndRewakeNote(attempt: number, held: readonly HeldWorkItem[]): string {
  const ids = held.map((h) => h.id);
  const listed =
    ids.slice(0, NOTE_LISTED_CAP).join(', ') +
    (ids.length > NOTE_LISTED_CAP ? `, +${ids.length - NOTE_LISTED_CAP} more` : '');
  return (
    `turn-end rewake ${attempt} of ${TURN_END_REWAKE_NO_PROGRESS_BUDGET}: you ended a turn in an autonomy mode ` +
    `holding ${listed} with nothing set to wake you. Take the next step on one of them, arm a wake, ` +
    'or release / complete the items you cannot advance.'
  );
}

/** The line the turn-end refusal appends for this outcome. Pure. */
export function turnEndRewakeRefusalLine(outcome: TurnEndRewakeOutcome): string {
  if (outcome.kind === 'armed') {
    const minutes = Math.round(outcome.timeoutSec / 60);
    return (
      `⏱ Rewake timer set: if you stop anyway, you will be woken in about ${minutes} min ` +
      `(timed rewake ${outcome.attempt} of ${TURN_END_REWAKE_NO_PROGRESS_BUDGET}; it never pages anyone).`
    );
  }
  return (
    `⏱ No rewake timer: ${outcome.firedWithoutProgress} timed rewakes in a row produced no progress on these ` +
    'items. Release or complete what you cannot advance rather than stopping on it.'
  );
}

/** IO seams, injectable for tests. */
export interface TurnEndRewakeDeps {
  /** Timed rewakes of this owner that fired after the latest progress on the held items. */
  countFiredWithoutProgress: (ownerId: string, heldIds: readonly string[]) => Promise<number>;
  arm: (input: { ownerId: string; eventKey: string; timeoutSec: number; note: string }) => Promise<void>;
  cancel: (ownerId: string, eventKey: string) => Promise<void>;
  random: () => number;
}

async function orgSql(): Promise<Sql> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql as unknown as Sql;
}

/**
 * Fires of this owner's rewake key after the progress mark: the newest last_progress_at (or claim
 * time) across the held items. No progress mark at all counts every fire.
 */
export async function countTurnEndRewakesWithoutProgress(
  ownerId: string,
  heldIds: readonly string[],
  sql?: Sql,
): Promise<number> {
  const db = sql ?? (await orgSql());
  const rows = await db<Array<{ n: number }>>`
    WITH progress AS (
      SELECT max(GREATEST(last_progress_at, taken_at)) AS mark
        FROM harness_shared.work_items
       WHERE taken_by = ${ownerId}
         AND feature_id = ANY(${heldIds as string[]})
    )
    SELECT count(*)::int AS n
      FROM harness_shared.event_awaits a, progress p
     WHERE a.subscriber_id = ${ownerId}
       AND a.event_key = ${turnEndRewakeKey(ownerId)}
       AND a.fired_at IS NOT NULL
       AND (p.mark IS NULL OR a.fired_at > p.mark)
  `;
  return rows[0]?.n ?? 0;
}

const defaultDeps: TurnEndRewakeDeps = {
  countFiredWithoutProgress: (ownerId, heldIds) => countTurnEndRewakesWithoutProgress(ownerId, heldIds),
  arm: async ({ ownerId, eventKey, timeoutSec, note }) => {
    const { registerAwait } = await import('./store');
    await registerAwait({
      subscriberId: ownerId,
      eventKey,
      policy: 'wake',
      note,
      timeoutBehavior: 'wake',
      timeoutSec,
      once: true,
      supersedePending: {},
    });
  },
  cancel: async (ownerId, eventKey) => {
    const { cancelAwaitsForSubscribersOnKeys } = await import('./store');
    await cancelAwaitsForSubscribersOnKeys([ownerId], [eventKey], { onceOnly: true });
  },
  random: Math.random,
};

/** Arm (or decline to arm) the rewake timer for a refused stop. */
export async function armTurnEndRewake(input: {
  ownerId: string;
  held: readonly HeldWorkItem[];
  deps?: Partial<TurnEndRewakeDeps>;
}): Promise<TurnEndRewakeOutcome> {
  const deps: TurnEndRewakeDeps = { ...defaultDeps, ...input.deps };
  const fired = await deps.countFiredWithoutProgress(
    input.ownerId,
    input.held.map((h) => h.id),
  );
  const outcome = decideTurnEndRewake(fired, deps.random);
  if (outcome.kind === 'armed') {
    await deps.arm({
      ownerId: input.ownerId,
      eventKey: turnEndRewakeKey(input.ownerId),
      timeoutSec: outcome.timeoutSec,
      note: turnEndRewakeNote(outcome.attempt, input.held),
    });
  }
  return outcome;
}

/** Drop a pending rewake timer: the latest stop was safe, so it has nothing left to catch. */
export async function cancelTurnEndRewake(input: {
  ownerId: string;
  deps?: Partial<TurnEndRewakeDeps>;
}): Promise<void> {
  const deps: TurnEndRewakeDeps = { ...defaultDeps, ...input.deps };
  await deps.cancel(input.ownerId, turnEndRewakeKey(input.ownerId));
}
