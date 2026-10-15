/**
 * WI-6554700010009155 (owner directive #1746) — migration 1474: a local ordinary-queue work row
 * may only ENTER status 'blocked' when it names its blocker. Runs the real migration SQL against
 * a scratch database holding the minimal columns the trigger reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.resolve(here, '../../../libs/papercusp/libs/db/sql');
const armed = path.join(sqlDir, '1474-blocked-requires-named-blocker.sql');
const migrationPath = existsSync(armed) ? armed : `${armed}.DRAFT`;

let sql: postgres.Sql;
let adminUri: string;
let dbName: string;

const WS = 'ws-test';
let seq = 0;
const nextId = () => `WI-T${++seq}`;

async function insert(row: {
  status: string;
  payload?: Record<string, unknown>;
  nature?: string;
  lane?: string | null;
  origin?: string;
  source_plan_slug?: string | null;
}): Promise<string> {
  const id = nextId();
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, feature_id, status, nature, lane, origin, payload, source_plan_slug)
    VALUES (${WS}, ${id}, ${row.status}, ${row.nature ?? 'work'}, ${row.lane ?? null}, ${row.origin ?? 'local'},
            ${sql.json((row.payload ?? {}) as postgres.JSONValue)}, ${row.source_plan_slug ?? null})`;
  return id;
}

const activeBlocker = { externalBlockers: [{ kind: 'gate', ref: 'deploy:3070', status: 'active' }] };

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `blocked_names_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, feature_id text NOT NULL, status text NOT NULL,
      nature text DEFAULT 'work', lane text, origin text DEFAULT 'local',
      payload jsonb DEFAULT '{}'::jsonb, source_plan_slug text, title text,
      PRIMARY KEY (workspace_id, feature_id)
    );
    CREATE TABLE harness_shared.work_item_deps (
      workspace_id text, blocked_ref text, blocker_ref text, satisfaction text
    );
  `);
  // A legacy row that was already blocked with no blocker BEFORE the rule existed.
  await sql`INSERT INTO harness_shared.work_items (workspace_id, feature_id, status) VALUES (${WS}, 'WI-LEGACY', 'blocked')`;
  await sql.unsafe(readFileSync(migrationPath, 'utf8'));
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (adminUri && dbName) {
    const admin = postgres(adminUri, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
});

describe('migration 1474: blocked requires a named blocker', () => {
  it('refuses a work row created straight into blocked with nothing named', async () => {
    await expect(insert({ status: 'blocked' })).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/cannot enter status blocked without naming its blocker/),
    });
  });

  it('refuses when every recorded external blocker is already cleared', async () => {
    await expect(
      insert({ status: 'blocked', payload: { externalBlockers: [{ kind: 'gate', ref: 'x', status: 'cleared' }] } }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts each way of naming the blocker', async () => {
    await expect(insert({ status: 'blocked', payload: activeBlocker })).resolves.toBeTypeOf('string');
    await expect(insert({ status: 'blocked', payload: { blockedReason: 'leader triage: flapping test' } })).resolves.toBeTypeOf('string');
    await expect(insert({ status: 'blocked', source_plan_slug: 'some-plan-2026-10-12' })).resolves.toBeTypeOf('string');
    const depId = `WI-T${seq + 1}`;
    await sql`INSERT INTO harness_shared.work_item_deps (workspace_id, blocked_ref, blocker_ref) VALUES (${WS}, ${depId}, 'WI-OTHER')`;
    await expect(insert({ status: 'blocked' })).resolves.toBe(depId);
  });

  it('refuses a whitespace-only leader-triage reason', async () => {
    await expect(insert({ status: 'blocked', payload: { blockedReason: '   ' } })).rejects.toMatchObject({ code: '23514' });
  });

  it('judges the open -> blocked transition, and accepts it when the blocker lands in the same write', async () => {
    const id = await insert({ status: 'open' });
    await expect(
      sql`UPDATE harness_shared.work_items SET status = 'blocked' WHERE feature_id = ${id}`,
    ).rejects.toMatchObject({ code: '23514' });
    await sql`
      UPDATE harness_shared.work_items
         SET status = 'blocked', payload = payload || ${sql.json(activeBlocker as postgres.JSONValue)}
       WHERE feature_id = ${id}`;
    const [row] = await sql`SELECT status FROM harness_shared.work_items WHERE feature_id = ${id}`;
    expect(row.status).toBe('blocked');
  });

  it('accepts the set_blocker order: payload first, then the status flip', async () => {
    const id = await insert({ status: 'open' });
    await sql`UPDATE harness_shared.work_items SET payload = ${sql.json(activeBlocker as postgres.JSONValue)} WHERE feature_id = ${id}`;
    await expect(sql`UPDATE harness_shared.work_items SET status = 'blocked' WHERE feature_id = ${id}`).resolves.toBeDefined();
  });

  it('never fails an unrelated write to a row that was already blocked before the rule', async () => {
    await expect(sql`UPDATE harness_shared.work_items SET title = 'touched' WHERE feature_id = 'WI-LEGACY'`).resolves.toBeDefined();
    await expect(sql`UPDATE harness_shared.work_items SET status = 'blocked' WHERE feature_id = 'WI-LEGACY'`).resolves.toBeDefined();
    await expect(sql`UPDATE harness_shared.work_items SET status = 'open' WHERE feature_id = 'WI-LEGACY'`).resolves.toBeDefined();
  });

  it('leaves records, special lanes and federated rows alone', async () => {
    await expect(insert({ status: 'blocked', nature: 'record' })).resolves.toBeTypeOf('string');
    await expect(insert({ status: 'blocked', lane: 'observation' })).resolves.toBeTypeOf('string');
    await expect(insert({ status: 'blocked', origin: 'remote' })).resolves.toBeTypeOf('string');
  });
});
