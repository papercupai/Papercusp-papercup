/**
 * publish.integration.test.ts — the generators:publish MCP tool handler, against a
 * real Postgres. The generative-wave expander (expandGeneratorsForFeature) is the
 * downstream forward — mocked; this tests the handler's OWN store logic.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - the published item-set is TRIMMED, EMPTY-FILTERED, and DEDUPED before storage
 *    (one child feature per distinct non-empty item — no dup/blank children);
 *  - items land as a proper jsonb ARRAY via ::text::jsonb;
 *  - re-publishing REPLACES the set (idempotent upsert on (ws, harness, feature)).
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
vi.mock('../plans/expand-generators', () => ({
  expandGeneratorsForFeature: vi.fn(async () => ({ waves: [], expanded: 0, childIds: [], escalations: [] })),
}));

const publishTool = (await import('./publish')).default;
const call = (items: string[], feature = 'F-1') =>
  publishTool.handler({ harness_slug: 'web', feature_id: feature, items } as never, { workspaceId: 'ws1' } as never) as Promise<{ content: { text: string }[] }>;
const itemsOf = async (feature: string) =>
  (await rootSql<{ items: string[]; typ: string }[]>`SELECT items, jsonb_typeof(items) AS typ FROM harness_shared.harness_generator_items WHERE feature_id=${feature}`)[0];

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `gp_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_generator_items (
      workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
      items jsonb DEFAULT '[]'::jsonb NOT NULL, updated_ts bigint NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_generator_items`;
});

describe('generators:publish handler (PG)', () => {
  it('trims, drops empties, and dedupes the item-set; stores a jsonb array', async () => {
    const before = Date.now();
    const res = await call(['a', '  a  ', 'b', '', '  ', 'b', 'c']);
    expect(JSON.parse(res.content[0]!.text).published).toBe(3); // a, b, c
    const row = await itemsOf('F-1');
    expect(row!.typ).toBe('array'); // proper jsonb array (::text::jsonb)
    expect(row!.items).toEqual(['a', 'b', 'c']); // trimmed, deduped, no blanks
    const ts = Number((await rootSql`SELECT updated_ts FROM harness_shared.harness_generator_items WHERE feature_id='F-1'`)[0]!.updated_ts);
    expect(ts).toBeGreaterThanOrEqual(before); // Date.now() epoch-ms
  });

  it('re-publishing REPLACES the set (idempotent upsert)', async () => {
    await call(['a', 'b']);
    await call(['c']); // same (ws, harness, feature) → replace
    expect((await itemsOf('F-1'))!.items).toEqual(['c']); // not merged with [a,b]
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_generator_items WHERE feature_id='F-1'`).toHaveLength(1);
  });
});
