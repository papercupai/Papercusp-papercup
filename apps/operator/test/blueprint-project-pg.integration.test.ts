/**
 * P-002 (PG half) — real-Postgres coverage for the blueprint projection cache
 * (`harness_shared.blueprints`). Exercises projectBlueprintToPg / readBlueprintFromPg
 * / getEffectiveBlueprint against a throwaway testcontainer DB.
 *
 * The full migration 133 (RLS + grants, compose-onto-baseline) is covered by
 * fresh-migrate.integration.test.ts, which applies every sql/ migration empty→head;
 * here we create just the table so the projection LOGIC is what's under test.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { BlueprintSchema, compileAgentSpecification, loadBuiltinBlueprint, operationFromSpecification } from '@papercusp/orchestrator/blueprint';
import {
  projectBlueprintToPg,
  readBlueprintFromPg,
  readBlueprintHashFromPg,
  readBlueprintSpecificationSnapshot,
  clearBlueprintSpecificationSnapshotCache,
} from '@papercusp/operator-core/lib/blueprint/project-to-pg';

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;

const WS = 'ws_test';

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `bp_${randomBytes(5).toString('hex')}`;
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
  // Table shape mirrors migration 133 (sans RLS/grants — those are exercised by
  // fresh-migrate.integration.test.ts).
  await sql.unsafe(`
    CREATE TABLE harness_shared.blueprints (
      workspace_id  text NOT NULL,
      harness_slug  text NOT NULL,
      blueprint_id  text NOT NULL,
      version       text NOT NULL DEFAULT '0.1.0',
      resolved      jsonb NOT NULL,
      content_hash  text NOT NULL,
      source_path   text,
      source_commit text,
      projected_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug)
    )
  `);
  await sql.unsafe(`
    CREATE TABLE harness_shared.blueprint_specifications (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      specification_revision text NOT NULL,
      artifact jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, specification_revision),
      CHECK (artifact->>'specificationRevision' = specification_revision)
    )
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

it('projects + reads back the resolved coding blueprint', async () => {
  const loaded = loadBuiltinBlueprint('coding-factory');
  const { contentHash, specification } = await projectBlueprintToPg(sql, {
    workspaceId: WS,
    harnessSlug: 'demo',
    blueprint: loaded.blueprint,
    loaded,
  });
  // The current cache key is the complete compiled specification revision when
  // a loaded source is available, including prompt/package inputs.
  expect(contentHash).toBe(specification?.specificationRevision);

  const read = await readBlueprintFromPg(sql, WS, 'demo');
  expect(read).not.toBeNull();
  expect(read!.id).toBe('coding-factory');
  // The round-tripped (jsonb → schema-parse) blueprint equals the loaded one.
  expect(read).toEqual(loaded.blueprint);
  expect(await readBlueprintHashFromPg(sql, WS, 'demo')).toBe(contentHash);
});

it('upsert overwrites the same (workspace, harness) row', async () => {
  const coding = loadBuiltinBlueprint('coding-factory').blueprint;
  await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: 'up', blueprint: coding });
  // Re-project a mutated version → row is replaced, not duplicated.
  const bumped = { ...coding, version: '9.9.9' };
  await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: 'up', blueprint: bumped });

  const rows = await sql`SELECT version FROM harness_shared.blueprints WHERE workspace_id=${WS} AND harness_slug='up'`;
  expect(rows.length).toBe(1);
  expect(rows[0].version).toBe('9.9.9');
});

it('reads are isolated by (workspace, harness)', async () => {
  const coding = loadBuiltinBlueprint('coding-factory').blueprint;
  await projectBlueprintToPg(sql, { workspaceId: 'ws_a', harnessSlug: 'shared-slug', blueprint: coding });
  expect(await readBlueprintFromPg(sql, 'ws_b', 'shared-slug')).toBeNull();
  expect(await readBlueprintFromPg(sql, 'ws_a', 'shared-slug')).not.toBeNull();
});

it('keeps accepted operation revision A after the mutable blueprint cache moves to B', async () => {
  const operation = {
    id: 'extract', version: 'A', target: { kind: 'work-item', itemKind: 'feature' },
    execution: { kind: 'agent', role: 'worker' },
    inputSchema: { type: 'object', properties: { itemId: { type: 'string' } } },
    acceptance: { resultSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    policy: {
      identity: { kind: 'identity', ref: 'snapshot-worker', revision: '1.0.0', contentHash: 'b'.repeat(64) },
      model: { mode: 'exact', models: ['gpt-6-sol'], onUnavailable: 'fail' },
    },
  };
  const source = {
    id: 'snapshot-fixture', workItem: { kind: 'feature' }, roles: [{ id: 'worker' }],
    spine: { edges: { DONE: { to: 'done' } } }, operations: [operation],
  };
  const a = compileAgentSpecification({ source });
  await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: 'snapshot-demo', blueprint: BlueprintSchema.parse(source), specification: a });
  const acceptedRevision = a.specificationRevision;
  const bSource = { ...source, operations: [{ ...operation, version: 'B', policy: { ...operation.policy, model: { mode: 'exact', models: ['gpt-6-luna'], onUnavailable: 'fail' } } }] };
  const b = compileAgentSpecification({ source: bSource });
  await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: 'snapshot-demo', blueprint: BlueprintSchema.parse(bSource), specification: b });

  expect(await readBlueprintHashFromPg(sql, WS, 'snapshot-demo')).toBe(b.specificationRevision);
  const retained = await readBlueprintSpecificationSnapshot(sql, WS, 'snapshot-demo', acceptedRevision);
  expect(retained?.specificationRevision).toBe(acceptedRevision);
  expect(operationFromSpecification(retained!, 'extract').operation).toMatchObject({
    version: 'A', execution: { kind: 'agent', role: 'worker' },
    inputSchema: { type: 'object' }, policy: {
      identity: { kind: 'identity', ref: 'snapshot-worker', revision: '1.0.0', contentHash: 'b'.repeat(64) },
      model: { mode: 'exact', models: ['gpt-6-sol'] },
    },
  });
  expect(await readBlueprintSpecificationSnapshot(sql, 'other-workspace', 'snapshot-demo', acceptedRevision)).toBeNull();
  expect(await readBlueprintSpecificationSnapshot(sql, WS, 'other-harness', acceptedRevision)).toBeNull();
  expect((await sql`SELECT count(*)::int AS n FROM harness_shared.blueprint_specifications WHERE workspace_id=${WS} AND harness_slug='snapshot-demo'`)[0].n).toBe(2);

  // WI-10003631: an accepted revision is immutable, so repeat reads are served from the
  // process cache (no PG round trip) as one shared, deep-frozen snapshot; misses are not cached.
  clearBlueprintSpecificationSnapshotCache();
  let queries = 0;
  const counting = ((...args: Parameters<typeof sql>) => { queries++; return sql(...args); }) as unknown as typeof sql;
  const first = await readBlueprintSpecificationSnapshot(counting, WS, 'snapshot-demo', acceptedRevision);
  expect(queries).toBe(1);
  const second = await readBlueprintSpecificationSnapshot(counting, WS, 'snapshot-demo', acceptedRevision);
  expect(queries).toBe(1);
  expect(second).toBe(first);
  expect(Object.isFrozen(second)).toBe(true);
  expect(Object.isFrozen(operationFromSpecification(second!, 'extract').operation)).toBe(true);
  // A miss is never cached: each one goes back to PG.
  expect(await readBlueprintSpecificationSnapshot(counting, WS, 'other-harness', acceptedRevision)).toBeNull();
  expect(await readBlueprintSpecificationSnapshot(counting, WS, 'other-harness', acceptedRevision)).toBeNull();
  expect(queries).toBe(3);
});
