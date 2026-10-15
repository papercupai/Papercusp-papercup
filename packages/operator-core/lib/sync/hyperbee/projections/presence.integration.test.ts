/**
 * presence.integration.test.ts — the Hyperbee→PG projection for shared_presence,
 * against a real Postgres (injectable opts.sql).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - writeToPg upserts on the 4-col PK (incl. machine_label) — same user on TWO
 *    machines is two distinct rows; same (user, machine) re-write upserts one;
 *  - to_timestamp(ms/1000) last_seen_at + provenance fed_ts;
 *  - harness isolation + EI-79 LWW guard + ts-guarded delete.
 * The distinctive decode invariant (tested directly): isSharedPresenceRow accepts
 * a row with hive_slug=string, =null, OR ABSENT — pre-P-008 federated peer-log
 * rows lack hive_slug and must still validate.
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

const { buildPresenceProjection, _testing } = await import('./presence');

const WS = 'ws-pr';
let rootSql: postgres.Sql;
const row = (over: Record<string, unknown> = {}) => ({
  harness_slug: 'web', github_user_id: 1, machine_label: 'laptop',
  device_pubkey: 'dk1', intent: 'reviewing', current_view: 'feature/F-1',
  last_seen_at: 1_716_000_000_000, schema_version: 1, hive_slug: 'web-hive', ...over,
}) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pr_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL: last_seen_at timestamptz, hive_slug text (mig 187), fed_ts bigint, 4-col PK.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.shared_presence (
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text NOT NULL,
      github_user_id bigint NOT NULL,
      machine_label text NOT NULL,
      device_pubkey text NOT NULL,
      intent text, current_view text,
      last_seen_at timestamptz DEFAULT now() NOT NULL,
      runs_routines boolean,
      schema_version bigint DEFAULT 1 NOT NULL,
      pot_slug text, fed_ts bigint,
      fed_hlc text, author_pubkey text,
      active_routines text[],
      CONSTRAINT shared_presence_pkey PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.shared_presence`;
});

const proj = () => buildPresenceProjection({ sql: rootSql, workspaceId: WS, harnessSlug: 'web' });

describe('presence writeToPg (PG)', () => {
  it('keys on (user, machine): two machines are distinct rows; same machine upserts', async () => {
    await proj().writeToPg(row({ machine_label: 'laptop', current_view: 'A' }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    await proj().writeToPg(row({ machine_label: 'desktop', current_view: 'B' }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' }); // 2nd machine
    expect(await rootSql`SELECT 1 FROM harness_shared.shared_presence`).toHaveLength(2);
    await proj().writeToPg(row({ machine_label: 'laptop', current_view: 'A2' }), { ts: 200, authorPubkey: 'pk-a', origin: 'local' }); // same machine → upsert
    const rows = await rootSql<{ machine_label: string; current_view: string }[]>`SELECT machine_label, current_view FROM harness_shared.shared_presence ORDER BY machine_label`;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.machine_label === 'laptop')!.current_view).toBe('A2'); // updated
    expect(await epochMs()).toBe(1_716_000_000_000); // last_seen_at epoch
  });

  it('HARNESS ISOLATION + EI-79 LWW', async () => {
    await proj().writeToPg(row({ harness_slug: 'api' }), { ts: 1, authorPubkey: 'pk-a', origin: 'local' });
    expect(await rootSql`SELECT 1 FROM harness_shared.shared_presence`).toHaveLength(0); // wrong harness dropped

    await proj().writeToPg(row({ device_pubkey: 'first' }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    await proj().writeToPg(row({ device_pubkey: 'older' }), { ts: 50, authorPubkey: 'pk-a', origin: 'local' }); // older → dropped
    expect((await rootSql`SELECT device_pubkey FROM harness_shared.shared_presence`)[0]!.device_pubkey).toBe('first');
  });

  it('deleteFromPg by <user>/<machine>, ts-guarded', async () => {
    await proj().writeToPg(row({ github_user_id: 5, machine_label: 'm1' }), { ts: 100, authorPubkey: 'pk-a', origin: 'local' });
    await proj().deleteFromPg('5/m1', 50, undefined, { ts: 50, authorPubkey: 'pk-a', origin: 'local' }); // stale → blocked
    expect(await rootSql`SELECT 1 FROM harness_shared.shared_presence WHERE github_user_id=5`).toHaveLength(1);
    await proj().deleteFromPg('5/m1', 200, undefined, { ts: 200, authorPubkey: 'pk-a', origin: 'local' }); // newer → applies
    expect(await rootSql`SELECT 1 FROM harness_shared.shared_presence WHERE github_user_id=5`).toHaveLength(0);
  });

  it('refuses a bare tombstone when provenance is absent', async () => {
    await proj().writeToPg(row({ github_user_id: 6, machine_label: 'm1' }), {
      ts: 100,
      authorPubkey: 'pk-a',
      origin: 'local',
    });

    await proj().deleteFromPg('6/m1', 200);

    expect(await rootSql`SELECT 1 FROM harness_shared.shared_presence WHERE github_user_id=6`).toHaveLength(1);
  });
});

describe('isSharedPresenceRow (pure) — hive_slug optionality', () => {
  it('validates with hive_slug present, null, OR ABSENT (pre-P-008), and rejects malformed', () => {
    expect(_testing.isSharedPresenceRow(row({ hive_slug: 'web-hive' }))).toBe(true);
    expect(_testing.isSharedPresenceRow(row({ hive_slug: null }))).toBe(true); // non-Hive harness
    const { hive_slug, ...preP008 } = row() as Record<string, unknown>;
    void hive_slug;
    expect(_testing.isSharedPresenceRow(preP008)).toBe(true); // pre-P-008 row lacks hive_slug — still valid
    expect(_testing.isSharedPresenceRow(row({ machine_label: '' }))).toBe(false); // non-empty required
    expect(_testing.isSharedPresenceRow(row({ github_user_id: -1 }))).toBe(false);
    expect(_testing.decodeValue({ junk: 1 })).toBeNull();
    expect(_testing.composeKey(row({ github_user_id: 9, machine_label: 'box' }))).toBe('9/box');
  });
});

async function epochMs(): Promise<number> {
  return Number((await rootSql`SELECT (extract(epoch from last_seen_at)*1000)::bigint AS v FROM harness_shared.shared_presence WHERE machine_label='laptop'`)[0]!.v);
}
