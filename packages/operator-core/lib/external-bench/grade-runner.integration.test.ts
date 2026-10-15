/**
 * Integration test for the grade trigger (P-010) against a real (testcontainer)
 * Postgres. Uses an INJECTED grader (the real path needs docker) to prove the
 * orchestration: status → grading → done, and the verdict map is persisted to the
 * per-task rows + rolled up into resolvedCount/gradedCount via applyGradeMap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { OrgSql } from './reproducibility/db';

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

import { gradeBenchRun, type GradeArgs } from './grade-runner';
import { upsertBenchRun, upsertBenchRunTask, getBenchRunDetail } from './run-store';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { canonicalJson } from './reproducibility/canonical-json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const WS = 'bench-grade-test-ws';

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
  db = await createFreshPgDb('benchgrade');
  sql = db.sql as unknown as OrgSql;
  await db.sql.unsafe(migrationSql('296-bench-run-operational-store.sql'));
  await db.sql.unsafe(migrationSql('298-bench-run-infra-excluded.sql'));
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

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.bench_runs WHERE workspace_id = ${WS}`;
});

describe('gradeBenchRun (P-010)', () => {
  function currentConfig() {
    const protocol = currentProtocolFixture('current-grade-fixture');
    const images = { t1: `docker.io/jefzda/sweap-images@sha256:${'a'.repeat(64)}` };
    protocol.grader = { family: 'swe-bench-pro', version: 'b'.repeat(40), datasetSha256: 'c'.repeat(64), images,
      imageDigest: createHash('sha256').update(canonicalJson(images)).digest('hex') };
    return { protocol, current: { workspaceId: WS, protocolRunId: protocol.runId, preregHash: 'd'.repeat(64), seed: 1 } };
  }

  it('passes verified committed current grader pins to the scorer before recording a verdict', async () => {
    const config = currentConfig();
    await upsertBenchRun({ id: 'current-grade', arm: 'baseline', suite: 'swe-bench-pro', taskSetId: 'custom',
      model: 'configured-alias', status: 'done', config, taskCount: 1 }, scope);
    await upsertBenchRunTask('current-grade', { instanceId: 't1', taskStatus: 'collected', diffBytes: 100 }, scope);
    const verify = vi.fn(async () => ({ preregHash: config.current.preregHash, gitCommitSha: 'e'.repeat(40), receiptRef: 'prereg:test' }));
    const grade = vi.fn(async (_args: GradeArgs) => {
      expect(verify).toHaveBeenCalledOnce(); return { t1: true };
    });
    const result = await gradeBenchRun('current-grade', { scope, grade, verifyCurrentPreregistration: verify });
    if ('error' in result) throw new Error(result.error);
    await result.done;
    expect(grade.mock.calls[0][0]).toMatchObject({ frozenGrader: config.protocol.grader });
    expect((await getBenchRunDetail('current-grade', scope))?.resolvedCount).toBe(1);
  });

  it.each(['manifest', 'missing-images', 'scope', 'seed', 'uncommitted'])(
    'refuses current %s drift without calling the scorer or writing grades', async changed => {
      const config = currentConfig();
      if (changed === 'manifest') config.protocol.grader.imageDigest = 'f'.repeat(64);
      if (changed === 'missing-images') delete config.protocol.grader.images;
      if (changed === 'scope') config.current.workspaceId = 'foreign-workspace';
      if (changed === 'seed') config.current.seed = 2;
      await upsertBenchRun({ id: 'current-refused', arm: 'baseline', suite: 'swe-bench-pro', taskSetId: 'custom',
        model: 'configured-alias', status: 'done', config, taskCount: 1 }, scope);
      await upsertBenchRunTask('current-refused', { instanceId: 't1', taskStatus: 'collected', diffBytes: 100 }, scope);
      const grade = vi.fn(async () => ({ t1: true }));
      const verify = vi.fn(async () => { throw new Error('Pre-registration is not committed'); });
      const result = await gradeBenchRun('current-refused', { scope, grade, verifyCurrentPreregistration: verify });
      expect(result).toMatchObject({ error: expect.stringContaining('current_grader_protocol') });
      expect(grade).not.toHaveBeenCalled();
      expect((await getBenchRunDetail('current-refused', scope))?.perTask.find(task => task.instanceId === 't1')?.resolved).toBeNull();
    },
  );

  it('refuses out-of-roster current verdicts instead of applying them', async () => {
    const config = currentConfig();
    await upsertBenchRun({ id: 'current-roster', arm: 'baseline', suite: 'swe-bench-pro', taskSetId: 'custom',
      model: 'configured-alias', status: 'done', config, taskCount: 1 }, scope);
    await upsertBenchRunTask('current-roster', { instanceId: 't1', taskStatus: 'collected', diffBytes: 100 }, scope);
    const result = await gradeBenchRun('current-roster', { scope, grade: async () => ({ foreign: true }),
      verifyCurrentPreregistration: async () => ({ preregHash: config.current.preregHash, gitCommitSha: 'e'.repeat(40), receiptRef: 'prereg:test' }) });
    if ('error' in result) throw new Error(result.error);
    await result.done;
    const detail = await getBenchRunDetail('current-roster', scope);
    expect(detail?.status).toBe('error'); expect(detail?.perTask.find(task => task.instanceId === 't1')?.resolved).toBeNull();
    expect(detail?.runError).toContain('frozen task roster');
  });

  it('runs the (injected) grader, persists the verdict map + rolls up resolved counts, status → done', async () => {
    await upsertBenchRun({ id: 'g1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'done' }, scope);
    for (const id of ['instance_a', 'instance_b', 'instance_c']) {
      await upsertBenchRunTask('g1', { instanceId: id, taskStatus: 'collected', diffBytes: 100 }, scope);
    }

    const grade = vi.fn(async () => ({ instance_a: true, instance_b: false, instance_c: true }));
    const res = await gradeBenchRun('g1', { scope, grade });
    expect('runId' in res).toBe(true);
    if ('error' in res) throw new Error(res.error);
    await res.done;

    expect(grade).toHaveBeenCalledTimes(1);
    const detail = await getBenchRunDetail('g1', scope);
    expect(detail!.status).toBe('done');
    expect(detail!.gradedCount).toBe(3);
    expect(detail!.resolvedCount).toBe(2);
    expect(detail!.resolvedPct).toBeCloseTo(2 / 3);
    const a = detail!.perTask.find((t) => t.instanceId === 'instance_a')!;
    expect(a.resolved).toBe(true);
    const b = detail!.perTask.find((t) => t.instanceId === 'instance_b')!;
    expect(b.resolved).toBe(false);
  });

  it('a grader failure marks the run status=error (does not silently pass)', async () => {
    await upsertBenchRun({ id: 'g2', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'done' }, scope);
    await upsertBenchRunTask('g2', { instanceId: 'instance_a', taskStatus: 'collected' }, scope);
    const grade = vi.fn(async () => {
      throw new Error('docker not available');
    });
    const res = await gradeBenchRun('g2', { scope, grade });
    if ('error' in res) throw new Error(res.error);
    await res.done;
    const detail = await getBenchRunDetail('g2', scope);
    expect(detail!.status).toBe('error');
    expect(detail!.runError).toMatch(/grade failed/);
  });

  it('returns run_not_found for an unknown run', async () => {
    const res = await gradeBenchRun('nope', { scope, grade: async () => ({}) });
    expect(res).toEqual({ error: 'run_not_found' });
  });
});
