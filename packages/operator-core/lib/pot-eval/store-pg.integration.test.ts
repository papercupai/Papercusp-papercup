/**
 * Integration test for the hive-eval PG store + migration 264. Validates the DDL applies and
 * the store round-trips, with the load-bearing property: runs key on (instance, scenario,
 * repeat), so N repeats of one scenario are N distinct rows (the P-022 distribution) — unlike
 * the beekeeper's UNIQUE(instance_id, case_id).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readRepoFile } from '@papercusp/test-config';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { createPgHiveEvalStore } from './store-pg';
import { coerceJson } from '../pg-jsonb';
import type { HiveEvalRunRow, HiveEvalScenarioRow, HiveEvalScoreRow, InstanceManifest } from './store';

// 264 records the runs; 268 (HE-06) adds the scores table that FK-references the runs;
// 554 (Slice H Phase 1, cup-lexicon rename) renames hive_eval_* -> pot_eval_* + bee_cap ->
// cup_cap so the store's queries (now against the new names) resolve against this fixture.
const MIGRATIONS = ['264-hive-eval-battery.sql', '268-hive-eval-scores.sql', '554-cup-lexicon-db-rename-phase1.sql'];

function readMigration(name: string): string {
  // Depth-/machine-proof walk-up (DG-6 P-049) — no hardcoded checkout paths.
  return readRepoFile(__dirname, `libs/papercusp/libs/db/sql/${name}`);
}

/** Strip psql meta (\set …) + the file's own top-level BEGIN/COMMIT so sql.unsafe()
 *  can apply it standalone (264/268 have neither, so this is a safe no-op for them). */
function stripMigrationMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

