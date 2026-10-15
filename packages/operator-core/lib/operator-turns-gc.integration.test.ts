/**
 * operator-turns-gc.integration.test.ts — gcOldOperatorTurns (WI-1637) against a
 * real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - it deletes ONLY turns older than retentionDays AND already folded into the
 *    conversation's rolling summary (seq <= summary_through_seq);
 *  - a turn NEWER than retentionDays survives regardless of compaction state;
 *  - a turn OLDER than retentionDays but NOT YET compacted (seq > summary_through_seq,
 *    or summary_through_seq NULL) is NEVER deleted — the compaction-boundary floor;
 *  - retentionDays controls the age cutoff;
 *  - batchLimit bounds a single run;
 *  - it returns the deleted count.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { gcOldOperatorTurns, OPERATOR_TURNS_GC_RETENTION_DAYS } = await import('./operator-turns-gc');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `otgc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // Minimal column subset — only what the GC touches. The real DDL has many
  // more columns (000-baseline.sql); this throwaway schema only needs to
  // prove the GC predicate + count, not the full shape.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      summary_through_seq integer
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL REFERENCES harness_shared.operator_conversations(id),
      seq integer NOT NULL,
      created_at bigint NOT NULL
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.operator_turns, harness_shared.operator_conversations RESTART IDENTITY CASCADE`;
});

async function mkConversation(summaryThroughSeq: number | null): Promise<string> {
  const [row] = await rootSql<{ id: string }[]>`
    INSERT INTO harness_shared.operator_conversations (summary_through_seq)
    VALUES (${summaryThroughSeq})
    RETURNING id`;
  return row.id;
}

async function ins(conversationId: string, seq: number, ageDays: number) {
  const createdAt = Date.now() - ageDays * 86_400_000;
  await rootSql`INSERT INTO harness_shared.operator_turns (conversation_id, seq, created_at)
                VALUES (${conversationId}, ${seq}, ${createdAt})`;
}

async function remainingSeqs(): Promise<number[]> {
  return (await rootSql<{ seq: number }[]>`SELECT seq FROM harness_shared.operator_turns ORDER BY seq`).map(
    (r) => r.seq,
  );
}

describe('gcOldOperatorTurns (PG)', () => {
  it('deletes ONLY turns older than retentionDays AND already compacted (seq <= summary_through_seq)', async () => {
    const conv = await mkConversation(5); // turns seq<=5 are folded into the summary
    await ins(conv, 1, 200); // old + compacted → deleted
    await ins(conv, 5, 200); // old + compacted (boundary, inclusive) → deleted
    await ins(conv, 6, 200); // old but NOT compacted (seq > summary_through_seq) → kept
    await ins(conv, 2, 10); // compacted but recent → kept
    const n = await gcOldOperatorTurns(150, 20000);
    expect(n).toBe(2);
    expect(await remainingSeqs()).toEqual([2, 6]);
  });

  it('a conversation that has NEVER been compacted (summary_through_seq NULL) is never touched, regardless of age', async () => {
    const conv = await mkConversation(null);
    await ins(conv, 1, 500);
    await ins(conv, 2, 500);
    const n = await gcOldOperatorTurns(150, 20000);
    expect(n).toBe(0);
    expect(await remainingSeqs()).toEqual([1, 2]);
  });

  it('retentionDays controls the age cutoff', async () => {
    const conv = await mkConversation(10);
    await ins(conv, 1, 100);
    expect(await gcOldOperatorTurns(150, 20000)).toBe(0); // 100d < 150d retention → kept
    expect(await gcOldOperatorTurns(90, 20000)).toBe(1); // 100d > 90d retention → deleted
  });

  it('batchLimit bounds a single run — a second run drains the rest', async () => {
    const conv = await mkConversation(10);
    for (let i = 0; i < 5; i++) await ins(conv, i, 200);
    const first = await gcOldOperatorTurns(150, 3);
    expect(first).toBe(3);
    expect((await remainingSeqs()).length).toBe(2);
    const second = await gcOldOperatorTurns(150, 3);
    expect(second).toBe(2);
    expect(await remainingSeqs()).toEqual([]);
  });

  it('the default retention is a conservative, generous window', () => {
    expect(OPERATOR_TURNS_GC_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
  });
});
