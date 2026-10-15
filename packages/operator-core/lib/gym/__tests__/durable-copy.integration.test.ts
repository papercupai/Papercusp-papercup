/**
 * Live-PG test for the durable run-analytics copy (plan
 * gym-repoint-live-coding-and-visible-runs-2026-07-20 P-011/P-013).
 *
 * Applies migration 650 (the live-DB harness_gym read-cache) to a `dst` DB and the ephemeral
 * gym schema to a `src` DB, writes a cycle's analytics into `src`, copies them across with
 * copyRunAnalyticsToDurable, and reads them back through the durable, (workspace,harness)-
 * scoped readers. Also proves the composite keys let two gym harnesses share the tables
 * without id collisions (both use variant_id 'baseline', task_id 'gym-train', cycle_id 'c0').
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyGymSchema } from '../schema';
import {
  insertVariant,
  insertTask,
  insertRun,
  insertRunParams,
  finishRun,
  insertScore,
  insertCycle,
  copyRunAnalyticsToDurable,
  compareDurableVariants,
} from '../store';
import { readDurableCycleHistory, readDurableVariants, durableFrontierView } from '../read-api';
import type { GymScore } from '../judge';
import { buildAbDeps, createGymStore, type RealAbDepsConfig } from '../ab-runner-real';
import { readTraceBundle } from '../collector';
import { buildLoopDeps } from '../loop-deps';
import type { AbDeps } from '../ab-runner';
import { GYM_JUDGE_RUBRIC_V1, rubricHash } from '../judge-scoring';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_650 = join(__dirname, '../../../../../libs/papercusp/libs/db/sql/650-harness-gym-durable-run-analytics.sql');
const MIGRATION_1012 = join(__dirname, '../../../../../libs/papercusp/libs/db/sql/1012-gym-durable-active-task-generation.sql');
const RUN_EVIDENCE_MIGRATION = join(__dirname, '../../../../../libs/papercusp/libs/db/sql/1358-gym-durable-run-evidence.sql');

const decode = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;

let src: postgres.Sql;
let dst: postgres.Sql;
let containerUri: string;
const srcDb = `gymsrc_${randomBytes(5).toString('hex')}`;
const dstDb = `gymdst_${randomBytes(5).toString('hex')}`;

const RH = 'rh-durable';
const score = (composite: number): GymScore => ({
  d1: composite, d2: composite, d3: composite, composite, rationale: 'r',
  judgeModel: 'claude-opus-4-8', rubricHash: RH, judgeTemp: 0, weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  costUsd: 0.5, inputTokens: 100, outputTokens: 50,
});

/** Seed one cycle's analytics (baseline + one candidate over a train task) into `src`. */
async function seedCycle(sql: postgres.Sql): Promise<void> {
  await insertVariant(sql, { variantId: 'baseline', label: 'baseline', overlay: { promptOverrides: {} } });
  await insertVariant(sql, { variantId: 'cand-c0', parentId: 'baseline', label: 'cand-c0', overlay: { promptOverrides: { worker: '# Worker\nRe-read the spec.' } }, proposerRationale: 'targets the gap' });
  await insertTask(sql, { taskId: 'gym-train', pool: 'train', repoUrl: '/r', repoCommit: 'abc1234', spec: 's', intent: 'i' });
  for (const [variantId, composite] of [['baseline', 5], ['cand-c0', 8]] as const) {
    const runId = `${variantId}::gym-train::c0::r0`;
    await insertRun(sql, { runId, variantId, taskId: 'gym-train', cycle: 0, harnessSlug: 'throwaway' });
    await finishRun(sql, runId, { terminalState: 'passed', deterministicSignals: { regressions: false }, elapsedMs: 100 });
    await insertScore(sql, runId, score(composite));
  }
  await insertCycle(sql, { cycleId: 'c0', cycle: 0, parentId: 'baseline', candidateId: 'cand-c0', decision: 'accept', gateResults: { passed: true } });
}

