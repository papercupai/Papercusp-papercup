/**
 * db-boot-migrate.integration.test.ts
 *
 * handoff-coordination-dx-followups-2026-06-04 §A1 — automated coverage for the
 * NATIVE-:5432 boot-apply (the other half of the acceptance: "native box
 * auto-applies on restart").
 *
 * Embedded-pg auto-applies pending sql/*.sql when its server boots; the native
 * dev box had no such runner, so a migration added since the last restart stayed
 * dark until a manual psql. db-boot-migrate.applyPendingMigrationsAtBoot() runs
 * the SAME idempotent runner on host boot, in LOG-AND-CONTINUE mode so one bad
 * migration can't wedge the dev-api the whole fleet shares.
 *
 * Block 1 (runner mechanics, applyPendingMigrations directly):
 *   - applies pending files + records them; a second run is a no-op (idempotent).
 *   - continueOnError:true leaves a broken file in `failed` and KEEPS applying
 *     the rest; the default (fail-loud) THROWS instead.
 *   - the runner's raw BEGIN;…COMMIT; via .unsafe() throws on a POOLED (max>1)
 *     client — which is exactly why the boot helper uses a dedicated max:1
 *     client (regression guard for that design choice).
 * Block 2 (wired entry, applyPendingMigrationsAtBoot):
 *   - drives the runner against the resolved admin DB, applies the good files,
 *     collects the bad one in `failed`, and coord-broadcasts the failure — and
 *     never throws (boot continues).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyPendingMigrations } from '@papercusp/embedded-postgres-server';
import { BACKUP_MIGRATION_ADVISORY_LOCK_KEY } from '@papercusp/backup/application-names';
import { readBackupLockedRelationNames } from './backup-lock-migration-proof';
import { withBoundedTimeout } from './bounded-timeout';

// ── shared test-DB + mock holders ────────────────────────────────────────────
const h = vi.hoisted(() => ({
  bootUrl: '' as string,
  bootSqlDir: '' as string,
  // TS6/vitest4: `ReturnType<typeof vi.fn>` resolves to `Mock<Procedure |
  // Constructable>`, whose call signature is not directly invocable (TS2348,
  // WI-2017). This holder is BOTH called directly (line ~59) AND read via
  // `.mock.calls` / `toHaveBeenCalledTimes` (below) — a concrete function-typed
  // `Mock<...>` supports both.
  sendMessage: undefined as unknown as Mock<(...args: unknown[]) => Promise<void>>,
}));

// db-boot-migrate builds its OWN max:1 client from getHarnessAdminUrl() and
// resolves the sql dir from resolveSqlDir(); point both at the test fixtures.
vi.mock('./embedded-pg-discovery', async () => {
  const actual = await vi.importActual<typeof import('./embedded-pg-discovery')>('./embedded-pg-discovery');
  return { ...actual, getHarnessAdminUrl: () => h.bootUrl };
});
vi.mock('./migration-drift', async () => {
  const actual = await vi.importActual<typeof import('./migration-drift')>('./migration-drift');
  return { ...actual, resolveSqlDir: () => h.bootSqlDir };
});
// The failure broadcast must not actually touch coord tables (absent in the
// throwaway DB) — capture the call instead.
vi.mock('./agent-tools/coordination/messages', async () => {
  const actual = await vi.importActual<typeof import('./agent-tools/coordination/messages')>(
    './agent-tools/coordination/messages',
  );
  return { ...actual, sendMessage: (...args: unknown[]) => h.sendMessage(...args) };
});

const { applyPendingMigrationsAtBoot, applyPendingMigrationsNow, reconcileMigrationReservations } =
  await import('./db-boot-migrate');

let rootSql: postgres.Sql;
let bootClient: postgres.Sql;
let dbUrl: string;
const PRE_DESTRUCTIVE_TEST_WORKSPACE = 'ei-217072-pre-snapshot-test';
const PRIOR_WORKSPACE_ENV = process.env.PAPERCUSP_WORKSPACE_ID;

// EI-8888-adjacent (2026-07-09 host-load root-cause finding): every mkdtemp()
// below lands under the fleet-wide shared TMPDIR (/tmp/pcv — pinned by
// libs/test-config/src/vitest-config.ts) and was NEVER cleaned up. At fleet
// scale that leaked 700k+ stale directories into one dir, degrading every
// mkdir/readdir/stat that touches it (including the testcontainer start-lock
// under the same tree) and contributing to spurious integration-test
// timeouts fleet-wide. Track + remove every dir this file creates.
const createdSqlDirs: string[] = [];

/** Write a temp sql dir with the given { filename: ddl } files. */
function makeSqlDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'a1-boot-'));
  createdSqlDirs.push(dir);
  for (const [name, ddl] of Object.entries(files)) writeFileSync(join(dir, name), ddl);
  return dir;
}

/** Reserve guarded throwaway migrations the same way db:next-migration does. */
async function seedMigrationReservations(filenames: readonly string[]): Promise<void> {
  const rows = filenames.flatMap((filename) => {
    const match = /^(\d+)-/.exec(filename);
    return match
      ? [
          {
            num: Number(match[1]),
            filename,
            reserved_by: 'db-boot-migrate.integration.test.ts',
            intent: 'integration fixture reservation',
          },
        ]
      : [];
  });
  if (rows.length === 0) return;
  await rootSql`
    INSERT INTO harness_shared.migration_reservations
      ${rootSql(rows, 'num', 'filename', 'reserved_by', 'intent')}
    ON CONFLICT (num) DO NOTHING`;
}

