/**
 * expirable-registry.integration.test.ts — the generic TTL sweep (sweepOne),
 * against a real Postgres. The module is table-agnostic, so the tests register
 * their own throwaway tables.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - delete-sweep removes ONLY rows whose expires column is in the past, for both
 *    column types: timestamptz (compared with now()) and unix-ms bigint (compared
 *    with (extract(epoch from now())*1000)::bigint);
 *  - mark-status sweep flips status from→to (+ stamps a ts column) ONLY for
 *    expired rows that are still in the `from` state;
 *  - an unregistered table is a no-op, and a missing table (42P01) is swallowed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { registerExpirable, sweepOne } = await import('./expirable-registry');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `exp_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`CREATE TABLE harness_shared.ttl_ts (id text, expires_at timestamptz)`);
  await rootSql.unsafe(`CREATE TABLE harness_shared.ttl_ms (id text, expires_at_ms bigint)`);
  await rootSql.unsafe(`CREATE TABLE harness_shared.ttl_status (id text, status text, expires_at timestamptz, updated_at bigint)`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('sweepOne — delete', () => {
  it('deletes ONLY past-expiry rows (timestamptz)', async () => {
    await rootSql`INSERT INTO harness_shared.ttl_ts (id, expires_at) VALUES
      ('expired1', now() - interval '1 hour'), ('expired2', now() - interval '1 minute'), ('live', now() + interval '1 hour')`;
    registerExpirable({ table: 'harness_shared.ttl_ts', onExpire: { kind: 'delete' } });
    await sweepOne('harness_shared.ttl_ts');
    const rows = await rootSql`SELECT id FROM harness_shared.ttl_ts`;
    expect(rows.map((r) => r.id)).toEqual(['live']); // both expired gone, live kept
  });

  it('deletes ONLY past-expiry rows (unix-ms bigint)', async () => {
    await rootSql`INSERT INTO harness_shared.ttl_ms (id, expires_at_ms) VALUES
      ('expired', ${Date.now() - 1000}), ('live', ${Date.now() + 3_600_000})`;
    registerExpirable({ table: 'harness_shared.ttl_ms', expiresAtColumn: 'expires_at_ms', columnType: 'unix-ms', onExpire: { kind: 'delete' } });
    await sweepOne('harness_shared.ttl_ms');
    const rows = await rootSql`SELECT id FROM harness_shared.ttl_ms`;
    expect(rows.map((r) => r.id)).toEqual(['live']);
  });
});

describe('sweepOne — mark-status', () => {
  it('flips status from→to for expired rows still in `from`, stamping the ts column', async () => {
    await rootSql`INSERT INTO harness_shared.ttl_status (id, status, expires_at, updated_at) VALUES
      ('a', 'running', now() - interval '1 hour', 0),
      ('b', 'running', now() + interval '1 hour', 0),
      ('c', 'done',    now() - interval '1 hour', 0)`;
    registerExpirable({
      table: 'harness_shared.ttl_status',
      onExpire: { kind: 'mark-status', column: 'status', from: 'running', to: 'stalled', timestampColumn: 'updated_at' },
    });
    await sweepOne('harness_shared.ttl_status');
    const rows = await rootSql<{ id: string; status: string; updated_at: string }[]>`
      SELECT id, status, updated_at FROM harness_shared.ttl_status ORDER BY id`;
    expect(rows.map((r) => `${r.id}:${r.status}`)).toEqual(['a:stalled', 'b:running', 'c:done']);
    // a flipped → its updated_at got stamped (was 0); b/c untouched (still 0)
    expect(Number(rows.find((r) => r.id === 'a')!.updated_at)).toBeGreaterThan(0);
    expect(Number(rows.find((r) => r.id === 'b')!.updated_at)).toBe(0);
  });
});

describe('sweepOne — robustness', () => {
  it('is a no-op for an unregistered table', async () => {
    await expect(sweepOne('harness_shared.never_registered')).resolves.toBeUndefined();
  });

  it('swallows a missing table (42P01) without throwing', async () => {
    registerExpirable({ table: 'harness_shared.does_not_exist', onExpire: { kind: 'delete' } });
    await expect(sweepOne('harness_shared.does_not_exist')).resolves.toBeUndefined();
  });
});
