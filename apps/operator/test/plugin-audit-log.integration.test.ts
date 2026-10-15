/**
 * plugin-audit-log.integration.test.ts — the D-001 regression gate.
 *
 * Plan: revive-plugin-system-2026-06-04 (D-001 / P0).
 *
 * `harness_shared.plugin_audit_log` used to be created lazily at runtime by a
 * `CREATE TABLE IF NOT EXISTS` in plugin-audit-writer.ts. Because
 * `ServerActionRegistry.invoke()` is FAIL-CLOSED on the audit write, that
 * runtime CREATE ran on the audit path — and a least-privilege ship role
 * (`harness_app`, which has NO CREATE on `harness_shared`) can't run it, so
 * EVERY plugin action failed. It was masked on the dev box only because the
 * audit writer connects as `harness_admin` (which has CREATE).
 *
 * The fix moved the table into migration 137 and deleted the runtime DDL.
 * This test boots a real Postgres, creates the framework roles + applies the
 * REAL migration file, then proves the two halves of the contract:
 *   1. a no-CREATE role can INSERT an audit row (and CANNOT create tables —
 *      i.e. the old ensureTable() path WOULD have failed for it), and
 *   2. ServerActionRegistry stays fail-closed: an action succeeds when the
 *      audit write succeeds on the app role, and fails when the write throws.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { ServerActionRegistry, type AuditRow, type AuditWriter } from '@papercusp/plugin-loader';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const MIGRATION_137 = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql/137-plugin-audit-log.sql');

// Mirror the production migration runner: psql meta-commands (\set, …) are
// client-side directives postgres-js can't parse, so strip them before exec.
function sanitizeMigration(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*\\[a-z]/i.test(line))
    .join('\n');
}

// Audit writer that performs the SAME INSERT as the production PgAuditWriter
// but through a supplied connection (so we can drive it as a non-superuser).
function makeSqlAuditWriter(client: postgres.Sql): AuditWriter {
  return {
    async write(row: AuditRow): Promise<void> {
      await client`
        INSERT INTO harness_shared.plugin_audit_log
          (ts, plugin_name, install_slug, action_name, trigger_source, trigger_id,
           params_json, outcome, duration_ms, error_message, capabilities_used,
           killed_by_timeout, stdout_bytes, stderr_bytes, truncated)
        VALUES
          (to_timestamp(${row.ts / 1000}), ${row.pluginName}, ${row.installSlug},
           ${row.actionName}, ${row.triggerSource}, ${row.triggerId},
           ${JSON.stringify(row.params ?? null)}::jsonb, ${row.outcome}, ${row.durationMs},
           ${row.errorMessage ?? null}, ${row.capabilitiesUsed ?? null},
           ${row.killedByTimeout ?? null}, ${row.stdoutBytes ?? null},
           ${row.stderrBytes ?? null}, ${row.truncated ?? null})
      `;
    },
  };
}

let adminUri: string;
let dbName: string;
let host: string;
let port: string;
let sql: postgres.Sql; // owner/superuser
let appSql: postgres.Sql; // harness_app — the least-privilege ship role (NO CREATE)

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `pal_${randomBytes(5).toString('hex')}`;
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

  // Framework roles (cluster-global). IF NOT EXISTS + EXCEPTION guard so a
  // concurrent test file (fresh-migrate creates the same roles) can't collide.
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
  // Schema USAGE so the app role can reach the table (000-baseline grants this;
  // replicate it for the isolated schema this test builds).
  await sql.unsafe(`GRANT USAGE ON SCHEMA harness_shared TO harness_app, harness_zero`);

  // Apply the REAL migration file (table + indexes + table/sequence grants).
  await sql.unsafe(sanitizeMigration(readFileSync(MIGRATION_137, 'utf8')));

  appSql = postgres(`postgresql://harness_app:harness_app_pwd@${host}:${port}/${dbName}`, {
    max: 1,
    onnotice: () => {},
  });
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

describe('migration 137 — plugin_audit_log on the least-privilege ship role', () => {
  it('defines the table via the migration (no runtime DDL needed)', async () => {
    const [{ reg }] = await sql.unsafe(
      `SELECT to_regclass('harness_shared.plugin_audit_log')::text AS reg`,
    );
    expect(reg).toBe('harness_shared.plugin_audit_log');
  });

  it('the no-CREATE app role CANNOT create tables (so the old ensureTable() path would have failed it)', async () => {
    await expect(
      appSql.unsafe(`CREATE TABLE harness_shared.audit_probe (a int)`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the app role CAN insert an audit row (BIGSERIAL sequence granted)', async () => {
    const writer = makeSqlAuditWriter(appSql);
    await expect(
      writer.write({
        ts: Date.now(),
        pluginName: 'firecrawl-bridge',
        installSlug: 'sheets',
        actionName: 'scrape',
        triggerSource: 'api',
        triggerId: 'inv_1',
        params: { url: 'https://example.com' },
        outcome: 'ok',
        durationMs: 12,
      }),
    ).resolves.toBeUndefined();

    const [{ n }] = await appSql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.plugin_audit_log`,
    );
    expect(n).toBe(1);

    // The sequence auto-assigns ids — a second insert gets a distinct id.
    await writer.write({
      ts: Date.now(),
      pluginName: 'firecrawl-bridge',
      installSlug: 'sheets',
      actionName: 'scrape',
      triggerSource: 'api',
      triggerId: 'inv_2',
      outcome: 'ok',
      durationMs: 9,
    });
    const ids = await appSql.unsafe<{ id: string }[]>(
      `SELECT id FROM harness_shared.plugin_audit_log ORDER BY id`,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0].id).not.toBe(ids[1].id);
  });
});

describe('ServerActionRegistry fail-closed audit (the regression contract)', () => {
  it('an action succeeds end-to-end when the audit write succeeds on the app role', async () => {
    const registry = new ServerActionRegistry([{ name: 'ping' }], {
      pluginName: 'test-plugin',
      audit: makeSqlAuditWriter(appSql),
    });
    registry.register('ping', () => ({ ok: true, result: 'pong' }));
    registry.seal();

    const before = (
      await appSql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM harness_shared.plugin_audit_log`,
      )
    )[0].n;

    const res = await registry.invoke({
      name: 'ping',
      ctx: { installSlug: 'sheets' },
      params: {},
      triggerSource: 'api',
      triggerId: 'reg_ok',
    });
    expect(res).toEqual({ ok: true, result: 'pong' });

    const after = (
      await appSql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM harness_shared.plugin_audit_log`,
      )
    )[0].n;
    expect(after).toBe(before + 1);
  });

  it('stays fail-closed: a throwing audit writer fails the action even though the handler ran', async () => {
    const throwing: AuditWriter = {
      async write() {
        throw new Error('relation "harness_shared.plugin_audit_log" does not exist');
      },
    };
    const registry = new ServerActionRegistry([{ name: 'ping' }], {
      pluginName: 'test-plugin',
      audit: throwing,
    });
    let ran = false;
    registry.register('ping', () => {
      ran = true;
      return { ok: true, result: 'pong' };
    });
    registry.seal();

    const res = await registry.invoke({
      name: 'ping',
      ctx: { installSlug: 'sheets' },
      params: {},
      triggerSource: 'api',
      triggerId: 'reg_failclosed',
    });
    expect(ran).toBe(true); // the handler's effects DID run …
    expect(res.ok).toBe(false); // … but the action is reported failed (fail-closed)
    expect(res.error).toMatch(/audit write failed/i);
  });
});
