import AdmZip from 'adm-zip';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { ingestExternalTriggerEvent } from '../external-triggers/ingestion';
import { buildPersonalAmbientContextBlock, disclosePersonalAmbientResults, type PersonalAmbientDeps } from './ambient';
import { parsePersonalArchive } from './archive-import';
import { authorizePersonalAccess } from './authorization';
import {
  createPersonalGrant,
  replacePersonalGrant,
  purgePersonalSource,
  searchPersonalDocuments,
  setPersonalSyncState,
  setPersonalVaultEnabled,
  upsertPersonalDocuments,
} from './store';
import {
  createPersonalVaultExternalSinkForSource,
  syncGoogleContacts,
} from './live-sink';

let org: OrgTestDb;
let userId: string;
const WS = 'personal-vault-test';

beforeAll(async () => {
  org = await createOrgTestDb();
  await org.adminSql`
    ALTER TABLE harness_shared.documents
      ADD COLUMN IF NOT EXISTS embedding_profile text`;
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'personal-test-' + Date.now()}, 'Personal Test') RETURNING id`;
  userId = user.id;
  const emailType = await getDatatype(org.adminSql, 'papercusp-workspace', 'email-message');
  if (!emailType) throw new Error('personal_vault_test_email_datatype_missing');
  await upsertDatatype(org.adminSql, {
    id: emailType.id,
    workspaceId: WS,
    potSlug: emailType.potSlug,
    title: emailType.title,
    description: emailType.description,
    tier: emailType.tier,
    nature: emailType.nature,
    audience: emailType.audience,
    workItemKind: emailType.workItemKind,
    payloadSchema: emailType.payloadSchema,
    authoritativeWriter: emailType.authoritativeWriter,
    selfImprovement: emailType.selfImprovement,
    published: emailType.published,
    tags: emailType.tags,
    createdBy: 'personal-vault-integration',
  });
});

afterAll(async () => {
  if (org && userId) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.documents WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_sync_state WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_identity_aliases WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_identities WHERE user_id = ${userId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_vault_settings WHERE user_id = ${userId}`;
});

