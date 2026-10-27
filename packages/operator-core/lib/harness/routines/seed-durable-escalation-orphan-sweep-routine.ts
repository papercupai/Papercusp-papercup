/**
 * Seed the always-on durable-escalation orphan sweep (WI-1741477).
 *
 * Daily at 04:40 — deliberately sparse, and off both the dead-citation sweep's 03:15 and the
 * admission-delta sweep's hourly :07 offset. The cadence is set by what the signal actually
 * does: each emitter is judged against its OWN p95 close time, which for the slowest emitters
 * measured is ~336h. Sampling a multi-day signal every few minutes would burn a ledger scan
 * per tick to re-observe the same state, so the item that commissioned this specified hours,
 * not minutes.
 *
 *   tsx seed-durable-escalation-orphan-sweep-routine.ts
 *   tsx seed-durable-escalation-orphan-sweep-routine.ts --inactive
 *
 * ⚠ WRITING THIS SCRIPT IS NOT RUNNING IT. A seed script that is never executed leaves the
 * handler registered with no `harness_shared.routines` row, which never fires — the exact
 * defect this whole action was commissioned to detect, reproduced in its own bring-up. The
 * action is declared `scheduling: 'standing'` (the default), so `validateActiveRoutines`
 * reports a missing row as an `unscheduledSystemActions` offender, and
 * `bespoke-active-seeds-check.ts` carries the paired entry.
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { DURABLE_ESCALATION_ORPHAN_SWEEP } from './durable-escalation-orphan-sweep-action';

const SLUG =
  process.env.DURABLE_ESCALATION_ORPHAN_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

void runRoutineSeed({
  scriptTag: 'seed-durable-escalation-orphan-sweep-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const name = DURABLE_ESCALATION_ORPHAN_SWEEP;
    const triggerConfig = { cron: '0 40 4 * * *' };
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
        `[seed-durable-escalation-orphan-sweep-routine] ${SLUG}: seeded durable daily 04:40 ` +
          `durable-escalation orphan sweep (${active ? 'ACTIVE' : 'inactive'}).`,
      );
    await sql.end({ timeout: 5 });
  },
});
