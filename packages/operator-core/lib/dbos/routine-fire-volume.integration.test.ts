/** Physical insert/commit boundary on private PG. No live DB or SDK executor. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { readRoutineFireVolume } from './routine-fire-volume';

const migrationPath = resolve(import.meta.dirname,
  '../../../../libs/papercusp/libs/db/sql/1565-routine-fire-committed-start-counters.sql');
// Drafts are deliberately not applied by boot. Exercise that exact draft before
// arming, without relying on an env flag scrubbed by the private-runtime route.
const migration = readFileSync(existsSync(migrationPath) ? migrationPath : migrationPath + '.DRAFT', 'utf8');
let db: MigratedTestDb;
let sql: Sql;
beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'routinevolume' });
  sql = postgres(db.url, { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared; CREATE SCHEMA dbos;
    CREATE TABLE harness_shared.operator_settings (key text PRIMARY KEY, value text NOT NULL,
      description text, updated_at bigint NOT NULL, workspace_id text NOT NULL)`);
  // Existing deployment: SDK table exists and current tenant settings require
  // workspace_id. This is the upgrade ordering the first fixture omitted.
  await sql.unsafe(`CREATE TABLE dbos.workflow_status (workflow_uuid text PRIMARY KEY, name text NOT NULL, inputs text)`);
  await sql.unsafe(migration);
}, 120_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); await db?.drop(); });

const input = (routine = 'routine') => JSON.stringify({ json: [routine, 'ws', 'pot', 'system:action'], __dbos_serializer: 'superjson' });
async function seed(id: string, payload = input(), name = 'routineFire') {
  await sql`INSERT INTO dbos.workflow_status VALUES (${id}, ${name}, ${payload}) ON CONFLICT DO NOTHING`;
}
async function count(routine = 'routine') {
  const [row] = await sql<{ n: string }[]>`SELECT coalesce(sum(starts), 0)::bigint AS n
    FROM harness_shared.routine_fire_start_counts WHERE routine_id = ${routine}`;
  return Number(row!.n);
}

it('upgrades preexisting DBOS with canonical NOTNULL tenant settings; excludes duplicates/rollbacks and survives GC', async () => {
  await seed('first'); await seed('first'); await seed('other', input(), 'otherWorkflow');
  expect(await count()).toBe(1);
  await sql`DELETE FROM dbos.workflow_status WHERE workflow_uuid = 'first'`;
  expect(await count()).toBe(1);
  await expect(sql.begin(async tx => {
    await tx`INSERT INTO dbos.workflow_status VALUES ('rolled-back', 'routineFire', ${input()})`;
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(await count()).toBe(1);
});
it('counts concurrent admissions without losing increments', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => seed(`parallel-${i}`, input('parallel'))));
  expect(await count('parallel')).toBe(12);
});
it('retains malformed attribution and accepts the legacy array serializer', async () => {
  await seed('malformed', 'not-json'); await seed('missing-fields', '{}');
  await seed('legacy', JSON.stringify(['legacy', 'ws', 'pot', 'system:action']));
  expect(await count('@unattributed')).toBe(2);
  expect(await count('legacy')).toBe(1);
});
it('preserves the epoch on reapply, resets disabled coverage and prunes only old buckets', async () => {
  const epoch = async () => {
    const [row] = await sql<{ value: string }[]>`SELECT obj_description(oid, 'pg_trigger') AS value FROM pg_trigger
      WHERE tgrelid = 'dbos.workflow_status'::regclass AND tgname = 'routine_fire_committed_start_counter'`;
    return JSON.parse(row!.value).sinceMs as number;
  };
  const first = await epoch();
  await sql.unsafe(migration);
  expect(await epoch()).toBe(first);
  await sql.unsafe(`ALTER TABLE dbos.workflow_status DISABLE TRIGGER routine_fire_committed_start_counter`);
  await sql.unsafe(migration);
  expect(await epoch()).toBeGreaterThan(first);
  await sql`INSERT INTO harness_shared.routine_fire_start_counts VALUES
    (0, 'ws', 'pot', 'expired', 'system:action', 99)`;
  await seed('prune', input('current'));
  expect(await count('expired')).toBe(0);
  expect(await count('current')).toBe(1);
  const observed = await readRoutineFireVolume(sql, Math.floor(Date.now() / 3600000) * 3600000);
  expect(observed.triggerEnabled).toBe(true);
  expect(observed.coveredFromMs).toBeGreaterThan(0);
  expect(observed.rows.find(row => row.routineId === 'parallel')?.starts).toBe(12);
});
it('also installs when SDK creates its table after app migration, without writing tenant settings', async () => {
  await sql.unsafe('DROP TABLE dbos.workflow_status');
  await sql.unsafe(migration);
  await sql.unsafe(`CREATE TABLE dbos.workflow_status (workflow_uuid text PRIMARY KEY, name text NOT NULL, inputs text)`);
  await seed('fresh-install', input('fresh'));
  expect(await count('fresh')).toBe(1);
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.operator_settings`;
  expect(row!.n).toBe(0);
});
