/**
 * Blocker auto-clear against a real Postgres (plan derived-status-not-hand-written-2026-10-12#P-011).
 *
 * The unit test (work-item-ref-blocker-auto-clear.test.ts) drives the clear through a fake
 * transaction, so it never runs the SQL. This file runs `clearBlockersNamingFinishedWorkItems`
 * inside a real transaction over a scratch `harness_shared.work_items` holding the columns the
 * clear reads and writes, plus the real migration 1475 index.
 *
 * Clauses under test:
 *   AUTO-BAR-R-10-P-011 — when a work item referenced by another item's blocker reaches a
 *     terminal state, the blocker is cleared with history preserved.
 *   SPEC-P-011 — a blocker that references a non-terminal work item stays set.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { BLOCKER_AUTO_CLEAR_ACTOR, clearBlockersNamingFinishedWorkItems } from './work-item-ref-blocker-auto-clear';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.resolve(here, '../../../libs/papercusp/libs/db/sql');
const armed = path.join(sqlDir, '1475-work-items-external-blockers-partial-idx.sql');
const migrationPath = existsSync(armed) ? armed : `${armed}.DRAFT`;

const WS = 'ws-a';
const OTHER_WS = 'ws-b';
const T0 = '2026-10-12T10:00:00.000Z';
const NOW = '2026-10-12T18:45:00.000Z';

let sql: postgres.Sql;
let adminUri: string;
let dbName: string;

function blocker(ref: string, over: Record<string, unknown> = {}) {
  return {
    kind: 'runtime',
    capability: 'live-dependency',
    capabilitySource: 'explicit',
    ref,
    summary: `waiting on ${ref}`,
    status: 'active',
    createdAt: T0,
    createdBy: 'su-blocked-holder',
    updatedAt: T0,
    ...over,
  };
}

/** An issue that `work_items:set_blocker` auto-parked. */
function parkedIssuePayload(blockers: unknown[]) {
  return { externalBlockers: blockers, held_open_reason: 'blocked', held_open_by: 'su-x', _claimHold: { by: 'su-x' } };
}

