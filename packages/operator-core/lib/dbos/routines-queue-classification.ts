/**
 * routines-queue-classification.ts — which DBOS WorkflowQueue a scheduled-routine fire belongs on.
 *
 * Pure (no DBOS / side-effect imports) so it's unit-testable without booting the routine engine.
 *
 * WHY (2026-06-23 routines-queue-starvation incident): the single `routines` queue (concurrency 4) was
 * shared by SHORT critical routines (git-sync) AND LONG ones (green-checkpoint ~25m, gym ~90m, agent-role /
 * loop fires, …). A burst of ≥4 long routines holding every slot STARVED git-sync → no commits → all fleet
 * work + deploys frozen for 7h (and the bghost-watchdog mistook the starved queue for a frozen ticker and
 * restart-looped bg-host, killing green-checkpoint mid-run). The fix is two-pronged: the watchdog now
 * corroborates with the routinesTick SCHEDULER (so a busy queue is no longer read as a freeze), and — here —
 * git-sync and the bounded deterministic admission fail-open action use the protected `routines-critical`
 * lane so shared-queue saturation cannot starve commit persistence or the admission floor.
 *
 * EI-21386288922867645 proves queueing a loop behind that shared backlog is NOT benign: a due loop fire sat
 * FIFO behind 29 earlier jobs for ~11 minutes, so the owner received no turn by its five-minute deadline.
 * Loop fires are quick but latency-sensitive, so they get their own bounded `routines-loop` lane. WI-41662
 * found the SAME shape a third time — the external-source polls (gmail/calendar/pr/vault) starved 4–18min
 * every hour behind green-checkpoint — so they get `routines-triggers` on the same principle. The critical
 * lane contains only git-sync and the bounded fail-open action; long/unknown system actions and agent roles
 * still default to `routines`, except for explicitly-known heavy/background work such as gitnexus reindexing, which gets
 * a bounded serial lane of its own. This extends the existing queue mechanism without weakening its
 * persistence invariant.
 */
import { SYSTEM_TARGET_PREFIX } from '../harness/routines/system-actions';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

export const ROUTINES_QUEUE = 'routines';
export const ROUTINES_CRITICAL_QUEUE = 'routines-critical';
export const ROUTINES_FLEET_CONTROL_QUEUE = 'routines-fleet-control';
export const ROUTINES_LOOP_QUEUE = 'routines-loop';
export const ROUTINES_TRIGGERS_QUEUE = 'routines-triggers';
export const ROUTINES_RELEASE_QUEUE = 'routines-release';
export const ROUTINES_DEPLOY_QUEUE = 'routines-deploy';
export const ROUTINES_HEAVY_QUEUE = 'routines-heavy';
export const ROUTINES_SYNC_GUARDS_QUEUE = 'routines-sync-guards';

/** Mirrors loop.ts's materialized target_role without importing that stateful module here. */
export const LOOP_WAKE_TARGET_ROLE = `${SYSTEM_TARGET_PREFIX}loop-wake`;

/**
 * System actions whose STARVATION freezes fleet-wide persistence/coordination → the protected lane.
 * `git-sync` is the proven case (its starvation behind 4 long routines froze every commit + deploys for 7h).
 * `work-item-admission-fail-open` also belongs here: its capped deterministic update is the only non-model
 * path that clears over-age pending work and now has a per-tick cap plus database-side timeouts.
 * Add to this set ONLY a genuinely must-never-starve, QUICK action — never a long-running one (that would
 * re-create the starvation this lane exists to prevent).
 */
export const CRITICAL_ROUTINE_ACTIONS = new Set<string>(['git-sync', 'work-item-admission-fail-open']);

/**
 * Fleet control-plane actions whose latency determines whether leaders can
 * recover dead/stale lanes or learn about fleet state transitions. They share
 * a separate admission class so ordinary routine backlog cannot starve them.
 *
 * The headcount governor can open and attest agent processes, so it must stay
 * off the responsive loop/trigger lanes. The two transition sweeps are bounded
 * observers with one-minute detection latency; keeping them on the fleet lane
 * separates them from both the general queue and unrelated external traffic.
 */
export const FLEET_CONTROL_ACTIONS = new Set<string>([
  'fleet-headcount-governor',
  'fleet-transition-sweep',
  'presence-transition-sweep',
]);

