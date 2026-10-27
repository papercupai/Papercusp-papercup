/**
 * Seed the cross-harness legacy `payload.needsHuman` reconciliation backstop
 * (autonomous-inbox-resolution-2026-08-31 P-004).
 *
 * Every 15 minutes at :11, one durable single-flight tick removes at most `cap`
 * stale presentation markers after re-checking the row's live lifecycle and typed
 * blocker state. It is payload-only, cross-harness within the workspace, makes no
 * model call, and leaves every real owner/capability gate intact.
 *
 * Seeded ACTIVE by default. This is the recurring guard that migration 1020 could
 * not provide; shipping it dark would leave replay/federation residue permanent.
 *
 *   tsx seed-legacy-needs-human-reconcile-routine.ts
 *   tsx seed-legacy-needs-human-reconcile-routine.ts --inactive
 *   tsx seed-legacy-needs-human-reconcile-routine.ts --cap 50
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP,
  LEGACY_NEEDS_HUMAN_RECONCILE,
  legacyNeedsHumanReconcileCap,
} from './legacy-needs-human-reconcile-action';

const SLUG = process.env.LEGACY_NEEDS_HUMAN_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = LEGACY_NEEDS_HUMAN_RECONCILE;
const TARGET_ROLE = `system:${NAME}`;
const CRON = '11 */15 * * * *';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

void runRoutineSeed({
  scriptTag: 'seed-legacy-needs-human-reconcile-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const cap = legacyNeedsHumanReconcileCap(argValue('--cap') ?? DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP);
    const triggerConfig = { cron: CRON, cap };
    return {
      installSlug: SLUG,
      name: NAME,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: TARGET_ROLE,
      tier: 'durable' as const,
      cap,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, cap, triggerConfig }) => {
    console.log(
        `[seed-legacy-needs-human-reconcile-routine] seeded "${NAME}" for "${SLUG}" ` +
          `(ws=${ws}, active=${active}, tier=durable, cron=${CRON}, cap=${cap}).`,
      );
    await sql.end({ timeout: 5 });
  },
});
