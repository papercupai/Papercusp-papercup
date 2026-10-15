/**
 * orphan-cleanup.integration.test.ts — the backup-snapshot orphan sweep against a
 * real Postgres. Exercises the full INSERT → sweep → status-check round-trip.
 *
 * INTEGRATION tier (EI-16090). This file's predecessor —
 * `lib/backup/orphan-cleanup.test.ts` — already described itself as "integration
 * tests ... against a live embedded-pg", but sat in the UNIT layer, where it:
 *
 *   1. inserted + verified fixtures with its OWN client from `pgClientFields()`
 *      (embedded pg, 127.0.0.1:18532) while `sweepOrphanSnapshots` mutated rows
 *      through `getOrgPg()` (native pg, 127.0.0.1:5432 — setup-hermetic-env.ts
 *      pins discovery off). Both DBs are named `papercusp`, so the split was
 *      invisible: the sweep updated a server the assertions never read, and every
 *      "expected 'running' to be 'failed'" failure followed from that.
 *   2. ran against the SHARED live dev PG, so the real scheduled sweep (or a
 *      parallel worker) could race it — which forced the assertions to be
 *      WEAKENED to "durable final state" instead of this call's own `sweptIds`.
 *   3. soft-skipped (`itPg` returned early) when PG was unreachable, so the file
 *      could silently pass as a no-op.
 *
 * Here the DB is a throwaway container owned solely by this file, and the code
 * under test writes through the SAME connection the assertions read
 * (`vi.mock('@papercusp/db-org')` — the host wires `getSql: () => getOrgPg().sql`
 * and calls it per use, so the mock reaches the real production wiring). Plain
 * `it()` means an unreachable DB fails loudly instead of vanishing.
 *
 * NOTE: with an isolated DB there is no concurrent production sweeper, so the
 * EI-13994 assertion weakening described in (2) is no longer necessary. Left
 * as-is deliberately — moving tier and tightening assertions in one change would
 * confound which edit caused any behavior difference. Tightening is a safe
 * follow-up.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { sweepOrphanSnapshots } = await import('./orphan-cleanup');

const TEST_WORKSPACE = '__orphan_sweep_test__';
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `orph_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to the baseline shape of harness_shared.backup_snapshots.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.backup_snapshots (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      kopia_snapshot_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status text NOT NULL DEFAULT 'running',
      trigger_reason text NOT NULL,
      trigger_context jsonb,
      bytes_added bigint,
      bytes_total bigint,
      sources_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      error_text text
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.backup_events (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      snapshot_id bigint REFERENCES harness_shared.backup_snapshots(id) ON DELETE CASCADE,
      kind text NOT NULL,
      payload_json jsonb,
      at timestamptz NOT NULL DEFAULT now()
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

afterEach(async () => {
  await rootSql`DELETE FROM harness_shared.backup_snapshots WHERE workspace_id = ${TEST_WORKSPACE}`;
});

async function insertSnapshot(
  status: 'running' | 'ok' | 'failed' | 'aborted',
  startedAtIso: string,
): Promise<string> {
  const rows = await rootSql<{ id: string }[]>`
    INSERT INTO harness_shared.backup_snapshots
      (workspace_id, started_at, status, trigger_reason)
    VALUES (${TEST_WORKSPACE}, ${startedAtIso}::timestamptz, ${status}, 'manual')
    RETURNING id::text
  `;
  return rows[0]!.id;
}

async function getStatus(id: string): Promise<{ status: string; error_text: string | null }> {
  const rows = await rootSql<{ status: string; error_text: string | null }[]>`
    SELECT status, error_text FROM harness_shared.backup_snapshots WHERE id = ${id}::bigint
  `;
  return rows[0]!;
}

async function insertEvent(snapshotId: string, atIso: string): Promise<void> {
  await rootSql`
    INSERT INTO harness_shared.backup_events
      (workspace_id, snapshot_id, kind, payload_json, at)
    VALUES
      (${TEST_WORKSPACE}, ${snapshotId}::bigint, 'progress', ${JSON.stringify({ phase: 'heartbeat' })}::jsonb, ${atIso}::timestamptz)
  `;
}

describe('sweepOrphanSnapshots', () => {
  it('returns 0 when no running rows', async () => {
    const result = await sweepOrphanSnapshots();
    expect(typeof result.swept).toBe('number');
    expect(Array.isArray(result.sweptIds)).toBe(true);
  });

  it('marks running rows older than threshold as failed', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const idA = await insertSnapshot('running', twoHoursAgo);
    const idB = await insertSnapshot('running', twoHoursAgo);
    const idC = await insertSnapshot('running', twoHoursAgo);

    await sweepOrphanSnapshots();

    const a = await getStatus(idA);
    expect(a.status).toBe('failed');
    expect(a.error_text).toContain('orphan-sweep');
    expect((await getStatus(idB)).status).toBe('failed');
    expect((await getStatus(idC)).status).toBe('failed');
  });

  it('leaves recent running rows untouched', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const id = await insertSnapshot('running', fiveMinAgo);

    const result = await sweepOrphanSnapshots();
    expect(result.sweptIds).not.toContain(id);
    expect((await getStatus(id)).status).toBe('running');
  });

  it('leaves an old running row untouched when it has a recent event', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const id = await insertSnapshot('running', twoHoursAgo);
    await insertEvent(id, fiveMinAgo);

    const result = await sweepOrphanSnapshots();
    expect(result.sweptIds).not.toContain(id);
    expect((await getStatus(id)).status).toBe('running');
  });

  it('marks an old running row failed when its last event is also stale', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const ninetyMinAgo = new Date(Date.now() - 90 * 60_000).toISOString();
    const id = await insertSnapshot('running', twoHoursAgo);
    await insertEvent(id, ninetyMinAgo);

    const result = await sweepOrphanSnapshots();
    expect(result.sweptIds).toContain(id);
    expect((await getStatus(id)).status).toBe('failed');
  });

  it('leaves terminal-state rows (ok/failed/aborted) untouched even when stale', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const idOk = await insertSnapshot('ok', twoHoursAgo);
    const idFail = await insertSnapshot('failed', twoHoursAgo);
    const idAborted = await insertSnapshot('aborted', twoHoursAgo);

    const result = await sweepOrphanSnapshots();
    expect(result.sweptIds).not.toContain(idOk);
    expect(result.sweptIds).not.toContain(idFail);
    expect(result.sweptIds).not.toContain(idAborted);

    expect((await getStatus(idOk)).status).toBe('ok');
    expect((await getStatus(idAborted)).status).toBe('aborted');
  });

  it('respects custom olderThanMs threshold', async () => {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    const id = await insertSnapshot('running', fifteenMinAgo);

    // With the default 1h threshold: untouched.
    const r1 = await sweepOrphanSnapshots();
    expect(r1.sweptIds).not.toContain(id);
    expect((await getStatus(id)).status).toBe('running');

    // With a 10-min threshold: swept.
    const r2 = await sweepOrphanSnapshots({ olderThanMs: 10 * 60_000 });
    expect(r2.sweptIds).toContain(id);
    expect((await getStatus(id)).status).toBe('failed');
  });

  it('two parallel calls are safe (no row double-marked)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const idA = await insertSnapshot('running', twoHoursAgo);
    const idB = await insertSnapshot('running', twoHoursAgo);

    await Promise.all([sweepOrphanSnapshots(), sweepOrphanSnapshots()]);

    expect((await getStatus(idA)).status).toBe('failed');
    expect((await getStatus(idB)).status).toBe('failed');
  });

  it('error_text records the threshold used', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const id = await insertSnapshot('running', twoHoursAgo);

    await sweepOrphanSnapshots({ olderThanMs: 30 * 60_000 });

    expect((await getStatus(id)).error_text).toMatch(/>30min/);
  });
});