/**
 * External-SOURCE poll actions → their own bounded lane. These are QUICK, run on a
 * sub-hour cadence, and their latency IS the product behaviour: an inbound email, PR,
 * or calendar event is not ingested until the poll actually executes.
 *
 * WI-41662 (2026-08-25) measured the starvation directly: on the shared `routines`
 * queue these sat FIFO behind green-checkpoint's hourly ~25m fire — 13 stalls in a
 * single day, 4m9s to 18m30s each, with gap ONSET clock-locked to :14–:16 past the
 * hour (green-checkpoint's cron is `0 15 * * * *`). Both Google polls froze and
 * resumed together, in the same process, while git-sync — the one routine with a
 * dedicated lane — ran straight through every gap. Nothing FAILED and nothing
 * restarted; the fires were merely waiting for a slot.
 *
 * Same starvation shape as the 2026-06-23 git-sync commit-freeze and
 * EI-21386288922867645's 11-minute loop-fire delay, so it gets the same proven
 * remedy rather than a new mechanism. Add ONLY quick, short-period external polls
 * here — a long-running action would re-create inside this lane the very starvation
 * the lane exists to prevent.
 */
export const TRIGGER_POLL_ACTIONS = new Set<string>([
  'pr-poll',
  'connector-sync',
]);

/**
 * Other bounded trigger/import handlers use the same latency-isolated lane as
 * source polls: trigger dispatch processes a bounded outbox batch, and personal
 * vault import advances one bounded, checkpointed batch per fire.
 *
 * Scheduled blueprint operations only submit an occurrence and return its handle;
 * their workers execute separately. WI-6554700010020357 measured a due daily
 * operation withheld behind a long interactive-usage fire on the ordinary lane,
 * including healthy pool epochs with window=1/inFlight=1. Its bounded submission
 * belongs with trigger dispatch so background work cannot consume its admission.
 */
export const TRIGGERS_QUEUE_ACTIONS = new Set<string>([
  ...TRIGGER_POLL_ACTIONS,
  'external-trigger-dispatch',
  'personal-vault-import',
  'blueprint-operation',
]);

/**
 * Long-running CPU/memory-heavy background actions → a bounded serial lane.
 *
 * `gitnexus-reindex` shells out to `gitnexus analyze` and has measured multi-hour
 * fire budgets. Dream cycles are LLM-bound and carry a bounded ten-minute cycle
 * deadline, so they have the same starvation risk when a large overdue shared-queue
 * cohort consumes the admission window. Leaving either on the shared queue lets one
 * long fire consume the same admission window as short housekeeping routines, which
 * is the starvation shape this classification layer exists to prevent. Keep this
 * exact allow-list narrow: a new action belongs here only after its runtime and
 * resource profile are known.
 *
 * `work-item-admission-bulk-dedup` is LLM-bound rather than CPU-bound, but its wall
 * clock is the same shape: a census fire measured 17m and a bulk stage over a
 * 65,091-member corpus ran 2h+ (2026-10-01). On the shared queue one stage held a
 * slot for 1h53m while pool pressure shrank the window to 3, and 117 cron routines
 * went overdue (plan work-queue-bulk-cleanup-remediation-2026-10-01 D-005). The
 * lane is serial, so a stage and a reindex can delay each other; both are
 * background work, which is the accepted trade-off.
 * The periodic full-suite run includes bisection and permits six hours of work;
 * it must not hold the ordinary admission/housekeeping lane for that duration.
 */
export const HEAVY_ROUTINE_ACTIONS = new Set<string>([
  'gitnexus-reindex',
  'work-item-admission-bulk-dedup',
  'dream-cycle',
  'periodic-full-run',
]);

/**
 * The DEPLOY LAUNCHER → its own bounded serial lane.
 *
 * `release-trigger` is the only thing that promotes a green `main` to the live operator:
 * each fire evaluates the deploy plan and LAUNCHES detached systemd units (the auto-deploy
 * and the exact-pin live certification). It never awaits them — launchLiveReleaseCertification
 * resolves on `systemd-run`'s own exit — so it is QUICK, and its cadence (`0 *\/15 * * * *`)
 * means a starved fire is a deploy that simply never happens.
 *
 * EI-23909857328600541 (measured 2026-09-22T01:50Z) is the starvation, and it is the same
 * shape as the four classes above rather than a new one. release-trigger fell through
 * queueForRoutine to the shared `routines` lane (concurrency 4). Two fires on that lane —
 * `orphaned-mcp-reaper` and `gate-watcher-tick` — had been PENDING for 49 and 37 minutes,
 * and because ROUTINE_FIRE_TIMEOUT_MS is 2 HOURS a hung fire keeps its durable slot for up
 * to two hours. With the remaining slots churning, the dispatch epoch computed
 * `inFlight=3, available=0` and withheld release-trigger fire after fire: 41 routines were
 * overdue, release-trigger had not fired for ~50 minutes, and 426 green commits sat
 * undeployed behind a live certification that nothing was left to launch.
 *
 * It does NOT belong on the existing lanes: `routines-critical` contains only git-sync and
 * the bounded admission fail-open, both must-never-starve quick actions; the deploy launcher is
 * not one, and `routines-release` is the SERIAL lane for the operator-home
 * green-checkpoint, whose ~25-minute fire would starve a 15-minute trigger outright.
 * Serial, because two concurrent deploy evaluations have nothing to gain: the units they
 * launch are themselves singletons, deduped by fixed unit name.
 */
