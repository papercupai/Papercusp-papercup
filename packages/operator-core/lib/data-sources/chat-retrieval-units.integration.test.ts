/**
 * Chat retrieval units against real Postgres (plan enterprise-data-sources-2026-10-01
 * P-015; schema: migration 1320).
 *
 * Properties under test: the indexed unit is a thread or a time-gap window rendered
 * from LIVE messages; an edit re-renders it; a delete removes the text from it; and
 * a legal hold keeps held content through every delete, erase and retention path,
 * which then proceed once the hold is released.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createPersonalGrant, searchPersonalDocuments, setPersonalVaultEnabled } from '../personal-vault/store';
import { createDatatypeDestinationSinks } from './datatype-destination-sink';
import {
  chatUnitDedupeKey,
  containerPermissionRef,
  migrateLegacyChatMessageDocuments,
  runChatRollupPass,
  placeLegalHold,
  purgeExpiredChatMessages,
  purgeExpiredDocuments,
  reconcileChatMessageCoverage,
  releaseLegalHold,
  rollupChatUnits,
  tombstoneChatMessage,
  upsertChatMessages,
} from './chat-retrieval-units';
import {
  ORGANIZATION_CORPUS_SCOPE,
  mapProviderIdentity,
  replacePermissionListMembers,
  searchOrganizationDocuments,
  upsertPermissionList,
} from './documents-corpus';

let org: OrgTestDb;
let alice: string;
let bob: string;
let sourceId: string;
const WS = 'chat-retrieval-units-test';
const CH = 'T1:CGENERAL';

async function makeSource(
  permissionMode: string,
  opts: { scope: 'personal' | 'pot'; scopeRef?: string; ownerUserId?: string; providerAccountId?: string } | null = null,
): Promise<string> {
  const [row] = opts
    ? await org.adminSql<{ id: string }[]>`
        INSERT INTO harness_shared.data_sources
          (workspace_id, kind, permission_mapping, scope, scope_ref, owner_user_id, provider_account_id)
        VALUES (${WS}, 'slack', ${org.adminSql.json({ mode: permissionMode })}, ${opts.scope}, ${opts.scopeRef ?? null},
                ${opts.ownerUserId ?? null}::uuid, ${opts.providerAccountId ?? null})
        RETURNING id`
    : await org.adminSql<{ id: string }[]>`
        INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping)
        VALUES (${WS}, 'slack', ${org.adminSql.json({ mode: permissionMode })})
        RETURNING id`;
  return row!.id;
}

/** Corpus rows of every scope, for the destination checks. */
async function corpusRows(): Promise<Array<{ scope: string; user_id: string | null; pot_slug: string | null; dedupe_key: string; text: string }>> {
  return org.adminSql<Array<{ scope: string; user_id: string | null; pot_slug: string | null; dedupe_key: string; text: string }>>`
    SELECT scope, user_id::text AS user_id, pot_slug, dedupe_key, text FROM harness_shared.documents
     WHERE workspace_id = ${WS} ORDER BY scope, occurred_at`;
}

/** Give alice every organization-corpus prerequisite, so an empty result proves the row is not organization-readable. */
async function orgSearchAsAlice(query: string): Promise<Array<[string, string | null]>> {
  await createPersonalGrant(org.adminSql, {
    workspaceId: WS, userId: alice, principalType: 'agent-role', principalId: 'meeting-prep',
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
  });
  await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UALICE', userId: alice, mappedBy: 'owner' });
  const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: containerPermissionRef(sourceId, CH), title: '#general' });
  await replacePermissionListMembers(org.adminSql, WS, list.id, [{ provider: 'slack', providerUserId: 'T1:UALICE' }]);
  const out = await searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role: 'meeting-prep' }, {
    workspaceId: WS, principalUserId: alice, agentOwnerId: 'chat-units-test', query,
  });
  if (!out.allowed) throw new Error(`organization search refused for ${query}`);
  return out.results.map((r) => [r.kind, r.externalId]);
}

const msg = (id: string, at: string, body: string, threadKey: string | null = null) => ({
  channelId: CH, providerMessageId: id, threadKey, authorRef: 'T1:UALICE', authorLabel: 'alice', body, postedAt: at,
});

async function docs(): Promise<Array<{ kind: string; external_id: string; text: string }>> {
  return org.adminSql<Array<{ kind: string; external_id: string; text: string }>>`
    SELECT kind, external_id, text FROM harness_shared.documents
     WHERE workspace_id = ${WS} AND scope = 'organization' ORDER BY occurred_at`;
}

async function units(): Promise<Array<{ unit_kind: string; unit_key: string; message_count: number }>> {
  return org.adminSql<Array<{ unit_kind: string; unit_key: string; message_count: number }>>`
    SELECT unit_kind, unit_key, message_count FROM harness_shared.chat_retrieval_units
     WHERE workspace_id = ${WS} ORDER BY first_posted_at`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`chat-units-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = user!.id;
  const [other] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`chat-units-bob-${Date.now()}`}, 'bob') RETURNING id`;
  bob = other!.id;
});

