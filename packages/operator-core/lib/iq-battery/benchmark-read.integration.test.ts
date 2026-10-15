/**
 * benchmark-read.integration.test.ts — readApiaryInstanceSummaries, the
 * Learning-tab "Benchmark" read (migration 180/201), against a real Postgres.
 *
 * The behavior a fake-sql unit test can't prove is the multi-table aggregate:
 *  - the LEFT JOIN HONESTY — a run with NO score row still counts in total_runs,
 *    but contributes to NONE of the score means (a partially-judged instance
 *    reports an honest success/total, not a silently-shrunk denominator);
 *  - the FILTER (WHERE s.success) means (time-to-green / tokens over solved runs);
 *  - newest-instance-first ordering + the success/escalation/first-attempt rates.
 *
 * The reader takes an INJECTED Sql, so no db-org mock is needed — we pass the
 * testcontainer handle straight in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { readApiaryInstanceSummaries } from './benchmark-read';

const WS = 'ws-bench';
let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `bench_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.cup_keeper_instances (
      instance_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      code_sha text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.cup_keeper_runs (
      run_id text PRIMARY KEY,
      instance_id text NOT NULL REFERENCES harness_shared.cup_keeper_instances(instance_id) ON DELETE CASCADE
    )`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.cup_keeper_scores (
      run_id text NOT NULL REFERENCES harness_shared.cup_keeper_runs(run_id) ON DELETE CASCADE,
      success boolean,
      tokens_per_task integer,
      time_to_green_secs integer,
      first_attempt_pass boolean,
      escalation boolean,
      composite real NOT NULL
    )`);

  // inst-new (newer): 2 runs, BOTH scored — one solved, one failed.
  await sql`INSERT INTO harness_shared.cup_keeper_instances (instance_id, workspace_id, code_sha, created_at)
            VALUES ('inst-new', ${WS}, 'sha-new', '2026-01-02T00:00:00Z')`;
  await sql`INSERT INTO harness_shared.cup_keeper_runs (run_id, instance_id) VALUES ('n1','inst-new'),('n2','inst-new')`;
  await sql`INSERT INTO harness_shared.cup_keeper_scores (run_id, success, tokens_per_task, time_to_green_secs, first_attempt_pass, escalation, composite)
            VALUES ('n1', true, 500, 100, true, false, 0.8),
                   ('n2', false, NULL, NULL, false, true, 0.4)`;

  // inst-old (older): 2 runs, only ONE scored — the other has NO score row (LEFT JOIN honesty).
  await sql`INSERT INTO harness_shared.cup_keeper_instances (instance_id, workspace_id, code_sha, created_at)
            VALUES ('inst-old', ${WS}, 'sha-old', '2026-01-01T00:00:00Z')`;
  await sql`INSERT INTO harness_shared.cup_keeper_runs (run_id, instance_id) VALUES ('o1','inst-old'),('o2','inst-old')`;
  await sql`INSERT INTO harness_shared.cup_keeper_scores (run_id, success, tokens_per_task, time_to_green_secs, first_attempt_pass, escalation, composite)
            VALUES ('o1', true, 200, 50, true, false, 0.9)`; // o2 intentionally UNSCORED

  // a different workspace — must never appear in WS's summaries.
  await sql`INSERT INTO harness_shared.cup_keeper_instances (instance_id, workspace_id, code_sha) VALUES ('other-ws', 'ws-elsewhere', 'x')`;
  await sql`INSERT INTO harness_shared.cup_keeper_runs (run_id, instance_id) VALUES ('x1','other-ws')`;
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('readApiaryInstanceSummaries (PG)', () => {
  it('returns one row per instance, newest first, scoped to the workspace', async () => {
    const rows = await readApiaryInstanceSummaries(sql, { workspaceId: WS });
    expect(rows.map((r) => r.instanceId)).toEqual(['inst-new', 'inst-old']); // created_at DESC; other-ws excluded
  });

  it('a fully-scored instance: success/escalation/first-attempt rates + FILTER(success) means', async () => {
    const [neu] = await readApiaryInstanceSummaries(sql, { workspaceId: WS });
    expect(neu).toMatchObject({ codeSha: 'sha-new', totalRuns: 2, successfulRuns: 1 });
    expect(neu!.successRate).toBeCloseTo(0.5, 5);
    expect(neu!.meanComposite).toBeCloseTo(0.6, 5); // (0.8 + 0.4) / 2 — all scored
    expect(neu!.meanTimeToGreenSecs).toBeCloseTo(100, 5); // only the SOLVED run (n1)
    expect(neu!.meanTokens).toBeCloseTo(500, 5); // only n1
    expect(neu!.escalationRate).toBeCloseTo(0.5, 5); // 1 of 2 escalated
    expect(neu!.firstAttemptRate).toBeCloseTo(0.5, 5); // 1 of 2 first-attempt
  });

  it('LEFT JOIN honesty: an unscored run counts in totalRuns but NOT in the score means', async () => {
    const old = (await readApiaryInstanceSummaries(sql, { workspaceId: WS }))[1]!;
    expect(old.totalRuns).toBe(2); // BOTH runs counted, including the unscored o2
    expect(old.successfulRuns).toBe(1);
    expect(old.successRate).toBeCloseTo(0.5, 5); // 1 / 2 — honest denominator
    expect(old.meanComposite).toBeCloseTo(0.9, 5); // avg over the SCORED run only (o2's NULL excluded)
  });

  it('limit is clamped and honored', async () => {
    expect(await readApiaryInstanceSummaries(sql, { workspaceId: WS, limit: 1 })).toHaveLength(1);
    expect(await readApiaryInstanceSummaries(sql, { workspaceId: 'ws-empty' })).toEqual([]);
  });
});
