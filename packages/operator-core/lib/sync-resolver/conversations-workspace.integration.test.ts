// EI-25791449797018815: admin-pool reads must enforce the request workspace
// on lists, counts, parent harness recovery, posts and recursive replies.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { runWithWorkspace } from '../workspace-als';

let db: OrgTestDb;
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.adminSql }),
}));

const own = 'conversations-own';
const foreign = 'conversations-foreign';
const actor = 'su-aabbccdd-conversations-test';
const id = (scope: string, source: string) => `${scope}-${source}`;
const read = async (name: string, args: Record<string, unknown> = {}, scope = own) => {
  const { resolveNamedQueryV2 } = await import('./index');
  return runWithWorkspace(scope, () => resolveNamedQueryV2(name, args)) as Promise<any[]>;
};

beforeAll(async () => {
  db = await createOrgTestDb();
  const sql = db.adminSql;
  // Insert the foreign parent first: unscoped LIMIT 1 recovery picks it.
  for (const scope of [foreign, own]) {
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts)
      VALUES (${scope}, ${scope + '-harness'}, 'WI-conversations-parent', 'change', 'open', ${scope}, ${Date.now()}, ${Date.now()})`;
    await sql`INSERT INTO harness_shared.coord_threads
      (workspace_id, thread_id, parent_kind, parent_ref, title, created_by, post_count, last_post_at)
      VALUES (${scope}, ${id(scope, 'thread')}, 'work-item', 'WI-conversations-parent', ${scope}, ${actor}, 1, now())`;
    await sql`INSERT INTO harness_shared.coord_thread_posts
      (workspace_id, thread_id, author_id, body)
      VALUES (${scope}, ${id(scope, 'thread')}, ${actor}, ${scope + '-post'})`;
    await sql`INSERT INTO harness_shared.agent_chats_consolidated
      (workspace_id, harness_slug, id, role, title, transcript, created_at, updated_at, archived_at)
      VALUES (${scope}, 'same-harness', ${id(scope, 'chat')}, 'worker', ${scope},
        ${JSON.stringify([{ role: 'assistant', content: scope + '-chat-body' }])}::jsonb,
        ${Date.now()}, ${Date.now()}, ${Date.now()})`;
    await sql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body)
      VALUES (${scope}, 'messages', ${id(scope, 'message')},
        ${JSON.stringify({ kind: 'message', from: actor, to: [actor], summary: scope, body: scope + '-message-body' })}::jsonb)`;
  }
  // Foreign children deliberately point at an OWN root; filtering only the
  // selected root cannot protect the transcript or its reply-count metadata.
  await sql`INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body)
    VALUES (${foreign}, ${id(own, 'thread')}, ${actor}, 'foreign-injected-post')`;
  for (const [scope, msg, parent] of [
    [own, 'own-reply', id(own, 'message')],
    [own, 'own-nested-reply', 'own-reply'],
    [foreign, 'foreign-reply', id(own, 'message')],
    [foreign, 'foreign-nested-reply', 'own-reply'],
  ]) await sql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body)
    VALUES (${scope}, 'messages', ${msg},
      ${JSON.stringify({ kind: 'message', from: actor, to: [actor], summary: msg, body: msg, related_msg_id: parent })}::jsonb)`;
});
afterAll(async () => { await db?.cleanup(); });

describe('Conversations request-workspace SQL isolation', () => {
  it.each([
    ['deliberationList', 'thread_id', 'thread'],
    ['agentChatList', 'id', 'chat'],
    ['agentMessageList', 'msg_id', 'message'],
  ])('%s scopes both rows and the bounded total', async (name, key, source) => {
    const rows = await read('conversations.' + name, { limit: 100 });
    expect(rows.map(row => row[key])).toEqual([id(own, source)]);
    expect(rows[0]._meta.total).toBe(1);
    const other = await read('conversations.' + name, { limit: 100 }, foreign);
    expect(other.map(row => row[key])).toEqual([id(foreign, source)]);
    expect(other[0]._meta.total).toBe(1);
  });

  it.each([
    ['deliberationDetail', 'thread'], ['agentChatDetail', 'chat'], ['agentMessageDetail', 'message'],
  ])('%s denies a foreign id and preserves the own detail', async (name, source) => {
    expect(await read('conversations.' + name, { id: id(foreign, source) })).toEqual([]);
    expect(JSON.stringify(await read('conversations.' + name, { id: id(own, source) }))).toContain(own);
  });

  it('recovers the parent harness from the same workspace in list and detail', async () => {
    const list = await read('conversations.deliberationList', { limit: 100 });
    const detail = await read('conversations.deliberationDetail', { id: id(own, 'thread') });
    expect(list[0].harness_slug).toBe(own + '-harness');
    expect(detail[0].thread.harness_slug).toBe(own + '-harness');
  });

  it('excludes a foreign post pointing at the selected own thread', async () => {
    const rows = await read('conversations.deliberationDetail', { id: id(own, 'thread') });
    expect(rows[0].posts.map((post: { body: string }) => post.body)).toEqual([own + '-post']);
  });

  it('scopes list reply metadata and both levels of the detail reply chain', async () => {
    const list = await read('conversations.agentMessageList', { limit: 100 });
    expect(list[0].reply_count).toBe(1);
    const detail = await read('conversations.agentMessageDetail', { id: id(own, 'message') });
    expect(detail[0].replies.map((reply: { msg_id: string }) => reply.msg_id).sort())
      .toEqual(['own-nested-reply', 'own-reply']);
    expect(detail[0].message.reply_count).toBe(2);
  });

  it('preserves optional chat and message filters within the selected workspace', async () => {
    expect(await read('conversations.agentChatList', { harness: 'absent', role: 'worker', limit: 100 })).toEqual([]);
    expect((await read('conversations.agentChatList', { harness: 'same-harness', role: 'worker', limit: 100 })).map(row => row.id))
      .toEqual([id(own, 'chat')]);
    expect((await read('conversations.agentMessageList', { q: own + '-message-body', limit: 100 })).map(row => row.msg_id))
      .toEqual([id(own, 'message')]);
  });
});