afterAll(async () => {
  if (alice) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  if (bob) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${bob}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_vault_settings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.datatype_registry WHERE workspace_id = ${WS} AND created_by = 'system:test'`;
  sourceId = await makeSource('source-acl');
});

describe('chat retrieval units (P-015)', () => {
  it('rolls a thread into one unit and indexes it in the organization corpus', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('1.1', '2026-09-30T10:00:00Z', 'Who owns the cobalt migration?', '1.1'),
      msg('1.2', '2026-09-30T10:05:00Z', 'Bob owns it.', '1.1'),
    ]);
    const out = await rollupChatUnits(org.adminSql, WS);
    expect(out).toMatchObject({ buckets: 1, unitsWritten: 1, documentsWritten: 1 });
    expect(await units()).toEqual([{ unit_kind: 'thread', unit_key: '1.1', message_count: 2 }]);
    expect(await docs()).toEqual([{
      kind: 'chat-thread', external_id: '1.1', text: 'alice: Who owns the cobalt migration?\nalice: Bob owns it.',
    }]);
  });

  it('the unit is retrievable only through the channel permission list (fail closed until members arrive)', async () => {
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId: alice, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
    });
    await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UALICE', userId: alice, mappedBy: 'owner' });
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('2.1', '2026-09-30T10:00:00Z', 'The cobalt launch moved to Friday.')]);
    await rollupChatUnits(org.adminSql, WS);
    const search = () => searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role: 'meeting-prep' }, {
      workspaceId: WS, principalUserId: alice, agentOwnerId: 'chat-units-test', query: 'cobalt launch',
    });
    expect(await search()).toMatchObject({ allowed: true, results: [] });
    const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: containerPermissionRef(sourceId, CH), title: '#general' });
    await replacePermissionListMembers(org.adminSql, WS, list.id, [{ provider: 'slack', providerUserId: 'T1:UALICE' }]);
    const out = await search();
    expect(out.allowed && out.results.map((r) => [r.kind, r.externalId])).toEqual([['chat-window', '2.1']]);
  });

  it('an edit re-renders the unit; an identical re-delivery writes nothing', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('3.1', '2026-09-30T10:00:00Z', 'Ship on Tuesday')]);
    await rollupChatUnits(org.adminSql, WS);
    expect(await upsertChatMessages(org.adminSql, WS, sourceId, [msg('3.1', '2026-09-30T10:00:00Z', 'Ship on Tuesday')]))
      .toEqual({ written: 0, unchanged: 1 });
    await upsertChatMessages(org.adminSql, WS, sourceId, [{ ...msg('3.1', '2026-09-30T10:00:00Z', 'Ship on Thursday'), editedAt: '2026-09-30T10:02:00Z' }]);
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ unitsWritten: 1 });
    expect((await docs()).map((d) => d.text)).toEqual(['alice: Ship on Thursday']);
  });

  it('a delete tombstones the message and removes its text; an emptied unit disappears', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('4.1', '2026-09-30T10:00:00Z', 'keep this', '4.1'),
      msg('4.2', '2026-09-30T10:01:00Z', 'secret token abc', '4.1'),
    ]);
    await rollupChatUnits(org.adminSql, WS);
    expect(await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '4.2' }))
      .toEqual({ tombstoned: true, held: false });
    const [raw] = await org.adminSql<{ body: string | null; deleted_at: Date | null }[]>`
      SELECT body, deleted_at FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '4.2'`;
    expect(raw).toMatchObject({ body: null });
    expect(raw!.deleted_at).not.toBeNull();
    await rollupChatUnits(org.adminSql, WS);
    expect((await docs()).map((d) => d.text)).toEqual(['alice: keep this']);

    await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '4.1' });
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ unitsRemoved: 1 });
    expect(await units()).toEqual([]);
    expect(await docs()).toEqual([]);
  });

  it('a delete that arrives before the message is stored still wins over a later stale copy', async () => {
    // A live delete can beat the backfill that would first store the message.
    expect(await tombstoneChatMessage(org.adminSql, WS, sourceId, {
      channelId: CH, providerMessageId: '4.9', deletedAt: '2026-09-30T10:05:00Z', postedAt: '2026-09-30T10:00:00Z',
    })).toEqual({ tombstoned: true, held: false });
    expect(await upsertChatMessages(org.adminSql, WS, sourceId, [msg('4.9', '2026-09-30T10:00:00Z', 'leaked secret')]))
      .toEqual({ written: 0, unchanged: 1 });
    const rows = await org.adminSql<{ body: string | null; raw: unknown; deleted_at: Date | null }[]>`
      SELECT body, raw, deleted_at FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '4.9'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: null, raw: null });
    expect(rows[0]!.deleted_at?.toISOString()).toBe('2026-09-30T10:05:00.000Z');
    await rollupChatUnits(org.adminSql, WS);
    expect(await docs()).toEqual([]);
    // A second delete of the same message is a no-op, not a second tombstone.
    expect(await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '4.9' }))
      .toEqual({ tombstoned: false, held: false });
  });

  // Spec AUTO-BAR-R-9-P-015: search over ingested chat returns thread rollups, never
  // raw message rows, and edited or deleted text is not retrievable through search.
  it('search returns the thread rollup, not message rows; edited and deleted text is not searchable', async () => {
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId: alice, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
    });
    await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UALICE', userId: alice, mappedBy: 'owner' });
    const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: containerPermissionRef(sourceId, CH), title: '#general' });
    await replacePermissionListMembers(org.adminSql, WS, list.id, [{ provider: 'slack', providerUserId: 'T1:UALICE' }]);
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('5.1', '2026-09-30T10:00:00Z', 'The zircon rollout starts Monday', '5.1'),
      msg('5.2', '2026-09-30T10:01:00Z', 'zircon owner is carol', '5.1'),
      msg('5.3', '2026-09-30T10:02:00Z', 'zircon budget password hunter2', '5.1'),
    ]);
    await rollupChatUnits(org.adminSql, WS);
    const search = async (query: string) => {
      const out = await searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role: 'meeting-prep' }, {
        workspaceId: WS, principalUserId: alice, agentOwnerId: 'chat-units-test', query,
      });
      if (!out.allowed) throw new Error(`search refused for ${query}`);
      return out.results.map((r) => [r.kind, r.externalId]);
    };

    // Three matching messages yield ONE hit: the thread rollup, never a message row.
    expect(await search('zircon')).toEqual([['chat-thread', '5.1']]);

    await upsertChatMessages(org.adminSql, WS, sourceId, [
      { ...msg('5.1', '2026-09-30T10:00:00Z', 'The zircon rollout starts Wednesday', '5.1'), editedAt: '2026-09-30T10:05:00Z' },
    ]);
    await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '5.3' });
    await rollupChatUnits(org.adminSql, WS);

    expect(await search('Monday')).toEqual([]);
    expect(await search('hunter2')).toEqual([]);
    expect(await search('Wednesday')).toEqual([['chat-thread', '5.1']]);
    expect(await search('carol')).toEqual([['chat-thread', '5.1']]);
  });

  it('splits non-thread messages into time-gap windows and merges them when the gap closes', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('5.1', '2026-09-30T10:00:00Z', 'a'),
      msg('5.2', '2026-09-30T10:10:00Z', 'b'),
      msg('5.3', '2026-09-30T11:00:00Z', 'c'),
    ]);
    await rollupChatUnits(org.adminSql, WS, { gapMinutes: 30 });
    expect(await units()).toEqual([
      { unit_kind: 'window', unit_key: '5.1', message_count: 2 },
      { unit_kind: 'window', unit_key: '5.3', message_count: 1 },
    ]);
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('5.4', '2026-09-30T10:35:00Z', 'bridge')]);
    expect(await rollupChatUnits(org.adminSql, WS, { gapMinutes: 30 })).toMatchObject({ unitsRemoved: 1 });
    expect(await units()).toEqual([{ unit_kind: 'window', unit_key: '5.1', message_count: 4 }]);
    expect((await docs()).map((d) => d.external_id)).toEqual(['5.1']);
  });

  it('a legal hold keeps held content through delete, erase, edit and retention, then releases it', async () => {
    await org.adminSql`
      UPDATE harness_shared.data_sources SET retention_policy = '{"maxAgeDays": 30}'::jsonb
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('6.1', '2026-01-01T10:00:00Z', 'old held message'),
      msg('6.2', '2026-09-30T10:00:00Z', 'original wording'),
    ]);
    const hold = await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, channelId: CH, reason: 'litigation 42', placedBy: 'owner' });

    expect(await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '6.1' }))
      .toEqual({ tombstoned: true, held: true });
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('6.2', '2026-09-30T10:00:00Z', 'edited wording')]);
    await expect(org.adminSql`DELETE FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '6.2'`)
      .rejects.toThrow(/chat_message_under_legal_hold/);
    await expect(org.adminSql`UPDATE harness_shared.chat_messages SET body = NULL WHERE workspace_id = ${WS} AND provider_message_id = '6.1'`)
      .rejects.toThrow(/chat_message_under_legal_hold/);
    await expect(org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`)
      .rejects.toThrow();

    const now = new Date('2026-10-01T00:00:00Z');
    expect(await purgeExpiredChatMessages(org.adminSql, WS, { now })).toEqual({ expired: 0, tombstonesErased: 0, revisionsDropped: 0 });
    const held = await org.adminSql<{ provider_message_id: string; body: string | null; held_revisions: unknown[] }[]>`
      SELECT provider_message_id, body, held_revisions FROM harness_shared.chat_messages
       WHERE workspace_id = ${WS} ORDER BY provider_message_id`;
    expect(held.map((m) => [m.provider_message_id, m.body, m.held_revisions.length])).toEqual([
      ['6.1', 'old held message', 0],
      ['6.2', 'edited wording', 1],
    ]);
    await rollupChatUnits(org.adminSql, WS);
    expect((await docs()).map((d) => d.text)).toEqual(['alice: edited wording']);

    expect(await releaseLegalHold(org.adminSql, WS, { id: hold.id, releasedBy: 'owner' })).toEqual({ released: 1 });
    expect(await purgeExpiredChatMessages(org.adminSql, WS, { now })).toEqual({ expired: 1, tombstonesErased: 0, revisionsDropped: 1 });
    const after = await org.adminSql<{ provider_message_id: string; held_revisions: unknown[] }[]>`
      SELECT provider_message_id, held_revisions FROM harness_shared.chat_messages WHERE workspace_id = ${WS}`;
    expect(after.map((m) => [m.provider_message_id, m.held_revisions.length])).toEqual([['6.2', 0]]);
  });

  it('coverage tombstones stored messages a fully read window no longer holds, and nothing outside it (WI-6554700010012278)', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('10.1', '2026-09-30T09:00:00Z', 'before the window'),
      msg('10.2', '2026-09-30T10:00:00Z', 'still live'),
      msg('10.3', '2026-09-30T10:05:00Z', 'deleted offline'),
      msg('10.4', '2026-09-30T10:10:00Z', 'thread root', '10.4'),
      msg('10.5', '2026-09-30T10:11:00Z', 'reply deleted offline', '10.4'),
      msg('10.6', '2026-09-30T11:00:00Z', 'after the window'),
    ]);
    // A channel window covers messages outside any thread, bounds inclusive.
    const window = { channelId: CH, from: '2026-09-30T10:00:00Z', to: '2026-09-30T10:30:00Z', liveProviderMessageIds: ['10.2'] };
    expect(await reconcileChatMessageCoverage(org.adminSql, WS, sourceId, window)).toEqual({ tombstoned: 1 });
    // Replaying the same window changes nothing.
    expect(await reconcileChatMessageCoverage(org.adminSql, WS, sourceId, window)).toEqual({ tombstoned: 0 });
    // A thread window covers the whole thread, root included.
    expect(await reconcileChatMessageCoverage(org.adminSql, WS, sourceId, {
      channelId: CH, threadKey: '10.4', liveProviderMessageIds: ['10.4'],
    })).toEqual({ tombstoned: 1 });
    // Another channel's window touches nothing in this one.
    expect(await reconcileChatMessageCoverage(org.adminSql, WS, sourceId, { channelId: 'T1:COTHER', liveProviderMessageIds: [] }))
      .toEqual({ tombstoned: 0 });
    const rows = await org.adminSql<{ provider_message_id: string; deleted: boolean; body: string | null }[]>`
      SELECT provider_message_id, deleted_at IS NOT NULL AS deleted, body FROM harness_shared.chat_messages
       WHERE workspace_id = ${WS} AND data_source_id = ${sourceId}::uuid ORDER BY provider_message_id`;
    expect(rows).toEqual([
      { provider_message_id: '10.1', deleted: false, body: 'before the window' },
      { provider_message_id: '10.2', deleted: false, body: 'still live' },
      { provider_message_id: '10.3', deleted: true, body: null },
      { provider_message_id: '10.4', deleted: false, body: 'thread root' },
      { provider_message_id: '10.5', deleted: true, body: null },
      { provider_message_id: '10.6', deleted: false, body: 'after the window' },
    ]);
  });

  it('coverage under a legal hold tombstones the message but keeps its text (WI-6554700010012278)', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('11.1', '2026-09-30T10:00:00Z', 'held text')]);
    await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, channelId: CH, reason: 'litigation 43', placedBy: 'owner' });
    expect(await reconcileChatMessageCoverage(org.adminSql, WS, sourceId, { channelId: CH, liveProviderMessageIds: [] }))
      .toEqual({ tombstoned: 1 });
    const [row] = await org.adminSql<{ deleted: boolean; body: string | null }[]>`
      SELECT deleted_at IS NOT NULL AS deleted, body FROM harness_shared.chat_messages
       WHERE workspace_id = ${WS} AND provider_message_id = '11.1'`;
    expect(row).toEqual({ deleted: true, body: 'held text' });
  });

  it('erases a tombstone kept by a hold once the hold is released', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('7.1', '2026-09-30T10:00:00Z', 'retracted')]);
    const hold = await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, reason: 'audit', placedBy: 'owner' });
    await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '7.1' });
    await releaseLegalHold(org.adminSql, WS, { id: hold.id, releasedBy: 'owner' });
    expect(await purgeExpiredChatMessages(org.adminSql, WS)).toMatchObject({ tombstonesErased: 1 });
    const [row] = await org.adminSql<{ body: string | null }[]>`
      SELECT body FROM harness_shared.chat_messages WHERE workspace_id = ${WS} AND provider_message_id = '7.1'`;
    expect(row).toEqual({ body: null });
  });

  it('computes units but writes no corpus row when an organization source has no source ACL', async () => {
    await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
    const ownerOnly = await makeSource('owner');
    await upsertChatMessages(org.adminSql, WS, ownerOnly, [msg('8.1', '2026-09-30T10:00:00Z', 'not for the corpus')]);
    const out = await rollupChatUnits(org.adminSql, WS);
    expect(out).toMatchObject({ unitsWritten: 1, documentsWritten: 0, corpusSkipped: { permission_mapping_mismatch: 1 } });
    expect(await corpusRows()).toEqual([]);
    expect(chatUnitDedupeKey(ownerOnly, CH, 'window', '8.1')).toBe(`chat:${ownerOnly}:${CH}:window:8.1`);
  });

  // D-005: personal chat goes to the owner's Personal Vault with vault semantics.
  it('a personal source writes its units into the owner vault only, and a delete removes them', async () => {
    const personal = await makeSource('owner', { scope: 'personal', ownerUserId: alice, providerAccountId: 'T1:UALICE' });
    await upsertChatMessages(org.adminSql, WS, personal, [
      msg('9.1', '2026-09-30T10:00:00Z', 'The basalt contract renews in March', '9.1'),
    ]);
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ unitsWritten: 1, documentsWritten: 1 });

    const rows = await corpusRows();
    expect(rows.map((r) => [r.scope, r.user_id, r.pot_slug])).toEqual([['personal', alice, null]]);
    expect(rows[0]!.dedupe_key.startsWith('account:')).toBe(true);
    const [unit] = await org.adminSql<{ document_dedupe_key: string }[]>`
      SELECT document_dedupe_key FROM harness_shared.chat_retrieval_units WHERE workspace_id = ${WS}`;
    expect(unit!.document_dedupe_key).toBe(rows[0]!.dedupe_key);

    const ownerHits = await searchPersonalDocuments(org.adminSql, WS, alice, { query: 'basalt' });
    expect(ownerHits.map((h) => [h.kind, h.externalId])).toEqual([['chat-thread', '9.1']]);
    expect(await searchPersonalDocuments(org.adminSql, WS, bob, { query: 'basalt' })).toEqual([]);
    expect(await orgSearchAsAlice('basalt')).toEqual([]);

    await tombstoneChatMessage(org.adminSql, WS, personal, { channelId: CH, providerMessageId: '9.1' });
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ unitsRemoved: 1 });
    expect(await corpusRows()).toEqual([]);
  });

  it('a disabled vault takes no chat units and counts the skip', async () => {
    const personal = await makeSource('owner', { scope: 'personal', ownerUserId: alice, providerAccountId: 'T1:UALICE' });
    await setPersonalVaultEnabled(org.adminSql, WS, alice, false, 'owner');
    await upsertChatMessages(org.adminSql, WS, personal, [msg('10.1', '2026-09-30T10:00:00Z', 'vault is off')]);
    expect(await rollupChatUnits(org.adminSql, WS))
      .toMatchObject({ unitsWritten: 1, documentsWritten: 0, corpusSkipped: { personal_vault_disabled: 1 } });
    expect(await corpusRows()).toEqual([]);
  });

  // D-005: pot chat is a scope='pot' row, readable by neither the organization corpus nor any personal vault.
  it('a pot source writes a pot-scoped row that organization and personal search cannot reach', async () => {
    const pot = await makeSource('owner', { scope: 'pot', scopeRef: 'research-pot' });
    await upsertChatMessages(org.adminSql, WS, pot, [msg('11.1', '2026-09-30T10:00:00Z', 'The gneiss benchmark is flaky')]);
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ unitsWritten: 1, documentsWritten: 1 });
    expect((await corpusRows()).map((r) => [r.scope, r.user_id, r.pot_slug, r.text]))
      .toEqual([['pot', null, 'research-pot', 'alice: The gneiss benchmark is flaky']]);
    expect(await orgSearchAsAlice('gneiss')).toEqual([]);
    expect(await searchPersonalDocuments(org.adminSql, WS, alice, { query: 'gneiss' })).toEqual([]);
  });

  it('moving a source from organization to pot scope leaves no organization row behind', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('12.1', '2026-09-30T10:00:00Z', 'feldspar plan', '12.1')]);
    await rollupChatUnits(org.adminSql, WS);
    expect((await corpusRows()).map((r) => r.scope)).toEqual(['organization']);

    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET scope = 'pot', scope_ref = 'research-pot', permission_mapping = '{"mode": "owner"}'::jsonb
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('12.2', '2026-09-30T10:01:00Z', 'feldspar reply', '12.1')]);
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ unitsWritten: 1, documentsWritten: 1 });
    expect((await corpusRows()).map((r) => [r.scope, r.pot_slug])).toEqual([['pot', 'research-pot']]);
    expect(await orgSearchAsAlice('feldspar')).toEqual([]);
  });

  // WI-10005117 / migration 1326: a routing change alone must re-queue the source's buckets.
  it('a routing change with NO new message re-queues every bucket of that source, so the next rollup moves its units', async () => {
    const other = await makeSource('source-acl');
    await upsertChatMessages(org.adminSql, WS, sourceId, [
      msg('13.1', '2026-09-30T10:00:00Z', 'olivine plan', '13.1'),
      msg('13.9', '2026-09-30T15:00:00Z', 'olivine standup notes'),
    ]);
    await upsertChatMessages(org.adminSql, WS, other, [msg('15.1', '2026-09-30T10:00:00Z', 'basalt plan', '15.1')]);
    await rollupChatUnits(org.adminSql, WS);
    expect((await corpusRows()).map((r) => r.scope)).toEqual(['organization', 'organization', 'organization']);
    expect(await queuedBuckets()).toEqual([]);

    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET scope = 'pot', scope_ref = 'research-pot', permission_mapping = '{"mode": "owner"}'::jsonb
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    // Both bucket kinds of the moved source (thread unit -> thread bucket, window unit -> UTC-day
    // bucket), and nothing of the untouched source.
    expect(await queuedBuckets()).toEqual([
      [sourceId, 'day', '2026-09-30'],
      [sourceId, 'thread', '13.1'],
    ]);

    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ documentsWritten: 2 });
    expect(await queuedBuckets()).toEqual([]);
    expect((await corpusRows()).map((r) => [r.scope, r.pot_slug, r.text])).toEqual([
      ['organization', null, 'alice: basalt plan'],
      ['pot', 'research-pot', 'alice: olivine plan'],
      ['pot', 'research-pot', 'alice: olivine standup notes'],
    ]);
    expect(await orgSearchAsAlice('olivine')).toEqual([]);
  });

  // D-016: the connector document sink is the writer, runChatRollupPass the driver; the unit is
  // read through the channel's CONTAINER list (the one the membership snapshot fills), and the
  // legacy per-message row is removed so the text is indexed once.
  it('a chat-message connector record lands as a raw message, rolls into a unit the channel member can read, and replaces the legacy row', async () => {
    await org.adminSql`
      UPDATE harness_shared.data_sources SET destination_policy = '{"chat-message": ["document"]}'::jsonb
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    // The sink routes by the workspace's registered nature (per-workspace registry, as on a real install).
    await org.adminSql`
      INSERT INTO harness_shared.datatype_registry
        (id, workspace_id, title, description, tier, work_item_kind, authoritative_writer,
         status, published, review_status, tags, created_by, nature, audience, updated_at)
      VALUES ('chat-message', ${WS}, 'Chat message', 'A chat message', 'first-class', NULL, 'papercusp',
        'active', TRUE, 'approved', ARRAY['test'], 'system:test', 'document', NULL, now())
      ON CONFLICT DO NOTHING`;
    const legacyKey = `chat-message:${sourceId}:${CH}:16.1`;
    const sinks = await createDatatypeDestinationSinks(org.adminSql, { workspaceId: WS, sourceId, datatype: 'chat-message' });
    expect(sinks.map((s) => s.kind)).toEqual(['data-source-chat-message']);
    const event = (ts: string, text: string, threadKey: string | null) => ({
      dedupeKey: `slack:${ts}`, externalId: `${CH}:${ts}`, occurredAt: '2026-09-30T10:00:00Z',
      payload: { channelId: CH, aclRef: CH, sender: 'T1:UALICE', text, threadKey },
    }) as never;
    await sinks[0]!.deliver(event('16.1', 'The quartz migration starts Monday', '16.1'));
    await sinks[0]!.deliver(event('16.2', 'quartz owner is dave', '16.1'));
    expect(await units()).toEqual([]);

    const pass = await runChatRollupPass(org.adminSql, { workspaceId: WS });
    expect(pass).toMatchObject({ buckets: 1, unitsWritten: 1, documentsWritten: 1 });
    expect(await units()).toEqual([{ unit_kind: 'thread', unit_key: '16.1', message_count: 2 }]);
    expect(await orgSearchAsAlice('quartz')).toEqual([['chat-thread', '16.1']]);
    expect((await corpusRows()).filter((r) => r.dedupe_key === legacyKey)).toEqual([]);
  });

  it('the cut-over turns a legacy per-message corpus row into a raw message and deletes the row', async () => {
    const [user] = await org.adminSql<{ id: string }[]>`SELECT ${alice}::uuid AS id`;
    await org.adminSql`
      INSERT INTO harness_shared.documents (workspace_id, user_id, scope, source, kind, external_id, occurred_at, title, text, metadata, dedupe_key)
      VALUES (${WS}, ${user!.id}::uuid, 'personal', 'slack', 'chat-message', ${`${CH}:17.1`}, '2026-09-30T10:00:00Z', 'legacy',
              'pyrite legacy text', ${org.adminSql.json({ dataSourceId: sourceId, channelId: CH, sender: 'T1:UALICE', text: 'pyrite legacy text' })},
              ${`legacy:${CH}:17.1`})`;
    expect(await migrateLegacyChatMessageDocuments(org.adminSql, WS)).toEqual({ migrated: 1 });
    expect((await corpusRows()).filter((r) => r.text === 'pyrite legacy text')).toEqual([]);
    const raw = await org.adminSql<{ provider_message_id: string; body: string }[]>`
      SELECT provider_message_id, body FROM harness_shared.chat_messages WHERE workspace_id = ${WS}`;
    expect(raw).toEqual([{ provider_message_id: `${CH}:17.1`, body: 'pyrite legacy text' }]);
    expect(await runChatRollupPass(org.adminSql, { workspaceId: WS })).toMatchObject({ unitsWritten: 1, documentsWritten: 1 });
    expect(await orgSearchAsAlice('pyrite')).toEqual([['chat-window', `${CH}:17.1`]]);
  });

  it('an update that changes no routing column queues nothing', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('14.1', '2026-09-30T10:00:00Z', 'gabbro', '14.1')]);
    await rollupChatUnits(org.adminSql, WS);
    // `scope = scope` names a routing column without changing it: the column trigger fires, its
    // WHEN clause must not.
    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET config = '{"note": "renamed"}'::jsonb, scope = scope
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    expect(await queuedBuckets()).toEqual([]);
  });
});

// P-017c (WI-6554700010012583): document retention deletes a source's expired documents, keeps
// the ones a legal hold covers (whole source, or the container by channelId or permission list),
// and leaves chat-derived documents to the chat purge and rollup.
describe('document retention (P-017c)', () => {
  const NOW = new Date('2026-10-01T00:00:00Z');
  const OLD = '2026-06-01T00:00:00Z';
  const FRESH = '2026-09-28T00:00:00Z';

  async function setPolicy(id: string, policy: Record<string, number>): Promise<void> {
    await org.adminSql`
      UPDATE harness_shared.data_sources SET retention_policy = ${org.adminSql.json(policy)}
       WHERE workspace_id = ${WS} AND id = ${id}::uuid`;
  }

  const setRetention = (id: string, maxAgeDays: number): Promise<void> => setPolicy(id, { maxAgeDays });

  async function addDoc(
    externalId: string,
    opts: {
      source?: string; kind?: string; occurredAt?: string | null; importedAt?: string; channelId?: string; permissionListId?: string;
    } = {},
  ): Promise<void> {
    const metadata = opts.channelId ? { channelId: opts.channelId } : {};
    const occurredAt = opts.occurredAt === undefined ? OLD : opts.occurredAt;
    // documents_scope_chk: a permission-list document is organization-scoped and has no user.
    const scope = opts.permissionListId ? 'organization' : 'personal';
    const userId = opts.permissionListId ? null : alice;
    await org.adminSql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, scope, source, source_id, kind, external_id, occurred_at, imported_at, title, text,
         metadata, dedupe_key, permission_list_id)
      VALUES (${WS}, ${userId}::uuid, ${scope}, 'slack', ${opts.source ?? sourceId}::uuid, ${opts.kind ?? 'file'}, ${externalId},
              ${occurredAt}::timestamptz, ${opts.importedAt ?? FRESH}::timestamptz, ${externalId}, ${`retention body ${externalId}`},
              ${org.adminSql.json(metadata)}, ${`retention:${externalId}`}, ${opts.permissionListId ?? null}::uuid)`;
  }

  async function remaining(): Promise<string[]> {
    const rows = await org.adminSql<{ external_id: string }[]>`
      SELECT external_id FROM harness_shared.documents WHERE workspace_id = ${WS} ORDER BY external_id`;
    return rows.map((r) => r.external_id);
  }

  it('deletes expired documents, keeps unexpired ones, and leaves chat-derived kinds alone', async () => {
    await setRetention(sourceId, 30);
    await addDoc('old');
    await addDoc('fresh', { occurredAt: FRESH });
    // No source time: the age is the import time.
    await addDoc('old-import', { occurredAt: null, importedAt: OLD });
    await addDoc('new-import', { occurredAt: null, importedAt: FRESH });
    await addDoc('chat-message-old', { kind: 'chat-message' });
    await addDoc('chat-thread-old', { kind: 'chat-thread' });
    await addDoc('chat-window-old', { kind: 'chat-window' });

    expect(await purgeExpiredDocuments(org.adminSql, WS, { now: NOW })).toEqual({ documentsExpired: 2, documentsHeldKept: 0 });
    expect(await remaining()).toEqual(['chat-message-old', 'chat-thread-old', 'chat-window-old', 'fresh', 'new-import']);
  });

  it('leaves a source with no maxAgeDays untouched', async () => {
    // The data_sources CHECK already refuses a non-numeric maxAgeDays, so the reachable
    // no-expiry shapes are a policy without the key and the default empty policy.
    const noPolicy = await makeSource('source-acl');
    await setPolicy(sourceId, { deliveryDedupeHorizonDays: 7 });
    await addDoc('dedupe-only-policy');
    await addDoc('no-policy', { source: noPolicy });

    expect(await purgeExpiredDocuments(org.adminSql, WS, { now: NOW })).toEqual({ documentsExpired: 0, documentsHeldKept: 0 });
    expect(await remaining()).toEqual(['dedupe-only-policy', 'no-policy']);
  });

  it('keeps and counts expired documents under a whole-source hold until the hold is released', async () => {
    const other = await makeSource('source-acl');
    await setRetention(sourceId, 30);
    await setRetention(other, 30);
    await addDoc('held-a');
    await addDoc('held-b', { channelId: CH });
    await addDoc('other-old', { source: other });
    const hold = await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, reason: 'audit 17c', placedBy: 'owner' });

    expect(await purgeExpiredDocuments(org.adminSql, WS, { now: NOW })).toEqual({ documentsExpired: 1, documentsHeldKept: 2 });
    expect(await remaining()).toEqual(['held-a', 'held-b']);

    await releaseLegalHold(org.adminSql, WS, { id: hold.id, releasedBy: 'owner' });
    expect(await purgeExpiredDocuments(org.adminSql, WS, { now: NOW })).toEqual({ documentsExpired: 2, documentsHeldKept: 0 });
    expect(await remaining()).toEqual([]);
  });

  it('a container hold keeps only that container, matched by channelId or by permission list', async () => {
    await setRetention(sourceId, 30);
    const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: containerPermissionRef(sourceId, CH), title: '#general' });
    await addDoc('in-channel', { channelId: CH });
    await addDoc('in-list', { permissionListId: list.id });
    await addDoc('other-channel', { channelId: 'T1:CRANDOM' });
    await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, channelId: CH, reason: 'litigation 17c', placedBy: 'owner' });

    expect(await purgeExpiredDocuments(org.adminSql, WS, { now: NOW })).toEqual({ documentsExpired: 1, documentsHeldKept: 2 });
    expect(await remaining()).toEqual(['in-channel', 'in-list']);
  });

  it('the connector-sync driver pass runs document retention and reports both counts', async () => {
    await setRetention(sourceId, 30);
    await addDoc('expired');
    await addDoc('held', { channelId: CH });
    await placeLegalHold(org.adminSql, WS, { dataSourceId: sourceId, channelId: CH, reason: 'litigation 17c', placedBy: 'owner' });

    expect(await runChatRollupPass(org.adminSql, { workspaceId: WS, now: NOW })).toMatchObject({ documentsExpired: 1, documentsHeldKept: 1 });
    expect(await remaining()).toEqual(['held']);
  });
});

