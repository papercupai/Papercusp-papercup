/**
 * work-items-outbox-canonical-slug.integration.test.ts — migration 452 (WI-900 M1).
 *
 * THE GAP THIS CLOSES
 * --------------------
 * `capture_work_items_outbox()` (the CDC capture the unified `work_items` table
 * rides — mig 375, refined 382/423/446) derives its routing `v_slug` straight from
 * the row's raw `harness_slug` and never calls `harness_shared.canonical_harness_slug()`
 * — unlike its sibling `capture_substrate_outbox()` (mig 359), which DOES wrap its
 * `v_slug` for exactly this reason: a write tagged with a RETIRED slug should
 * self-heal into its current hive instead of enqueuing an outbox row no booted
 * drain owns (which then just sits until the 48h backstop GC drops it, silently
 * never federating). `federation-slug-canonicalization.integration.test.ts` proves
 * this invariant for the GENERIC capture path (coord_event_log,
 * harness_features_consolidated pre-unification) — it does NOT cover the
 * work-items-specific capture fn, which is exactly where mig 375/382 silently
 * dropped the canonicalization. This file is that missing coverage, against the
 * REAL, CURRENT, full migration chain (000-baseline → HEAD, including mig 452).
 *
 * WHY THE FULL-CHAIN BOOT (not a hand-assembled schema slice)
 * -------------------------------------------------------------
 * Mirrors stamp-trigger-coverage.integration.test.ts: `createFreshTestDb` +
 * `applyPendingMigrations` runs the REAL boot-path migration runner over the REAL
 * sql/ directory, so this test exercises the actual live `capture_work_items_outbox`
 * function post-452 (not a reconstructed approximation) and would have caught the
 * bug had it existed at HEAD before this fix.
 *
 * RUN (real testcontainer PG):
 *   VITEST_UNIT_TIMEOUT_MS=180000 npm run test:file -- \
 *     packages/operator-core/lib/sync/hyperbee/__tests__/work-items-outbox-canonical-slug.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(REPO_ROOT, 'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js');
const MIGRATION_829_SQL = readFileSync(
  resolve(SQL_DIR, '829-harness-qualify-engineer-issue-op-identity.sql'),
  'utf8',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot /
// stamp-trigger-coverage.integration.test.ts. Roles are cluster-global on the
// reused testcontainer, hence IF NOT EXISTS.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const WS = 'ws_work_items_canon';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'wicanon',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

interface OutboxRow {
  table_name: string;
  harness_slug: string;
  key: string;
  row: Record<string, unknown> | null;
}

async function latestOutbox(key: string): Promise<OutboxRow | undefined> {
  const [r] = await sql<OutboxRow[]>`
    SELECT table_name, harness_slug, key, row FROM harness_shared.substrate_outbox
     WHERE key = ${key}
        OR row->>'issue_id' = ${key}
        OR row->>'feature_id' = ${key}
     ORDER BY id DESC LIMIT 1`;
  return r;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-canon-${seq}`;
}

describe('capture_work_items_outbox canonicalizes harness_slug (migration 452, WI-900 M1, real PG)', () => {
  it('an ISSUE (bug) written under the retired papercup slug federates under the canonical papercusp slug', async () => {
    const id = nextId('WI');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'papercup', ${id}, 'canon test issue', 'body', 'open', 'bug', 'local')`;
    const row = await latestOutbox(id);
    expect(row?.table_name).toBe('engineer_issues');
    expect(row?.harness_slug).toBe('papercusp');
    // Routing canonicalizes to papercusp, but row identity remains the physical
    // harness that owns the work_items row.  This distinction prevents a delete
    // on the shared home log from erasing a same-id papercusp sibling.
    expect(row?.key).toBe(`papercup/${id}`);
    expect(row?.row?.storage_harness_slug).toBe('papercup');
  });

  it('the papercup-hive alias also canonicalizes to papercusp (issue family)', async () => {
    const id = nextId('WI');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'papercup-hive', ${id}, 'canon test issue 2', 'body', 'open', 'change', 'local')`;
    expect((await latestOutbox(id))?.harness_slug).toBe('papercusp');
  });

  it('a FEATURE written under the retired papercup slug federates under the canonical papercusp slug', async () => {
    const id = nextId('F');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'papercup', ${id}, 'canon test feature', 'body', 'todo', 'feature', 'local')`;
    const row = await latestOutbox(id);
    expect(row?.table_name).toBe('harness_features_consolidated');
    expect(row?.harness_slug).toBe('papercusp');
  });

  it('a non-retired slug passes through UNCHANGED (behavior-preserving), both families', async () => {
    const issueId = nextId('WI');
    const featureId = nextId('F');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'real-hive', ${issueId}, 'passthrough issue', 'body', 'open', 'bug', 'local')`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES (${WS}, 'real-hive', ${featureId}, 'passthrough feature', 'body', 'todo', 'feature', 'local')`;
    expect((await latestOutbox(issueId))?.harness_slug).toBe('real-hive');
    expect((await latestOutbox(featureId))?.harness_slug).toBe('real-hive');
    expect((await latestOutbox(issueId))?.key).toBe(`real-hive/${issueId}`);
    // The feature family retains its established per-log key shape.
    expect((await latestOutbox(featureId))?.key).toBe(featureId);
  });

  it('does not trigger the migration 829 restore from unrelated nonempty backup rows', async () => {
    const unrelatedId = nextId('WI');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin)
      VALUES ('papercusp-workspace', 'papercusp', ${unrelatedId}, 'unrelated backup witness', 'body', 'open', 'bug', 'local')`;

    try {
      const [backupProjection] = await sql<Array<{ target_columns: string; source_columns: string }>>`
        SELECT string_agg(format('%I', backup_col.attname), ', ' ORDER BY current_col.attnum) AS target_columns,
               string_agg(format('w.%I', current_col.attname), ', ' ORDER BY current_col.attnum) AS source_columns
          FROM pg_attribute current_col
          JOIN pg_attribute backup_col
            ON backup_col.attrelid = 'harness_shared.bak_20260813_work_item_physical_twins'::regclass
           AND backup_col.attname = current_col.attname
           AND backup_col.attnum > 0
           AND NOT backup_col.attisdropped
           AND backup_col.attgenerated = ''
         WHERE current_col.attrelid = 'harness_shared.work_items'::regclass
           AND current_col.attnum > 0
           AND NOT current_col.attisdropped
           AND current_col.attgenerated = ''`;
      if (!backupProjection?.target_columns || !backupProjection.source_columns) {
        throw new Error('migration 826 backup has no writable columns in common with work_items');
      }

      await sql.unsafe(
        `INSERT INTO harness_shared.bak_20260813_work_item_physical_twins (${backupProjection.target_columns})
         SELECT ${backupProjection.source_columns}
           FROM harness_shared.work_items w
          WHERE w.workspace_id = $1 AND w.feature_id = $2`,
        ['papercusp-workspace', unrelatedId],
      );
      await sql.unsafe(MIGRATION_829_SQL);

      const [{ n }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM harness_shared.work_items
         WHERE workspace_id = 'papercusp-workspace'
           AND feature_id IN ('EI-1435', 'EI-1629', 'EI-1700', 'EI-2205', 'EI-6706',
                              'EI-6707', 'EI-6708', 'EI-6765', 'EI-7019', 'EI-7532',
                              'EI-7690', 'WI-1993', 'WI-2017', 'WI-2063', 'WI-2124')`;
      expect(n).toBe(0);
    } finally {
      await sql`
        DELETE FROM harness_shared.bak_20260813_work_item_physical_twins
         WHERE workspace_id = 'papercusp-workspace' AND feature_id = ${unrelatedId}`;
      await sql`
        DELETE FROM harness_shared.work_items
         WHERE workspace_id = 'papercusp-workspace' AND feature_id = ${unrelatedId}`;
    }
  });

  it('migration 829 restores an erased Papercusp survivor and emits its harness-qualified identity', async () => {
    const restoreIds = [
      'EI-1435',
      'EI-1629',
      'EI-1700',
      'EI-2205',
      'EI-6706',
      'EI-6707',
      'EI-6708',
      'EI-6765',
      'EI-7019',
      'EI-7532',
      'EI-7690',
      'WI-1993',
      'WI-2017',
      'WI-2063',
      'WI-2124',
    ] as const;
    const id = restoreIds[0];
    const survivorPayload = JSON.stringify({ survivor: 'papercusp' });
    const sourcePayload = JSON.stringify({
      source: 'operator',
      _completionEvidence: { testResult: 'green' },
    });
    const [backupProjection] = await sql<Array<{ target_columns: string; source_columns: string }>>`
      SELECT string_agg(format('%I', backup_col.attname), ', ' ORDER BY current_col.attnum) AS target_columns,
             string_agg(format('w.%I', current_col.attname), ', ' ORDER BY current_col.attnum) AS source_columns
        FROM pg_attribute current_col
        JOIN pg_attribute backup_col
          ON backup_col.attrelid = 'harness_shared.bak_20260813_work_item_physical_twins'::regclass
         AND backup_col.attname = current_col.attname
         AND backup_col.attnum > 0
         AND NOT backup_col.attisdropped
         AND backup_col.attgenerated = ''
       WHERE current_col.attrelid = 'harness_shared.work_items'::regclass
         AND current_col.attnum > 0
         AND NOT current_col.attisdropped
         AND current_col.attgenerated = ''`;
    if (!backupProjection?.target_columns || !backupProjection.source_columns) {
      throw new Error('migration 826 backup has no writable columns in common with work_items');
    }

    // Reconstruct the production incident from migration 826's durable backup:
    // two content-identical physical rows were preserved, then a legacy bare-key
    // tombstone erased the Papercusp survivor after the redundant source row was
    // removed.  Seed the backup through real work_items rows so its wide schema
    // stays aligned with HEAD without duplicating the column list here.  All 15
    // frozen IDs are required: migration 829 deliberately refuses a partial
    // incident backup instead of guessing which survivor rows should exist.
    for (const restoreId of restoreIds) {
      const title = `restoration witness ${restoreId}`;
      await sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
        VALUES
          ('papercusp-workspace', 'papercusp', ${restoreId}, ${title}, 'same body',
           'open', 'bug', 'local', ${restoreId === id ? survivorPayload : '{}'}::text::jsonb),
          ('papercusp-workspace', 'operator:papercusp-workspace', ${restoreId}, ${title}, 'same body',
           'open', 'bug', 'local', ${restoreId === id ? sourcePayload : '{}'}::text::jsonb)`;
      await sql.unsafe(
        `INSERT INTO harness_shared.bak_20260813_work_item_physical_twins (${backupProjection.target_columns})
         SELECT ${backupProjection.source_columns}
           FROM harness_shared.work_items w
          WHERE w.workspace_id = $1 AND w.feature_id = $2`,
        ['papercusp-workspace', restoreId],
      );
    }
    await sql.unsafe(
      `UPDATE harness_shared.bak_20260813_work_item_physical_twins
          SET status = 'done',
              completion_ref = jsonb_build_object('summary', 'source completion'),
              terminal_completion_ref = 'source completion',
              terminal_owner = 'source-agent',
              authority = 'committed'
        WHERE harness_slug = 'operator:papercusp-workspace' AND feature_id = $1`,
      [id],
    );
    for (const restoreId of restoreIds) {
      await sql`
        DELETE FROM harness_shared.work_items
         WHERE workspace_id = 'papercusp-workspace' AND feature_id = ${restoreId}`;
    }

    await sql.unsafe(MIGRATION_829_SQL);

    const rows = await sql<
      {
        harness_slug: string;
        status: string;
        completion_ref: Record<string, unknown> | null;
        terminal_completion_ref: string | null;
        terminal_owner: string | null;
        authority: string | null;
        payload: Record<string, unknown>;
      }[]
    >`
      SELECT harness_slug, status, completion_ref, terminal_completion_ref,
             terminal_owner, authority, payload
        FROM harness_shared.work_items
       WHERE workspace_id = 'papercusp-workspace' AND feature_id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      harness_slug: 'papercusp',
      status: 'done',
      completion_ref: { summary: 'source completion' },
      terminal_completion_ref: 'source completion',
      terminal_owner: 'source-agent',
      authority: 'committed',
    });
    expect(rows[0]?.payload).toMatchObject({
      survivor: 'papercusp',
      _completionEvidence: { testResult: 'green' },
      _physicalTwinRepair: {
        migration: 826,
        sourceHarness: 'operator:papercusp-workspace',
      },
    });

    const outbox = await latestOutbox(id);
    expect(outbox).toMatchObject({
      table_name: 'engineer_issues',
      harness_slug: 'papercusp',
      key: `papercusp/${id}`,
    });
    expect(outbox?.row?.storage_harness_slug).toBe('papercusp');

    // Re-execution is deliberately safe: an exact restored survivor is retained,
    // evidence remains merged, and the frozen postcondition still holds.
    await expect(sql.unsafe(MIGRATION_829_SQL)).resolves.toBeDefined();
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.work_items
       WHERE workspace_id = 'papercusp-workspace'
         AND harness_slug = 'papercusp'
         AND feature_id IN ${sql(restoreIds)}`;
    expect(n).toBe(restoreIds.length);
  });
});
