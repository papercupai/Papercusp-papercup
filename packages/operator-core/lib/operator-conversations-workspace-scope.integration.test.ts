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
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

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
  rootSql = postgres(u.toString(), { max: 4, onnotice: () => {} });
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
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
  if (priorWsPin === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = priorWsPin;
});

describe('getOrCreateActiveConversation workspace scoping (WI-4801)', () => {
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
