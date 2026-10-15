/**
 * usage.integration.test.ts — the Hyperbee→PG projection for the append-only
 * contributor_usage_events ledger, against a real Postgres (injectable opts.sql).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - APPEND-ONLY: ON CONFLICT (harness_slug, event_id) DO NOTHING — a re-delivery
 *    of the same event_id is a no-op (the first event is immutable; this ledger is
 *    the source of truth for tier-C stats, so an overwrite would corrupt history);
 *  - payload stored as a proper jsonb object via ::text::jsonb;
 *  - the echo-guard origin (remote from provenance, 'local' default) + ts epoch;
 *  - harness isolation + deleteFromPg no-op (append-only never deletes).
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

const { buildUsageProjection, _testing } = await import('./usage');

const WS = 'ws-us';
const LOCAL_PROVENANCE = { authorPubkey: '', origin: 'local' as const };
let rootSql: postgres.Sql;
const row = (over: Record<string, unknown> = {}) => ({
  harness_slug: 'web', event_id: 'E1', github_user_id: 1, device_pubkey: 'dk1',
  kind: 'view', ref_id: 'F-1', payload: { count: 5 }, ts: 1_716_000_000_000, schema_version: 1, ...over,
}) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `us_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL: payload jsonb, ts timestamptz, origin NOT NULL DEFAULT 'local' (later ALTER), 2-col PK.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.contributor_usage_events (
      harness_slug text NOT NULL,
      event_id text NOT NULL,
      github_user_id bigint NOT NULL,
      device_pubkey text NOT NULL,
      kind text NOT NULL,
      ref_id text,
      payload jsonb,
      ts timestamptz DEFAULT now() NOT NULL,
      schema_version bigint DEFAULT 1 NOT NULL,
      origin text NOT NULL DEFAULT 'local',
      CONSTRAINT contributor_usage_events_pkey PRIMARY KEY (harness_slug, event_id)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.contributor_usage_events`;
});

const proj = () => buildUsageProjection({ sql: rootSql, workspaceId: WS, harnessSlug: 'web' });

describe('usage writeToPg (PG)', () => {
  it('inserts an event: jsonb payload, epoch ts, echo-guard origin (remote vs local default)', async () => {
    await proj().writeToPg(row({ event_id: 'E1', payload: { count: 5, action: 'view' } }), { origin: 'remote', authorPubkey: 'pk-a' });
    await proj().writeToPg(row({ event_id: 'E2' }), LOCAL_PROVENANCE);
    const r = (await rootSql<{ typ: string; cnt: string; origin: string; ms: string }[]>`
      SELECT jsonb_typeof(payload) AS typ, payload->>'count' AS cnt, origin,
             (extract(epoch from ts)*1000)::bigint AS ms
        FROM harness_shared.contributor_usage_events WHERE event_id='E1'`)[0]!;
    expect(r.typ).toBe('object'); // ::text::jsonb → real object
    expect(r.cnt).toBe('5');
    expect(r.origin).toBe('remote'); // stamped remote → capture trigger skips re-federation
    expect(Number(r.ms)).toBe(1_716_000_000_000);
    expect((await rootSql`SELECT origin FROM harness_shared.contributor_usage_events WHERE event_id='E2'`)[0]!.origin).toBe('local');
  });

  it('APPEND-ONLY: a re-delivery of the same event_id is a no-op (first event immutable)', async () => {
    await proj().writeToPg(row({ event_id: 'E9', kind: 'view' }), LOCAL_PROVENANCE);
    await proj().writeToPg(row({ event_id: 'E9', kind: 'edit' }), LOCAL_PROVENANCE); // same PK → DO NOTHING
    const rows = await rootSql<{ kind: string }[]>`SELECT kind FROM harness_shared.contributor_usage_events WHERE event_id='E9'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('view'); // first event wins; NOT overwritten
  });

  it('HARNESS ISOLATION: drops an event for a different harness', async () => {
    await proj().writeToPg(row({ harness_slug: 'api', event_id: 'X' }), LOCAL_PROVENANCE);
    expect(await rootSql`SELECT 1 FROM harness_shared.contributor_usage_events`).toHaveLength(0);
  });

  it('deleteFromPg is a no-op (append-only never deletes)', async () => {
    await proj().writeToPg(row({ event_id: 'keep' }), LOCAL_PROVENANCE);
    await proj().deleteFromPg('1/keep');
    expect(await rootSql`SELECT 1 FROM harness_shared.contributor_usage_events WHERE event_id='keep'`).toHaveLength(1);
  });
});

describe('isContributorUsageEventRow (pure)', () => {
  it('accepts a well-formed event and rejects malformed', () => {
    expect(_testing.isContributorUsageEventRow(row())).toBe(true);
    expect(_testing.isContributorUsageEventRow(row({ event_id: '' }))).toBe(false);
    expect(_testing.isContributorUsageEventRow(row({ github_user_id: 0 }))).toBe(false);
    expect(_testing.isContributorUsageEventRow(row({ kind: '' }))).toBe(false);
    expect(_testing.decodeValue({ junk: 1 })).toBeNull();
    expect(_testing.composeKey(row({ github_user_id: 7, event_id: 'E5' }))).toBe('7/E5');
  });
});
