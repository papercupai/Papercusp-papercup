/**
 * harness-plan-status-grants.integration.test.ts
 *
 * Regression guard for the `plans:start` → `permission denied for table
 * harness_plan_status` failure (found in harness_shared.tool_invocations,
 * 2026-05-31).
 *
 * ROOT CAUSE: the GRANTs in 086-harness-plan-status.sql / 087-... were
 * committed ~15 min AFTER the table-create versions of those files. The
 * migration runner tracks applied migrations by FILENAME only and never
 * re-applies a recorded file, so any embedded-pg that recorded 086/087 from
 * their grant-less versions never got the GRANT — the runtime `harness_app`
 * role has no DML privilege and plans:start fails. The fix is the idempotent
 * catch-up migration 092-regrant-harness-plan-tables.sql.
 *
 * This test reproduces the grant-less state (apply the real 086/087, then
 * REVOKE harness_app's grants) and proves 092 repairs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const readSql = (f: string) => readFileSync(resolve(SQL_DIR, f), 'utf8');

const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
  END $pg$;
`;

let adminUri: string;
let dbName: string;
let sql: postgres.Sql; // owner/superuser connection
let appSql: postgres.Sql; // the runtime harness_app role

const PLAN_TABLES = [
  'harness_shared.harness_plan_status',
  'harness_shared.harness_plan_assertions',
] as const;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `hpg_${randomBytes(5).toString('hex')}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  // Schema USAGE is granted by migration 001 in the real system; the GRANT
  // bug is strictly about TABLE-level privilege, so grant schema usage here.
  await sql.unsafe(`GRANT USAGE ON SCHEMA harness_shared TO harness_app, harness_admin`);

  // Apply the REAL 086/087 (they are self-contained — own trigger fns, only
  // depend on the harness_shared schema). This creates the tables WITH grants.
  await sql.unsafe(readSql('archive/086-harness-plan-status.sql')).simple();
  await sql.unsafe(readSql('archive/087-harness-plan-assertions.sql')).simple();

  // Reproduce the grant-less state that the filename-only runner left behind.
  for (const t of PLAN_TABLES) {
    await sql.unsafe(`REVOKE ALL ON ${t} FROM harness_app`);
  }

  const au = new URL(adminUri);
  au.username = 'harness_app';
  au.password = 'harness_app_pwd';
  au.pathname = `/${dbName}`;
  appSql = postgres(au.toString(), { max: 1, onnotice: () => {} });
  await appSql.unsafe(`SET app.workspace_id = 'ws1'`);
}, 60_000);

afterAll(async () => {
  await appSql?.end({ timeout: 5 });
  await sql?.end({ timeout: 5 });
});

describe('harness_plan_* GRANTs (migration 092 catch-up repair)', () => {
  it('reproduces the bug: harness_app cannot INSERT before the re-grant', async () => {
    await expect(
      appSql`INSERT INTO harness_shared.harness_plan_status (workspace_id, harness_slug, plan_slug, status)
             VALUES ('ws1', 'papercup', 'p-pre', 'started')`,
    ).rejects.toThrow(/permission denied for (table|relation) harness_plan_status/);
  });

  it('092 re-grants DML on both plan tables to harness_app', async () => {
    await sql.unsafe(readSql('archive/092-regrant-harness-plan-tables.sql')).simple();

    // harness_plan_status: full DML cycle as harness_app.
    await appSql`INSERT INTO harness_shared.harness_plan_status (workspace_id, harness_slug, plan_slug, status)
                 VALUES ('ws1', 'papercup', 'p1', 'started')`;
    const sel = await appSql`SELECT status FROM harness_shared.harness_plan_status WHERE plan_slug = 'p1'`;
    expect(sel[0]?.status).toBe('started');
    await appSql`UPDATE harness_shared.harness_plan_status SET status = 'paused' WHERE plan_slug = 'p1'`;
    await appSql`DELETE FROM harness_shared.harness_plan_status WHERE plan_slug = 'p1'`;

    // harness_plan_assertions: insert + select.
    await appSql`INSERT INTO harness_shared.harness_plan_assertions
                   (workspace_id, harness_slug, val_id, plan_slug, item_id, verify_text)
                 VALUES ('ws1', 'papercup', 'VAL-p1-001', 'p1', 'I-1', 'it works')`;
    const a = await appSql`SELECT verify_text FROM harness_shared.harness_plan_assertions WHERE val_id = 'VAL-p1-001'`;
    expect(a[0]?.verify_text).toBe('it works');
  });

  it('is idempotent — re-running 092 does not error', async () => {
    await expect(sql.unsafe(readSql('archive/092-regrant-harness-plan-tables.sql')).simple()).resolves.toBeDefined();
  });
});