export const DEPLOY_TRIGGER_ACTIONS = new Set<string>(['release-trigger']);

/**
 * The sync-batch lint guard runs every five minutes and has a 15-minute red-finding target, but its
 * repo-wide lint work can run for up to 45 minutes. Keep it serial and isolated from both the ordinary
 * overdue-routine FIFO and the multi-hour heavy-job lane. It remains noncritical: pool-pressure shedding
 * still protects the database when the physical pool is critical.
 */
export const SYNC_GUARD_ACTIONS = new Set<string>(['sync-batch-lint-guards']);

/**
 * The queue NAME a routine fire should enqueue on, by its target role and (when
 * needed) install slug. The operator-home green-checkpoint is the workspace's
 * release finalizer: if it waits behind four long subject-hive gates, a frozen
 * repair queue cannot recover and every staging delivery remains blocked. Give
 * that one home-hive action its own serial lane; subject-hive checkpoints stay on
 * the bounded shared lane so their aggregate concurrency remains unchanged.
 *
 * A loop wake → the latency-isolated `routines-loop` lane; fleet control-plane
 * actions → the dedicated `routines-fleet-control` lane; a critical quick SYSTEM action →
 * `routines-critical`; a source poll or bounded trigger/import drain → `routines-triggers`; the
 * operator-home green-checkpoint → `routines-release`; the deploy launcher →
 * `routines-deploy`; the sync-batch lint guard → `routines-sync-guards`; a known
 * heavy/background action → `routines-heavy`;
 * everything else → `routines`.
 */
export function queueForRoutine(targetRole: string, installSlug?: string | null): string {
  if (targetRole === LOOP_WAKE_TARGET_ROLE) return ROUTINES_LOOP_QUEUE;
  if (targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
    const action = targetRole.slice(SYSTEM_TARGET_PREFIX.length);
    if (action === 'green-checkpoint' && installSlug === operatorHomeHarnessSlug()) {
      return ROUTINES_RELEASE_QUEUE;
    }
    if (HEAVY_ROUTINE_ACTIONS.has(action)) return ROUTINES_HEAVY_QUEUE;
    if (FLEET_CONTROL_ACTIONS.has(action)) return ROUTINES_FLEET_CONTROL_QUEUE;
    if (CRITICAL_ROUTINE_ACTIONS.has(action)) return ROUTINES_CRITICAL_QUEUE;
    if (DEPLOY_TRIGGER_ACTIONS.has(action)) return ROUTINES_DEPLOY_QUEUE;
    if (SYNC_GUARD_ACTIONS.has(action)) return ROUTINES_SYNC_GUARDS_QUEUE;
    if (TRIGGERS_QUEUE_ACTIONS.has(action)) return ROUTINES_TRIGGERS_QUEUE;
  }
  return ROUTINES_QUEUE;
}

/**
 * The CRITICAL-ROUTINE FLOOR for the routinesTick PG-pool-starvation shed (EI-11171).
 *
 * When routinesTickImpl sheds on critical pool pressure (pool-pressure.ts), it must NOT go
 * fully dark: the protected critical-queue actions (git-sync and the deterministic admission
 * fail-open) cannot be allowed to stall. Git-sync starvation froze every commit + deploy for 7h
 * (2026-06-23); fail-open starvation breaks the pending-admission floor. The original shed did
 * a bare `return` BEFORE the fire loop, silently skipping their enqueue too — defeating that lane.
 * This predicate is the floor: under a shed, a routine fires ONLY if it belongs to the protected
 * lane; everything else sheds with the heavy sweeps, exactly as before. Pure ⇒ unit-testable.
 */
export function shouldFireUnderPoolShed(targetRole: string): boolean {
  return queueForRoutine(targetRole) === ROUTINES_CRITICAL_QUEUE;
}

