/**
 * Seed the `spec-conformance-sweep` routine (spec-driven-tooling-integration-2026-10-05
 * P-031, R-23; handler + row shape in `../../spec-conformance/sweep-action.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`): ONE
 * operator-home row serves every workspace plan, mirroring
 * `seed-acceptance-grading-sweep-routine.ts`. Ephemeral rows are armed by the per-host
 * ephemeral executor on boot — not a bare `setInterval`.
 *
 * SEEDED ACTIVE by default: the sweep is bounded per tick (`maxRunsPerTick`), every action it
 * takes is an existing idempotent surface (the conformance run's ledger rows + condition-keyed
 * drift alarms, the footprint reconcile's condition-keyed finding, its own watermark row), and
 * finished work never ships dark. Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-spec-conformance-sweep-routine.ts              # seed ACTIVE (default)
 *   tsx seed-spec-conformance-sweep-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name)). Run it only once the handler is live on the
 * serving build: an active row whose target_role is unregistered fails every tick.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { specConformanceSweepRoutineRow } from '../../spec-conformance/sweep-action';

const SLUG = process.env.SPEC_CONFORMANCE_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'spec-conformance-sweep';
const TARGET_ROLE = 'system:spec-conformance-sweep';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const row = specConformanceSweepRoutineRow({ installSlug: SLUG, workspaceId: activeWorkspaceId(), active });
  if (row.name !== NAME || row.target_role !== TARGET_ROLE) {
    throw new Error(`seed/handler mismatch: row ${row.name}/${row.target_role} vs ${NAME}/${TARGET_ROLE}`);
  }
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at, workspace_id)
    VALUES (
      ${row.id}, ${row.install_slug}, ${row.name}, ${row.trigger_kind},
      ${JSON.stringify(row.trigger_config)}::text::jsonb, ${row.target_role},
      ${row.concurrency}, ${row.catchup}, ${row.active}, ${row.tier}, NULL, ${row.workspace_id}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind   = EXCLUDED.trigger_kind,
      trigger_config = EXCLUDED.trigger_config,
      target_role    = EXCLUDED.target_role,
      tier           = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a re-seed
      -- must never clobber an operator's runtime pause/resume of this routine.
      workspace_id   = EXCLUDED.workspace_id,
      updated_at     = now()
  `;
  console.log(
    `[seed-spec-conformance-sweep-routine] seeded "${NAME}" for "${SLUG}" (ws=${row.workspace_id}, active=${active}, ` +
      `tier=ephemeral, interval=${row.trigger_config.interval_sec}s). Restart papercusp-bg-host to live-arm on a running host.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-spec-conformance-sweep-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
