/**
 * feature-queue.integration.test.ts — the Hyperbee→PG projection for feature_queue
 * (per-user queue pointer, soft-delete + federation LWW), against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - writeToPg upserts with to_timestamp(ms/1000) for queued_at/removed_at + the
 *    provenance columns (author_pubkey, origin, fed_ts);
 *  - the EI-79 LWW guard: ON CONFLICT … WHERE fed_ts IS NULL OR EXCLUDED.fed_ts >=
 *    fed_ts — a strictly-OLDER federated op is DROPPED, a newer one applies;
 *  - the harness-isolation guard;
 *  - deleteFromPg parses `<userId>/<featureId>` and ts-guards the delete (a stale
 *    del must not erase a newer row).
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

const { buildFeatureQueueProjection, _testing } = await import('./feature-queue');

const WS = 'ws-fq';
let rootSql: postgres.Sql;
const row = (over: Record<string, unknown> = {}) => ({
  harness_slug: 'web', github_user_id: 1, feature_id: 'F-1',
  queued_at: 1_716_000_000_000, removed_at: null, schema_version: 1, ...over,
}) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `fq_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL: queued_at/removed_at timestamptz, fed_ts bigint (added by a later migration), 4-col PK.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.feature_queue (
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text NOT NULL,
      github_user_id bigint NOT NULL,
      feature_id text NOT NULL,
      queued_at timestamptz DEFAULT now() NOT NULL,
      removed_at timestamptz,
      author_pubkey text,
      origin text DEFAULT 'local' NOT NULL,
      schema_version bigint DEFAULT 1 NOT NULL,
      fed_ts bigint,
      fed_hlc text,
      CONSTRAINT feature_queue_pkey PRIMARY KEY (workspace_id, harness_slug, github_user_id, feature_id)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.feature_queue`;
});

const proj = () => buildFeatureQueueProjection({ sql: rootSql, workspaceId: WS, harnessSlug: 'web' });
const epochMs = async (col: string) =>
  Number((await rootSql.unsafe(`SELECT (extract(epoch from ${col}) * 1000)::bigint AS v FROM harness_shared.feature_queue`))[0]!.v);

describe('feature-queue writeToPg (PG)', () => {
  it('upserts with epoch timestamps + provenance columns', async () => {
    await proj().writeToPg(row({ removed_at: 1_716_000_050_000 }), { ts: 100, authorPubkey: 'pk-a', origin: 'remote' });
    const r = (await rootSql<{ origin: string; author_pubkey: string; fed_ts: string }[]>`
      SELECT origin, author_pubkey, fed_ts FROM harness_shared.feature_queue`)[0]!;
    expect(r).toMatchObject({ origin: 'remote', author_pubkey: 'pk-a' });
    expect(Number(r.fed_ts)).toBe(100);
    expect(await epochMs('queued_at')).toBe(1_716_000_000_000);
    expect(await epochMs('removed_at')).toBe(1_716_000_050_000); // soft-delete tombstone ts
  });

  it('EI-79 LWW: a strictly-OLDER fed_ts op is DROPPED; a newer one applies', async () => {
    await proj().writeToPg(row({ queued_at: 1000 }), { ts: 100, authorPubkey: 'first', origin: 'local' });
    await proj().writeToPg(row({ queued_at: 2000 }), { ts: 50, authorPubkey: 'older', origin: 'local' }); // older fed_ts → dropped
    let r = (await rootSql<{ author_pubkey: string; fed_ts: string }[]>`SELECT author_pubkey, fed_ts FROM harness_shared.feature_queue`)[0]!;
    expect(r.author_pubkey).toBe('first'); // older op did NOT overwrite
    expect(Number(r.fed_ts)).toBe(100);

    await proj().writeToPg(row({ queued_at: 3000 }), { ts: 200, authorPubkey: 'newer', origin: 'local' }); // newer fed_ts → applies
    r = (await rootSql<{ author_pubkey: string; fed_ts: string }[]>`SELECT author_pubkey, fed_ts FROM harness_shared.feature_queue`)[0]!;
    expect(r.author_pubkey).toBe('newer');
    expect(Number(r.fed_ts)).toBe(200);
  });

  it('HARNESS ISOLATION: drops a row for a different harness', async () => {
    await proj().writeToPg(row({ harness_slug: 'api' }), { ts: 1, authorPubkey: 'pk-a', origin: 'local' });
    expect(await rootSql`SELECT 1 FROM harness_shared.feature_queue`).toHaveLength(0);
  });
});

describe('feature-queue deleteFromPg (PG)', () => {
  it('hard-deletes the parsed <userId>/<featureId>, but a STALE del (older ts) does not erase a newer row', async () => {
    await proj().writeToPg(row({ github_user_id: 7, feature_id: 'F-9' }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    await proj().deleteFromPg('7/F-9', 50); // stale del (50 < fed_ts 100) → ts-guard blocks
    expect(await rootSql`SELECT 1 FROM harness_shared.feature_queue WHERE github_user_id=7`).toHaveLength(1); // survived
    await proj().deleteFromPg('7/F-9', 200); // newer del → applies
    expect(await rootSql`SELECT 1 FROM harness_shared.feature_queue WHERE github_user_id=7`).toHaveLength(0);
  });
});

describe('isFeatureQueueRow (pure)', () => {
  it('accepts a well-formed row and rejects malformed ones', () => {
    expect(_testing.isFeatureQueueRow(row())).toBe(true);
    expect(_testing.isFeatureQueueRow(row({ github_user_id: 0 }))).toBe(false); // must be > 0
    expect(_testing.isFeatureQueueRow(row({ github_user_id: 1.5 }))).toBe(false); // and integer
    expect(_testing.isFeatureQueueRow(row({ harness_slug: '' }))).toBe(false); // non-empty
    expect(_testing.isFeatureQueueRow(row({ removed_at: 'x' }))).toBe(false); // null or number only
    expect(_testing.decodeValue({ nope: 1 })).toBeNull();
    expect(_testing.composeKey(row({ github_user_id: 42, feature_id: 'F-2' }))).toBe('42/F-2');
  });
});
