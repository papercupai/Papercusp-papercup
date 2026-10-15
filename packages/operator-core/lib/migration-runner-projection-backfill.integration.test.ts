import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { applyPendingMigrations, migrationTransactionChunks } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const filename = '1422-adv-sessions-launch-harness-projection.sql';
const originalSql = readFileSync(new URL('../../../libs/papercusp/libs/db/sql/1422-adv-sessions-launch-harness-projection.sql', import.meta.url), 'utf8');
const originalHash = '3e83f0b39921a090bd4eaeb4d67f676d8ab7c739abd81a71a2651a5214bbd34a';
let db: FreshPgDb;
let client: postgres.Sql;
let dir: string;

beforeEach(async () => {
  db = await createFreshPgDb('projection-replay');
  const expectedDatabase = decodeURIComponent(new URL(db.url).pathname.slice(1));
  expect(['papercusp', 'postgres', 'org']).not.toContain(expectedDatabase);
  client = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  expect((await client`SELECT current_database() AS name`)[0].name).toBe(expectedDatabase);
  dir = mkdtempSync(join(tmpdir(), 'projection-replay-'));
  writeFileSync(join(dir, filename), originalSql);
  await db.sql.unsafe('CREATE TABLE harness_shared.adv_sessions (id integer PRIMARY KEY, launch_spec jsonb)');
}, 60_000);

afterEach(async () => {
  await client?.end({ timeout: 5 });
  await db?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('historical session projection cold replay', () => {
  it('retains committed batches after SQLSTATE57014 and resumes without changing the ledger hash or launch JSON', async () => {
    expect(createHash('sha256').update(originalSql).digest('hex')).toBe(originalHash);
    await db.sql.unsafe(`INSERT INTO harness_shared.adv_sessions (id, launch_spec)
      SELECT g, jsonb_build_object('harnessSlug', CASE WHEN g % 5 = 0 THEN NULL ELSE 'h-' || g END,
        'history', repeat('historical-identity-', 4000)) FROM generate_series(1, 130) AS g`);
    const before = await db.sql`SELECT id, md5(launch_spec::text) AS fingerprint FROM harness_shared.adv_sessions ORDER BY id`;
    await db.sql.unsafe(`CREATE FUNCTION harness_shared.force_projection_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('synchronous_commit') <> 'on' THEN RAISE EXCEPTION 'projection batch commit must be durable'; END IF;
        IF NEW.id = 65 THEN RAISE EXCEPTION 'forced projection cancellation' USING ERRCODE = '57014'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER z_force_projection_cancel BEFORE UPDATE ON harness_shared.adv_sessions
      FOR EACH ROW EXECUTE FUNCTION harness_shared.force_projection_cancel()`);

    // Control: the historical unbounded data transaction rolls every row back.
    const legacyChunks = originalSql.split(/-->\s*statement-breakpoint/);
    await client.unsafe(`BEGIN; ${legacyChunks[0]} COMMIT;`);
    await expect(client.unsafe(`BEGIN; ${legacyChunks[1]} COMMIT;`)).rejects.toMatchObject({ code: '57014' });
    await client.unsafe('ROLLBACK');
    expect((await db.sql`SELECT count(*)::int AS n FROM harness_shared.adv_sessions WHERE launch_harness_projection IS NOT NULL`)[0].n).toBe(0);

    await client.unsafe('SET synchronous_commit = off');
    await expect(applyPendingMigrations({ client, sqlDir: dir })).rejects.toThrow(/forced projection cancellation/);
    expect((await db.sql`SELECT count(*)::int AS n FROM harness_shared.adv_sessions WHERE launch_harness_projection IS NOT NULL`)[0].n).toBe(64);
    expect(await db.sql`SELECT filename FROM harness_shared.schema_migrations WHERE filename = ${filename}`).toEqual([]);

    await db.sql.unsafe('DROP TRIGGER z_force_projection_cancel ON harness_shared.adv_sessions');
    expect(await applyPendingMigrations({ client, sqlDir: dir })).toMatchObject({ appliedCount: 1, failed: [] });
    expect((await db.sql`SELECT count(*)::int AS n FROM harness_shared.adv_sessions WHERE launch_harness_projection IS NULL`)[0].n).toBe(0);
    expect(await db.sql`SELECT filename, sha256 FROM harness_shared.schema_migrations WHERE filename = ${filename}`)
      .toEqual([{ filename, sha256: originalHash }]);
    expect(await db.sql`SELECT id, md5(launch_spec::text) AS fingerprint FROM harness_shared.adv_sessions ORDER BY id`).toEqual(before);
    expect(await applyPendingMigrations({ client, sqlDir: dir })).toMatchObject({ appliedCount: 0 });
  }, 60_000);

  it('rejects a final ledger write while any pending projection remains', async () => {
    await db.sql.unsafe(`ALTER TABLE harness_shared.adv_sessions ADD COLUMN launch_harness_projection jsonb;
      INSERT INTO harness_shared.adv_sessions (id) VALUES (1);
      CREATE TABLE harness_shared.schema_migrations (filename text PRIMARY KEY, sha256 text)`);
    const guard = migrationTransactionChunks(originalSql).at(-1);
    await expect(client.unsafe(`BEGIN; ${guard}
      INSERT INTO harness_shared.schema_migrations VALUES ('${filename}', '${originalHash}'); COMMIT;`))
      .rejects.toThrow(/remains incomplete/);
    await client.unsafe('ROLLBACK');
    expect(await db.sql`SELECT filename FROM harness_shared.schema_migrations`).toEqual([]);
  });
});
