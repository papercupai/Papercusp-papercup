/**
 * coord-thread.integration.test.ts — the Hyperbee→PG projection for coord_threads
 * (thread header), against a real Postgres (injectable opts.sql).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - the upsert on PK (workspace_id, thread_id) with epoch created_at + a NULLABLE
 *    last_post_at (null stays null; a number → to_timestamp(ms/1000));
 *  - POST_COUNT RIDES THE HEADER: a newer re-federation of the thread carries the
 *    updated post_count (the remote post projection doesn't bump it), so the
 *    DO UPDATE must set post_count = EXCLUDED.post_count;
 *  - LWW guard + harness isolation + ts-guarded delete.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { FED_ORDER_KEY_DDL } from '../../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { buildCoordThreadProjection, _testing } = await import('./coord-thread');

const WS = 'ws-ct';
let rootSql: postgres.Sql;
const row = (over: Record<string, unknown> = {}) => ({
  harness_slug: 'web', thread_id: 'thr-1', parent_kind: 'conversation', parent_ref: 'conv-1',
  title: 'Thread', created_by: 'u1', created_at: 1_716_000_000_000,
  last_post_at: 1_716_000_050_000, post_count: 3, ...over,
}) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ct_${randomBytes(5).toString('hex')}`;
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
  // Federation ordering key (mig-458 / EI-1698) — projection LWW guards call
  // harness_shared.fed_order_key(hlc, ts); this hand-provisioned DB skips mig-458,
  // so seed it or every projection write/delete throws "function … does not exist".
  await rootSql.unsafe(FED_ORDER_KEY_DDL);
  // FAITHFUL to mig 123 + later ALTERs: created_at/last_post_at timestamptz, post_count int, federated cols + fed_ts.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_threads (
      workspace_id text DEFAULT 'default' NOT NULL,
      thread_id text NOT NULL,
      parent_kind text NOT NULL,
      parent_ref text NOT NULL,
      title text, created_by text,
      created_at timestamptz DEFAULT now() NOT NULL,
      last_post_at timestamptz,
      post_count integer DEFAULT 0 NOT NULL,
      harness_slug text, origin text DEFAULT 'local' NOT NULL, author_pubkey text, fed_ts bigint,
      fed_hlc text,
      CONSTRAINT coord_threads_pkey PRIMARY KEY (workspace_id, thread_id),
      CONSTRAINT coord_threads_parent_nonempty CHECK (parent_ref <> '' AND parent_kind <> '')
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_threads`;
});

const proj = () => buildCoordThreadProjection({ sql: rootSql, workspaceId: WS, harnessSlug: 'web' });

describe('coord-thread writeToPg (PG)', () => {
  it('upserts the header: epoch created_at + last_post_at, parent + provenance', async () => {
    await proj().writeToPg(row({ post_count: 4 }), { ts: 100, origin: 'remote', authorPubkey: 'pk-a' });
    const r = (await rootSql<{ parent_kind: string; parent_ref: string; title: string; post_count: number; origin: string; created_ms: string; last_ms: string }[]>`
      SELECT parent_kind, parent_ref, title, post_count, origin,
             (extract(epoch from created_at)*1000)::bigint AS created_ms,
             (extract(epoch from last_post_at)*1000)::bigint AS last_ms
        FROM harness_shared.coord_threads`)[0]!;
    expect(r).toMatchObject({ parent_kind: 'conversation', parent_ref: 'conv-1', title: 'Thread', post_count: 4, origin: 'remote' });
    expect(Number(r.created_ms)).toBe(1_716_000_000_000);
    expect(Number(r.last_ms)).toBe(1_716_000_050_000);
  });

  it('a null last_post_at stays NULL (nullable epoch conditional)', async () => {
    await proj().writeToPg(row({ last_post_at: null }), { ts: 1, authorPubkey: 'pk-a', origin: 'local' });
    expect((await rootSql`SELECT last_post_at FROM harness_shared.coord_threads`)[0]!.last_post_at).toBeNull();
  });

  it('POST_COUNT RIDES THE HEADER: a newer re-federation carries the updated post_count', async () => {
    await proj().writeToPg(row({ thread_id: 'T1', post_count: 5 }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    await proj().writeToPg(row({ thread_id: 'T1', post_count: 10 }), { ts: 200, authorPubkey: 'pk-a', origin: 'local' }); // newer fed_ts → applies
    expect(Number((await rootSql`SELECT post_count FROM harness_shared.coord_threads WHERE thread_id='T1'`)[0]!.post_count)).toBe(10);
  });

  it('HARNESS ISOLATION + ts-guarded delete', async () => {
    await proj().writeToPg(row({ harness_slug: 'api', thread_id: 'X' }), { ts: 1, authorPubkey: 'pk-a', origin: 'local' });
    expect(await rootSql`SELECT 1 FROM harness_shared.coord_threads`).toHaveLength(0); // wrong harness dropped

    await proj().writeToPg(row({ thread_id: 'D1' }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    await proj().deleteFromPg('D1', 50); // stale → blocked
    expect(await rootSql`SELECT 1 FROM harness_shared.coord_threads WHERE thread_id='D1'`).toHaveLength(1);
    await proj().deleteFromPg('D1', 200); // newer → applies
    expect(await rootSql`SELECT 1 FROM harness_shared.coord_threads WHERE thread_id='D1'`).toHaveLength(0);
  });
});

describe('isCoordThreadRow (pure)', () => {
  it('accepts a well-formed thread (nullable title/created_by/last_post_at) and rejects malformed', () => {
    expect(_testing.isCoordThreadRow(row())).toBe(true);
    expect(_testing.isCoordThreadRow(row({ title: null, created_by: null, last_post_at: null }))).toBe(true);
    expect(_testing.isCoordThreadRow(row({ parent_ref: '' }))).toBe(false);
    expect(_testing.isCoordThreadRow(row({ post_count: 1.5 }))).toBe(false); // must be an integer
    expect(_testing.decodeValue({ junk: 1 })).toBeNull();
    expect(_testing.composeKey(row({ thread_id: 'thr-9' }))).toBe('thr-9');
  });
});
