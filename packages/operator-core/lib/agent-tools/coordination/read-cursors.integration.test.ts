/**
 * read-cursors.integration.test.ts — proves PgReadCursorStore.ackAndAdvance persists
 * a real jsonb OBJECT (not a string scalar) through the real getOrgPg()-class client,
 * against a real, migrated Postgres (WI-7092 / EI-607).
 *
 * Before this fix, `ackAndAdvance`'s INSERT bound its `pending` column via
 * `sql.json(next)`, which THROWS on getOrgPg's client in PRODUCTION (a postgres-js
 * CJS/ESM dual-package module-instance mismatch; see
 * agent-insights/sql-json-throws-on-getorgpg-client). `read-cursors.test.ts` only
 * ever exercises `InMemoryReadCursorStore` (its own header says the Pg store's live
 * behavior was "verified... via psql round-trip, not here") — so this write path had
 * ZERO automated coverage and was silently broken in production every time it ran:
 * every real cursor-ack call threw, so the fleet-deltas P-004 two-phase ack protocol
 * never actually persisted a cursor row.
 *
 * ⚠ What this test does NOT prove: it does not, by itself, catch a REGRESSION back to
 * `sql.json(next)`. Confirmed empirically (temporarily reverting the fix and re-running
 * this suite): `sql.json` does not throw under vitest even when routed at the real
 * getOrgPg() against a real migrated DB — the dual-package CJS/ESM hazard the doc above
 * describes is specific to the actual built/bundled Node runtime resolving
 * `@papercusp/db-org`'s compiled output, which vitest's module transform does not
 * reproduce. This matches the doc's own "integration tests are structurally blind to
 * this class" warning; it turns out that includes a getOrgPg-routed one too, not only
 * the tolerant root-postgres fixture client. The actual regression guard for THIS
 * specific class is the static `lint:no-sql-json` guard (scripts/check-no-sql-json.mjs).
 * What this test DOES prove, and is worth having on its own: the two-phase ack SQL
 * (the CTE, the jsonb round-trip, the ON CONFLICT promotion) is correct against a real
 * Postgres — coverage `read-cursors.test.ts` never had at all.
 *
 * This test env-routes the real getOrgPg() at a throwaway MIGRATED database (the
 * `hive-git-mode-gc-arming.integration.test.ts` / "serve-wiring" idiom).
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/coordination/read-cursors.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { getOrgPg } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes (not re-exported from the index) — same pattern as hive-git-mode-gc-arming.integration.test.ts
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import {
  ackAndAdvance,
  ackAndRead,
  clearReadCursor,
  DELIVERY_TOKEN_KEY,
  resetReadCursorStore,
  stage,
  annotateReadCursorByToken,
} from './read-cursors';

describe('read-cursors PgReadCursorStore (PG) — ackAndAdvance against the real getOrgPg client', () => {
  let db: OrgTestDb;
  let prevAppUrl: string | undefined;
  let prevAdminUrl: string | undefined;
  let prevPgb: string | undefined;
  let prevSkipDisc: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    prevAppUrl = process.env.HARNESS_DATABASE_URL;
    prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    prevPgb = process.env.PAPERCUSP_PGBOUNCER;
    prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    process.env.PAPERCUSP_PGBOUNCER = '0';
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
  }, 120_000);

  afterEach(async () => {
    resetReadCursorStore();
    await db.adminSql.unsafe('TRUNCATE harness_shared.coord_read_cursors');
  });

  afterAll(async () => {
    process.env.HARNESS_DATABASE_URL = prevAppUrl;
    process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
    if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
    if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
    _resetUrlCacheForTests();
    await db?.cleanup();
  });

  it('persists a real jsonb OBJECT (not a sql.json throw, not a string-scalar) on first call', async () => {
    const owner = `su-${randomUUID().slice(0, 8)}`;
    const surface = 'fleet:monitor';
    const r = await ackAndAdvance(owner, surface, { a: 1 });
    expect(r).toEqual({ committed: null, baseline: true });

    const { sql } = getOrgPg();
    const rows = await sql<Array<{ pending: unknown }>>`
      SELECT pending FROM harness_shared.coord_read_cursors
       WHERE owner_id = ${owner} AND surface = ${surface}`;
    expect(rows).toHaveLength(1);
    // A pre-fix sql.json(next) bind either threw (nothing landed at all) or, had it
    // silently double-encoded, would read back as the STRING '{"a":1}' rather than
    // the object {a:1}. Assert the real, typed object shape lands.
    expect(rows[0].pending).toEqual({ a: 1 });
  });

  it("call N+1 promotes call N's pending -> committed against the real DB", async () => {
    const owner = `su-${randomUUID().slice(0, 8)}`;
    const surface = 'fleet:monitor';
    await ackAndAdvance(owner, surface, { state: 'N' });
    const r2 = await ackAndAdvance(owner, surface, { state: 'N+1' });
    expect(r2).toEqual({ committed: { state: 'N' }, baseline: false });

    const { sql } = getOrgPg();
    const rows = await sql<Array<{ committed: unknown; pending: unknown }>>`
      SELECT committed, pending FROM harness_shared.coord_read_cursors
       WHERE owner_id = ${owner} AND surface = ${surface}`;
    expect(rows[0]).toEqual({ committed: { state: 'N' }, pending: { state: 'N+1' } });
  });

  // ACK-ON-PROOF (owner-directive-delivery-redesign-2026-09-22 P-005). The
  // conditional promotion is one CASE expression inside the ON CONFLICT update, so
  // only a real Postgres can say whether its parameter casts and jsonb operators
  // behave; the in-memory store mirrors the contract but shares none of the SQL.
  describe('ackAndRead with a delivery confirmation', () => {
    const readRow = async (owner: string, surface: string) => {
      const { sql } = getOrgPg();
      const rows = await sql<Array<{ committed: unknown; pending: unknown }>>`
        SELECT committed, pending FROM harness_shared.coord_read_cursors
         WHERE owner_id = ${owner} AND surface = ${surface}`;
      return rows[0];
    };

    it('stages the token inside pending, and a MATCHING confirmation promotes it with the token stripped', async () => {
      const owner = `su-${randomUUID().slice(0, 8)}`;
      const surface = 'turn-start-orientation';
      await ackAndRead(owner, surface, { confirmedToken: null });
      await stage(owner, surface, { gen: 1 }, { deliveryToken: 'tok-1' });
      expect((await readRow(owner, surface))?.pending).toEqual({ gen: 1, [DELIVERY_TOKEN_KEY]: 'tok-1' });

      const r = await ackAndRead(owner, surface, { confirmedToken: 'tok-1' });
      expect(r).toEqual({ committed: { gen: 1 }, baseline: false });
      expect(await readRow(owner, surface)).toEqual({ committed: { gen: 1 }, pending: null });
    });

    it('annotates the exact candidate across pending and committed without altering ACK', async () => {
      const owner = `su-${randomUUID().slice(0, 8)}`;
      const surface = 'turn-start-orientation';
      await stage(owner, surface, { gen: 1, identity: { token: 'tok-1', status: 'pending' } },
        { deliveryToken: 'tok-1' });
      expect(await annotateReadCursorByToken(owner, surface, 'identity', 'tok-1',
        { token: 'tok-1', status: 'bound' })).toBe(true);
      expect((await ackAndRead(owner, surface, { confirmedToken: 'tok-1' })).committed).toEqual({
        gen: 1, identity: { token: 'tok-1', status: 'bound' },
      });
      expect(await annotateReadCursorByToken(owner, surface, 'identity', 'tok-1',
        { token: 'tok-1', status: 'verified' })).toBe(true);
      expect((await readRow(owner, surface))?.committed).toEqual({
        gen: 1, identity: { token: 'tok-1', status: 'verified' },
      });
      expect(await annotateReadCursorByToken(owner, surface, 'identity', 'wrong',
        { token: 'wrong', status: 'late' })).toBe(false);
    });

    it('a MISMATCHED or NULL confirmation discards pending and keeps the proven floor', async () => {
      const owner = `su-${randomUUID().slice(0, 8)}`;
      const surface = 'turn-start-orientation';
      await ackAndRead(owner, surface, { confirmedToken: null });
      await stage(owner, surface, { gen: 1 }, { deliveryToken: 'tok-1' });
      await ackAndRead(owner, surface, { confirmedToken: 'tok-1' });

      await stage(owner, surface, { gen: 2 }, { deliveryToken: 'tok-2' });
      expect(await ackAndRead(owner, surface, { confirmedToken: 'tok-1' })).toEqual({
        committed: { gen: 1 },
        baseline: false,
        unconfirmedPending: { gen: 2 },
      });
      expect(await readRow(owner, surface)).toEqual({ committed: { gen: 1 }, pending: null });

      await stage(owner, surface, { gen: 3 }, { deliveryToken: 'tok-3' });
      expect(await ackAndRead(owner, surface, { confirmedToken: null })).toEqual({
        committed: { gen: 1 },
        baseline: false,
        unconfirmedPending: { gen: 3 },
      });
    });

    it('a caller that sends NO confirmation keeps ack-on-arrival, and the token never reaches committed', async () => {
      const owner = `su-${randomUUID().slice(0, 8)}`;
      const surface = 'turn-start-orientation';
      await stage(owner, surface, { gen: 1 }, { deliveryToken: 'tok-1' });
      expect(await ackAndRead(owner, surface)).toEqual({ committed: { gen: 1 }, baseline: false });
    });
  });

  it('clearReadCursor deletes the row via the real DB', async () => {
    const owner = `su-${randomUUID().slice(0, 8)}`;
    const surface = 'fleet:monitor';
    await ackAndAdvance(owner, surface, { a: 1 });
    await clearReadCursor(owner, surface);

    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT 1 FROM harness_shared.coord_read_cursors
       WHERE owner_id = ${owner} AND surface = ${surface}`;
    expect(rows).toHaveLength(0);
  });
});
