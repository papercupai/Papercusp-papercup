/**
 * TEMPORARY LIVE DRILL — DELETE AFTER 2026-10-27 ~20:15Z. Owner: su-64f21cce (WI-6554700010010481,
 * green-main-cycle-time-2026-10-08#P-028 acceptance). Imported by nothing; never executed.
 *
 * This file deliberately violates `lint:no-raw-setinterval` so the per-sync `sync-batch-lint-guards`
 * routine can prove its acceptance on the live tree: a seeded guard violation yields a red routed to
 * the authoring agent plus a delivered wake within 15 minutes, before any gate run. The drill owner
 * removes this file as soon as that red and wake are observed.
 */
export function p028LintGuardDrill(): void {
  setInterval(() => undefined, 60_000);
}
