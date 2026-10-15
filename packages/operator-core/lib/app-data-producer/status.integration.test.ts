import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { countPendingRows, readPushRollup } from './status';

/**
 * Real-database coverage for the two SQL edges of the producer status read.
 *
 * WHY THIS FILE EXISTS. status.test.ts injects `readRollup` and `countPending`
 * in every case, so it covers readAppProducerStatus's orchestration and NONE of
 * the SQL underneath it — the suite stays green while both queries have zero
 * coverage. status.ts used to carry a comment asserting the queries were "ALSO
 * exercised against the live corpus"; no such check existed (EI-21857366890440494,
 * found during independent acceptance grading). This is that check.
 *
 * The workspace is the shared fixture workspace, because trigger_deliveries has
 * FKs onto data_sources and datatype_registry. Isolation comes from a fresh
 * user uuid per run: both queries are scoped by user, which is exactly the
 * scoping property worth testing.
 */

const WS = 'papercusp-workspace';
/** Vault category label. Display-only after D-010; it no longer routes. */
const SOURCE = 'google-calendar';
/** The canonical datatype countPendingRows selects on (D-010). */
const DATATYPE = 'calendar-event';

let org: OrgTestDb;
let sql: Sql;
let sourceId: string;
let userId: string;
/** A second user whose id has userId as a string PREFIX would be a false match. */
let neighbourId: string;

async function makeUser(label: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`app-status-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${label})
    RETURNING id`;
  return user.id;
}

async function delivery(
  opts: { ref: string; outcome: 'delivered' | 'failed' | 'pending'; error?: string; updatedAt?: string },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
       sink_kind, sink_ref, outcome, error, completed_at, updated_at)
    VALUES (
      ${WS}, ${sourceId}, ${`dedupe-${Math.random().toString(36).slice(2)}`},
      'calendar-event', 'status.integration.test', '{}'::jsonb,
      'app-delivery', ${opts.ref}, ${opts.outcome}, ${opts.error ?? null},
      ${opts.outcome === 'delivered' ? new Date().toISOString() : null},
      ${opts.updatedAt ?? new Date().toISOString()}
    )`;
}

async function document(occurredAt: string | null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.documents
      (workspace_id, user_id, source, datatype_id, kind, dedupe_key, occurred_at)
    VALUES (${WS}, ${userId}, ${SOURCE}, ${DATATYPE}, 'event',
            ${`doc-${Math.random().toString(36).slice(2)}`}, ${occurredAt})
    RETURNING id`;
  return row.id;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES (${WS}, 'google-calendar', 'connected') RETURNING id`;
  sourceId = source.id;
  userId = await makeUser('subject');
  neighbourId = await makeUser('neighbour');
}, 120_000);

afterAll(async () => {
  if (sql) {
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ${sourceId}`.catch(() => {});
    await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND id = ${sourceId}`.catch(() => {});
    for (const id of [userId, neighbourId]) {
      if (id) {
        await sql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND user_id = ${id}`.catch(() => {});
        await sql`DELETE FROM harness_shared.users WHERE id = ${id}`.catch(() => {});
      }
    }
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ${sourceId}`;
  await sql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND user_id IN (${userId}, ${neighbourId})`;
});

