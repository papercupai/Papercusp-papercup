/**
 * consult-dispatch-record.integration.test.ts — the persisted dispatch record
 * (WI-10003197, plan review-routing-through-relevance-router-2026-09-26 P-001).
 *
 * Every consult answering-session dispatch walk is appended to
 * `consult_state.dispatch_attempts` (migration 1225), so a refused fork or
 * convert is visible from the consult row instead of only from fleet-logs.
 *
 * WHY real Postgres: the bound (newest N, in append order) and the "leaves
 * updated_at alone" contract are both properties of one SQL statement. A fake
 * `sql` would only restate what the statement was meant to do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import {
  DISPATCH_RECORDS_MAX,
  SOURCE_LAUNCH_FAILURE_THRESHOLD,
  appendDispatchRecord,
  readSourceDispatchRecords,
  sourceCooldownFrom,
  type ConsultDispatchRecordInput,
} from './consult-dispatch';

const WS = 'ws-dispatch-record';
const sqlPath = (name: string) =>
  fileURLToPath(new URL(`../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url));
/** A migration's armed `.sql`, or its `.DRAFT` while still being iterated. */
const migration = (name: string) => (existsSync(sqlPath(name)) ? sqlPath(name) : `${sqlPath(name)}.DRAFT`);

let sql: Sql;
let fixtureDb: MigratedTestDb;

/** A row that existed BEFORE migration 1225 — the column default must backfill it. */
const PRE_EXISTING = 'conv-before-1225';

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'consultrec' });
  sql = postgres(fixtureDb.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  // Landing pad for 834's coord_conversations kind-CHECK widening (see
  // consult-verbs-core.integration.test.ts); only `kind` matters here.
  await sql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL,
      id text NOT NULL,
      kind text NOT NULL DEFAULT 'question',
      state text NOT NULL DEFAULT 'open',
      accepted_answer text,
      accepted_post_id bigint,
      updated_at timestamptz,
      resolved_at timestamptz,
      PRIMARY KEY (workspace_id, id)
    )`);
  // The REAL migrations, so the column and its default cannot drift from the test.
  await sql.unsafe(readFileSync(sqlPath('834-consult-threads.sql'), 'utf8'));
  await sql.unsafe(readFileSync(migration('844-consult-cascade-cursor.sql'), 'utf8'));
  await seed(PRE_EXISTING);
  await sql.unsafe(readFileSync(migration('1225-consult-dispatch-attempts.sql'), 'utf8'));
}, 120_000);

afterAll(async () => {
  try { await sql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

async function seed(conversationId: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, question, updated_at)
    VALUES (${WS}, ${conversationId}, 'su-requester', 'why?', '2026-09-01T00:00:00Z')
  `;
}

async function readRecords(conversationId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await sql<Array<{ dispatch_attempts: Array<Record<string, unknown>> }>>`
    SELECT dispatch_attempts FROM harness_shared.consult_state
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
  `;
  return rows[0]!.dispatch_attempts;
}

function input(conversationId: string, detail: string, launchError?: string): ConsultDispatchRecordInput {
  return {
    workspaceId: WS,
    conversationId,
    sourceOwnerId: 'su-expert',
    result: {
      dispatched: false,
      answeringOwnerId: null,
      operation: null,
      agent: null,
      model: null,
      verified: false,
      detail,
      attempts: [
        {
          rank: 1,
          agent: 'claude',
          model: 'opus',
          operation: 'fork',
          outcome: 'failed',
          reason: 'launch-exited',
          detail: `rank 1 of ${detail}`,
          ...(launchError ? { launchError } : {}),
        },
      ],
    },
  };
}

describe('migration 1225 — consult_state.dispatch_attempts', () => {
  it('backfills a row that existed before the migration with an empty array', async () => {
    expect(await readRecords(PRE_EXISTING)).toEqual([]);
  });

  it('is re-runnable (ADD COLUMN IF NOT EXISTS)', async () => {
    await expect(
      sql.unsafe(readFileSync(migration('1225-consult-dispatch-attempts.sql'), 'utf8')),
    ).resolves.toBeDefined();
  });
});