beforeAll(async () => {
  containerUri = await getTestPg();
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`CREATE DATABASE "${srcDb}"`);
    await markManagedTestDatabase(maint, srcDb);
    await maint.unsafe(`CREATE DATABASE "${dstDb}"`);
    await markManagedTestDatabase(maint, dstDb);
  } finally { await maint.end({ timeout: 5 }); }

  const srcUrl = new URL(containerUri); srcUrl.pathname = `/${srcDb}`;
  const dstUrl = new URL(containerUri); dstUrl.pathname = `/${dstDb}`;
  src = postgres(srcUrl.toString(), { max: 2, onnotice: () => {}, prepare: false });
  dst = postgres(dstUrl.toString(), { max: 2, onnotice: () => {}, prepare: false });

  // A multi-statement migration via applyGymSchema / .unsafe() trips postgres-js's
  // UNSAFE_TRANSACTION guard on a pooled (max>1) connection, so apply BOTH schemas on
  // dedicated max:1 connections; the max:2 src/dst pools then serve the parallel copy + reads.
  const srcMig = postgres(srcUrl.toString(), { max: 1, onnotice: () => {}, prepare: false });
  try { await applyGymSchema(srcMig); } finally { await srcMig.end({ timeout: 5 }); }

  // The migration GRANTs to harness_app / harness_zero — create them so the real migration
  // applies verbatim (the test role owns the tables and bypasses the RLS it enables).
  const mig = postgres(dstUrl.toString(), { max: 1, onnotice: () => {}, prepare: false });
  try {
    await mig.unsafe(`DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await mig.unsafe(`DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    // .simple(): the migration is a multi-statement DDL batch — the simple query protocol runs
    // them as one batch (the extended protocol postgres-js defaults to allows only one).
    await mig.unsafe(readFileSync(MIGRATION_650, 'utf8')).simple();
    // Migration 684 added harness_gym_durable.gym_tasks.corpus, which
    // copyRunAnalyticsToDurable now writes unconditionally — but 684's OTHER
    // statement (harness_shared.gym_proposals.task_corpus) targets a table this
    // test's minimal dst schema never creates (only 650 is applied here, not the
    // full migration chain). Apply just the gym_tasks half directly rather than
    // replaying 684 verbatim, so this test's schema matches what store.ts writes
    // without pulling in the unrelated harness_shared dependency.
    await mig.unsafe(`
      ALTER TABLE harness_gym_durable.gym_tasks
        ADD COLUMN IF NOT EXISTS corpus text NOT NULL DEFAULT 'synthetic';
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'gym_tasks_corpus_check'
             AND conrelid = 'harness_gym_durable.gym_tasks'::regclass
        ) THEN
          ALTER TABLE harness_gym_durable.gym_tasks
            ADD CONSTRAINT gym_tasks_corpus_check CHECK (corpus IN ('synthetic', 'real'));
        END IF;
      END $$;
    `);
    await mig.unsafe(readFileSync(MIGRATION_1012, 'utf8')).simple();
    const evidenceMigration = readFileSync(existsSync(RUN_EVIDENCE_MIGRATION)
      ? RUN_EVIDENCE_MIGRATION : `${RUN_EVIDENCE_MIGRATION}.DRAFT`, 'utf8');
    await mig.unsafe(evidenceMigration).simple();
    // The additive migration must also be safe on an already-upgraded schema.
    await mig.unsafe(evidenceMigration).simple();
  } finally { await mig.end({ timeout: 5 }); }
});

