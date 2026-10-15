/**
 * schema-object-drift.integration.test.ts — PINS the migration-derived index
 * manifest to the migrations themselves.
 *
 * `packages/operator-core/lib/db-schema-reference/index-manifest.ts` is the
 * reference side of the live-vs-migration index drift guard: the exact index
 * census of a database with every migration applied. It is only trustworthy if
 * it cannot silently fall behind the SQL it claims to describe, and this test is
 * what makes that true — it applies the CURRENT migration set to a throwaway
 * database with the real boot-path runner (the same machinery
 * fresh-migrate.integration.test.ts uses) and asserts the committed manifest
 * still matches, naming every index that moved.
 *
 * Regenerate after any migration that adds, drops or redefines an index:
 *
 *   PAPERCUSP_UPDATE_INDEX_MANIFEST=1 \
 *     npm run test:file -- apps/operator/test/schema-object-drift.integration.test.ts
 *
 * ## What this test deliberately does NOT do
 *
 * It does not compare against the LIVE operator database, and so it cannot go
 * red because of what is in one. That comparison is the standing guard's job
 * (`checkSchemaObjectDrift()`, surfaced through the improvements watchdog),
 * and it belongs there rather than here for a reason: the live database is a
 * per-machine artifact — a long-lived dev box accumulates objects a fresh
 * install never had — so failing a shared build on one developer's local schema
 * would make the gate a machine-dependent coin flip. A finding names the drift
 * and stays actionable; a red gate on a personal database just gets routed
 * around, and then the guard is worse than nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  takeIndexCensus,
  compareIndexCensus,
  describeSchemaObjectDrift,
  type IndexCensusEntry,
} from '@papercusp/operator-core/lib/schema-object-drift';
import { INDEX_MANIFEST } from '@papercusp/operator-core/lib/db-schema-reference/index-manifest';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MANIFEST_FILE = resolve(
  REPO_ROOT,
  'packages/operator-core/lib/db-schema-reference/index-manifest.ts',
);

const UPDATE = process.env.PAPERCUSP_UPDATE_INDEX_MANIFEST === '1';

// Roles + the 3 extensions the baseline references — mirrored from
// embedded-postgres-server/src/index.js, same block as fresh-migrate's.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
      CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
    END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const MANIFEST_HEADER = `/**
 * index-manifest.ts — GENERATED. Do not hand-edit.
 *
 * The index census of a database with every \`libs/papercusp/libs/db/sql/*.sql\`
 * migration applied to it — i.e. exactly the indexes a FRESH INSTALL gets. It is
 * the reference side of \`../schema-object-drift.ts\`, whose module header
 * explains why this is materialized from a real Postgres rather than parsed out
 * of the migration SQL.
 *
 * Regenerate (and re-pin) with:
 *   PAPERCUSP_UPDATE_INDEX_MANIFEST=1 \\
 *     npm run test:file -- apps/operator/test/schema-object-drift.integration.test.ts
 *
 * That same test, run WITHOUT the env var, applies the current migrations to a
 * throwaway database and asserts this file still matches them — so the manifest
 * cannot silently drift away from the SQL it claims to describe.
 *
 * An EMPTY \`indexes\` array is the un-generated state: \`checkSchemaObjectDrift()\`
 * reports it as UNAVAILABLE rather than as a clean result, because a check that
 * could not run and a check that found nothing are the same zero if you only
 * look at the count.
 */
import type { IndexManifest } from '../schema-object-drift';

export const INDEX_MANIFEST: IndexManifest = `;

function renderManifest(indexes: IndexCensusEntry[], migrationCount: number): string {
  const body = {
    generatedAt: new Date().toISOString(),
    migrationCountAtGeneration: migrationCount,
    indexes,
  };
  return `${MANIFEST_HEADER}${JSON.stringify(body, null, 2)};\n`;
}

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;
let referenceCensus: IndexCensusEntry[];
let migrationCount: number;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `idxman_${randomBytes(5).toString('hex')}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  // max:1 — the runner applies each migration in an explicit BEGIN/COMMIT block.
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  await sql.unsafe(BOOT_PREREQS_DDL);
  await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });

  referenceCensus = await takeIndexCensus(sql);
  migrationCount = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).length;

  if (UPDATE) {
    writeFileSync(MANIFEST_FILE, renderManifest(referenceCensus, migrationCount), 'utf8');
  }
}, 180_000);

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

