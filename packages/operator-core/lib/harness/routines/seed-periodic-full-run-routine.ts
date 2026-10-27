/**
 * Seed the `periodic-full-run` routine (green-main-ratchet-convergence-2026-10-17 P-013) —
 * `system:periodic-full-run` → `periodic-full-run-action.ts`, the whole-suite run of `main`
 * whose new failures are attributed to a single promotion by bisection.
 *
 * Every 30 minutes at :22/:52, offset from green-checkpoint (:15), cargo-test (:45) and the
 * 5-minute sync-batch slots (:02/5). The action runs the suite only when 6h have passed since
 * the last full run, so the cadence is "at least every 6h while live". Durable, not
 * ephemeral (the sync-batch-delta-check seed's reasoning), concurrency 'skip' so an overrunning
 * run absorbs the next ticks.
 *
 * Seeded ACTIVE: the action runs tests in clean trees and files deduped bugs, never mutates
 * source, and self-gates to the operator-home installSlug. `--inactive` seeds it off.
 *
 *   tsx seed-periodic-full-run-routine.ts             # seed ACTIVE
 *   tsx seed-periodic-full-run-routine.ts --inactive  # seed off
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.PERIODIC_FULL_RUN_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** 6-field cron, second-first: :22 and :52 every hour. */
const CRON = '0 22/30 * * * *';

void runRoutineSeed({
  scriptTag: 'seed-periodic-full-run-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const name = 'periodic-full-run';
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify({ cron: CRON }),
      targetRole: 'system:periodic-full-run',
      replaceActive: true,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, name }) => {
    console.log(
        `[seed-periodic-full-run-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          `every 30 min (:22/30), full suite of main at least every 6h. ` +
          (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
      );
    await sql.end({ timeout: 5 });
  },
});
