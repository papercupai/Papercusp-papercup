/**
 * feature-claims.integration.test.ts — the Hyperbee→PG projection for
 * feature_claims (append-only), against a real Postgres. The projection takes an
 * injectable `opts.sql`, so the testcontainer handle goes straight in.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - writeToPg inserts a claim, converting claimed_at (epoch ms) via
 *    to_timestamp(ms/1000) to the timestamptz column;
 *  - APPEND-ONLY idempotency: ON CONFLICT (workspace, harness, feature, seq) DO
 *    NOTHING — a replay of the same key is a no-op (the first record wins);
 *  - the HARNESS-ISOLATION guard: a row whose harness_slug != the projection's
 *    harness is dropped (a projection only writes its own harness's claims);
 *  - deleteFromPg is a no-op (append-only never deletes).
 * The pure decode guard (isFeatureClaimRow) is tested directly.
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

const { buildFeatureClaimsProjection, _testing } = await import('./feature-claims');

const WS = 'ws-fc';
const LOCAL_PROVENANCE = { authorPubkey: '', origin: 'local' as const };
let rootSql: postgres.Sql;
const row = (over: Record<string, unknown> = {}) => ({
  harness_slug: 'web', feature_id: 'F-1', seq: 0,
  claimer_pubkey: 'pk-aaa', claimer_github_user_id: 12345, claimed_at: 1_716_000_000_000,
  outcome: null, schema_version: 1, ...over,
}) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `fc_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to baseline: seq/github_user_id bigint, claimed_at timestamptz, 4-col PK.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.feature_claims (
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      seq bigint NOT NULL,
      claimer_pubkey text NOT NULL,
      claimer_github_user_id bigint NOT NULL,
      claimed_at timestamptz NOT NULL,
      outcome text,
      schema_version bigint DEFAULT 1 NOT NULL,
      CONSTRAINT feature_claims_pkey PRIMARY KEY (workspace_id, harness_slug, feature_id, seq)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.feature_claims`;
});

const proj = () => buildFeatureClaimsProjection({ sql: rootSql, workspaceId: WS, harnessSlug: 'web' });

describe('feature-claims projection writeToPg (PG)', () => {
  it('inserts a claim, converting claimed_at epoch-ms via to_timestamp(ms/1000)', async () => {
    await proj().writeToPg(row({ claimer_pubkey: 'pk-x', claimer_github_user_id: 999, outcome: 'won' }), LOCAL_PROVENANCE);
    const r = (await rootSql<{ feature_id: string; seq: string; outcome: string; ms: string; gh: string }[]>`
      SELECT feature_id, seq, outcome, claimer_github_user_id AS gh, (extract(epoch from claimed_at) * 1000)::bigint AS ms
        FROM harness_shared.feature_claims`)[0]!;
    expect(r).toMatchObject({ feature_id: 'F-1', outcome: 'won' });
    expect(Number(r.seq)).toBe(0);
    expect(Number(r.gh)).toBe(999);
    expect(Number(r.ms)).toBe(1_716_000_000_000); // epoch-ms round-trips
  });

  it('is APPEND-ONLY idempotent — a replay of the same (feature, seq) is a no-op', async () => {
    await proj().writeToPg(row({ seq: 0, claimer_pubkey: 'first' }), LOCAL_PROVENANCE);
    await proj().writeToPg(row({ seq: 0, claimer_pubkey: 'second' }), LOCAL_PROVENANCE); // same PK → DO NOTHING
    const rows = await rootSql<{ claimer_pubkey: string }[]>`SELECT claimer_pubkey FROM harness_shared.feature_claims`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claimer_pubkey).toBe('first'); // first record wins
  });

  it('HARNESS ISOLATION: drops a row whose harness_slug != the projection harness', async () => {
    await proj().writeToPg(row({ harness_slug: 'api', feature_id: 'F-OTHER' }), LOCAL_PROVENANCE); // 'web' projection, 'api' row
    expect(await rootSql`SELECT 1 FROM harness_shared.feature_claims`).toHaveLength(0); // not written
  });

  it('deleteFromPg is a no-op (append-only never deletes)', async () => {
    await proj().writeToPg(row({ seq: 5 }), LOCAL_PROVENANCE);
    await proj().deleteFromPg('F-1/5');
    expect(await rootSql`SELECT 1 FROM harness_shared.feature_claims WHERE seq = 5`).toHaveLength(1); // still there
  });
});

describe('isFeatureClaimRow / composeKey (pure)', () => {
  it('accepts a well-formed row and rejects malformed ones', () => {
    expect(_testing.isFeatureClaimRow(row())).toBe(true);
    expect(_testing.decodeValue(row())).not.toBeNull();
    expect(_testing.isFeatureClaimRow(row({ seq: -1 }))).toBe(false); // seq must be >= 0
    expect(_testing.isFeatureClaimRow(row({ seq: 1.5 }))).toBe(false); // and an integer
    expect(_testing.isFeatureClaimRow(row({ claimer_github_user_id: 'x' }))).toBe(false); // wrong type
    expect(_testing.isFeatureClaimRow({ feature_id: 'F-1' })).toBe(false); // missing fields
    expect(_testing.decodeValue({ junk: true })).toBeNull();
    expect(_testing.composeKey(row({ feature_id: 'F-9', seq: 3 }))).toBe('F-9/3');
  });
});
