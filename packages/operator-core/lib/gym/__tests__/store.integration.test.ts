/**
 * Live-PG test for the gym store (P-012/P-013): write variants/tasks/runs/scores/
 * params into a throwaway gym DB and read the A-vs-B comparison back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyGymSchema } from '../schema';
import { insertVariant, insertTask, insertRun, finishRun, insertScore, insertRunParams, compareVariants } from '../store';
import type { GymScore } from '../judge';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `gymstore_${randomBytes(5).toString('hex')}`;

const score = (composite: number, rubricHash = 'rh1'): GymScore => ({
  d1: composite, d2: composite, d3: composite, composite, rationale: 'r',
  judgeModel: 'claude-opus-4-8', rubricHash, judgeTemp: 0, weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  costUsd: 0.5, inputTokens: 100, outputTokens: 50,
});

beforeAll(async () => {
  containerUri = await getTestPg();
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`CREATE DATABASE "${dbName}"`); await markManagedTestDatabase(maint, dbName); } finally { await maint.end({ timeout: 5 }); }
  const u = new URL(containerUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {}, prepare: false });
  await applyGymSchema(sql);
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('gym store', () => {
  it('round-trips a run with signals + params', async () => {
    await insertVariant(sql, { variantId: 'v-base', label: 'baseline', overlay: { promptOverrides: {} } });
    await insertTask(sql, { taskId: 'tk-1', pool: 'train', repoUrl: '/r', repoCommit: 'abc1234', spec: 's', intent: 'i' });
    await insertRun(sql, { runId: 'rn-1', variantId: 'v-base', taskId: 'tk-1', cycle: 0, harnessSlug: 'gym-x' });
    await finishRun(sql, 'rn-1', { terminalState: 'passed', deterministicSignals: { regressions: false }, elapsedMs: 1234 });
    await insertRunParams(sql, 'rn-1', { harnessCommit: 'fed1234', substrateCommit: 'abc1234', rubricHash: 'rh1' });

    const run = await sql<{ terminal_state: string; elapsed_ms: string; deterministic_signals: unknown }[]>`
      SELECT terminal_state, elapsed_ms, deterministic_signals FROM harness_gym.gym_runs WHERE run_id = 'rn-1'`;
    expect(run[0].terminal_state).toBe('passed');
    expect(Number(run[0].elapsed_ms)).toBe(1234);
    // jsonb is returned as a STRING on this postgres-js stack — callers must JSON.parse.
    const sig = run[0].deterministic_signals;
    const parsedSig = typeof sig === 'string' ? JSON.parse(sig) : sig;
    expect((parsedSig as { regressions: boolean }).regressions).toBe(false);

    const params = await sql<{ harness_commit: string }[]>`SELECT harness_commit FROM harness_gym.gym_runs_params WHERE run_id = 'rn-1'`;
    expect(params[0].harness_commit).toBe('fed1234');
  });

  it('compares two variants per-task with a signed delta', async () => {
    await insertVariant(sql, { variantId: 'v-a', label: 'A', overlay: { promptOverrides: {} } });
    await insertVariant(sql, { variantId: 'v-b', label: 'B', overlay: { promptOverrides: { worker: 'w2' } } });
    for (const t of ['ct-1', 'ct-2']) {
      await insertTask(sql, { taskId: t, pool: 'train', repoUrl: '/r', repoCommit: 'abc1234', spec: 's', intent: 'i' });
    }
    // A scores 6 on both tasks; B scores 7 on ct-1, 5 on ct-2
    await insertRun(sql, { runId: 'a1', variantId: 'v-a', taskId: 'ct-1', cycle: 0 });
    await insertScore(sql, 'a1', score(6));
    await insertRun(sql, { runId: 'a2', variantId: 'v-a', taskId: 'ct-2', cycle: 0 });
    await insertScore(sql, 'a2', score(6));
    await insertRun(sql, { runId: 'b1', variantId: 'v-b', taskId: 'ct-1', cycle: 0 });
    await insertScore(sql, 'b1', score(7));
    await insertRun(sql, { runId: 'b2', variantId: 'v-b', taskId: 'ct-2', cycle: 0 });
    await insertScore(sql, 'b2', score(5));

    const cmp = await compareVariants(sql, 'v-a', 'v-b', 'rh1');
    const byTask = Object.fromEntries(cmp.map((r) => [r.taskId, r]));
    expect(byTask['ct-1'].delta).toBeCloseTo(1, 5); // 7 - 6
    expect(byTask['ct-2'].delta).toBeCloseTo(-1, 5); // 5 - 6
  });

  it('upgrades the legacy run key while retaining independent evaluations and idempotent retries', async () => {
    // Recreate an already-provisioned gym DB: migration 001 is recorded, its
    // tuple constraint remains, and the additive run-identity migration is pending.
    await sql`ALTER TABLE harness_gym.gym_runs
      ADD CONSTRAINT gym_runs_variant_id_task_id_cycle_repeat_key UNIQUE (variant_id, task_id, cycle, repeat)`;
    await sql`DELETE FROM harness_shared.schema_migrations WHERE filename = '002-gym-run-identity.sql'`;
    await insertVariant(sql, { variantId: 'retained-baseline', label: 'baseline', overlay: { promptOverrides: {} } });
    await insertTask(sql, { taskId: 'retained-task', pool: 'train', repoUrl: '/r', repoCommit: 'abc1234', spec: 's', intent: 'i' });
    const first = { runId: 'loop-first::baseline', variantId: 'retained-baseline', taskId: 'retained-task', cycle: 0, repeat: 0, harnessSlug: 'first' };
    const second = { ...first, runId: 'loop-second::baseline', harnessSlug: 'second' };
    await insertRun(sql, first);
    await finishRun(sql, first.runId, { terminalState: 'passed', deterministicSignals: { snapshot: 'first' } });
    await insertScore(sql, first.runId, score(6));
    await insertRunParams(sql, first.runId, { harnessCommit: 'first-commit', substrateCommit: 'abc1234' });

    // Isolate the old schema as the cause, independently of loop orchestration.
    await expect(insertRun(sql, second)).rejects.toMatchObject({
      code: '23505', constraint_name: 'gym_runs_variant_id_task_id_cycle_repeat_key',
    });
    await applyGymSchema(sql);
    await insertRun(sql, second);
    await finishRun(sql, second.runId, { terminalState: 'passed', deterministicSignals: { snapshot: 'second' } });
    await insertScore(sql, second.runId, score(7));
    await insertRunParams(sql, second.runId, { harnessCommit: 'second-commit', substrateCommit: 'abc1234' });
    // A retry of the same run identity must preserve the original run row.
    await insertRun(sql, { ...first, harnessSlug: 'retry-must-not-replace' });
    await applyGymSchema(sql);

    const rows = await sql`
      SELECT r.run_id, r.harness_slug, r.deterministic_signals->>'snapshot' AS snapshot,
             s.composite, p.harness_commit
        FROM harness_gym.gym_runs r
        JOIN harness_gym.gym_scores s USING (run_id)
        JOIN harness_gym.gym_runs_params p USING (run_id)
       WHERE r.task_id = 'retained-task'
       ORDER BY r.run_id`;
    expect(rows.map((r) => ({ ...r, composite: Number(r.composite) }))).toEqual([
      { run_id: first.runId, harness_slug: 'first', snapshot: 'first', composite: 6, harness_commit: 'first-commit' },
      { run_id: second.runId, harness_slug: 'second', snapshot: 'second', composite: 7, harness_commit: 'second-commit' },
    ]);
  });
});
