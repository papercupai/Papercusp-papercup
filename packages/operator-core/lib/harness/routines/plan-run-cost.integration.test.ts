/**
 * Run-level cost attribution + cost-breach auto-pause (P-013 / D-018) against a REAL
 * migrated Postgres: a scheduled run's spend is summed across its work_items' spawns'
 * usage samples; a run over the per-plan costCapCents auto-disarms the schedule.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/plan-run-cost.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-013 / D-018).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { computeRunCostCents, autoPauseOnCostBreach } from './plan-run-cost';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-cost';
// Retired aliases (papercup/papercup-hive) are rewritten by migration 656.
// Keep every fixture relation in one isolated, non-alias harness namespace.
const HARNESS = 'plan-run-cost-it';
const SLUG = 'pricey-monitor';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_usage_samples WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.spawned_agents WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
});

/** Seed a template (armed, with an optional cap), a run, a work_item, a spawn, and N usage samples. */
async function seedRun(opts: { capCents?: number; scheduleActive?: boolean; sampleCostsUsd: number[] }): Promise<number> {
  const schedule = { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z', ...(opts.capCents != null ? { costCapCents: opts.capCents } : {}) };
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, schedule, schedule_active)
    VALUES (${WS}, ${HARNESS}, ${SLUG}, 'Pricey', 'active', '# Pricey', 'h',
            ${JSON.stringify(schedule)}::text::jsonb, ${opts.scheduleActive ?? true})
  `;
  const [template] = await sql<Array<{ schedule_active: boolean }>>`
    SELECT schedule_active FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  expect(template, 'the migrated database must preserve the fixture harness scope')
    .toEqual({ schedule_active: opts.scheduleActive ?? true });
  const runRows = await sql<Array<{ id: number }>>`
    INSERT INTO harness_shared.plan_runs
      (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at, status, run_type, updated_at)
    VALUES (${HARNESS}, ${SLUG}, 'h', 's1', 'system:plan-run', 1000, 'running', 'scheduled', 1000)
    RETURNING id`;
  const runId = Number(runRows[0].id);

  const featureId = `PR-${runId}-1`;
  const payload = JSON.stringify({ plan_run: { runId, runSeq: 0, instancePlanSlug: `${SLUG}@run-${runId}`, templateSlug: SLUG } });
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, status, attempts, item_kind, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts, source_plan_slug)
    VALUES (${HARNESS}, ${featureId}, 'item 1', 'passed', 0, 'feature', ${payload}::text::jsonb, FALSE, ${WS}, 1000, 1000, 1000, ${SLUG})
  `;
  const spawnRunId = `spawn-${runId}`;
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id, status, feature_id)
    VALUES (${'sp-' + runId}, ${WS}, ${HARNESS}, 'mug', 'worker', ${spawnRunId}, 'done', ${featureId})
  `;
  for (let i = 0; i < opts.sampleCostsUsd.length; i++) {
    await sql`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, harness_slug, run_id, ts, bucket_key, provider, model_class, source, cost_usd)
      VALUES (${WS}, ${HARNESS}, ${spawnRunId}, ${2000 + i}, ${'b' + i}, 'anthropic', 'opus', 'spawn', ${opts.sampleCostsUsd[i]})
    `;
  }
  return runId;
}

async function active(): Promise<boolean> {
  const r = await sql<{ schedule_active: boolean }[]>`
    SELECT schedule_active FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  return r[0]?.schedule_active ?? false;
}

describe('computeRunCostCents', () => {
  it('SUMs cost_usd across the run work-items spawns usage samples (→ cents)', async () => {
    const runId = await seedRun({ sampleCostsUsd: [0.5, 0.25, 0.1] }); // $0.85 → 85¢
    const cents = await computeRunCostCents({ sql, harnessSlug: HARNESS, runId });
    expect(cents).toBe(85);
  });

  it('returns 0 when nothing was priced', async () => {
    const runId = await seedRun({ sampleCostsUsd: [] });
    expect(await computeRunCostCents({ sql, harnessSlug: HARNESS, runId })).toBe(0);
  });
});

describe('autoPauseOnCostBreach', () => {
  it('disarms the schedule when a run breaches the cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runId = await seedRun({ capCents: 50, sampleCostsUsd: [0.4, 0.4] }); // 80¢ > 50¢
    const r = await autoPauseOnCostBreach({ sql, harnessSlug: HARNESS, planSlug: SLUG, runId });
    expect(r.paused).toBe(true);
    expect(r.costCents).toBe(80);
    expect(r.capCents).toBe(50);
    expect(await active()).toBe(false); // disarmed
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does NOT pause a run under the cap', async () => {
    const runId = await seedRun({ capCents: 100, sampleCostsUsd: [0.3] }); // 30¢ ≤ 100¢
    const r = await autoPauseOnCostBreach({ sql, harnessSlug: HARNESS, planSlug: SLUG, runId });
    expect(r.paused).toBe(false);
    expect(await active()).toBe(true);
  });

  it('does NOT pause when no cap is set', async () => {
    const runId = await seedRun({ sampleCostsUsd: [5.0] }); // expensive but uncapped
    const r = await autoPauseOnCostBreach({ sql, harnessSlug: HARNESS, planSlug: SLUG, runId });
    expect(r.paused).toBe(false);
    expect(r.capCents).toBe(null);
    expect(await active()).toBe(true);
  });

  it('does NOT pause an already-disarmed template', async () => {
    const runId = await seedRun({ capCents: 10, scheduleActive: false, sampleCostsUsd: [1.0] });
    const r = await autoPauseOnCostBreach({ sql, harnessSlug: HARNESS, planSlug: SLUG, runId });
    expect(r.paused).toBe(false);
  });
});
