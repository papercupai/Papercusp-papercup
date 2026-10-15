/**
 * ensure-git-outbox.integration.test.ts — the git-export capture trigger
 * (git_export_outbox + capture_git_export_outbox()), against a real Postgres.
 * The source builds its own schema (ensureGitExportOutbox), so no migration DDL
 * to mirror — only throwaway target tables to attach the trigger to.
 *
 * Behaviors a fake-sql unit test can't prove (they live in the plpgsql trigger):
 *  - INSERT/UPDATE → op='put', DELETE → op='del' (keyed off the variadic key cols,
 *    composite keys joined with '__'), ws/slug extracted from the row;
 *  - the NO-OP-UPDATE guard: an UPDATE that changes nothing enqueues NOTHING
 *    (TEETHED) — the re-upsert-amplification fix;
 *  - the echo-loop guard: a remote-origin write is NOT captured (only local writes
 *    git-export).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const { ensureGitExportOutbox, attachGitCaptureTrigger, gitKeyCols } = await import('./ensure-git-outbox');

let rootSql: postgres.Sql;
const WS = 'ws-gx';
const outbox = () => rootSql<{ op: string; key: string; table_name: string; ws: string; slug: string; data: string | null }[]>`
  SELECT op, key, table_name, workspace_id AS ws, harness_slug AS slug, row->>'data' AS data
    FROM harness_shared.git_export_outbox ORDER BY id`;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `gx_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await ensureGitExportOutbox(rootSql); // the source builds the outbox + capture fn
  // throwaway target tables: a simple-keyed one + a composite-keyed one
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.git_test_tbl (
      workspace_id text NOT NULL, harness_slug text NOT NULL, id text NOT NULL,
      origin text NOT NULL DEFAULT 'local', data text,
      PRIMARY KEY (workspace_id, harness_slug, id)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.git_test_composite (
      workspace_id text NOT NULL, harness_slug text NOT NULL, phase text NOT NULL, test_id text NOT NULL,
      origin text NOT NULL DEFAULT 'local',
      PRIMARY KEY (workspace_id, harness_slug, phase, test_id)
    )`);
  // EI-10521: an UNROUTABLE target — no harness_slug column at all (the real shape of
  // `goals`, which is install-scoped, and `project_spec_revisions`, which is
  // project-scoped). Both were git-registered by mistake; the capture trigger read a
  // column they don't have and its NOT NULL insert aborted every write to them.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.git_test_noslug (
      workspace_id text NOT NULL, install_slug text, id text NOT NULL,
      origin text NOT NULL DEFAULT 'local', data text,
      PRIMARY KEY (workspace_id, id)
    )`);
  // …and one whose harness_slug EXISTS but is nullable (the NULL-valued case).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.git_test_nullslug (
      workspace_id text NOT NULL, harness_slug text, id text NOT NULL,
      origin text NOT NULL DEFAULT 'local', data text,
      PRIMARY KEY (workspace_id, id)
    )`);
  await attachGitCaptureTrigger(rootSql, 'git_test_tbl', ['id']);
  await attachGitCaptureTrigger(rootSql, 'git_test_composite', ['phase', 'test_id']);
  await attachGitCaptureTrigger(rootSql, 'git_test_noslug', ['id']);
  await attachGitCaptureTrigger(rootSql, 'git_test_nullslug', ['id']);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.git_export_outbox RESTART IDENTITY`;
  await rootSql`TRUNCATE harness_shared.git_test_tbl, harness_shared.git_test_composite,
                         harness_shared.git_test_noslug, harness_shared.git_test_nullslug`;
});

describe('git-export capture trigger (PG)', () => {
  it('INSERT → put; value-changing UPDATE → put; DELETE → del (ws/slug/key extracted)', async () => {
    await rootSql`INSERT INTO harness_shared.git_test_tbl (workspace_id, harness_slug, id, data) VALUES (${WS}, 'web', 'f1', 'v1')`;
    await rootSql`UPDATE harness_shared.git_test_tbl SET data='v2' WHERE id='f1'`;
    await rootSql`DELETE FROM harness_shared.git_test_tbl WHERE id='f1'`;
    const rows = await outbox();
    expect(rows.map((r) => r.op)).toEqual(['put', 'put', 'del']); // ins, value-update, delete
    expect(rows.every((r) => r.key === 'f1' && r.table_name === 'git_test_tbl' && r.ws === WS && r.slug === 'web')).toBe(true);
    expect(rows[1]!.data).toBe('v2'); // the put carries the NEW row
  });

  it('a NO-OP UPDATE (no column changed) enqueues NOTHING', async () => {
    await rootSql`INSERT INTO harness_shared.git_test_tbl (workspace_id, harness_slug, id, data) VALUES (${WS}, 'web', 'f1', 'v1')`;
    await rootSql`TRUNCATE harness_shared.git_export_outbox RESTART IDENTITY`; // isolate the update
    await rootSql`UPDATE harness_shared.git_test_tbl SET data='v1' WHERE id='f1'`; // same value → no-op
    expect(await outbox()).toHaveLength(0); // the re-upsert-amplification guard
  });

  it('echo-loop guard: a remote-origin write is NOT captured', async () => {
    await rootSql`INSERT INTO harness_shared.git_test_tbl (workspace_id, harness_slug, id, origin, data) VALUES (${WS}, 'web', 'r1', 'remote', 'v1')`;
    expect(await outbox()).toHaveLength(0); // only origin='local' writes git-export
    await rootSql`INSERT INTO harness_shared.git_test_tbl (workspace_id, harness_slug, id, origin, data) VALUES (${WS}, 'web', 'l1', 'local', 'v1')`;
    expect((await outbox()).map((r) => r.key)).toEqual(['l1']); // the local one captured
  });

  it('composite key cols are composed with __', async () => {
    expect(gitKeyCols('harness_tests')).toEqual(['phase', 'test_id']); // registry default
    await rootSql`INSERT INTO harness_shared.git_test_composite (workspace_id, harness_slug, phase, test_id) VALUES (${WS}, 'web', 'p1', 't9')`;
    expect((await outbox())[0]!.key).toBe('p1__t9');
  });
});

/**
 * EI-10521 — an UNROUTABLE row must not take the caller's write down with it.
 *
 * git_export_outbox.harness_slug is NOT NULL. Before the guard, a target table with
 * no harness_slug column (or a NULL one) made the trigger's INSERT raise
 * "null value in column harness_slug", and because that raise happens INSIDE the
 * AFTER trigger it aborted the statement that fired it. Two live tables were
 * registered that way — `goals` (install-scoped) and `project_spec_revisions`
 * (project-scoped) — so every write to them failed and both sat at ZERO rows. The
 * llm_test_* tables had already been bitten by the identical bug (table-registry.ts).
 *
 * The invariant: an export we cannot route is DROPPED, never fatal. The registry is
 * the real fix (git-export-slug-coverage keeps an unroutable table out of GIT_TABLES);
 * this is the seatbelt under it.
 */
