/**
 * migration-runner-behaviors.integration.test.ts — failure-path + recording-contract
 * suite for the idempotent boot migration runner (P-006, app-wide-test-coverage-2026-06-05).
 *
 * fresh-migrate.integration.test.ts is the strict SUCCESS gate (empty → head against
 * the REAL sql dir). This file is its failure-path counterpart: it drives the SAME
 * production runner (embedded-postgres-server/src/migration-runner.js) against TEMP
 * directories of tiny synthetic .sql fixtures on a real testcontainer Postgres,
 * pinning the behaviors boot correctness rests on:
 *
 *   - apply + record (sha256 of the RAW file contents) in one transaction
 *   - already-recorded files are skipped (DDL never re-executed)
 *   - fail-loud default: a broken migration throws, stays unrecorded, and the
 *     error names the file/offending statement/reused-PGDATA remedy while the
 *     runner's ROLLBACK leaves the connection usable
 *   - continueOnError=true: bad file → failed[], later files still apply, the
 *     same diagnostic is logged, and the bad file stays pending/retries next run
 *   - failures without a PostgreSQL query position retain an actionable fallback
 *   - psql metacommand lines are stripped from execution but hashed raw
 *   - the default skip set (per-harness-template + MANUAL_ONLY) and its override
 *   - SQL escaping of recorded filenames
 *   - numeric-prefix apply order with deterministic complete-filename tie-breaks
 *   - INCIDENT CLASS (2026-06-09 fleet deploy wedge): out-of-band `psql -f`
 *     application leaves a migration permanently pending — only the RUNNER records.
 *
 * Run (file-scoped):
 *   cd apps/operator && npx vitest run --config vitest.integration.config.ts \
 *     test/migration-runner-behaviors.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
// eslint-disable-next-line import/no-relative-packages -- exercise the real boot-path runner
import { applyPendingMigrations } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;
const tempDirs: string[] = [];

/** Write a synthetic sql dir (NEVER the real libs/papercusp/libs/db/sql). */
async function makeSqlDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mrb-sql-'));
  tempDirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(dir, name), contents, 'utf8')),
  );
  return dir;
}

/** Tracker rows as plain objects (filename-sorted) so toEqual sees no RowList extras. */
async function recorded(): Promise<Array<{ filename: string; sha256: string }>> {
  const rows = await sql.unsafe(
    `SELECT filename, sha256 FROM harness_shared.schema_migrations ORDER BY filename`,
  );
  return rows.map((r) => ({ filename: r.filename, sha256: r.sha256 }));
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await sql.unsafe(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.length === 1;
}

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `mrb_${randomBytes(5).toString('hex')}`;

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
}, 120_000);

