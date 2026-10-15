/**
 * Integration tests for the operational bench-run store (P-002) against a real
 * (testcontainer) Postgres: migration 296 applies; the live write path
 * (upsertBenchRun → tasks → events) is readable via getBenchRunDetail in the
 * PreservedArmRun shape; the grade map + rollup fill graded/resolved counts; and
 * the one-way file-dir → store import reproduces a preserved run as a row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { OrgSql } from './reproducibility/db';

// The store fires notifySyncInvalidate on every write — that hits the global org
// pool (no operator in a unit run). Stub it so the test exercises only the
// injected sql.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

import {
  upsertBenchRun,
  setBenchRunHive,
  upsertBenchRunTask,
  taskRowFromFleetResult,
  appendBenchRunEvents,
  setBenchRunEvents,
  setBenchRunStatus,
  applyGradeMap,
  listBenchRuns,
  getBenchRunDetail,
  importPreservedRunToStore,
  importAllPreservedRuns,
  rollupBenchRunMetrics,
} from './run-store';
import type { FleetTaskResult } from './hive-backlog';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const WS = 'bench-store-test-ws';

function migrationSql(file: string): string {
  return readFileSync(resolve(SQL_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');
}

let db: FreshPgDb;
let sql: OrgSql;
let scope: { sql: OrgSql; workspaceId: string };

beforeAll(async () => {
  db = await createFreshPgDb('benchstore');
  sql = db.sql as unknown as OrgSql;
  await db.sql.unsafe(migrationSql('296-bench-run-operational-store.sql'));
  await db.sql.unsafe(migrationSql('298-bench-run-infra-excluded.sql'));
  const archiveMigration = '1434-benchmark-ungraded-archive-state.sql';
  await db.sql.unsafe(migrationSql(existsSync(resolve(SQL_DIR, archiveMigration))
    ? archiveMigration : `${archiveMigration}.DRAFT`));
  // D-007 pot-rename: mig 296 creates bench_runs.hive_slug; mig 523 renamed it → pot_slug.
  // Replaying only 296/298 predates the rename, so apply it in-place to match the write path.
  await db.sql.unsafe(`ALTER TABLE harness_shared.bench_runs RENAME COLUMN hive_slug TO pot_slug`);
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.bench_runs       DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.bench_run_tasks  DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.bench_run_events DISABLE ROW LEVEL SECURITY;
  `);
  scope = { sql, workspaceId: WS };
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

function fleetResult(instanceId: string, diff: string, costUsd: number): FleetTaskResult {
  return {
    attempt: {
      arm: 'hive-realqueen',
      blueprintId: 'external-bench',
      instanceId,
      seed: '1',
      diff,
      tokensIn: 1000,
      tokensOut: 5000,
      costUsd,
      turns: 3,
      wallClockMs: 60_000,
      trajectoryRef: '',
      stopReason: 'done',
    },
    cupId: `bee-${instanceId}`,
    placedAtMs: 1,
    startedAtMs: 2,
    finishedAtMs: 3,
    disposition: 'spawn',
  } as unknown as FleetTaskResult;
}

describe('bench run-store (live write + read)', () => {
  it('serializes concurrent sequence allocation over real PostgreSQL', async () => {
    const runId = 'concurrent-event-append';
    await upsertBenchRun({ id: runId, arm: 'papercusp', taskSetId: 'fixture', model: 'fixture' }, scope);
    // Hold both unprotected reads at the same frontier. Transaction-local SQL
    // keeps its normal behavior, so a serialized implementation never needs
    // the barrier. This makes the old race reproducible without timing sleeps.
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    const concurrentSql = new Proxy(sql, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        if (Array.isArray(args[0]) && args[0].join('').includes('MAX(seq)')) {
          return Promise.resolve(result).then(async rows => {
            if (++reads === 2) release();
            await bothRead;
            return rows;
          });
        }
        return result;
      },
    });
    await Promise.all(['first', 'second'].map(agent => appendBenchRunEvents(
      runId, [{ kind: 'placement', agent }], { ...scope, sql: concurrentSql },
    )));
    const rows = await sql<{ seq: number; agent: string }[]>`
      SELECT seq, agent FROM harness_shared.bench_run_events
       WHERE run_id = ${runId} AND workspace_id = ${WS} ORDER BY seq
    `;
    expect(rows.map(row => Number(row.seq))).toEqual([0, 1]);
    expect(rows.map(row => row.agent).sort()).toEqual(['first', 'second']);
  });

  it('shares one serialization boundary for append and whole-trace replacement', async () => {
    const runId = 'concurrent-event-replacement';
    await upsertBenchRun({ id: runId, arm: 'papercusp', taskSetId: 'fixture', model: 'fixture' }, scope);
    await appendBenchRunEvents(runId, [{ kind: 'placement', agent: 'old' }], scope);
    await Promise.all([
      setBenchRunEvents(runId, [{ kind: 'placement', agent: 'replacement' }], scope),
      ...Array.from({ length: 12 }, (_, i) => appendBenchRunEvents(
        runId, [{ kind: 'placement', agent: `append-${i}` }], scope,
      )),
    ]);
    const rows = await sql<{ seq: number; agent: string }[]>`
      SELECT seq, agent FROM harness_shared.bench_run_events
       WHERE run_id = ${runId} AND workspace_id = ${WS} ORDER BY seq
    `;
    // Replacement may precede or follow any append. Either order must replay
    // as one contiguous trace starting with the replacement, without duplicates.
    expect(rows[0]?.agent).toBe('replacement');
    expect(rows.map(row => Number(row.seq))).toEqual(rows.map((_, i) => i));
    expect(new Set(rows.map(row => row.agent)).size).toBe(rows.length);
  });

  it('refuses event writes for a missing or foreign-workspace run', async () => {
    const runId = 'event-write-workspace-scope';
    await upsertBenchRun({ id: runId, arm: 'papercusp', taskSetId: 'fixture', model: 'fixture' }, scope);
    await appendBenchRunEvents(runId, [{ kind: 'placement', agent: 'retained' }], scope);
    for (const input of [
      { runId, scope: { ...scope, workspaceId: 'other-workspace' } },
      { runId: 'absent-run', scope },
    ]) {
      await expect(appendBenchRunEvents(input.runId, [{ kind: 'placement' }], input.scope)).rejects.toThrow(/workspace/);
      await expect(setBenchRunEvents(input.runId, [], input.scope)).rejects.toThrow(/workspace/);
    }
    expect((await getBenchRunDetail(runId, scope))!.run.coordEvents?.map(event => event.agent)).toEqual(['retained']);
  });

  it('writes a run + tasks + events and reads them back in the PreservedArmRun shape', async () => {
    await upsertBenchRun(
      { id: 'r1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', config: { cap: 5 } },
      scope,
    );
    await setBenchRunHive('r1', 'hive-abc', scope);
    // A live "todo" task, then two collected results.
    await upsertBenchRunTask('r1', { instanceId: 'instance_a', taskStatus: 'in_progress', cupId: 'bee-a' }, scope);
    await upsertBenchRunTask('r1', taskRowFromFleetResult(fleetResult('instance_a', 'diff a', 5.5)), scope);
    await upsertBenchRunTask('r1', taskRowFromFleetResult(fleetResult('instance_b', '', 2.0)), scope);
    await appendBenchRunEvents(
      'r1',
      [
        { kind: 'placement', agent: 'bee-a', taskId: 'instance_a', detail: 'placed' },
        { kind: 'complete', agent: 'bee-a', taskId: 'instance_a' },
      ],
      scope,
    );

    const detail = await getBenchRunDetail('r1', scope);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('running');
    expect(detail!.potSlug).toBe('hive-abc');
    expect(detail!.arm).toBe('hive-realqueen');
    expect(detail!.config).toEqual({ cap: 5 });
    expect(detail!.perTask).toHaveLength(2);
    expect(detail!.run.coordEvents).toHaveLength(2);
    // The collected result is authoritative — its cupId overwrote the live placeholder.
    const a = detail!.perTask.find((t) => t.instanceId === 'instance_a')!;
    expect(a.cupId).toBe('bee-instance_a');
    expect(a.costUsd).toBe(5.5);
    expect(a.diffBytes).toBeGreaterThan(0);

    // A later PARTIAL upsert (just a status flip, no metrics) must NOT wipe the
    // collected fields — COALESCE preserves them.
    await upsertBenchRunTask('r1', { instanceId: 'instance_a', taskStatus: 'collected' }, scope);
    const after = await getBenchRunDetail('r1', scope);
    const a2 = after!.perTask.find((t) => t.instanceId === 'instance_a')!;
    expect(a2.cupId).toBe('bee-instance_a');
    expect(a2.costUsd).toBe(5.5);
    // Not graded yet → resolved null, summary has nothing graded.
    expect(a.resolved).toBeNull();
    expect(detail!.summary.gradedCount).toBe(0);
    expect(detail!.summary.nonEmptyDiffs).toBe(1); // only instance_a had a diff
    expect(detail!.coordRates).toBeTruthy();
  });

  it('applies a grade map + rolls up resolved/graded counts', async () => {
    await applyGradeMap('r1', { instance_a: true, instance_b: false }, scope);
    const detail = await getBenchRunDetail('r1', scope);
    expect(detail!.gradedCount).toBe(2);
    expect(detail!.resolvedCount).toBe(1);
    expect(detail!.resolvedPct).toBeCloseTo(0.5);
    expect(detail!.summary.resolvedPct).toBeCloseTo(0.5);
    const a = detail!.perTask.find((t) => t.instanceId === 'instance_a')!;
    expect(a.resolved).toBe(true);
  });

  it('transitions status + stamps finished_at', async () => {
    await setBenchRunStatus('r1', 'done', {}, scope);
    const detail = await getBenchRunDetail('r1', scope);
    expect(detail!.status).toBe('done');
    expect(detail!.finishedAt).not.toBeNull();
  });

  it('lists runs newest-first', async () => {
    const runs = await listBenchRuns(scope);
    expect(runs.some((r) => r.id === 'r1')).toBe(true);
  });
});

describe('rollupBenchRunMetrics — fairness exclusion (benchmark-fairness-fix)', () => {
  it('EXCLUDES external/transient/infra tasks from the resolved% denominator + counts them separately', async () => {
    await upsertBenchRun(
      { id: 'fair1', arm: 'hive-realqueen', taskSetId: 'custom:5-task', model: 'opus', status: 'running' },
      scope,
    );
    // 5 tasks: 2 scored-resolved, 1 scored-fail, 1 wall-clock timeout, 1 infra-failed (429/contention).
    await upsertBenchRunTask('fair1', { instanceId: 'ok-1', taskStatus: 'graded', resolved: true, stopReason: 'done', diffBytes: 100, costUsd: 4 }, scope);
    await upsertBenchRunTask('fair1', { instanceId: 'ok-2', taskStatus: 'graded', resolved: true, stopReason: 'done', diffBytes: 100, costUsd: 4 }, scope);
    await upsertBenchRunTask('fair1', { instanceId: 'fail-1', taskStatus: 'graded', resolved: false, stopReason: 'escalate', diffBytes: 100, costUsd: 4 }, scope);
    await upsertBenchRunTask('fair1', { instanceId: 'timeout-1', taskStatus: 'collected', resolved: null, stopReason: 'timeout', diffBytes: 0, costUsd: 4, generationError: 'wall-clock ceiling' }, scope);
    await upsertBenchRunTask('fair1', { instanceId: 'infra-1', taskStatus: 'collected', resolved: null, stopReason: 'infra-failed', diffBytes: 0, costUsd: 4, generationError: '429 contention' }, scope);

    await rollupBenchRunMetrics('fair1', scope);
    const runs = await listBenchRuns(scope);
    const r = runs.find((x) => x.id === 'fair1')!;
    expect(r.taskCount).toBe(5);
    expect(r.gradedCount).toBe(3); // ONLY the scored tasks — infra/timeout EXCLUDED from the denominator
    expect(r.resolvedCount).toBe(2);
    expect(r.infraExcluded).toBe(2); // timeout-1 + infra-1, surfaced separately
    expect(r.resolvedPct).toBeCloseTo(2 / 5, 5);
    expect(r.conditionalResolvedPct).toBeCloseTo(2 / 3, 5);
    // Cost still counts EVERY task (a crashed/throttled run still spent real tokens — honest cost).
    expect(r.costUsd).toBeCloseTo(20, 5);
  });

  it('a grader-manufactured (false) verdict on an infra row is NOT counted as a capability fail', async () => {
    await upsertBenchRun({ id: 'fair2', arm: 'su-independent', taskSetId: 'custom:2-task', model: 'opus' }, scope);
    await upsertBenchRunTask('fair2', { instanceId: 'ok', taskStatus: 'graded', resolved: true, stopReason: 'done', costUsd: 1 }, scope);
    // The grade map applied resolved=false, but the row also carries a non-scored stopReason → excluded.
    await upsertBenchRunTask('fair2', { instanceId: 'infra', taskStatus: 'graded', resolved: false, stopReason: 'infra-failed', generationError: 'spawn 429', costUsd: 1 }, scope);
    await rollupBenchRunMetrics('fair2', scope);
    const r = (await listBenchRuns(scope)).find((x) => x.id === 'fair2')!;
    expect(r.gradedCount).toBe(1); // only the genuine 'done' row
    expect(r.resolvedCount).toBe(1);
    expect(r.infraExcluded).toBe(1);
    expect(r.resolvedPct).toBe(1 / 2);
    expect(r.conditionalResolvedPct).toBe(1);
  });
});

describe('assigned task scoring across store readers', () => {
  it('retains the declared task set after partial collection and grader repair', async () => {
    await upsertBenchRun({ id: 'assigned', arm: 'su', taskSetId: 'custom:5-task', model: 'sol',
      taskCount: 5, config: { taskIds: ['a', 'b', 'c', 'd', 'e'] } }, scope);
    await upsertBenchRunTask('assigned', { instanceId: 'a', taskStatus: 'collected', stopReason: 'done',
      generationError: '', costUsd: 1 }, scope);
    await upsertBenchRunTask('assigned', { instanceId: 'b', taskStatus: 'collected', stopReason: 'timeout',
      generationError: 'budget ceiling', costUsd: 2 }, scope);
    await rollupBenchRunMetrics('assigned', scope);
    const before = (await listBenchRuns(scope)).find(row => row.id === 'assigned')!;
    expect(before).toMatchObject({ taskCount: 5, attemptedCount: 2, absentCount: 3,
      missingGradeCount: 1, measurementComplete: false, resolvedPct: null, costUsd: 3 });
    expect((await getBenchRunDetail('assigned', scope))!.summary).toMatchObject({
      taskCount: 5, missingGradeCount: 1, resolvedPct: null });
    await applyGradeMap('assigned', { a: true }, scope);
    const after = (await listBenchRuns(scope)).find(row => row.id === 'assigned')!;
    const detail = (await getBenchRunDetail('assigned', scope))!;
    expect(after).toMatchObject({ taskCount: 5, gradedCount: 1, resolvedCount: 1,
      resolvedPct: 0.2, conditionalResolvedPct: 1, missingGradeCount: 0, infraExcluded: 1 });
    expect(detail.resolvedPct).toBe(after.resolvedPct);
    expect(detail.summary.resolvedPct).toBe(after.resolvedPct);
    expect(detail.summary.conditionalResolvedPct).toBe(after.conditionalResolvedPct);
  });
});

describe('bench run-store (file-dir import)', () => {
  let baseDir: string;
  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'bench-import-'));
    const runDir = join(baseDir, 'preserved-run');
    mkdirSync(join(runDir, 'grade-hive-realqueen', 'out'), { recursive: true });
    const armRun = {
      arm: 'hive-realqueen',
      runId: 'preserved-run-orig',
      startedAt: '2026-06-16T04:47:56.836Z',
      finishedAt: '2026-06-16T05:00:00.000Z',
      model: 'provider-model-frozen-version',
      suite: 'swe-bench-pro',
      wallMs: 0,
      peakConcurrentBees: 3,
      taskCount: 2,
      nonEmptyDiffs: 1,
      totals: { costUsd: 7.5, tokensIn: 6000, tokensOut: 60000 },
      perTask: [
        { instanceId: 'instance_x', cupId: 'b1', disposition: 'spawn', stopReason: 'done', tokensIn: 3000, tokensOut: 30000, costUsd: 5, turns: 1, wallClockMs: 0, diffBytes: 100 },
        { instanceId: 'instance_y', cupId: 'b2', disposition: 'spawn', stopReason: 'no-diff', tokensIn: 3000, tokensOut: 30000, costUsd: 2.5, turns: 1, wallClockMs: 0, diffBytes: 0 },
      ],
      coordEvents: [
        { ts: 1, kind: 'placement', agent: 'b1', taskId: 'instance_x', detail: 'placed' },
        { ts: 2, kind: 'complete', agent: 'b1', taskId: 'instance_x' },
      ],
      recovered: true,
    };
    writeFileSync(join(runDir, 'hive-realqueen.json'), JSON.stringify(armRun), 'utf8');
    writeFileSync(
      join(runDir, 'grade-hive-realqueen', 'out', 'eval_results.json'),
      JSON.stringify({ instance_x: true, instance_y: false }),
      'utf8',
    );
  });
  afterAll(() => rmSync(baseDir, { recursive: true, force: true }));

  it('imports a preserved file-dir run into the store with grader verdicts merged', async () => {
    const res = await importPreservedRunToStore('preserved-run', { ...scope, baseDir });
    expect(res.imported).toBe(true);

    const detail = await getBenchRunDetail('preserved-run', scope);
    expect(detail).not.toBeNull();
    expect(detail!.source).toBe('import');
    expect(detail!.status).toBe('done');
    expect(detail!.arm).toBe('hive-realqueen');
    expect(detail!.model).toBe('provider-model-frozen-version');
    expect(detail!.suite).toBe('swe-bench-pro');
    expect(new Date(detail!.finishedAt!).toISOString()).toBe('2026-06-16T05:00:00.000Z');
    expect(detail!.config?.importedAt).toEqual(expect.any(String));
    expect(detail!.recovered).toBe(true);
    expect(detail!.taskSetId).toBe('custom:2-task');
    expect(detail!.perTask).toHaveLength(2);
    expect(detail!.gradedCount).toBe(2);
    expect(detail!.resolvedCount).toBe(1);
    expect(detail!.resolvedPct).toBeCloseTo(0.5);
    expect(detail!.run.coordEvents).toHaveLength(2);
    const x = detail!.perTask.find((t) => t.instanceId === 'instance_x')!;
    expect(x.resolved).toBe(true);
    const y = detail!.perTask.find((t) => t.instanceId === 'instance_y')!;
    expect(y.resolved).toBe(false);
    expect(detail!.summary.costUsd).toBeCloseTo(7.5);
  });

  it('re-import is idempotent (same row, no dupes)', async () => {
    const before = await getBenchRunDetail('preserved-run', scope);
    await importPreservedRunToStore('preserved-run', { ...scope, baseDir });
    const detail = await getBenchRunDetail('preserved-run', scope);
    expect(detail!.perTask).toHaveLength(2);
    expect(detail!.run.coordEvents).toHaveLength(2);
    expect(new Date(detail!.finishedAt!).toISOString()).toBe(new Date(before!.finishedAt!).toISOString());
  });

  it('keeps a valid archive without grades explicitly ungraded and its model unknown', async () => {
    const dir = join(baseDir, 'ungraded-run');
    mkdirSync(dir);
    writeFileSync(join(dir, 'arm.json'), JSON.stringify({ arm: 'solo', perTask: [{ instanceId: 'ungraded-task' }] }));
    expect((await importPreservedRunToStore('ungraded-run', { ...scope, baseDir })).imported).toBe(true);
    const detail = await getBenchRunDetail('ungraded-run', scope);
    expect(detail!.status).toBe('ungraded');
    expect(detail!.gradedCount).toBe(0);
    expect(detail!.model).toBe('unknown');
    expect(detail!.suite).toBe('unknown');
    expect(detail!.startedAt).toBeNull();
    expect(detail!.finishedAt).toBeNull();
  });

  it('marks an archive with only some task grades ungraded', async () => {
    const dir = join(baseDir, 'partial-grade-run');
    mkdirSync(join(dir, 'grade-solo', 'out'), { recursive: true });
    writeFileSync(join(dir, 'solo.json'), JSON.stringify({ arm: 'solo', perTask: [{ instanceId: 'first' }, { instanceId: 'second' }] }));
    writeFileSync(join(dir, 'grade-solo', 'out', 'eval_results.json'), JSON.stringify({ first: true }));
    await importPreservedRunToStore('partial-grade-run', { ...scope, baseDir });
    const detail = await getBenchRunDetail('partial-grade-run', scope);
    expect(detail!.status).toBe('ungraded');
    expect(detail!.gradedCount).toBe(1);
    expect(detail!.perTask.find((task) => task.instanceId === 'second')!.resolved).toBeNull();
  });

  it('repairs former dataset-only imports without altering a same-shaped UI run', async () => {
    for (const source of ['import', 'ui'] as const) {
      const id = `dataset-${source}`;
      const dir = join(baseDir, id);
      mkdirSync(dir);
      writeFileSync(join(dir, 'summary.json'), JSON.stringify({ instances: 103 }));
      await upsertBenchRun({ id, arm: 'unknown', model: 'opus', taskSetId: 'dataset', source, status: 'done' }, scope);
      expect((await importPreservedRunToStore(id, { ...scope, baseDir })).imported).toBe(false);
      const detail = await getBenchRunDetail(id, scope);
      expect(detail!.status).toBe(source === 'import' ? 'error' : 'done');
      expect(detail!.runError).toBe(source === 'import' ? 'archive_not_a_run:no_task_submission_records' : null);
    }
  });

  it('does not overwrite known archived history when the source evidence is unavailable', async () => {
    const before = await getBenchRunDetail('preserved-run', scope);
    expect((await importPreservedRunToStore('preserved-run', { ...scope, baseDir: join(baseDir, 'absent') })).imported).toBe(false);
    const after = await getBenchRunDetail('preserved-run', scope);
    expect(after!.status).toBe('done');
    expect(new Date(after!.finishedAt!).toISOString()).toBe(new Date(before!.finishedAt!).toISOString());
  });
});

// A preserved run whose arm JSON OMITS the `arm` field passed `undefined` to the
// upsert → postgres-js `UNDEFINED_VALUE: Undefined values are not allowed` →
// importAllPreservedRuns threw and the WHOLE boot-time backfill aborted (the
// Evaluation Compare view stayed empty). importPreservedRunToStore now coerces the
// missing arm to a placeholder and importAllPreservedRuns isolates per-run failures
// so one bad dir can't sink the batch.
describe('importAllPreservedRuns — resilient to a malformed run (missing arm) [EI: bench-import]', () => {
  let baseDir: string;
  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'bench-import-malformed-'));
    const okDir = join(baseDir, 'ok-run');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(
      join(okDir, 'hive-realqueen.json'),
      JSON.stringify({
        arm: 'hive-realqueen',
        runId: 'ok-run-orig',
        taskCount: 1,
        perTask: [{ instanceId: 'inst_ok', costUsd: 1, tokensIn: 10, tokensOut: 10, turns: 1, wallClockMs: 0, diffBytes: 5 }],
        recovered: false,
      }),
      'utf8',
    );
    // The malformed run: arm JSON has NO `arm` key (the production failure mode).
    const badDir = join(baseDir, 'bad-run');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, 'hive-noarm.json'),
      JSON.stringify({
        runId: 'bad-run-orig',
        taskCount: 1,
        perTask: [{ instanceId: 'inst_bad', costUsd: 1, tokensIn: 10, tokensOut: 10, turns: 1, wallClockMs: 0, diffBytes: 5 }],
        recovered: false,
      }),
      'utf8',
    );
  });
  afterAll(() => rmSync(baseDir, { recursive: true, force: true }));

  it('imports BOTH runs without throwing; the missing-arm run gets a placeholder arm (pre-fix: whole batch threw)', async () => {
    const res = await importAllPreservedRuns({ ...scope, baseDir });
    expect(res.imported.sort()).toEqual(['bad-run', 'ok-run']);
    expect(res.skipped).toEqual([]);

    expect((await getBenchRunDetail('ok-run', scope))!.arm).toBe('hive-realqueen');
    const bad = await getBenchRunDetail('bad-run', scope);
    expect(bad!.arm).toBe('unknown'); // coerced placeholder, not undefined
    expect(bad!.perTask).toHaveLength(1);
  });
});