describe('readPushRollup (real SQL)', () => {
  it('returns an all-zero rollup when the user has no deliveries', async () => {
    const rollup = await readPushRollup(sql, WS, userId);
    expect(rollup).toMatchObject({ delivered: 0, failed: 0, pending: 0, lastError: null });
  });

  it('counts each outcome and surfaces the MOST RECENT failure text', async () => {
    await delivery({ ref: `user:${userId}`, outcome: 'delivered' });
    await delivery({ ref: `user:${userId}`, outcome: 'delivered' });
    await delivery({ ref: `user:${userId}`, outcome: 'pending' });
    await delivery({ ref: `user:${userId}`, outcome: 'failed', error: 'older failure', updatedAt: '2026-01-01T00:00:00Z' });
    await delivery({ ref: `user:${userId}`, outcome: 'failed', error: 'newest failure', updatedAt: '2026-06-01T00:00:00Z' });

    const rollup = await readPushRollup(sql, WS, userId);
    expect(rollup.delivered).toBe(2);
    expect(rollup.pending).toBe(1);
    expect(rollup.failed).toBe(2);
    // ORDER BY updated_at DESC — the newest failure is the actionable one.
    expect(rollup.lastError).toBe('newest failure');
    expect(rollup.lastErrorAt).not.toBeNull();
    expect(rollup.lastDeliveredAt).not.toBeNull();
  });

  it('matches the suffixed sink_ref form as well as the bare one', async () => {
    await delivery({ ref: `user:${userId}`, outcome: 'delivered' });
    await delivery({ ref: `user:${userId}:calendar`, outcome: 'delivered' });
    expect((await readPushRollup(sql, WS, userId)).delivered).toBe(2);
  });

  it('does NOT match another user whose ref merely starts with the same text', async () => {
    // The anchoring property the query is written for: `user:<a>` must not also
    // match `user:<a-something-else>`. Constructed rather than relying on two
    // real uuids happening to share a prefix.
    await delivery({ ref: `user:${userId}-other`, outcome: 'failed', error: 'not mine' });
    await delivery({ ref: `user:${neighbourId}`, outcome: 'failed', error: 'also not mine' });

    const rollup = await readPushRollup(sql, WS, userId);
    expect(rollup.failed).toBe(0);
    expect(rollup.lastError).toBeNull();
  });

  it('ignores deliveries from a different sink_kind', async () => {
    await sql`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload, sink_kind, sink_ref, outcome)
      VALUES (${WS}, ${sourceId}, ${`dedupe-${Math.random().toString(36).slice(2)}`},
              'calendar-event', 'status.integration.test', '{}'::jsonb,
              'personal-vault', ${`user:${userId}`}, 'failed')`;
    expect((await readPushRollup(sql, WS, userId)).failed).toBe(0);
  });
});

describe('countPendingRows (real SQL)', () => {
  it('counts every row for the user when the cursor is null', async () => {
    await document('2026-03-01T00:00:00Z');
    await document('2026-03-02T00:00:00Z');
    expect(await countPendingRows(sql, WS, userId, DATATYPE,null)).toBe(2);
  });

  it('counts only rows ordered AFTER the cursor', async () => {
    await document('2026-03-01T00:00:00Z');
    const mid = await document('2026-03-02T00:00:00Z');
    await document('2026-03-03T00:00:00Z');

    const cursor = `2026-03-02T00:00:00.000Z|${mid}`;
    // Strictly greater than (occurred_at, id): the cursor row itself is excluded.
    expect(await countPendingRows(sql, WS, userId, DATATYPE,cursor)).toBe(1);
  });

  it('falls back to imported_at when occurred_at is null', async () => {
    await document(null);
    // A null occurred_at must still be counted via COALESCE, not silently dropped.
    expect(await countPendingRows(sql, WS, userId, DATATYPE,null)).toBe(1);
  });

  it('does not count another user, or another datatype', async () => {
    await document('2026-03-01T00:00:00Z');
    await sql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, source, datatype_id, kind, dedupe_key, occurred_at)
      VALUES (${WS}, ${neighbourId}, ${SOURCE}, ${DATATYPE}, 'event',
              ${`doc-${Math.random().toString(36).slice(2)}`}, '2026-03-01T00:00:00Z')`;
    // Same SOURCE label, different datatype: D-010 routes by datatype, so a
    // shared provider-named label must not leak rows into this app's count.
    await sql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, source, datatype_id, kind, dedupe_key, occurred_at)
      VALUES (${WS}, ${userId}, ${SOURCE}, 'email-message', 'message',
              ${`doc-${Math.random().toString(36).slice(2)}`}, '2026-03-01T00:00:00Z')`;

    expect(await countPendingRows(sql, WS, userId, DATATYPE, null)).toBe(1);
  });

  it('counts a non-Google provider row of the same datatype (routing is provider-neutral)', async () => {
    await document('2026-03-01T00:00:00Z');
    await sql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, source, datatype_id, kind, dedupe_key, occurred_at)
      VALUES (${WS}, ${userId}, 'outlook-fixture', ${DATATYPE}, 'event',
              ${`doc-${Math.random().toString(36).slice(2)}`}, '2026-03-01T00:00:00Z')`;

    expect(await countPendingRows(sql, WS, userId, DATATYPE, null)).toBe(2);
  });

  it('treats a malformed cursor as no cursor rather than counting zero', async () => {
    await document('2026-03-01T00:00:00Z');
    // parseReconcileCursor returns null for these, so the unbounded branch runs.
    expect(await countPendingRows(sql, WS, userId, DATATYPE,'not-a-cursor')).toBe(1);
    expect(await countPendingRows(sql, WS, userId, DATATYPE,'')).toBe(1);
  });
});
