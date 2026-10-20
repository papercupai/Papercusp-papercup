#!/usr/bin/env -S npx tsx
/**
 * One-time backfill of harness_plans.verification_profile, with the R-6 ship-verdict census
 * (plan-verification-profiles-2026-10-17 P-002, WI-6554700010017301).
 *
 * The logic lives in packages/operator-core/lib/agent-tools/plans/verification-profile-backfill.ts
 * and is covered by verification-profile-backfill.integration.test.ts; this file is only the CLI.
 * Migration 1537 must be applied first, so the write keeps every plan's federation clock.
 *
 * Usage (DATABASE_URL must point at the operator database; apps/operator/.env.local supplies it):
 *   npx tsx scripts/backfill-plan-verification-profiles.mts --census before.json   # gate verdicts of shipped plans
 *   npx tsx scripts/backfill-plan-verification-profiles.mts                        # dry run: what would be written
 *   npx tsx scripts/backfill-plan-verification-profiles.mts --execute              # write (NULL rows only; idempotent)
 *   npx tsx scripts/backfill-plan-verification-profiles.mts --census after.json
 *   npx tsx scripts/backfill-plan-verification-profiles.mts --diff before.json after.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import {
  backfillPlanVerificationProfiles,
  diffShipVerdicts,
  SHIP_VERDICT_CENSUS_GATE_OPTS,
  shipVerdictSnapshot,
  type ShipVerdictSnapshot,
} from '../packages/operator-core/lib/agent-tools/plans/verification-profile-backfill';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function census(outPath: string): Promise<void> {
  const { evaluatePlanAcceptanceGate } = await import('../packages/operator-core/lib/plan-acceptance-gate');
  const { runWithWorkspace } = await import('../packages/operator-core/lib/workspace-als');
  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  let plans: Array<{ workspace_id: string; harness_slug: string; plan_slug: string }>;
  try {
    plans = await sql`
      SELECT workspace_id, harness_slug, plan_slug FROM harness_shared.harness_plans
       WHERE status = 'shipped' ORDER BY workspace_id, harness_slug, plan_slug`;
  } finally {
    await sql.end();
  }
  const concurrency = Number(flag('--concurrency') ?? 4);
  const out: Array<ShipVerdictSnapshot & { ms: number }> = [];
  let next = 0;
  const started = Date.now();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= plans.length) return;
      const p = plans[i];
      const t0 = Date.now();
      const base = { workspaceId: p.workspace_id, harnessSlug: p.harness_slug, planSlug: p.plan_slug };
      try {
        const gate = await runWithWorkspace(p.workspace_id, () =>
          evaluatePlanAcceptanceGate(p.plan_slug, { harnessSlug: p.harness_slug, ...SHIP_VERDICT_CENSUS_GATE_OPTS }),
        );
        out.push({ ...shipVerdictSnapshot(base, gate), ms: Date.now() - t0 });
      } catch (err) {
        out.push({ ...base, satisfied: null, code: null, error: String(err).slice(0, 300), ms: Date.now() - t0 });
      }
      if (out.length % 50 === 0) {
        process.stderr.write(`census ${out.length}/${plans.length} ${Math.round((Date.now() - started) / 1000)}s\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  out.sort((a, b) => `${a.workspaceId}/${a.harnessSlug}/${a.planSlug}`.localeCompare(`${b.workspaceId}/${b.harnessSlug}/${b.planSlug}`));
  writeFileSync(outPath, JSON.stringify({ takenAt: new Date().toISOString(), count: out.length, snapshots: out }, null, 1));
  const satisfied = out.filter((s) => s.satisfied === true).length;
  const errors = out.filter((s) => s.error).length;
  // A re-evaluating census must never see the post-ship skip; if it does, it measured nothing.
  const skippedShipped = out.filter((s) => s.skipped === 'already-shipped').length;
  console.log(
    `CENSUS_RESULT path=${outPath} plans=${out.length} satisfied=${satisfied} errors=${errors} ` +
    `skippedAlreadyShipped=${skippedShipped} seconds=${Math.round((Date.now() - started) / 1000)}`,
  );
  if (skippedShipped > 0) process.exitCode = 3;
}

async function main(): Promise<void> {
  const censusPath = flag('--census');
  if (censusPath) return census(censusPath);

  const diffIdx = args.indexOf('--diff');
  if (diffIdx >= 0) {
    const read = (p: string) => (JSON.parse(readFileSync(p, 'utf8')) as { snapshots: ShipVerdictSnapshot[] }).snapshots;
    const diff = diffShipVerdicts(read(args[diffIdx + 1]), read(args[diffIdx + 2]));
    console.log(JSON.stringify({ ...diff, changed: diff.changed.slice(0, 50) }, null, 1));
    console.log(`DIFF_RESULT compared=${diff.compared} unchanged=${diff.unchanged} changed=${diff.changed.length} onlyBefore=${diff.onlyBefore.length} onlyAfter=${diff.onlyAfter.length}`);
    return;
  }

  const execute = args.includes('--execute');
  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  try {
    const report = await backfillPlanVerificationProfiles(sql, { execute });
    const byStatus: Record<string, Record<string, number>> = {};
    for (const row of report.rows) {
      const status = row.status ?? '(none)';
      byStatus[status] ??= {};
      byStatus[status][row.profile] = (byStatus[status][row.profile] ?? 0) + 1;
    }
    console.log(JSON.stringify({ byProfile: report.byProfile, byBasis: report.byBasis, byStatus }, null, 1));
    console.log(`BACKFILL_RESULT executed=${report.executed} candidates=${report.candidates} updated=${report.updated}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
