/** P008 / EI-24109951788640754: list rebuilds should use the existing kind index,
 * while preserving the workspace-local generic-kind visibility contract. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', async (original) => ({
  ...(await original<typeof import('./workspace-registry')>()),
  activeWorkspaceId: () => 'default',
}));
const wi = await import('./work-items');
let db: FreshPgDb;
const HARNESS = 'kind-index-test';

beforeAll(async () => {
  db = await createFreshPgDb('work-items-kind-selection');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  // Production migration 136's index survives the migration-374 table rename.
  await db.sql`CREATE INDEX hfc_item_kind_idx
    ON harness_shared.work_items (workspace_id, harness_slug, item_kind)`;
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  h.sql = db.sql;
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.datatype_registry`;
});

async function seed(id: string, kind: string, workspace = 'default', parent: string | null = null) {
  await db.sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts, parent_id)
    VALUES (${workspace}, ${HARNESS}, ${id}, ${kind}, ${id}, 'open', 1000, 1000, ${parent})`;
}

describe('indexed feature-family kind selection', () => {
  it('preserves local active kinds, chunk opt-in, empty registry, duplicates and foreign isolation', async () => {
    await seed('feature', 'feature');
    await seed('chunk', 'chunk', 'default', 'feature');
    await seed('local', 'experiment');
    await seed('inactive', 'inactive-kind');
    await seed('wrong-tier', 'typed-kind');
    await seed('foreign-kind', 'foreign-kind');
    await seed('foreign-row', 'experiment', 'foreign');
    const list = (filter: Parameters<typeof wi.listWorkItems>[0] = {}) =>
      wi.listWorkItems({ harness: HARNESS, includeBody: false, includePayload: false, ...filter });
    const ids = async (filter: Parameters<typeof wi.listWorkItems>[0] = {}) =>
      (await list(filter)).filter(row => row.family === 'feature').map(row => row.id).sort();

    expect(await ids()).toEqual(['feature']);
    await db.sql`INSERT INTO harness_shared.datatype_registry (workspace_id, id, work_item_kind, tier, status)
      VALUES ('default', 'local', 'experiment', 'generic-kind', 'active'),
             ('default', 'duplicate', 'experiment', 'generic-kind', 'active'),
             ('default', 'builtin-duplicate', 'feature', 'generic-kind', 'active'),
             ('default', 'inactive', 'inactive-kind', 'generic-kind', 'inactive'),
             ('default', 'typed', 'typed-kind', 'typed', 'active'),
             ('default', 'null-kind', NULL, 'generic-kind', 'active'),
             ('foreign', 'foreign', 'foreign-kind', 'generic-kind', 'active')`;
    expect(await ids()).toEqual(['feature', 'local']);
    expect(await ids({ includeChildren: true })).toEqual(['chunk', 'feature', 'local']);
    expect(await ids({ parent: 'feature' })).toEqual(['chunk']);
    expect(await ids({ kind: 'chunk', includeChildren: true })).toEqual(['chunk']);
    expect(await ids({ kind: 'feature' })).toEqual(['feature']);
    expect(await wi.countWorkItems({ harness: HARNESS })).toBe(2);
    expect(await wi.countWorkItems({ harness: HARNESS, includeChildren: true })).toBe(3);
    expect((await wi.listAllWorkItemsForFileExport({ harness: HARNESS })).map(row => row.id).sort())
      .toEqual(['feature', 'local']);

    // The kind set is computed by each query, not cached beyond registry changes.
    await db.sql`UPDATE harness_shared.datatype_registry SET status='inactive'
      WHERE workspace_id='default' AND work_item_kind='experiment'`;
    expect(await ids()).toEqual(['feature']);
  });

  it('honors exact ids for both family readers and both identity-filter forms', async () => {
    await seed('feature-array', 'feature');
    await seed('feature-subquery', 'feature');
    await seed('bug-array', 'bug');
    await seed('bug-subquery', 'bug');

    const listIds = async (
      kind: 'feature' | 'bug',
      ids: NonNullable<Parameters<typeof wi.listWorkItems>[0]>['ids'],
    ) => (await wi.listWorkItems({
      harness: HARNESS,
      kind,
      ids,
      includeBody: false,
      includePayload: false,
    })).map(row => row.id).sort();

    expect(await listIds('feature', ['feature-array'])).toEqual(['feature-array']);
    expect(await listIds('bug', ['bug-array'])).toEqual(['bug-array']);
    expect(await listIds('feature', [])).toEqual([]);
    expect(await listIds('bug', [])).toEqual([]);
    expect(await listIds('feature', db.sql`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND harness_slug = ${HARNESS}
         AND item_kind = 'feature' AND feature_id = 'feature-subquery'
    `)).toEqual(['feature-subquery']);
    expect(await listIds('bug', db.sql`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND harness_slug = ${HARNESS}
         AND item_kind = 'bug' AND feature_id = 'bug-subquery'
    `)).toEqual(['bug-subquery']);
  });

  it('makes item_kind indexable during a list rebuild, unlike the historical OR filter', async () => {
    await db.sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts, summary)
      SELECT 'default', ${HARNESS}, 'row-' || n, CASE WHEN n <= 40 THEN 'feature' ELSE 'bug' END,
             'row-' || n, 'open', n, n, repeat('body ', 50)
        FROM generate_series(1, 2000) n`;
    await db.sql`ANALYZE harness_shared.work_items`;
    let captured: unknown[] | undefined;
    h.sql = new Proxy(db.sql, {
      apply(target, thisArg, args) {
        const statement = Array.isArray(args[0]) ? args[0].join('') : '';
        if (/^\s*SELECT /.test(statement) && statement.includes('FROM harness_shared.harness_features_consolidated')) {
          captured = args;
        }
        return Reflect.apply(target, thisArg, args);
      },
    }) as typeof h.sql;
    try {
      // Exercise the actual production query builder, with the ordinary lean list projection.
      const rows = await wi.listWorkItems({ harness: HARNESS, limit: 20, includeBody: false, includePayload: false });
      expect(rows).toHaveLength(20);
      expect(captured).toBeDefined();
      const query = Reflect.apply(db.sql, db.sql, captured!);
      await db.sql.begin(async tx => {
        // Test indexability, not the planner's cost choice for a tiny two-kind
        // fixture. This local transaction setting is restored on exit. Natural
        // production plans and timings are measured separately (plan D-015).
        await tx`SET LOCAL enable_seqscan=off`;
        const plan = await tx`EXPLAIN (FORMAT JSON) ${query}`;
        const conditions: string[] = [];
        const visit = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          const node = value as Record<string, unknown>;
          // Bitmap Index Scan nodes carry Index Name but no Relation Name.
          if ((node['Relation Name'] === 'work_items' || node['Index Name'] === 'hfc_item_kind_idx') &&
              typeof node['Index Cond'] === 'string') {
            conditions.push(node['Index Cond']);
          }
          for (const child of Object.values(node)) visit(child);
        };
        visit(plan[0]['QUERY PLAN']);
        expect(conditions.join('\n'), JSON.stringify(plan[0]['QUERY PLAN'])).toMatch(/\bitem_kind\b/);

        // Historical OR/subquery control: the same indexed fixture must distinguish
        // the original scan from the production query above, without wall-clock thresholds.
        const historical = await tx`EXPLAIN (FORMAT JSON)
          SELECT feature_id FROM harness_shared.harness_features_consolidated
           WHERE workspace_id='default' AND harness_slug=${HARNESS}
             AND (item_kind='feature' OR item_kind IN (
               SELECT work_item_kind FROM harness_shared.datatype_registry
                WHERE workspace_id='default' AND tier='generic-kind' AND status='active'
                  AND work_item_kind IS NOT NULL))
             AND (parent_id IS NULL OR parent_id='')
           ORDER BY updated_ts DESC NULLS LAST LIMIT 20`;
        conditions.length = 0;
        visit(historical[0]['QUERY PLAN']);
        expect(conditions.join('\n')).not.toMatch(/\bitem_kind\b/);
      });
    } finally {
      h.sql = db.sql;
    }
  });
});