afterAll(async () => {
  if (src) await src.end({ timeout: 5 });
  if (dst) await dst.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`DROP DATABASE IF EXISTS "${srcDb}" WITH (FORCE)`);
    await maint.unsafe(`DROP DATABASE IF EXISTS "${dstDb}" WITH (FORCE)`);
  } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('durable run-analytics copy (migration 650)', () => {
  it('copies a cycle from the ephemeral gym PG into the durable read-cache and reads it back scoped', async () => {
    await seedCycle(src);
    const copied = await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'ws1', harnessSlug: 'h1' });
    expect(copied).toEqual({ tasks: 1, variants: 2, runs: 2, scores: 2, cycles: 1 });

    const scope = { workspaceId: 'ws1', harnessSlug: 'h1' };
    const cycles = await readDurableCycleHistory(dst, scope);
    expect(cycles).toEqual([{ cycle: 0, parentId: 'baseline', candidateId: 'cand-c0', decision: 'accept' }]);

    const variants = await readDurableVariants(dst, scope);
    expect(variants.map((v) => v.variantId).sort()).toEqual(['baseline', 'cand-c0']);
    const cand = variants.find((v) => v.variantId === 'cand-c0')!;
    expect(cand.parentId).toBe('baseline');
    expect(cand.rationale).toBe('targets the gap');

    // jsonb round-trips (not double-encoded): the candidate's worker overlay is a real object.
    const [ov] = await dst<{ worker: string | null }[]>`
      SELECT prompt_overrides->>'worker' AS worker
        FROM harness_gym_durable.gym_variants
       WHERE workspace_id = 'ws1' AND harness_slug = 'h1' AND variant_id = 'cand-c0'`;
    expect(ov.worker).toContain('Re-read the spec.');

    // Frontier over the train vectors: cand-c0 (8) dominates baseline (5) on the single task.
    const frontier = await durableFrontierView(dst, scope, RH);
    expect(frontier).toContain('cand-c0');

    // Compare A-vs-B: the signed per-task delta (B − A).
    const cmp = await compareDurableVariants(dst, scope, 'baseline', 'cand-c0', RH);
    expect(cmp).toEqual([{ taskId: 'gym-train', aComposite: 5, bComposite: 8, delta: 3 }]);
  });

  it('is idempotent and (workspace,harness)-scoped — two harnesses share ids without collision', async () => {
    // Same src ids copied under a DIFFERENT harness must not collide (composite PKs) and must
    // stay isolated from h1's rows.
    const copied2 = await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'ws1', harnessSlug: 'h2' });
    expect(copied2.cycles).toBe(1);

    // Re-copy h1 (idempotent upsert) — still exactly one cycle, not duplicated.
    await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'ws1', harnessSlug: 'h1' });

    const h1 = await readDurableCycleHistory(dst, { workspaceId: 'ws1', harnessSlug: 'h1' });
    const h2 = await readDurableCycleHistory(dst, { workspaceId: 'ws1', harnessSlug: 'h2' });
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(1);

    // A different workspace sees nothing.
    const other = await readDurableCycleHistory(dst, { workspaceId: 'ws-other', harnessSlug: 'h1' });
    expect(other).toHaveLength(0);

    // The frontier for h1 is unaffected by h2's identical rows.
    const frontier = await durableFrontierView(dst, { workspaceId: 'ws1', harnessSlug: 'h1' }, RH);
    expect(frontier).toContain('cand-c0');
  });

  it('keeps old task history but activates only the newest copied corpus', async () => {
    await dst`
      INSERT INTO harness_gym_durable.gym_tasks
        (workspace_id, harness_slug, task_id, pool, corpus, active)
      VALUES ('ws1', 'h3', 'legacy-synthetic', 'train', 'synthetic', true)`;

    await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'ws1', harnessSlug: 'h3' });

    const rows = await dst<{ task_id: string; corpus: string; active: boolean }[]>`
      SELECT task_id, corpus, active
        FROM harness_gym_durable.gym_tasks
       WHERE workspace_id = 'ws1' AND harness_slug = 'h3'
       ORDER BY task_id`;
    expect(rows).toEqual([
      { task_id: 'gym-train', corpus: 'synthetic', active: true },
      { task_id: 'legacy-synthetic', corpus: 'synthetic', active: false },
    ]);
  });

  it('retains actual oracle signals and recorded parameters after source rows are removed', async () => {
    const runId = 'baseline::gym-train::c0::r0';
    // Controlled source rows exercise retention; these are not a native acceptance verdict.
    const signals = { regressions: false, planted_bug_caught: true,
      oracle: { sourceRef: 'controlled-oracle', status: 'not-measured',
        pre: { results: [{ name: 'assertion', passed: false }], sourceHashes: { pinned: 'pre-pin' } },
        post: { results: [{ name: 'assertion', passed: true }], sourceHashes: { pinned: 'post-pin' } },
        unresolved: ['complete-runtime-identity'] } };
    await finishRun(src, runId, { terminalState: 'passed', deterministicSignals: signals,
      traceRef: '/removed-scratch/trace.json', distilledRef: '/removed-scratch/distilled.txt' });
    await insertRunParams(src, runId, { harnessCommit: 'declared-harness', substrateCommit: 'declared-substrate',
      mutableRoles: ['worker'], judgeModel: 'recorded-model', judgeTemp: 0,
      weights: { d1: 0.5, d2: 0.25, d3: 0.25 }, rubricHash: RH });
    const [originalRun] = await src`SELECT row_to_json(r) AS evidence FROM harness_gym.gym_runs r WHERE run_id = ${runId}`;
    const [originalParams] = await src`SELECT row_to_json(p) AS params FROM harness_gym.gym_runs_params p WHERE run_id = ${runId}`;
    expect(decode(originalRun.evidence).deterministic_signals).toEqual(signals);
    const readEvidence = () => dst`
      SELECT run_evidence,
             run_evidence->'deterministic_signals' AS deterministic_signals,
             run_evidence->>'trace_ref' AS trace_ref, run_evidence->>'distilled_ref' AS distilled_ref, run_params
        FROM harness_gym_durable.gym_runs
       WHERE workspace_id = 'evidence-ws' AND harness_slug = 'evidence-harness' AND run_id = ${runId}`;
    await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'evidence-ws', harnessSlug: 'evidence-harness' });
    const [retained] = await readEvidence();
    // Preserve the entire source row, including workflow/harness identity and future fields.
    expect(decode(retained.run_evidence)).toEqual(decode(originalRun.evidence));
    expect(decode(retained.deterministic_signals)).toEqual(signals);
    expect(retained.trace_ref).toBe('/removed-scratch/trace.json');
    expect(retained.distilled_ref).toBe('/removed-scratch/distilled.txt');
    expect(decode(retained.run_params)).toEqual(decode(originalParams.params));
    expect(decode(retained.run_params)).toMatchObject({ run_id: runId, harness_commit: 'declared-harness',
      substrate_commit: 'declared-substrate', mutable_roles: ['worker'], judge_model: 'recorded-model',
      judge_temp: 0, rubric_hash: RH });
    // Re-copy retains the same bytes, and missing params stay unknown on the sibling run.
    await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'evidence-ws', harnessSlug: 'evidence-harness' });
    expect((await readEvidence())[0]).toEqual(retained);
    const [unmeasured] = await dst`
      SELECT run_params FROM harness_gym_durable.gym_runs
       WHERE workspace_id = 'evidence-ws' AND harness_slug = 'evidence-harness' AND run_id = 'cand-c0::gym-train::c0::r0'`;
    expect(unmeasured.run_params).toBeNull();
    const [foreign] = await dst`
      SELECT run_evidence->'deterministic_signals' AS deterministic_signals, run_params FROM harness_gym_durable.gym_runs
       WHERE workspace_id = 'ws1' AND harness_slug = 'h1' AND run_id = ${runId}`;
    expect(decode(foreign.deterministic_signals)).toEqual({ regressions: false });
    expect(foreign.run_params).toBeNull();
    await src`DELETE FROM harness_gym.gym_runs WHERE run_id = ${runId}`;
    expect((await readEvidence())[0]).toEqual(retained);
  });

  it('resolves the real retained trace through its durable row after scratch and source cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gym-durable-trace-'));
    const scratchRoot = join(root, 'scratch');
    try {
      // This private-PG fixture exercises the real collector + store + copy.
      // No operator, agent, judge or external model is invoked.
      await src`CREATE SCHEMA IF NOT EXISTS harness_shared`;
      await src`CREATE TABLE IF NOT EXISTS harness_shared.harness_run_output
        (run_id TEXT, role TEXT, out_body TEXT, harness_slug TEXT, started_at TIMESTAMPTZ)`;
      await src`INSERT INTO harness_shared.harness_run_output
        VALUES ('retained-worker', 'worker', 'retained submission', 'trace-copy', now())`;
      const deps = buildAbDeps({ gymSql: src, ports: {} as RealAbDepsConfig['ports'],
        llmCall: async () => { throw new Error('judge must not run'); },
        timeoutMs: 1, pollIntervalMs: 1, scratchRoot, traceRoot: join(root, 'retained'),
        collectStrategy: 'work-item-output' });
      const collected = await deps.collectAndDistill({
        handle: { harnessSlug: 'trace-copy', clonePath: scratchRoot, workflowID: 'trace-copy',
          outcome: 'passed', pipelineUsd: 0, deterministicSignals: { regressions: false } },
        task: { taskId: 'trace-copy-task', pool: 'train', repoUrl: '', repoCommit: '',
          spec: 's', intent: 'i', projectContext: 'c' }, maxChars: 60000 });
      await deps.store.upsertVariant({ variantId: 'trace-copy', label: 'trace-copy', overlay: { promptOverrides: {} } });
      await deps.store.upsertTask({ taskId: 'trace-copy-task', pool: 'train', repoUrl: '', repoCommit: '', spec: 's', intent: 'i', projectContext: 'c' });
      await deps.store.startRun({ runId: 'retained-trace-run', variantId: 'trace-copy', taskId: 'trace-copy-task',
        cycle: 35, repeat: 0, harnessSlug: 'trace-copy', workflowId: 'trace-copy' });
      await deps.store.finishRun('retained-trace-run', { terminalState: 'passed',
        deterministicSignals: collected.rawSignals, traceRef: collected.traceRef });
      await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'trace-copy-ws', harnessSlug: 'trace-copy' });
      await src`DELETE FROM harness_gym.gym_runs WHERE run_id = 'retained-trace-run'`;
      rmSync(scratchRoot, { recursive: true, force: true });
      const [row] = await dst<{ trace_ref: string }[]>`
        SELECT run_evidence->>'trace_ref' AS trace_ref FROM harness_gym_durable.gym_runs
         WHERE workspace_id = 'trace-copy-ws' AND harness_slug = 'trace-copy' AND run_id = 'retained-trace-run'`;
      expect(row.trace_ref).toBe(collected.traceRef);
      expect(JSON.parse(await readTraceBundle(row.trace_ref))).toMatchObject({
        diff: 'retained submission', signals: { regressions: false },
        roleTranscripts: [{ runId: 'retained-worker', role: 'worker', text: 'retained submission' }] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves SQL NULL for a run that never recorded measurements', async () => {
    const runId = 'unmeasured-run';
    await insertRun(src, { runId, variantId: 'baseline', taskId: 'gym-train', cycle: 9 });
    await copyRunAnalyticsToDurable(src, dst, { workspaceId: 'unknown-ws', harnessSlug: 'unknown-harness' });
    const [row] = await dst`
      SELECT run_evidence->'deterministic_signals' AS deterministic_signals,
             run_evidence->>'trace_ref' AS trace_ref, run_evidence->>'distilled_ref' AS distilled_ref, run_params
        FROM harness_gym_durable.gym_runs
       WHERE workspace_id = 'unknown-ws' AND harness_slug = 'unknown-harness' AND run_id = ${runId}`;
    expect(row).toEqual({ deterministic_signals: null, trace_ref: null, distilled_ref: null, run_params: null });
  });

  it('retains both independent baseline evaluations through the real store and durable copy', async () => {
    const scope = { workspaceId: 'identity-ws', harnessSlug: 'identity-harness' };
    const evaluate = async (token: string) => {
      const judge: AbDeps['llmCall'] = async () => ({
        text: JSON.stringify({ d1: 5, d2: 5, d3: 5, rationale: 'controlled identity fixture' }),
        costUsd: 0, inputTokens: 0, outputTokens: 0,
      });
      const ab: AbDeps = {
        store: createGymStore(src), llmCall: judge, now: () => 0,
        newRunId: () => { throw new Error('the loop owns its evaluation identity'); },
        runPipeline: async () => ({ harnessSlug: `identity-${token}`, clonePath: '/controlled-clone',
          workflowID: `identity-${token}`, outcome: 'passed', pipelineUsd: 0 }),
        collectAndDistill: async () => ({ distilledTrace: 'controlled trace',
          traceRef: `controlled:${token}`, rawSignals: { regressions: false, fixtureLoop: token } }),
      };
      const deps = buildLoopDeps({ gymSql: src, ports: {} as never, abDeps: ab,
        judgeCall: judge, proposerCall: judge, proposerModel: 'controlled-unused',
        tasks: [{ taskId: 'identity-task', pool: 'train', repoUrl: '/controlled',
          repoCommit: 'declared-source', spec: 'controlled', intent: 'controlled', projectContext: 'controlled' }],
        baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
        harnessCommit: 'declared-harness', workspaceId: 'controlled-workspace', scratchRoot: '/controlled-scratch',
        timeoutMs: 1000, pollIntervalMs: 10, maxDistillChars: 100, runId: token,
      });
      await deps.evaluate('baseline', { promptOverrides: {} });
      await copyRunAnalyticsToDurable(src, dst, scope);
      // The next independent loop has a new temporary DB. Clear its source run
      // here while keeping the real destination, reproducing that lifecycle.
      await src`DELETE FROM harness_gym.gym_runs WHERE task_id = 'identity-task'`;
    };
    await evaluate('first');
    await evaluate('second');
    const rows = await dst`
      SELECT run_id, run_evidence->'deterministic_signals'->>'fixtureLoop' AS fixture_loop, run_params
        FROM harness_gym_durable.gym_runs
       WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
         AND task_id = 'identity-task' ORDER BY fixture_loop`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.run_id)).size).toBe(2);
    expect(rows.map((row) => row.fixture_loop)).toEqual(['first', 'second']);
    for (const row of rows) {
      expect(decode(row.run_params)).toMatchObject({ run_id: row.run_id,
        harness_commit: 'declared-harness', substrate_commit: 'declared-source',
        judge_model: GYM_JUDGE_RUBRIC_V1.model, judge_temp: GYM_JUDGE_RUBRIC_V1.temperature,
        weights: GYM_JUDGE_RUBRIC_V1.weights, rubric_hash: rubricHash(GYM_JUDGE_RUBRIC_V1), mutable_roles: null });
    }
  });
});