async function insert(row: {
  ws?: string;
  id: string;
  kind?: string;
  status: string;
  payload?: Record<string, unknown>;
  takenBy?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, feature_id, item_kind, status, payload, harness_slug, taken_by, updated_ts)
    VALUES (${row.ws ?? WS}, ${row.id}, ${row.kind ?? 'bug'}, ${row.status},
            ${sql.json((row.payload ?? {}) as postgres.JSONValue)}, 'papercusp', ${row.takenBy ?? 'su-blocked-holder'}, 0)`;
}

async function read(id: string, ws = WS) {
  const [row] = await sql<{ status: string; payload: Record<string, unknown>; updated_ts: string }[]>`
    SELECT status, payload, updated_ts FROM harness_shared.work_items WHERE workspace_id = ${ws} AND feature_id = ${id}`;
  return row!;
}

function blockersOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return payload.externalBlockers as Array<Record<string, unknown>>;
}

async function runClear(ids: string[]) {
  return sql.begin((tx) =>
    clearBlockersNamingFinishedWorkItems(tx as unknown as postgres.TransactionSql, { workspaceId: WS, ids, now: NOW }),
  );
}

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `blocker_auto_clear_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  sql = postgres(url.toString(), { max: 2, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, feature_id text NOT NULL, item_kind text, status text,
      payload jsonb DEFAULT '{}'::jsonb, harness_slug text, taken_by text, updated_ts bigint,
      PRIMARY KEY (workspace_id, feature_id)
    );
  `);
  await sql.unsafe(readFileSync(migrationPath, 'utf8'));

  // The work items the blockers name.
  await insert({ id: 'WI-9', kind: 'feature', status: 'done' });
  await insert({ id: 'WI-8', kind: 'feature', status: 'wip' });
  await insert({ id: 'WI-90', kind: 'feature', status: 'wip' });
  await insert({ id: 'WI-7', kind: 'feature', status: 'dropped' });

  // EI-1: qualified ref naming the finished item → cleared, issue restored.
  await insert({ id: 'EI-1', status: 'blocked', payload: parkedIssuePayload([blocker('root-disk-headroom / WI-9')]) });
  // EI-2: ref names WI-90; the LIKE prefilter matches it, the whole-token check must not.
  await insert({ id: 'EI-2', status: 'blocked', payload: parkedIssuePayload([blocker('WI-90')]) });
  // EI-3: names a finished AND a still-open item → stays.
  await insert({ id: 'EI-3', status: 'blocked', payload: parkedIssuePayload([blocker('WI-9 + WI-8')]) });
  // EI-4: an owner ask that mentions the finished item → stays.
  await insert({
    id: 'EI-4',
    status: 'blocked',
    payload: parkedIssuePayload([blocker('owner signs off on WI-9', { kind: 'human', capability: 'product-decision' })]),
  });
  // EI-5: same blocker in another workspace → untouched.
  await insert({ ws: OTHER_WS, id: 'EI-5', status: 'blocked', payload: parkedIssuePayload([blocker('WI-9')]) });
  // EI-6: already terminal → not selected.
  await insert({ id: 'EI-6', status: 'done', payload: parkedIssuePayload([blocker('WI-9')]) });
  // WI-20: feature with a second active blocker → one cleared, status untouched.
  await insert({
    id: 'WI-20',
    kind: 'feature',
    status: 'blocked',
    payload: { externalBlockers: [blocker('WI-9'), blocker('gate:release', { kind: 'gate' })] },
  });
  // EI-7: names a finished item and a dropped one → cleared, the dropped id reported.
  await insert({ id: 'EI-7', status: 'blocked', payload: parkedIssuePayload([blocker('WI-9 and WI-7')]) });
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

describe('clearBlockersNamingFinishedWorkItems against Postgres', () => {
  it('AUTO-BAR-R-10: clears only satisfied live-dependency blockers, keeps history and restores parked issues', async () => {
    const out = await runClear(['WI-9']);

    expect(out.map((item) => item.featureId).sort()).toEqual(['EI-1', 'EI-7', 'WI-20']);
    const byId = new Map(out.map((item) => [item.featureId, item]));
    expect(byId.get('EI-1')).toMatchObject({ family: 'issue', status: 'open', restored: true, activeRemaining: 0 });
    expect(byId.get('EI-7')!.cleared[0]).toMatchObject({ namedIds: ['WI-9', 'WI-7'], endedWithoutDone: ['WI-7'] });
    expect(byId.get('WI-20')).toMatchObject({ family: 'feature', status: 'blocked', restored: false, activeRemaining: 1 });

    const ei1 = await read('EI-1');
    expect(ei1.status).toBe('open');
    expect(ei1.payload).not.toHaveProperty('held_open_reason');
    expect(ei1.payload).not.toHaveProperty('_claimHold');
    expect(Number(ei1.updated_ts)).toBe(Date.parse(NOW));
    // History kept: the record is still there, marked cleared, original fields intact.
    expect(blockersOf(ei1.payload)).toEqual([
      expect.objectContaining({
        ref: 'root-disk-headroom / WI-9',
        createdAt: T0,
        createdBy: 'su-blocked-holder',
        status: 'cleared',
        clearedAt: NOW,
        clearedBy: BLOCKER_AUTO_CLEAR_ACTOR,
        evidence: 'auto-cleared: WI-9 is done',
      }),
    ]);

    const wi20 = await read('WI-20');
    expect(wi20.status).toBe('blocked');
    expect(blockersOf(wi20.payload).map((b) => [b.ref, b.status])).toEqual([
      ['WI-9', 'cleared'],
      ['gate:release', 'active'],
    ]);
  });

  it('SPEC-P-011: leaves blockers naming a non-terminal item, owner asks, other workspaces and terminal rows alone', async () => {
    for (const id of ['EI-2', 'EI-3', 'EI-4']) {
      const row = await read(id);
      expect(row.status, id).toBe('blocked');
      expect(row.payload, id).toHaveProperty('held_open_reason', 'blocked');
      expect(blockersOf(row.payload).every((b) => b.status === 'active'), id).toBe(true);
      expect(Number(row.updated_ts), id).toBe(0);
    }
    const other = await read('EI-5', OTHER_WS);
    expect(blockersOf(other.payload)[0]).toMatchObject({ status: 'active' });
    expect(Number(other.updated_ts)).toBe(0);
    const terminal = await read('EI-6');
    expect(blockersOf(terminal.payload)[0]).toMatchObject({ status: 'active' });
  });

  it('SPEC-P-011: clears the multi-item blocker once its last named item finishes, and is idempotent', async () => {
    expect(await runClear(['WI-9'])).toEqual([]);

    await sql`UPDATE harness_shared.work_items SET status = 'done' WHERE workspace_id = ${WS} AND feature_id = 'WI-8'`;
    const out = await runClear(['WI-8']);
    expect(out.map((item) => item.featureId)).toEqual(['EI-3']);
    const ei3 = await read('EI-3');
    expect(ei3.status).toBe('open');
    expect(blockersOf(ei3.payload)[0]).toMatchObject({ status: 'cleared', evidence: 'auto-cleared: WI-9 is done, WI-8 is done' });
  });

  it('migration 1475: the clear predicate can use the partial index', async () => {
    const plan = await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      return tx.unsafe(
        `EXPLAIN SELECT feature_id FROM harness_shared.work_items wi
          WHERE wi.workspace_id = 'ws-a' AND wi.payload ? 'externalBlockers'`,
      );
    });
    const text = plan.map((row) => String((row as Record<string, unknown>)['QUERY PLAN'])).join('\n');
    expect(text).toContain('work_items_external_blockers_ws_idx');
  });
});
