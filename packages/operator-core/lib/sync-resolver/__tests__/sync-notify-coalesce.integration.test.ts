/**
 * P-525 (plan p2p-join-catchup-speed-2026-09-23, D-013) — mig 1213.
 *
 * A bulk read-merge fold opens its batch transaction with
 * `set_config('papercusp.sync_notify_coalesce', 'on', true)`. Under it
 * emit_change_notify sends one TABLE-SCOPED sync_invalidate per table per
 * transaction (PG dedupes identical payloads), instead of one per row. Measured on
 * the P-007 VM: handling the per-row echoes of a snapshot-set crossing was 22.8% of
 * the serve process's main thread.
 *
 * This guard runs the REAL migrated trigger function against real PG LISTEN:
 *   - under the GUC, N rows on two tables deliver exactly two id-less payloads;
 *   - without it, every row still delivers its own row-scoped payload;
 *   - the GUC is transaction-local, so the next transaction is per-row again.
 * The GUC name is imported from read-merge, so a rename on either side fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { SYNC_NOTIFY_COALESCE_GUC } from '../../sync/hyperbee/read-merge';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = packages/operator-core/lib/sync-resolver/__tests__ → up 5 to the repo root.
const REPO_ROOT = resolve(HERE, '../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

interface Notice {
  name: string;
  args: { workspace_id?: string | null; op?: string; id?: unknown };
}

let db: MigratedTestDb;
let sql: postgres.Sql;
let listener: postgres.Sql;
const received: Notice[] = [];

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'notifycoal',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 2, onnotice: () => {}, prepare: false });
  // Probe tables carrying the real trigger function, so the test does not depend on
  // any product table's columns or constraints.
  await sql.unsafe(`
    CREATE TABLE harness_shared.p525_probe_a (id text PRIMARY KEY, v int);
    CREATE TABLE harness_shared.p525_probe_b (id text PRIMARY KEY);
    CREATE TABLE harness_shared.p525_probe_scoped (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TRIGGER p525_a AFTER INSERT OR UPDATE OR DELETE ON harness_shared.p525_probe_a
      FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
    CREATE TRIGGER p525_b AFTER INSERT OR UPDATE OR DELETE ON harness_shared.p525_probe_b
      FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
    CREATE TRIGGER p525_scoped AFTER INSERT OR UPDATE OR DELETE ON harness_shared.p525_probe_scoped
      FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
  `);
  listener = postgres(db.url, { max: 1, onnotice: () => {} });
  await listener.listen('sync_invalidate', (payload) => {
    const n = JSON.parse(payload) as Notice;
    if (n.name.includes('p525_probe_')) received.push(n);
  });
}, 240_000);

afterAll(async () => {
  await listener?.end({ timeout: 5 });
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

/** Wait until `count` probe notifications arrived, plus a quiet window so extras would show. */
async function drain(count: number): Promise<Notice[]> {
  const deadline = Date.now() + 10_000;
  while (received.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 300));
  return received.splice(0, received.length);
}

describe('mig 1213: emit_change_notify coalesces under papercusp.sync_notify_coalesce', () => {
  it('a coalesced transaction delivers one id-less payload per table, however many rows it writes', async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config(${SYNC_NOTIFY_COALESCE_GUC}, 'on', true)`;
      await tx`INSERT INTO harness_shared.p525_probe_a SELECT 'a' || g, g FROM generate_series(1, 50) g`;
      await tx`UPDATE harness_shared.p525_probe_a SET v = v + 1`;
      await tx`INSERT INTO harness_shared.p525_probe_b SELECT 'b' || g FROM generate_series(1, 20) g`;
    });
    const got = await drain(2);
    expect(got.map((n) => n.name).sort()).toEqual([
      'harness_shared.p525_probe_a.changed',
      'harness_shared.p525_probe_b.changed',
    ]);
    for (const n of got) {
      expect(n.args.op).toBe('COALESCED');
      expect(n.args.id).toBeUndefined();
    }
  });

  it('without the GUC every row keeps its own row-scoped payload, and the GUC did not outlive its transaction', async () => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO harness_shared.p525_probe_a SELECT 'c' || g, g FROM generate_series(1, 3) g`;
    });
    const got = await drain(3);
    expect(got.map((n) => n.args.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(got.every((n) => n.args.op === 'INSERT')).toBe(true);
  });

  it('global tables retain the connection workspace for normal and coalesced writes', async () => {
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'global-normal', true)`;
      await tx`INSERT INTO harness_shared.p525_probe_b VALUES ('global-normal')`;
    });
    expect(await drain(1)).toEqual([{ name: 'harness_shared.p525_probe_b.changed',
      args: { workspace_id: 'global-normal', op: 'INSERT', id: 'global-normal', plan_slug: null, harness_slug: null } }]);
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'global-coalesced', true)`;
      await tx`SELECT set_config(${SYNC_NOTIFY_COALESCE_GUC}, 'on', true)`;
      await tx`INSERT INTO harness_shared.p525_probe_b VALUES ('global-batch-1'), ('global-batch-2')`;
    });
    expect(await drain(1)).toEqual([{ name: 'harness_shared.p525_probe_b.changed',
      args: { workspace_id: 'global-coalesced', op: 'COALESCED' } }]);
  });

  it('coalesces row-scoped writes per workspace despite a foreign connection context', async () => {
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'foreign-connection', true)`;
      await tx`SELECT set_config(${SYNC_NOTIFY_COALESCE_GUC}, 'on', true)`;
      await tx`INSERT INTO harness_shared.p525_probe_scoped VALUES
        ('scope-a1', 'workspace-a'), ('scope-a2', 'workspace-a'), ('scope-b1', 'workspace-b')`;
    });
    const got = await drain(2);
    expect(got).toHaveLength(2);
    expect(got.map(n => n.args.workspace_id).sort()).toEqual(['workspace-a', 'workspace-b']);
    for (const n of got) {
      expect(n.name).toBe('harness_shared.p525_probe_scoped.changed');
      expect(n.args.op).toBe('COALESCED');
      expect(n.args.id).toBeUndefined();
    }
    for (const operation of ['UPDATE', 'DELETE'] as const) {
      await sql.begin(async tx => {
        await tx`SELECT set_config('app.workspace_id', '', true)`;
        if (operation === 'UPDATE') await tx`UPDATE harness_shared.p525_probe_scoped SET id='scope-a-updated' WHERE id='scope-a1'`;
        else await tx`DELETE FROM harness_shared.p525_probe_scoped WHERE id='scope-a-updated'`;
      });
      expect(await drain(1)).toEqual([{ name: 'harness_shared.p525_probe_scoped.changed',
        args: { workspace_id: 'workspace-a', op: operation, id: 'scope-a-updated', plan_slug: null, harness_slug: null } }]);
    }
  });
});
