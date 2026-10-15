/**
 * plugin-audit-writer-real.integration.test.ts — the D-001 fail-closed gate,
 * exercised through the REAL PgAuditWriter.
 *
 * Plan: revive-plugin-system-2026-06-04 (D-001 / P0).
 *
 * plugin-audit-log.integration.test.ts already proves that a HAND-COPIED
 * duplicate of the INSERT works on the least-privilege `harness_app` role. But a
 * hand copy can drift from the shipping code: a column rename, a missing
 * `::text::jsonb` cast, a forgotten grant — none of those would fail that test,
 * yet all of them re-break every plugin action in production (the invoke path is
 * fail-closed on this write).
 *
 * This test closes that gap: it drives the ACTUAL `PgAuditWriter` from
 * @papercusp/operator-core/lib/plugin-audit-writer.ts (by pointing its
 * `getOrgPg()` at a `harness_app` connection) against a schema built from the
 * REAL migration-137 file. If the production INSERT's columns/casts/grants drift,
 * THIS test goes red — it is the one audit-write path that ships.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATION_137 = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql/137-plugin-audit-log.sql');

// Hoisted holder so the db-org mock can hand the REAL PgAuditWriter the
// harness_app connection (the least-privilege ship role) instead of the
// operator's org PG.
const h = vi.hoisted(() => ({ appSql: null as unknown as import('postgres').Sql }));

// PgAuditWriter calls getOrgPg() and writes through its `sql`. Redirect that to
// the harness_app connection so the write executes as the no-CREATE ship role.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.appSql }) };
});

import { PgAuditWriter } from '@papercusp/operator-core/lib/plugin-audit-writer';

// psql meta-commands (\set, …) the migration runner strips before exec.
function sanitizeMigration(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*\\[a-z]/i.test(line))
    .join('\n');
}

let adminUri: string;
let dbName: string;
let host: string;
let port: string;
let sql: postgres.Sql; // owner/superuser
let appSql: postgres.Sql; // harness_app — the least-privilege ship role (NO CREATE)

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `palr_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  host = u.hostname;
  port = u.port;
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  // Framework roles (cluster-global) — guarded so a concurrent test file can't collide.
  await sql.unsafe(`
    DO $pg$ BEGIN
      BEGIN CREATE ROLE harness_admin LOGIN PASSWORD 'harness_admin_pwd';
      EXCEPTION WHEN duplicate_object THEN NULL; END;
      BEGIN CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
      EXCEPTION WHEN duplicate_object THEN NULL; END;
      BEGIN CREATE ROLE harness_zero LOGIN PASSWORD 'harness_zero_pwd';
      EXCEPTION WHEN duplicate_object THEN NULL; END;
    END $pg$;
  `);
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA harness_shared TO harness_app, harness_zero`);

  // Apply the REAL migration file (table + indexes + table/sequence grants).
  await sql.unsafe(sanitizeMigration(readFileSync(MIGRATION_137, 'utf8')));

  appSql = postgres(`postgresql://harness_app:harness_app_pwd@${host}:${port}/${dbName}`, {
    max: 1,
    onnotice: () => {},
  });
  h.appSql = appSql; // wire the mock's getOrgPg() at the harness_app role
}, 120_000);

afterAll(async () => {
  if (appSql) await appSql.end({ timeout: 5 });
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('PgAuditWriter on the least-privilege ship role (D-001 — the path that ships)', () => {
  it('the REAL writer INSERTs an ok row as harness_app + round-trips params via ::text::jsonb', async () => {
    const writer = new PgAuditWriter();
    const ts = Date.now();
    await expect(
      writer.write({
        ts,
        pluginName: 'firecrawl-bridge',
        installSlug: 'sheets',
        actionName: 'scrape',
        triggerSource: 'api',
        triggerId: 'inv_real_1',
        params: { url: 'https://example.com', nested: { n: 1 }, list: ['a', 'b'] },
        outcome: 'ok',
        durationMs: 12,
      }),
    ).resolves.toBeUndefined();

    const [row] = await appSql.unsafe<
      { plugin_name: string; outcome: string; params_json: unknown; duration_ms: number }[]
    >(
      `SELECT plugin_name, outcome, params_json, duration_ms
         FROM harness_shared.plugin_audit_log WHERE trigger_id = 'inv_real_1'`,
    );
    expect(row.plugin_name).toBe('firecrawl-bridge');
    expect(row.outcome).toBe('ok');
    expect(row.duration_ms).toBe(12);
    // params went in as JS object → ::text::jsonb → comes back as parsed JSON.
    expect(row.params_json).toEqual({ url: 'https://example.com', nested: { n: 1 }, list: ['a', 'b'] });
  });

  it('null params round-trip as SQL NULL (the `row.params ?? null` path)', async () => {
    const writer = new PgAuditWriter();
    await writer.write({
      ts: Date.now(),
      pluginName: 'p',
      installSlug: 'sheets',
      actionName: 'a',
      triggerSource: 'api',
      triggerId: 'inv_null_params',
      outcome: 'ok',
      durationMs: 1,
    });
    const [row] = await appSql.unsafe<{ params_json: unknown }[]>(
      `SELECT params_json FROM harness_shared.plugin_audit_log WHERE trigger_id = 'inv_null_params'`,
    );
    // JSON.stringify(null) → 'null'::jsonb → SQL json-null, read back as JS null.
    expect(row.params_json).toBeNull();
  });

  it('a non-ok row (killed_by_timeout + capabilities_used TEXT[]) round-trips and trips the partial index', async () => {
    const writer = new PgAuditWriter();
    await writer.write({
      ts: Date.now(),
      pluginName: 'firecrawl-bridge',
      installSlug: 'sheets',
      actionName: 'crawl',
      triggerSource: 'event',
      triggerId: 'inv_failed_1',
      params: { depth: 3 },
      outcome: 'error',
      durationMs: 30_000,
      errorMessage: 'killed: exceeded action timeout',
      capabilitiesUsed: ['http:fetch:api.firecrawl.dev', 'secrets:read:FIRECRAWL_KEY'],
      killedByTimeout: true,
      stdoutBytes: 0,
      stderrBytes: 512,
      truncated: true,
    });

    const [row] = await appSql.unsafe<
      {
        outcome: string;
        killed_by_timeout: boolean;
        capabilities_used: string[];
        error_message: string;
        truncated: boolean;
        stderr_bytes: number;
      }[]
    >(
      `SELECT outcome, killed_by_timeout, capabilities_used, error_message, truncated, stderr_bytes
         FROM harness_shared.plugin_audit_log WHERE trigger_id = 'inv_failed_1'`,
    );
    expect(row.outcome).toBe('error');
    expect(row.killed_by_timeout).toBe(true);
    expect(row.truncated).toBe(true);
    expect(row.stderr_bytes).toBe(512);
    expect(row.error_message).toMatch(/exceeded action timeout/);
    // TEXT[] array round-trips as a JS string[].
    expect(row.capabilities_used).toEqual([
      'http:fetch:api.firecrawl.dev',
      'secrets:read:FIRECRAWL_KEY',
    ]);

    // The partial index `plugin_audit_outcome ... WHERE outcome != 'ok'` should be
    // usable for a non-ok lookup. Force index usage and confirm the planner picks it.
    await appSql.unsafe(`SET enable_seqscan = off`);
    try {
      const plan = await appSql.unsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT id FROM harness_shared.plugin_audit_log WHERE outcome != 'ok'`,
      );
      const planText = plan.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText).toMatch(/plugin_audit_outcome/);
    } finally {
      await appSql.unsafe(`SET enable_seqscan = on`);
    }

    // …and the non-ok row is actually returned by that predicate.
    const failed = await appSql.unsafe<{ trigger_id: string }[]>(
      `SELECT trigger_id FROM harness_shared.plugin_audit_log WHERE outcome != 'ok' ORDER BY id`,
    );
    expect(failed.map((r) => r.trigger_id)).toContain('inv_failed_1');
  });

  it('harness_app still CANNOT create tables (the old ensureTable() path is genuinely closed to it)', async () => {
    await expect(
      appSql.unsafe(`CREATE TABLE harness_shared.audit_probe_real (a int)`),
    ).rejects.toThrow(/permission denied/i);
  });
});
