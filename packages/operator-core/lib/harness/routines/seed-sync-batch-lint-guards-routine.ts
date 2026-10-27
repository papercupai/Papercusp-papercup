/**
 * Seed the `sync-batch-lint-guards` routine (green-main-cycle-time-2026-10-08 P-028):
 * `system:sync-batch-lint-guards` -> `sync-batch-lint-guards-action.ts`, the gate's
 * repo-wide lint guards run per git-sync batch with new violations routed to their author.
 *
 * Every 5 minutes at :04/:09/..., offset from sync-batch-delta-check (:02/5),
 * green-checkpoint (:15) and cargo-test (:45). DURABLE cron row fired by routinesTick, not
 * ephemeral, for the reason seed-sync-batch-delta-check-routine.ts records.
 *
 * Seeded ACTIVE by default: the action reads the tree and files deduped work-items, never
 * mutates source, self-gates to the operator-home installSlug, and every unmeasurable guard
 * resolves to doing less. `--inactive` seeds it off.
 *
 *   tsx seed-sync-batch-lint-guards-routine.ts             # seed ACTIVE
 *   tsx seed-sync-batch-lint-guards-routine.ts --inactive  # seed off
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.SYNC_BATCH_LINT_GUARDS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** 6-field cron, second-first: every 5 minutes at :04/:09/:14/... */
const CRON = '0 4/5 * * * *';

void runRoutineSeed({
  scriptTag: 'seed-sync-batch-lint-guards-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const name = 'sync-batch-lint-guards';
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify({ cron: CRON }),
      targetRole: 'system:sync-batch-lint-guards',
      replaceActive: true,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, name }) => {
    console.log(
        `[seed-sync-batch-lint-guards-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          'every 5 min (:04/5) repo-wide lint guards over staging. ' +
          (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
      );
    await sql.end({ timeout: 5 });
  },
});
