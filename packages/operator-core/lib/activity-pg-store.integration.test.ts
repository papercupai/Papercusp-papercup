/**
 * activity-pg-store.integration.test.ts — the PG TelemetryStore over
 * harness_shared.agent_activity (migration 143), against a real Postgres.
 *
 * The behavior a fake-sql unit test can't prove is the `${json}::text::jsonb`
 * double-encode-avoidance gotcha: postgres-js JSON-encodes a string param first,
 * so a bare `${json}::jsonb` would store a jsonb STRING SCALAR (detail->>'k' null);
 * the `::text::jsonb` cast stores a proper queryable jsonb OBJECT. Plus the
 * scope→harness_slug mapping, owner→owner_id, the '*' workspace default, and the
 * BIGSERIAL id RETURNING.
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

const { createPgTelemetryStore } = await import('./activity-pg-store');

const rec = (over: Record<string, unknown> = {}) => ({
  owner: 'su-1', agent: 'builder-1', sessionId: 'sess', scope: 'web', kind: 'tool',
  toolName: 'Bash', phase: 'start', toolUseId: 'tu-1', summary: 'ran', status: 'ok',
  cwd: '/repo', detail: null, workspaceId: undefined, ...over,
}) as never;

let rootSql: postgres.Sql;
let store: ReturnType<typeof createPgTelemetryStore>;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `act_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to migration 143: BIGSERIAL id, workspace_id default '*', detail jsonb.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_activity (
      id BIGSERIAL PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT '*',
      owner_id text NOT NULL,
      agent text, session_id text, harness_slug text,
      kind text NOT NULL, tool_name text, phase text, tool_use_id text,
      summary text, status text, detail jsonb, cwd text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  h.sql = rootSql;
  store = createPgTelemetryStore();
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.agent_activity`;
});

describe('createPgTelemetryStore.append (PG)', () => {
  it('inserts a row (scope→harness_slug, owner→owner_id) and RETURNs the BIGSERIAL id', async () => {
    const { id } = await store.append(rec());
    expect(id).toMatch(/^\d+$/); // bigserial id as text
    const row = (await rootSql<{ harness_slug: string; owner_id: string; kind: string; tool_name: string }[]>`
      SELECT harness_slug, owner_id, kind, tool_name FROM harness_shared.agent_activity WHERE id = ${id}`)[0]!;
    expect(row).toMatchObject({ harness_slug: 'web', owner_id: 'su-1', kind: 'tool', tool_name: 'Bash' });
  });

  it('defaults the workspace to "*" when the record has none', async () => {
    const { id } = await store.append(rec({ workspaceId: undefined }));
    const ws = (await rootSql`SELECT workspace_id FROM harness_shared.agent_activity WHERE id=${id}`)[0]!.workspace_id;
    expect(ws).toBe('*');
  });

  it('honours an explicit workspaceId', async () => {
    const { id } = await store.append(rec({ workspaceId: 'ws-7' }));
    const ws = (await rootSql`SELECT workspace_id FROM harness_shared.agent_activity WHERE id=${id}`)[0]!.workspace_id;
    expect(ws).toBe('ws-7');
  });

  it('stores detail as a proper jsonb OBJECT (the ::text::jsonb double-encode-avoidance), queryable by key', async () => {
    const { id } = await store.append(rec({ detail: { todos: ['a', 'b'], count: 2 } }));
    const row = (await rootSql<{ detail: Record<string, unknown>; foo: string | null; typ: string }[]>`
      SELECT detail, detail->>'count' AS foo, jsonb_typeof(detail) AS typ
        FROM harness_shared.agent_activity WHERE id = ${id}`)[0]!;
    expect(row.typ).toBe('object'); // a real jsonb object, NOT a double-encoded string scalar
    expect(row.foo).toBe('2'); // queryable by key
    expect(row.detail).toEqual({ todos: ['a', 'b'], count: 2 });
  });

  it('stores NULL detail when the record has none', async () => {
    const { id } = await store.append(rec({ detail: null }));
    const d = (await rootSql`SELECT detail FROM harness_shared.agent_activity WHERE id=${id}`)[0]!.detail;
    expect(d).toBeNull();
  });
});