// WI-6554700010011913: one bucket that always fails must not stall the buckets queued behind it.
// A test-only trigger makes every unit insert for POISON raise, so that bucket fails on each render.
describe('chat rollup isolates a failing bucket', () => {
  const POISON = 'T1:CPOISON';
  const poisonMsg = (id: string, at: string, body: string) => ({ ...msg(id, at, body, id), channelId: POISON });

  beforeAll(async () => {
    await org.adminSql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.test_chat_unit_poison() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.channel_id = '${POISON}' THEN RAISE EXCEPTION 'poisoned bucket'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_chat_unit_poison BEFORE INSERT ON harness_shared.chat_retrieval_units
        FOR EACH ROW EXECUTE FUNCTION harness_shared.test_chat_unit_poison();`);
  });

  afterAll(async () => {
    await org.adminSql.unsafe(`
      DROP TRIGGER IF EXISTS test_chat_unit_poison ON harness_shared.chat_retrieval_units;
      DROP FUNCTION IF EXISTS harness_shared.test_chat_unit_poison();`).catch(() => {});
  });

  it('inside the pass, the failing bucket rolls back alone and waits out its delay; the bucket behind it commits', async () => {
    // Separate statements, so the poisoned bucket is queued first and heads the queue.
    await upsertChatMessages(org.adminSql, WS, sourceId, [poisonMsg('20.1', '2026-09-30T09:00:00Z', 'poisoned')]);
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('21.1', '2026-09-30T10:00:00Z', 'healthy basalt', '21.1')]);

    // batchSize 1: the poisoned bucket is batch 1 on its own. Before the fix that batch threw and
    // rolled back its dequeue, so the pass rejected and 21.1 was never rendered.
    const pass = await runChatRollupPass(org.adminSql, { workspaceId: WS, batchSize: 1 });
    expect(pass).toMatchObject({ buckets: 2, failed: 1, unitsWritten: 1, documentsWritten: 1 });
    expect(pass.failures).toEqual([expect.objectContaining({
      dataSourceId: sourceId, channelId: POISON, bucketKind: 'thread', bucketKey: '20.1',
      error: expect.stringContaining('poisoned bucket'),
    })]);
    expect(await units()).toEqual([{ unit_kind: 'thread', unit_key: '21.1', message_count: 1 }]);

    // Re-queued, not dropped, and not due before the default retry delay.
    const queued = await org.adminSql<Array<{ bucket_key: string; due_in: number }>>`
      SELECT bucket_key, EXTRACT(EPOCH FROM queued_at - now())::float8 AS due_in
        FROM harness_shared.chat_rollup_queue WHERE workspace_id = ${WS}`;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ bucket_key: '20.1' });
    expect(queued[0]!.due_in).toBeGreaterThan(200);
    expect(await runChatRollupPass(org.adminSql, { workspaceId: WS, batchSize: 1 })).toMatchObject({ buckets: 0, failed: 0 });
  });

  it('outside a transaction each bucket gets its own, and a re-queued bucket renders once its cause is gone', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [poisonMsg('22.1', '2026-09-30T09:00:00Z', 'poisoned')]);
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('23.1', '2026-09-30T10:00:00Z', 'healthy gneiss', '23.1')]);

    expect(await rollupChatUnits(org.adminSql, WS, { retryDelaySeconds: 0 }))
      .toMatchObject({ buckets: 2, failed: 1, unitsWritten: 1 });
    expect(await queuedBuckets()).toEqual([[sourceId, 'thread', '22.1']]);

    // The bucket's only message goes away, so its render writes no unit and the retry succeeds.
    await org.adminSql`
      UPDATE harness_shared.chat_messages SET deleted_at = now() WHERE workspace_id = ${WS} AND channel_id = ${POISON}`;
    expect(await rollupChatUnits(org.adminSql, WS, { retryDelaySeconds: 0 })).toMatchObject({ buckets: 1, failed: 0 });
    expect(await queuedBuckets()).toEqual([]);
  });

  // WI-6554700010012111: a bucket that keeps failing backs off, then stops being retried.
  it('a bucket that keeps failing backs off exponentially, ignores new input while backing off, and is dead-lettered at the cap', async () => {
    const opts = { retryDelaySeconds: 100, maxRetryDelaySeconds: 250, deadLetterAttempts: 4 };
    await upsertChatMessages(org.adminSql, WS, sourceId, [poisonMsg('24.1', '2026-09-30T09:00:00Z', 'poisoned')]);

    const first = await rollupChatUnits(org.adminSql, WS, opts);
    expect(first).toMatchObject({ buckets: 1, failed: 1, deadLettered: 0 });
    expect(first.failures).toEqual([expect.objectContaining({ bucketKey: '24.1', attempts: 1, deadLettered: false })]);
    const [afterFirst] = await queueState();
    expect(afterFirst).toMatchObject({
      bucket_key: '24.1', attempts: 1, dead_lettered: false, last_error: expect.stringContaining('poisoned bucket'),
    });
    expect(afterFirst!.due_in).toBeGreaterThan(90);
    expect(afterFirst!.due_in).toBeLessThanOrEqual(100);
    expect(afterFirst!.first_failed_at).toBeInstanceOf(Date);

    // A new message while the bucket backs off leaves its schedule and its count alone.
    await upsertChatMessages(org.adminSql, WS, sourceId, [{ ...msg('24.2', '2026-09-30T09:05:00Z', 'still poisoned', '24.1'), channelId: POISON }]);
    const [afterInput] = await queueState();
    expect(afterInput).toMatchObject({ bucket_key: '24.1', attempts: 1, dead_lettered: false });
    expect(afterInput!.due_in).toBeGreaterThan(90);

    // Each further failure doubles the delay, up to the cap; first_failed_at keeps the run's start.
    for (const [attempts, delay] of [[2, 200], [3, 250]] as const) {
      await makeDue();
      expect(await rollupChatUnits(org.adminSql, WS, opts)).toMatchObject({ buckets: 1, failed: 1, deadLettered: 0 });
      const [row] = await queueState();
      expect(row).toMatchObject({ attempts, dead_lettered: false });
      expect(row!.due_in).toBeGreaterThan(delay - 10);
      expect(row!.due_in).toBeLessThanOrEqual(delay);
      expect(row!.first_failed_at).toEqual(afterFirst!.first_failed_at);
    }

    // The cap-th failure dead-letters the bucket: it stays queued with its error and is never dequeued.
    await makeDue();
    const last = await rollupChatUnits(org.adminSql, WS, opts);
    expect(last).toMatchObject({ buckets: 1, failed: 1, deadLettered: 1 });
    expect(last.failures).toEqual([expect.objectContaining({ attempts: 4, deadLettered: true })]);
    expect(await queueState()).toEqual([expect.objectContaining({ bucket_key: '24.1', attempts: 4, dead_lettered: true })]);
    await makeDue();
    expect(await rollupChatUnits(org.adminSql, WS, opts)).toMatchObject({ buckets: 0, failed: 0 });
    expect(await runChatRollupPass(org.adminSql, { workspaceId: WS })).toMatchObject({ buckets: 0, failed: 0, deadLettered: 0 });
  });

  it('a new message revives a dead-lettered bucket, which then renders once its cause is gone', async () => {
    const opts = { retryDelaySeconds: 0, deadLetterAttempts: 1 };
    await upsertChatMessages(org.adminSql, WS, sourceId, [poisonMsg('25.1', '2026-09-30T09:00:00Z', 'poisoned')]);
    expect(await rollupChatUnits(org.adminSql, WS, opts)).toMatchObject({ buckets: 1, failed: 1, deadLettered: 1 });
    expect(await rollupChatUnits(org.adminSql, WS, opts)).toMatchObject({ buckets: 0 });

    await upsertChatMessages(org.adminSql, WS, sourceId, [{ ...msg('25.2', '2026-09-30T09:05:00Z', 'a reply', '25.1'), channelId: POISON }]);
    const [revived] = await queueState();
    expect(revived).toMatchObject({ bucket_key: '25.1', attempts: 0, dead_lettered: false, last_error: null, first_failed_at: null });
    expect(revived!.due_in).toBeLessThanOrEqual(0);

    await org.adminSql`
      UPDATE harness_shared.chat_messages SET deleted_at = now() WHERE workspace_id = ${WS} AND channel_id = ${POISON}`;
    expect(await rollupChatUnits(org.adminSql, WS, opts)).toMatchObject({ buckets: 1, failed: 0, deadLettered: 0 });
    expect(await queuedBuckets()).toEqual([]);
  });

  // Migration 1500 changed the 1326 trigger: a routing change also clears a bucket's failure state.
  it('a routing change revives a dead-lettered bucket of that source', async () => {
    await upsertChatMessages(org.adminSql, WS, sourceId, [msg('26.1', '2026-09-30T10:00:00Z', 'healthy diorite', '26.1')]);
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ buckets: 1, failed: 0, unitsWritten: 1 });
    // A bucket that rendered before can fail later; give its queue row a dead-letter state directly.
    await org.adminSql`
      INSERT INTO harness_shared.chat_rollup_queue
        (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key, attempts, last_error, first_failed_at, dead_lettered_at)
      VALUES (${WS}, ${sourceId}::uuid, ${CH}, 'thread', '26.1', 8, 'boom', now(), now())`;
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ buckets: 0 });

    await org.adminSql`
      UPDATE harness_shared.data_sources SET destination_policy = '{"chat-message": ["document"]}'::jsonb
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    expect(await queueState()).toEqual([expect.objectContaining({
      bucket_key: '26.1', attempts: 0, dead_lettered: false, last_error: null, first_failed_at: null,
    })]);
    expect(await rollupChatUnits(org.adminSql, WS)).toMatchObject({ buckets: 1, failed: 0 });
  });
});

