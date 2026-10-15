/**
 * store.integration.test.ts — PgPlanPartsStore (harness_plan_parts, migration 270),
 * against a real Postgres. Injectable sql.
 *
 * Behaviors a fake-sql unit test can't prove — the LWW upsert guard decides
 * atomically in the ON CONFLICT … WHERE (no read-modify-write race):
 *  - a STRICTLY-NEWER fed_ts wins; an older one is DROPPED;
 *  - on EQUAL fed_ts, the lexically-GREATER author wins (deterministic tie-break
 *    so all peers converge);
 *  - tombstones are SOFT (a flag, not a DELETE) so a late op is still LWW-ordered;
 *  - getParts is scoped to (workspace, harness, plan).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const { PgPlanPartsStore } = await import('./store');

const WS = 'ws-pp';
let rootSql: postgres.Sql;
const store = (harness = 'web') => new PgPlanPartsStore(rootSql, WS, harness);
const part = (over: Record<string, unknown> = {}) =>
  ({ key: 'section:intro', kind: 'section', text: 'A', order: 0, fedTs: 100, author: 'alice', ...over }) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pp_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to migration 270 (incl. the generated part_fed_key + epoch-ms created/updated defaults).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_plan_parts (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL, part_key text NOT NULL,
      kind text NOT NULL, body text NOT NULL DEFAULT '', ordinal integer NOT NULL DEFAULT 0,
      fed_ts bigint NOT NULL, author text, tombstone boolean NOT NULL DEFAULT false, origin text NOT NULL DEFAULT 'local',
      part_fed_key text GENERATED ALWAYS AS (plan_slug || '/' || part_key) STORED,
      created_at bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
      updated_at bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
      CONSTRAINT harness_plan_parts_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, part_key)
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_plan_parts`;
});

const partOf = async (plan: string, key: string, harness = 'web') => (await store(harness).getParts(plan)).get(key);

describe('PgPlanPartsStore LWW upsert (PG)', () => {
  it('upsert → getParts round-trips the part', async () => {
    await store().upsertPart('p1', part({ text: 'hello', order: 3, author: 'dev1' }));
    expect(await partOf('p1', 'section:intro')).toMatchObject({ key: 'section:intro', kind: 'section', text: 'hello', order: 3, fedTs: 100, author: 'dev1' });
  });

  it('a STRICTLY-NEWER fed_ts wins; an OLDER one is dropped', async () => {
    await store().upsertPart('p1', part({ fedTs: 200, text: 'new' }));
    await store().upsertPart('p1', part({ fedTs: 100, text: 'old' })); // older → dropped
    expect((await partOf('p1', 'section:intro'))!.text).toBe('new');
  });

  it('on EQUAL fed_ts, the lexically-GREATER author wins (deterministic tie-break)', async () => {
    await store().upsertPart('p1', part({ fedTs: 100, author: 'alice', text: 'A' }));
    await store().upsertPart('p1', part({ fedTs: 100, author: 'bob', text: 'B' }));   // bob > alice → wins
    await store().upsertPart('p1', part({ fedTs: 100, author: 'aaa', text: 'C' }));   // aaa < bob → dropped
    const p = (await partOf('p1', 'section:intro'))!;
    expect(p.text).toBe('B');
    expect(p.author).toBe('bob');
  });

  it('a tombstone is a SOFT flag (newer fed_ts) — the part is kept, marked tombstone', async () => {
    await store().upsertPart('p1', part({ fedTs: 100, text: 'live' }));
    await store().upsertPart('p1', part({ fedTs: 300, tombstone: true, text: '' }));
    const p = (await partOf('p1', 'section:intro'))!;
    expect(p.tombstone).toBe(true); // not deleted
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_plan_parts WHERE part_key='section:intro'`).toHaveLength(1);
  });

  it('getParts is scoped to (workspace, harness, plan)', async () => {
    await store('web').upsertPart('p1', part({ key: 'k', text: 'web' }));
    await store('api').upsertPart('p1', part({ key: 'k', text: 'api' }));
    expect((await partOf('p1', 'k', 'web'))!.text).toBe('web'); // only this harness's part
    expect((await store('web').getParts('other-plan')).size).toBe(0); // other plan empty
  });
});
