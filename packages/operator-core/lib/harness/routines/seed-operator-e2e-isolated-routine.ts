/**
 * Seed the standing operator e2e routines (plan operator-e2e-standing-isolated-run-2026-10-06):
 *
 *   - `operator-e2e-isolated` (P-002, WI-10006805): `system:operator-e2e-isolated` →
 *     `operator-e2e-isolated-action.ts`, which launches the operator Playwright suite inside the
 *     isolated verify-tauri-headless rig and records every spec result in
 *     `harness_shared.test_runs` under the run group `operator-e2e-nightly:<fire>`. Nightly at
 *     04:30, an hour and a half after the 03:00 nightly release cut (a 30-40 min build), so the two
 *     heaviest nightly jobs do not start together. The run is also pc-heavy-wrapped, so it queues
 *     behind any heavy job that still holds a slot.
 *   - `operator-e2e-red-filer` (P-003, WI-10006806): `system:operator-e2e-red-filer` →
 *     `operator-e2e-red-filer.ts`, which files or assigns one owned work-item per red spec in the
 *     newest completed nightly group. Hourly at :50; idempotent, so hourly costs a few bounded
 *     queries and catches a run whenever it finishes.
 *
 * `tier: 'durable'` puts each fire on the DBOS routines engine. Seeded ACTIVE by default: the suite
 * runs against a throwaway database and WebView profile (VERIFY_TAURI_ISOLATED_DB=1), it never
 * mutates tracked source, and both actions self-gate to the operator-home harness. Finished work
 * never ships dark (CLAUDE.md). `--inactive` seeds both off for an explicit dark launch.
 *
 * `OPERATOR_E2E_RED_OWNER=<ownerId>` sets the filer's `payload_template.redOwner` (plan D-002);
 * without it the filer assigns reds to the umbrella item's assignee.
 *
 *   tsx seed-operator-e2e-isolated-routine.ts             # seed ACTIVE
 *   tsx seed-operator-e2e-isolated-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.OPERATOR_E2E_ISOLATED_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Nightly at 04:30, clear of the 03:00 nightly release cut. */
const OPERATOR_E2E_ISOLATED_CRON = '0 30 4 * * *';
/** Hourly at :50. */
const OPERATOR_E2E_RED_FILER_CRON = '0 50 * * * *';

interface SeedRow {
  name: string;
  cron: string;
  targetRole: string;
  payloadTemplate: Record<string, unknown> | null;
  describe: string;
}

function seedRows(): SeedRow[] {
  const redOwner = process.env.OPERATOR_E2E_RED_OWNER?.trim();
  return [
    {
      name: 'operator-e2e-isolated',
      cron: OPERATOR_E2E_ISOLATED_CRON,
      targetRole: 'system:operator-e2e-isolated',
      payloadTemplate: null,
      describe: 'nightly (04:30) isolated operator Playwright run, ledger group operator-e2e-nightly:<fire>',
    },
    {
      name: 'operator-e2e-red-filer',
      cron: OPERATOR_E2E_RED_FILER_CRON,
      targetRole: 'system:operator-e2e-red-filer',
      payloadTemplate: redOwner ? { redOwner } : null,
      describe: `hourly (:50) red filer for the newest completed nightly group${redOwner ? `, owner ${redOwner}` : ''}`,
    },
  ];
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  for (const row of seedRows()) {
    const id = `rt_${SLUG}_${row.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         payload_template, concurrency, catchup, active, tier, next_fire_at)
      VALUES (${id}, ${SLUG}, ${ws}, ${row.name}, 'cron', ${JSON.stringify({ cron: row.cron })}::text::jsonb,
              ${row.targetRole}, ${row.payloadTemplate == null ? null : JSON.stringify(row.payloadTemplate)}::text::jsonb,
              'skip', 'skip-old', ${active}, 'durable', now())
      ON CONFLICT (install_slug, name) DO UPDATE SET
        target_role = EXCLUDED.target_role,
        trigger_config = EXCLUDED.trigger_config,
        tier = EXCLUDED.tier,
        -- An explicit owner on re-seed wins; a re-seed without one keeps the row's current owner.
        payload_template = COALESCE(EXCLUDED.payload_template, harness_shared.routines.payload_template),
        -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
        -- re-seed must never clobber an operator's runtime pause/resume of this routine.
        workspace_id = EXCLUDED.workspace_id,
        updated_at = now()
    `;
    console.log(
      `[seed-operator-e2e-isolated-routine] seeded "${row.name}" for "${SLUG}" (ws=${ws}, active=${active}): ` +
        `${row.describe}. ` +
        (active ? 'Cadence LIVE.' : 'Inactive; enable it from the routines admin.'),
    );
  }
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-operator-e2e-isolated-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
