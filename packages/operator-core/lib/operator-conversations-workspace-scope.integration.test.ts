/**
 * operator-conversations-workspace-scope.integration.test.ts
 *
 * WI-4801 — "Papercup chat empty after a full app reload".
 *
 * The sync READ query `operatorConversations.current` passes the window's
 * workspace (`window.__PAPERCUSP_WS__`) as an arg, but the resolver dropped it
 * and `getOrCreateActiveConversation()` resolved the AMBIENT
 * `activeWorkspaceId()` instead — which, on a header-less batch fetch, is the
 * process-global `reg.current`. The WRITE path (operator-converse) resolves the
 * window's workspace via the request header→ALS, so when the global diverged
 * from the window's workspace (multi-window shared operator, or a transient on
 * boot / right after a workspace switch) the READ returned a DIFFERENT (empty)
 * conversation than writes landed in — the thread looked wiped on reload while
 * the turns were safe in PG.
 *
 * The fix: `getOrCreateActiveConversation(workspaceId?)` honors an EXPLICIT
 * workspace (via `resolveConcreteWorkspaceId`), falling back to the ambient one
 * only when none / blank / '*' is passed. This proves that against a real
 * Postgres so read scope tracks the window, not the process global.
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
import { TurnRecovery } from '@papercusp/chat-protocol/recovery';
import { OperatorChatStore, operatorChatSessionAuthority } from './operator-chat-store';
import { chatWorkerSourceHash, runOperatorChatWorkers } from '../test/operator-chat-workers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

/**
 * What the AMBIENT activeWorkspaceId() resolves to (the header-less fallback).
 * Driven through the REAL precedence chain via the PAPERCUSP_WORKSPACE_ID env
 * pin (precedence #2), so the real `resolveConcreteWorkspaceId` → real
 * `activeWorkspaceId` is exercised end-to-end — an export-mock of
 * activeWorkspaceId wouldn't be observed by resolveConcreteWorkspaceId's
 * intra-module call.
 */
const WS_AMBIENT = 'ws-scope-ambient';
let priorWsPin: string | undefined;

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});

const { getOrCreateActiveConversation } = await import('./operator-conversations');

let rootSql: postgres.Sql;
let databaseUrl: string;

