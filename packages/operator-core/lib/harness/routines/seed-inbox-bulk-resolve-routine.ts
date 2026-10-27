/** Seed the always-on durable Inbox resolver backstop (P-009). */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { announceRoutineSeeded } from './seed-routine-announce';
import { INBOX_BULK_RESOLVE, INBOX_BULK_RESOLVE_CAP } from './inbox-bulk-resolve-action';

const SLUG = process.env.INBOX_BULK_RESOLVE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = INBOX_BULK_RESOLVE;
const TARGET_ROLE = `system:${NAME}`;
/** Second 26, every 15 minutes — offset from legacy-needs-human at second 11. */
const CRON = '26 */15 * * * *';

void runRoutineSeed({
  scriptTag: 'seed-inbox-bulk-resolve-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const triggerConfig = { cron: CRON, cap: INBOX_BULK_RESOLVE_CAP };
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
        `[seed-inbox-bulk-resolve-routine] seeded "${NAME}" for "${SLUG}" ` +
          `(ws=${ws}, active=${active}, tier=durable, cron=${CRON}, cap=${INBOX_BULK_RESOLVE_CAP}).`,
      );
    announceRoutineSeeded('seed-inbox-bulk-resolve-routine', 'packages/operator-core/lib/harness/routines/inbox-bulk-resolve-action.ts');
    await sql.end({ timeout: 5 });
  },
});
