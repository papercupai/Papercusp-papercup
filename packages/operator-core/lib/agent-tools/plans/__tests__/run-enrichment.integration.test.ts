/**
 * Enriched plans:runs data layer (P-022/P-023): per-run outcome/duration/work-item
 * rollup/cost from listPlanRuns (against a real migrated Postgres), and the pure
 * computePlanRunRollup aggregate.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/run-enrichment.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-022 / P-023).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';

let org: OrgTestDb;

// runs.ts routes its reads through withWorkspace — point it at the admin test client.
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: (_ws: string, cb: (tx: unknown) => unknown) => cb(org.adminSql),
}));

// listPlanRuns filters `WHERE r.workspace_id = activeWorkspaceId()` (F-B3
// workspace-data-isolation). activeWorkspaceId() is process-GLOBAL (request-ALS →
// PAPERCUSP_WORKSPACE_ID → registry default), uncontrolled here — and the seeded
// plan_runs.workspace_id (set to WS below) must equal it or the read returns []
// intermittently. Pin the active workspace to the seed workspace.
vi.mock('../../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'ws-x' };
});

// Import AFTER the mock is declared (vi.mock is hoisted).
const { listPlanRuns, computePlanRunRollup } = await import('../runs');
type PlanRunSummary = Awaited<ReturnType<typeof listPlanRuns>>[number];

const HARNESS = 'test-run-enrichment';
const TEMPLATE = 'test-tmpl-runs';

beforeAll(async () => {
  org = await createOrgTestDb();
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = 'ws-x'`;
  await org.adminSql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = 'ws-x'`;
  await org.adminSql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = 'ws-x'`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = 'ws-x'`;
  await org.adminSql`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`;
  await org.adminSql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS}`;
  await org.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES ('ws-x', ${HARNESS}, ${TEMPLATE}, 'Run visibility fixture', 'ready',
            '# Run visibility fixture', 'run-visibility-v1', '[]'::jsonb)
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING`;
});

async function seedRun(opts: { outcome: 'success' | 'partial' | 'failed'; launchedAt: number; durationMs: number }): Promise<number> {
  const sql = org.adminSql;
  const rows = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.plan_runs
      (workspace_id, harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, run_seq, outcome, finished_at, instance_plan_slug)
    VALUES ('ws-x', ${HARNESS}, ${TEMPLATE}, 'h', ${'s' + opts.launchedAt}, 'system:plan-run', ${opts.launchedAt},
            ${opts.outcome === 'failed' ? 'failed' : 'done'}, 'r', ${opts.launchedAt}, 'scheduled', 'scheduled', 0,
            ${opts.outcome}, ${opts.launchedAt + opts.durationMs}, ${TEMPLATE + '@run-' + opts.launchedAt})
    RETURNING id`;
  return Number(rows[0].id);
}
async function seedWi(runId: number, status: string): Promise<void> {
  const sql = org.adminSql;
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_features_consolidated
       (harness_slug, feature_id, title, status, attempts, item_kind, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts)
     VALUES ($1,$2,'wi',$3,0,'feature',$4::text::jsonb,FALSE,'ws-x',$5,$5,$5)`,
    [HARNESS, `PR-${runId}-${status}-${Math.random()}`, status, JSON.stringify({ plan_run: { runId } }), now],
  );
}

describe('listPlanRuns enrichment (P-022)', () => {
  it('returns outcome, duration, run_type/trigger, and a work-item rollup per run', async () => {
    const id = await seedRun({ outcome: 'partial', launchedAt: 1_780_000_000_000, durationMs: 5000 });
    await seedWi(id, 'passed');
    await seedWi(id, 'failed');
    await seedWi(id, 'todo'); // open

    const runs = await listPlanRuns(TEMPLATE, { harnessSlug: HARNESS });
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.runType).toBe('scheduled');
    expect(r.trigger).toBe('scheduled');
    expect(r.outcome).toBe('partial');
    expect(r.durationMs).toBe(5000);
    expect(r.instancePlanSlug).toBe(`${TEMPLATE}@run-1780000000000`);
    expect(r.workItems).toEqual({ total: 3, passed: 1, failed: 1, open: 1 });
  });

  it('orders newest-first', async () => {
    await seedRun({ outcome: 'success', launchedAt: 1_780_000_000_000, durationMs: 1000 });
    await seedRun({ outcome: 'failed', launchedAt: 1_780_000_100_000, durationMs: 1000 });
    const runs = await listPlanRuns(TEMPLATE, { harnessSlug: HARNESS });
    expect(runs.map((r) => r.outcome)).toEqual(['failed', 'success']);
  });

  it('folds external-trigger provenance onto the existing plan-run row', async () => {
    const id = await seedRun({ outcome: 'success', launchedAt: 1_780_000_000_000, durationMs: 5000 });
    const sources = await org.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.data_sources (workspace_id, kind, status, config)
      VALUES ('ws-x', 'slack', 'connected', '{"teamId":"T1"}'::jsonb)
      RETURNING id`;
    const bindings = await org.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES ('ws-x', ${sources[0].id}, ${HARNESS}, ${TEMPLATE}, 'ext:slack:mention',
              '{"channelType":"public_channel"}'::jsonb, '{"type":"launch-plan"}'::jsonb,
              TRUE, '{"maxRuns":3,"windowSeconds":60}'::jsonb)
      RETURNING id`;
    await org.adminSql`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, dedupe_key, status, args, outcome, attempts,
         plan_run_ref, started_at, completed_at)
      VALUES ('ws-x', ${bindings[0].id}, 'slack:message-1', 'succeeded',
              ${JSON.stringify({ trigger: { payload: { text: 'Ship the release', channelId: 'C1' } } })}::text::jsonb,
              ${JSON.stringify({ gmailDraft: { draftId: 'draft-1', subject: 'Re: Ship the release' } })}::text::jsonb,
              1, ${String(id)}, now(), now())`;

    const run = (await listPlanRuns(TEMPLATE, { harnessSlug: HARNESS }))[0]!;
    expect(run.triggerRun).toMatchObject({
      sourceKind: 'slack',
      eventPattern: 'ext:slack:mention',
      causeSummary: 'Ship the release',
      policyDisposition: 'ran',
      planRun: { id, status: 'done', durationMs: 5000 },
    });
    expect(run.triggerRun?.outcomeLinks).toEqual([
      {
        kind: 'gmail-draft',
        label: 'Re: Ship the release',
        href: 'https://mail.google.com/mail/u/0/#drafts/draft-1',
      },
    ]);
  });
});

describe('computePlanRunRollup (P-023, pure)', () => {
  const mk = (over: Partial<PlanRunSummary>): PlanRunSummary =>
    ({
      id: 1, planSlug: TEMPLATE, planContentHash: 'h', sessionId: 's', note: null,
      launchedBy: 'x', launchedAt: 0, status: 'done', title: null, updatedAt: 0,
      runType: 'scheduled', trigger: 'scheduled', outcome: 'success', finishedAt: 0,
      runSeq: 0, instancePlanSlug: null, durationMs: 100, turnCount: 0,
      workItems: { total: 0, passed: 0, failed: 0, open: 0 }, costUsd: 0,
      triggerRun: null,
      ...over,
    }) as PlanRunSummary;

  it('computes success rate over settled runs + duration stats + regression flags', () => {
    const runs = [
      mk({ id: 3, outcome: 'failed', status: 'failed', durationMs: 1000, costUsd: 0.5 }), // newest
      mk({ id: 2, outcome: 'success', durationMs: 100, costUsd: 0.2 }),
      mk({ id: 1, outcome: 'success', durationMs: 100, costUsd: 0.3 }),
    ];
    const r = computePlanRunRollup(runs);
    expect(r.total).toBe(3);
    expect(r.success).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.successRate).toBeCloseTo(2 / 3);
    expect(r.medianDurationMs).toBe(100); // sorted [100,100,1000], middle element = 100
    expect(r.totalCostUsd).toBeCloseTo(1.0);
    expect(r.lastOutcome).toBe('failed');
    expect(r.regression.lastFailed).toBe(true);
  });

  it('successRate is 0 when nothing has settled', () => {
    const r = computePlanRunRollup([mk({ outcome: null, status: 'running', durationMs: null })]);
    expect(r.running).toBe(1);
    expect(r.successRate).toBe(0);
    expect(r.medianDurationMs).toBeNull();
  });
});
