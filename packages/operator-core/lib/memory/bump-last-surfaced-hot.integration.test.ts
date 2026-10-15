/**
 * bump-last-surfaced-hot.integration.test.ts — recurrence guard for
 * papercusp-log-performance-remediation-2026-09-23 P-015(d), migration 1312.
 *
 * bumpLastSurfacedSql runs after every memory injection. While an index covered
 * memory_canonical.last_surfaced_at, PostgreSQL could not do a HOT update, so
 * every bump wrote a new heap tuple plus a fresh entry in all 8 indexes on the
 * table, including the trigram GIN index over payload->>'data'. Measured
 * 2026-10-01: 99,892 bump calls, 5.68 GB of WAL, about 29 kB per 409-byte row.
 *
 * This runs against the fully migrated org template (the real indexes and
 * triggers), not a hand-rolled table, so a new index covering the column, or a
 * trigger that rewrites an indexed column on update, fails here.
 *
 * The HOT check reads pg_stat_get_xact_tuples_hot_updated inside the same
 * transaction as the bump. The transaction-local counters are exact and are not
 * subject to the cumulative-stats flush delay. The probe row is the only row on
 * a fresh page, so free space cannot be the reason a HOT update is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { _resetForTests, bumpLastSurfacedSql, type SqlTag } from './bump-last-surfaced';

const { createOrgTestDb } = await import('../../test/_org-test-db');

const PROBE_ID = '5f0c1e2a-3b4d-4c5e-8f60-718293a4b5c6';

describe('memory_canonical last_surfaced_at bump is a HOT update (real PG, migration 1312)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    _resetForTests();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('no index on memory_canonical covers last_surfaced_at (key column, expression or predicate)', async () => {
    const rows = await db.adminSql<{ name: string }[]>`
      SELECT i.relname AS name
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
       WHERE x.indrelid = 'harness_shared.memory_canonical'::regclass
         AND (
           EXISTS (
             SELECT 1
               FROM unnest(x.indkey::int2[]) AS k(attnum)
               JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
              WHERE a.attname = 'last_surfaced_at'
           )
           OR coalesce(pg_get_expr(x.indexprs, x.indrelid), '') LIKE '%last_surfaced_at%'
           OR coalesce(pg_get_expr(x.indpred, x.indrelid), '') LIKE '%last_surfaced_at%'
         )
       ORDER BY 1`;
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it('the real bump statement updates the row as a HOT update', async () => {
    const payload = JSON.stringify({
      data: 'hot-update probe memory text for the last_surfaced_at bump guard',
      user_id: 'hot-probe-user',
      workspace_id: 'hot-probe-workspace',
    });
    await db.adminSql`
      INSERT INTO harness_shared.memory_canonical (id, payload)
      VALUES (${PROBE_ID}::uuid, ${payload}::jsonb)`;

    const result = await db.adminSql.begin(async (tx) => {
      const ok = await bumpLastSurfacedSql(tx as unknown as SqlTag, [PROBE_ID]);
      const [counts] = await tx<{ updated: number; hot: number }[]>`
        SELECT pg_stat_get_xact_tuples_updated('harness_shared.memory_canonical'::regclass)::int AS updated,
               pg_stat_get_xact_tuples_hot_updated('harness_shared.memory_canonical'::regclass)::int AS hot`;
      return { ok, updated: counts.updated, hot: counts.hot };
    });

    // ok + updated pin that the bump really ran: bumpLastSurfacedSql swallows
    // errors, so a failing statement would otherwise read as "0 HOT of 0".
    expect(result).toEqual({ ok: true, updated: 1, hot: 1 });

    const [row] = await db.adminSql<{ surfaced: boolean }[]>`
      SELECT last_surfaced_at IS NOT NULL AS surfaced
        FROM harness_shared.memory_canonical WHERE id = ${PROBE_ID}::uuid`;
    expect(row?.surfaced).toBe(true);
  });
});
