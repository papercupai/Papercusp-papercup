/**
 * Activity-clock liveness constants, kept dependency-free on purpose.
 *
 * The shared liveness oracle (presence-wakeability.ts / liveness-oracle.ts) and
 * the SQL-side stale-claim reapers (work-items-stale-claims.ts) must agree on
 * when a heartbeat-fresh owner has stopped taking turns. They import the SAME
 * constants from here, so the reaper cannot keep an owner "alive" that the
 * oracle already reports as warm-dead (WI-6554700010029295). This module has no
 * imports, so a SQL consumer gets the thresholds without loading
 * presence-wakeability's PG/runtime graph (which unit tests routinely mock).
 *
 * presence-wakeability.ts re-exports both names; existing importers are unchanged.
 */

/**
 * How far back the activity clock reads. `agent_activity` is retained for
 * seven days, so the liveness query must cover that same bounded horizon:
 * otherwise a heartbeat-fresh owner whose last turn is older than the
 * wake-miss window becomes indistinguishable from a brand-new owner and
 * incorrectly falls through to `parked`.
 */
export const ACTIVITY_LOOKBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The ACTIVITY-clock dead ceiling (EI-21356812816484561) — the counterpart to
 * `PRESENCE_DEAD_MS`, which only ever watched the HEARTBEAT clock and so could
 * see a process that DIED but never one that is alive with a wedged agent loop.
 *
 * Deliberately 12× the warm-idle band rather than equal to it, because the two
 * mistakes cost different amounts. `PRESENCE_DEAD_MS` can be aggressive (30m)
 * since a cold heartbeat means the process is GONE, so a wrong call costs one
 * spawn. Here the process is ALIVE: a wrong `ended` spawns a DUPLICATE agent
 * beside a working one, and it is self-fulfilling — a parked owner's activity
 * is only old because nobody woke it, and `ended` makes peers stop trying.
 *
 * 6h is past any legitimate park this system produces (loop intervals clamp to
 * 1h; `events:await` timeouts are minutes). It is also the SECOND line of
 * defence, not the first: `wakeAttemptMiss` already catches the precise
 * "we woke it and it did not answer" case at any age, so this timer only has
 * to catch the tail nobody has tried to wake — where declaring `ended` changes
 * nothing about who was waking it, and only stops fresh routing offering it.
 * Measured 2026-08-24: 32 of 180 rows, vs 107 at the warm-idle band.
 */
export const ACTIVITY_DEAD_MS = 6 * 60 * 60 * 1000;
