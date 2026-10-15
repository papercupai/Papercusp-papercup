/**
 * feature-audit.integration.test.ts — auditFeatureChange, the fire-and-forget
 * feature-mutation audit writer (feature_audit_consolidated, migration 118,
 * drizzle), against a real Postgres.
 *
 * auditFeatureChange returns void and writes via a DETACHED async IIFE (never
 * blocks the caller), so the test polls for the row. Behaviors a fake-db unit
 * test can't prove: the values are JSON.stringify'd into text columns (an object
 * stored as JSON, not "[object Object]"); undefined old/new → NULL; the row lands
 * with the active workspace + an epoch-ms ts; the BIGSERIAL id auto-fills.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-fa';
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ db: h.db }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { auditFeatureChange } = await import('./feature-audit');

let rootSql: postgres.Sql;

type Row = { harness_slug: string; feature_id: string; field: string; old_value: string | null; new_value: string | null; actor: string; workspace_id: string; ts: string };
async function waitRows(min: number, ms = 3000): Promise<Row[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = (await rootSql`SELECT * FROM harness_shared.feature_audit_consolidated ORDER BY id`) as unknown as Row[];
    if (rows.length >= min || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `fa_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to migration 118: id has a sequence default (bigserial stands in); ts bigint, values text.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.feature_audit_consolidated (
      id bigserial PRIMARY KEY,
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      ts bigint NOT NULL,
      field text NOT NULL,
      old_value text, new_value text, actor text
    )`);
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.feature_audit_consolidated RESTART IDENTITY`;
});

describe('auditFeatureChange (PG, fire-and-forget)', () => {
  it('writes a row with JSON-serialized values, the active workspace, and an epoch-ms ts', async () => {
    const before = Date.now();
    auditFeatureChange('web', 'F-1', 'status', { a: 1 }, 'done', 'su-1');
    const [row] = await waitRows(1);
    expect(row).toMatchObject({
      harness_slug: 'web', feature_id: 'F-1', field: 'status',
      old_value: '{"a":1}', // object → JSON text (not "[object Object]")
      new_value: '"done"', // string → JSON-quoted
      actor: 'su-1', workspace_id: WS,
    });
    expect(Number(row!.ts)).toBeGreaterThanOrEqual(before); // Date.now() stamp
  });

  it('serializes undefined old/new values to NULL columns', async () => {
    auditFeatureChange('web', 'F-2', 'created', undefined, { x: 2 }, 'su-2');
    const [row] = await waitRows(1);
    expect(row!.old_value).toBeNull();
    expect(row!.new_value).toBe('{"x":2}');
  });
});
