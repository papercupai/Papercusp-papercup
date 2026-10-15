/**
 * migration-649-pot-backfill.integration.test.ts — a migration must never make a
 * BOOT depend on state that only exists AFTER the boot.
 *
 * WHY THIS EXISTS (EI-18892214197928842). `649-pot-membership-backfill.sql` re-homes
 * mis-scoped `work_items.harness_slug` values onto real Pots, and RAISEs if it cannot.
 * `harness_shared.pots` is populated only at RUNTIME by `hive-store.ts` — NO migration,
 * not even `000-baseline.sql`, ever inserts a Pot. Migrations run BEFORE the operator
 * boots. So on a fresh database the pots table is empty BY CONSTRUCTION, 649 could not
 * home anything, and it raised.
 *
 * The consequence was not a failed migration. It was that THE SHIPPED DESKTOP APP COULD
 * NOT BOOT AT ALL: reproduced on the packaged 0.0.13 deb on 2026-07-28 with
 * `649 guard: 8 mapped target slug(s) are not real pots`, after which serve.mjs exited 1,
 * the sidecar respawn-looped to its 5-in-300s cap, and the webview showed a proxy error
 * page forever. Nothing in that symptom points at a migration, which is why finding it
 * cost a full day's diagnosis.
 *
 * THE FIX IS ALIGNMENT, NOT A LOOSENED CHECK. Migrations 651 and 652 — same plan, same
 * invariant, written days later — already ruled on this exact condition: "Fail OPEN for a
 * workspace with no platform Pot (isolated fixtures / un-potted tenant)". 649 hard-RAISEd
 * where its own siblings deliberately fail open. It was the outlier. It now shares their
 * precondition, and the rows it declines to touch are left for 652's runtime self-heal.
 *
 * (The alternative — have a migration CREATE the papercusp Pot — is wrong: a Pot carries a
 * federation identity, `public_key` + `keychain_id`. A migration must not mint a keypair.
 * The fixture below has to fabricate one, which is precisely why only a fixture may.)
 *
 * WHAT MAKES THESE TESTS TEETH RATHER THAN A RUBBER STAMP. "The migration no longer throws"
 * would also pass against a 649 whose guards had simply been deleted, and deleting the
 * guards would reintroduce something worse than the boot failure: SILENT DATA LOSS. Under
 * the old file, a row whose slug already equalled its target matched ITSELF in the
 * duplicate-shadow dedup and was DELETED in step 4 — which is what the packaged app's 8
 * rows actually did. Only the `bad_target` RAISE rolled that deletion back. So every test
 * here asserts row SURVIVAL and exact slugs, not merely that the runner resolved. A fix by
 * check-deletion fails them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations, compareMigrationFilenames, defaultSkipFile } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const MIGRATION = '649-pot-membership-backfill.sql';
const WORKSPACE = 'papercusp-workspace';
/** Maps to `oddsmith-hive` in the CASE — an optional Pot we deliberately never create. */
const MIS_SCOPED_SLUG = 'oddsmith';
const CATCH_ALL_POT = 'papercusp';

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

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

/** Exercise the backfill at its real boot stage. Later migrations (1134)
 * replace its legacy capture trigger, so replaying 649 against head is invalid. */
function applyThrough649() {
  return applyPendingMigrations({
    client: sql,
    sqlDir: SQL_DIR,
    skipFile: (file) => defaultSkipFile(file) || compareMigrationFilenames(file, MIGRATION) > 0,
  });
}

/** A slug the CASE maps onto an OPTIONAL Pot that does not exist here. */
const optionalTargetId = `EI-TEST-649-opt-${randomBytes(4).toString('hex')}`;
/**
 * The packaged app's actual shape: a row ALREADY scoped to the catch-all slug, in a
 * database where that slug is not (yet) a Pot. Step 1 still selects it — `papercusp` is
 * not in `pots` — and before the fix it became its own duplicate shadow and was deleted.
 */
const selfTargetId = `EI-TEST-649-self-${randomBytes(4).toString('hex')}`;

/** Re-arm 649 as pending by forgetting it was applied (the runner skips by filename). */
async function rearm649(): Promise<void> {
  await sql.unsafe(`DELETE FROM harness_shared.schema_migrations WHERE filename = $1`, [MIGRATION]);
}

async function slugOf(featureId: string): Promise<string | null> {
  const rows = await sql.unsafe(
    `SELECT harness_slug FROM harness_shared.work_items
      WHERE workspace_id = $1 AND feature_id = $2`,
    [WORKSPACE, featureId],
  );
  return rows.length ? (rows[0] as unknown as { harness_slug: string }).harness_slug : null;
}

