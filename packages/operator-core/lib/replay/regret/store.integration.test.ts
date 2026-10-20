/**
 * store.integration.test.ts — regret-findings SQL over migration 248
 * (self-learning-frontier P-021 / FB-07). Provisions a throwaway DB with the
 * full live schema (provisionGymDatabase applies 000-baseline + every pending
 * migration, so 248's regret_findings exists), then round-trips:
 *
 *   - upsertFinding semantics: detection columns refresh on re-mine, but
 *     replay results and the filed-report id CARRY FORWARD (paid-for work
 *     never regresses — the FB-04 rule);
 *   - the pending → replayed → filed lifecycle reads
 *     (listKnownRunIds / readPendingReplay / readUnfiledReplayed);
 *   - readSelectionRows over real spawned_agents ⋈ harness_run_output ⋈
 *     harness_features_consolidated rows (LEFT-join tolerance for missing
 *     usage samples).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config/pg';
import { provisionGymDatabase } from '../../gym/gym-db-init';
import {
  listKnownRunIds,
  markReportFiled,
  readPendingReplay,
  readSelectionRows,
  readTranscriptBody,
  readUnfiledReplayed,
  recordReplayScores,
  upsertFinding,
  type RegretFindingRecord,
} from './store';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `regret_${randomBytes(5).toString('hex')}`;
const WS = 'ws-regret-test';

function finding(over: Partial<RegretFindingRecord> = {}): RegretFindingRecord {
  return {
    workspaceId: WS,
    runId: 'run-1',
    harnessSlug: 'papercup',
    role: 'worker',
    badnessScore: 0.45,
    badnessReasons: ['status-failed', 'timeout-rc124'],
    divergenceTurn: 3,
    divergenceKind: 'error-loop',
    divergenceEvidence: { runLength: 4, tools: ['Bash'] },
    candidateChanges: [
      { id: 'stop-retry-ladder', title: 'Stop retrying', promptDelta: 'HARD RULE: stop.', rationale: 'r', fromTurn: 3 },
    ],
    replayStatus: 'pending',
    replayScores: null,
    reportImprovementId: null,
    minedAt: '2026-06-12T10:00:00.000Z',
    ...over,
  };
}

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

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
  // Best-effort: the reused test container is shared across vitest processes
  // on the dev box — a concurrent suite's teardown can stop it first (404).
  if (!process.env.KEEP_TEST_PG) await teardownTestPg().catch(() => {});
});

describe('regret_findings lifecycle (migration 248)', () => {
  it('upserts a finding and reads it back through the pending queue', async () => {
    await upsertFinding(sql, finding());
    expect(await listKnownRunIds(sql, WS)).toEqual(new Set(['run-1']));
    const pending = await readPendingReplay(sql, WS, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      runId: 'run-1',
      divergenceTurn: 3,
      divergenceKind: 'error-loop',
      badnessReasons: ['status-failed', 'timeout-rc124'],
      replayStatus: 'pending',
    });
    expect(pending[0].candidateChanges[0].id).toBe('stop-retry-ladder');
  });

  it('replay scores flip the row to replayed; a re-mine NEVER regresses them', async () => {
    await recordReplayScores(sql, WS, 'run-1', [
      { candidateId: 'stop-retry-ladder', improvementScore: 0.4, summary: 'better', costUsd: 0.2 },
    ]);
    expect(await readPendingReplay(sql, WS, 10)).toHaveLength(0);

    // Re-mine upsert (detection refresh, incoming status pending, no scores).
    await upsertFinding(sql, finding({ badnessScore: 0.6, badnessReasons: ['status-failed'] }));
    const rows = await readUnfiledReplayed(sql, WS, 10, 0.1);
    expect(rows).toHaveLength(1);
    expect(rows[0].badnessScore).toBeCloseTo(0.6); // detection refreshed
    expect(rows[0].replayStatus).toBe('replayed'); // replay survived
    expect(rows[0].replayScores?.[0]).toMatchObject({ improvementScore: 0.4 });
  });

  it('a filed report id sticks and removes the row from the filing queue', async () => {
    await markReportFiled(sql, WS, 'run-1', 'EI-901');
    expect(await readUnfiledReplayed(sql, WS, 10, 0.1)).toHaveLength(0);
    // Carry-forward across yet another re-mine.
    await upsertFinding(sql, finding());
    const known = await listKnownRunIds(sql, WS);
    expect(known.has('run-1')).toBe(true);
    expect(await readUnfiledReplayed(sql, WS, 10, 0.1)).toHaveLength(0);
  });

  it('filters filing eligibility before LIMIT so unscored FIFO rows cannot starve scored findings', async () => {
    for (let i = 1; i <= 3; i++) {
      await upsertFinding(
        sql,
        finding({
          runId: `run-unscored-${i}`,
          replayStatus: 'replayed',
          replayScores: null,
          minedAt: `2026-06-12T10:0${i}:00.000Z`,
        }),
      );
    }
    await upsertFinding(
      sql,
      finding({
        runId: 'run-eligible-after-unscored',
        replayStatus: 'replayed',
        replayScores: [{ candidateId: 'stop-retry-ladder', improvementScore: 0.4, summary: 'better', costUsd: 0.2 }],
        minedAt: '2026-06-12T11:00:00.000Z',
      }),
    );

    const rows = await readUnfiledReplayed(sql, WS, 1, 0.1);
    expect(rows.map((row) => row.runId)).toEqual(['run-eligible-after-unscored']);
  });

  it('a skipped (no-divergence) finding never enters the pending queue', async () => {
    await upsertFinding(
      sql,
      finding({ runId: 'run-2', divergenceTurn: null, divergenceKind: null, replayStatus: 'skipped', candidateChanges: [] }),
    );
    const pending = await readPendingReplay(sql, WS, 10);
    expect(pending.map((r) => r.runId)).not.toContain('run-2');
  });
});

describe('readSelectionRows (spawned_agents ⋈ run_output ⋈ features)', () => {
  it('joins terminal spawns with transcript size and bounce attempts; LEFT-tolerates missing usage', async () => {
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, attempts)
      VALUES (${WS}, 'papercup', 'F-001', 'bounced feature', 'failing', 3)`;
    await sql`
      INSERT INTO harness_shared.spawned_agents
        (spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id, feature_id, status, exit_code, duration_ms, started_at)
      VALUES ('sp-1', ${WS}, 'papercup', 'mug', 'worker', 'sel-run-1', 'F-001', 'failed', 124, 120000, now() - interval '1 day')`;
    await sql`
      INSERT INTO harness_shared.harness_run_output
        (workspace_id, harness_slug, run_id, role, jsonl_body, started_at, ended_at)
      VALUES (${WS}, 'papercup', 'sel-run-1', 'worker', '{"type":"assistant"}', 1, 2)`;

    const rows = await readSelectionRows(sql, WS, 7);
    const row = rows.find((r) => r.runId === 'sel-run-1');
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      harnessSlug: 'papercup',
      role: 'worker',
      status: 'failed',
      exitCode: 124,
      featureAttempts: 3,
      costUsd: null, // no usage samples — LEFT join tolerated
    });
    expect(row!.transcriptBytes).toBe('{"type":"assistant"}'.length);
    expect(await readTranscriptBody(sql, 'sel-run-1')).toBe('{"type":"assistant"}');
    expect(await readTranscriptBody(sql, 'missing-run')).toBeNull();
  });

  it('excludes spawns outside the window and non-terminal statuses', async () => {
    await sql`
      INSERT INTO harness_shared.spawned_agents
        (spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id, status, started_at)
      VALUES ('sp-old', ${WS}, 'papercup', 'mug', 'worker', 'sel-run-old', 'failed', now() - interval '30 days'),
             ('sp-live', ${WS}, 'papercup', 'mug', 'worker', 'sel-run-live', 'running', now())`;
    const rows = await readSelectionRows(sql, WS, 7);
    const ids = rows.map((r) => r.runId);
    expect(ids).not.toContain('sel-run-old');
    expect(ids).not.toContain('sel-run-live');
  });
});
