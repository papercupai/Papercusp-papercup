/**
 * Live-PG fake-validation of the P-014 A/B harness (`runAbEvaluation`) over the REAL gym
 * store (`createGymStore`): run 2 variants × 1 task × 2 repeats with a FAKE pipeline +
 * FAKE collect + FAKE judge, but write/read a real gym PG. Proves the harness + store
 * adapter + real `compareVariants` compose end-to-end — no operator, no real agents, no
 * LLM (the slow real pipeline + real Opus judge are exercised on capacity, per the run plan).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyGymSchema } from '../schema';
import { buildAbDeps, createGymStore } from '../ab-runner-real';
import { loadHarnessPipelineSpend } from '../../harness-insights/load-spend';
import type { GymRunnerPorts } from '../gym-runner';
import { runAbEvaluation, type AbConfig, type AbDeps } from '../ab-runner';
import { GYM_JUDGE_RUBRIC_V1, rubricHash } from '../judge-scoring';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `gymab_${randomBytes(5).toString('hex')}`;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

beforeAll(async () => {
  containerUri = await getTestPg();
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`CREATE DATABASE "${dbName}"`); await markManagedTestDatabase(maint, dbName); } finally { await maint.end({ timeout: 5 }); }
  const u = new URL(containerUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {}, prepare: false });
  await applyGymSchema(sql);
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`CREATE TABLE harness_shared.harness_run_output (
    workspace_id text, harness_slug text, run_id text,
    PRIMARY KEY (workspace_id, harness_slug, run_id))`;
  await sql`CREATE TABLE harness_shared.agent_usage_samples (
    id bigserial PRIMARY KEY, workspace_id text, harness_slug text, run_id text,
    source text, cost_usd numeric, cost_source text, usage_provenance jsonb)`;
  await sql`CREATE TABLE harness_shared.agent_runs_consolidated (
    workspace_id text, harness_slug text, run_id text, cost_usd numeric)`;
});

describe('native Gym canonical pipeline usage (private PG, controlled ports)', () => {
  async function pipeline(costs: Array<{ run: string; usd: number | null; source: string | null }>, missingRun?: string) {
    let slug = '';
    const ports: GymRunnerPorts = {
      cloneSubstrate: async () => {}, registerThrowawayHarness: async (i) => { slug = i.slug; },
      applyPromptOverride: async () => {}, fileFeature: async () => {},
      startPipeline: async () => ({ workflowID: 'controlled-native-workflow' }),
      pollStatus: async () => ({ workflowStatus: 'SUCCESS', featureStatus: 'completed' }),
      teardownHarness: async () => {}, now: () => 0, sleep: async () => {},
    };
    const originalStart = ports.startPipeline;
    ports.startPipeline = async (i) => {
      for (const run of new Set([...costs.map((c) => c.run), ...(missingRun ? [missingRun] : [])])) {
        await sql`INSERT INTO harness_shared.harness_run_output VALUES ('gym-ws', ${slug}, ${run})`;
      }
      for (const c of costs) await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, harness_slug, run_id, source, cost_usd, cost_source, usage_provenance)
        VALUES ('gym-ws', ${slug}, ${c.run}, 'jsonl', ${c.usd}, ${c.source}, ${sql.json({ backend: 'codex', costBound: c.source === 'estimated' ? 'lower' : null })})`;
      // Cross-workspace / harness / capture-point values must not inflate this attempt.
      for (const [ws, harness, source] of [['other-ws', slug, 'jsonl'], ['gym-ws', 'other-harness', 'jsonl'], ['gym-ws', slug, 'headers']]) {
        await sql`INSERT INTO harness_shared.agent_usage_samples
          (workspace_id, harness_slug, run_id, source, cost_usd, cost_source)
          VALUES (${ws}, ${harness}, 'decoy', ${source}, 900, 'provider')`;
      }
      return originalStart(i);
    };
    const deps = buildAbDeps({ gymSql: sql, ports, llmCall: async () => { throw new Error('no paid judge'); },
      timeoutMs: 100, pollIntervalMs: 1, scratchRoot: '/tmp/gym-controlled-scratch', traceRoot: '/tmp/gym-controlled-retained' });
    const handle = await deps.runPipeline({ variant: cfg().variants[0],
      task: { ...cfg().tasks[0], taskId: randomBytes(5).toString('hex') }, repeat: 0, cycle: 0,
      harnessCommit: COMMIT, workspaceId: 'gym-ws', scratchRoot: '/tmp/gym-controlled-scratch' });
    return handle;
  }

  it('reads PG-only costs with no filesystem mirror rows and retains estimate provenance', async () => {
    const handle = await pipeline([{ run: 'worker', usd: 0.4, source: 'provider' },
      { run: 'validator', usd: 0.2, source: 'estimated' }]);
    const old = await sql`SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd
      FROM harness_shared.agent_runs_consolidated WHERE workspace_id = 'gym-ws' AND harness_slug = ${handle.harnessSlug}`;
    expect(old[0].usd).toBe(0);
    expect(handle.pipelineUsd).toBeCloseTo(0.6);
    expect(handle.pipelineSpend).toMatchObject({ complete: true, measured: false, providerUsd: 0.4, estimatedUsd: 0.2 });
    expect(handle.pipelineSpend?.samples.find((s) => s.costSource === 'estimated')?.provenance)
      .toMatchObject({ costBound: 'lower', backend: 'codex' });
    await sql`INSERT INTO harness_shared.agent_runs_consolidated VALUES ('gym-ws', ${handle.harnessSlug}, 'worker', 700)`;
    const out = await loadHarnessPipelineSpend({ workspace_id: 'gym-ws', harness_slug: handle.harnessSlug,
      runQuery: async <T>(q: string, p: unknown[]) => await sql.unsafe(q, p as never[]) as unknown as T[] });
    expect(out.knownUsd).toBeCloseTo(0.6);
  });

  it('preserves measured zero separately from no evidence and missing archived-run usage', async () => {
    expect((await pipeline([{ run: 'worker', usd: 0, source: 'provider' }])).pipelineSpend)
      .toMatchObject({ knownUsd: 0, complete: true, measured: true });
    expect((await pipeline([])).pipelineSpend).toMatchObject({ knownUsd: 0, complete: false, measured: false });
    expect((await pipeline([{ run: 'worker', usd: 0.3, source: 'provider' }], 'validator')).pipelineSpend)
      .toMatchObject({ knownUsd: 0.3, complete: false, measured: false, missingRunIds: ['validator'] });
  });

  it('does not call nullable native usage a zero-cost run', async () => {
    const handle = await pipeline([{ run: 'worker', usd: null, source: null }]);
    expect(handle.pipelineSpend).toMatchObject({ complete: false, measured: false, missingRunIds: ['worker'],
      samples: [{ runId: 'worker', costUsd: null, costSource: null }] });
  });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

function cfg(): AbConfig {
  return {
    variants: [
      { variantId: 'baseline', label: 'baseline', overlay: { promptOverrides: {} } },
      { variantId: 'cand-1', label: 'candidate', overlay: { promptOverrides: { worker: '# w2' } } },
    ],
    tasks: [{ taskId: 'task-a', pool: 'train', repoUrl: '/repos/sub', repoCommit: COMMIT, spec: 'Add /health', intent: 'liveness', projectContext: 'a Hono API', corpus: 'real' }],
    repeats: 2,
    rubric: GYM_JUDGE_RUBRIC_V1,
    harnessCommit: COMMIT,
    workspaceId: 'gym-ws',
    scratchRoot: '/scratch/gym',
    deriveOpts: { sigmaMultiple: 2, targetStandardError: 0.25 },
    maxDistillChars: 60_000,
  };
}

/** Deps with the REAL gym store but fake pipeline/collect/judge — composites scripted per call. */
function deps(composites: number[]): AbDeps {
  let i = 0;
  return {
    store: createGymStore(sql),
    async runPipeline(input) {
      const slug = `gym${input.variant.variantId}${input.task.taskId}r${input.repeat}`.replace(/[^a-z0-9]/g, '');
      return { harnessSlug: slug, clonePath: `/c/${slug}`, workflowID: `wf:${slug}`, outcome: 'passed', pipelineUsd: 0.4 };
    },
    async collectAndDistill() {
      return { distilledTrace: '## Diff\n+health()', traceRef: '/t/x.json', rawSignals: { ok: true } };
    },
    llmCall: async () => {
      const c = composites[Math.min(i++, composites.length - 1)];
      return { text: JSON.stringify({ d1: c, d2: c, d3: c, rationale: 'fake' }), costUsd: 2.5, inputTokens: 10, outputTokens: 20 };
    },
    newRunId: (v, t, r) => `${v}::${t}::r${r}`,
    now: () => 0,
  };
}