describe('the migration-derived index manifest', () => {
  it('is non-trivial — the migrations really do build indexes', () => {
    // Guards the whole file against the failure mode where the reference comes
    // back empty (a migration apply that silently did nothing, a census query
    // that matched no schema) and every comparison below passes vacuously.
    expect(referenceCensus.length).toBeGreaterThan(500);
    expect(new Set(referenceCensus.map((e) => e.schema))).toContain('harness_shared');
  });

  it('includes the two index classes a TEXT search over the migrations cannot find', () => {
    // These are why the reference is materialized instead of parsed — see
    // schema-object-drift.ts's module header. If the census ever stops carrying
    // them, the guard has quietly reacquired its false-positive classes.
    const names = new Set(referenceCensus.map((e) => e.name));

    // (a) Built by migration 530 through EXECUTE format() — the identifier never
    //     appears as a literal anywhere in the SQL corpus.
    const dynamic = [...names].filter((n) => n.endsWith('_embedding_mode_idx'));
    expect(dynamic.length).toBeGreaterThan(0);

    // (b) Named by Postgres itself for a UNIQUE table constraint.
    const autoNamed = referenceCensus.filter((e) => e.constraintBacked && e.name.endsWith('_key'));
    expect(autoNamed.length).toBeGreaterThan(0);
  });

  it('matches the committed manifest', () => {
    if (UPDATE) {
      // The regeneration run wrote the file above; asserting the stale in-memory
      // import against it would be comparing the old bytes to the new ones.
      return;
    }
    expect(
      INDEX_MANIFEST.indexes.length,
      `The index manifest has never been generated. Run:\n  PAPERCUSP_UPDATE_INDEX_MANIFEST=1 npm run test:file -- apps/operator/test/schema-object-drift.integration.test.ts`,
    ).toBeGreaterThan(0);

    const drift = compareIndexCensus(referenceCensus, [...INDEX_MANIFEST.indexes]);
    expect(
      drift.liveOnly.length + drift.referenceOnly.length + drift.definitionMismatch.length,
      `The committed index manifest no longer matches the migrations.\n\n` +
        `${describeSchemaObjectDrift(drift)}\n\n` +
        `(In this comparison "live" means THE COMMITTED MANIFEST and "reference" means the migrations as they are on disk right now.)\n\n` +
        `Regenerate it:\n  PAPERCUSP_UPDATE_INDEX_MANIFEST=1 npm run test:file -- apps/operator/test/schema-object-drift.integration.test.ts`,
    ).toBe(0);
  });

  it('carries each index exactly once', () => {
    const keys = referenceCensus.map((e) => `${e.schema}.${e.name}`);
    const repeated = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    expect(repeated, 'index keys repeated in the census').toEqual([]);
  });
});

/**
 * The census QUERY against the one shape that broke it (WI-10005064): foreign
 * keys. A foreign key sets `pg_constraint.conindid` to the REFERENCED table's
 * unique index, so a census that joins on `conindid` alone emits one row per
 * referencing FK and calls an FK-referenced plain unique index constraint-backed.
 *
 * `LEGACY_JOIN_CENSUS_SQL` is that broken query, kept on purpose as the control:
 * it must still show the defect on this fixture, or the fixture has stopped
 * exercising the FK class and the real assertions below would pass vacuously.
 */
const FIXTURE_SCHEMA = 'census_fk_fixture';

const LEGACY_JOIN_CENSUS_SQL = `
  SELECT i.indexname AS name, (con.conindid IS NOT NULL) AS "constraintBacked"
    FROM pg_indexes i
    JOIN pg_class ic
      ON ic.relname = i.indexname
     AND ic.relnamespace = i.schemaname::regnamespace
    LEFT JOIN pg_constraint con
      ON con.conindid = ic.oid
   WHERE i.schemaname = '${FIXTURE_SCHEMA}'
`;

describe('the index census query', () => {
  beforeAll(async () => {
    await sql.unsafe(`
      CREATE SCHEMA ${FIXTURE_SCHEMA};
      CREATE TABLE ${FIXTURE_SCHEMA}.parent (
        id         integer PRIMARY KEY,
        code       text,
        label      text CONSTRAINT parent_label_key UNIQUE,
        parent_ref integer REFERENCES ${FIXTURE_SCHEMA}.parent (id)
      );
      CREATE UNIQUE INDEX parent_code_uq ON ${FIXTURE_SCHEMA}.parent (code);
      CREATE TABLE ${FIXTURE_SCHEMA}.child_a (
        parent_id   integer REFERENCES ${FIXTURE_SCHEMA}.parent (id),
        parent_code text    REFERENCES ${FIXTURE_SCHEMA}.parent (code)
      );
      CREATE TABLE ${FIXTURE_SCHEMA}.child_b (
        parent_id integer REFERENCES ${FIXTURE_SCHEMA}.parent (id)
      );
    `);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
  });

  it('control: a conindid join really is broken on this fixture', async () => {
    const rows = (await sql.unsafe(LEGACY_JOIN_CENSUS_SQL)) as Array<{
      name: string;
      constraintBacked: boolean;
    }>;
    // parent_pkey: its own PK + two child FKs + the self-referencing FK.
    expect(rows.filter((r) => r.name === 'parent_pkey')).toHaveLength(4);
    expect(rows.find((r) => r.name === 'parent_code_uq')?.constraintBacked).toBe(true);
  });

  it('returns each index once, constraint-backed only by its own PK / UNIQUE constraint', async () => {
    const census = (await takeIndexCensus(sql)).filter((e) => e.schema === FIXTURE_SCHEMA);
    const byName = Object.fromEntries(census.map((e) => [e.name, e.constraintBacked]));

    expect(census.map((e) => e.name).sort()).toEqual([
      'parent_code_uq',
      'parent_label_key',
      'parent_pkey',
    ]);
    expect(byName).toEqual({
      parent_pkey: true,
      parent_label_key: true,
      // A plain unique index is not constraint-backed just because an FK uses it.
      parent_code_uq: false,
    });
  });
});
