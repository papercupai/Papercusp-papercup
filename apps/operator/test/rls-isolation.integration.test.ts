/**
 * rls-isolation.integration.test.ts — proves workspace RLS actually ISOLATES
 * (P-011, Phase 1).
 *
 * The audit found RLS was only ever asserted to *exist* (a regex check that the
 * migration declares policies), never that it *works*. The whole multi-tenant
 * safety story rests on it: every workspace-scoped table in harness_shared has
 * RLS enabled with `USING/WITH CHECK (workspace_id = current_setting(
 * 'app.workspace_id', true))` (010-workspace-scoping-rls.sql), and the app
 * connects as the non-superuser `harness_app` role (harness_admin has BYPASSRLS).
 *
 * This replicates that exact pattern on a real testcontainer Postgres and drives
 * it through TWO connections — the superuser (bypasses RLS) and `harness_app`
 * (subject to RLS) — to prove: cross-workspace reads are blocked, WITH CHECK
 * blocks cross-workspace writes, the no-session-var default is deny-all, and a
 * BYPASSRLS role sees everything. Superuser-bypass is why a faithful test MUST
 * use a separate non-superuser connection — running as the owner/superuser would
 * silently pass while proving nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

// Idempotent — roles are cluster-global and a prior test may have created it.
const APP_ROLE_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
  END $pg$;
`;

// Mirrors the production RLS shape (010-workspace-scoping-rls.sql + e.g. 014).
const TABLE_DDL = `
  CREATE TABLE public.rls_demo (workspace_id text NOT NULL, val text NOT NULL);
  ALTER TABLE public.rls_demo ENABLE ROW LEVEL SECURITY;
  CREATE POLICY rls_demo_workspace_iso ON public.rls_demo
    USING (workspace_id = current_setting('app.workspace_id', true))
    WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.rls_demo TO harness_app;
`;

let adminUri: string;
let dbName: string;
let admin: postgres.Sql; // testcontainer superuser → bypasses RLS
let app: postgres.Sql; // harness_app → subject to RLS

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `rls_${randomBytes(5).toString('hex')}`;

  const root = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await root.unsafe(APP_ROLE_DDL);
    await root.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(root, dbName);
  } finally {
    await root.end({ timeout: 5 });
  }

  const su = new URL(adminUri);
  su.pathname = `/${dbName}`;
  admin = postgres(su.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO harness_app`);
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO harness_app`);
  await admin.unsafe(TABLE_DDL);

  const au = new URL(adminUri);
  au.username = 'harness_app';
  au.password = 'harness_app_pwd';
  au.pathname = `/${dbName}`;
  app = postgres(au.toString(), { max: 1, onnotice: () => {} });
}, 60_000);

afterAll(async () => {
  if (app) await app.end({ timeout: 5 });
  if (admin) await admin.end({ timeout: 5 });
  const root = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await root.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await root.end({ timeout: 5 });
  }
});

describe('workspace RLS isolation (P-011)', () => {
  it('a workspace cannot read another workspace’s rows', async () => {
    await app.unsafe(`SET app.workspace_id = 'ws1'`);
    await app.unsafe(`INSERT INTO public.rls_demo VALUES ('ws1','a'), ('ws1','b')`);
    const mine = await app.unsafe(`SELECT val FROM public.rls_demo ORDER BY val`);
    expect(mine.map((r: { val: string }) => r.val)).toEqual(['a', 'b']);

    await app.unsafe(`SET app.workspace_id = 'ws2'`);
    const theirs = await app.unsafe(`SELECT val FROM public.rls_demo`);
    expect(theirs).toHaveLength(0); // ws2 sees none of ws1's rows
  });

  it('WITH CHECK blocks inserting a row tagged for another workspace', async () => {
    await app.unsafe(`SET app.workspace_id = 'ws2'`);
    await expect(
      app.unsafe(`INSERT INTO public.rls_demo VALUES ('ws1','sneaky')`),
    ).rejects.toThrow();
  });

  it('with no session var set, the app role sees nothing (deny-all default)', async () => {
    await app.unsafe(`RESET app.workspace_id`);
    const rows = await app.unsafe(`SELECT * FROM public.rls_demo`);
    expect(rows).toHaveLength(0);
  });

  it('a BYPASSRLS / superuser role sees all rows regardless of session var', async () => {
    const rows = await admin.unsafe(`SELECT val FROM public.rls_demo ORDER BY val`);
    // ws1's a + b persisted; the sneaky cross-workspace insert was rejected.
    expect(rows.map((r: { val: string }) => r.val)).toEqual(['a', 'b']);
  });
});