describe('runAbEvaluation over the real gym store (live PG)', () => {
  it('writes variants/tasks/runs/scores and reads back the A-vs-B comparison + variance', async () => {
    // baseline repeats → 6,8 (mean 7, sd 1); cand-1 repeats → 9,9 (mean 9, sd 0).
    const res = await runAbEvaluation(cfg(), deps([6, 8, 9, 9]));

    // 2 variants × 1 task × 2 repeats = 4 runs/scores persisted in the real gym PG.
    expect(res.outcomes).toHaveLength(4);
    const runCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_gym.gym_runs`;
    expect(runCount[0].n).toBe(4);
    const scoreCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_gym.gym_scores`;
    expect(scoreCount[0].n).toBe(4);
    const params = await sql`SELECT * FROM harness_gym.gym_runs_params ORDER BY run_id`;
    expect(params).toHaveLength(4);
    expect(params.map((p) => p.run_id).sort()).toEqual(res.outcomes.map((r) => r.runId).sort());
    for (const p of params) {
      expect(p).toMatchObject({ harness_commit: COMMIT, substrate_commit: COMMIT,
        judge_model: GYM_JUDGE_RUBRIC_V1.model, judge_temp: GYM_JUDGE_RUBRIC_V1.temperature,
        weights: GYM_JUDGE_RUBRIC_V1.weights, rubric_hash: rubricHash(GYM_JUDGE_RUBRIC_V1), mutable_roles: null });
    }
    const variantCount = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_gym.gym_variants`;
    expect(variantCount[0].n).toBe(2);
    const taskCorpus = await sql<{ corpus: string }[]>`
      SELECT corpus FROM harness_gym.gym_tasks WHERE task_id = 'task-a'`;
    expect(taskCorpus[0].corpus).toBe('real');

    // Comparison comes from the REAL compareVariants over the real PG (max composite per variant×task).
    expect(res.comparison).toEqual([{ taskId: 'task-a', aComposite: 8, bComposite: 9, delta: 1 }]);

    // Variance derived from the persisted composites.
    const base = res.perTaskVariance.find((v) => v.variantId === 'baseline')!;
    expect(base.mean).toBeCloseTo(7);
    expect(base.sd).toBeCloseTo(1);
    expect(base.minRepeats).toBe(16); // ceil((1/0.25)^2)
    const cand = res.perTaskVariance.find((v) => v.variantId === 'cand-1')!;
    expect(cand.sd).toBeCloseTo(0);

    // Cost: 4 × (0.4 pipeline + 2.5 judge) = 11.6.
    expect(res.cost.totalUsd).toBeCloseTo(11.6);
  });

  it('keeps unknown parameters absent for callers that did not provide them', async () => {
    const store = createGymStore(sql);
    await store.startRun({ runId: 'unknown-params', variantId: 'baseline', taskId: 'task-a',
      cycle: 1, repeat: 0, harnessSlug: 'controlled', workflowId: 'controlled' });
    const rows = await sql`SELECT * FROM harness_gym.gym_runs_params WHERE run_id = 'unknown-params'`;
    expect(rows).toEqual([]);
  });
});
