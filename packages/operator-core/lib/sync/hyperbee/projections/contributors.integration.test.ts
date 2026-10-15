/**
 * contributors.integration.test.ts — the Hyperbee→PG projection for contributors,
 * against a real Postgres (injectable opts.sql).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - device_attestations is stored as a proper jsonb ARRAY via the
 *    `${JSON.stringify(...)}::text::jsonb` double-encode-avoidance (a bare ::jsonb
 *    would store a string scalar — the documented postgres-js binding gotcha);
 *  - revoked_pubkeys round-trips as text[]; the epoch timestamps convert;
 *  - the harness-isolation guard + the EI-79 LWW fed_ts guard;
 *  - deleteFromPg parses <github_user_id> and ts-guards the delete.
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

const { buildContributorsProjection, _testing } = await import('./contributors');

const WS = 'ws-co';
let rootSql: postgres.Sql;
const row = (over: Record<string, unknown> = {}) => ({
  harness_slug: 'web', github_user_id: 42, github_username: 'alice',
  display_name: 'Alice', avatar_url: 'https://x/a.png',
  device_attestations: [{ pubkey: 'pk1', sig: 's1' }], revoked_pubkeys: ['old-pk'],
  joined_at: 1_716_000_000_000, last_seen_at: 1_716_000_050_000,
  schema_version: 1, binding_status: 'verified',
  channel1_verified_at: null, channel2_verified_at: null,
  channel2_branch_ref: null, binding_last_checked_at: null, ...over,
}) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `co_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL: device_attestations jsonb, revoked_pubkeys text[], timestamptz cols, fed_ts bigint (later ALTER).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.contributors (
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text NOT NULL,
      github_user_id bigint NOT NULL,
      github_username text NOT NULL,
      display_name text, avatar_url text,
      device_attestations jsonb DEFAULT '[]'::jsonb NOT NULL,
      revoked_pubkeys text[] DEFAULT '{}'::text[] NOT NULL,
      joined_at timestamptz DEFAULT now() NOT NULL,
      last_seen_at timestamptz,
      schema_version bigint DEFAULT 1 NOT NULL,
      binding_status text DEFAULT 'unverified' NOT NULL,
      channel1_verified_at timestamptz, channel2_verified_at timestamptz,
      channel2_branch_ref text, binding_last_checked_at timestamptz,
      fed_ts bigint,
      fed_hlc text,
      CONSTRAINT contributors_pkey PRIMARY KEY (workspace_id, harness_slug, github_user_id)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.contributors`;
});

const proj = () => buildContributorsProjection({ sql: rootSql, workspaceId: WS, harnessSlug: 'web' });

describe('contributors writeToPg (PG)', () => {
  it('stores device_attestations as a proper jsonb ARRAY (::text::jsonb), revoked_pubkeys as text[], epoch joined_at', async () => {
    await proj().writeToPg(row(), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    const r = (await rootSql<{ typ: string; pk: string; revoked: string[]; ms: string; fed_ts: string; binding_status: string }[]>`
      SELECT jsonb_typeof(device_attestations) AS typ, device_attestations->0->>'pubkey' AS pk,
             revoked_pubkeys AS revoked, (extract(epoch from joined_at)*1000)::bigint AS ms,
             fed_ts, binding_status
        FROM harness_shared.contributors`)[0]!;
    expect(r.typ).toBe('array'); // NOT a double-encoded string scalar
    expect(r.pk).toBe('pk1'); // queryable by element
    expect(r.revoked).toEqual(['old-pk']); // text[]
    expect(Number(r.ms)).toBe(1_716_000_000_000); // epoch joined_at
    expect(Number(r.fed_ts)).toBe(100);
    expect(r.binding_status).toBe('verified');
  });

  it('HARNESS ISOLATION: drops a row for a different harness', async () => {
    await proj().writeToPg(row({ harness_slug: 'api' }), { ts: 1, authorPubkey: 'pk-a', origin: 'local' });
    expect(await rootSql`SELECT 1 FROM harness_shared.contributors`).toHaveLength(0);
  });

  it('EI-79 LWW: an older fed_ts op does not overwrite a newer row', async () => {
    await proj().writeToPg(row({ github_username: 'first' }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    await proj().writeToPg(row({ github_username: 'older' }), { ts: 50, authorPubkey: 'pk-a', origin: 'local' }); // dropped
    expect((await rootSql`SELECT github_username FROM harness_shared.contributors`)[0]!.github_username).toBe('first');
  });
});

describe('contributors deleteFromPg (PG)', () => {
  it('hard-deletes by github_user_id; a stale del (older ts) does not erase a newer row', async () => {
    await proj().writeToPg(row({ github_user_id: 7 }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    await proj().deleteFromPg('7', 50); // stale → blocked by ts-guard
    expect(await rootSql`SELECT 1 FROM harness_shared.contributors WHERE github_user_id=7`).toHaveLength(1);
    await proj().deleteFromPg('7', 200); // newer → applies
    expect(await rootSql`SELECT 1 FROM harness_shared.contributors WHERE github_user_id=7`).toHaveLength(0);
  });
});

describe('decodeValue (pure)', () => {
  it('accepts a well-formed contributor row and rejects junk', () => {
    expect(_testing.decodeValue(row())).not.toBeNull();
    expect(_testing.decodeValue({ github_user_id: 1 })).toBeNull();
    expect(_testing.composeKey(row({ github_user_id: 99 }))).toBe('99');
  });
});
