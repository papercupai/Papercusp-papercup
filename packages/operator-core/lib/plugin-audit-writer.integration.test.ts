/**
 * plugin-audit-writer.integration.test.ts — PgAuditWriter, the fail-closed plugin
 * action audit writer (plugin_audit_log, migration 137), against a real Postgres.
 *
 * The writer throws on failure by design (a plugin that ran but isn't audited is
 * worse than one that didn't run — D-001). Behaviors a fake-sql unit test can't
 * prove: the `to_timestamp(ts/1000)` epoch conversion, the `${params}::text::jsonb`
 * double-encode-avoidance (a real jsonb object, not a string scalar), the TEXT[]
 * capabilities_used array, and the `?? null` nullable mapping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { PgAuditWriter } = await import('./plugin-audit-writer');

const row = (over: Record<string, unknown> = {}) => ({
  ts: 1_716_000_000_000, pluginName: 'cool-plugin', installSlug: 'web', actionName: 'run',
  triggerSource: 'manual', triggerId: 't1', params: { foo: 'bar', n: 2 }, outcome: 'ok',
  durationMs: 42, errorMessage: null, capabilitiesUsed: ['fs.read', 'net'],
  killedByTimeout: false, stdoutBytes: 10, stderrBytes: 0, truncated: false, ...over,
}) as never;

let rootSql: postgres.Sql;
let writer: InstanceType<typeof PgAuditWriter>;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pal_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 137: ts timestamptz NOT NULL, params_json jsonb, capabilities_used text[].
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.plugin_audit_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      plugin_name TEXT NOT NULL, install_slug TEXT NOT NULL, action_name TEXT NOT NULL,
      trigger_source TEXT NOT NULL, trigger_id TEXT,
      params_json JSONB, outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      error_message TEXT, capabilities_used TEXT[], killed_by_timeout BOOLEAN,
      stdout_bytes INTEGER, stderr_bytes INTEGER, truncated BOOLEAN
    )`);
  h.sql = rootSql;
  writer = new PgAuditWriter();
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.plugin_audit_log RESTART IDENTITY`;
});

describe('PgAuditWriter.write (PG)', () => {
  it('writes a row: epoch ts, TEXT[] capabilities, mapped scalars', async () => {
    await writer.write(row());
    const r = (await rootSql<{ plugin_name: string; outcome: string; duration_ms: number; capabilities_used: string[]; ms: string }[]>`
      SELECT plugin_name, outcome, duration_ms, capabilities_used,
             (extract(epoch from ts) * 1000)::bigint AS ms
        FROM harness_shared.plugin_audit_log`)[0]!;
    expect(r).toMatchObject({ plugin_name: 'cool-plugin', outcome: 'ok', duration_ms: 42 });
    expect(r.capabilities_used).toEqual(['fs.read', 'net']); // TEXT[]
    expect(Number(r.ms)).toBe(1_716_000_000_000); // to_timestamp(ts/1000) round-trips epoch-ms
  });

  it('stores params_json as a proper jsonb OBJECT (::text::jsonb), queryable by key', async () => {
    await writer.write(row({ params: { foo: 'bar', n: 2 } }));
    const r = (await rootSql<{ typ: string; foo: string; params: Record<string, unknown> }[]>`
      SELECT jsonb_typeof(params_json) AS typ, params_json->>'foo' AS foo, params_json AS params
        FROM harness_shared.plugin_audit_log`)[0]!;
    expect(r.typ).toBe('object'); // NOT a double-encoded string scalar
    expect(r.foo).toBe('bar');
    expect(r.params).toEqual({ foo: 'bar', n: 2 });
  });

  it('maps absent optionals (the `?? null` fields) to NULL columns', async () => {
    // triggerId is a REQUIRED string in AuditRow (the writer doesn't ?? null it); these are the optional ones.
    await writer.write(row({ errorMessage: undefined, capabilitiesUsed: undefined, killedByTimeout: undefined, stdoutBytes: undefined, stderrBytes: undefined, truncated: undefined }));
    const r = (await rootSql<Record<string, unknown>[]>`
      SELECT error_message, capabilities_used, killed_by_timeout, stdout_bytes, stderr_bytes, truncated
        FROM harness_shared.plugin_audit_log`)[0]!;
    expect(Object.values(r).every((v) => v === null)).toBe(true);
  });
});
