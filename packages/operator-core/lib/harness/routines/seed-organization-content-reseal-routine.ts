/**
 * Seed the `organization-content-reseal` routine — WI-6554700010012443 U5 (plan
 * papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b follow-up; handler in
 * `organization-content-reseal-action.ts`, logic in
 * `../../data-governance/organization-document-reseal.ts`).
 *
 *   - `organization-content-reseal` (every 15 min): re-seal a bounded batch of organization documents
 *     whose envelope DEK version is not their organization's active version, so a DEK rotation
 *     actually moves stored content and its blind-index tokens onto the new key.
 *
 * Seeded ACTIVE by default. It changes no document content, launches no agent or model, and has no
 * outward-facing or owner-authority effect: each tick is one bounded read plus compare-and-swap
 * writes, and a finished organization costs one read. Pass `--inactive` to seed dark.
 *
 *   tsx seed-organization-content-reseal-routine.ts                   # seed ACTIVE (default)
 *   tsx seed-organization-content-reseal-routine.ts --inactive        # seed dark
 *   tsx seed-organization-content-reseal-routine.ts --batch-size 500  # larger per-tick bound
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - batchSize (default 200, DEFAULT_RESEAL_BATCH_SIZE; clamped to 1..5000)
 *
 * Idempotent upsert on (install_slug, name). A re-run does not re-apply `active`, so an operator's
 * pause survives a re-seed. The routine engine picks a newly seeded row up on its next tick; a host
 * that does not yet register the action logs "no handler registered" and skips.
 */
import { runRoutineSeed } from './seed-routine-main';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.ORGANIZATION_CONTENT_RESEAL_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 15 minutes on the :00 second (6-field: sec min hour dom mon dow). A row left under an older
 *  DEK stays readable and findable, so nothing is urgent; 15 minutes at 200 rows moves ~19k rows a day
 *  after a rotation and costs one bounded read per tick otherwise. */
const CRON = '0 */15 * * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

void runRoutineSeed({
  scriptTag: 'seed-organization-content-reseal-routine',
  prepare: () => {
    const active = !process.argv.includes('--inactive');
    const batchSize = argNumber('--batch-size');
    const name = 'organization-content-reseal';
    const triggerConfig = { cron: CRON, ...(batchSize ? { batchSize } : {}) };
    return {
      installSlug: SLUG,
      name: name,
      active,
      triggerConfig: JSON.stringify(triggerConfig),
      targetRole: 'system:organization-content-reseal',
      batchSize,
    };
  },
  afterSeed: async ({ active, id, workspaceId: ws, sql, batchSize, name, triggerConfig }) => {
    console.log(
        `[seed-organization-content-reseal-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
          `15-minute DEK-rotation re-seal sweep for sealed organization documents` +
          (batchSize ? `, batchSize=${batchSize}` : '') +
          '.',
      );
  },
});
