/**
 * P-020 (first cut) — work_items generalization behavior. Migration 135's
 * empty→head correctness is covered by fresh-migrate.integration.test.ts; this
 * exercises the behavior: item_kind defaults to 'feature' on existing rows, a
 * non-feature kind + payload round-trips, and the work_items view reads the base.
 *
 * The DDL mirrors migration 135 (sans the full baseline table — only the columns
 * under test), the established pattern for these focused PG tests.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `wi_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  // A minimal harness_features_consolidated (the legacy `kind` = feature
  // sub-category) with a pre-existing feature row, THEN migration 135's changes.
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id   text NOT NULL,
      status       text,
      kind         text,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );
    INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, status, kind)
      VALUES ('ws', 'demo', 'F-1', 'passed', 'infra');
  `);
  // === migration 135 (item_kind + payload + work_items view) ===
  await sql.unsafe(`
    ALTER TABLE harness_shared.harness_features_consolidated
      ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'feature';
    ALTER TABLE harness_shared.harness_features_consolidated
      ADD COLUMN IF NOT EXISTS payload jsonb;
    CREATE OR REPLACE VIEW harness_shared.work_items AS
      SELECT * FROM harness_shared.harness_features_consolidated;
  `);
}, 60_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

it('the pre-existing feature row gets item_kind=feature (default), legacy kind untouched', async () => {
  const rows = await sql`SELECT item_kind, kind, payload FROM harness_shared.harness_features_consolidated WHERE feature_id='F-1'`;
  expect(rows[0].item_kind).toBe('feature');
  expect(rows[0].kind).toBe('infra'); // legacy sub-category preserved, NOT clobbered
  expect(rows[0].payload).toBeNull();
});

it('a non-feature-pipeline work-item (chunk) inserts with payload + reads via work_items', async () => {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, status, item_kind, payload)
    VALUES ('ws', 'demo', 'R-1', 'pending', 'chunk', ${sql.json({ question: 'what is X?' })})
  `;
  const rows = await sql`SELECT item_kind, payload FROM harness_shared.work_items WHERE feature_id='R-1'`;
  expect(rows[0].item_kind).toBe('chunk');
  expect(rows[0].payload).toEqual({ question: 'what is X?' });
});

it('work_items view exposes both feature and chunk rows', async () => {
  const kinds = (await sql`SELECT item_kind FROM harness_shared.work_items ORDER BY item_kind`).map((r) => r.item_kind);
  expect(kinds).toEqual(['chunk', 'feature']);
});