beforeEach(async () => {
  // Same DDL the runner ensures on every call (idempotent), so the truncate is
  // always valid — each test starts from an EMPTY tracker. Fixture tables use a
  // per-test mrb<N>_ prefix, so leftover tables can't collide across tests.
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE IF NOT EXISTS harness_shared.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sha256 TEXT NOT NULL
    );
    TRUNCATE harness_shared.schema_migrations;
  `);
});

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
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('migration runner — failure paths + recording contract (synthetic sql dir)', () => {
  it('bulk fresh-schema replay disables parallel query inside each migration transaction', async () => {
    const before = await sql.unsafe(`SELECT current_setting('max_parallel_workers_per_gather') AS value`);
    const files: Record<string, string> = {
      '001-observe.sql': `
        CREATE TABLE mrb0_parallel_setting (value text NOT NULL);
        INSERT INTO mrb0_parallel_setting(value)
        VALUES (current_setting('max_parallel_workers_per_gather'));
      `,
    };
    // The runner's bulk threshold is 20 pending files. The remaining fixtures
    // are intentional no-ops: they make this a fresh-schema-shaped replay while
    // keeping the assertion focused on the session setting migration 001 saw.
    for (let i = 2; i <= 20; i += 1) {
      files[`${String(i).padStart(3, '0')}-noop.sql`] = 'SELECT 1;\n';
    }
    const dir = await makeSqlDir(files);

    const res = await applyPendingMigrations({ client: sql, sqlDir: dir });

    expect(res.appliedCount).toBe(20);
    const observed = await sql.unsafe('SELECT value FROM mrb0_parallel_setting');
    expect(observed).toEqual([{ value: '0' }]);
    // SET LOCAL must not retune the shared session after the migration commits.
    const after = await sql.unsafe(`SELECT current_setting('max_parallel_workers_per_gather') AS value`);
    expect(after).toEqual(before);
  });

  it('applies a new file and records its filename + sha256 of the RAW contents', async () => {
    const raw = 'CREATE TABLE mrb1_widgets (id int PRIMARY KEY);\n';
    const dir = await makeSqlDir({ '001-widgets.sql': raw });

    const res = await applyPendingMigrations({ client: sql, sqlDir: dir });

    expect(res.appliedCount).toBe(1);
    expect(res.totalKnown).toBe(1);
    expect(res.failed).toEqual([]);
    await expect(tableExists('mrb1_widgets')).resolves.toBe(true);
    expect(await recorded()).toEqual([{ filename: '001-widgets.sql', sha256: sha256(raw) }]);
  });

  it('retries a transient 55P03 per transaction attempt after rollback, then records the migration', async () => {
    const raw = 'CREATE TABLE mrb1b_lock_retry (id int PRIMARY KEY);\n';
    const dir = await makeSqlDir({ '001-lock-retry.sql': raw });
    let transientFailuresRemaining = 2;
    let transactionAttempts = 0;
    let rollbacks = 0;
    const logs: string[] = [];
    const client = {
      unsafe: async (query: string) => {
        if (query.startsWith('BEGIN;')) {
          transactionAttempts += 1;
          if (transientFailuresRemaining > 0) {
            transientFailuresRemaining -= 1;
            throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
          }
        }
        if (query.trim() === 'ROLLBACK') rollbacks += 1;
        return sql.unsafe(query);
      },
    };

    const result = await applyPendingMigrations({ client, sqlDir: dir, log: (line) => logs.push(line) });

    expect(result).toMatchObject({ appliedCount: 1, totalKnown: 1, failed: [] });
    expect(transactionAttempts).toBe(3);
    expect(rollbacks).toBe(2);
    expect(logs.filter((line) => line.includes('SQLSTATE 55P03'))).toHaveLength(2);
    await expect(tableExists('mrb1b_lock_retry')).resolves.toBe(true);
    expect(await recorded()).toEqual([{ filename: '001-lock-retry.sql', sha256: sha256(raw) }]);
  });

  it('flushes bulk migration WAL without a cluster checkpoint, including a failed final file', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 19; i += 1) files[`${String(i).padStart(3, '0')}-bulk.sql`] = 'SELECT 1;';
    files['020-broken.sql'] = 'SELECT * FROM mrb_missing_bulk_tail;';
    const dir = await makeSqlDir(files);
    let beforeBarrierLsn: string | undefined;
    let barrierSeen = false;
    const client = {
      unsafe: async (query: string) => {
        // Reject the old implementation before it can stall a shared cluster.
        if (query.trim() === 'CHECKPOINT') throw new Error('cluster checkpoint is forbidden in this probe');
        if (query.startsWith('UPDATE harness_shared.schema_migrations SET sha256')) {
          const [{ value }] = await sql.unsafe("SELECT current_setting('synchronous_commit') AS value");
          expect(value).toBe('on');
          const [{ lsn }] = await sql.unsafe('SELECT pg_current_wal_insert_lsn()::text AS lsn');
          beforeBarrierLsn = lsn;
          barrierSeen = true;
        }
        return sql.unsafe(query);
      },
    };

    const result = await applyPendingMigrations({ client, sqlDir: dir, continueOnError: true });

    expect(result.appliedCount).toBe(19);
    expect(result.failed.map((failure) => failure.file)).toEqual(['020-broken.sql']);
    expect(barrierSeen).toBe(true);
    const [{ durable }] = await sql.unsafe('SELECT pg_current_wal_flush_lsn() >= $1::pg_lsn AS durable', [beforeBarrierLsn!]);
    expect(durable).toBe(true);
    // The barrier may add a row version, but may not alter the ledger's meaning.
    expect(await recorded()).toEqual(Object.keys(files).slice(0, 19).map(filename => ({ filename, sha256: sha256(files[filename]!) })));
  });

  it('second run skips already-recorded files (non-idempotent DDL is NOT re-executed)', async () => {
    // Deliberately no IF NOT EXISTS — if the runner re-executed this, the second
    // run would throw 42P07 (duplicate_table) instead of cleanly skipping.
    const dir = await makeSqlDir({ '001-once.sql': 'CREATE TABLE mrb2_once (id int);\n' });

    const first = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(first.appliedCount).toBe(1);

    const second = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(second.appliedCount).toBe(0);
    expect(second.totalKnown).toBe(1);
    expect(second.failed).toEqual([]);
  });

  it('fail-loud default: a broken migration throws, stays unrecorded, and the connection survives', async () => {
    const dir = await makeSqlDir({
      '001-good.sql': 'CREATE TABLE mrb3_first (id int);\n',
      // Semicolons inside the dollar-quoted body must NOT confuse statement
      // selection: the diagnostic excerpt should name the ALTER, not this DO.
      '002-bad.sql': [
        'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;',
        // 42601 reliably carries a PostgreSQL query position, so this leg proves
        // the position-to-statement mapping (semantic errors are allowed to omit it).
        'ALTER TABLE mrb3_missing ADD COLUMN broken ???;',
        'SELECT 3;',
        '',
      ].join('\n'),
      '003-later.sql': 'CREATE TABLE mrb3_third (id int);\n',
    });

    let thrown: Error | undefined;
    try {
      await applyPendingMigrations({ client: sql, sqlDir: dir, dataDirWasReused: true });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    expect(thrown?.name).toBe('MigrationError');
    expect(thrown?.message).toContain('Migration 002-bad.sql FAILED');
    expect(thrown?.message).toContain('syntax error at or near "???"');
    expect(thrown?.message).toContain(`Migration file: ${join(dir, '002-bad.sql')}`);
    expect(thrown?.message).toMatch(
      /Offending statement near migration character \d+: ALTER TABLE mrb3_missing ADD COLUMN broken \?\?\?;/,
    );
    expect(thrown?.message).not.toContain('PERFORM 1');
    expect(thrown?.message).toContain('reused an existing Postgres data directory');
    expect(thrown?.message).toContain('operator cannot start until this migration applies');
    expect(thrown?.cause).toMatchObject({ code: '42601', position: expect.any(String) });

    // Earlier file in the SAME run was applied + recorded; the bad file and the
    // later file (loop halted at the throw) were not.
    expect((await recorded()).map((r) => r.filename)).toEqual(['001-good.sql']);
    await expect(tableExists('mrb3_first')).resolves.toBe(true);
    await expect(tableExists('mrb3_third')).resolves.toBe(false);

    // The runner ROLLBACKed the aborted transaction — the session must NOT be
    // wedged in "current transaction is aborted, commands ignored until end of block".
    const [{ ok }] = await sql.unsafe('SELECT 1 AS ok');
    expect(ok).toBe(1);
  });

  it('continueOnError=true: bad file lands in failed[] unrecorded, later files apply, and it retries next run', async () => {
    const dir = await makeSqlDir({
      '001-good.sql': 'CREATE TABLE mrb4_first (id int);\n',
      '002-bad.sql': 'ALTER TABLE mrb4_missing ADD COLUMN x int;\n',
      '003-later.sql': 'CREATE TABLE mrb4_third (id int);\n',
    });

    const logs: string[] = [];
    const first = await applyPendingMigrations({
      client: sql,
      sqlDir: dir,
      dataDirWasReused: true,
      continueOnError: true,
      log: (line) => logs.push(line),
    });
    expect(first.appliedCount).toBe(2);
    expect(first.totalKnown).toBe(3);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0].file).toBe('002-bad.sql');
    expect(first.failed[0].error).toContain('Migration 002-bad.sql FAILED');
    expect(first.failed[0].error).toContain('mrb4_missing');
    expect(first.failed[0].error).toContain('reused an existing Postgres data directory');
    expect(first.failed[0].error).toContain('remains pending and will retry on the next boot');
    expect(first.failed[0].error).not.toContain('operator cannot start');
    expect(logs.some((line) => line.includes(first.failed[0].error))).toBe(true);
    // Boot continued PAST the bad file (the whole point of continueOnError).
    await expect(tableExists('mrb4_third')).resolves.toBe(true);
    expect((await recorded()).map((r) => r.filename)).toEqual(['001-good.sql', '003-later.sql']);

    // Unrecorded → still pending: fix the file and the next run picks it up.
    const fixed = 'CREATE TABLE mrb4_fixed (id int);\n';
    await writeFile(join(dir, '002-bad.sql'), fixed, 'utf8');
    const second = await applyPendingMigrations({ client: sql, sqlDir: dir, continueOnError: true });
    expect(second.appliedCount).toBe(1);
    expect(second.failed).toEqual([]);
    await expect(tableExists('mrb4_fixed')).resolves.toBe(true);
    const rows = await recorded();
    expect(rows.map((r) => r.filename)).toEqual(['001-good.sql', '002-bad.sql', '003-later.sql']);
    expect(rows.find((r) => r.filename === '002-bad.sql')?.sha256).toBe(sha256(fixed));
  });

  it('preserves PL/pgSQL failure context when PostgreSQL provides no outer query position', async () => {
    const dir = await makeSqlDir({
      '001-inner.sql': "DO $guard$ BEGIN RAISE EXCEPTION 'inner role guard'; END $guard$;",
    });
    await expect(applyPendingMigrations({ client: sql, sqlDir: dir })).rejects.toThrow(
      /PostgreSQL context: PL\/pgSQL function inline_code_block line 1 at RAISE/,
    );
    expect(await recorded()).toEqual([]);
    expect((await sql.unsafe('SELECT 1 AS ok'))[0].ok).toBe(1);
  });

  it('failure without a query position still names the file, fresh-data context, and remedy', async () => {
    const dir = await makeSqlDir({
      '001-guarded.sql': 'CREATE TABLE mrb4b_guarded (id int);\n',
    });

    let thrown: Error | undefined;
    try {
      await applyPendingMigrations({
        client: sql,
        sqlDir: dir,
        dataDirWasReused: false,
        beforeApply: () => {
          throw new Error('synthetic pre-apply guard failure');
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown?.name).toBe('MigrationError');
    expect(thrown?.message).toContain('Migration 001-guarded.sql FAILED');
    expect(thrown?.message).toContain(`Migration file: ${join(dir, '001-guarded.sql')}`);
    expect(thrown?.message).toContain('underlying error did not report a usable query position');
    expect(thrown?.message).toContain('created a fresh Postgres data directory');
    expect(thrown?.message).toContain('operator cannot start until this migration applies');
    expect(thrown?.message).not.toContain('Offending statement');
    expect(thrown?.cause).toMatchObject({ message: 'synthetic pre-apply guard failure' });
  });

  it('a missing pgvector names the embedded-postgres provisioning step (open-source-release P-008)', async () => {
    const dir = await makeSqlDir({ '001-vec.sql': 'CREATE TABLE mrb4c_vec (id int);\n' });
    let thrown: Error | undefined;
    try {
      await applyPendingMigrations({
        client: sql,
        sqlDir: dir,
        dataDirWasReused: false,
        beforeApply: () => {
          throw new Error('type "vector" does not exist');
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    expect(thrown?.name).toBe('MigrationError');
    expect(thrown?.message).toContain('pgvector extension is missing');
    expect(thrown?.message).toContain('node scripts/install-embedded-pgvector.mjs');
  });

  it('an unrelated failure carries no pgvector hint', async () => {
    const dir = await makeSqlDir({ '001-other.sql': 'CREATE TABLE mrb4d_other (id int);\n' });
    let thrown: Error | undefined;
    try {
      await applyPendingMigrations({
        client: sql,
        sqlDir: dir,
        beforeApply: () => {
          throw new Error('relation "nope" does not exist');
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    expect(thrown?.message).not.toContain('pgvector');
  });

  it('strips psql metacommand lines from execution but hashes the RAW contents', async () => {
    // Sent raw to postgres-js these metacommands would be "syntax error at or near \".
    const raw = [
      '\\set ON_ERROR_STOP on',
      "\\echo 'applying mrb5'",
      'CREATE TABLE mrb5_meta (id int);',
      '\\if :flag',
      '\\endif',
      '',
    ].join('\n');
    const dir = await makeSqlDir({ '001-meta.sql': raw });

    const res = await applyPendingMigrations({ client: sql, sqlDir: dir });

    expect(res.appliedCount).toBe(1);
    await expect(tableExists('mrb5_meta')).resolves.toBe(true);
    const [row] = await recorded();
    // Hash is of the RAW file (metacommands INCLUDED) — so files don't re-apply
    // just because the stripper changes — not of the executed (stripped) text.
    expect(row.sha256).toBe(sha256(raw));
    const stripped = raw
      .split('\n')
      .filter((line) => !/^\s*\\[a-z]/i.test(line))
      .join('\n');
    expect(row.sha256).not.toBe(sha256(stripped));
  });

  it('default skip set: per-harness-template + MANUAL_ONLY names are not applied; a custom skipFile overrides it', async () => {
    const dir = await makeSqlDir({
      '001-normal.sql': 'CREATE TABLE mrb6_normal (id int);\n',
      // Real-world MANUAL_ONLY name (the real file needs psql -v substitution;
      // this synthetic stand-in is plain DDL so the override leg can apply it).
      '040-plugin-configs-backfill.sql': 'CREATE TABLE mrb6_manual (id int);\n',
      '900-per-harness-template.sql': 'CREATE TABLE mrb6_template (id int);\n',
    });

    const res = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(res.totalKnown).toBe(1); // skipped files aren't even "known"
    expect(res.appliedCount).toBe(1);
    await expect(tableExists('mrb6_normal')).resolves.toBe(true);
    await expect(tableExists('mrb6_manual')).resolves.toBe(false);
    await expect(tableExists('mrb6_template')).resolves.toBe(false);
    expect((await recorded()).map((r) => r.filename)).toEqual(['001-normal.sql']);

    // A custom skipFile REPLACES the default (it does not compose with it).
    const res2 = await applyPendingMigrations({ client: sql, sqlDir: dir, skipFile: () => false });
    expect(res2.totalKnown).toBe(3);
    expect(res2.appliedCount).toBe(2); // 001 was already recorded
    await expect(tableExists('mrb6_manual')).resolves.toBe(true);
    await expect(tableExists('mrb6_template')).resolves.toBe(true);
  });

  it('EI-19366138707071397: a `.DRAFT`-suffixed file (db:next-migration\'s write target) is never applied — even a syntactically BROKEN one, and even a `skipFile` override cannot bring it back', async () => {
    // db:next-migration now hands callers a `<NNN>-<slug>.sql.DRAFT` path to
    // write + iterate at (including a deliberate temporary both-ways
    // guard-test mutation) so it can never race the boot auto-apply while
    // unfinished — see scripts/next-migration.mjs's module docstring. The
    // runner's `.filter(f => f.endsWith('.sql'))` (not a skip-set entry) is
    // what makes this safe: prove it holds, and prove it holds even for
    // genuinely invalid SQL a mid-edit draft could legitimately contain.
    const dir = await makeSqlDir({
      '001-normal.sql': 'CREATE TABLE mrb6b_normal (id int);\n',
      '002-in-progress.sql.DRAFT': 'this is not even valid SQL {{{',
    });

    const res = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(res.totalKnown).toBe(1); // the draft isn't even "known" — same as the skip set
    expect(res.appliedCount).toBe(1);
    expect(res.failed).toEqual([]);
    await expect(tableExists('mrb6b_normal')).resolves.toBe(true);
    expect((await recorded()).map((r) => r.filename)).toEqual(['001-normal.sql']);

    // Unlike MANUAL_ONLY / per-harness-template, the DRAFT suffix is a plain
    // filename-shape fact (endsWith('.sql')), not a skip-set entry — a custom
    // skipFile that returns false for everything still cannot make it apply,
    // because it's filtered out before `skip()` is ever consulted.
    const res2 = await applyPendingMigrations({ client: sql, sqlDir: dir, skipFile: () => false });
    expect(res2.totalKnown).toBe(1);
    expect(res2.appliedCount).toBe(0); // 001 already recorded; the .DRAFT stays invisible
  });

  it("records a filename containing a single quote correctly (SQL escaping)", async () => {
    const raw = 'CREATE TABLE mrb7_quoted (id int);\n';
    const name = "001-o'brien.sql";
    const dir = await makeSqlDir({ [name]: raw });

    const res = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(res.appliedCount).toBe(1);

    const rows = await sql.unsafe(
      `SELECT filename, sha256 FROM harness_shared.schema_migrations WHERE filename = $1`,
      [name],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].sha256).toBe(sha256(raw));

    // And the escaped name round-trips: a re-run sees it as applied.
    const second = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(second.appliedCount).toBe(0);
  });

  it('applies numbered files in numeric prefix order with deterministic filename ties', async () => {
    // '002-a.sql' sorts first, so it creates the log table the others insert into.
    const dir = await makeSqlDir({
      '002-a.sql':
        "CREATE TABLE mrb8_log (n serial, tag text);\nINSERT INTO mrb8_log (tag) VALUES ('002');\n",
      '010-b.sql': "INSERT INTO mrb8_log (tag) VALUES ('010');\n",
      '100-c.sql': "INSERT INTO mrb8_log (tag) VALUES ('100');\n",
      '10-ten.sql': "INSERT INTO mrb8_log (tag) VALUES ('10');\n",
      '2-two.sql': "INSERT INTO mrb8_log (tag) VALUES ('2');\n",
      '374-three.sql': "INSERT INTO mrb8_log (tag) VALUES ('374');\n",
      '1003-four.sql': "INSERT INTO mrb8_log (tag) VALUES ('1003');\n",
    });

    const res = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(res.appliedCount).toBe(7);

    const rows = await sql.unsafe(`SELECT tag FROM mrb8_log ORDER BY n`);
    // Numeric prefixes group equivalent numbers, and complete filenames break ties.
    // Crucially, the three-digit prerequisite runs before the four-digit migration.
    expect(rows.map((r) => r.tag)).toEqual(['002', '2', '010', '10', '100', '374', '1003']);
  });

  it('INCIDENT REGRESSION (2026-06-09 fleet deploy wedge): out-of-band DDL leaves the migration pending — only the runner records', async () => {
    // Idempotent DDL, like a well-formed migration — so the forced re-apply succeeds.
    const raw = 'CREATE TABLE IF NOT EXISTS mrb9_oob (id int);\n';
    const dir = await makeSqlDir({ '001-oob.sql': raw });

    // Simulate a raw `psql -f` out-of-band apply: the DDL runs, nothing records it.
    await sql.unsafe(raw);
    await expect(tableExists('mrb9_oob')).resolves.toBe(true);
    expect(await recorded()).toEqual([]);

    // Next runner pass: the file is STILL pending (applied-but-unrecorded), so it
    // re-applies. This is the contract that wedged the fleet's deploys for ~1h on
    // 2026-06-09 (migration 208-scout-ticks applied via psql -f, never recorded →
    // re-run on every deploy until a lock_timeout rollback). Recording happens
    // only now, through the runner.
    const res = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(res.appliedCount).toBe(1);
    expect(await recorded()).toEqual([{ filename: '001-oob.sql', sha256: sha256(raw) }]);

    // And only from here on is it skipped.
    const second = await applyPendingMigrations({ client: sql, sqlDir: dir });
    expect(second.appliedCount).toBe(0);
  });
});
