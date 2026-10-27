/**
 * Seed the `reconcile-silent-halts` routine — WI-35718 (root cause: an autonomous session that
 * goes inert for a reason OTHER than a bound breach is caught by nothing, because at the moment
 * it happens there is no executing code to notice; handler in `silent-halt-action.ts`, sweep in
 * `silent-halt-reconcile.ts`).
 *
 *   - `reconcile-silent-halts` (every 20 min): find sessions whose PROCESS IS ALIVE (fresh
 *     presence heartbeat) but which hold an autonomy posture with an INACTIVE loop, no pending
 *     events:await, and no recent real turn — then page the OWNER once per halt epoch. Reads
 *     only; it disarms nothing and touches no loop, because its subjects are already stopped and
 *     the remedy is a human.
 *
 * Confirmed live cost of NOT running this (measured 2026-09-01 while authoring): THREE sessions
 * in this workspace matched at that instant, the worst disarmed 5,906 minutes — 4.1 DAYS — with
 * a heartbeat 65 seconds old. Nothing in the system was due to notice any of them. That is the
 * same shape as WI-35718's own cited incident (su-1f7ee244: 4 days inert, plan advanced zero
 * items, restarted only because the owner happened to type into the session).
 *
 * WHY 20 MINUTES, not hourly. The staleness floor is already 30 minutes, so the cadence is not
 * what protects against a premature page — the floor is. A shorter period only shortens the gap
 * between a halt becoming real and the owner hearing about it, and the sweep is a handful of
 * indexed SELECTs plus at most a bounded number of deduped notifications.
 *
 * NOT flag-gated (read-only liveness housekeeping; it changes no loop and no session state —
 * strictly less invasive than gc-dead-loops or stalled-loops-guard, both of which write).
 * Seeded ACTIVE by default: every ambiguity in the verdict resolves toward silence (no presence
 * row, stale heartbeat, any pending await, an armed loop, or no autonomy posture all exempt), so
 * there is nothing here for a human to eyeball first.
 *
 *   tsx seed-silent-halt-routine.ts                # seed + enable (default)
 *   tsx seed-silent-halt-routine.ts --inactive     # seed but leave disabled
 *   tsx seed-silent-halt-routine.ts --dry-run      # detect and log only, page nobody
 */

import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SILENT_HALT_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 20 minutes at :04 past — offset from sweep-stalled-loops (:07) and gc-plan-runs (:12)
 *  so the loop-liveness janitors never contend for the same read. */
const CRON = '0 4,24,44 * * * *';

void runRoutineSeed({
  scriptTag: 'seed-silent-halt-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const dryRun = process.argv.includes('--dry-run');
    const name = 'reconcile-silent-halts';
    const triggerConfig = {
        cron: CRON,
        ...(dryRun ? { dry_run: true } : {}),
      };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: 'system:reconcile-silent-halts',
      dryRun,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, dryRun, name, triggerConfig }) => {
    console.log(
        `[seed-silent-halt-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          `20-minute sweep paging the OWNER about live sessions whose loop is inactive with no wake source` +
          (dryRun ? ', dry_run=true' : '') +
          '.',
      );
  },
});