async function seededRowCount(): Promise<number> {
  const [{ n }] = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM harness_shared.work_items
      WHERE workspace_id = $1 AND feature_id = ANY($2)`,
    [WORKSPACE, [optionalTargetId, selfTargetId]],
  )) as Array<{ n: number }>;
  return n;
}

async function createPlatformPot(): Promise<void> {
  await sql.unsafe(
    `INSERT INTO harness_shared.pots
       (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
     VALUES ($1, $2, '\\x00'::bytea, $3, $4)
     ON CONFLICT DO NOTHING`,
    [WORKSPACE, CATCH_ALL_POT, `kc-${randomBytes(4).toString('hex')}`, Date.now()],
  );
}

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `m649_${randomBytes(5).toString('hex')}`;

  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  await sql.unsafe(BOOT_PREREQS_DDL);
  await applyThrough649();

  // A fresh database has no work_items, so 649 was a no-op above. Seed the exact two
  // shapes the packaged app had, in a database that (like the packaged one) has no Pots.
  await sql.unsafe(
    `INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
     VALUES ($1, $2, $3), ($1, $4, $5)`,
    [WORKSPACE, MIS_SCOPED_SLUG, optionalTargetId, CATCH_ALL_POT, selfTargetId],
  );
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

describe('migration 649 — a backfill must not gate the boot on post-boot state', () => {
  it('uses the historical boot stage with its legacy capture trigger intact', async () => {
    const applied = await sql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations`;
    expect(applied.some((row) => row.filename === MIGRATION)).toBe(true);
    expect(applied.every((row) => compareMigrationFilenames(row.filename, MIGRATION) <= 0)).toBe(true);
    const triggers = await sql<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid='harness_shared.work_items'::regclass AND NOT tgisinternal`;
    expect(triggers.map((row) => row.tgname)).toContain('capture_work_items_outbox_ins_del_trg');
    expect(triggers.map((row) => row.tgname)).not.toContain('capture_work_items_outbox_ins_trg');
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='harness_shared' AND table_name='pots'`;
    expect(columns.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'workspace_id', 'pot_home_slug', 'public_key', 'keychain_id', 'created_at',
    ]));
    // Added by 686, so it cannot be part of a 649-era seed.
    expect(columns.map((row) => row.column_name)).not.toContain('canonical_pot_home_slug');
  });

  it('APPLIES CLEANLY on a database with no Pots at all — the shipped-app case', async () => {
    // Precisely the packaged 0.0.13 state: rows to re-home, and nowhere yet to put them
    // because the operator that creates Pots has not run. This is a normal deployment
    // state, not a corruption, so the migration must complete rather than take the boot
    // down with it.
    const [{ n: pots }] = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.pots`,
    )) as Array<{ n: number }>;
    expect(pots).toBe(0);

    await rearm649();
    await expect(applyThrough649()).resolves.toBeDefined();
  });

  it('leaves every row EXACTLY as it was when it declines to backfill', async () => {
    // The teeth. Declining must mean "touch nothing" — not "delete what cannot be homed".
    // Before the fix the second row below was matched against ITSELF by the duplicate-
    // shadow dedup (its slug already equalled its target) and DELETED in step 4; only the
    // bad_target RAISE rolled that back. Remove the guards without fixing the dedup and
    // this assertion is what catches the silent purge.
    expect(await seededRowCount()).toBe(2);
    expect(await slugOf(optionalTargetId)).toBe(MIS_SCOPED_SLUG);
    expect(await slugOf(selfTargetId)).toBe(CATCH_ALL_POT);
  });

  it('re-homes onto the catch-all once the platform Pot exists, though the mapped Pot never does', async () => {
    await createPlatformPot();

    // `oddsmith-hive` — the Pot the CASE actually maps this slug to — is still absent.
    // That alone used to raise `649 guard: N mapped target slug(s) are not real pots`.
    const [{ n }] = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.pots WHERE pot_home_slug = 'oddsmith-hive'`,
    )) as Array<{ n: number }>;
    expect(n).toBe(0);

    await rearm649();
    await expect(applyThrough649()).resolves.toBeDefined();

    // Re-homed, and — the point of the dedup fix — still TWO rows, not one.
    expect(await slugOf(optionalTargetId)).toBe(CATCH_ALL_POT);
    expect(await slugOf(selfTargetId)).toBe(CATCH_ALL_POT);
    expect(await seededRowCount()).toBe(2);
  });

  it('is idempotent — re-running after a successful backfill changes nothing', async () => {
    await rearm649();
    await expect(applyThrough649()).resolves.toBeDefined();
    expect(await seededRowCount()).toBe(2);
    expect(await slugOf(optionalTargetId)).toBe(CATCH_ALL_POT);
    expect(await slugOf(selfTargetId)).toBe(CATCH_ALL_POT);
  });
});