describe('git-export capture trigger — unroutable rows drop, they do not abort the write (EI-10521)', () => {
  it('a table with NO harness_slug column: the write SUCCEEDS and enqueues nothing', async () => {
    // Pre-fix this INSERT threw 23502 not_null_violation and the row was never written.
    await expect(
      rootSql`INSERT INTO harness_shared.git_test_noslug (workspace_id, install_slug, id, data) VALUES (${WS}, 'inst-1', 'g1', 'v1')`,
    ).resolves.toBeDefined();
    const kept = await rootSql<{ id: string }[]>`SELECT id FROM harness_shared.git_test_noslug`;
    expect(kept.map((r) => r.id)).toEqual(['g1']); // the caller's row actually landed
    expect(await outbox()).toHaveLength(0); // and nothing unroutable was enqueued
  });

  it('UPDATE and DELETE on an unroutable table also survive', async () => {
    await rootSql`INSERT INTO harness_shared.git_test_noslug (workspace_id, install_slug, id, data) VALUES (${WS}, 'inst-1', 'g1', 'v1')`;
    await expect(rootSql`UPDATE harness_shared.git_test_noslug SET data='v2' WHERE id='g1'`).resolves.toBeDefined();
    await expect(rootSql`DELETE FROM harness_shared.git_test_noslug WHERE id='g1'`).resolves.toBeDefined();
    expect(await outbox()).toHaveLength(0); // every op dropped, none fatal
  });

  it('a NULL harness_slug VALUE drops too (the column exists but is unset)', async () => {
    await expect(
      rootSql`INSERT INTO harness_shared.git_test_nullslug (workspace_id, harness_slug, id, data) VALUES (${WS}, NULL, 'n1', 'v1')`,
    ).resolves.toBeDefined();
    expect(await outbox()).toHaveLength(0);
  });

  it('an EMPTY-STRING harness_slug drops too — it would route nowhere', async () => {
    await rootSql`INSERT INTO harness_shared.git_test_nullslug (workspace_id, harness_slug, id, data) VALUES (${WS}, '', 'e1', 'v1')`;
    expect(await outbox()).toHaveLength(0);
  });

  it('a ROUTABLE row on the very same table still exports (the guard is not a blanket off-switch)', async () => {
    // The negative control: if this stopped exporting, the guard would be suppressing
    // real work rather than only the unroutable ops.
    await rootSql`INSERT INTO harness_shared.git_test_nullslug (workspace_id, harness_slug, id, data) VALUES (${WS}, 'web', 'ok1', 'v1')`;
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe('web');
    expect(rows[0]!.key).toBe('ok1');
  });
});
