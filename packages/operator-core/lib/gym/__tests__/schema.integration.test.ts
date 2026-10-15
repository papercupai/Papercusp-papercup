/**
 * Live-PG regression sentinel for the harness_gym schema (P-012). The gym schema is
 * applied by the migration runner from ./sql (schema = migrations only, no runtime
 * DDL) to a DEDICATED gym database (D-018) — never the live operator DB. We provision
 * a throwaway database on the shared testcontainer and apply the gym migration to it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyGymSchema } from '../schema';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `gym_${randomBytes(5).toString('hex')}`;

beforeAll(async () => {
  containerUri = await getTestPg();
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(maint, dbName);
  } finally {
    await maint.end({ timeout: 5 });
  }
  const u = new URL(containerUri);
  u.pathname = `/${dbName}`;
  // max:1 — the migration runner issues explicit BEGIN/COMMIT via unsafe(), which
  // postgres-js only allows on a single-connection client.
  sql = postgres(u.toString(), { max: 1, onnotice: () => {}, prepare: false });
  await applyGymSchema(sql);
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await maint.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('applyGymSchema', () => {
  it('creates the gym schema with all six tables', async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'harness_gym' ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      'gym_cycles',
      'gym_runs',
      'gym_runs_params',
      'gym_scores',
      'gym_tasks',
      'gym_variants',
    ]);
  });

  it('is idempotent — re-applying is a tracked no-op', async () => {
    await expect(applyGymSchema(sql)).resolves.toBeUndefined();
  });

  it('enforces the task-pool CHECK (the five defined pools only)', async () => {
    await sql.unsafe(
      `INSERT INTO harness_gym.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['t-ok', 'dev-anchor', '/r', 'abc1234', 'spec', 'intent'],
    );
    await expect(
      sql.unsafe(
        `INSERT INTO harness_gym.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        ['t-bad', 'bogus-pool', '/r', 'abc1234', 'spec', 'intent'],
      ),
    ).rejects.toThrow();
  });

  it('cascades scores + params when their run is deleted (FK + ON DELETE CASCADE)', async () => {
    await sql.unsafe(`INSERT INTO harness_gym.gym_variants (variant_id, label) VALUES ($1,$2)`, ['v1', 'baseline']);
    await sql.unsafe(
      `INSERT INTO harness_gym.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['task-c', 'train', '/r', 'abc1234', 's', 'i'],
    );
    await sql.unsafe(`INSERT INTO harness_gym.gym_runs (run_id, variant_id, task_id, cycle) VALUES ($1,$2,$3,$4)`, [
      'run-c', 'v1', 'task-c', 0,
    ]);
    await sql.unsafe(
      `INSERT INTO harness_gym.gym_scores (run_id, judge_model, rubric_hash, weights, d1, d2, d3, composite)
       VALUES ($1,$2,$3,'{"d1":0.5}'::jsonb,$4,$5,$6,$7)`,
      ['run-c', 'claude-opus-4-8', 'rh1', 8, 7, 9, 8.1],
    );
    await sql.unsafe(
      `INSERT INTO harness_gym.gym_runs_params (run_id, harness_commit, substrate_commit) VALUES ($1,$2,$3)`,
      ['run-c', 'fed1234', 'abc1234'],
    );

    await sql.unsafe(`DELETE FROM harness_gym.gym_runs WHERE run_id = $1`, ['run-c']);
    const scores = await sql.unsafe(`SELECT 1 FROM harness_gym.gym_scores WHERE run_id = $1`, ['run-c']);
    const params = await sql.unsafe(`SELECT 1 FROM harness_gym.gym_runs_params WHERE run_id = $1`, ['run-c']);
    expect(scores).toHaveLength(0);
    expect(params).toHaveLength(0);
  });

  it('allows a run to carry multiple scores under distinct rubric_hash (re-judge-from-cache)', async () => {
    await sql.unsafe(`INSERT INTO harness_gym.gym_variants (variant_id, label) VALUES ($1,$2)`, ['v2', 'cand']);
    await sql.unsafe(
      `INSERT INTO harness_gym.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['task-r', 'train', '/r', 'abc1234', 's', 'i'],
    );
    await sql.unsafe(`INSERT INTO harness_gym.gym_runs (run_id, variant_id, task_id, cycle) VALUES ($1,$2,$3,$4)`, [
      'run-r', 'v2', 'task-r', 0,
    ]);
    for (const rh of ['rubric-A', 'rubric-B']) {
      await sql.unsafe(
        `INSERT INTO harness_gym.gym_scores (run_id, judge_model, rubric_hash, weights, d1, d2, d3, composite)
         VALUES ($1,$2,$3,'{}'::jsonb,$4,$5,$6,$7)`,
        ['run-r', 'claude-opus-4-8', rh, 5, 5, 5, 5],
      );
    }
    const rows = await sql.unsafe(`SELECT rubric_hash FROM harness_gym.gym_scores WHERE run_id = $1 ORDER BY rubric_hash`, ['run-r']);
    expect(rows.map((r) => (r as { rubric_hash: string }).rubric_hash)).toEqual(['rubric-A', 'rubric-B']);
  });
});