// EI-19403856469813053: applyPendingMigrationsNow() now reads/writes a small
// cross-boot cooldown file, defaulting to a REAL path under the host's actual
// ~/.papercusp (see resolveMigrationCooldownFilePath in db-boot-migrate.ts).
// EVERY test in this file that reaches applyPendingMigrationsNow() — not just
// the dedicated cooldown describe block below — must stay off that real path,
// or a test run pollutes (and, under fleet load, RACES on) the shared host
// file every other agent's boot-migrate/green-checkpoint preflight also reads.
// A file-wide beforeEach/afterEach keeps this hermetic for every test here,
// including ones that never mention "cooldown" at all.
const hermeticCooldownFiles: string[] = [];
beforeEach(async () => {
  // Each case owns a disposable reservation/history namespace. Earlier native
  // backup cases use the same numeric range as the cooldown cases; retaining
  // their rows makes a valid fixture fail reservation admission instead of
  // exercising cooldown or the intended migration failure.
  await rootSql.unsafe('TRUNCATE harness_shared.schema_migrations, harness_shared.migration_reservations');
  const p = join(tmpdir(), `a1-boot-cooldown-default-${randomBytes(4).toString('hex')}.json`);
  hermeticCooldownFiles.push(p);
  process.env.PAPERCUSP_MIGRATION_COOLDOWN_FILE = p;
  h.sendMessage?.mockClear();
});
afterEach(() => {
  delete process.env.PAPERCUSP_MIGRATION_COOLDOWN_FILE;
  delete process.env.PAPERCUSP_MIGRATION_COOLDOWN_MS;
});

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `bm_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  dbUrl = u.toString();
  h.bootUrl = dbUrl;
  h.sendMessage = vi.fn(async () => {});

  rootSql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  // Reconciliation cases must also run independently with a name filter.
  // Earlier runner cases otherwise bootstrap this ledger as a side effect.
  await rootSql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.schema_migrations (
      filename text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  // The native boot guard checks reservation provenance for every migration
  // at or above the enforced floor. Keep the throwaway database's schema
  // faithful to the live baseline so unrelated fixture migrations reach their
  // intended assertions instead of failing on a missing ledger table.
  await rootSql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.migration_reservations (
      num integer PRIMARY KEY,
      filename text,
      reserved_by text,
      intent text,
      reserved_at timestamptz NOT NULL DEFAULT now()
    )`);
  // The snapshot-admission regression exercises the native runner against a
  // minimal but schema-faithful receipt table. The real 000-baseline creates
  // this table; this integration fixture creates only the relation needed by
  // the focused migration runner tests above it.
  await rootSql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.backup_snapshots (
      id bigint PRIMARY KEY,
      workspace_id text NOT NULL,
      kopia_snapshot_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status text NOT NULL DEFAULT 'running',
      trigger_reason text NOT NULL,
      trigger_context jsonb,
      bytes_added bigint,
      bytes_total bigint,
      sources_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      error_text text,
      db_dump_ok boolean
    )`);
  process.env.PAPERCUSP_WORKSPACE_ID = PRE_DESTRUCTIVE_TEST_WORKSPACE;
  bootClient = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
}, 90_000);

afterAll(async () => {
  if (PRIOR_WORKSPACE_ENV === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = PRIOR_WORKSPACE_ENV;
  await bootClient?.end({ timeout: 5 });
  await rootSql?.end({ timeout: 5 });
  await Promise.all(createdSqlDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(hermeticCooldownFiles.map((f) => rm(f, { force: true })));
});

describe('boot-apply runner mechanics (§A1)', () => {
  it('applies a pending migration and records it; a re-run is a no-op (idempotent)', async () => {
    const dir = makeSqlDir({ '900-boot-good.sql': 'CREATE TABLE harness_shared.boot_test_a (id int);' });

    const first = await applyPendingMigrations({ client: bootClient, sqlDir: dir, log: () => {} });
    expect(first.appliedCount).toBe(1);
    expect(first.failed).toEqual([]);

    const tracked = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations WHERE filename = '900-boot-good.sql'`;
    expect(tracked).toHaveLength(1);

    // Second run: nothing new to apply.
    const second = await applyPendingMigrations({ client: bootClient, sqlDir: dir, log: () => {} });
    expect(second.appliedCount).toBe(0);
  });

  it('continueOnError leaves a broken file pending and keeps applying the rest', async () => {
    const dir = makeSqlDir({
      '910-good.sql': 'CREATE TABLE harness_shared.boot_test_b (id int);',
      '911-bad.sql': 'CREATE TABLE no_such_schema_xyz.bad (id int);', // schema missing → fails
      '912-good.sql': 'CREATE TABLE harness_shared.boot_test_c (id int);',
    });

    const res = await applyPendingMigrations({
      client: bootClient,
      sqlDir: dir,
      continueOnError: true,
      log: () => {},
    });
    expect(res.appliedCount).toBe(2);
    expect(res.failed.map((f) => f.file)).toEqual(['911-bad.sql']);

    // The two good ones are recorded; the bad one is NOT (so it retries next boot).
    const rows = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations
       WHERE filename IN ('910-good.sql','911-bad.sql','912-good.sql') ORDER BY filename`;
    expect(rows.map((r) => r.filename)).toEqual(['910-good.sql', '912-good.sql']);
  });

  it('retries an idempotent statement-breakpoint migration after an earlier chunk committed', async () => {
    const filename = '913-breakpoint-retry.sql';
    const dir = makeSqlDir({
      [filename]: [
        'CREATE TABLE IF NOT EXISTS harness_shared.boot_breakpoint_a (id int);',
        '--> statement-breakpoint',
        'CREATE TABLE no_such_schema_xyz.breakpoint_b (id int);',
      ].join('\n'),
    });

    const first = await applyPendingMigrations({
      client: bootClient,
      sqlDir: dir,
      continueOnError: true,
      log: () => {},
    });
    expect(first.appliedCount).toBe(0);
    expect(first.failed.map((failure) => failure.file)).toEqual([filename]);
    const afterFailure = await rootSql<{ first_chunk: string | null; recorded: boolean }[]>`
      SELECT to_regclass('harness_shared.boot_breakpoint_a')::text AS first_chunk,
             EXISTS (
               SELECT 1 FROM harness_shared.schema_migrations WHERE filename = ${filename}
             ) AS recorded`;
    expect(afterFailure[0]).toEqual({
      first_chunk: 'harness_shared.boot_breakpoint_a',
      recorded: false,
    });

    writeFileSync(
      join(dir, filename),
      [
        'CREATE TABLE IF NOT EXISTS harness_shared.boot_breakpoint_a (id int);',
        '--> statement-breakpoint',
        'CREATE TABLE IF NOT EXISTS harness_shared.boot_breakpoint_b (id int);',
      ].join('\n'),
    );
    const second = await applyPendingMigrations({ client: bootClient, sqlDir: dir, log: () => {} });
    expect(second).toMatchObject({ appliedCount: 1, failed: [] });
    const afterRetry = await rootSql<{ second_chunk: string | null; recorded: boolean }[]>`
      SELECT to_regclass('harness_shared.boot_breakpoint_b')::text AS second_chunk,
             EXISTS (
               SELECT 1 FROM harness_shared.schema_migrations WHERE filename = ${filename}
             ) AS recorded`;
    expect(afterRetry[0]).toEqual({
      second_chunk: 'harness_shared.boot_breakpoint_b',
      recorded: true,
    });
  });

  it('the DEFAULT (fail-loud) runner THROWS on a broken migration', async () => {
    const dir = makeSqlDir({ '920-bad.sql': 'CREATE TABLE no_such_schema_xyz.bad2 (id int);' });
    await expect(applyPendingMigrations({ client: bootClient, sqlDir: dir, log: () => {} })).rejects.toThrow();
  });

  it('a POOLED (max>1) client rejects the raw BEGIN;…COMMIT; — why boot uses max:1', async () => {
    const pooled = postgres(dbUrl, { max: 2, onnotice: () => {} });
    try {
      const dir = makeSqlDir({ '930-good.sql': 'CREATE TABLE harness_shared.boot_test_d (id int);' });
      await expect(applyPendingMigrations({ client: pooled, sqlDir: dir, log: () => {} })).rejects.toThrow(/unsafe/i);
    } finally {
      await pooled.end({ timeout: 5 });
    }
  });

  it('when nothing is pending, issues no DDL beyond the idempotent schema_migrations bootstrap (EI-19403856469813053)', async () => {
    // Regression guard for the ORIGINAL (incorrect) candidate root cause in
    // EI-19403856469813053: "boot-migrate takes an ACCESS EXCLUSIVE lock with
    // nothing to apply". It does not — this asserts exactly that, so a future
    // change that adds an unconditional preflight DDL touching a real table
    // (rather than the two idempotent, harmless-when-already-applied
    // CREATE-IF-NOT-EXISTS statements below) fails this test instead of
    // silently reintroducing a fleet-wide stall on every boot. The REAL root
    // cause — a pending, genuinely-broken migration retried (and re-locking)
    // on every boot — is covered by db-boot-migrate.integration.test.ts's own
    // cross-boot cooldown tests, not here.
    const dir = makeSqlDir({}); // nothing pending at all
    const calls: string[] = [];
    const spyClient = {
      unsafe: (sql: string, ...rest: unknown[]) => {
        calls.push(sql);
        return (bootClient as unknown as { unsafe: (...a: unknown[]) => unknown }).unsafe(sql, ...rest);
      },
    };

    const res = await applyPendingMigrations({ client: spyClient, sqlDir: dir, log: () => {} });
    expect(res.appliedCount).toBe(0);
    expect(res.failed).toEqual([]);
    // Only the idempotent schema_migrations bootstrap + the applied-set SELECT
    // ran — no ALTER/CREATE touches ANY other relation, so no concurrent reader
    // of work_items (or any other table) could ever be blocked by this call.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/CREATE TABLE IF NOT EXISTS harness_shared\.schema_migrations/);
    expect(calls[1]).toMatch(/^SELECT filename FROM harness_shared\.schema_migrations/);
  });
});

describe('applyPendingMigrationsAtBoot wired entry (§A1)', () => {
  it('refuses a gate-lint violation before SQL reaches Postgres or the migration ledger', async () => {
    const filename = '998-gate-lint-violation.sql';
    const candidateSqlDir = makeSqlDir({
      [filename]: 'BEGIN;\nCREATE TABLE harness_shared.must_not_apply (id int);\nCOMMIT;',
    });
    await seedMigrationReservations([filename]);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof applyPendingMigrationsNow>>;
    try {
      result = await applyPendingMigrationsNow({ sqlDir: candidateSqlDir });
    } finally {
      errSpy.mockRestore();
    }

    expect(result).toMatchObject({
      applied: 0,
      failed: [{ file: filename, error: expect.stringContaining('top-level transaction control') }],
    });
    const ledger = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations WHERE filename = ${filename}`;
    expect(ledger).toEqual([]);
    const relation = await rootSql<{ name: string | null }[]>`
      SELECT to_regclass('harness_shared.must_not_apply')::text AS name`;
    expect(relation[0]?.name).toBeNull();
  });

  it('applyPendingMigrationsNow honors an explicit candidate sqlDir over ambient resolution', async () => {
    h.bootSqlDir = makeSqlDir({});
    const candidateSqlDir = makeSqlDir({
      '954-candidate-exact.sql': 'CREATE TABLE harness_shared.boot_candidate_exact (id int);',
    });
    await seedMigrationReservations(['954-candidate-exact.sql']);

    const result = await applyPendingMigrationsNow({ sqlDir: candidateSqlDir });

    expect(result).toMatchObject({ applied: 1, failed: [] });
    const rows = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations
       WHERE filename = '954-candidate-exact.sql'`;
    expect(rows.map((r) => r.filename)).toEqual(['954-candidate-exact.sql']);
  });

  it('retains ordered migration preflight progress through actual client cleanup', async () => {
    h.bootSqlDir = makeSqlDir({ '956-preflight-phases.sql': 'CREATE TABLE harness_shared.boot_preflight_phases (id int);' });
    await seedMigrationReservations(['956-preflight-phases.sql']);
    const progress = vi.spyOn(console, 'info').mockImplementation(() => {});
    let lines: string[] = [];
    try {
      const result = await applyPendingMigrationsNow({ broadcast: false });
      expect(result?.failed).toEqual([]);
      expect((await bootClient`SELECT to_regclass('harness_shared.boot_preflight_phases') AS relation`)[0].relation).toBeTruthy();
      lines = progress.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('[boot-migrate] preflight phase='));
    } finally { progress.mockRestore(); }
    const phases = lines.map(line => line.match(/phase=(.*?) elapsedMs=/)?.[1]);
    expect(phases).toEqual(['read cooldown', 'backup rendezvous', 'apply pending migrations', 'reconcile reservations',
      'schema drift diagnostics', 'complete', 'close client', 'client closed']);
    const times = lines.map(line => Number(line.match(/elapsedMs=(\d+)$/)?.[1]));
    expect(times.every((time, i) => Number.isFinite(time) && time >= 0 && (i === 0 || time >= times[i - 1]))).toBe(true);
  });

  it('applies pending files, collects the broken one in failed, broadcasts, and does not throw', async () => {
    // The wired entry resolves resolveSqlDir() → this dir and builds its own
    // max:1 client from getHarnessAdminUrl() → the test DB (both mocked above).
    h.bootSqlDir = makeSqlDir({
      '950-good.sql': 'CREATE TABLE harness_shared.boot_wired_a (id int);',
      '951-bad.sql': 'CREATE TABLE no_such_schema_xyz.wired_bad (id int);',
      '952-good.sql': 'CREATE TABLE harness_shared.boot_wired_b (id int);',
    });
    await seedMigrationReservations(['950-good.sql', '951-bad.sql', '952-good.sql']);

    // The helper intentionally console.error()s the failure (the loud, non-fatal
    // surface for a dark migration); suppress it so vitest-fail-on-console
    // doesn't trip, and assert it actually fired.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof applyPendingMigrationsAtBoot>>;
    let errCalls = 0;
    try {
      result = await applyPendingMigrationsAtBoot();
      errCalls = errSpy.mock.calls.length; // capture before mockRestore clears it
    } finally {
      errSpy.mockRestore();
    }
    expect(errCalls).toBeGreaterThan(0);
    expect(result).not.toBeNull();
    expect(result!.applied).toBe(2);
    expect(result!.failed.map((f) => f.file)).toEqual(['951-bad.sql']);

    // The failure was coord-broadcast (ambient) so peers see the dark migration.
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [, payload] = h.sendMessage.mock.calls[0] as [unknown, { summary: string }];
    expect(payload.summary).toMatch(/failed to apply/i);

    // The two good wired migrations actually landed.
    const rows = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations
       WHERE filename IN ('950-good.sql','951-bad.sql','952-good.sql') ORDER BY filename`;
    expect(rows.map((r) => r.filename)).toEqual(['950-good.sql', '952-good.sql']);
  });

  it('broadcast:false still reports the failure but sends no coord broadcast (WI-10002822 retry loop)', async () => {
    // The bg-host gate retry re-checks every minute while withheld; with the
    // default broadcast every tick would re-post the same failure to every inbox.
    const dir = makeSqlDir({ '956-quiet-bad.sql': 'CREATE TABLE no_such_schema_xyz.quiet_bad (id int);' });
    await seedMigrationReservations(['956-quiet-bad.sql']);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof applyPendingMigrationsNow>>;
    let errCalls = 0;
    try {
      result = await applyPendingMigrationsNow({ sqlDir: dir, broadcast: false });
      errCalls = errSpy.mock.calls.length;
    } finally {
      errSpy.mockRestore();
    }
    expect(errCalls).toBeGreaterThan(0); // still loud in the host log
    expect(result).not.toBeNull();
    expect(result!.failed.map((f) => f.file)).toEqual(['956-quiet-bad.sql']);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe('native boot migration/backup rendezvous (EI-21443484375613585)', () => {
  it('boots without waiting when a new backup starts after target preflight applied its migrations', async () => {
    const filename = '957-staging-pre-cutover.sql';
    const dir = makeSqlDir({ [filename]: 'CREATE TABLE harness_shared.staging_pre_cutover (id int);' });
    await seedMigrationReservations([filename]);
    expect(await applyPendingMigrationsNow({ sqlDir: dir, broadcast: false }))
      .toMatchObject({ applied: 1, failed: [] });
    const holder = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await holder`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
      const boot = await Promise.race([
        applyPendingMigrationsNow({ sqlDir: dir, broadcast: false }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('late backup blocked prepared target boot')), 5_000);
        }),
      ]);
      expect(boot).toMatchObject({ applied: 0, failed: [] });
      // This observer must still be unable to acquire the held lock: success
      // above happened before backup release, not just shortly after it.
      expect(await rootSql`SELECT pg_try_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY})) AS acquired`)
        .toEqual([{ acquired: false }]);
    } finally {
      if (timer) clearTimeout(timer);
      await holder`SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
      await holder.end({ timeout: 5 });
    }
  });

  it('does not keep a request-only host dark behind a backup when no migration is pending', async () => {
    const filename = '956-native-boot-already-applied.sql';
    const dir = makeSqlDir({
      [filename]: 'CREATE TABLE harness_shared.must_not_run_unlocked (id int);',
    });
    await rootSql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        sha256 text NOT NULL
      )`);
    await rootSql`
      INSERT INTO harness_shared.schema_migrations (filename, sha256)
      VALUES (${filename}, 'already-applied-fixture')
      ON CONFLICT (filename) DO NOTHING`;
    await seedMigrationReservations([filename]);

    const holder = postgres(dbUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: 'pcbackup-workspace' },
    });
    let lockReleased = false;
    try {
      await holder`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;

      // The result must settle WHILE the backup still owns the lock. A timing
      // assertion alone would be ambiguous; successful settlement before the
      // finally-block unlock proves this call never entered pg_advisory_lock.
      const result = await Promise.race([
        applyPendingMigrationsNow({ sqlDir: dir }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('no-pending boot waited behind backup lock')), 5_000),
        ),
      ]);
      expect(result).toMatchObject({ applied: 0, failed: [] });

      const holderStillOwnsLock = await rootSql<{ held: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
            FROM pg_locks
           WHERE locktype = 'advisory'
             AND pid = (SELECT pid FROM pg_stat_activity
                         WHERE datname = current_database()
                           AND application_name = 'pcbackup-workspace'
                         ORDER BY backend_start DESC LIMIT 1)
             AND granted
        ) AS held`;
      expect(holderStillOwnsLock).toEqual([{ held: true }]);
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`.catch(() => {});
      lockReleased = true;
      await holder.end({ timeout: 5 });
    }
    expect(lockReleased).toBe(true);
  });

  it('closes the timed-out migration backend without releasing the backup lock or applying its migration', async () => {
    const filename = '959-native-boot-timeout-cancel.sql';
    const relation = 'boot_native_timeout_cancel_target';
    await rootSql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.${relation} (id int)`);
    const dir = makeSqlDir({
      [filename]: `ALTER TABLE harness_shared.${relation} ADD COLUMN timeout_note text;`,
    });
    await seedMigrationReservations([filename]);

    const backupApp = 'pcbackup-workspace';
    const holder = postgres(dbUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: backupApp },
    });
    const dump = await holder.reserve();
    const bootLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let boundedAttempt: Promise<unknown> | undefined;
    try {
      await dump`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
      await dump`BEGIN`;
      await dump`LOCK TABLE harness_shared.boot_native_timeout_cancel_target IN ACCESS SHARE MODE`;

      const attempt = withBoundedTimeout(
        (signal) => applyPendingMigrationsNow({ sqlDir: dir, broadcast: false, signal }),
        { fallback: null, timeoutMs: 5_000, label: 'boot migration cancellation regression' },
      );
      boundedAttempt = attempt;

      const waitLine = `waiting for backup migration rendezvous; pending migrations: ${filename}`;
      const startDeadline = Date.now() + 4_000;
      let backendSeenWaiting = false;
      while (!backendSeenWaiting && Date.now() < startDeadline) {
        const backends = await rootSql<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = 'papercusp-boot-migrate'`;
        const loggedWait = bootLog.mock.calls.some((call) => String(call[0]).includes(waitLine));
        backendSeenWaiting = backends.length === 1 && loggedWait;
        if (!backendSeenWaiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(backendSeenWaiting, 'the migration backend must be observed waiting before its deadline').toBe(true);

      const timeout = await attempt;
      expect(timeout).toMatchObject({ value: null, degraded: true, reason: 'timeout' });
      expect(warnLog.mock.calls.some(([line]) =>
        String(line).includes('preflight cancelled during backup rendezvous'),
      )).toBe(true);

      const closeDeadline = Date.now() + 5_000;
      let backendClosed = false;
      while (!backendClosed && Date.now() < closeDeadline) {
        const backends = await rootSql<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = 'papercusp-boot-migrate'`;
        backendClosed = backends.length === 0;
        if (!backendClosed) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(backendClosed, 'timeout must close the abandoned postgres-js backend').toBe(true);

      const backupLock = await rootSql<{ held: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.granted AND a.application_name = ${backupApp}
        ) AS held`;
      expect(backupLock).toEqual([{ held: true }]);

      const migrationState = await rootSql<{ recorded: boolean; columnPresent: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM harness_shared.schema_migrations WHERE filename = ${filename}
        ) AS recorded,
        EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'harness_shared' AND table_name = ${relation}
             AND column_name = 'timeout_note'
        ) AS "columnPresent"`;
      expect(migrationState).toEqual([{ recorded: false, columnPresent: false }]);
    } finally {
      // Let the bounded timeout fire before dropping the backup barriers, then
      // clean up a leaked backend so a failing regression cannot apply its
      // fixture after the assertion has finished.
      await boundedAttempt?.catch(() => {});
      await rootSql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'papercusp-boot-migrate'`;
      await dump`ROLLBACK`.catch(() => {});
      await dump`SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`.catch(() => {});
      dump.release();
      await holder.end({ timeout: 5 });
      bootLog.mockRestore();
      warnLog.mockRestore();
      errorLog.mockRestore();
    }
  });

  // WI-10003357: the wait is relation-scoped. Boot waits while the backup
  // holds a relation the pending migration names, and resumes as soon as the
  // dump stops holding it — even though the rendezvous itself is still held
  // (the 99 GiB transcript tier keeps it for ~20 min after the state tier).
  it('waits while the backup locks a relation the migration names, then resumes with the rendezvous still held', async () => {
    const filename = '955-native-boot-backup-lock.sql';
    await rootSql.unsafe('CREATE TABLE IF NOT EXISTS harness_shared.boot_native_backup_target (id int)');
    const dir = makeSqlDir({
      [filename]: 'ALTER TABLE harness_shared.boot_native_backup_target ADD COLUMN note text;',
    });
    await seedMigrationReservations([filename]);
    await rootSql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        sha256 text NOT NULL
      )`);

    const holder = postgres(dbUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: 'pcbackup-workspace' },
    });
    const dump = await holder.reserve();
    let boot: Promise<Awaited<ReturnType<typeof applyPendingMigrationsNow>>> | undefined;
    let lockReleased = false;
    const bootLog = vi.spyOn(console, 'log');
    try {
      await dump`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
      await dump`BEGIN`;
      await dump`LOCK TABLE harness_shared.boot_native_backup_target IN ACCESS SHARE MODE`;
      h.bootSqlDir = dir;
      boot = applyPendingMigrationsNow();

      const waitingLine = `waiting for backup migration rendezvous; pending migrations: ${filename}`;
      const deadline = Date.now() + 10_000;
      const logged = () => bootLog.mock.calls.some((call) => String(call[0]).includes(waitingLine));
      while (!logged() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      // The HTTP listener cannot start until this wait settles. Its boot log
      // must identify the barrier, the pending file and the locked relation.
      expect(bootLog).toHaveBeenCalledWith(expect.stringContaining(waitingLine));
      expect(bootLog).toHaveBeenCalledWith(
        expect.stringContaining(`${filename} names backup-locked relation boot_native_backup_target`),
      );
      const beforeRelease = await rootSql<{ filename: string }[]>`
        SELECT filename FROM harness_shared.schema_migrations WHERE filename = ${filename}`;
      expect(beforeRelease).toEqual([]);

      // The dump moves on (state tier done): the relation lock goes, the
      // rendezvous stays held for the rest of the backup.
      await dump`COMMIT`;
      const result = await boot;
      expect(result).not.toBeNull();
      expect(result!.applied).toBe(1);
      expect(result!.failed).toEqual([]);
      expect(bootLog).toHaveBeenCalledWith(expect.stringContaining('name no relation the backup holds'));
      const stillHeld = await rootSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory' AND l.granted AND a.application_name = 'pcbackup-workspace'`;
      expect(stillHeld[0].n).toBe(1);

      const afterRelease = await rootSql<{ filename: string }[]>`
        SELECT filename FROM harness_shared.schema_migrations WHERE filename = ${filename}`;
      expect(afterRelease).toEqual([{ filename }]);
      await dump`SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
      lockReleased = true;
    } finally {
      if (!lockReleased) {
        await dump`ROLLBACK`.catch(() => {});
        await dump`SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`.catch(() => {});
      }
      // If an assertion fails while boot is blocked, release the holder and
      // settle the boot promise before closing the test connection.
      await boot?.catch(() => {});
      dump.release();
      await holder.end({ timeout: 5 });
      bootLog.mockRestore();
    }
  });

  it('applies immediately when the backup locks only relations the migration does not name', async () => {
    const filename = '958-native-boot-backup-unrelated.sql';
    await rootSql.unsafe('CREATE TABLE IF NOT EXISTS harness_shared.boot_native_backup_transcript (id int)');
    const dir = makeSqlDir({ [filename]: 'CREATE TABLE harness_shared.boot_native_backup_fresh (id int);' });
    await seedMigrationReservations([filename]);
    const holder = postgres(dbUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: 'pcbackup' },
    });
    const dump = await holder.reserve();
    const bootLog = vi.spyOn(console, 'log');
    try {
      await dump`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
      await dump`BEGIN`;
      await dump`LOCK TABLE harness_shared.boot_native_backup_transcript IN ACCESS SHARE MODE`;
      h.bootSqlDir = dir;
      const result = await applyPendingMigrationsNow();
      expect(result!.applied).toBe(1);
      expect(result!.failed).toEqual([]);
      expect(bootLog.mock.calls.some((call) => String(call[0]).includes('waiting for backup migration rendezvous'))).toBe(false);
    } finally {
      await dump`ROLLBACK`.catch(() => {});
      await dump`SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`.catch(() => {});
      dump.release();
      await holder.end({ timeout: 5 });
      bootLog.mockRestore();
    }
  });

  it('expands backup-locked relations with partition ancestors and index names', async () => {
    await rootSql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.boot_backup_parent (id int, k int) PARTITION BY LIST (k);
      CREATE TABLE IF NOT EXISTS harness_shared.boot_backup_child PARTITION OF harness_shared.boot_backup_parent FOR VALUES IN (1);
      CREATE INDEX IF NOT EXISTS boot_backup_child_id_idx ON harness_shared.boot_backup_child (id);`);
    const holder = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'pcbackup' } });
    const dump = await holder.reserve();
    try {
      await dump`BEGIN`;
      await dump`LOCK TABLE ONLY harness_shared.boot_backup_child IN ACCESS SHARE MODE`;
      const names = await readBackupLockedRelationNames(rootSql);
      expect(names).toEqual(expect.arrayContaining(['boot_backup_child', 'boot_backup_parent', 'boot_backup_child_id_idx']));
    } finally {
      await dump`ROLLBACK`.catch(() => {});
      dump.release();
      await holder.end({ timeout: 5 });
    }
  });

  it.each([
    ['INSERT', '', 960],
    ['UPDATE OF id', 'WHEN (NEW.id = 1)', 961],
    ['INSERT OR UPDATE OF id', 'WHEN (NEW.id = 1)', 962],
  ])('applies a static %s trigger migration while the backup rendezvous remains held on an unrelated table', async (event, predicate, number) => {
    const filename = `${number}-native-boot-backup-static-trigger.sql`;
    const target = `boot_static_trigger_target_${number}`;
    const transcript = `boot_static_trigger_transcript_${number}`;
    const action = `boot_static_trigger_action_${number}`;
    const trigger = `boot_static_trigger_${number}`;
    await rootSql.unsafe(`
      CREATE TABLE harness_shared.${target} (id int);
      CREATE TABLE harness_shared.${transcript} (id int);
      CREATE FUNCTION harness_shared.${action}() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`);
    const dir = makeSqlDir({
      [filename]: `CREATE TRIGGER ${trigger}
        AFTER ${event} ON harness_shared.${target}
        FOR EACH ROW ${predicate} EXECUTE FUNCTION harness_shared.${action}();`,
    });
    await seedMigrationReservations([filename]);
    const holder = postgres(dbUrl, {
      max: 1, prepare: false, onnotice: () => {},
      connection: { application_name: 'pcbackup-workspace' },
    });
    const dump = await holder.reserve();
    try {
      await dump`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
      await dump`BEGIN`;
      await dump.unsafe(`LOCK TABLE harness_shared.${transcript} IN ACCESS SHARE MODE`);
      const result = await withBoundedTimeout(
        (signal) => applyPendingMigrationsNow({ sqlDir: dir, broadcast: false, signal }),
        { fallback: null, timeoutMs: 5_000, label: 'static trigger backup rendezvous regression' },
      );
      expect(result.degraded).toBe(false);
      expect(result.value).toMatchObject({ applied: 1, failed: [] });
      const observed = await rootSql<{ created: boolean; backupStillHeld: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = ${trigger}
        ) AS created,
        EXISTS (
          SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.granted AND a.application_name = 'pcbackup-workspace'
        ) AS "backupStillHeld"`;
      expect(observed).toEqual([{ created: true, backupStillHeld: true }]);
    } finally {
      await dump`ROLLBACK`.catch(() => {});
      await dump`SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`.catch(() => {});
      dump.release();
      await holder.end({ timeout: 5 });
    }
  });
});

describe('native boot pre-destructive snapshot admission (EI-217072)', () => {
  async function withSuppressedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  }

  beforeEach(async () => {
    await rootSql`
      DELETE FROM harness_shared.backup_snapshots
       WHERE workspace_id = ${PRE_DESTRUCTIVE_TEST_WORKSPACE}`;
  });

  it('leaves a post-1006 migration pending when no completed pre-destructive receipt exists', async () => {
    const filename = '1016-ei-217072-no-receipt.sql';
    const dir = makeSqlDir({
      [filename]: 'CREATE TABLE harness_shared.ei_217072_no_receipt (id int);',
    });
    await seedMigrationReservations([filename]);

    const result = await withSuppressedConsoleError(() => applyPendingMigrationsNow({ sqlDir: dir }));

    expect(result).toMatchObject({
      applied: 0,
      failed: [{ file: filename, error: expect.stringContaining('pre-destructive snapshot admission failed') }],
    });
    const ledger = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations WHERE filename = ${filename}`;
    expect(ledger).toEqual([]);
    const relation = await rootSql<{ name: string | null }[]>`
      SELECT to_regclass('harness_shared.ei_217072_no_receipt')::text AS name`;
    expect(relation[0]?.name).toBeNull();
  });

  it('does not let an older completed receipt mask a newer running receipt', async () => {
    const filename = '1017-ei-217072-newest-running.sql';
    const dir = makeSqlDir({
      [filename]: 'CREATE TABLE harness_shared.ei_217072_newest_running (id int);',
    });
    await seedMigrationReservations([filename]);
    await rootSql`
      INSERT INTO harness_shared.backup_snapshots
        (id, workspace_id, trigger_reason, status, started_at, finished_at, kopia_snapshot_id, db_dump_ok)
      VALUES
        (101, ${PRE_DESTRUCTIVE_TEST_WORKSPACE}, 'pre_destructive', 'ok',
          '2026-08-30T05:00:00Z', '2026-08-30T05:01:00Z', 'kopia-good', true),
        (102, ${PRE_DESTRUCTIVE_TEST_WORKSPACE}, 'pre_destructive', 'running',
          '2026-08-30T05:02:00Z', NULL, NULL, NULL)`;

    const result = await withSuppressedConsoleError(() => applyPendingMigrationsNow({ sqlDir: dir }));

    expect(result).toMatchObject({
      applied: 0,
      failed: [{ file: filename, error: expect.stringContaining('pre-destructive snapshot admission failed') }],
    });
    const relation = await rootSql<{ name: string | null }[]>`
      SELECT to_regclass('harness_shared.ei_217072_newest_running')::text AS name`;
    expect(relation[0]?.name).toBeNull();
  });

  // EI-21968380816102718: the refusal must name the receipt it judged, so the
  // next agent goes straight to the cause instead of a bare "not completed".
  it('names the newest receipt (id, status, error) when it refuses, and says so when none exists', async () => {
    const failedFile = '1019-ei-21968-names-receipt.sql';
    const noneFile = '1020-ei-21968-no-receipt-named.sql';
    const failedDir = makeSqlDir({
      [failedFile]: 'CREATE TABLE harness_shared.ei_21968_names_receipt (id int);',
    });
    await seedMigrationReservations([failedFile, noneFile]);

    const noneDir = makeSqlDir({
      [noneFile]: 'CREATE TABLE harness_shared.ei_21968_no_receipt_named (id int);',
    });
    const none = await withSuppressedConsoleError(() => applyPendingMigrationsNow({ sqlDir: noneDir }));
    expect(none).toMatchObject({
      applied: 0,
      failed: [{ file: noneFile, error: expect.stringContaining('latest pre_destructive receipt: none recorded') }],
    });

    await rootSql`
      INSERT INTO harness_shared.backup_snapshots
        (id, workspace_id, trigger_reason, status, started_at, finished_at, kopia_snapshot_id, db_dump_ok, error_text)
      VALUES
        (104, ${PRE_DESTRUCTIVE_TEST_WORKSPACE}, 'pre_destructive', 'failed',
          '2026-09-23T18:53:15Z', '2026-09-23T20:10:15Z', NULL, NULL,
          'orphan-sweep: status=''running'' for >60min')`;

    const result = await withSuppressedConsoleError(() => applyPendingMigrationsNow({ sqlDir: failedDir }));

    expect(result).toMatchObject({ applied: 0 });
    const error = String(result?.failed[0]?.error);
    expect(error).toContain('pre-destructive snapshot admission failed');
    expect(error).toContain('id=104 status=failed');
    expect(error).toContain('kopia_snapshot=none db_dump_ok=null');
    expect(error).toContain("error=orphan-sweep: status='running' for >60min");
    const relation = await rootSql<{ name: string | null }[]>`
      SELECT to_regclass('harness_shared.ei_21968_names_receipt')::text AS name`;
    expect(relation[0]?.name).toBeNull();
  });

  it('applies a post-1006 migration once the newest receipt is complete and database-backed', async () => {
    const filename = '1018-ei-217072-complete.sql';
    const dir = makeSqlDir({
      [filename]: 'CREATE TABLE harness_shared.ei_217072_complete (id int);',
    });
    await seedMigrationReservations([filename]);
    await rootSql`
      INSERT INTO harness_shared.backup_snapshots
        (id, workspace_id, trigger_reason, status, started_at, finished_at, kopia_snapshot_id, db_dump_ok)
      VALUES
        (103, ${PRE_DESTRUCTIVE_TEST_WORKSPACE}, 'pre_destructive', 'ok',
          '2026-08-30T05:03:00Z', '2026-08-30T05:04:00Z', 'kopia-complete', true)`;

    const result = await applyPendingMigrationsNow({ sqlDir: dir });

    expect(result).toMatchObject({ applied: 1, failed: [] });
    const ledger = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations WHERE filename = ${filename}`;
    expect(ledger).toEqual([{ filename }]);
    const relation = await rootSql<{ name: string | null }[]>`
      SELECT to_regclass('harness_shared.ei_217072_complete')::text AS name`;
    expect(relation[0]?.name).toBe('harness_shared.ei_217072_complete');
  });
});

// EI-19403856469813053: the REAL root cause behind "boot-migrate takes an
// ACCESS EXCLUSIVE lock" — a pending migration that keeps genuinely FAILING
// (not the "nothing pending" false candidate the runner-mechanics test above
// falsifies) gets re-attempted, and re-locks its target table, on literally
// every applyPendingMigrationsNow() call (every operator boot AND every
// green-checkpoint/checkpoint-run preflight — see checkpoint-run.ts). These
// tests cover the cross-boot cooldown that stops that amplification.
describe('boot-apply cross-boot failure cooldown (EI-19403856469813053)', () => {
  const cooldownFiles: string[] = [];

  function freshCooldownFile(): string {
    const p = join(tmpdir(), `a1-boot-cooldown-${randomBytes(6).toString('hex')}.json`);
    cooldownFiles.push(p);
    return p;
  }

  /** Every assertion path below produces a `failed.length > 0` boot-migrate
   *  console.error (the existing loud non-fatal surface) — suppress it the
   *  same way the wired-entry test above does, so vitest-fail-on-console
   *  doesn't trip on an EXPECTED failure log. */
  async function withSuppressedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  }

  // (The file-wide beforeEach/afterEach above already resets
  // PAPERCUSP_MIGRATION_COOLDOWN_FILE/_MS between every test in this file —
  // no per-block reset needed here.)
  afterAll(async () => {
    await Promise.all(cooldownFiles.map((f) => rm(f, { force: true })));
  });

  it('a genuinely-broken pending migration is SKIPPED (not re-attempted) on the next call within the cooldown window', async () => {
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_FILE = freshCooldownFile();
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_MS = String(60_000); // long — this test doesn't wait for expiry
    h.bootSqlDir = makeSqlDir({
      '960-broken.sql': 'CREATE TABLE no_such_schema_xyz.cooldown_bad (id int);',
    });
    await seedMigrationReservations(['960-broken.sql']);

    const first = await withSuppressedConsoleError(() => applyPendingMigrationsNow());
    expect(first).not.toBeNull();
    expect(first!.failed.map((f) => f.file)).toEqual(['960-broken.sql']);
    expect(first!.failed[0].error).not.toMatch(/cooling down/i);

    // Same broken file still pending: the SECOND call must SKIP it (cooling
    // down) rather than re-attempt the DDL — the whole point of this fix.
    const second = await withSuppressedConsoleError(() => applyPendingMigrationsNow());
    expect(second).not.toBeNull();
    expect(second!.failed.map((f) => f.file)).toEqual(['960-broken.sql']);
    expect(second!.failed[0].error).toMatch(/cooling down/i);
  });

  it('cooldown is per-file: a good migration alongside a cooling-down broken one still applies', async () => {
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_FILE = freshCooldownFile();
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_MS = String(60_000);
    const dir = makeSqlDir({
      '961-broken.sql': 'CREATE TABLE no_such_schema_xyz.cooldown_bad2 (id int);',
    });
    await seedMigrationReservations(['961-broken.sql', '962-good.sql']);
    const reserved = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.migration_reservations WHERE num IN (961, 962) ORDER BY num`;
    expect(reserved.map((row) => row.filename)).toEqual(['961-broken.sql', '962-good.sql']);
    h.bootSqlDir = dir;
    const first = await withSuppressedConsoleError(() => applyPendingMigrationsNow());
    expect(first!.failed.map((f) => f.file)).toEqual(['961-broken.sql']);

    // A NEW good file lands in the same dir alongside the still-broken one
    // (mirrors a peer's unrelated migration landing while this one is stuck).
    writeFileSync(join(dir, '962-good.sql'), 'CREATE TABLE harness_shared.boot_cooldown_good (id int);');
    const second = await withSuppressedConsoleError(() => applyPendingMigrationsNow());
    expect(second!.applied).toBe(1); // the good one applied despite the cooldown
    expect(second!.failed.map((f) => f.file)).toEqual(['961-broken.sql']); // still reported pending
    expect(second!.failed[0].error).toMatch(/cooling down/i);

    const rows = await rootSql<{ filename: string }[]>`
      SELECT filename FROM harness_shared.schema_migrations WHERE filename = '962-good.sql'`;
    expect(rows).toHaveLength(1);
  });

  it('the cooldown EXPIRES: the broken migration is genuinely re-attempted once it elapses', async () => {
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_FILE = freshCooldownFile();
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_MS = String(50); // tiny — expires almost immediately
    h.bootSqlDir = makeSqlDir({
      '963-broken.sql': 'CREATE TABLE no_such_schema_xyz.cooldown_bad3 (id int);',
    });
    await seedMigrationReservations(['963-broken.sql']);
    const first = await withSuppressedConsoleError(() => applyPendingMigrationsNow());
    expect(first!.failed[0].error).not.toMatch(/cooling down/i);

    await new Promise((resolve) => setTimeout(resolve, 150)); // outlast the 50ms cooldown

    const second = await withSuppressedConsoleError(() => applyPendingMigrationsNow());
    expect(second!.failed.map((f) => f.file)).toEqual(['963-broken.sql']);
    // Re-attempted for real (the runner's own error), not skipped as cooling down.
    expect(second!.failed[0].error).not.toMatch(/cooling down/i);
  });

  it('once retried-and-fixed after cooldown expiry, the cooldown entry is cleared — no stale skip lingers', async () => {
    const cooldownFile = freshCooldownFile();
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_FILE = cooldownFile;
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_MS = String(50);
    const dir = makeSqlDir({
      '964-temp-broken.sql': 'CREATE TABLE no_such_schema_xyz.cooldown_bad4 (id int);',
    });
    await seedMigrationReservations(['964-temp-broken.sql']);
    h.bootSqlDir = dir;
    const first = await withSuppressedConsoleError(() => applyPendingMigrationsNow());
    expect(first!.failed.map((f) => f.file)).toEqual(['964-temp-broken.sql']);

    // "Fix" the migration in place (same filename, corrected DDL) — mirrors an
    // agent editing the SQL file before it has ever been recorded as applied.
    writeFileSync(join(dir, '964-temp-broken.sql'), 'CREATE TABLE harness_shared.boot_cooldown_fixed (id int);');
    await new Promise((resolve) => setTimeout(resolve, 150)); // outlast the 50ms cooldown

    const second = await applyPendingMigrationsNow(); // no failure expected — nothing to suppress
    expect(second!.applied).toBe(1);
    expect(second!.failed).toEqual([]);

    const raw = await readFile(cooldownFile, 'utf8').catch(() => '{}');
    const state = JSON.parse(raw) as Record<string, unknown>;
    expect(state['964-temp-broken.sql']).toBeUndefined();
  });

  it('an externally applied migration clears its stale cooldown immediately instead of blocking the next boot', async () => {
    const cooldownFile = freshCooldownFile();
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_FILE = cooldownFile;
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_MS = String(60_000);
    const filename = '965-external-apply.sql';
    h.bootSqlDir = makeSqlDir({
      [filename]: 'CREATE TABLE no_such_schema_xyz.cooldown_external (id int);',
    });
    await seedMigrationReservations([filename]);

    const first = await withSuppressedConsoleError(() => applyPendingMigrationsNow());
    expect(first!.failed.map((f) => f.file)).toEqual([filename]);

    // Mirrors coordinated db:migrate repairing the pending file while boot's
    // cross-process cooldown still remembers the earlier failure.
    await rootSql`
      INSERT INTO harness_shared.schema_migrations (filename, sha256)
      VALUES (${filename}, ${'0'.repeat(64)})`;

    const second = await applyPendingMigrationsNow();
    expect(second).toMatchObject({ applied: 0, failed: [] });
    const raw = await readFile(cooldownFile, 'utf8').catch(() => '{}');
    const state = JSON.parse(raw) as Record<string, unknown>;
    expect(state[filename]).toBeUndefined();
  });

  it('ignores and clears a cooldown entry for a migration absent from the selected sql tree', async () => {
    const cooldownFile = freshCooldownFile();
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_FILE = cooldownFile;
    process.env.PAPERCUSP_MIGRATION_COOLDOWN_MS = String(60_000);
    const staleFilename = '966-staging-only-broken.sql';
    h.bootSqlDir = makeSqlDir({});
    writeFileSync(
      cooldownFile,
      JSON.stringify({
        [staleFilename]: {
          lastFailedAt: Date.now(),
          error: 'failure recorded by a different sql tree',
          attempts: 3,
        },
      }),
    );

    const result = await applyPendingMigrationsNow();

    expect(result).toMatchObject({ applied: 0, failed: [] });
    const raw = await readFile(cooldownFile, 'utf8').catch(() => '{}');
    const state = JSON.parse(raw) as Record<string, unknown>;
    expect(state[staleFilename]).toBeUndefined();
  });
});

