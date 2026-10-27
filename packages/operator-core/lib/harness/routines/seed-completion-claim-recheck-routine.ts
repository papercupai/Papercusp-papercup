/**
 * Seed the always-on post-close completion-claim recheck (WI-2142447).
 *
 * Cadence: every 6 hours at :25, off both the hourly :07 admission-delta sweep and the
 * daily 03:15 dead-citation sweep. More often than daily because the measured drift rate on
 * this tree is a 69-MINUTE half-life on a load-bearing claim about a named array
 * (EI-22175397357614106); less often than hourly because the pass reads and parses source
 * per claim, and a claim that went false four hours ago is not more wrong than one that
 * went false four minutes ago — nothing downstream reacts to it faster than a person reads.
 *
 *   tsx seed-completion-claim-recheck-routine.ts
 *   tsx seed-completion-claim-recheck-routine.ts --inactive
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { COMPLETION_CLAIM_RECHECK } from './completion-claim-recheck-action';

const SLUG = process.env.COMPLETION_CLAIM_RECHECK_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

void runRoutineSeed({
  scriptTag: 'seed-completion-claim-recheck-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const name = COMPLETION_CLAIM_RECHECK;
    const triggerConfig = { cron: '0 25 */6 * * *' };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: `system:${name}`,
      tier: 'durable' as const,
      payloadTemplate: '{}',
    };
  },
  afterSeed: async ({ active, id, workspaceId, sql, name, triggerConfig }) => {
    console.log(
        `[seed-completion-claim-recheck-routine] ${SLUG}: seeded durable 6-hourly :25 ` +
          `completion-claim recheck (${active ? 'ACTIVE' : 'inactive'}).`,
      );
    await sql.end({ timeout: 5 });
  },
});
