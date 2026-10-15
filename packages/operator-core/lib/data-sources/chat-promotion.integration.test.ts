/**
 * Chat -> work promotion (enterprise-data-sources-2026-10-01 P-021, acceptance BAR R-15).
 *
 * Ingesting a chat message that asks for a fix must NOT create a work item. A work item
 * exists only after the manual promote path (admitWorkItem, the core of work_items:admit)
 * is called on the thread, and the promoted item stays linked to that thread through its
 * work_admissions row. A message inside an already-promoted thread resolves to the same
 * item ('covered') instead of creating a second one (D-030).
 *
 * Real Postgres for ingestion, permissions and admissions (needs migration 1337,
 * work_admissions). createWorkItem is injected so no row is written to the live operator DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { Admitter } from '../work-admission/admission-sources';
import { admissionsForSource, admissionsForWorkItem, admitWorkItem, type AdmitDeps } from '../work-admission/admit';
import {
  CHAT_MESSAGE_SOURCE_KIND,
  CHAT_THREAD_SOURCE_KIND,
  chatMessageSourceKey,
  chatThreadSourceKey,
} from './chat-admission-sources';
import { upsertChatMessages } from './chat-retrieval-units';
import { mapProviderIdentity, replacePermissionListMembers, upsertPermissionList } from './documents-corpus';

let org: OrgTestDb;
let alice: string;
let bob: string;
let sourceId: string;
let created: Array<{ kind: string; title: string; summary: string }>;
let nextId = 0;

const WS = 'chat-promotion-test';
const CH = 'T1:CGENERAL';
const HARNESS = 'papercusp';
const THREAD = `${CH}:7.1`;

const person = (userId: string): Admitter => ({ via: 'person', actorId: 'su-chat-promotion-test', principalUserId: userId });

const msg = (id: string, at: string, body: string, threadKey: string | null = null, author = 'alice') => ({
  channelId: CH, providerMessageId: id, threadKey, authorRef: `T1:U${author.toUpperCase()}`, authorLabel: author, body, postedAt: at,
});

const threadSource = () => ({ kind: CHAT_THREAD_SOURCE_KIND, dataSourceId: sourceId, channelId: CH, threadKey: THREAD });
const threadIdentity = () => ({
  kind: CHAT_THREAD_SOURCE_KIND,
  key: chatThreadSourceKey({ dataSourceId: sourceId, channelId: CH, threadKey: THREAD }),
});

function deps(): AdmitDeps {
  return {
    sql: org.adminSql as unknown as AdmitDeps['sql'],
    createWorkItem: async (input) => {
      created.push({ kind: String(input.kind), title: String(input.title), summary: String(input.summary ?? '') });
      nextId += 1;
      return { id: `WI-CHAT-PROMOTE-${nextId}` };
    },
  };
}

async function workItemsInWorkspace(): Promise<number> {
  const [row] = await org.adminSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
  return row!.n;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [a] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`chat-promote-alice-${Date.now()}`}, 'alice') RETURNING id`;
  const [b] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`chat-promote-bob-${Date.now()}`}, 'bob') RETURNING id`;
  alice = a!.id;
  bob = b!.id;
});

afterAll(async () => {
  if (alice) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  if (bob) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${bob}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  created = [];
  await org.adminSql`DELETE FROM harness_shared.work_admissions WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping)
    VALUES (${WS}, 'slack', ${org.adminSql.json({ mode: 'source-acl' })})
    RETURNING id`;
  sourceId = row!.id;
  // alice is a member of #general; bob has a mapped identity but is not a member.
  await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UALICE', userId: alice, mappedBy: 'owner' });
  await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UBOB', userId: bob, mappedBy: 'owner' });
  const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: CH, title: '#general' });
  await replacePermissionListMembers(org.adminSql, WS, list.id, [{ provider: 'slack', providerUserId: 'T1:UALICE' }]);
  // The fix request arrives through ordinary chat ingestion.
  await upsertChatMessages(org.adminSql, WS, sourceId, [
    msg('7.1', '2026-09-30T11:00:00Z', 'Can someone fix the CSV export? It 500s on large pots.', THREAD),
    msg('7.2', '2026-09-30T11:04:00Z', 'Seeing it too, since the last deploy', THREAD, 'bob'),
  ]);
});

describe('chat -> work promotion (P-021, BAR R-15)', () => {
  it('ingesting a fix request creates no work item until the thread is promoted, then links the item to its thread', async () => {
    // Ingestion alone: no work item, no admission, no create call.
    expect(await workItemsInWorkspace()).toBe(0);
    expect(await admissionsForSource(WS, threadIdentity(), org.adminSql as never)).toEqual([]);
    expect(created).toEqual([]);

    const out = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: threadSource(), admitter: person(alice) },
      deps(),
    );
    expect(out).toMatchObject({ ok: true, reason: 'admitted' });
    if (!out.ok) throw new Error('unreachable');

    expect(created).toHaveLength(1);
    expect(created[0]!.summary).toContain('Can someone fix the CSV export?');

    // The promoted item is linked to its thread, in both directions.
    const bySource = await admissionsForSource(WS, threadIdentity(), org.adminSql as never);
    expect(bySource.map((a) => [a.workItemId, a.sourceKind, a.dataSourceId, a.admittedVia])).toEqual([
      [out.workItemId, CHAT_THREAD_SOURCE_KIND, sourceId, 'person'],
    ]);
    const byItem = await admissionsForWorkItem(WS, out.workItemId, org.adminSql as never);
    expect(byItem.map((a) => a.sourceKey)).toEqual([threadIdentity().key]);
    expect(byItem[0]!.sourceRef).toMatchObject({ channelId: CH, threadKey: THREAD });
  });

  it('re-promoting the thread or promoting a message inside it returns the same item without creating another', async () => {
    const first = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: threadSource(), admitter: person(alice) }, deps());
    if (!first.ok) throw new Error(`thread promotion refused: ${first.code}`);

    const again = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: threadSource(), admitter: person(alice) }, deps());
    expect(again).toMatchObject({ ok: true, reason: 'existing', workItemId: first.workItemId });

    const message = await admitWorkItem({
      workspaceId: WS,
      harness: HARNESS,
      source: { kind: CHAT_MESSAGE_SOURCE_KIND, dataSourceId: sourceId, channelId: CH, providerMessageId: '7.2' },
      admitter: person(alice),
    }, deps());
    expect(message).toMatchObject({ ok: true, reason: 'covered', workItemId: first.workItemId });

    expect(created).toHaveLength(1);
    const messageKey = chatMessageSourceKey({ dataSourceId: sourceId, channelId: CH, providerMessageId: '7.2' });
    expect(await admissionsForSource(WS, { kind: CHAT_MESSAGE_SOURCE_KIND, key: messageKey }, org.adminSql as never)).toEqual([]);
  });

  it('a person who cannot see the channel cannot promote it, and nothing is created', async () => {
    const out = await admitWorkItem(
      { workspaceId: WS, harness: HARNESS, source: threadSource(), admitter: person(bob) }, deps());
    expect(out.ok).toBe(false);
    expect(created).toEqual([]);
    expect(await admissionsForSource(WS, threadIdentity(), org.adminSql as never)).toEqual([]);
  });
});
