/**
 * WI-6554700010009273 — migration 1477 amends the migration-1474 rule "a local ordinary-queue
 * work row may only ENTER status 'blocked' when it names its blocker":
 *   - payload.blockedReason vouches only when payload.blockedAt is fresh (≤15 min old), so a
 *     leftover reason on a reopened or failed-review row cannot let an unrelated write through;
 *   - a pending agent review is a named blocker, so the improvements:capture review park is no
 *     longer refused (EI-25807214698674439).
 * Runs the real 1474 + 1477 SQL against a scratch database holding the columns the trigger reads.
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
function migration(name: string): string {
  const armed = path.join(sqlDir, name);
  return existsSync(armed) ? armed : `${armed}.DRAFT`;
}
const MIGRATIONS = [
  migration('1474-blocked-requires-named-blocker.sql'),
  migration('1477-blocked-reason-freshness-and-review-park.sql'),
];

let sql: postgres.Sql;
let adminUri: string;
let dbName: string;

const WS = 'ws-test';
let seq = 0;
const nextId = () => `WI-F${++seq}`;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const REFUSED = { code: '23514', message: expect.stringMatching(/cannot enter status blocked without naming its blocker/) };

async function insert(row: { status: string; payload?: Record<string, unknown> }): Promise<string> {
  const id = nextId();
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, feature_id, status, payload)
    VALUES (${WS}, ${id}, ${row.status}, ${sql.json((row.payload ?? {}) as postgres.JSONValue)})`;
  return id;
}

async function setPayload(id: string, payload: Record<string, unknown>): Promise<void> {
  await sql`UPDATE harness_shared.work_items SET payload = payload || ${sql.json(payload as postgres.JSONValue)} WHERE feature_id = ${id}`;
}

function flip(id: string) {
  return sql`UPDATE harness_shared.work_items SET status = 'blocked' WHERE feature_id = ${id}`;
}

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `blocked_fresh_${randomBytes(5).toString('hex')}`;
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
  for (const file of MIGRATIONS) await sql.unsafe(readFileSync(file, 'utf8'));
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

describe('migration 1477: a leader-triage reason only vouches while it is fresh', () => {
  it('accepts the markLeaderTriage order: fresh reason + blockedAt in one write, then the flip', async () => {
    const id = await insert({ status: 'open' });
    await setPayload(id, { blockedReason: 'implement-worker:needs-human-untyped', blockedAt: new Date().toISOString() });
    await expect(flip(id)).resolves.toBeDefined();
  });

  it('refuses a leftover reason whose blockedAt is older than 15 minutes (a reopened triage row)', async () => {
    const id = await insert({ status: 'open', payload: { blockedReason: 'retries-exhausted', blockedAt: minutesAgo(16) } });
    await expect(flip(id)).rejects.toMatchObject(REFUSED);
  });

  it('accepts a reason stamped 14 minutes ago', async () => {
    const id = await insert({ status: 'open', payload: { blockedReason: 'retries-exhausted', blockedAt: minutesAgo(14) } });
    await expect(flip(id)).resolves.toBeDefined();
  });

  it('refuses a reason with no blockedAt, a malformed one, or one far in the future', async () => {
    await expect(insert({ status: 'blocked', payload: { blockedReason: 'leader triage: flapping test' } })).rejects.toMatchObject(REFUSED);
    await expect(
      insert({ status: 'blocked', payload: { blockedReason: 'x', blockedAt: 'not-a-timestamp' } }),
    ).rejects.toMatchObject(REFUSED);
    await expect(
      insert({ status: 'blocked', payload: { blockedReason: 'x', blockedAt: new Date(Date.now() + 3_600_000).toISOString() } }),
    ).rejects.toMatchObject(REFUSED);
  });

  it('refuses the stale "agent-review-block-failed" stamp a failed capture review leaves on an open row', async () => {
    const id = await insert({
      status: 'open',
      payload: { blockedReason: 'agent-review-block-failed', blockedAt: minutesAgo(30) },
    });
    await expect(flip(id)).rejects.toMatchObject(REFUSED);
  });
});

describe('migration 1477: a pending agent review is a named blocker', () => {
  it('accepts the improvements:capture review park (readiness awaiting-agent-review, then the flip)', async () => {
    const id = await insert({
      status: 'open',
      payload: { implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review', source: 'capture-policy' } },
    });
    await expect(flip(id)).resolves.toBeDefined();
  });

  it('accepts an enrolled review that is pending or awaiting revision', async () => {
    await expect(insert({ status: 'blocked', payload: { agentReview: { status: 'pending' } } })).resolves.toBeTypeOf('string');
    await expect(insert({ status: 'blocked', payload: { agentReview: { status: 'revision-requested' } } })).resolves.toBeTypeOf('string');
  });

  it('refuses a review that is already decided, or a readiness that is not waiting on review', async () => {
    await expect(insert({ status: 'blocked', payload: { agentReview: { status: 'approved' } } })).rejects.toMatchObject(REFUSED);
    await expect(
      insert({ status: 'blocked', payload: { implementationReadiness: { status: 'ready', reason: 'reviewed' } } }),
    ).rejects.toMatchObject(REFUSED);
  });
});

describe('migration 1477 keeps every 1474 rule', () => {
  it('still refuses a bare blocked write and still accepts the other ways of naming the blocker', async () => {
    await expect(insert({ status: 'blocked' })).rejects.toMatchObject(REFUSED);
    await expect(
      insert({ status: 'blocked', payload: { externalBlockers: [{ kind: 'gate', ref: 'deploy:3070', status: 'active' }] } }),
    ).resolves.toBeTypeOf('string');
    const planId = nextId();
    await sql`INSERT INTO harness_shared.work_items (workspace_id, feature_id, status, source_plan_slug)
              VALUES (${WS}, ${planId}, 'blocked', 'some-plan-2026-10-12')`;
    const depId = `WI-F${seq + 1}`;
    await sql`INSERT INTO harness_shared.work_item_deps (workspace_id, blocked_ref, blocker_ref) VALUES (${WS}, ${depId}, 'WI-OTHER')`;
    await expect(insert({ status: 'blocked' })).resolves.toBe(depId);
  });

  it('never re-judges a row that is already blocked', async () => {
    const id = await insert({ status: 'blocked', payload: { blockedReason: 'fresh', blockedAt: new Date().toISOString() } });
    await setPayload(id, { blockedAt: minutesAgo(120) });
    await expect(flip(id)).resolves.toBeDefined();
  });
});
