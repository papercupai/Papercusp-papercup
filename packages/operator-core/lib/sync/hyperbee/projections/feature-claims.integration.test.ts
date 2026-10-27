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
import { existsSync, readFileSync } from 'node:fs';
import { encodeHlc } from '@papercusp/locks-core';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { FED_ORDER_KEY_DDL } from '../../../../test/_pg-helpers';
import { applyOpVia, type TableProjection } from '../projection';
import { createMergeCursor, mergeAdmittedLogs, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import type { FeatureClaimRow } from './feature-claims';
import type { PeerLogOp } from '../peer-log';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { buildFeatureClaimsProjection, _testing } = await import('./feature-claims');

const WS = 'ws-fc';
const AUTHOR = 'a'.repeat(64);
const provenance = (value: FeatureClaimRow) => ({ authorPubkey: value.claimer_pubkey,
  sourceLogKeyHex: value.claimer_pubkey, origin: 'remote' as const,
  hbKey: _testing.composeKey(value), ts: value.claimed_at, fedHlc: encodeHlc({ ms: value.claimed_at, count: 0 }) });
let rootSql: postgres.Sql;
const row = (over: Record<string, unknown> = {}) => ({
  harness_slug: 'web', feature_id: 'F-1', seq: 0,
  claimer_pubkey: AUTHOR, claimer_github_user_id: 12345, claimed_at: 1_716_000_000_000,
  outcome: null, schema_version: 1, ...over,
}) as FeatureClaimRow;

async function applyContract() {
  const active = new URL('../../../../../../libs/papercusp/libs/db/sql/1571-p532-author-qualified-claim-events.sql', import.meta.url);
  const draft = new URL(`${active.href}.DRAFT`);
  await rootSql.unsafe(readFileSync(existsSync(draft) ? draft : active, 'utf8'));
}

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
  await rootSql.unsafe(`ALTER TABLE harness_shared.feature_claims DROP CONSTRAINT feature_claims_pkey,
    ADD CONSTRAINT feature_claims_pkey PRIMARY KEY (workspace_id,harness_slug,feature_id,seq)`);
});

const proj = () => buildFeatureClaimsProjection({ sql: rootSql, workspaceId: WS, harnessSlug: 'web' });

describe('feature-claims projection writeToPg (PG)', () => {
  it('inserts a claim, converting claimed_at epoch-ms via to_timestamp(ms/1000)', async () => {
    const value = row({ claimer_github_user_id: 999, outcome: 'won' });
    await proj().writeToPg(value, provenance(value));
    const r = (await rootSql<{ feature_id: string; seq: string; outcome: string; ms: string; gh: string }[]>`
      SELECT feature_id, seq, outcome, claimer_github_user_id AS gh, (extract(epoch from claimed_at) * 1000)::bigint AS ms
        FROM harness_shared.feature_claims`)[0]!;
    expect(r).toMatchObject({ feature_id: 'F-1', outcome: 'won' });
    expect(Number(r.seq)).toBe(0);
    expect(Number(r.gh)).toBe(999);
    expect(Number(r.ms)).toBe(1_716_000_000_000); // epoch-ms round-trips
  });

  it('positively reconciles an exact original replay on the old schema', async () => {
    const value = row();
    await proj().writeToPg(value, provenance(value));
    await expect(proj().writeToPg(value, provenance(value))).resolves.toBeUndefined();
    const rows = await rootSql<{ claimer_pubkey: string }[]>`SELECT claimer_pubkey FROM harness_shared.feature_claims`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claimer_pubkey).toBe(AUTHOR);
  });

  it('HARNESS ISOLATION: drops a row whose harness_slug != the projection harness', async () => {
    const value = row({ harness_slug: 'api', feature_id: 'F-OTHER' });
    await proj().writeToPg(value, provenance(value));
    expect(await rootSql`SELECT 1 FROM harness_shared.feature_claims`).toHaveLength(0); // not written
  });

  it('deleteFromPg is a no-op (append-only never deletes)', async () => {
    const value = row({ seq: 5 });
    await proj().writeToPg(value, provenance(value));
    await proj().deleteFromPg('F-1/5');
    expect(await rootSql`SELECT 1 FROM harness_shared.feature_claims WHERE seq = 5`).toHaveLength(1); // still there
  });

  it('holds an old-schema author collision for replay, then persists both origins after the draft contract', async () => {
    const other = 'b'.repeat(64);
    const values = [row(), row({ claimer_pubkey: other })];
    const logs: AdmittedLog[] = values.map(value => {
      const op: PeerLogOp = { type: 'put', table: 'claims', hbKey: _testing.composeKey(value), value,
        ts: value.claimed_at, hlc: encodeHlc({ ms: value.claimed_at, count: 0 }),
        schema_version: 1, author_pubkey: value.claimer_pubkey };
      return { keyHex: value.claimer_pubkey, length: 1, get: async index => index === 0 ? op : null };
    });
    const projection = proj() as TableProjection<unknown>;
    const lookup = (table: string) => table === 'claims' ? projection : null;
    const options = { getTimeoutMs: 0, applyTimeoutMs: 0, batchApply: false as const,
      projectionLookup: lookup, applyImpl: (op: Parameters<typeof applyOpVia>[1]) =>
        applyOpVia(lookup, op, { ownLogKeyHex: 'c'.repeat(64) }) };
    const cursor = createMergeCursor();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await mergeAdmittedLogsIncremental(logs, cursor, options);
        expect(result.caughtUp).toBe(false);
        expect(cursor.positions.get(AUTHOR)).toBe(1);
        expect(cursor.positions.get(other) ?? 0).toBe(0);
      }
      expect(warning.mock.calls).toEqual([[expect.stringContaining('cursor HELD for replay'),
        expect.stringContaining('Claim event remains unprojected')]]);
      expect(alert.mock.calls).toEqual([[expect.stringContaining('UNAPPLIED BACKLOG'),
        expect.stringContaining('Claim event remains unprojected')]]);
    } finally {
      warning.mockRestore();
      alert.mockRestore();
    }
    expect(await rootSql`SELECT claimer_pubkey FROM harness_shared.feature_claims`).toEqual([{ claimer_pubkey: AUTHOR }]);
    await applyContract(); // This is the disposable test DB, never the live database.
    expect((await mergeAdmittedLogsIncremental(logs, cursor, options)).caughtUp).toBe(true);
    expect(cursor.positions.get(other)).toBe(1);
    await mergeAdmittedLogs([...logs].reverse(), options);
    await mergeAdmittedLogs(logs, options);
    const persisted = await rootSql`SELECT claimer_pubkey FROM harness_shared.feature_claims ORDER BY claimer_pubkey`;
    expect(persisted).toEqual([{ claimer_pubkey: AUTHOR }, { claimer_pubkey: other }]);
  });

  it.each(['old', 'new'])('refuses a changed immutable original instead of calling it an exact replay (%s schema)', async phase => {
    if (phase === 'new') await applyContract();
    const original = row({ outcome: 'won' });
    const modified = { ...original, outcome: 'modified' };
    await proj().writeToPg(original, provenance(original));
    await expect(proj().writeToPg(modified, provenance(modified))).resolves.toBe(false);
    expect(await rootSql`SELECT outcome FROM harness_shared.feature_claims`).toEqual([{ outcome: 'won' }]);
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
    expect(_testing.composeKey(row({ feature_id: 'F-9', seq: 3 }))).toBe(`F-9/${AUTHOR}/3`);
  });
});
