/**
 * Integration test for the LIVE-ops DB READS (P-063 / D-011) — proves the SQL the live binding runs
 * against a throwaway hive's real tables is correct: the spawn-row mapping (bigint duration +
 * timestamptz → epoch ms + null handling), the HFC run-stats (total + `passed` completion count), and
 * the in-flight placement predicate (only non-terminal `pot_placements`). No LLM, no hive boot:
 * synthetic rows in minimal stub tables (the exact columns the reads query, verified against
 * 000-baseline.sql / 263-hive-placements.sql) — the same boundary b459e's ground-truth-live test drew.
 *
 * The lifecycle WRITE ops (createHive/registerMember/startHive) + the real Queen drive are owner-gated
 * (P-051) and validated at the first armed run; these reads are the part that CAN be verified now.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { readMemberSpawnRows, readMemberRunStats, countHivePlacementsInFlight, readQueenEkg, readBeeEkg } from './live-ops';

describe('live-ops DB reads (P-063, synthetic hive rows)', () => {
  let sql: postgres.Sql;
  const ws = 'ws-test';

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `hive_eval_ops_${randomBytes(5).toString('hex')}`;
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      await markManagedTestDatabase(admin, dbName);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const u = new URL(adminUri);
    u.pathname = `/${dbName}`;
    sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    // P-010 unification: work_items base + hfc/ei compat views (replaces the hfc stub).
    await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
    // Minimal stubs — only the columns the live reads query (cf. 000-baseline + 263-hive-placements).
    await sql.unsafe(`
      CREATE TABLE harness_shared.spawned_agents (
        spawn_id text PRIMARY KEY,
        workspace_id text NOT NULL,
        harness_slug text NOT NULL,
        feature_id text,
        status text NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        duration_ms bigint
      );
      CREATE TABLE harness_shared.pot_placements (
        workspace_id text NOT NULL,
        install_slug text NOT NULL,
        work_item_id text NOT NULL,
        status text NOT NULL,
        PRIMARY KEY (workspace_id, install_slug, work_item_id)
      );
      CREATE TABLE harness_shared.agent_usage_samples (
        workspace_id text NOT NULL,
        ts bigint NOT NULL,
        role text,
        harness_slug text,
        run_id text,
        session_id text, -- migration 279: groups a warm-inject bee's wakes (readBeeEkg, P-015)
        input_tokens bigint,
        output_tokens bigint,
        cache_read_tokens bigint,
        cache_creation_tokens bigint,
        cost_usd numeric,
        turn_count integer
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('readMemberRunStats: total + the `passed` completion count, scoped to the member', async () => {
    const member = 'hevalm1';
    await sql`INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, status) VALUES
      (${ws}, ${member}, 'w0', 'passed'),
      (${ws}, ${member}, 'w1', 'passed'),
      (${ws}, ${member}, 'w2', 'validating'),
      (${ws}, ${member}, 'w3', 'todo'),
      (${ws}, 'other-harness', 'w0-other', 'passed')`; // a different harness — must be excluded (its own id: a work-item id names one row per workspace, scope-unique-identifiers P-009)
    const stats = await readMemberRunStats(sql, member, ws);
    expect(stats).toEqual({ costUsd: 0, workItemsTotal: 4, workItemsCompleted: 2 });
  });

  it('readMemberSpawnRows: maps bigint duration + timestamptz → epoch ms, handles null finished/feature', async () => {
    const member = 'hevalm2';
    await sql`INSERT INTO harness_shared.spawned_agents (spawn_id, workspace_id, harness_slug, feature_id, status, started_at, finished_at, duration_ms) VALUES
      ('s1', ${ws}, ${member}, 'w0', 'done', ${new Date(1_000_000)}, ${new Date(1_050_000)}, ${50_000}),
      ('s2', ${ws}, ${member}, NULL, 'running', ${new Date(2_000_000)}, NULL, NULL),
      ('s3', ${ws}, 'other-harness', 'w0', 'done', ${new Date(3_000_000)}, ${new Date(3_001_000)}, ${1_000})`;
    const rows = await readMemberSpawnRows(sql, member, ws);
    expect(rows).toHaveLength(2); // s3 belongs to another harness
    const s1 = rows.find((r) => r.spawnId === 's1')!;
    expect(s1).toEqual({ spawnId: 's1', featureId: 'w0', status: 'done', startedAtMs: 1_000_000, finishedAtMs: 1_050_000, durationMs: 50_000 });
    const s2 = rows.find((r) => r.spawnId === 's2')!;
    expect(s2).toMatchObject({ featureId: null, finishedAtMs: null, durationMs: null, startedAtMs: 2_000_000 });
  });

  it('countHivePlacementsInFlight: only non-terminal (working/recovering) rows for the home', async () => {
    const home = 'heval-home1';
    await sql`INSERT INTO harness_shared.pot_placements (workspace_id, install_slug, work_item_id, status) VALUES
      (${ws}, ${home}, 'w0', 'working'),
      (${ws}, ${home}, 'w1', 'recovering'),
      (${ws}, ${home}, 'w2', 'completed'),
      (${ws}, ${home}, 'w3', 'cursed'),
      (${ws}, ${home}, 'w4', 'abandoned'),
      (${ws}, 'other-home', 'w0', 'working')`; // a different hive — excluded
    expect(await countHivePlacementsInFlight(sql, home, ws)).toBe(2); // working + recovering only
  });

  it('empty member/home → zeroes (a drained hive reads clean)', async () => {
    expect(await readMemberRunStats(sql, 'nope', ws)).toEqual({ costUsd: 0, workItemsTotal: 0, workItemsCompleted: 0 });
    expect(await readMemberSpawnRows(sql, 'nope', ws)).toEqual([]);
    expect(await countHivePlacementsInFlight(sql, 'nope', ws)).toBe(0);
  });

  it('readQueenEkg: aggregates role=queen usage scoped to the home slug (B-06 per-wake efficiency)', async () => {
    const home = 'heval-qeff1';
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, role, harness_slug, run_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, turn_count) VALUES
      (${ws}, 200, 'mug', ${home}, 'w1', 1000, 500, 8000, 1000, 0.12, 3),
      (${ws}, 100, 'mug', ${home}, 'w2', 2000, 300, 0, 5000, 0.20, NULL),
      (${ws}, 150, 'worker', ${home}, 'b1', 9999, 9999, 9999, 9999, 9.99, 9),
      (${ws}, 150, 'mug', 'other-home', 'x1', 7777, 7777, 7777, 7777, 7.77, 7)`;
    const ekg = await readQueenEkg(sql, { workspaceId: ws, hiveHome: home });
    // only the two role=queen rows under THIS home — worker + other-home excluded.
    expect(ekg.queenWakes).toBe(2);
    expect(ekg.queenCacheReadTokens).toBe(8000);
    expect(ekg.queenCacheCreationTokens).toBe(6000); // 1000 + 5000
    expect(ekg.queenInputTokens).toBe(3000); // 1000 + 2000
    expect(ekg.queenTurns).toBe(3); // only w1 reported a turn count
    expect(ekg.queenWakesWithTurns).toBe(1);
  });

  it('readQueenEkg: a home with no Queen wakes reads all-zero (conservative floor)', async () => {
    const ekg = await readQueenEkg(sql, { workspaceId: ws, hiveHome: 'heval-noqueen' });
    expect(ekg).toEqual({
      queenCacheReadTokens: 0,
      queenCacheCreationTokens: 0,
      queenInputTokens: 0,
      queenWakes: 0,
      queenTurns: 0,
      queenWakesWithTurns: 0,
    });
  });

  it('readBeeEkg: aggregates role=bee usage by session scoped to the member, deriving the warm-inject carry (P-015)', async () => {
    const member = 'heval-beeff1';
    // sessA = a warm-inject session (2 wakes: spawn + 1 warm-inject); sessB = a single-task session.
    // Excluded: a worker row (wrong role), an other-member bee row (wrong harness), a NULL-session bee
    // row (un-attributable — the SELECT filters session_id IS NOT NULL).
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, role, harness_slug, run_id, session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, turn_count) VALUES
      (${ws}, 100, 'cup', ${member}, 'r1', 'sessA', 1000, 500, 100000, 5000, 0.50, 4),
      (${ws}, 200, 'cup', ${member}, 'r2', 'sessA',  200, 300, 130000, 1000, 0.30, 6),
      (${ws}, 150, 'cup', ${member}, 'r3', 'sessB', 2000, 400,  80000, 8000, 0.40, 5),
      (${ws}, 150, 'worker', ${member}, 'r4', 'sessW', 9999, 9999, 9999, 9999, 9.99, 9),
      (${ws}, 150, 'cup', 'other-member', 'r5', 'sessY', 7777, 7777, 7777, 7777, 7.77, 7),
      (${ws}, 160, 'cup', ${member}, 'r6', NULL, 3333, 3333, 3333, 3333, 3.33, 3)`;
    const ekg = await readBeeEkg(sql, { workspaceId: ws, member });
    // carry = cache_read on the NON-FIRST wake of each session: only sessA's second wake (130000).
    expect(ekg.beeCarriedReadTokens).toBe(130000);
    expect(ekg.beeCacheReadTokens).toBe(310000); // 100000 + 130000 + 80000
    expect(ekg.beeCacheCreationTokens).toBe(14000); // 5000 + 1000 + 8000
    expect(ekg.beeInputTokens).toBe(3200); // 1000 + 200 + 2000
    // warm-injects = totalWakes(3) − sessions(2) = 1 (sessA's single warm-inject). The score gate.
    expect(ekg.beeWarmInjects).toBe(1);
  });

  it('readBeeEkg: a member with no bee wakes reads all-zero (conservative floor)', async () => {
    const ekg = await readBeeEkg(sql, { workspaceId: ws, member: 'heval-nobee' });
    expect(ekg).toEqual({
      beeCarriedReadTokens: 0,
      beeCacheReadTokens: 0,
      beeCacheCreationTokens: 0,
      beeInputTokens: 0,
      beeWarmInjects: 0,
    });
  });
});