describe('hive-eval PG store (migrations 264 + 268)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `hive_eval_${randomBytes(5).toString('hex')}`;
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
    for (const m of MIGRATIONS) await sql.unsafe(stripMigrationMeta(readMigration(m)));
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  const instance: InstanceManifest = {
    instanceId: 'gen0-deadbe-ws',
    workspaceId: 'ws',
    codeSha: 'deadbe',
    createdAt: new Date(),
  };
  const scenario: HiveEvalScenarioRow = {
    scenarioId: 'serial-pipeline',
    title: 'Serial',
    shape: 'serial',
    idealWallClockUnits: 4,
    idealBeeCount: 1,
    totalUnits: 4,
    criticalPath: ['w1', 'w2', 'w3', 'w4'],
    workItemCount: 4,
    plantedBugLocation: 'src/ranker.js#topN',
  };
  const runRow = (repeat: number): HiveEvalRunRow => ({
    runId: `${instance.instanceId}::serial-pipeline::r${repeat}`,
    instanceId: instance.instanceId,
    scenarioId: 'serial-pipeline',
    shape: 'serial',
    repeat,
    seed: 100 + repeat,
    budgetUsdCap: 10,
    beeCap: 4,
    startedAt: new Date(),
  });

  it('round-trips instance + scenario + a finished run', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    await store.upsertScenario(scenario);
    await store.startRun(runRow(0));
    await store.finishRun(runRow(0).runId, {
      finishedAt: new Date(),
      observations: {
        terminalState: 'drained',
        wallClockMs: 1234,
        frontierDrained: true,
        workItemsTotal: 4,
        workItemsCompleted: 4,
        costUsd: 0.5,
      },
      traceRef: 'trace://x',
    });

    const [row] = await sql`SELECT * FROM harness_shared.pot_eval_runs WHERE run_id = ${runRow(0).runId}`;
    expect(row.terminal_state).toBe('drained');
    expect(Number(row.wall_clock_ms)).toBe(1234);
    expect(row.frontier_drained).toBe(true);
    expect(coerceJson<{ costUsd: number }>(row.observations)?.costUsd).toBe(0.5);
    const [sc] = await sql`SELECT * FROM harness_shared.pot_eval_scenarios WHERE scenario_id = 'serial-pipeline'`;
    expect(sc.ideal_cup_count).toBe(1);
    expect(coerceJson(sc.critical_path)).toEqual(['w1', 'w2', 'w3', 'w4']);
  });

  it('keeps every repeat as a distinct row (the P-022 distribution)', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    for (let r = 0; r < 3; r++) await store.startRun(runRow(r));
    const rows = await sql`SELECT run_id FROM harness_shared.pot_eval_runs WHERE scenario_id = 'serial-pipeline' AND instance_id = ${instance.instanceId} ORDER BY repeat`;
    expect(rows.map((x) => x.run_id)).toEqual([
      `${instance.instanceId}::serial-pipeline::r0`,
      `${instance.instanceId}::serial-pipeline::r1`,
      `${instance.instanceId}::serial-pipeline::r2`,
    ]);
  });

  it('startRun is idempotent — a re-run resets the row to a fresh attempt', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    await store.startRun(runRow(0));
    await store.finishRun(runRow(0).runId, {
      finishedAt: new Date(),
      observations: { terminalState: 'drained', wallClockMs: 9, frontierDrained: true, workItemsTotal: 4, workItemsCompleted: 4, costUsd: 0 },
    });
    // re-run the same key
    await store.startRun(runRow(0));
    const [row] = await sql`SELECT terminal_state, finished_at FROM harness_shared.pot_eval_runs WHERE run_id = ${runRow(0).runId}`;
    expect(row.terminal_state).toBeNull(); // reset
    expect(row.finished_at).toBeNull();
  });

  // ── HE-06 scores (migration 268) ──
  const scoreRow = (over: Partial<HiveEvalScoreRow> = {}): HiveEvalScoreRow => ({
    runId: runRow(0).runId,
    rubricHash: 'rubric-abc',
    rubricVersion: 'hive-score-v1',
    outcomeGatePassed: true,
    efficiencyScore: 8.5,
    speedScore: 9.1,
    composite: 8.8,
    judgeComposite: 7.2,
    regressions: false,
    plantedBugCaught: true,
    fabricationDetected: false,
    criticalPathRatio: 1.1,
    floorCeiling: 10,
    detail: { axis: 'demo' },
    ...over,
  });

  it('round-trips a score and is idempotent on (run_id, rubric_hash)', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    await store.upsertScenario(scenario);
    await store.startRun(runRow(0));
    await store.upsertScore(scoreRow());

    const got = await store.getScore(runRow(0).runId, 'rubric-abc');
    expect(got?.composite).toBe(8.8);
    expect(got?.judgeComposite).toBe(7.2);
    expect(got?.outcomeGatePassed).toBe(true);
    expect((got?.detail as { axis: string }).axis).toBe('demo');

    // re-score the same (run, rubric) → overwrite, not a second row.
    await store.upsertScore(scoreRow({ composite: 2.0, regressions: true, floorCeiling: 3 }));
    const re = await store.getScore(runRow(0).runId, 'rubric-abc');
    expect(re?.composite).toBe(2.0);
    expect(re?.regressions).toBe(true);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM harness_shared.pot_eval_scores WHERE run_id = ${runRow(0).runId}`;
    expect(count).toBe(1);
  });

  it('a different rubric_hash writes a DISTINCT score row (scores never mix across rubrics)', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    await store.upsertScenario(scenario);
    await store.startRun(runRow(0));
    await store.upsertScore(scoreRow({ rubricHash: 'rubric-abc', composite: 8.8 }));
    await store.upsertScore(scoreRow({ rubricHash: 'rubric-xyz', composite: 4.4 }));
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM harness_shared.pot_eval_scores WHERE run_id = ${runRow(0).runId}`;
    expect(count).toBe(2);
    expect((await store.getScore(runRow(0).runId, 'rubric-xyz'))?.composite).toBe(4.4);
  });

  it('a score is removed when its run is deleted (FK ON DELETE CASCADE)', async () => {
    const store = createPgHiveEvalStore(sql);
    await store.upsertInstance(instance);
    await store.upsertScenario(scenario);
    await store.startRun(runRow(0));
    await store.upsertScore(scoreRow());
    await sql`DELETE FROM harness_shared.pot_eval_runs WHERE run_id = ${runRow(0).runId}`;
    expect(await store.getScore(runRow(0).runId, 'rubric-abc')).toBeNull();
  });
});
