/**
 * Migration-901 acceptance against a real Postgres pool. During authoring the
 * suite can read the reserved `.DRAFT`; after the guard suite passes and the
 * migration is armed, it reads the canonical SQL. Either way, the SQL is
 * applied only to an isolated database for this acceptance run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const WS = 'ws-work-item-conversation';

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
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => WS,
  resolveConcreteWorkspaceId: (value?: string) =>
    value && value.trim() && value !== '*' ? value.trim() : WS,
}));
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

const {
  appendTurn,
  getConversationById,
  getOrCreateActiveConversation,
  getOrCreateWorkItemConversation,
  getWorkItemConversation,
  listTurns,
} = await import('./operator-conversations');
const turnAnswer = (await import('./endpoint-route/routes/operator/turn-answer')).default as unknown as {
  handler: (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ocwi_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 12, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_conversations (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      workspace_id text DEFAULT '' NOT NULL,
      harness_slug text,
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
  // postgres.js rejects explicit BEGIN/COMMIT on a pooled client. Mirror the
  // established migration-test pattern: strip only that wrapper and execute
  // the unchanged multi-statement body over the simple protocol (implicit
  // transaction), preserving atomicity while keeping max>1 for the race test.
  const armed901 = resolve(SQL_DIR, '901-work-item-papercup-conversations.sql');
  const migration901Path = existsSync(armed901) ? armed901 : `${armed901}.DRAFT`;
  const migration901 = readFileSync(migration901Path, 'utf8').replace(
    /^\s*(BEGIN|COMMIT)\s*;\s*$/gim,
    '',
  );
  await rootSql.unsafe(migration901).simple();
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('work-item Papercup conversations (real Postgres)', () => {
  it('concurrent get-or-create calls converge on exactly one row', async () => {
    const rows = await Promise.all(
      Array.from({ length: 24 }, () =>
        getOrCreateWorkItemConversation({
          workspaceId: WS,
          harnessSlug: 'papercusp',
          workItemId: 'WI-concurrent',
        }),
      ),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    const persisted = await rootSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
        FROM harness_shared.operator_conversations
       WHERE workspace_id = ${WS}
         AND harness_slug = 'papercusp'
         AND subject_kind = 'work-item'
         AND subject_ref = 'WI-concurrent'`;
    expect(persisted[0].n).toBe(1);
  });

  it('isolates workspace, harness, and global-current identity', async () => {
    const a = await getOrCreateWorkItemConversation({
      workspaceId: WS,
      harnessSlug: 'papercusp',
      workItemId: 'WI-isolation',
    });
    const otherHarness = await getOrCreateWorkItemConversation({
      workspaceId: WS,
      harnessSlug: 'other-harness',
      workItemId: 'WI-isolation',
    });
    const otherWorkspace = await getOrCreateWorkItemConversation({
      workspaceId: 'ws-other',
      harnessSlug: 'papercusp',
      workItemId: 'WI-isolation',
    });
    const global = await getOrCreateActiveConversation(WS);

    expect(new Set([a.id, otherHarness.id, otherWorkspace.id, global.id]).size).toBe(4);
    expect(a).toMatchObject({
      subjectKind: 'work-item',
      subjectRef: 'WI-isolation',
      status: 'scoped',
    });
    expect(global).toMatchObject({ subjectKind: 'global', subjectRef: null, status: 'active' });
    expect(await getConversationById(a.id, 'ws-other')).toBeNull();
    expect(
      await getWorkItemConversation({
        workspaceId: WS,
        harnessSlug: 'papercusp',
        workItemId: 'WI-isolation',
      }),
    ).toMatchObject({ id: a.id });
  });

  it('persists rich ask-choice tools and their answer in the scoped thread', async () => {
    const conversation = await getOrCreateWorkItemConversation({
      workspaceId: WS,
      harnessSlug: 'papercusp',
      workItemId: 'WI-card-answer',
    });
    const assistant = await appendTurn({
      conversationId: conversation.id,
      role: 'assistant',
      text: 'Pick one.',
      tools: [
        {
          name: 'chat:ask_choice',
          input: { options: [{ id: 'a', label: 'Card A' }, { id: 'b', label: 'Card B' }] },
        },
      ],
    });

    const response = await turnAnswer.handler(
      new Request('http://localhost/api/operator/conversations/scoped/turn-answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assistantSeq: assistant.seq,
          toolIndex: 0,
          picks: [{ option_id: 'a', label: 'Card A' }],
        }),
      }),
      { params: { id: conversation.id } },
    );
    expect(response.status).toBe(200);

    const turns = await listTurns(conversation.id);
    expect(turns).toHaveLength(2);
    expect(turns[0].tools?.[0].answered?.picks).toEqual([
      { option_id: 'a', label: 'Card A' },
    ]);
    expect(turns[1]).toMatchObject({ role: 'user', text: 'Card A' });
    expect(
      (await getOrCreateWorkItemConversation({
        workspaceId: WS,
        harnessSlug: 'papercusp',
        workItemId: 'WI-card-answer',
      })).id,
    ).toBe(conversation.id);
  });
});
