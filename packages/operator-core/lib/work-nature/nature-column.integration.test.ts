/**
 * nature-column.integration.test.ts — work_items.nature against real Postgres
 * (enterprise-data-sources-2026-10-01 P-010; spec AUTO-BAR-R-4-P-010, D-011 / D-018).
 *
 * R-4 has two halves, and each block below fails on exactly one way of getting them wrong:
 *   (a) Every work_items row carries the nature its datatype has in datatype_registry. That
 *       holds at mint (the nature_stamp_from_registry_trg trigger, migration 1322) and after a
 *       registry reclassification (restamp_work_items_nature_trg). A hand-set nature is
 *       overwritten, never trusted.
 *   (b) Default work reads (listWorkItems, countWorkItems, countWorkItemsByState,
 *       searchWorkItems) return no record-nature row. Calibration: `natures: ['record']` and
 *       an explicit `kind` DO return it, so a default read that simply returned nothing would
 *       still fail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const WS = 'ws-nature-column-it';
const HARNESS = 'nature-column-it';
const RECORD_KIND = 'nature-it-contact';
const LATE_KIND = 'nature-it-late';
// A token no other row carries, so the lexical search leg matches only our two rows.
const TOKEN = 'zqxnaturecolumnzq';

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { listWorkItems, countWorkItems, countWorkItemsByState, searchWorkItems } = await import('../work-items');

type NatureRow = { nature: string; audience: string | null };

describe('work_items.nature — the work/data boundary on the work queue (real PG, P-010)', () => {
  let db: OrgTestDb;
  let prevWs: string | undefined;

  async function insertItem(id: string, kind: string): Promise<void> {
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, created_ts, updated_ts, payload)
      VALUES
        (${WS}, ${HARNESS}, ${id}, ${`${TOKEN} ${id}`}, ${`body ${id}`}, ${kind}, 'open',
         ${Date.now()}, ${Date.now()}, ${db.adminSql.json({})})`;
  }

  async function natureOf(id: string): Promise<NatureRow> {
    const [row] = await db.adminSql<NatureRow[]>`
      SELECT nature, audience FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    return row;
  }

  async function registerKind(kind: string, nature: string, audience: string | null): Promise<void> {
    await db.adminSql`
      INSERT INTO harness_shared.datatype_registry (id, workspace_id, title, description, tier, work_item_kind, nature, audience)
      VALUES (${kind}, ${WS}, ${kind}, 'registered by the nature-column integration test', 'generic-kind', ${kind},
              ${nature}, ${audience})`;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    prevWs = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
    await registerKind(RECORD_KIND, 'record', null);
    await insertItem('WI-NAT-WORK', 'feature');
    await insertItem('WI-NAT-RECORD', RECORD_KIND);
  }, 120_000);

  afterAll(async () => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = prevWs;
    await db?.cleanup();
  });

  describe('(a) every row carries its registry nature', () => {
    it('nature is NOT NULL and closed-vocabulary on work_items', async () => {
      const [col] = await db.adminSql<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'harness_shared' AND table_name = 'work_items' AND column_name = 'nature'`;
      expect(col?.is_nullable).toBe('NO');
    });

    it('stamps the registry nature at mint: built-in kinds are agent work, a record kind is a record', async () => {
      expect(await natureOf('WI-NAT-WORK')).toEqual({ nature: 'work', audience: 'agent' });
      expect(await natureOf('WI-NAT-RECORD')).toEqual({ nature: 'record', audience: null });
    });

    it('a hand-set nature is overwritten by the derivation, never trusted', async () => {
      await db.adminSql`
        UPDATE harness_shared.work_items SET nature = 'work', audience = 'agent'
         WHERE workspace_id = ${WS} AND feature_id = 'WI-NAT-RECORD'`;
      expect(await natureOf('WI-NAT-RECORD')).toEqual({ nature: 'record', audience: null });
    });

    it('a registry reclassification restamps rows already minted under the kind', async () => {
      // Minted before its kind is registered: no registry row → work/agent (D-013 §5).
      await insertItem('WI-NAT-LATE', LATE_KIND);
      expect(await natureOf('WI-NAT-LATE')).toEqual({ nature: 'work', audience: 'agent' });
      await registerKind(LATE_KIND, 'event', null);
      expect(await natureOf('WI-NAT-LATE')).toEqual({ nature: 'event', audience: null });
      await db.adminSql`
        DELETE FROM harness_shared.datatype_registry WHERE workspace_id = ${WS} AND id = ${LATE_KIND}`;
      expect(await natureOf('WI-NAT-LATE')).toEqual({ nature: 'work', audience: 'agent' });
      await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'WI-NAT-LATE'`;
    });

    it('zero work_items rows disagree with their registry nature', async () => {
      const [{ n, total }] = await db.adminSql<{ n: number; total: number }[]>`
        SELECT count(*) FILTER (WHERE (wi.nature, wi.audience) IS DISTINCT FROM (k.nature, k.audience))::int AS n,
               count(*)::int AS total
          FROM harness_shared.work_items wi,
               LATERAL harness_shared.work_item_kind_nature(wi.workspace_id, wi.item_kind) k`;
      expect(total).toBeGreaterThanOrEqual(2);
      expect(n).toBe(0);
    });
  });

  describe('(b) default work reads return no record-nature row', () => {
    const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

    it('listWorkItems excludes the record row by default and returns it on request', async () => {
      expect(ids(await listWorkItems({ harness: HARNESS }))).toEqual(['WI-NAT-WORK']);
      expect(ids(await listWorkItems({ harness: HARNESS, natures: ['record'] }))).toEqual(['WI-NAT-RECORD']);
      expect(ids(await listWorkItems({ harness: HARNESS, kind: RECORD_KIND as never }))).toEqual(['WI-NAT-RECORD']);
      expect(ids(await listWorkItems({ harness: HARNESS, natures: ['work', 'record'] }))).toEqual([
        'WI-NAT-RECORD',
        'WI-NAT-WORK',
      ]);
    });

    it('countWorkItems and countWorkItemsByState agree with the list', async () => {
      expect(await countWorkItems({ harness: HARNESS })).toBe(1);
      expect(await countWorkItems({ harness: HARNESS, natures: ['record'] })).toBe(1);
      expect(await countWorkItems({ harness: HARNESS, natures: ['work', 'record'] })).toBe(2);
      expect(await countWorkItemsByState({ harness: HARNESS })).toEqual({ open: 1 });
      expect(await countWorkItemsByState({ harness: HARNESS, natures: ['work', 'record'] })).toEqual({ open: 2 });
    });

    it('a natures set without work drops the issue family too', async () => {
      await db.adminSql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, created_ts, updated_ts, payload)
        VALUES (${WS}, ${HARNESS}, 'EI-NAT-BUG', ${`${TOKEN} bug`}, 'a bug', 'bug', 'open',
                ${Date.now()}, ${Date.now()}, ${db.adminSql.json({})})`;
      try {
        expect(ids(await listWorkItems({ harness: HARNESS }))).toEqual(['EI-NAT-BUG', 'WI-NAT-WORK']);
        expect(ids(await listWorkItems({ harness: HARNESS, natures: ['record'] }))).toEqual(['WI-NAT-RECORD']);
        expect(await countWorkItems({ harness: HARNESS, natures: ['record'] })).toBe(1);
      } finally {
        await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-NAT-BUG'`;
      }
    });

    it('searchWorkItems excludes the record row by default and returns it on request', async () => {
      const search = (natures?: ('work' | 'record')[]) =>
        searchWorkItems(TOKEN, { harness: HARNESS, semantic: false, ...(natures ? { natures } : {}) });
      expect(ids((await search()).items)).toEqual(['WI-NAT-WORK']);
      expect(ids((await search(['record'])).items)).toEqual(['WI-NAT-RECORD']);
      expect(
        ids((await searchWorkItems(TOKEN, { harness: HARNESS, semantic: false, kind: RECORD_KIND as never })).items),
      ).toEqual(['WI-NAT-RECORD']);
    });
  });
});
