/**
 * WI-10003565 — own-node origin heal against real Postgres.
 *
 * A row this workspace authored can read origin='remote' (the flip is still under
 * investigation, EI-19313515375179600). The claim gate already treats it as ours via
 * issueOwnAuthorWhereSql, but every write path refused it as "remote-authored ... its authoring
 * peer must claim/resolve it". A system-filed row matches none of the caller-identity hatches, so
 * it could be claimed and never closed (measured live 2026-10-01 on three learning-loop rows,
 * WI-10004844). selfHealOwnNodeOriginIfStranded is the hatch; its WHERE clause is the identity
 * check, so the controls below matter as much as the heal itself.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { selfHealOwnNodeOriginIfStranded, isOwnNodeAuthoredRemoteRow } = await import('./work-items-admission');

const WS = 'ws-own-node';
const OTHER_WS = 'ws-elsewhere';
const OWN = 'f89879623b3799fa00';
const PEER = 'aa11bb22cc33dd4400';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-own-node-heal');
  h.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      origin text,
      author_pubkey text,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    )`);
}, 60_000);

afterAll(async () => db?.cleanup());

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items`;
});

async function seed(ws: string, id: string, origin: 'local' | 'remote' | null, author: string | null): Promise<void> {
  await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, origin, author_pubkey)
               VALUES (${ws}, 'papercusp', ${id}, ${origin}, ${author})`;
}
async function originOf(ws: string, id: string): Promise<string | null> {
  const [r] = await db.sql<Array<{ origin: string | null }>>`
    SELECT origin FROM harness_shared.work_items WHERE workspace_id = ${ws} AND feature_id = ${id}`;
  return r?.origin ?? null;
}

describe('selfHealOwnNodeOriginIfStranded', () => {
  it('heals a remote row authored by a key this workspace has written locally', async () => {
    await seed(WS, 'EI-local', 'local', OWN);
    await seed(WS, 'EI-stranded', 'remote', OWN);

    expect(await isOwnNodeAuthoredRemoteRow(WS, 'EI-stranded')).toBe(true);
    expect(await selfHealOwnNodeOriginIfStranded(WS, 'EI-stranded')).toBe(true);
    expect(await originOf(WS, 'EI-stranded')).toBe('local');
  });

  it('control: leaves a genuinely peer-authored remote row alone', async () => {
    await seed(WS, 'EI-local', 'local', OWN);
    await seed(WS, 'EI-peer', 'remote', PEER);

    expect(await isOwnNodeAuthoredRemoteRow(WS, 'EI-peer')).toBe(false);
    expect(await selfHealOwnNodeOriginIfStranded(WS, 'EI-peer')).toBe(false);
    expect(await originOf(WS, 'EI-peer')).toBe('remote');
  });

  it('control: a blank author key never counts as ours, even when blank-authored local rows exist', async () => {
    await seed(WS, 'EI-local-blank', 'local', '');
    await seed(WS, 'EI-remote-blank', 'remote', '');

    expect(await isOwnNodeAuthoredRemoteRow(WS, 'EI-remote-blank')).toBe(false);
    expect(await selfHealOwnNodeOriginIfStranded(WS, 'EI-remote-blank')).toBe(false);
    expect(await originOf(WS, 'EI-remote-blank')).toBe('remote');
  });

  it('control: a key written locally in ANOTHER workspace does not make the row ours', async () => {
    await seed(OTHER_WS, 'EI-local-elsewhere', 'local', OWN);
    await seed(WS, 'EI-stranded', 'remote', OWN);

    expect(await isOwnNodeAuthoredRemoteRow(WS, 'EI-stranded')).toBe(false);
    expect(await selfHealOwnNodeOriginIfStranded(WS, 'EI-stranded')).toBe(false);
    expect(await originOf(WS, 'EI-stranded')).toBe('remote');
  });

  // WI-10006010: the heal keyed on feature_id alone flipped origin on EVERY slug twin. With a
  // pinned harness_slug only that physical row is healed; the twin keeps origin='remote'.
  it('heals only the pinned physical row when the id has a slug twin', async () => {
    await seed(WS, 'EI-local', 'local', OWN);
    await seed(WS, 'EI-twin', 'remote', OWN);
    await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, origin, author_pubkey)
                 VALUES (${WS}, 'operator:ws-own-node', 'EI-twin', 'remote', ${OWN})`;

    expect(await selfHealOwnNodeOriginIfStranded(WS, 'EI-twin', 'operator:ws-own-node')).toBe(true);

    const rows = await db.sql<Array<{ harness_slug: string; origin: string | null }>>`
      SELECT harness_slug, origin FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = 'EI-twin' ORDER BY harness_slug`;
    expect(rows).toEqual([
      { harness_slug: 'operator:ws-own-node', origin: 'local' },
      { harness_slug: 'papercusp', origin: 'remote' },
    ]);
  });
});
