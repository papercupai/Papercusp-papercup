/**
 * chat-message / chat-thread admission sources (enterprise-data-sources-2026-10-01 P-021).
 * Real Postgres: identity keys, thread covering, deleted/missing refusals, and the person
 * visibility model (organization permission lists, personal owner, pot scope_ref).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  getAdmissionSource,
  isAdmissionRefusal,
  type Admitter,
  type AdmissionResolveContext,
  type ResolvedAdmissionSource,
} from '../work-admission/admission-sources';
import {
  CHAT_THREAD_SOURCE_KIND,
  chatMessageAdmissionSource,
  chatMessageSourceKey,
  chatThreadAdmissionSource,
  chatThreadSourceKey,
} from './chat-admission-sources';
import { tombstoneChatMessage, upsertChatMessages } from './chat-retrieval-units';
import { mapProviderIdentity, replacePermissionListMembers, upsertPermissionList } from './documents-corpus';

let org: OrgTestDb;
let alice: string;
let bob: string;
let sourceId: string;
const WS = 'chat-admission-sources-test';
const CH = 'T1:CGENERAL';
const HARNESS = 'papercusp';
const THREAD = `${CH}:5.1`;

const person = (userId?: string): Admitter =>
  ({ via: 'person', actorId: 'su-chat-admission-test', ...(userId ? { principalUserId: userId } : {}) }) as Admitter;
const rule = (dataSourceId: string): Admitter => ({ via: 'rule', ruleId: 'rule-1', dataSourceId });
const ctx = (admitter: Admitter, harness = HARNESS): AdmissionResolveContext => ({
  db: org.adminSql, workspaceId: WS, harness, admitter,
});
const msg = (id: string, at: string, body: string, threadKey: string | null = null, author = 'alice') => ({
  channelId: CH, providerMessageId: id, threadKey, authorRef: `T1:U${author.toUpperCase()}`, authorLabel: author, body, postedAt: at,
});

async function makeSource(opts: { scope?: 'personal' | 'pot'; scopeRef?: string; ownerUserId?: string } = {}): Promise<string> {
  const [row] = opts.scope
    ? await org.adminSql<{ id: string }[]>`
        INSERT INTO harness_shared.data_sources
          (workspace_id, kind, permission_mapping, scope, scope_ref, owner_user_id, provider_account_id)
        VALUES (${WS}, 'slack', ${org.adminSql.json({ mode: 'owner' })},
                ${opts.scope}, ${opts.scopeRef ?? null}, ${opts.ownerUserId ?? null}::uuid,
                ${opts.scope === 'personal' ? 'T1:UALICE' : null})
        RETURNING id`
    : await org.adminSql<{ id: string }[]>`
        INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping)
        VALUES (${WS}, 'slack', ${org.adminSql.json({ mode: 'source-acl' })})
        RETURNING id`;
  return row!.id;
}

function resolved(x: unknown): ResolvedAdmissionSource {
  if (isAdmissionRefusal(x)) throw new Error(`unexpected refusal ${x.code}: ${x.message}`);
  return x as ResolvedAdmissionSource;
}

function refusalCode(x: unknown): string | null {
  return isAdmissionRefusal(x) ? x.code : null;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [a] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`chat-admit-alice-${Date.now()}`}, 'alice') RETURNING id`;
  const [b] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`chat-admit-bob-${Date.now()}`}, 'bob') RETURNING id`;
  alice = a!.id;
  bob = b!.id;
});

afterAll(async () => {
  if (alice) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  if (bob) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${bob}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.data_source_legal_holds WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  sourceId = await makeSource();
  // alice is a member of #general; bob has a mapped identity but is not a member.
  await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UALICE', userId: alice, mappedBy: 'owner' });
  await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UBOB', userId: bob, mappedBy: 'owner' });
  const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: CH, title: '#general' });
  await replacePermissionListMembers(org.adminSql, WS, list.id, [{ provider: 'slack', providerUserId: 'T1:UALICE' }]);
  await upsertChatMessages(org.adminSql, WS, sourceId, [
    msg('1.1', '2026-09-30T09:00:00Z', 'Can someone fix the export button?\nIt 500s on large pots.'),
    msg('5.1', '2026-09-30T10:00:00Z', 'Login loops on Safari', THREAD),
    msg('5.2', '2026-09-30T10:05:00Z', 'Same here, since Tuesday', THREAD, 'bob'),
    msg('5.3', '2026-09-30T10:06:00Z', 'oops wrong channel', THREAD, 'bob'),
  ]);
  await tombstoneChatMessage(org.adminSql, WS, sourceId, { channelId: CH, providerMessageId: '5.3' });
});

describe('chat admission sources (P-021)', () => {
  it('registers both kinds on the one admission seam', () => {
    expect(getAdmissionSource('chat-message')).toBe(chatMessageAdmissionSource);
    expect(getAdmissionSource('chat-thread')).toBe(chatThreadAdmissionSource);
  });

  it('keys a message by provider identity and snapshots it, with no covering thread when it has none', async () => {
    const ref = { dataSourceId: sourceId, channelId: CH, providerMessageId: '1.1' };
    const out = resolved(await chatMessageAdmissionSource.resolve(ctx(person(alice)), ref));
    expect(out.sourceKey).toBe(`${sourceId}:${CH}:1.1`);
    expect(out.sourceKey).toBe(chatMessageSourceKey(ref));
    expect(out.dataSourceId).toBe(sourceId);
    expect(out.title).toBe('Can someone fix the export button?');
    expect(out.body).toBe('alice: Can someone fix the export button?\nIt 500s on large pots.');
    expect(out.coveredBy).toEqual([]);
    expect(out.sourceRef).toMatchObject({ provider: 'slack', channelId: CH, providerMessageId: '1.1', author: 'alice' });
  });

  it('declares the thread as covering a threaded message', async () => {
    const out = resolved(await chatMessageAdmissionSource.resolve(
      ctx(person(alice)), { dataSourceId: sourceId, channelId: CH, providerMessageId: '5.2' }));
    expect(out.coveredBy).toEqual([
      { kind: CHAT_THREAD_SOURCE_KIND, key: chatThreadSourceKey({ dataSourceId: sourceId, channelId: CH, threadKey: THREAD }) },
    ]);
  });

  it('snapshots a thread from its live messages, oldest first, and keys it by thread', async () => {
    const ref = { dataSourceId: sourceId, channelId: CH, threadKey: THREAD };
    const out = resolved(await chatThreadAdmissionSource.resolve(ctx(person(alice)), ref));
    expect(out.sourceKey).toBe(`${sourceId}:${CH}:thread:${THREAD}`);
    expect(out.title).toBe('Login loops on Safari');
    expect(out.body).toBe('alice: Login loops on Safari\nbob: Same here, since Tuesday');
    expect(out.sourceRef).toMatchObject({ threadKey: THREAD, messageCount: 2 });
    expect(out.coveredBy ?? []).toEqual([]);
  });

  it('refuses deleted and missing sources', async () => {
    const p = ctx(person(alice));
    expect(refusalCode(await chatMessageAdmissionSource.resolve(p, { dataSourceId: sourceId, channelId: CH, providerMessageId: '5.3' })))
      .toBe('source_deleted');
    expect(refusalCode(await chatMessageAdmissionSource.resolve(p, { dataSourceId: sourceId, channelId: CH, providerMessageId: '9.9' })))
      .toBe('source_not_found');
    expect(refusalCode(await chatThreadAdmissionSource.resolve(p, { dataSourceId: sourceId, channelId: CH, threadKey: `${CH}:9.9` })))
      .toBe('source_not_found');
    expect(refusalCode(await chatMessageAdmissionSource.resolve(p, {
      dataSourceId: '00000000-0000-4000-8000-000000000000', channelId: CH, providerMessageId: '1.1' })))
      .toBe('source_not_found');
  });

  it('refuses a person who cannot read the channel, and a person admission with no principal', async () => {
    const ref = { dataSourceId: sourceId, channelId: CH, providerMessageId: '1.1' };
    expect(refusalCode(await chatMessageAdmissionSource.resolve(ctx(person(bob)), ref))).toBe('not_visible');
    expect(refusalCode(await chatMessageAdmissionSource.resolve(ctx(person()), ref))).toBe('not_visible');
    expect(refusalCode(await chatThreadAdmissionSource.resolve(
      ctx(person(bob)), { dataSourceId: sourceId, channelId: CH, threadKey: THREAD }))).toBe('not_visible');
  });

  it('lets a rule admission through without a person check (the verb enforces rule scope)', async () => {
    const out = resolved(await chatMessageAdmissionSource.resolve(
      ctx(rule(sourceId)), { dataSourceId: sourceId, channelId: CH, providerMessageId: '1.1' }));
    expect(out.dataSourceId).toBe(sourceId);
  });

  it('applies the personal and pot scope rules', async () => {
    const personal = await makeSource({ scope: 'personal', ownerUserId: alice });
    const pot = await makeSource({ scope: 'pot', scopeRef: HARNESS });
    for (const ds of [personal, pot]) {
      await upsertChatMessages(org.adminSql, WS, ds, [msg('7.1', '2026-09-30T11:00:00Z', 'Please triage the flaky test')]);
    }
    const ref = (ds: string) => ({ dataSourceId: ds, channelId: CH, providerMessageId: '7.1' });
    expect(resolved(await chatMessageAdmissionSource.resolve(ctx(person(alice)), ref(personal))).dataSourceId).toBe(personal);
    expect(refusalCode(await chatMessageAdmissionSource.resolve(ctx(person(bob)), ref(personal)))).toBe('not_visible');
    expect(resolved(await chatMessageAdmissionSource.resolve(ctx(person(bob)), ref(pot))).dataSourceId).toBe(pot);
    expect(refusalCode(await chatMessageAdmissionSource.resolve(ctx(person(bob), 'other-pot'), ref(pot)))).toBe('not_visible');
  });

  it('rejects malformed refs before touching the database', () => {
    expect(() => chatMessageAdmissionSource.parseRef({ dataSourceId: 'nope', channelId: CH, providerMessageId: '1' }))
      .toThrow(/^admission_source_invalid: dataSourceId must be a uuid/);
    expect(() => chatMessageAdmissionSource.parseRef({ dataSourceId: sourceId, channelId: CH }))
      .toThrow(/^admission_source_invalid: chat-message source needs \{ providerMessageId \}/);
    expect(() => chatThreadAdmissionSource.parseRef({ dataSourceId: sourceId, channelId: ' ', threadKey: 'x' }))
      .toThrow(/^admission_source_invalid: chat-thread source needs \{ channelId \}/);
  });
});