/**
 * EI-27084758447422793: the STARVATION BOUND on the pool-shed floor. The floor above skips every
 * non-critical routine for as long as the pool probe stays critical, with no limit. Measured
 * 2026-10-26: the probe classified critical on ~20 ticks per 15 min from 21:15Z to 22:45Z, and the
 * pr-drill green-checkpoint (cron :37 hourly) went unclaimed from its 21:37Z slot until 23:18Z, so
 * a frozen repair queue sat untested for ~100 min. Under a shed, a non-critical routine that has
 * been overdue for at least `boundMs` may still fire, oldest first, at most `starvedPerTick` per tick.
 * The shed stays real (one extra enqueue per tick at most) but no routine can be starved forever.
 */
export const POOL_SHED_STARVATION_BOUND_MS = 30 * 60_000;
export const POOL_SHED_STARVED_FIRES_PER_TICK = 1;

export interface PoolShedCandidate {
  readonly targetRole: string;
  readonly nextFireAt: Date | null;
}

/**
 * Which due routines may fire this tick under a critical pool shed: every critical-floor routine,
 * plus up to `starvedPerTick` non-critical routines overdue by at least `boundMs`. `dueByAge` must be
 * ordered oldest-due first, so the budget goes to the longest-starved routine. A NULL or non-finite
 * `nextFireAt` has no measurable overdue age and never counts as starved. Pure ⇒ unit-testable.
 */
export function admitUnderPoolShed<T extends PoolShedCandidate>(
  dueByAge: readonly T[],
  nowMs: number,
  opts: { boundMs?: number; starvedPerTick?: number } = {},
): Set<T> {
  let starvedLeft = opts.starvedPerTick ?? POOL_SHED_STARVED_FIRES_PER_TICK;
  const admitted = new Set<T>();
  for (const routine of dueByAge) {
    if (shouldFireUnderPoolShed(routine.targetRole)) {
      admitted.add(routine);
      continue;
    }
    if (starvedLeft <= 0) continue;
    if (!isStarvedPastBound(routine, nowMs, opts.boundMs)) continue;
    admitted.add(routine);
    starvedLeft -= 1;
  }
  return admitted;
}

/**
 * True when a NON-critical routine has been overdue for at least `boundMs`. A critical-floor
 * routine is never "starved" in this sense (it has its own protected lane), and a NULL or
 * non-finite `nextFireAt` has no measurable overdue age. Pure ⇒ unit-testable.
 */
export function isStarvedPastBound(
  routine: PoolShedCandidate,
  nowMs: number,
  boundMs: number = POOL_SHED_STARVATION_BOUND_MS,
): boolean {
  if (shouldFireUnderPoolShed(routine.targetRole)) return false;
  const dueAtMs = routine.nextFireAt?.getTime();
  return dueAtMs !== undefined && Number.isFinite(dueAtMs) && nowMs - dueAtMs >= boundMs;
}

/** Per-tick budget for starved routines that may start despite zero queue credit. */
export interface StarvedZeroCreditBudget {
  left: number;
}

export function createStarvedZeroCreditBudget(
  perTick: number = POOL_SHED_STARVED_FIRES_PER_TICK,
): StarvedZeroCreditBudget {
  return { left: Math.max(0, Math.floor(perTick)) };
}

/**
 * WI-6554700010030059: the starvation bound must reach the queue's ZERO-CREDIT hold too, not only
 * the pool-shed filter. Under a critical probe the dispatch epoch gives every non-critical queue
 * zero starts, so a routine admitUnderPoolShed had just admitted was then HELD by the credit check
 * and never fired. Measured 2026-10-27: precompute-derived-reads was logged "firing STARVED" on
 * consecutive ticks while it stayed 50+ min overdue. Under ok/elevated pressure a full window
 * (long fires holding every slot) starved gate-watcher-tick for 45 min the same way.
 *
 * Returns true, and spends one unit of `budget`, when `routine` may start although its queue has no
 * credit left this tick. The leak is bounded: at most the budget per tick (default
 * POOL_SHED_STARVED_FIRES_PER_TICK), and only for a routine overdue past the bound. Once it fires,
 * its next_fire_at advances, so the same routine cannot monopolise the budget.
 */
export function admitStarvedZeroCreditStart(
  routine: PoolShedCandidate,
  nowMs: number,
  budget: StarvedZeroCreditBudget,
  boundMs: number = POOL_SHED_STARVATION_BOUND_MS,
): boolean {
  if (budget.left <= 0) return false;
  if (!isStarvedPastBound(routine, nowMs, boundMs)) return false;
  budget.left -= 1;
  return true;
}
