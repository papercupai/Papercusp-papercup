/**
 * beekeeper-store-pg.integration.test.ts — BeekeeperStorePg, the apiary result
 * writer (migrations 180 + 201), against a real Postgres (testcontainer).
 *
 * The behaviors a fake-sql unit test can't prove, all idempotent-re-run (D-005):
 *  - upsertInstance conflicts on the instance_id PK (DO NOTHING) — a re-run at the
 *    same commit is a no-op, not a crash; and two distinct instance_ids sharing
 *    (workspace, code_sha) with NULL genome_id BOTH insert (NULLs never match the
 *    UNIQUE), the exact subtlety the source comment documents.
 *  - startRun RESETS the terminal fields on re-run (a fresh attempt), not a PK clash.
 *  - recordScore overwrites on (run_id, rubric_hash) re-judge.
 *  - recordScore persists FRACTIONAL metrics (tokens_per_task 90.377) — the numeric
 *    widening from migration 201; an INTEGER column would reject it.
 *
 * Store takes an INJECTED Sql, so no db-org mock — the testcontainer handle goes in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { BeekeeperStorePg } from './beekeeper-store-pg';
import type { InstanceManifest } from './instance-manifest';
import type { GymScore } from '../gym/judge';
import type { IQBatteryMetrics } from './collectors';

const WS = 'ws-bk';
let sql: postgres.Sql;
let store: BeekeeperStorePg;

const manifest = (over: Partial<InstanceManifest>): InstanceManifest =>
  ({ instanceId: 'i1', workspaceId: WS, codeSha: 'shaA', genomeId: null, memorySnapshotId: null, batterySliceId: null, ...over }) as InstanceManifest;

const score = (over: Partial<GymScore>): GymScore =>
  ({ judgeModel: 'opus', rubricHash: 'rh1', judgeTemp: 0, weights: { d1: 1 }, d1: 0.5, d2: 0.5, d3: 0.5, composite: 0.5, rationale: 'ok', ...over }) as GymScore;

const metrics = (over: Partial<IQBatteryMetrics>): IQBatteryMetrics =>
  ({ success: true, tokensPerSolvedTask: 100, timeToGreenSecs: 10, firstAttemptPass: true, recurrence: 0, escalation: false, recallHit: 0, ...over }) as IQBatteryMetrics;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `bk_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to migration 180 + 201 (the three fractional metrics are numeric post-201).
  await sql.unsafe(`
    CREATE TABLE harness_shared.cup_keeper_instances (
      instance_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      code_sha TEXT NOT NULL,
      genome_id TEXT,
      memory_snapshot_id TEXT,
      battery_slice_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, code_sha, genome_id)
    )`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.cup_keeper_runs (
      run_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES harness_shared.cup_keeper_instances(instance_id) ON DELETE CASCADE,
      case_id TEXT NOT NULL,
      case_variant TEXT NOT NULL,
      case_title TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      elapsed_ms BIGINT,
      terminal_state TEXT,
      deterministic_signals JSONB,
      trace_ref TEXT,
      UNIQUE (instance_id, case_id)
    )`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.cup_keeper_scores (
      run_id TEXT NOT NULL REFERENCES harness_shared.cup_keeper_runs(run_id) ON DELETE CASCADE,
      judge_model TEXT NOT NULL,
      rubric_hash TEXT NOT NULL,
      judge_temp REAL,
      weights JSONB NOT NULL,
      success BOOLEAN,
      tokens_per_task NUMERIC,
      time_to_green_secs NUMERIC,
      first_attempt_pass BOOLEAN,
      recurrence INTEGER,
      escalation BOOLEAN,
      recall_hit NUMERIC,
      d1 REAL NOT NULL,
      d2 REAL NOT NULL,
      d3 REAL NOT NULL,
      composite REAL NOT NULL,
      rationale TEXT,
      scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, rubric_hash)
    )`);
  store = new BeekeeperStorePg(sql);
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.cup_keeper_instances CASCADE`;
});

describe('BeekeeperStorePg (PG)', () => {
  it('upsertInstance is idempotent on the instance_id PK — a re-run at the same commit is a no-op', async () => {
    await store.upsertInstance(manifest({ instanceId: 'gen0-shaA', codeSha: 'shaA' }));
    await store.upsertInstance(manifest({ instanceId: 'gen0-shaA', codeSha: 'DIFFERENT' })); // same PK
    const rows = await sql`SELECT code_sha FROM harness_shared.cup_keeper_instances WHERE instance_id = 'gen0-shaA'`;
    expect(rows).toHaveLength(1); // DO NOTHING — no crash, no dup
    expect(rows[0]!.code_sha).toBe('shaA'); // original preserved
  });

  it('two distinct instances sharing (workspace, code_sha) with NULL genome_id BOTH insert (NULLs never match the UNIQUE)', async () => {
    await store.upsertInstance(manifest({ instanceId: 'a', codeSha: 'shaX', genomeId: null }));
    await store.upsertInstance(manifest({ instanceId: 'b', codeSha: 'shaX', genomeId: null }));
    const n = await sql`SELECT count(*)::int AS c FROM harness_shared.cup_keeper_instances WHERE code_sha = 'shaX'`;
    expect(n[0]!.c).toBe(2); // the UNIQUE(workspace, code_sha, genome) does not block — genome NULLs are distinct
  });

  it('startRun → finishRun → startRun RESETS the terminal fields (a fresh attempt)', async () => {
    await store.upsertInstance(manifest({ instanceId: 'inst', codeSha: 'shaA' }));
    await store.startRun({ runId: 'r1', instanceId: 'inst', caseId: 'c1', caseVariant: 'v', caseTitle: 'T' });
    await store.finishRun('r1', { terminalState: 'green', deterministicSignals: { ok: true }, traceRef: 'tr', elapsedMs: 1234 });
    let row = (await sql`SELECT terminal_state, elapsed_ms, finished_at FROM harness_shared.cup_keeper_runs WHERE run_id='r1'`)[0]!;
    expect(row.terminal_state).toBe('green'); // finishRun populated it
    expect(Number(row.elapsed_ms)).toBe(1234);

    await store.startRun({ runId: 'r1', instanceId: 'inst', caseId: 'c1', caseVariant: 'v', caseTitle: 'T' }); // re-run
    row = (await sql`SELECT terminal_state, elapsed_ms, finished_at FROM harness_shared.cup_keeper_runs WHERE run_id='r1'`)[0]!;
    expect(row.terminal_state).toBeNull(); // RESET — not the prior 'green'
    expect(row.elapsed_ms).toBeNull();
    expect(row.finished_at).toBeNull();
  });

  it('recordScore persists FRACTIONAL metrics (numeric, migration 201) and overwrites on (run_id, rubric_hash) re-judge', async () => {
    await store.upsertInstance(manifest({ instanceId: 'inst', codeSha: 'shaA' }));
    await store.startRun({ runId: 'r1', instanceId: 'inst', caseId: 'c1', caseVariant: 'v', caseTitle: 'T' });
    // tokens 90.377 is the exact value that broke the INTEGER column pre-201.
    await store.recordScore('r1', score({ rubricHash: 'rh1', composite: 0.4 }), metrics({ tokensPerSolvedTask: 90.377, recallHit: 0.5 }));
    let s = (await sql`SELECT tokens_per_task, recall_hit, composite FROM harness_shared.cup_keeper_scores WHERE run_id='r1' AND rubric_hash='rh1'`)[0]!;
    expect(Number(s.tokens_per_task)).toBeCloseTo(90.377, 3); // fractional persisted
    expect(Number(s.recall_hit)).toBeCloseTo(0.5, 5);
    expect(Number(s.composite)).toBeCloseTo(0.4, 5);

    await store.recordScore('r1', score({ rubricHash: 'rh1', composite: 0.9 }), metrics({})); // re-judge, same rubric
    const all = await sql`SELECT composite FROM harness_shared.cup_keeper_scores WHERE run_id='r1'`;
    expect(all).toHaveLength(1); // overwrite, not a second row
    expect(Number(all[0]!.composite)).toBeCloseTo(0.9, 5);

    await store.recordScore('r1', score({ rubricHash: 'rh2', composite: 0.7 }), metrics({})); // different rubric → new row
    expect(await sql`SELECT 1 FROM harness_shared.cup_keeper_scores WHERE run_id='r1'`).toHaveLength(2);
  });
});
