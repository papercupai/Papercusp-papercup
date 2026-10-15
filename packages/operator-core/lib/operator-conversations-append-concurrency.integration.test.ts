/**
 * operator-conversations-append-concurrency.integration.test.ts
 *
 * `appendTurn` assigns the next seq under UNIQUE(conversation_id, seq). The
 * original read MAX(seq) in a SEPARATE SELECT and retried only 3× on the
 * assumption that concurrent inserters were rare ("one user, two transports
 * max"). Server-side writers (the curation tick, the urgent-wake runner, and the
 * live transport) broke that assumption and were exhausting the 3 retries in
 * prod ("appendTurn: failed after 3 retries", hundreds of occurrences — curation
 * turns silently dropped). The fix folds the seq into the INSERT (no read→write
 * gap) and retries with jitter.
 *
 * This proves it against a REAL Postgres pool with max>1 (so the inserts
 * genuinely race on separate connections — the compaction integration test uses
 * max:1 and therefore can't): many concurrent appends to one conversation all
 * land with unique, contiguous seqs and none throws. On the old 3-retry code
 * this batch reliably threw "failed after 3 retries".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

const WS = 'ws-append-concurrency';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});
vi.mock('./workspace-registry', async () => {
  const actual =
    await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { getOrCreateActiveConversation, appendTurn, maxTurnSeq } = await import(
  './operator-conversations'
);

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `cca_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  // max > 1 is the whole point: concurrent appendTurn calls then run on
  // separate connections and genuinely race the seq assignment.
  rootSql = postgres(u.toString(), { max: 10, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_conversations (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text,
      subject_kind text DEFAULT 'global' NOT NULL,
      subject_ref text,
      title text,
      status text DEFAULT 'active' NOT NULL,
      started_at bigint NOT NULL,
      ended_at bigint,
      el_conversation_ids text[] DEFAULT '{}' NOT NULL,
      has_audio boolean DEFAULT false NOT NULL
    );
    CREATE TABLE harness_shared.operator_turns (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      conversation_id uuid NOT NULL,
      seq integer NOT NULL,
      role text NOT NULL,
      text text NOT NULL,
      source text DEFAULT 'text_typed' NOT NULL,
      el_conv_id text,
      audio_url text,
      created_at bigint NOT NULL,
      tools jsonb,
      report jsonb,
      workspace_id text NOT NULL, -- mig 453: appendTurn stamps activeWorkspaceId()
      CONSTRAINT operator_turns_conv_seq UNIQUE (conversation_id, seq)
    );
  `);
  // Migration 168 adds the summary_* columns the drizzle operator_conversations
  // schema (used by getOrCreateActiveConversation) references on insert.
  await rootSql.unsafe(
    readFileSync(resolve(SQL_DIR, '168-operator-conversation-summary.sql'), 'utf8'),
  );
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('appendTurn concurrency (real PG pool, max>1)', () => {
  it('N concurrent appends to one conversation all land with unique, contiguous seqs', async () => {
    const conv = await getOrCreateActiveConversation();
    const N = 24;

    // Fire them all at once — they race the COALESCE(MAX(seq))+1 assignment.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendTurn({
          conversationId: conv.id,
          role: i % 2 ? 'assistant' : 'user',
          text: `concurrent-turn-${i}`,
        }),
      ),
    );

    // None threw; every call returned a row with a numeric seq.
    expect(results).toHaveLength(N);
    expect(results.every((r) => r && typeof r.seq === 'number')).toBe(true);

    // Persisted state: exactly N rows, seqs 0..N-1 (unique + contiguous — the
    // UNIQUE constraint forbids dupes; a swallowed failure would leave a gap),
    // and every distinct text landed exactly once.
    const rows = await rootSql<{ seq: number; text: string }[]>`
      SELECT seq, text FROM harness_shared.operator_turns
       WHERE conversation_id = ${conv.id} ORDER BY seq`;
    expect(rows).toHaveLength(N);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(new Set(rows.map((r) => r.text)).size).toBe(N);
    expect(await maxTurnSeq(conv.id)).toBe(N - 1);
  });

  it('a second concurrent batch continues the seq sequence without collision', async () => {
    const conv = await getOrCreateActiveConversation(); // same active conversation
    const before = await maxTurnSeq(conv.id);
    const M = 12;
    const results = await Promise.all(
      Array.from({ length: M }, (_, i) =>
        appendTurn({ conversationId: conv.id, role: 'user', text: `batch2-${i}` }),
      ),
    );
    expect(results.every((r) => r && typeof r.seq === 'number')).toBe(true);
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    // Contiguous continuation: before+1 .. before+M, no dupes.
    expect(seqs).toEqual(Array.from({ length: M }, (_, i) => before + 1 + i));
    expect(await maxTurnSeq(conv.id)).toBe(before + M);
  });
});