type QueueStateRow = {
  bucket_key: string; attempts: number; last_error: string | null; first_failed_at: Date | null; dead_lettered: boolean;
  /** Seconds until the row is due (negative once due). */
  due_in: number;
};

/** The test workspace's rollup queue with its failure state, by bucket_key. */
async function queueState(): Promise<QueueStateRow[]> {
  const rows = await org.adminSql<QueueStateRow[]>`
    SELECT bucket_key, attempts, last_error, first_failed_at, dead_lettered_at IS NOT NULL AS dead_lettered,
           EXTRACT(EPOCH FROM queued_at - now())::float8 AS due_in
      FROM harness_shared.chat_rollup_queue
     WHERE workspace_id = ${WS}
     ORDER BY bucket_key`;
  return [...rows];
}

/** Make every queued bucket in the test workspace due now, as if its retry delay had passed. */
async function makeDue(): Promise<void> {
  await org.adminSql`UPDATE harness_shared.chat_rollup_queue SET queued_at = now() WHERE workspace_id = ${WS}`;
}

/** Every queued rollup bucket in the test workspace, as [data_source_id, bucket_kind, bucket_key]. */
async function queuedBuckets(): Promise<Array<[string, string, string]>> {
  const rows = await org.adminSql<Array<{ data_source_id: string; bucket_kind: string; bucket_key: string }>>`
    SELECT data_source_id::text AS data_source_id, bucket_kind, bucket_key
      FROM harness_shared.chat_rollup_queue
     WHERE workspace_id = ${WS}
     ORDER BY data_source_id, bucket_kind, bucket_key`;
  return rows.map((r) => [r.data_source_id, r.bucket_kind, r.bucket_key]);
}
