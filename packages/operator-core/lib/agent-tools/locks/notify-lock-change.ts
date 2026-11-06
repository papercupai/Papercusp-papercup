/**
 * Push plan-lock changes to the lock banner (plan
 * semantic-search-fingerprint-coverage-2026-08-03, P-025 / D-042).
 *
 * The banner used to poll `/api/admin/locks/queue` on a 30s
 * `window.setInterval`. This is the push half that replaces it.
 *
 * ┌ WHY THE EXPLICIT `dedupeWindowMs` IS LOAD-BEARING ────────────────────────┐
 * │ Do not remove it, and do not let these emits fall back to the bus default.│
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The invalidation bus defaults to a 90s source-side dedupe floor per
 * `(name, args)` key. Pure invalidations use `offerNotify()` to retain the
 * latest repeat for a bounded trailing publish; the default coalesce bound
 * is 2s. Only byte-identical data-bearing repeats still use the drop path.
 *
 * A plan lock is routinely acquired and released well inside 90s. Both events
 * carry the SAME `(name, args)` key. The historical first-wins bus discarded
 * the release; the current bus retains it for a trailing publish instead.
 * Keep this producer's 1s override as its tighter latency policy, allowing
 * transitions beyond that floor through immediately. `usePlanLock` also
 * refreshes on focus/visibility changes if the transport loses an invalidation.
 *
 * The per-CALL override (`notifyOpts.dedupeWindowMs`)
 * is deliberately used instead of the per-NAME bus policy proposed in
 * WI-37446: the owner DEFERRED that change, and it carries a standing
 * constraint not to lower the global default, which would re-arm the WI-840
 * invalidate storm. A per-call window touches nothing shared.
 *
 * The PG-trigger + `queryNamesForTriggerEvent` bridge has its own bounded
 * trailing-coalesce policy, including per-target overrides. Moving this
 * producer there would need to preserve the plan-path filter and latency
 * policy explicitly; the current explicit notify owns both at this call site.
 *
 * ⚠ SCOPED TO PLAN PATHS ON PURPOSE. The file-lock guard this is called from
 * is the generic guard for EVERY agent file edit fleet-wide. Emitting on all
 * of them at a 1s window would re-create a WI-840-class fan-out storm; D-038's
 * measured 3.6 lock-changes/min is the PLAN-lock rate, not the fleet-wide file
 * -lock rate. Widening this filter is a volume decision, not a cosmetic one.
 */
import { PLANS_DIR_REL } from '../plans/source';
import { trackDetached } from '../../detached-imports';

/**
 * The sync query name the plan lock banner subscribes to. Args are
 * `{ path }` — a single scalar, per D-038: the bus dedupe key is
 * `name|args|dataHash`, so scoping on one scalar path gives every plan its
 * own dedupe bucket instead of one shared bucket for all locks.
 */
export const PLAN_LOCK_QUERY = 'planLock.byPath';

/**
 * Per-call dedupe window for lock invalidations, in ms.
 *
 * Small rather than zero: it still collapses a same-instant cross-process
 * burst (the thing source-side dedupe exists for) while letting a genuine
 * acquire→release pair through. Every lock transition is a discrete,
 * meaningful, already-rate-limited event — exactly the self-debounced-producer
 * case the per-call override was added for.
 */
export const PLAN_LOCK_DEDUPE_MS = 1_000;

/**
 * Is this lock path one the plan lock banner cares about?
 *
 * Matches the workspace-relative key `with-plan-lock.ts` / `planLockPath()`
 * build: `apps/operator/docs/plans/[archive/]<slug>.md`. Backslashes are
 * normalised so a Windows-shaped path cannot silently miss the filter.
 */
export function isPlanLockPath(lockPath: string): boolean {
  const norm = lockPath.replace(/\\/g, '/');
  return norm.startsWith(`${PLANS_DIR_REL}/`) && norm.endsWith('.md');
}

/**
 * Announce that the lock state for `paths` changed (acquired OR released).
 *
 * Fire-and-forget by design, matching every other `notifySyncInvalidate`
 * caller in this tree: a sync-bus fault must never fail — or even delay — the
 * lock operation that triggered it. Non-plan paths are filtered out, and
 * duplicates within one call are collapsed so a multi-path acquire emits once
 * per distinct plan.
 */
export function notifyPlanLockChange(paths: readonly string[]): void {
  const planPaths = [...new Set(paths.filter(isPlanLockPath))];
  if (planPaths.length === 0) return;
  void trackDetached(import('../../sync-sse'))
    .then(({ notifySyncInvalidate }) =>
      Promise.all(
        planPaths.map((path) =>
          // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/notify-lock-change.ts#<module>/notifyPlanLockChange/<callback>/<callback>:18fd69a9a6a9b2400ffb:1","classification":"safe-to-lose","reason":"Only invalidates the planLock.byPath banner query after a plan-file lock changes; lock enforcement remains in the lock store. usePlanLock in apps/operator/app/admin/plans/plans-api.ts invokes the current rows.refresh on window focus and when the document becomes visible, recovering a dropped banner invalidation."}
          notifySyncInvalidate(PLAN_LOCK_QUERY, { path }, undefined, {
            dedupeWindowMs: PLAN_LOCK_DEDUPE_MS,
          }),
        ),
      ),
    )
    .catch(() => {
      /* best-effort: the banner re-fetches on focus/visibility regardless */
    });
}