describe('migration reservation reconciliation (WI-38354)', () => {
  it('inserts a missing reservation row through the real postgres helper path', async () => {
    await rootSql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.migration_reservations (
        num integer PRIMARY KEY,
        filename text,
        reserved_by text,
        intent text,
        reserved_at timestamptz NOT NULL DEFAULT now()
      )`);
    await rootSql.unsafe('TRUNCATE harness_shared.migration_reservations');
    await rootSql.unsafe('TRUNCATE harness_shared.schema_migrations');
    await rootSql.unsafe('INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ($1, $2)', [
      '999999-reconcile-regression.sql',
      '0'.repeat(64),
    ]);

    const logs: string[] = [];
    const count = await reconcileMigrationReservations(rootSql, (message) => logs.push(message));

    expect(count).toBe(1);
    expect(logs).toEqual([expect.stringContaining('reconciled 1 migration_reservations row(s)')]);
    const rows = await rootSql<
      {
        num: number;
        filename: string;
        reserved_by: string;
        intent: string;
      }[]
    >`
      SELECT num, filename, reserved_by, intent
        FROM harness_shared.migration_reservations
       WHERE num = 999999`;
    expect(rows).toEqual([
      {
        num: 999999,
        filename: '999999-reconcile-regression.sql',
        reserved_by: 'reconcile-on-apply',
        intent: 'auto-reconciled (WI-38354): applied without a db:next-migration reservation row',
      },
    ]);
  });

  it('counts only inserted rows when a peer reserves a number after the reconciliation read', async () => {
    await rootSql.unsafe('TRUNCATE harness_shared.migration_reservations');
    await rootSql.unsafe('TRUNCATE harness_shared.schema_migrations');
    await rootSql.unsafe('INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ($1, $2)', [
      '999999-reconcile-race.sql',
      '0'.repeat(64),
    ]);

    // Inject a real committed peer reservation immediately before the INSERT.
    // The existing ON CONFLICT must preserve it, and neither the result nor
    // the diagnostic may count that skipped row as one this call inserted.
    const racingClient = new Proxy(rootSql, {
      apply: (target, thisArg, args) => {
        const strings = args[0];
        if (Array.isArray(strings) && strings.join('').includes('INSERT INTO harness_shared.migration_reservations')) {
          return (async () => {
            await rootSql.unsafe(
              'INSERT INTO harness_shared.migration_reservations (num, filename, reserved_by, intent) VALUES ($1, $2, $3, $4)',
              [999999, '999999-peer-reservation.sql', 'peer', 'reserved concurrently'],
            );
            return Reflect.apply(target, thisArg, args);
          })();
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    const logs: string[] = [];
    const count = await reconcileMigrationReservations(racingClient, (message) => logs.push(message));

    expect(count).toBe(0);
    expect(logs).toEqual([]);
    const rows = await rootSql<{ filename: string; reserved_by: string; intent: string }[]>`
      SELECT filename, reserved_by, intent FROM harness_shared.migration_reservations WHERE num = 999999`;
    expect(rows).toEqual([
      { filename: '999999-peer-reservation.sql', reserved_by: 'peer', intent: 'reserved concurrently' },
    ]);
  });

  it('does not re-emit conflicts for applied filenames removed after a collision was repaired', async () => {
    await rootSql.unsafe('TRUNCATE harness_shared.migration_reservations');
    await rootSql.unsafe('TRUNCATE harness_shared.schema_migrations');
    await rootSql.unsafe('INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ($1, $2), ($3, $4)', [
      '528-restore-fed-hlc-insert-stamp.sql',
      '0'.repeat(64),
      '528-restore-work-items-local-fed-hlc-stamp.sql',
      '1'.repeat(64),
    ]);
    await rootSql.unsafe(
      'INSERT INTO harness_shared.migration_reservations (num, filename, reserved_by, intent) VALUES ($1, $2, $3, $4)',
      [528, '528-restore-fed-hlc-insert-stamp.sql', 'integration-test', 'collision repair'],
    );

    const logs: string[] = [];
    const count = await reconcileMigrationReservations(
      rootSql,
      (message) => logs.push(message),
      new Set(['528-restore-fed-hlc-insert-stamp.sql']),
    );

    expect(count).toBe(0);
    expect(logs).toEqual([]);
  });
});
