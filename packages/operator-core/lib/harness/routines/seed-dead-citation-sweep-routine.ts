/**
 * Seed the always-on dead-citation sweep (EI-21894865709918325).
 *
 * Sparse daily cadence (03:15, off the admission-delta-sweep's hourly :07 offset): doc/metadata
 * citation drift accumulates slowly and the check is cheap but non-urgent, unlike the hourly
 * root-cause burst detector this deliberately does not compete with.
 *
 *   tsx seed-dead-citation-sweep-routine.ts
 *   tsx seed-dead-citation-sweep-routine.ts --inactive
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { DEAD_CITATION_SWEEP } from './dead-citation-sweep-action';

const SLUG = process.env.DEAD_CITATION_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

void runRoutineSeed({
  scriptTag: 'seed-dead-citation-sweep-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const name = DEAD_CITATION_SWEEP;
    const triggerConfig = { cron: '0 15 3 * * *' };
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
        `[seed-dead-citation-sweep-routine] ${SLUG}: seeded durable daily 03:15 dead-citation sweep ` +
          `(${active ? 'ACTIVE' : 'inactive'}).`,
      );
    await sql.end({ timeout: 5 });
  },
});
