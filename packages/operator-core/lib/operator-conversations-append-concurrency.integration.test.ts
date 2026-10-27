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
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { restoreRawJsonbSerializer } from '@papercusp/db-org';
import { OperatorChatStore, operatorChatSessionAuthority } from './operator-chat-store';
import { chatWorkerSourceHash, runOperatorChatWorkers } from '../test/operator-chat-workers';

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
let databaseUrl: string;

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
  databaseUrl = u.toString();
  // max > 1 is the whole point: concurrent appendTurn calls then run on
  // separate connections and genuinely race the seq assignment.
  rootSql = postgres(u.toString(), { max: 10, onnotice: () => {} });
  restoreRawJsonbSerializer(rootSql);
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
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.users (id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE harness_shared.user_sessions (token text PRIMARY KEY, workspace_id text NOT NULL,
      user_id text NOT NULL, expires_at timestamptz NOT NULL, capabilities jsonb NOT NULL DEFAULT '["chat:write"]');
  `);
  await rootSql.unsafe(readFileSync(resolve(SQL_DIR, '1569-operator-chat-durable-state.sql'), 'utf8'));
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('appendTurn concurrency (real PG pool, max>1)', () => {
  it('P010 two-worker terminal CAS', async () => {
    const conversation = await getOrCreateActiveConversation('p010-terminal-workers');
    const unrelated = await getOrCreateActiveConversation('p010-terminal-unrelated');
    const unrelatedTurn = { id: randomUUID(), text: 'Unrelated session remains intact', seq: 0 };
    await rootSql.unsafe(`INSERT INTO harness_shared.operator_turns
      (id,conversation_id,workspace_id,seq,role,text,created_at) VALUES ($1,$2,$3,0,'user',$4,$5)`,
      [unrelatedTurn.id, unrelated.id, unrelated.workspaceId, unrelatedTurn.text, Date.now()]);
    const workspaceId = conversation.workspaceId;
    const turn = { conversationId: conversation.id, turnId: randomUUID() };
    const scope = { principalId: 'p010-terminal-owner', tenantId: 'tenant', customerId: 'customer', publicOwnerId: 'public-owner' };
    const token = randomUUID();
    await rootSql.unsafe('INSERT INTO harness_shared.users VALUES ($1,true)', [scope.principalId]);
    await rootSql.unsafe(`INSERT INTO harness_shared.user_sessions VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour','["chat:write"]')`,
      [token, workspaceId, scope.principalId]);
    const store = new OperatorChatStore({ sql: rootSql, workspaceId, turn, scope,
      authorize: operatorChatSessionAuthority({ workspaceId, principalId: scope.principalId,
        credential: { kind: 'user-session', userId: scope.principalId, token },
        capability: 'chat:write', toolName: 'operator:converse' }) });
    await store.beginTurn('p010-terminal-run', 'text_typed');
    const input = { databaseUrl, workspaceId, turn, scope, token,
      action: { kind: 'finalize' as const, runId: 'p010-terminal-run', status: 'completed' as const, text: 'First winner' } };
    const results = await runOperatorChatWorkers([input, { ...input, action: { ...input.action, text: 'Second winner' } }]);
    expect(new Set(results.map(result => result.pid)).size).toBe(2);
    expect(results.every(result => result.pid !== process.pid && result.sourceHash === chatWorkerSourceHash())).toBe(true);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toMatchObject([{ error: 'turn-result-conflict' }]);
    const rows = await rootSql.unsafe('SELECT id,seq,text,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows).toHaveLength(1);
    const winner = results.findIndex(result => result.ok);
    expect(rows[0]).toMatchObject({ id: turn.turnId, text: winner === 0 ? 'First winner' : 'Second winner',
      chat_state: { execution: { status: 'completed', runId: 'p010-terminal-run' } } });
    // A third, newly started worker reconciles commit-success/ack-loss, rather
    // than replacing the winning text or appending a second terminal row.
    const [retry] = await runOperatorChatWorkers([{ ...input, action: { ...input.action, text: rows[0].text } }]);
    expect(retry).toMatchObject({ ok: true, value: { ...turn, seq: rows[0].seq } });
    expect(await rootSql.unsafe('SELECT id FROM harness_shared.operator_turns WHERE conversation_id=$1', [conversation.id]))
      .toHaveLength(1);
    expect(await rootSql.unsafe('SELECT id,text,seq FROM harness_shared.operator_turns WHERE id=$1', [unrelatedTurn.id]))
      .toEqual([{ id: unrelatedTurn.id, text: unrelatedTurn.text, seq: unrelatedTurn.seq }]);
  }, 90_000);

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

  it('P010 stable turn identity reconciles concurrent writes and lost acknowledgements', async () => {
    const conv = await getOrCreateActiveConversation();
    const input = { conversationId: conv.id, turnId: randomUUID(), role: 'assistant' as const,
      text: 'One completed reply', tools: [{ name: 'chat:ask_choice', callId: 'stable-choice', input: { question: 'Keep?' } }] };
    const results = await Promise.all(Array.from({ length: 12 }, () => appendTurn(input)));
    expect(new Set(results.map(row => row.id))).toEqual(new Set([input.turnId]));
    expect(new Set(results.map(row => row.seq)).size).toBe(1);
    // A new request after commit/ack-loss returns the original row unchanged.
    expect(await appendTurn(input)).toEqual(results[0]);
    expect((await rootSql.unsafe('SELECT id FROM harness_shared.operator_turns WHERE id=$1', [input.turnId]))).toHaveLength(1);
  });

  it('P010 stable turn identity refuses changed payloads and foreign conversations', async () => {
    const conv = await getOrCreateActiveConversation();
    const other = await getOrCreateActiveConversation('p010-other-workspace');
    const input = { conversationId: conv.id, turnId: randomUUID(), role: 'assistant' as const,
      text: 'Original reply', tools: [{ name: 'chat:ask_choice', callId: 'original-call' }] };
    const original = await appendTurn(input);
    for (const change of [{ text: 'Changed reply' }, { role: 'user' as const },
      { tools: [{ name: 'chat:ask_choice', callId: 'competing-call' }] }, { conversationId: other.id }]) {
      await expect(appendTurn({ ...input, ...change })).rejects.toThrow('turn identity conflict');
    }
    expect(await appendTurn(input)).toEqual(original);
    expect((await rootSql.unsafe('SELECT id FROM harness_shared.operator_turns WHERE id=$1', [input.turnId]))).toHaveLength(1);
  });
});
