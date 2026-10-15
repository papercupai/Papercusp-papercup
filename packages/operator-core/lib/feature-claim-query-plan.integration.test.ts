/**
 * feature-claim-query-plan.integration.test.ts — the feature-tier claim candidate
 * read must reach the feature family through an index, not by walking every issue
 * row in the harness (EI-25902840495107632, migration 1505).
 *
 * WHY. harness_features_consolidated is work_items filtered by
 * `item_kind NOT IN ('bug','change','task')`, a `<> ALL` that no btree can serve.
 * Scoped by (workspace_id, harness_slug) alone, the claim's candidate subquery walked
 * the whole harness and threw the issue family away in a Filter: measured live
 * 2026-10-14 at 8,559 ms / 1,057,548 buffers with 348,557 rows removed to return 1,
 * and scheduler:get_next was cancelled (SQLSTATE 57014) every few minutes.
 *
 * HOW. The test composes the REAL claim floors (claimFloorsWhereSql, the fragment
 * scheduler:get_next's feature tier ANDs in) over the view, exactly as the claim's
 * candidate subquery does, applies the REAL migration file, and EXPLAINs it. The
 * assertion is the defect's own signature on the candidate scan: no seq scan, and no
 * `item_kind <> ALL` Filter discarding the issue family. It then drops the index and
 * asserts that Filter comes back, so the guard is proven falsifiable inside the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { applyClaimPathReadDeps, HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { claimFloorsWhereSql } from './work-items';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dirname, '../../../libs/papercusp/libs/db/sql/1505-work-items-feature-family-scope-idx.sql');
const INDEX = 'work_items_feature_family_scope_idx';
const WS = 'ei2590-claim-plan-ws';
const HARNESS = 'ei2590';
const ISSUE_ROWS = 20_000;
const FEATURE_ROWS = 200;

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Alias?: string;
  Filter?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/**
 * The claim's CANDIDATE scan: the view's own reference to work_items (alias
 * `work_items`). The floors' correlated subplans (sibling holders, condition keys,
 * author provenance) reference work_items under suffixed aliases and are served on
 * live by indexes this fixture deliberately does not recreate, so they are out of
 * scope here; asserting over them would test fixture completeness, not 1505.
 */
function candidateScans(nodes: PlanNode[]): PlanNode[] {
  return nodes.filter((n) => n['Relation Name'] === 'work_items' && n.Alias === 'work_items');
}

/** The defect itself: the issue family is read and then discarded in a Filter. */
function filtersIssueFamilyAway(node: PlanNode): boolean {
  return /item_kind <> ALL/.test(node.Filter ?? '');
}

function describePlan(nodes: PlanNode[]): string {
  return nodes
    .map((n) => {
      const on = n['Relation Name'] ? ` on ${n['Relation Name']} ${n.Alias ?? ''}`.trimEnd() : '';
      return `${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : ''}${on}`;
    })
    .join(' > ');
}

let db: FreshPgDb;

/** EXPLAIN the feature-tier claim candidate subquery, composed from the real floors. */
async function planOfFeatureClaimCandidate(): Promise<PlanNode[]> {
  const sql = db.sql;
  const floors = claimFloorsWhereSql(sql as never, {
    harness: HARNESS,
    workspaceId: WS,
    states: ['open'],
    cooldownAssignee: 'su-ei2590-probe',
  });
  const explained = await sql`
    EXPLAIN (FORMAT JSON)
    SELECT harness_slug, feature_id
      FROM harness_shared.harness_features_consolidated
     WHERE ${floors}
     ORDER BY created_ts
     LIMIT 1
     FOR UPDATE SKIP LOCKED`;
  const plan = (explained[0] as Record<string, unknown>)['QUERY PLAN'] as { Plan: PlanNode }[];
  return flatten(plan[0]!.Plan);
}

beforeAll(async () => {
  db = await createFreshPgDb('feature-claim-plan');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  // The real migration file, so the test proves the shipped DDL, not a copy of it.
  await db.sql.unsafe(readFileSync(MIGRATION, 'utf8'));

  // The live shape: the issue family dominates the harness, the feature family is a
  // small slice of it, and a second workspace the index must skip.
  await db.sql.unsafe(`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, summary, created_ts, updated_ts, payload)
    SELECT '${WS}', '${HARNESS}', 'EI-' || g, (ARRAY['bug','change','task'])[1 + g % 3], 'open',
           'issue ' || g, repeat('x', 600), 1760000000000 + g * 1000, 1760000000000 + g * 1000, '{}'::jsonb
      FROM generate_series(1, ${ISSUE_ROWS}) g;
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts)
    SELECT '${WS}', '${HARNESS}', 'F-' || g, 'feature', 'open', 'feature ' || g, 1760000000000 + g * 1000, 1760000000000 + g * 1000
      FROM generate_series(1, ${FEATURE_ROWS}) g;
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts)
    SELECT 'other-ws', 'other-${HARNESS}', 'OF-' || g, 'feature', 'open', 'other ' || g, 1790000000000 + g, 1790000000000 + g
      FROM generate_series(1, 2000) g;
    ANALYZE harness_shared.work_items;`).simple();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('feature-tier claim candidate query plan (EI-25902840495107632)', () => {
  it('reaches the feature family through the feature-family scope index', async () => {
    const nodes = await planOfFeatureClaimCandidate();
    const shape = describePlan(nodes);
    expect(nodes.some((n) => n['Index Name'] === INDEX), `claim candidate read did not use ${INDEX}: ${shape}`).toBe(true);
    const candidates = candidateScans(nodes);
    expect(candidates.length, `no candidate scan on work_items found: ${shape}`).toBeGreaterThan(0);
    expect(candidates.filter((n) => n['Node Type'] === 'Seq Scan'), `candidate scan seq-scans work_items: ${shape}`).toEqual([]);
    expect(
      candidates.filter(filtersIssueFamilyAway).map((n) => n.Filter),
      `candidate scan still reads the issue family and discards it in a Filter: ${shape}`,
    ).toEqual([]);
  });

  it('is falsifiable: without the index the candidate scan discards the issue family in a Filter again', async () => {
    await db.sql.unsafe(`DROP INDEX harness_shared.${INDEX}`);
    try {
      const nodes = await planOfFeatureClaimCandidate();
      const shape = describePlan(nodes);
      expect(nodes.some((n) => n['Index Name'] === INDEX)).toBe(false);
      // The positive control for the first test's Filter assertion: the defect it
      // guards against is observable on this fixture once the index is gone.
      expect(candidateScans(nodes).some(filtersIssueFamilyAway), `expected the issue-family Filter without ${INDEX}: ${shape}`).toBe(true);
    } finally {
      await db.sql.unsafe(readFileSync(MIGRATION, 'utf8'));
    }
  });
});
