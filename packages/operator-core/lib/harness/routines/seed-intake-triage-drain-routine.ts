/**
 * Seed the durable intake-triage drain (observation-candidate-acceptance-promotion-2026-09-30,
 * P-008 / D-020). It drains awaiting observations/candidates as `intake-triage` runs, apart
 * from the Inbox resolver and from accepted implementation work.
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';
import { INTAKE_TRIAGE_DRAIN, INTAKE_TRIAGE_DRAIN_CAP } from './intake-triage-drain-action';

const SLUG = process.env.INTAKE_TRIAGE_DRAIN_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = INTAKE_TRIAGE_DRAIN;
const TARGET_ROLE = `system:${NAME}`;
/**
 * Second 41, minute 7, every hour. Hourly, not every 15 minutes like the Inbox resolver:
 * one intake run takes up to 200 rows and holds its single-flight slot until the owner
 * reviews it, so a faster cadence would only add skipped fires.
 */
const CRON = '41 7 * * * *';

void runRoutineSeed({
  scriptTag: 'seed-intake-triage-drain-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const triggerConfig = { cron: CRON, cap: INTAKE_TRIAGE_DRAIN_CAP };
    return {
      installSlug: SLUG,
      name: NAME,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: TARGET_ROLE,
      tier: 'durable' as const,
      payloadTemplate: '{}',
      updatePayload: true,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, triggerConfig }) => {
    console.log(
        `[seed-intake-triage-drain-routine] seeded "${NAME}" for "${SLUG}" ` +
          `(ws=${ws}, active=${active}, tier=durable, cron=${CRON}, cap=${INTAKE_TRIAGE_DRAIN_CAP}).`,
      );
    announceRoutineSeeded(
        'seed-intake-triage-drain-routine',
        'packages/operator-core/lib/harness/routines/intake-triage-drain-action.ts',
      );
    await sql.end({ timeout: 5 });
  },
});