beforeAll(async () => {
  priorWsPin = process.env.PAPERCUSP_WORKSPACE_ID;
  process.env.PAPERCUSP_WORKSPACE_ID = WS_AMBIENT;
  const adminUri = await getTestPg();
  const dbName = `ocws_${randomBytes(5).toString('hex')}`;
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
  rootSql = postgres(u.toString(), { max: 4, onnotice: () => {} });
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
  `);
  // Migration 168 adds the summary_* columns the drizzle operator_conversations
  // schema references on insert.
  await rootSql.unsafe(
    readFileSync(resolve(SQL_DIR, '168-operator-conversation-summary.sql'), 'utf8'),
  );
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_turns (id uuid PRIMARY KEY, conversation_id uuid NOT NULL,
      workspace_id text NOT NULL, seq integer NOT NULL DEFAULT 0, role text NOT NULL DEFAULT 'assistant',
      text text NOT NULL DEFAULT '', source text, tools jsonb DEFAULT '[]', report jsonb, created_at bigint,
      UNIQUE(conversation_id,seq));
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
  if (priorWsPin === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = priorWsPin;
});

describe('getOrCreateActiveConversation workspace scoping (WI-4801)', () => {
  it('P010 durable worker recovery', async () => {
    const workspaceId = 'p010-worker-workspace';
    const conversation = await getOrCreateActiveConversation(workspaceId);
    const unrelated = await getOrCreateActiveConversation('p010-unrelated-workspace');
    const unrelatedBefore = await rootSql.unsafe('SELECT * FROM harness_shared.operator_conversations WHERE id=$1', [unrelated.id]);
    const turn = { conversationId: conversation.id, turnId: randomUUID() };
    const scope = { principalId: 'p010-worker-owner', tenantId: 'tenant', customerId: 'customer', publicOwnerId: 'public-owner' };
    const token = randomUUID();
    await rootSql.unsafe('INSERT INTO harness_shared.users VALUES ($1,true)', [scope.principalId]);
    await rootSql.unsafe(`INSERT INTO harness_shared.user_sessions VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour','["chat:write"]')`,
      [token, workspaceId, scope.principalId]);
    const store = new OperatorChatStore({ sql: rootSql, workspaceId, turn, scope,
      authorize: operatorChatSessionAuthority({ workspaceId, principalId: scope.principalId,
        credential: { kind: 'user-session', userId: scope.principalId, token },
        capability: 'chat:write', toolName: 'operator:converse' }) });
    await store.beginTurn('p010-recovery-run', 'text_typed');
    const recovery = new TurnRecovery({ capabilities: { connectionReplay: true, persistedHistory: true,
      persistedInteractionDecisions: true, completedToolCheckpoints: true, interruptedTurnRecovery: true },
      store, authorize: async () => true, replay: (id, after) => store.replay(id, after), abortExecution: async () => {} });
    expect((await recovery.start(turn, ['read'])).ok).toBe(true);
    let effects = 0;
    expect((await recovery.runEffect(turn, 'read', async () => { effects++; return { ref: 'document:durable-worker' }; },
      new AbortController().signal)).ok).toBe(true);
    const input = { databaseUrl, workspaceId, turn, scope, token,
      action: { kind: 'recover' as const, callId: 'read' } };
    const [recovered, foreign] = await runOperatorChatWorkers([input, { ...input, workspaceId: 'p010-foreign' }]);
    expect(recovered).toMatchObject({ ok: true, sourceHash: chatWorkerSourceHash(),
      value: { source: 'checkpoint', result: { ref: 'document:durable-worker' } } });
    expect(recovered.pid).not.toBe(process.pid);
    expect(foreign.pid).not.toBe(recovered.pid);
    expect(foreign.ok).toBe(false);
    expect(effects).toBe(1);
    await rootSql.unsafe('DELETE FROM harness_shared.user_sessions WHERE token=$1', [token]);
    expect((await runOperatorChatWorkers([input]))[0].ok).toBe(false);
    expect(await rootSql.unsafe('SELECT * FROM harness_shared.operator_conversations WHERE id=$1', [unrelated.id]))
      .toEqual(unrelatedBefore);
    expect(await rootSql.unsafe('SELECT id FROM harness_shared.operator_turns WHERE conversation_id=$1', [unrelated.id]))
      .toEqual([]);
  }, 90_000);

  it('an EXPLICIT workspaceId wins over the ambient one (read scope tracks the window)', async () => {
    const windowWs = 'ws-scope-window';
    const conv = await getOrCreateActiveConversation(windowWs);
    // The returned conversation belongs to the passed workspace — NOT the
    // ambient WS_AMBIENT that the old code would have resolved.
    expect(conv.workspaceId).toBe(windowWs);
    expect(conv.workspaceId).not.toBe(WS_AMBIENT);

    // It is idempotent for that workspace: a second call returns the SAME row,
    // not a fresh empty conversation (which is what a wrong-workspace read did).
    const again = await getOrCreateActiveConversation(windowWs);
    expect(again.id).toBe(conv.id);
  });

  it('omitting the workspaceId falls back to the ambient workspace (unchanged behavior)', async () => {
    const ambient = await getOrCreateActiveConversation();
    expect(ambient.workspaceId).toBe(WS_AMBIENT);
    // A blank string and the '*' read-wildcard both fall back to ambient too
    // (resolveConcreteWorkspaceId treats them as "not concrete").
    expect((await getOrCreateActiveConversation('')).id).toBe(ambient.id);
    expect((await getOrCreateActiveConversation('*')).id).toBe(ambient.id);
  });

  it('two different windows resolve two DISTINCT conversations from one shared operator', async () => {
    const a = await getOrCreateActiveConversation('ws-scope-a');
    const b = await getOrCreateActiveConversation('ws-scope-b');
    expect(a.workspaceId).toBe('ws-scope-a');
    expect(b.workspaceId).toBe('ws-scope-b');
    expect(a.id).not.toBe(b.id);
  });
});
