/**
 * work-items-duplicate-of.integration.test.ts — migration 1534 against real Postgres
 * (bug-inflow-one-problem-one-row-2026-10-18#D-001, WI-6554700010017181).
 *
 * Owner directive #1990: a duplicate is a FIELD the admission gate checks, not a comment.
 * Migration 1534 adds work_items.duplicate_of / duplicate_source and patches the three views
 * that read work_items from their LIVE definitions (the guarded-anchor shape of migration
 * 1110). A mock cannot catch a view rewrite that lands in the wrong clause; only applying the
 * real migration file to real view text can.
 *
 * Where the view text comes from:
 *   - engineer_issues + harness_features_consolidated: the shared superset fixture, which is
 *     kept in lockstep with production (see _work-items-schema.ts).
 *   - work_items_claimable: the REAL view statement from migration 1301, the latest migration
 *     that defines it. The 12-argument work_item_claim_floors function that view calls is
 *     stubbed to "no floors": floor behaviour is claim-ssot-agreement's subject, and this
 *     file's subject is the 1534 rewrite of the view TEXT plus the gate it appends.
 *
 * Gated on Docker like every other *.integration.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');

// The armed file name first. The .DRAFT fallback exists only until
// `node scripts/next-migration.mjs --arm` publishes the migration (WI-6554700010017181 removes it then).
const MIGRATION_1534 = ['1534-work-items-duplicate-of.sql', '1534-work-items-duplicate-of.sql.DRAFT']
  .map((f) => resolve(SQL_DIR, f))
  .find((p) => existsSync(p));

const WS = 'default';
const HARNESS = 'h1';
const VIEWS = ['engineer_issues', 'harness_features_consolidated', 'work_items_claimable'] as const;

const CLAIM_FLOORS_STUB_DDL = `
  CREATE OR REPLACE FUNCTION harness_shared.work_item_claim_floors(
    text, text, text, text, text, text, text, jsonb, text, text, text, bigint
  ) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[]::text[] $$`;

/** The real work_items_claimable statement (DROP + CREATE VIEW + COMMENT) from migration 1301. */
function claimableViewFrom1301(): string {
  const text = readFileSync(resolve(SQL_DIR, '1301-acceptance-claim-floor.sql'), 'utf8');
  const start = text.indexOf('DROP VIEW IF EXISTS harness_shared.work_items_claimable;');
  if (start < 0) {
    throw new Error(
      '1301-acceptance-claim-floor.sql no longer contains the work_items_claimable view statement; ' +
        're-point this fixture at the migration that now defines the view',
    );
  }
  return text.slice(start);
}

/** Base table + the three production-shaped views 1534 patches. */
async function standUpViews(db: FreshPgDb): Promise<void> {
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(CLAIM_FLOORS_STUB_DDL).simple();
  await db.sql.unsafe(claimableViewFrom1301()).simple();
}