describe('appendDispatchRecord (real Postgres)', () => {
  it('appends one record carrying the per-rank reason and the launcher’s own words', async () => {
    await seed('conv-one');
    const why = 'psu: refusing unmanaged fork su-x: could not recover adv row #?.';
    await appendDispatchRecord(sql, input('conv-one', 'walk-1', why), '2026-09-26T03:00:00.000Z');
    const records = await readRecords('conv-one');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      at: '2026-09-26T03:00:00.000Z',
      sourceOwnerId: 'su-expert',
      dispatched: false,
      detail: 'walk-1',
      attempts: [{ rank: 1, agent: 'claude', outcome: 'failed', reason: 'launch-exited', launchError: why }],
    });
  });

  it('stores each record as a jsonb OBJECT on a plain client, not a double-encoded jsonb string', async () => {
    // This client deliberately lacks the canonical hybrid jsonb serializer; a
    // bare `${text}::jsonb` param stored 'string' here (the defect this pins).
    await seed('conv-typeof');
    await appendDispatchRecord(sql, input('conv-typeof', 'walk-1'), '2026-09-26T03:00:00.000Z');
    const rows = await sql<Array<{ t: string }>>`
      SELECT jsonb_typeof(e) AS t
        FROM harness_shared.consult_state, jsonb_array_elements(dispatch_attempts) e
       WHERE workspace_id = ${WS} AND conversation_id = 'conv-typeof'
    `;
    expect(rows.map((r) => r.t)).toEqual(['object']);
  });

  it(`keeps only the newest ${DISPATCH_RECORDS_MAX}, in append order`, async () => {
    await seed('conv-bound');
    const total = DISPATCH_RECORDS_MAX + 6;
    for (let i = 1; i <= total; i++) {
      await appendDispatchRecord(sql, input('conv-bound', `walk-${i}`), `2026-09-26T03:00:${String(i).padStart(2, '0')}.000Z`);
    }
    const details = (await readRecords('conv-bound')).map((r) => r.detail);
    const expected = Array.from({ length: DISPATCH_RECORDS_MAX }, (_, k) => `walk-${total - DISPATCH_RECORDS_MAX + 1 + k}`);
    expect(details).toEqual(expected);
  });

  it('leaves updated_at alone — recording evidence is not consult activity', async () => {
    await seed('conv-updated-at');
    await appendDispatchRecord(sql, input('conv-updated-at', 'walk-1'), '2026-09-26T03:00:00.000Z');
    const rows = await sql<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = 'conv-updated-at'
    `;
    expect(rows[0]!.updated_at.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('touches only its own consult', async () => {
    await seed('conv-mine');
    await seed('conv-other');
    await appendDispatchRecord(sql, input('conv-mine', 'walk-1'), '2026-09-26T03:00:00.000Z');
    expect(await readRecords('conv-other')).toEqual([]);
    // an unknown consult is a no-op, not an error
    await expect(
      appendDispatchRecord(sql, input('conv-missing', 'walk-1'), '2026-09-26T03:00:00.000Z'),
    ).resolves.toBeUndefined();
  });

  it('stores text with quotes, backslashes and non-ASCII verbatim (the ::jsonb text-param path)', async () => {
    await seed('conv-escape');
    const tricky = `psu: "quoted" \\ back\\slash · résumé ✓ {not:json}`;
    await appendDispatchRecord(sql, input('conv-escape', tricky, tricky), '2026-09-26T03:00:00.000Z');
    const [rec] = await readRecords('conv-escape');
    expect(rec!.detail).toBe(tricky);
    expect((rec!.attempts as Array<Record<string, unknown>>)[0]!.launchError).toBe(tricky);
  });
});

// WI-10003198 (P-002): the source cool-down is DERIVED from these records, so
// the read that feeds it is one SQL statement over the same column. If it read
// nothing (a wrong key, a double-encoded element, a bad `at` comparison), the
// cool-down would fail open and the relaunch storm would return without any
// error. Only real Postgres can show the statement selects what it claims to.
describe('readSourceDispatchRecords (real Postgres) — the cool-down read', () => {
  const OTHER_WS = 'ws-dispatch-record-other';
  const SINCE = '2026-09-26T00:00:00.000Z';

  function walk(conversationId: string, sourceOwnerId: string, workspaceId = WS): ConsultDispatchRecordInput {
    return { ...input(conversationId, `walk-${conversationId}`), workspaceId, sourceOwnerId };
  }

  beforeAll(async () => {
    await seed('conv-cd-a');
    await seed('conv-cd-b');
    await sql`
      INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, question)
      VALUES (${OTHER_WS}, 'conv-cd-other-ws', 'su-requester', 'why?')
    `;
    // In scope: su-cooling, this workspace, at/after SINCE, spread across two consults.
    await appendDispatchRecord(sql, walk('conv-cd-a', 'su-cooling'), '2026-09-26T03:00:00.000Z');
    await appendDispatchRecord(sql, walk('conv-cd-b', 'su-cooling'), '2026-09-26T03:05:00.000Z');
    await appendDispatchRecord(sql, walk('conv-cd-a', 'su-cooling'), '2026-09-26T03:10:00.000Z');
    // Out of scope, one axis each.
    await appendDispatchRecord(sql, walk('conv-cd-a', 'su-cooling'), '2026-09-25T23:59:59.999Z'); // before SINCE
    await appendDispatchRecord(sql, walk('conv-cd-b', 'su-someone-else'), '2026-09-26T03:20:00.000Z'); // other source
    await appendDispatchRecord(sql, walk('conv-cd-other-ws', 'su-cooling', OTHER_WS), '2026-09-26T03:30:00.000Z'); // other workspace
  });

  it("returns only that source's walks in that workspace since the cut-off, newest first, across consults", async () => {
    const records = await readSourceDispatchRecords(sql, WS, 'su-cooling', SINCE);
    expect(records.map((r) => r.at)).toEqual([
      '2026-09-26T03:10:00.000Z',
      '2026-09-26T03:05:00.000Z',
      '2026-09-26T03:00:00.000Z',
    ]);
    for (const r of records) {
      expect(typeof r).toBe('object');
      expect(r.sourceOwnerId).toBe('su-cooling');
    }
  });

  it('honours the row limit, keeping the newest', async () => {
    const records = await readSourceDispatchRecords(sql, WS, 'su-cooling', SINCE, 2);
    expect(records.map((r) => r.at)).toEqual(['2026-09-26T03:10:00.000Z', '2026-09-26T03:05:00.000Z']);
  });

  it('returns nothing for a source with no walks — no cool-down, not an error', async () => {
    await expect(readSourceDispatchRecords(sql, WS, 'su-never-routed', SINCE)).resolves.toEqual([]);
  });

  it('feeds sourceCooldownFrom records it can count: three failed launches start the cool-down', async () => {
    expect(SOURCE_LAUNCH_FAILURE_THRESHOLD).toBe(3);
    const records = await readSourceDispatchRecords(sql, WS, 'su-cooling', SINCE);
    const cooldown = sourceCooldownFrom(records, Date.parse('2026-09-26T03:15:00.000Z'));
    expect(cooldown).toMatchObject({
      failures: 3,
      until: '2026-09-26T04:10:00.000Z',
    });
    expect(cooldown!.lastFailure).toMatch(/^launch-exited on claude\/opus/);
  });
});
