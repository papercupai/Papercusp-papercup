/**
 * fallback-observations against real Postgres, ACROSS PROCESSES
 * (degradation-signals-on-condition-rail-2026-10-11 P-002, BAR R-1, D-001).
 *
 * The whole point of the durable table is that a decision recorded in one
 * process (a gate child) is visible to the watchdog in another. So the write
 * here happens in a spawned child process through the public writer, and the
 * read happens in this process through the public reader.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../../test/_org-test-db';

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { readFallbackWindow, readFallbackWindowsByScope, pruneFallbackObservations, observeFallback, flushFallbackObservations, fallbackObservationCounters } =
  await import('./fallback-observations');

const MODULE_URL = new URL('./fallback-observations.ts', import.meta.url).href;
const WS = 'ws-fallback-observations-it';
const CORRELATION_ID = '64eab084-4e87-4e2b-99bd-3be2eb7c191f';

/** Run the writer in a separate node process (tsx loader), against `dsn`. */
function writeFromChildProcess(dsn: string): Promise<{ code: number | null; out: string }> {
  const script = `
    import postgres from 'postgres';
    const m = await import(${JSON.stringify(MODULE_URL)});
    const sql = postgres(process.env.FO_DSN, { max: 1, onnotice: () => {} });
    m.observeFallback('gate.pass-reuse', { eligible: 7689, applied: 0, reason: 'proofs-unavailable', scope: 'run-762a13a6' }, { sql, workspaceId: '${WS}', processTag: 'child-' + process.pid, correlationId: ${JSON.stringify(CORRELATION_ID)} });
    m.observeFallback('gate.pass-reuse', { eligible: 11, applied: 0, reason: 'dirty-checkout' }, { sql, workspaceId: '${WS}' });
    m.observeFallback('gate.pass-reuse', { eligible: 300, applied: 300, reason: 'applied' }, { sql, workspaceId: '${WS}' });
    m.observeFallback('other.mechanism', { eligible: 5, applied: 0, reason: 'x' }, { sql, workspaceId: '${WS}' });
    const res = await m.flushFallbackObservations();
    await sql.end({ timeout: 5 });
    process.stdout.write(JSON.stringify({ pid: process.pid, res }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, FO_DSN: dsn },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: out || err }));
  });
}

describe('fallback observations — durable and readable across processes (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('a decision recorded in a child process is returned by the trailing-window reader here', async () => {
    const child = await writeFromChildProcess(db.adminDsn);
    expect(child.code, child.out).toBe(0);
    const reported = JSON.parse(child.out) as { pid: number; res: { written: number; failed: number } };
    expect(reported.pid).not.toBe(process.pid);
    expect(reported.res).toMatchObject({ written: 4, failed: 0 });

    const w = await readFallbackWindow('gate.pass-reuse', 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(w.samples).toBe(3);
    expect(w.eligible).toBe(8_000);
    expect(w.applied).toBe(300);
    expect(w.appliedRate).toBeCloseTo(300 / 8_000, 10);
    expect(w.dominantReason).toBe('proofs-unavailable');
    expect(w.reasons.find((r) => r.reason === 'dirty-checkout')).toMatchObject({ samples: 1, eligible: 11, fellBack: 11 });

    // Mechanisms and workspaces do not bleed into each other.
    const other = await readFallbackWindow('other.mechanism', 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(other.samples).toBe(1);
    const elsewhere = await readFallbackWindow('gate.pass-reuse', 60 * 60 * 1000, { sql: db.adminSql, workspaceId: 'ws-unrelated' });
    expect(elsewhere.samples).toBe(0);

    const rows = await db.adminSql<Array<{ process_tag: string | null; scope: string | null; correlation_id: string | null }>>`
      SELECT process_tag, scope, correlation_id FROM harness_shared.fallback_observations
       WHERE workspace_id = ${WS} AND reason = 'proofs-unavailable'
    `;
    expect(rows).toEqual([{ process_tag: `child-${reported.pid}`, scope: 'run-762a13a6', correlation_id: CORRELATION_ID }]);
  }, 60_000);

  it('the window excludes rows older than windowMs, and pruning removes rows past retention', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.fallback_observations (workspace_id, mechanism, eligible, applied, reason, observed_at)
      VALUES (${WS}, 'aged.mechanism', 4, 0, 'stale', now() - interval '3 days')
    `;
    const recent = await readFallbackWindow('aged.mechanism', 24 * 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(recent.samples).toBe(0);
    const wide = await readFallbackWindow('aged.mechanism', 7 * 24 * 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(wide.samples).toBe(1);

    const deleted = await pruneFallbackObservations({ sql: db.adminSql, retentionMs: 2 * 24 * 60 * 60 * 1000, batchSize: 1 });
    expect(deleted).toBe(1);
    const after = await readFallbackWindow('aged.mechanism', 7 * 24 * 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(after.samples).toBe(0);
    // Recent rows survive the prune.
    const kept = await readFallbackWindow('gate.pass-reuse', 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(kept.samples).toBe(3);
  });

  it('BAR R-12: the default retention bound is 14 days — a 15-day-old row is pruned, a 13-day-old row survives', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.fallback_observations (workspace_id, mechanism, eligible, applied, reason, observed_at)
      VALUES (${WS}, 'retention.default', 1, 0, 'past-bound', now() - interval '15 days'),
             (${WS}, 'retention.default', 1, 0, 'inside-bound', now() - interval '13 days')
    `;
    const deleted = await pruneFallbackObservations({ sql: db.adminSql });
    expect(deleted).toBe(1);
    const left = await db.adminSql<{ reason: string }[]>`
      SELECT reason FROM harness_shared.fallback_observations
       WHERE workspace_id = ${WS} AND mechanism = 'retention.default'
    `;
    expect(left.map((r) => r.reason)).toEqual(['inside-bound']);
  });

  it('coalesced decisions land as ONE row, and both readers count them as their samples (migration 1489)', async () => {
    for (let i = 0; i < 3; i++) {
      observeFallback('coalesce.mechanism', { eligible: 2, applied: 1, reason: 'partial', scope: 'op' }, { sql: db.adminSql, workspaceId: WS });
    }
    observeFallback('coalesce.mechanism', { eligible: 1, applied: 1, reason: 'applied', scope: 'op' }, { sql: db.adminSql, workspaceId: WS });
    expect(await flushFallbackObservations()).toMatchObject({ written: 2, failed: 0 });
    const rows = await db.adminSql<Array<{ reason: string; samples: number; eligible: number; applied: number }>>`
      SELECT reason, samples, eligible, applied FROM harness_shared.fallback_observations
       WHERE workspace_id = ${WS} AND mechanism = 'coalesce.mechanism' ORDER BY reason
    `;
    expect(rows).toEqual([
      { reason: 'applied', samples: 1, eligible: 1, applied: 1 },
      { reason: 'partial', samples: 3, eligible: 6, applied: 3 },
    ]);
    const hour = 60 * 60 * 1000;
    const w = await readFallbackWindow('coalesce.mechanism', hour, { sql: db.adminSql, workspaceId: WS });
    expect(w.samples).toBe(4);
    expect(w.eligible).toBe(7);
    expect(w.reasons.find((r) => r.reason === 'partial')).toMatchObject({ samples: 3, eligible: 6, fellBack: 3 });
    const scoped = await readFallbackWindowsByScope('coalesce.mechanism', hour, { sql: db.adminSql, workspaceId: WS });
    expect(scoped.map((s) => [s.scope, s.window.samples])).toEqual([['op', 4]]);
  });

  it('filters scoped windows by the explicit workspace and producer context', async () => {
    const gateTag = 'gate-reuse:green-checkpoint';
    observeFallback('context-filter', { eligible: 1, applied: 0, reason: 'dirty-checkout', scope: 'shared-task' }, {
      sql: db.adminSql, workspaceId: 'default', processTag: gateTag,
    });
    observeFallback('context-filter', { eligible: 2, applied: 0, reason: 'dirty-checkout', scope: 'shared-task' }, {
      sql: db.adminSql, workspaceId: WS, processTag: 'gate-reuse',
    });
    observeFallback('context-filter', { eligible: 3, applied: 0, reason: 'otherRunner', scope: 'shared-task' }, {
      sql: db.adminSql, workspaceId: 'default', processTag: 'local-check',
    });
    expect(await flushFallbackObservations()).toMatchObject({ written: 3, failed: 0 });

    const scoped = await readFallbackWindowsByScope('context-filter', 60 * 60 * 1000, {
      sql: db.adminSql, workspaceId: 'default', processTag: gateTag,
    });
    const flat = await readFallbackWindow('context-filter', 60 * 60 * 1000, {
      sql: db.adminSql, workspaceId: 'default', processTag: gateTag,
    });
    expect(flat).toMatchObject({ samples: 1, eligible: 1, applied: 0 });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({
      scope: 'shared-task',
      window: { samples: 1, eligible: 1, applied: 0, reasons: [{ reason: 'dirty-checkout', eligible: 1 }] },
    });
  });

  it('BAR R-14: a real PostgreSQL write rejection is non-throwing, counted, and leaves no row', async () => {
    // Calibrate the unit fixture's rejected INSERT against the actual driver and
    // migrated table. This constraint exists only in createOrgTestDb's private DB.
    await db.adminSql`
      ALTER TABLE harness_shared.fallback_observations
      ADD CONSTRAINT fallback_observations_test_write_failure
      CHECK (reason <> 'forced-write-failure')
    `;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = fallbackObservationCounters().failed;
      expect(() => observeFallback('write-rejection', {
        eligible: 2, applied: 0, reason: 'forced-write-failure',
      }, { sql: db.adminSql, workspaceId: WS })).not.toThrow();
      await expect(flushFallbackObservations()).resolves.toMatchObject({ written: 0, failed: 1 });
      expect(fallbackObservationCounters().failed).toBe(before + 1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('fallback_observations_test_write_failure'));

      // Query storage directly so the oracle does not reuse the window reader.
      const rows = await db.adminSql`
        SELECT reason FROM harness_shared.fallback_observations
        WHERE workspace_id = ${WS} AND mechanism = 'write-rejection'
      `;
      expect(rows).toHaveLength(0);

      // The failed batch must not poison the next real write.
      observeFallback('write-rejection', { eligible: 1, applied: 1, reason: 'applied' }, {
        sql: db.adminSql, workspaceId: WS,
      });
      await expect(flushFallbackObservations()).resolves.toMatchObject({ written: 1, failed: 0 });
      const recovered = await db.adminSql`
        SELECT reason, eligible, applied FROM harness_shared.fallback_observations
        WHERE workspace_id = ${WS} AND mechanism = 'write-rejection'
      `;
      expect(recovered).toEqual([{ reason: 'applied', eligible: 1, applied: 1 }]);
      expect(fallbackObservationCounters().failed).toBe(before + 1);
    } finally {
      warning.mockRestore();
      await db.adminSql`
        ALTER TABLE harness_shared.fallback_observations
        DROP CONSTRAINT fallback_observations_test_write_failure
      `;
    }
  });

  it('the table refuses an applied count above eligible', async () => {
    await expect(db.adminSql`
      INSERT INTO harness_shared.fallback_observations (workspace_id, mechanism, eligible, applied, reason)
      VALUES (${WS}, 'm', 1, 2, 'r')
    `).rejects.toThrow(/fallback_observations_counts_valid/);
  });
});
