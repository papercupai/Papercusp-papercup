/**
 * Seed the `idle-session-reaper` routine — P-011 (D-007); design in
 * `idle-session-reaper.ts`, handler in `idle-session-reaper-action.ts`.
 *
 *   - `idle-session-reaper` (hourly): mark DEAD-process open adv_sessions ended
 *     (owner dropped out of the liveness set past the grace window), reclaiming
 *     the live roster + unblocking session-dir-gc. SQL-only; spawns no agent,
 *     makes no network call.
 *
 * DOUBLE-GATED: the action is flag-gated DEFAULT-OFF (papercusp-idle-session-reaper),
 * and this routine is SEEDED INACTIVE. Bring-up is human-confirmed; idempotent
 * (upsert). Recommended bring-up order: `--active` with `dry_run` first to preview
 * the ghost set, then flip the flag, then drop dry_run.
 *
 *   tsx seed-idle-session-reaper-routine.ts            # seed INACTIVE
 *   tsx seed-idle-session-reaper-routine.ts --active   # seed + enable the hourly sweep
 *   tsx seed-idle-session-reaper-routine.ts --active --dry-run  # enable in preview mode
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - dry_run (default false) — plan + log but mark nothing.
 */

import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.IDLE_SESSION_REAPER_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Hourly at :05 — cheap (one SELECT + a few UPDATEs); dead sessions accrue all day. */
const CRON = '0 5 * * * *';

void runRoutineSeed({
  scriptTag: 'seed-idle-session-reaper-routine',
  prepare: () => {
    const active = process.argv.includes('--active');
    const dryRun = process.argv.includes('--dry-run');
    const name = 'idle-session-reaper';
    const triggerConfig = { cron: CRON, dry_run: dryRun };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: 'system:idle-session-reaper',
      dryRun,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, dryRun, name, triggerConfig }) => {
    console.log(
        `[seed-idle-session-reaper-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}, dry_run=${dryRun}) — ` +
          `hourly reap of dead-process session rows. ` +
          (active
            ? 'Cadence LIVE (still flag-gated by papercusp-idle-session-reaper).'
            : 'Inactive — enable with --active or the routines admin.'),
      );
  },
});