describe('Personal Vault core', () => {
  it('reimports Gmail and Facebook archives idempotently and hybrid-searches both sources', async () => {
    const archive = new AdmZip();
    archive.addFile('Takeout/Mail/All mail.mbox', Buffer.from(
      'From sender@example.com Tue Jan 1 00:00:00 2026\n'
      + 'Message-ID: <archive-mail-1@example.com>\n'
      + 'Date: Tue, 01 Jan 2026 00:00:00 +0000\n'
      + 'From: Ada <ada@example.com>\n'
      + 'To: Owner <owner@example.com>\n'
      + 'Subject: Archive readiness proof\n\n'
      + 'The cobalt notebook contains the launch checklist.',
    ));
    archive.addFile('facebook/messages/inbox/readiness/message_1.json', Buffer.from(JSON.stringify({
      participants: [{ name: 'Ada' }, { name: 'Owner' }],
      messages: [{
        id: 'facebook-archive-message-1',
        sender_name: 'Ada',
        timestamp_ms: 1_787_000_000_000,
        content: 'The amber folder contains the follow-up notes.',
      }],
    })));

    const parsed = parsePersonalArchive('owner-history.zip', archive.toBuffer());
    expect(parsed).toMatchObject({ sources: ['facebook', 'mail'], warnings: [] });
    expect(parsed.documents.map((document) => document.dedupeKey).sort()).toEqual([
      'facebook:facebook-archive-message-1',
      'mail:archive-mail-1@example.com',
    ]);

    const first = await upsertPersonalDocuments(org.adminSql, WS, userId, parsed.documents);
    const reimport = await upsertPersonalDocuments(org.adminSql, WS, userId, parsed.documents);
    expect(reimport.ids).toEqual(first.ids);
    const rows = await org.adminSql<Array<{ source: string; n: number }>>`
      SELECT source, count(*)::int AS n
        FROM harness_shared.documents
       WHERE workspace_id = ${WS} AND user_id = ${userId}
       GROUP BY source ORDER BY source`;
    expect(rows).toEqual([
      { source: 'facebook', n: 1 },
      { source: 'mail', n: 1 },
    ]);

    const lexical = await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'cobalt notebook', scopes: ['mail'],
    });
    expect(lexical).toHaveLength(1);
    expect(lexical[0]).toMatchObject({
      source: 'mail',
      externalId: 'archive-mail-1@example.com',
      lexicalRank: 1,
    });

    const localEmbedding = new Array(768).fill(0);
    localEmbedding[0] = 1;
    await org.adminSql`
      UPDATE harness_shared.documents
         SET embedding = ${JSON.stringify(localEmbedding)}::vector,
             embedding_mode = 'gemma',
             embedding_profile = 'gemma-embeddinggemma-300m-768@v1'
       WHERE workspace_id = ${WS} AND user_id = ${userId} AND source = 'facebook'`;
    const semantic = await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'lexically absent query',
      queryEmbedding: localEmbedding,
      scopes: ['facebook'],
    });
    expect(semantic).toHaveLength(1);
    expect(semantic[0]).toMatchObject({
      source: 'facebook',
      externalId: 'facebook-archive-message-1',
      lexicalRank: null,
      vectorRank: 1,
    });

    await org.adminSql`
      UPDATE harness_shared.documents
         SET embedding_profile = 'openai-text-embedding-3-small-768@v1'
       WHERE workspace_id = ${WS} AND user_id = ${userId} AND source = 'facebook'`;
    const mismatched = await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'lexically absent query',
      queryEmbedding: localEmbedding,
      scopes: ['facebook'],
    });
    expect(mismatched).toEqual([]);
  });

  it('upserts/dedupes and hybrid-searches with scope, participant, time, and bounded snippets', async () => {
    await upsertPersonalDocuments(org.adminSql, WS, userId, [
      { source: 'mail', kind: 'message', externalId: 'm1', occurredAt: '2026-08-21T12:00:00Z', participants: ['ada@example.com'], title: 'Launch notes', text: 'The launch checklist includes privacy verification. '.repeat(30), dedupeKey: 'm1' },
      { source: 'calendar', kind: 'event', externalId: 'e1', occurredAt: '2026-08-20T12:00:00Z', participants: ['bob@example.com'], title: 'Dinner', text: 'Restaurant booking', dedupeKey: 'e1' },
    ]);
    await upsertPersonalDocuments(org.adminSql, WS, userId, [
      { source: 'mail', kind: 'message', externalId: 'm1', participants: ['ada@example.com'], title: 'Launch notes', text: 'Updated privacy verification', dedupeKey: 'm1' },
    ]);
    const results = await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'privacy verification', scopes: ['mail'], participants: ['ada@example.com'],
      timeRange: { from: '2026-08-01T00:00:00Z' }, snippetChars: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: 'mail', scopeKey: 'personal:mail', title: 'Launch notes' });
    expect(results[0]!.snippet.length).toBeLessThanOrEqual(100);
    const count = await org.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int n FROM harness_shared.documents WHERE user_id = ${userId}`;
    expect(count[0].n).toBe(2);
  });

  it('is default-deny, grants a non-coding role, and hard-denies coding roles', async () => {
    const baseCtx = { workspaceId: WS, role: 'meeting-prep' };
    expect((await authorizePersonalAccess(org.adminSql, baseCtx, WS, userId, ['mail'])).allowed).toBe(false);
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: ['mail'], grantedBy: 'owner',
    });
    const granted = await authorizePersonalAccess(org.adminSql, baseCtx, WS, userId, ['personal:mail']);
    expect(granted).toMatchObject({ allowed: true, scopes: ['personal:mail'] });
    const coding = await authorizePersonalAccess(org.adminSql, { workspaceId: WS, role: 'worker' }, WS, userId, ['mail']);
    expect(coding).toMatchObject({ allowed: false, reason: 'coding_agent_denied' });
  });

  it('ambient recall is positive only for the granted context and byte-empty otherwise', async () => {
    const archive = new AdmZip();
    archive.addFile('Takeout/Mail/All mail Including Spam and Trash.mbox', Buffer.from(
      'From sender@example.com Tue Jan 1 00:00:00 2026\n'
      + 'Message-ID: <ambient-mail-1@example.com>\n'
      + 'Date: Tue, 01 Jan 2026 00:00:00 +0000\n'
      + 'From: Ada <ada@example.com>\n'
      + 'To: Owner <owner@example.com>\n'
      + 'Subject: Acme renewal review\n\n'
      + 'Ada requested a renewal timeline review before Friday.',
    ));
    const parsed = parsePersonalArchive('takeout.zip', archive.toBuffer());
    expect(parsed).toMatchObject({ sources: ['mail'], warnings: [] });
    await upsertPersonalDocuments(org.adminSql, WS, userId, parsed.documents);
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: ['mail'], grantedBy: 'owner',
    });
    // Even an explicit grant must not bypass the absolute coding-role fence.
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'agent-role', principalId: 'worker',
      scopes: ['mail'], grantedBy: 'owner',
    });

    const build = (role: string) => buildPersonalAmbientContextBlock(
      { ownerId: `agent-${role}`, userId, workspaceId: WS, query: 'Acme renewal' },
      {
        sql: org.adminSql,
        resolveContext: async () => ({ workspaceId: WS, role }),
        authorize: authorizePersonalAccess,
        embedQuery: async () => null,
        search: searchPersonalDocuments,
        disclose: disclosePersonalAmbientResults,
      } satisfies PersonalAmbientDeps,
    );

    const granted = await build('meeting-prep');
    expect(granted).toContain('## Granted Personal Vault context');
    expect(granted).toContain('Acme renewal review');
    await expect(build('ungranted-assistant')).resolves.toBeNull();
    await expect(build('worker')).resolves.toBeNull();
  });

  it('owner approval replaces a broader live grant instead of leaving stale access', async () => {
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'plan-template', principalId: 'meeting-prep',
      scopes: ['mail', 'calendar'], grantedBy: 'owner',
    });
    const replacement = await replacePersonalGrant(org.adminSql, {
      workspaceId: WS, userId, principalType: 'plan-template', principalId: 'meeting-prep',
      scopes: ['mail'], grantedBy: 'owner',
    });
    expect(replacement).toMatchObject({ scopes: ['personal:mail'], revoked: 1 });
    const live = await org.adminSql<Array<{ scopes: string[] }>>`
      SELECT scopes FROM harness_shared.personal_grants
       WHERE user_id = ${userId} AND principal_type = 'plan-template'
         AND principal_id = 'meeting-prep' AND revoked_at IS NULL`;
    expect(live).toEqual([{ scopes: ['personal:mail'] }]);
  });

  it('resolves one human across contact email, mail address, and social display name', async () => {
    await upsertPersonalDocuments(org.adminSql, WS, userId, [{
      source: 'contacts', kind: 'contact', externalId: 'people/ada',
      participants: ['ada@example.com'], title: 'Ada Lovelace', text: 'ada@example.com', dedupeKey: 'ada-contact',
    }]);
    await upsertPersonalDocuments(org.adminSql, WS, userId, [{
      source: 'mail', kind: 'message', externalId: 'mail-ada',
      participants: ['Ada Lovelace <ada@example.com>'], title: 'Project Phoenix', text: 'Project Phoenix update', dedupeKey: 'ada-mail',
    }]);
    await upsertPersonalDocuments(org.adminSql, WS, userId, [{
      source: 'instagram', kind: 'message', externalId: 'social-ada',
      participants: ['Ada Lovelace'], title: 'Ada thread', text: 'Project Phoenix follow-up', dedupeKey: 'ada-social',
    }]);
    const rows = await org.adminSql<Array<{ source: string; participant_ids: string[] }>>`
      SELECT source, participant_ids FROM harness_shared.documents
       WHERE user_id = ${userId} ORDER BY source`;
    expect(rows.every((row) => row.participant_ids.length === 1)).toBe(true);
    expect(new Set(rows.flatMap((row) => row.participant_ids)).size).toBe(1);

    const found = await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'Project Phoenix', participants: ['ada@example.com'], limit: 10,
    });
    expect(found.map((row) => row.source).sort()).toEqual(['instagram', 'mail']);
  });

  it('kill-switches all writes and purge removes documents plus cursor state', async () => {
    await upsertPersonalDocuments(org.adminSql, WS, userId, [{ source: 'mail', kind: 'message', title: 'x', dedupeKey: 'x' }]);
    await setPersonalSyncState(org.adminSql, WS, userId, 'mail', { historyId: '1' });
    const deleted = await purgePersonalSource(org.adminSql, WS, userId, 'mail');
    expect(deleted).toMatchObject({ documents: 1, cursors: 1 });
    await setPersonalVaultEnabled(org.adminSql, WS, userId, false, 'owner');
    await expect(upsertPersonalDocuments(org.adminSql, WS, userId, [{ source: 'mail', kind: 'message', dedupeKey: 'blocked' }])).rejects.toThrow('personal_vault_disabled');
  });

  it('keeps identical external records separate by provider account and purges surgically', async () => {
    const firstSourceId = '00000000-0000-4000-8000-000000000201';
    const secondSourceId = '00000000-0000-4000-8000-000000000202';
    const common = {
      source: 'mail',
      kind: 'message',
      externalId: 'shared-provider-local-id',
      title: 'Account provenance proof',
      text: 'account scoped cobalt record',
      dedupeKey: 'mail:shared-provider-local-id',
    };
    await upsertPersonalDocuments(org.adminSql, WS, userId, [
      { ...common, sourceId: firstSourceId, providerAccountId: 'first@example.com' },
      { ...common, sourceId: secondSourceId, providerAccountId: 'second@example.com' },
    ]);

    const [otherUser] = await org.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.users (username, display_name)
      VALUES (${'personal-isolation-' + Date.now()}, 'Personal Isolation')
      RETURNING id`;
    await upsertPersonalDocuments(org.adminSql, WS, otherUser.id, [
      { ...common, sourceId: firstSourceId, providerAccountId: 'first@example.com' },
    ]);

    const first = await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'cobalt record',
      scopes: ['mail'],
      sourceIds: [firstSourceId],
      providerAccountIds: ['first@example.com'],
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      sourceId: firstSourceId,
      providerAccountId: 'first@example.com',
    });

    const removed = await purgePersonalSource(org.adminSql, WS, userId, 'mail', {
      sourceId: firstSourceId,
      providerAccountId: 'first@example.com',
    });
    expect(removed).toMatchObject({ documents: 1, cursors: 0 });
    const remaining = await org.adminSql<
      Array<{
        source_id: string;
        provider_account_id: string;
      }>
    >`
      SELECT source_id::text, provider_account_id
        FROM harness_shared.documents
       WHERE workspace_id = ${WS} AND user_id = ${userId} AND source = 'mail'`;
    expect(remaining).toEqual([
      {
        source_id: secondSourceId,
        provider_account_id: 'second@example.com',
      },
    ]);
    const otherUserRows = await org.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM harness_shared.documents
       WHERE workspace_id = ${WS} AND user_id = ${otherUser.id}
         AND provider_account_id = 'first@example.com'`;
    expect(otherUserRows).toEqual([{ n: 1 }]);
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${otherUser.id}`;
  });

  it('stores source-bound social posts under their provider scope and excludes them from Facebook searches', async () => {
    await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'source-scope-regression');
    for (const kind of ['linkedin-company', 'bluesky', 'facebook-pages']) {
      const [source] = await org.adminSql<Array<{ id: string }>>`
        INSERT INTO harness_shared.data_sources
          (workspace_id, kind, owner_user_id, provider_account_id, status)
        VALUES (${WS}, ${kind}, ${userId}, 'connected-member', 'connected')
        RETURNING id`;
      const sink = await createPersonalVaultExternalSinkForSource(org.adminSql, WS, source.id);
      await sink.deliver({
        key: `external-trigger:${kind}:post`, datatypeId: 'social-post', externalId: 'shared-post-id',
        payload: { platform: 'facebook', author: 'Organization', text: 'Scoped company launch' },
      });
      const hits = await searchPersonalDocuments(org.adminSql, WS, userId, {
        query: 'Scoped company launch', scopes: [`personal:${kind}`],
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ source: kind, externalId: 'shared-post-id' });
    }
    expect(await searchPersonalDocuments(org.adminSql, WS, userId, {
      query: 'Scoped company launch', scopes: ['personal:facebook'],
    })).toEqual([]);
  });

  it('consumes normalized Gmail/Calendar events and paged Google Contacts locally', async () => {
    const sources = await org.adminSql<Array<{ id: string; kind: string }>>`
      INSERT INTO harness_shared.data_sources
        (workspace_id, kind, owner_user_id, provider_account_id, status)
      VALUES
        (${WS}, 'gmail', ${userId}, 'owner@example.com', 'ready'),
        (${WS}, 'contacts', ${userId}, 'contacts@example.com', 'connected')
      RETURNING id, kind`;
    const gmailSource = sources.find((source) => source.kind === 'gmail')!;
    const contactsSource = sources.find((source) => source.kind === 'contacts')!;
    const sink = await createPersonalVaultExternalSinkForSource(org.adminSql, WS, gmailSource.id);
    expect(sink).toMatchObject({ kind: 'personal-vault', ref: `user:${userId}:source:${gmailSource.id}` });
    const event = {
      id: 'live-m1', from: 'ada@example.com', to: ['bob@example.com'],
      subject: 'Live mail', text: 'Hello',
    };
    const ingested = await ingestExternalTriggerEvent(org.adminSql, {
      workspaceId: WS,
      sourceId: sources[0].id,
      source: 'gmail',
      event: 'message.received',
      externalId: event.id,
      datatypeId: 'email-message',
      adapterPayload: event,
      normalize: (payload) => payload as typeof event,
      occurredAt: '2026-08-22T00:00:00Z',
      additionalSinks: [sink],
    }, {
      emit: async () => ({ ok: true, key: 'ext:gmail:message.received', woken: 0, notified: [], msgId: null, waiters: 0 }),
    });
    expect(ingested.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'delivered' }),
    ]));
    const fakeFetch = async () => new Response(JSON.stringify({
      connections: [{ resourceName: 'people/1', names: [{ displayName: 'Ada' }], emailAddresses: [{ value: 'ada@example.com' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const synced = await syncGoogleContacts(org.adminSql, {
      workspaceId: WS,
      userId,
      sourceId: contactsSource.id,
      providerAccountId: 'contacts@example.com',
      accessToken: 'local-test-token',
      fetchImpl: fakeFetch as typeof fetch,
    });
    expect(synced).toMatchObject({ contacts: 1, pages: 1, nextPageToken: null });
    const rows = await org.adminSql<Array<{
      source: string;
      source_id: string | null;
      provider_account_id: string | null;
    }>>`
      SELECT source, source_id::text, provider_account_id
        FROM harness_shared.documents
       WHERE user_id = ${userId} ORDER BY source`;
    expect(rows.map((r) => r.source)).toEqual(['contacts', 'mail']);
    expect(rows.find((row) => row.source === 'contacts')).toMatchObject({
      source_id: contactsSource.id,
      provider_account_id: 'contacts@example.com',
    });
    expect(rows.find((row) => row.source === 'mail')).toMatchObject({
      source_id: gmailSource.id,
      provider_account_id: 'owner@example.com',
    });
  });
});
