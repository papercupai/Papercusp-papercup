/**
 * Seed the FAST hive-canary SLA sweep (EI-18170 recurrence-guard).
 *
 * One routine, `hive-canary-sla` → `system:hive-canary-sla`, every 15 minutes
 * (6-field cron `0 *\/15 * * * *`). The COMPLEMENT to the daily `hive-canary`
 * routine (seed-hive-canary-routine.ts): the daily check fires once/day with a 6h
 * deadline, so a canary the completion driver never touches was invisible for up
 * to ~24h AND only if the daily routine itself ran. This sweep flags today's
 * canary within ~SLA (default 30min) of creation, INDEPENDENT of any Mug/Queen
 * wake — closing the detector gap that let F-CANARY-20260720 sit open+untouched
 * with no standing alarm.
 *
 * RETIRED: the autonomous cup loop this routine measured is permanently
 * disarmed. This seed remains as an idempotent row normalizer for historical
 * installs, but it always writes an inactive row and has no activation mode.
 *
 * The routine's install_slug IS the canary harness (default 'hive-canary';
 * override via POT_CANARY_HARNESS). payload_template tunable: `slaMinutes`
 * (default 30) — the fast completion SLA before an early-warning bug is filed.
 *
 *   tsx seed-hive-canary-sla-routine.ts              # seed INACTIVE (permanently retired)
 */
import { runRoutineSeed } from './seed-routine-main';

const SLUG = process.env.POT_CANARY_HARNESS ?? process.env.HIVE_CANARY_HARNESS ?? 'hive-canary'; // legacy env name — dual-accept until callers migrate

void runRoutineSeed({
  scriptTag: 'seed-hive-canary-sla',
  exit: false,
  prepare: () => {
    const active = false;
    return {
      installSlug: SLUG,
      name: 'hive-canary-sla',
      active,
      triggerConfig: JSON.stringify({ cron: '0 */15 * * * *' }),
      targetRole: 'system:hive-canary-sla',
      payloadTemplate: JSON.stringify({ slaMinutes: 30 }),
      permanentlyInactive: true,
      updateWorkspace: false,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql }) => {
    console.log(`[seed-hive-canary-sla] routine ${id} seeded (harness=${SLUG}, active=${active})`);
    await sql.end({ timeout: 5 });
  },
});
