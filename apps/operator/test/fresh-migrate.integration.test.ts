/**
 * fresh-migrate.integration.test.ts — the STRICT SUCCESS GATE: empty Postgres → head.
 *
 * Plan: self-contained-migration-baseline-2026-06-02, Phase 3 (P-011). Supersedes the
 * old "tripwire" (which asserted empty→head FAILED, because the schema used to be split
 * between hand-written migrations and runtime ensure-schema DDL).
 *
 * The schema is now a single self-contained `000-baseline.sql` (the squash + the
 * 117 archived incrementals). So empty→head MUST now succeed, completely and
 * idempotently, with ZERO skips. This gate asserts exactly that, exercising the REAL
 * production migration runner from a genuinely empty database.
 *
 * Boot pre-steps the production embedded-pg performs before migrations (and that this
 * gate replicates): framework roles + the 3 extensions the baseline references
 * (pgcrypto/pg_trgm/vector). See embedded-postgres-server/src/index.js.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path publication DDL
import { ensureZeroHarnessPublication } from '../../../libs/papercusp/packages/embedded-postgres-server/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

// Boot pre-migration step (roles + extensions), mirrored from embedded-postgres-server/src/index.js.
// A future refactor should extract a shared ensureFrameworkPrereqs() both call.
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

const MIN_HARNESS_SHARED_TABLES = 180; // complete baseline (see verify-baseline.ts); -3 after dropping the 3 harness_expert* tables (migration 117); -1 harness_health (migration 171)

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;
let firstRun: { appliedCount: number; totalKnown: number };

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `fm_${randomBytes(5).toString('hex')}`;

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

  // The one real apply, shared across the assertions below.
  firstRun = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
}, 120_000);

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

describe('fresh migrate — empty Postgres → head (STRICT SUCCESS GATE)', () => {
  it('applies every tracked migration from empty, with zero skips', () => {
    expect(firstRun.totalKnown).toBeGreaterThanOrEqual(1); // 000-baseline.sql (template is name-skipped)
    expect(firstRun.appliedCount).toBe(firstRun.totalKnown); // ZERO skips
  });

  it('builds the complete schema (all harness_shared tables present)', async () => {
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'harness_shared' AND table_type = 'BASE TABLE'`,
    );
    expect(n).toBeGreaterThanOrEqual(MIN_HARNESS_SHARED_TABLES);
  });

  it('records exactly one tracker row per applied migration', async () => {
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.schema_migrations`,
    );
    expect(n).toBe(firstRun.totalKnown);
  });

  it('wires the reactivity triggers (emit_change_notify_trg) from migrations, not runtime DDL', async () => {
    // Migration 107 moved these out of the old runtime wireDogfoodTriggers() helper.
    // A table/column/index/policy diff can't see triggers, so assert them explicitly.
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = 'emit_change_notify_trg'`,
    );
    expect(n).toBeGreaterThanOrEqual(18);
  });

  it('builds the core global schemas (papercusp_auth + audit, migration 109)', async () => {
    // The reference dump was scoped to harness_shared + papercusp_shared, so these were a
    // baseline blind spot until 109 restored them.
    const rows = await sql.unsafe(
      `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)`,
      [['harness_shared', 'papercusp_shared', 'papercusp_auth', 'audit']],
    );
    expect(rows.length).toBe(4);
  });

  it('agent_facts has a surrogate PK + REPLICA IDENTITY DEFAULT (migration 505 supersedes 498 — WI-2914)', async () => {
    // agent_facts publishes DELETEs for federation (mig 461 capture trigger + the
    // zero_harness publication), so it needs a replica identity that logs deletes.
    // 498 used REPLICA IDENTITY FULL as a no-PK workaround, but FULL includes the
    // STORED generated column fed_key (mig 462) → on PG18 the delete is rejected
    // ("Replica identity must not contain unpublished generated columns"), breaking
    // the sweep/GC. 505 gives it a surrogate PK and switches to REPLICA IDENTITY
    // DEFAULT (PK-only, no generated column) — a version-agnostic fix. 'd' = DEFAULT.
    const [{ relreplident }] = await sql.unsafe(
      `SELECT relreplident FROM pg_class
        WHERE relname = 'agent_facts' AND relnamespace = 'harness_shared'::regnamespace`,
    );
    expect(relreplident).toBe('d');

    // The surrogate PK must exist for DEFAULT to have key columns to log.
    const [{ pk_cols }] = await sql.unsafe(
      `SELECT array_agg(a.attname ORDER BY k.ord) AS pk_cols
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'harness_shared.agent_facts'::regclass AND c.contype = 'p'`,
    );
    expect(pk_cols).toEqual(['id']);
  });

  it('WI-2914: agent_facts sweep DELETE succeeds under the real zero_harness delete-publishing publication', async () => {
    // The replica-identity assertion above is necessary but NOT sufficient: the
    // actual sweep/GC DELETE only fails once the table is in a delete-publishing
    // publication — which the embedded/federated operator creates at boot but the
    // dev box's native PG never does (why the bug never reproduced on :5432). So run
    // the REAL boot-path publication DDL (ensureZeroHarnessPublication — the same fn
    // index.js calls at boot), then prove a full insert→delete round-trip works.
    //
    // Before migration 505 this DELETE threw, on PG18, "cannot delete from table
    // agent_facts: Replica identity must not contain unpublished generated columns"
    // (498's FULL replica identity contained the STORED generated column fed_key).
    // 505's surrogate-PK + REPLICA IDENTITY DEFAULT removes the generated column
    // from the identity, so the DELETE works on every PG version (this suite's PG16
    // container AND the PG18 ship target). Goes red if 505 is removed/regressed.
    await ensureZeroHarnessPublication(sql);

    // Sanity: agent_facts really is a member of the delete-publishing publication.
    const [{ published }] = await sql.unsafe(
      `SELECT count(*)::int > 0 AS published FROM pg_publication_tables
        WHERE pubname = 'zero_harness' AND schemaname = 'harness_shared'
          AND tablename = 'agent_facts'`,
    );
    expect(published).toBe(true);

    // The real thing the sweep does: insert an (expired) fact, then delete it.
    await sql.unsafe(`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, key, body, created_by, expires_at)
      VALUES ('wi2914-guard-ws', 'workspace', 'wi2914-guard-key', 'guard', 'test',
              now() - interval '1 day')
    `);
    await expect(
      sql.unsafe(
        `DELETE FROM harness_shared.agent_facts
          WHERE workspace_id = 'wi2914-guard-ws' AND key = 'wi2914-guard-key'`,
      ),
    ).resolves.toBeDefined();
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.agent_facts
        WHERE workspace_id = 'wi2914-guard-ws'`,
    );
    expect(n).toBe(0);
  });

  it('does not reissue per-harness publication membership DDL on a reused cluster', async () => {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_gym_durable`);
    await sql.unsafe(`
      DO $pg$ BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_publication p
          JOIN pg_publication_namespace pn ON pn.pnpubid = p.oid
          JOIN pg_namespace n ON n.oid = pn.pnnspid
          WHERE p.pubname = 'zero_harness' AND n.nspname = 'harness_gym_durable'
        ) THEN
          ALTER PUBLICATION zero_harness ADD TABLES IN SCHEMA harness_gym_durable;
        END IF;
      END $pg$;
    `);

    const calls: string[] = [];
    const observingClient = {
      begin: (callback: (tx: unknown) => Promise<unknown>) =>
        sql.begin(async (tx) =>
          callback({
            unsafe: (query: string, ...values: unknown[]) => {
              calls.push(query);
              return (tx as unknown as { unsafe: (sql: string, ...args: unknown[]) => unknown }).unsafe(
                query,
                ...values,
              );
            },
          }),
        ),
    };

    await ensureZeroHarnessPublication(observingClient);

    expect(calls.some((query) => query.includes('pg_publication_namespace'))).toBe(true);
    expect(
      calls.some((query) => query.includes('ALTER PUBLICATION zero_harness ADD TABLES IN SCHEMA harness_gym_durable')),
    ).toBe(false);
  });

  it('grants the runtime app role access (harness_app can read its tables — migration 109)', async () => {
    // --no-privileges stripped every grant from the baseline; 109 restores them. Connect AS
    // harness_app (not the migration superuser) to prove a fresh boot doesn't lock the app out.
    const u = new URL(adminUri);
    const appUri = `postgresql://harness_app:harness_app_pwd@${u.hostname}:${u.port}/${dbName}`;
    const app = postgres(appUri, { max: 1, onnotice: () => {} });
    try {
      await expect(app.unsafe(`SELECT count(*) FROM harness_shared.harness_features_consolidated`)).resolves.toBeDefined();
      await expect(app.unsafe(`SELECT count(*) FROM papercusp_auth.users`)).resolves.toBeDefined();
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it('WI-2668: unqualified `harness_features` resolves via the harness_shared fallback view when no per-harness schema exists (migration 497)', async () => {
    // A fresh-migrated DB has ONLY harness_shared — no per-harness `harness_<slug>`
    // schemas — which is exactly the packaged/federated (embedded) operator shape.
    // getHarnessPg(slug) opens a client with a connect-time search_path of
    // [harness_<slug>, harness_shared, papercusp_shared, public] so the ~20 legacy
    // call sites issuing UNQUALIFIED `SELECT ... FROM harness_features` resolve. With
    // no per-harness schema AND no fallback, that name is unresolvable and PG logs
    // `relation "harness_features" does not exist` in a tight loop (measured: 644 of
    // 4000 server-log lines on the Mac dogfood VM). Migration 497 adds
    // harness_shared.harness_features (a view over harness_features_consolidated),
    // always next in the search_path, so the name resolves on a consolidated-only
    // operator. (On tower the real per-harness table shadows it — not exercisable
    // here, since a fresh DB has no per-harness schema.)
    const u = new URL(adminUri);
    const appUri = `postgresql://harness_app:harness_app_pwd@${u.hostname}:${u.port}/${dbName}`;
    const app = postgres(appUri, { max: 1, onnotice: () => {} });
    try {
      // Mirror getHarnessPg's search_path with a DELIBERATELY ABSENT per-harness
      // schema first (nonexistent schemas in a search_path are silently skipped).
      await app.unsafe(
        `SET search_path TO "harness_no_such_slug", harness_shared, papercusp_shared, public`,
      );
      // The exact unqualified shape parseFeatures / the features routes issue. Before
      // 497 this REJECTED with relation-does-not-exist; it must now resolve.
      await expect(
        app.unsafe(`SELECT * FROM harness_features WHERE harness_slug = $1 ORDER BY feature_id`, [
          'any-slug',
        ]),
      ).resolves.toBeDefined();
      // …and the unqualified name resolves to the harness_shared fallback view
      // SPECIFICALLY (not a stray relation). (to_regclass::text would render the
      // name minimally — schema omitted because harness_shared is in the
      // search_path — so resolve the regclass and read its schema directly.)
      const [{ schema }] = await app.unsafe(
        `SELECT n.nspname AS schema
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = 'harness_features'::regclass`,
      );
      expect(schema).toBe('harness_shared');
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it('is idempotent — a second run applies nothing', async () => {
    const second = await applyPendingMigrations({ client: sql, sqlDir: SQL_DIR });
    expect(second.appliedCount).toBe(0);
  });

  it('re-applying 000-baseline.sql RAW is a clean no-op (statement-level idempotency)', async () => {
    // Asserted on a baseline-ONLY database, not the head DB: migration 374 turned
    // work_items/harness_features_consolidated/engineer_issues into views at head,
    // so table-DDL statements in the baseline (ALTER TABLE, triggers, RLS) now fail
    // there on relation-type mismatch no matter how well guarded. The contract this
    // gate protects — every baseline statement is guarded (IF NOT EXISTS /
    // OR REPLACE / DO-block) — is a property of the baseline itself.
    const { readFileSync } = await import('node:fs');
    const baseline = readFileSync(resolve(SQL_DIR, '000-baseline.sql'), 'utf8');
    const bName = `fmb_${randomBytes(5).toString('hex')}`;
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${bName}"`);
      await markManagedTestDatabase(admin, bName);
      const u = new URL(adminUri);
      u.pathname = `/${bName}`;
      const bSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
      try {
        await bSql.unsafe(BOOT_PREREQS_DDL);
        await bSql.unsafe(baseline);
        // Throws if any statement isn't guarded.
        await expect(bSql.unsafe(baseline)).resolves.toBeDefined();
      } finally {
        await bSql.end({ timeout: 5 });
      }
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${bName}" WITH (FORCE)`).catch(() => {});
      await admin.end({ timeout: 5 });
    }
  }, 120_000);
});

describe('migration runner — filename-keyed tracker safety', () => {
  it('records each migration filename at most once (filename is the PK)', async () => {
    const dupes = await sql.unsafe(
      `SELECT filename FROM harness_shared.schema_migrations
        GROUP BY filename HAVING count(*) > 1`,
    );
    expect(dupes).toHaveLength(0);
  });
});
