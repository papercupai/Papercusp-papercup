/**
 * Seed the daily hive-canary routine (hive-loop-e2e-testing-2026-06-10 P-009).
 *
 * One routine, `hive-canary` → `system:hive-canary`, daily at 09:00 (6-field
 * cron). RETIRED: the autonomous cup loop this routine measured is permanently
 * disarmed. This seed remains as an idempotent row normalizer for historical
 * installs, but it always writes an inactive row and has no activation mode.
 *
 * The routine's install_slug IS the canary harness (default 'hive-canary';
 * override via POT_CANARY_HARNESS). payload_template tunables:
 * `deadlineHours` (default 6), `title` (the trivial feature's title).
 *
 *   tsx seed-hive-canary-routine.ts              # seed INACTIVE (permanently retired)
 */
import { runRoutineSeed } from './seed-routine-main';

const SLUG = process.env.POT_CANARY_HARNESS ?? process.env.HIVE_CANARY_HARNESS ?? 'hive-canary'; // legacy env name — dual-accept until callers migrate

void runRoutineSeed({
  scriptTag: 'seed-hive-canary',
  exit: false,
  prepare: () => {
    const active = false;
    return {
      installSlug: SLUG,
      name: 'hive-canary',
      active,
      triggerConfig: JSON.stringify({ cron: '0 0 9 * * *' }),
      targetRole: 'system:hive-canary',
      payloadTemplate: JSON.stringify({ deadlineHours: 6 }),
      permanentlyInactive: true,
      updateWorkspace: false,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql }) => {
    console.log(`[seed-hive-canary] routine ${id} seeded (harness=${SLUG}, active=${active})`);
    await sql.end({ timeout: 5 });
  },
});
