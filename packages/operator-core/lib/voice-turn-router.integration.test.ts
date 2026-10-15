/**
 * P-002/P-004 integration proof: the voice router and hosted-session
 * persistence use the production operator-conversations store against real
 * Postgres. Unit fakes prove which dependency is called; this suite proves
 * typed, hosted-voice, and Phone turns retain one server-selected owner thread.
 */
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const WORKSPACE_ID = 'ws-voice-router-integration';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql, db: h.db }),
  };
});

const { appendTurn, getOrCreateActiveConversation } = await import('./operator-conversations');
const { createVoiceTurnRouter } = await import('./voice-turn-router');
const { createOperatorVoiceSessionDeps } = await import('./voice-node/operator-voice-session-deps');

const owner = {
  kind: 'owner',
  subjectId: 'owner-1',
  authenticated: true,
  authoritySource: 'owner-session',
} as const;

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `voice_router_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  rootSql = postgres(url.toString(), { max: 4, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
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
      conversation_id uuid NOT NULL REFERENCES harness_shared.operator_conversations(id) ON DELETE CASCADE,
      seq integer NOT NULL,
      role text NOT NULL,
      text text NOT NULL,
      source text DEFAULT 'text_typed' NOT NULL,
      el_conv_id text,
      audio_url text,
      created_at bigint NOT NULL,
      tools jsonb,
      report jsonb,
      workspace_id text NOT NULL,
      CONSTRAINT operator_turns_conv_seq UNIQUE (conversation_id, seq)
    );
  `);
  await rootSql.unsafe(
    readFileSync(resolve(SQL_DIR, '168-operator-conversation-summary.sql'), 'utf8'),
  );
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('voice-turn router owner continuity (real operator-conversation store)', () => {
  it('links local and Phone owner turns to one persisted active operator conversation', async () => {
    const getOrCreateCallConversation = vi.fn(async ({ callSessionId }: { callSessionId: string }) => ({
      id: `call:${callSessionId}`,
    }));
    const route = createVoiceTurnRouter({
      getOrCreateActiveOperatorConversation: getOrCreateActiveConversation,
      getOrCreateCallConversation,
      resolveOwnerTools: async () => ['calendar:list'],
    });
    const common = {
      workspaceId: WORKSPACE_ID,
      turnId: 'turn-local',
      sequence: 0,
      occurredAt: '2026-08-31T16:00:00.000Z',
      transport: 'papercup-local' as const,
      latencyClass: 'deliberative' as const,
      transcript: 'Continue our conversation.',
      resolvedPrincipal: owner,
    };

    const local = await route(common);
    const persisted = await getOrCreateActiveConversation(WORKSPACE_ID);
    const phone = await route({
      ...common,
      turnId: 'turn-phone',
      sequence: 1,
      transport: 'phone-livekit',
      latencyClass: 'interactive',
      transcript: 'Continue by phone.',
      callSessionId: 'room-owner',
    });

    expect(local.turn.conversation).toEqual({
      kind: 'operator',
      id: persisted.id,
      parentOperatorConversationId: null,
    });
    expect(phone.turn.conversation).toEqual({
      kind: 'phone-call',
      id: 'call:room-owner',
      parentOperatorConversationId: persisted.id,
    });
    expect(getOrCreateCallConversation).toHaveBeenCalledOnce();

    const rows = await rootSql<{ id: string }[]>`
      SELECT id
        FROM harness_shared.operator_conversations
       WHERE workspace_id = ${WORKSPACE_ID}
         AND subject_kind = 'global'
         AND subject_ref IS NULL
         AND status = 'active'`;
    expect(rows).toEqual([{ id: persisted.id }]);
  });

  it('keeps typed → hosted voice → typed turns on the session-pinned conversation with ordered metadata', async () => {
    const workspaceId = `${WORKSPACE_ID}-hosted-continuity`;
    const pinned = await getOrCreateActiveConversation(workspaceId);

    await appendTurn({
      conversationId: pinned.id,
      role: 'user',
      text: 'typed before voice',
      source: 'text_typed',
    });

    // Rotate the workspace's active row after the hosted session loaded its id.
    // Re-resolving "active" during persistence would now split voice turns into
    // this replacement thread; a session-pinned writer must ignore the drift.
    await rootSql`
      UPDATE harness_shared.operator_conversations
         SET status = 'done', ended_at = ${Date.now()}
       WHERE id = ${pinned.id}`;
    const replacement = await getOrCreateActiveConversation(workspaceId);
    expect(replacement.id).not.toBe(pinned.id);

    const hostedDeps = createOperatorVoiceSessionDeps(() => {});
    await hostedDeps.persistTurn(pinned.id, 'user', 'spoken question', 'el-p004');
    await hostedDeps.persistTurn(pinned.id, 'assistant', 'spoken answer', 'el-p004');
    await appendTurn({
      conversationId: pinned.id,
      role: 'user',
      text: 'typed after voice',
      source: 'text_typed',
    });

    const turns = await rootSql<{
      conversation_id: string;
      seq: number;
      role: string;
      text: string;
      source: string;
      el_conv_id: string | null;
    }[]>`
      SELECT conversation_id, seq, role, text, source, el_conv_id
        FROM harness_shared.operator_turns
       WHERE conversation_id = ${pinned.id}
       ORDER BY seq`;
    expect(turns).toEqual([
      {
        conversation_id: pinned.id,
        seq: 0,
        role: 'user',
        text: 'typed before voice',
        source: 'text_typed',
        el_conv_id: null,
      },
      {
        conversation_id: pinned.id,
        seq: 1,
        role: 'user',
        text: 'spoken question',
        source: 'voice_stt',
        el_conv_id: 'el-p004',
      },
      {
        conversation_id: pinned.id,
        seq: 2,
        role: 'assistant',
        text: 'spoken answer',
        source: 'voice_tts',
        el_conv_id: 'el-p004',
      },
      {
        conversation_id: pinned.id,
        seq: 3,
        role: 'user',
        text: 'typed after voice',
        source: 'text_typed',
        el_conv_id: null,
      },
    ]);

    const replacementTurns = await rootSql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.operator_turns
       WHERE conversation_id = ${replacement.id}`;
    expect(replacementTurns).toEqual([{ count: 0 }]);
  });
});
