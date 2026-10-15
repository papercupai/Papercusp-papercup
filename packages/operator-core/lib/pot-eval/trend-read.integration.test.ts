/**
 * Integration test for the Hive-eval trend read (HE-07, P-050) over migrations 264 + 268.
 * Seeds two generations (instances) with scored runs and asserts the per-generation trend rolls
 * up newest-first, scopes to one rubric hash (scores never mix across rubrics, D-011), and reports
 * an honest scored-vs-total count when a generation is only partially scored.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readRepoFile } from '@papercusp/test-config';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { createPgHiveEvalStore } from './store-pg';
import { readHiveEvalInstanceSummaries } from './trend-read';
import type { HiveEvalRunRow, HiveEvalScoreRow, InstanceManifest } from './store';

// 554 (Slice H Phase 1, cup-lexicon rename) renames hive_eval_* -> pot_eval_* so the store's
// queries (now against the new names) resolve against this fixture.
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

const WS = 'ws-trend';
const RUBRIC = 'rubric-current';

const runRow = (instanceId: string, repeat: number): HiveEvalRunRow => ({
  runId: `${instanceId}::serial-pipeline::r${repeat}`,
  instanceId,
  scenarioId: 'serial-pipeline',
  shape: 'serial',
  repeat,
  seed: 1 + repeat,
  budgetUsdCap: 10,
  beeCap: 4,
  startedAt: new Date(),
});

const scoreRow = (runId: string, over: Partial<HiveEvalScoreRow> = {}): HiveEvalScoreRow => ({
  runId,
  rubricHash: RUBRIC,
  rubricVersion: 'hive-score-v1',
  outcomeGatePassed: true,
  efficiencyScore: 8,
  speedScore: 9,
  composite: 8.5,
  judgeComposite: undefined,
  regressions: false,
  plantedBugCaught: true,
  fabricationDetected: false,
  criticalPathRatio: 1.2,
  floorCeiling: 10,
  detail: {},
  ...over,
});

describe('readHiveEvalInstanceSummaries (HE-07 trend, migrations 264 + 268)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `hive_eval_trend_${randomBytes(5).toString('hex')}`;
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

    const store = createPgHiveEvalStore(sql);
    // Two generations with explicit created_at so the trend order is deterministic.
    const older: InstanceManifest = { instanceId: 'gen-old', workspaceId: WS, codeSha: 'aaaa', createdAt: new Date('2026-06-01T00:00:00Z') };
    const newer: InstanceManifest = { instanceId: 'gen-new', workspaceId: WS, codeSha: 'bbbb', createdAt: new Date('2026-06-10T00:00:00Z') };
    await store.upsertInstance(older);
    await store.upsertInstance(newer);
    await sql`UPDATE harness_shared.pot_eval_instances SET created_at = '2026-06-01T00:00:00Z' WHERE instance_id = 'gen-old'`;
    await sql`UPDATE harness_shared.pot_eval_instances SET created_at = '2026-06-10T00:00:00Z' WHERE instance_id = 'gen-new'`;

    // OLDER generation: 2 runs, both scored (composite 6 + 8 → mean 7), one gate-fail.
    for (const r of [0, 1]) await store.startRun(runRow('gen-old', r));
    await store.upsertScore(scoreRow(runRow('gen-old', 0).runId, { composite: 6, outcomeGatePassed: false }));
    await store.upsertScore(scoreRow(runRow('gen-old', 1).runId, { composite: 8 }));

    // NEWER generation: 2 runs but only 1 scored under the current rubric (the other under a stale
    // rubric — must NOT be counted), composite 9, no gate-fail.
    for (const r of [0, 1]) await store.startRun(runRow('gen-new', r));
    await store.upsertScore(scoreRow(runRow('gen-new', 0).runId, { composite: 9 }));
    await store.upsertScore(scoreRow(runRow('gen-new', 1).runId, { rubricHash: 'rubric-stale', composite: 1 }));
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('rolls up per generation, newest first, scoped to the rubric', async () => {
    const rows = await readHiveEvalInstanceSummaries(sql, { workspaceId: WS, rubricHash: RUBRIC });
    expect(rows.map((r) => r.instanceId)).toEqual(['gen-new', 'gen-old']); // newest first

    const [newer, older] = rows;
    // newer: 2 runs total, 1 scored under the current rubric (the stale-rubric run excluded).
    expect(newer.totalRuns).toBe(2);
    expect(newer.scoredRuns).toBe(1);
    expect(newer.meanComposite).toBeCloseTo(9, 5);
    expect(newer.outcomeGatePassRate).toBe(1);

    // older: 2 runs, both scored (composite 6 + 8 → 7), one gate-fail → pass rate 0.5.
    expect(older.totalRuns).toBe(2);
    expect(older.scoredRuns).toBe(2);
    expect(older.meanComposite).toBeCloseTo(7, 5);
    expect(older.outcomeGatePassRate).toBeCloseTo(0.5, 5);
    expect(older.meanCriticalPathRatio).toBeCloseTo(1.2, 5);
  });

  it('a different rubric hash yields no scored runs (scores never mix across rubrics)', async () => {
    const rows = await readHiveEvalInstanceSummaries(sql, { workspaceId: WS, rubricHash: 'rubric-stale' });
    const newer = rows.find((r) => r.instanceId === 'gen-new')!;
    expect(newer.scoredRuns).toBe(1); // only the stale-rubric run
    expect(newer.meanComposite).toBeCloseTo(1, 5);
    const older = rows.find((r) => r.instanceId === 'gen-old')!;
    expect(older.scoredRuns).toBe(0); // older has no stale-rubric scores
    expect(older.meanComposite).toBeNull();
  });
});