async function viewColumns(db: FreshPgDb, view: string): Promise<string[]> {
  const rows = await db.sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'harness_shared' AND table_name = ${view}
     ORDER BY ordinal_position`;
  return rows.map((r) => r.column_name);
}

async function viewDefs(db: FreshPgDb): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of VIEWS) {
    const [row] = await db.sql<{ def: string }[]>`
      SELECT pg_get_viewdef(${`harness_shared.${v}`}::regclass) AS def`;
    out[v] = row.def;
  }
  return out;
}

describe('migration 1534: work_items.duplicate_of is a typed verdict the claimable gate reads', () => {
  let db: FreshPgDb;
  const columnsBefore: Record<string, string[]> = {};

  beforeAll(async () => {
    expect(MIGRATION_1534, 'migration 1534 file (armed or .DRAFT) must exist').toBeDefined();
    db = await createFreshPgDb('work-items-duplicate-of');
    await standUpViews(db);
    for (const v of VIEWS) columnsBefore[v] = await viewColumns(db, v);

    for (const [featureId, itemKind] of [
      ['EI-DUP-A', 'bug'], // the canonical
      ['EI-DUP-B', 'bug'], // will carry duplicate_of = EI-DUP-A
      ['EI-DUP-C', 'bug'], // unrelated open bug
      ['F-DUP-F', 'feature'], // feature family, so harness_features_consolidated has a row
    ] as const) {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (harness_slug, feature_id, workspace_id, title, status, item_kind, payload, created_ts)
        VALUES (${HARNESS}, ${featureId}, ${WS}, ${`title ${featureId}`}, 'open', ${itemKind}, '{}'::jsonb, 0)`;
    }

    await applyMigrationForTest(db.sql, MIGRATION_1534!);
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  it('adds duplicate_of / duplicate_source as nullable text, defaulting to "not a duplicate" on existing rows', async () => {
    const cols = await db.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'work_items'
         AND column_name IN ('duplicate_of', 'duplicate_source')
       ORDER BY column_name`;
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['duplicate_of', 'text', 'YES'],
      ['duplicate_source', 'text', 'YES'],
    ]);
    const detail = await db.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'work_items'
         AND column_name IN ('duplicate_confidence', 'duplicate_evidence')
       ORDER BY column_name`;
    expect(detail.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['duplicate_confidence', 'real', 'YES'],
      ['duplicate_evidence', 'jsonb', 'YES'],
    ]);
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.work_items
       WHERE feature_id LIKE '%-DUP-%'
         AND (duplicate_of IS NOT NULL OR duplicate_source IS NOT NULL
              OR duplicate_confidence IS NOT NULL OR duplicate_evidence IS NOT NULL)`;
    expect(n).toBe(0);
  });

  it('rejects an unknown writer and a row naming itself as its own canonical', async () => {
    await expect(
      db.sql`UPDATE harness_shared.work_items SET duplicate_of = 'EI-DUP-A', duplicate_source = 'bogus'
              WHERE feature_id = 'EI-DUP-B'`,
    ).rejects.toThrow(/work_items_duplicate_source_check/);
    await expect(
      db.sql`UPDATE harness_shared.work_items SET duplicate_of = feature_id, duplicate_source = 'agent'
              WHERE feature_id = 'EI-DUP-B'`,
    ).rejects.toThrow(/work_items_duplicate_of_not_self/);
    for (const source of ['create-match', 'admission-promoter', 'fold', 'agent']) {
      await db.sql`UPDATE harness_shared.work_items SET duplicate_of = 'EI-DUP-A', duplicate_source = ${source}
                    WHERE feature_id = 'EI-DUP-B'`;
    }
    await db.sql`UPDATE harness_shared.work_items SET duplicate_of = NULL, duplicate_source = NULL
                  WHERE feature_id = 'EI-DUP-B'`;
  });

  it('carries match confidence and evidence only alongside a verdict, with confidence in [0,1]', async () => {
    await expect(
      db.sql`UPDATE harness_shared.work_items SET duplicate_confidence = 0.9 WHERE feature_id = 'EI-DUP-B'`,
    ).rejects.toThrow(/work_items_duplicate_detail_check/);
    await expect(
      db.sql`UPDATE harness_shared.work_items SET duplicate_evidence = '{"matchedOn":"similarity"}'::jsonb
              WHERE feature_id = 'EI-DUP-B'`,
    ).rejects.toThrow(/work_items_duplicate_detail_check/);
    await expect(
      db.sql`UPDATE harness_shared.work_items
                SET duplicate_of = 'EI-DUP-A', duplicate_source = 'agent', duplicate_confidence = 1.5
              WHERE feature_id = 'EI-DUP-B'`,
    ).rejects.toThrow(/work_items_duplicate_detail_check/);
    await db.sql`UPDATE harness_shared.work_items
                    SET duplicate_of = 'EI-DUP-A', duplicate_source = 'create-match', duplicate_confidence = 1,
                        duplicate_evidence = '{"matchedOn":"structural-key","key":"k"}'::jsonb
                  WHERE feature_id = 'EI-DUP-B'`;
    const [row] = await db.sql<{ duplicate_confidence: number; matched: string }[]>`
      SELECT duplicate_confidence, duplicate_evidence->>'matchedOn' AS matched
        FROM harness_shared.work_items WHERE feature_id = 'EI-DUP-B'`;
    expect(row).toEqual({ duplicate_confidence: 1, matched: 'structural-key' });
    await db.sql`UPDATE harness_shared.work_items
                    SET duplicate_of = NULL, duplicate_source = NULL, duplicate_confidence = NULL, duplicate_evidence = NULL
                  WHERE feature_id = 'EI-DUP-B'`;
  });

  it('appends both columns to every view that reads work_items, keeping each existing column in place', async () => {
    for (const v of VIEWS) {
      expect(columnsBefore[v].length, `${v} had columns before 1534`).toBeGreaterThan(0);
      expect(await viewColumns(db, v), v).toEqual([...columnsBefore[v], 'duplicate_of', 'duplicate_source']);
    }
  });

  it('work_items_claimable never serves a row carrying a duplicate verdict, and serves its non-duplicate twin', async () => {
    const claimable = async () =>
      (
        await db.sql<{ feature_id: string }[]>`
          SELECT feature_id FROM harness_shared.work_items_claimable
           WHERE feature_id LIKE 'EI-DUP-%' ORDER BY feature_id`
      ).map((r) => r.feature_id);

    // Positive control: with no verdict the stubbed floors admit all three open bugs.
    expect(await claimable()).toEqual(['EI-DUP-A', 'EI-DUP-B', 'EI-DUP-C']);

    await db.sql`UPDATE harness_shared.work_items SET duplicate_of = 'EI-DUP-A', duplicate_source = 'agent'
                  WHERE feature_id = 'EI-DUP-B'`;
    expect(await claimable()).toEqual(['EI-DUP-A', 'EI-DUP-C']);

    // D-001: ANY non-null verdict excludes the row, even when the canonical is terminal.
    await db.sql`UPDATE harness_shared.work_items SET status = 'done' WHERE feature_id = 'EI-DUP-A'`;
    expect(await claimable()).toEqual(['EI-DUP-C']);

    await db.sql`UPDATE harness_shared.work_items SET status = 'open' WHERE feature_id = 'EI-DUP-A'`;
    await db.sql`UPDATE harness_shared.work_items SET duplicate_of = NULL, duplicate_source = NULL
                  WHERE feature_id = 'EI-DUP-B'`;
    expect(await claimable()).toEqual(['EI-DUP-A', 'EI-DUP-B', 'EI-DUP-C']);
  });

  it('engineer_issues and harness_features_consolidated carry the verdict for their own rows', async () => {
    await db.sql`UPDATE harness_shared.work_items SET duplicate_of = 'EI-DUP-A', duplicate_source = 'fold'
                  WHERE feature_id = 'EI-DUP-B'`;
    await db.sql`UPDATE harness_shared.work_items SET duplicate_of = 'F-DUP-OTHER', duplicate_source = 'agent'
                  WHERE feature_id = 'F-DUP-F'`;
    const issues = await db.sql<{ issue_id: string; duplicate_of: string | null; duplicate_source: string | null }[]>`
      SELECT issue_id, duplicate_of, duplicate_source FROM harness_shared.engineer_issues
       WHERE issue_id IN ('EI-DUP-A', 'EI-DUP-B') ORDER BY issue_id`;
    expect(issues).toEqual([
      { issue_id: 'EI-DUP-A', duplicate_of: null, duplicate_source: null },
      { issue_id: 'EI-DUP-B', duplicate_of: 'EI-DUP-A', duplicate_source: 'fold' },
    ]);
    const [feature] = await db.sql<{ duplicate_of: string | null; duplicate_source: string | null }[]>`
      SELECT duplicate_of, duplicate_source FROM harness_shared.harness_features_consolidated
       WHERE feature_id = 'F-DUP-F'`;
    expect(feature).toEqual({ duplicate_of: 'F-DUP-OTHER', duplicate_source: 'agent' });
    await db.sql`UPDATE harness_shared.work_items SET duplicate_of = NULL, duplicate_source = NULL
                  WHERE feature_id IN ('EI-DUP-B', 'F-DUP-F')`;
  });

  it('indexes rows by their canonical for the fold and the occurrence count', async () => {
    const [idx] = await db.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'harness_shared' AND indexname = 'work_items_duplicate_of_idx'`;
    expect(idx?.indexdef).toMatch(/\(workspace_id, duplicate_of\) WHERE \(duplicate_of IS NOT NULL\)/);
  });

  it('re-applying the migration is a verified no-op: view definitions and columns are unchanged', async () => {
    const before = await viewDefs(db);
    await applyMigrationForTest(db.sql, MIGRATION_1534!);
    expect(await viewDefs(db)).toEqual(before);
    for (const v of VIEWS) {
      expect(await viewColumns(db, v), v).toEqual([...columnsBefore[v], 'duplicate_of', 'duplicate_source']);
    }
  });
});

describe('migration 1534 refuses to patch a view whose shape it cannot locate exactly once', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    expect(MIGRATION_1534).toBeDefined();
    db = await createFreshPgDb('work-items-duplicate-of-guard');
    await standUpViews(db);
    // Re-shape engineer_issues so its rendering no longer has exactly one top-level
    // "FROM harness_shared.work_items" line (two branches of a UNION).
    await db.sql
      .unsafe(
        `DROP VIEW harness_shared.engineer_issues CASCADE;
         CREATE VIEW harness_shared.engineer_issues AS
           SELECT feature_id AS issue_id FROM harness_shared.work_items WHERE item_kind = 'bug'
           UNION ALL
           SELECT feature_id AS issue_id FROM harness_shared.work_items WHERE item_kind = 'task';`,
      )
      .simple();
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  it('fails loudly and rolls back instead of patching the wrong clause', async () => {
    await expect(applyMigrationForTest(db.sql, MIGRATION_1534!)).rejects.toThrow(
      /1534: expected exactly one top-level work_items FROM anchor in engineer_issues/,
    );
    // The whole file ran as one implicit transaction, so nothing from it survived.
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'work_items' AND column_name = 'duplicate_of'`;
    expect(n).toBe(0);
  });
});
