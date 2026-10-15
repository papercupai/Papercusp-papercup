import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { replyToCanonicalMail } from './mail';
import { mailProviderFixture } from './__fixtures__/mail-provider';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';
const FIRST = '00000000-0000-4000-8000-000000000101';
const SECOND = '00000000-0000-4000-8000-000000000102';

function source(id: string, account: string) {
  return {
    id,
    workspaceId: WORKSPACE,
    kind: 'gmail',
    ownerUserId: USER,
    providerAccountId: account,
    credentialRef: `credential:${account}`,
    status: 'connected',
    config: {},
    cursor: {},
    lastError: null,
    lastConnectedAt: null,
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
}

function document(sourceId: string, account: string, sender: string) {
  return {
    id: sourceId,
    source: 'mail',
    sourceId,
    providerAccountId: account,
    kind: 'message',
    externalId: 'shared-message',
    occurredAt: '2026-08-31T00:00:00.000Z',
    participants: [sender, account],
    title: 'Shared provider id',
    text: 'Body',
    metadata: {
      direction: 'inbound',
      from: sender,
      subject: 'Shared provider id',
      threadId: 'shared-thread',
      messageId: 'shared-message',
    },
  };
}

function fakeSql(options: { singleAccount?: boolean } = {}) {
  const allDocuments = [
    document(FIRST, 'first@example.com', 'First sender <first-sender@example.com>'),
    document(SECOND, 'second@example.com', 'Second sender <second-sender@example.com>'),
  ];
  const allSources = [source(FIRST, 'first@example.com'), source(SECOND, 'second@example.com')];
  const documents = options.singleAccount ? allDocuments.slice(0, 1) : allDocuments;
  const sources = options.singleAccount ? allSources.slice(0, 1) : allSources;
  const query = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join(' ');
    if (text.includes('FROM harness_shared.documents')) {
      // Find the requested source id by the SQL text that binds it, never by a
      // fixed slot: a filter added earlier in the WHERE clause (the datatype_id
      // filter did exactly this) shifts every later parameter, and a stale index
      // silently reads a different one and returns both accounts' documents.
      const slot = parts.findIndex((part) => /d\.source_id\s*=\s*$/.test(part));
      if (slot < 0) throw new Error(`fixture_expected_source_id_filter:${text}`);
      const requested = values[slot];
      const requestedSourceId = typeof requested === 'string' ? requested : null;
      return requestedSourceId
        ? documents.filter((row) => row.sourceId === requestedSourceId)
        : documents;
    }
    if (text.includes('FROM harness_shared.data_sources')) return sources;
    throw new Error(`unexpected_query:${text}`);
  };
  return query as unknown as postgres.Sql;
}

/**
 * A provider that answers like Gmail for a reply draft. The reply path must
 * always carry the thread; a missing one is a real defect, so the fixture
 * refuses rather than coercing, which would stop testing threading at all.
 */
function replyDraftProvider(draftId: string) {
  return mailProviderFixture(({ args }) => {
    if (!args.threadId) throw new Error('fixture_expected_reply_thread_id');
    return { draftId, messageId: `out-${draftId}`, threadId: String(args.threadId) };
  });
}

describe('mail reply account routing', () => {
  it('invokes the provider on the source that holds the selected canonical message', async () => {
    const { deps, calls } = await replyDraftProvider('draft-2');
    const result = await replyToCanonicalMail(fakeSql(), {
      workspaceId: WORKSPACE,
      userId: USER,
      agentOwnerId: null,
      messageId: 'shared-message',
      sourceId: SECOND,
      text: 'Account-safe draft',
      mode: 'draft',
    }, deps);

    // The host binds the call, and so the credential, to exactly that source.
    expect(calls.map((call) => call.source)).toEqual([SECOND]);
    expect(calls[0]).toMatchObject({
      capability: 'mail.draft',
      args: { operation: 'create', threadId: 'shared-thread', inReplyTo: 'shared-message' },
    });
    expect(result).toMatchObject({ to: 'Second sender <second-sender@example.com>', draftId: 'draft-2' });
  });

  it('fails closed when a legacy provider-only id matches more than one account', async () => {
    await expect(replyToCanonicalMail(fakeSql(), {
      workspaceId: WORKSPACE,
      userId: USER,
      agentOwnerId: null,
      messageId: 'shared-message',
      text: 'Must not guess',
      mode: 'draft',
    })).rejects.toThrow('canonical_document_ambiguous:mail:shared-message');
  });

  it('keeps provider-only legacy calls compatible when exactly one account owns the message', async () => {
    const { deps, calls } = await replyDraftProvider('draft-legacy');
    const result = await replyToCanonicalMail(fakeSql({ singleAccount: true }), {
      workspaceId: WORKSPACE,
      userId: USER,
      agentOwnerId: null,
      messageId: 'shared-message',
      text: 'Legacy single-account draft',
      mode: 'draft',
    }, deps);

    expect(calls.map((call) => call.source)).toEqual([FIRST]);
    expect(result).toMatchObject({
      to: 'First sender <first-sender@example.com>',
      draftId: 'draft-legacy',
    });
  });
});
