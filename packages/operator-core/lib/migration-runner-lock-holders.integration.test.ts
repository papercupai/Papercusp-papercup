// WI-10004820: real-Postgres proof that a migration blocked by another session's
// relation lock names that session. Reproduces the 2026-10-01 staging incident in
// miniature: an open read transaction holds ACCESS SHARE on a table, and a
// migration that ALTERs it hits lock_timeout (SQLSTATE 55P03) on every attempt.
// The unit cases in migration-runner-lock-holders.test.ts cover formatting and
// wiring; this file proves the pg_locks query itself finds the real holder.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyPendingMigrations } from '@papercusp/embedded-postgres-server';

const HOLDER_APP = 'wi10004820-holder';
let dbUrl = '';
let rootSql: postgres.Sql;
const dirs: string[] = [];

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `mlh_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  dbUrl = u.toString();
  rootSql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await rootSql.unsafe('CREATE TABLE harness_shared.lock_holder_target (id int)');
});

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migration runner names the session blocking a migration', () => {
  it('reports the holder pid, application and relation, then applies once the holder commits', async () => {
    const file = '001-alter-held-table.sql';
    const dir = mkdtempSync(join(tmpdir(), 'migration-runner-lock-holders-'));
    dirs.push(dir);
    writeFileSync(join(dir, file), 'ALTER TABLE harness_shared.lock_holder_target ADD COLUMN note text;', 'utf8');

    const holder = postgres(dbUrl, { max: 1, onnotice: () => {}, connection: { application_name: HOLDER_APP } });
    const migrator = postgres(dbUrl, { max: 1, onnotice: () => {}, connection: { lock_timeout: 250 } });
    const conn = await holder.reserve();
    let committed = false;
    try {
      const [{ pid }] = await conn<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await conn`BEGIN`;
      await conn`SELECT count(*) FROM harness_shared.lock_holder_target`;

      const lines: string[] = [];
      const blocked = await applyPendingMigrations({
        client: migrator,
        sqlDir: dir,
        continueOnError: true,
        log: (line: string) => lines.push(line),
      });

      expect(blocked.appliedCount).toBe(0);
      expect(blocked.failed).toHaveLength(1);
      const expectedHolder = `pid ${pid} (${HOLDER_APP}, idle in transaction, txn `;
      expect(blocked.failed[0].error).toContain('(SQLSTATE 55P03)');
      expect(blocked.failed[0].error).toContain(expectedHolder);
      expect(blocked.failed[0].error).toContain('holds AccessShareLock on harness_shared.lock_holder_target');
      const retries = lines.filter((line) => line.startsWith(`retry ${file} after SQLSTATE 55P03`));
      expect(retries).toHaveLength(2);
      for (const retry of retries) expect(retry).toContain(expectedHolder);

      await conn`COMMIT`;
      committed = true;
      const applied = await applyPendingMigrations({ client: migrator, sqlDir: dir });
      expect(applied).toMatchObject({ appliedCount: 1, failed: [] });
    } finally {
      if (!committed) await conn`ROLLBACK`.catch(() => {});
      conn.release();
      await holder.end({ timeout: 5 });
      await migrator.end({ timeout: 5 });
    }
  }, 30_000);
});
