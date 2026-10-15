/**
 * The chat verbs post through whichever installed provider package serves the
 * source (`chat.reply`), never through an in-app Slack client
 * (cupboard-distributable-integrations-2026-10-10 P-008, D-018).
 *
 * The provider here is a fake package registered in a real provider registry,
 * so the selection, capability check and invoke path are the production ones;
 * only the provider's own behaviour is a spy.
 */
import type postgres from 'postgres';
import type { HostFetch, ProviderAdapter, ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderRegistry } from '../integrations/provider-registry';

const ledger = vi.hoisted(() => ({ assertDisclosurePermits: vi.fn() }));
vi.mock('../personal-vault/disclosure-ledger', async (importActual) => ({
  ...(await importActual<typeof import('../personal-vault/disclosure-ledger')>()),
  assertDisclosurePermits: ledger.assertDisclosurePermits,
}));

const resolve = vi.hoisted(() => ({ resolveCanonicalDocument: vi.fn() }));
vi.mock('./resolve', async (importActual) => ({
  ...(await importActual<typeof import('./resolve')>()),
  resolveCanonicalDocument: resolve.resolveCanonicalDocument,
}));

const sources = vi.hoisted(() => ({ listOwnedExternalTriggerSources: vi.fn() }));
vi.mock('../external-triggers/source-store', async (importActual) => ({
  ...(await importActual<typeof import('../external-triggers/source-store')>()),
  listOwnedExternalTriggerSources: sources.listOwnedExternalTriggerSources,
}));

vi.mock('./addressing', async (importActual) => ({
  ...(await importActual<typeof import('./addressing')>()),
  assertTrustedAddressee: vi.fn(async (_sql: unknown, p: { address: string }) =>
    ({ address: p.address, standing: 'known-contact', provenance: 'owner-instruction', verified: true })),
}));

import { ProviderCapabilityUnsupported } from './provider-dispatch';
import type { CanonicalDocument } from './resolve';
import { postToChatChannel, replyToCanonicalChat, replyToTriggerRun } from './chat';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';
const AGENT = 'su-chat-test-agent';
const noHttp: HostFetch = async () => {
  throw new Error('the fake chat package performs no HTTP');
};

function sourceRow(id: string, kind: string) {
  return {
    id,
    workspaceId: WORKSPACE,
    kind,
    ownerUserId: USER,
    providerAccountId: `${id}@team`,
    credentialRef: `credential:${id}`,
    status: 'connected',
    config: { installSlug: 'install-1' },
    cursor: {},
    lastError: null,
    lastConnectedAt: null,
    updatedAt: '2026-10-11T00:00:00.000Z',
  };
}

function chatDoc(payload: Record<string, unknown>, extra: Partial<CanonicalDocument> = {}): CanonicalDocument {
  return {
    id: '00000000-0000-4000-8000-0000000000c0',
    source: 'slack',
    sourceId: 's1',
    datatypeId: 'chat-message',
    kind: 'message',
    externalId: 'msg-1',
    occurredAt: '2026-10-11T00:00:00Z',
    participants: ['U1'],
    title: '',
    text: 'the original message',
    payload,
    ...extra,
  };
}

async function chatPackage(capabilities: string[] = ['chat.channels', 'chat.reply']) {
  const chatReply = vi.fn(async (request: ProviderInvokeRequest) => ({
    channelId: request.args.channelId,
    threadId: request.args.threadId,
    messageTs: '1700000000.000200',
  }));
  const descriptor: ProviderDescriptor = { id: 'slack', contractVersion: 1, datatypes: ['chat-message'], capabilities, egressHosts: ['slack.com'] };
  const adapter: ProviderAdapter = {
    describe: () => descriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async (request) => chatReply(request),
  };
  const registry = createProviderRegistry();
  await registry.register({ pluginName: 'slack', descriptor, adapter });
  return { chatReply, deps: { registry, hostFetchFor: () => noHttp } };
}

beforeEach(() => {
  ledger.assertDisclosurePermits.mockReset().mockResolvedValue(undefined);
  resolve.resolveCanonicalDocument.mockReset();
  sources.listOwnedExternalTriggerSources.mockReset().mockResolvedValue([sourceRow('s1', 'slack')]);
});

describe('chat:reply { messageId }', () => {
  it('posts through the package\'s chat.reply with the stored message\'s coordinates', async () => {
    const { chatReply, deps } = await chatPackage();
    resolve.resolveCanonicalDocument.mockResolvedValue(chatDoc({ id: '1.0', channelId: 'C1', threadId: '0.5' }));

    const result = await replyToCanonicalChat(
      {} as postgres.Sql,
      { workspaceId: WORKSPACE, userId: USER, messageId: 'msg-1', text: '  on it  ', agentOwnerId: AGENT },
      deps,
    );

    expect(resolve.resolveCanonicalDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ datatypeId: 'chat-message', externalId: 'msg-1' }));
    expect(chatReply).toHaveBeenCalledTimes(1);
    expect(chatReply.mock.calls[0]![0]).toMatchObject({ source: 's1', capability: 'chat.reply', args: { channelId: 'C1', threadId: '0.5', text: 'on it' } });
    expect(result).toEqual({ channelId: 'C1', threadId: '0.5', messageTs: '1700000000.000200', provider: 'slack' });
    expect(ledger.assertDisclosurePermits.mock.calls[0]![1]).toMatchObject({ sink: 'slack:C1', recipients: null, agentOwnerId: AGENT });
  });

  it('starts the thread of a top-level message', async () => {
    const { chatReply, deps } = await chatPackage();
    resolve.resolveCanonicalDocument.mockResolvedValue(chatDoc({ id: '1.0', channelId: 'C1' }));

    await replyToCanonicalChat({} as postgres.Sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'msg-1', text: 'hi', agentOwnerId: AGENT }, deps);

    expect(chatReply.mock.calls[0]![0].args).toMatchObject({ channelId: 'C1', threadId: '1.0' });
  });

  it('replies as the source that received the message, not another connected one', async () => {
    const { chatReply, deps } = await chatPackage();
    sources.listOwnedExternalTriggerSources.mockResolvedValue([sourceRow('s1', 'slack'), sourceRow('s2', 'slack')]);
    resolve.resolveCanonicalDocument.mockResolvedValue(chatDoc({ id: '1.0', channelId: 'C1' }, { sourceId: 's2' }));

    await replyToCanonicalChat({} as postgres.Sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'msg-1', text: 'hi', agentOwnerId: AGENT }, deps);

    expect(chatReply.mock.calls[0]![0].source).toBe('s2');
  });

  it('refuses a document that is not a chat message before reaching any provider', async () => {
    const { chatReply, deps } = await chatPackage();
    resolve.resolveCanonicalDocument.mockResolvedValue(chatDoc({ channelId: 'C1' }, { datatypeId: 'email-message' }));

    await expect(
      replyToCanonicalChat({} as postgres.Sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'msg-1', text: 'hi', agentOwnerId: AGENT }, deps),
    ).rejects.toThrow('chat_reply_datatype_unsupported:email-message');
    expect(chatReply).not.toHaveBeenCalled();
  });

  it('refuses when the installed chat package does not offer chat.reply', async () => {
    const { chatReply, deps } = await chatPackage(['chat.channels']);
    resolve.resolveCanonicalDocument.mockResolvedValue(chatDoc({ id: '1.0', channelId: 'C1' }));

    await expect(
      replyToCanonicalChat({} as postgres.Sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'msg-1', text: 'hi', agentOwnerId: AGENT }, deps),
    ).rejects.toBeInstanceOf(ProviderCapabilityUnsupported);
    expect(chatReply).not.toHaveBeenCalled();
    expect(ledger.assertDisclosurePermits).not.toHaveBeenCalled();
  });

  it('refuses when no chat package is installed for the connected source', async () => {
    const registry = createProviderRegistry();
    resolve.resolveCanonicalDocument.mockResolvedValue(chatDoc({ id: '1.0', channelId: 'C1' }));

    await expect(
      replyToCanonicalChat({} as postgres.Sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'msg-1', text: 'hi', agentOwnerId: AGENT }, { registry, hostFetchFor: () => noHttp }),
    ).rejects.toThrow(/^outbound_source_not_connected:chat-message:s1/);
  });
});

describe('chat:post', () => {
  it('posts into the named thread through the same package', async () => {
    const { chatReply, deps } = await chatPackage();

    const result = await postToChatChannel(
      {} as postgres.Sql,
      { workspaceId: WORKSPACE, userId: USER, channelId: 'C9', threadId: '9.0', text: 'note', provenance: { from: 'owner-instruction' }, agentOwnerId: AGENT },
      deps,
    );

    expect(chatReply.mock.calls[0]![0].args).toMatchObject({ channelId: 'C9', threadId: '9.0', text: 'note' });
    expect(result.provider).toBe('slack');
  });
});

/** A tagged-template stand-in for the run-row transaction: SELECT returns `row`, UPDATE is recorded. */
function triggerRunSql(row: Record<string, unknown> | null) {
  const updates: unknown[][] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM harness_shared.trigger_runs')) return row ? [row] : [];
    if (text.includes('UPDATE harness_shared.trigger_runs')) {
      updates.push(values);
      return [];
    }
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as postgres.Sql;
  return { sql, updates };
}

function runRow(outcome: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    args: { trigger: { payload: { id: '5.0', channelId: 'C5' } } },
    outcome,
    sourceId: 's1',
    ownerUserId: USER,
  };
}

describe('chat:reply { planRunId }', () => {
  it('replies once in the thread of the message that started the run and records it', async () => {
    const { chatReply, deps } = await chatPackage();
    const { sql, updates } = triggerRunSql(runRow({ status: 'done' }));

    const result = await replyToTriggerRun(sql, { workspaceId: WORKSPACE, planRunId: 42, text: 'Filed as ASANA-1' }, { ...deps, now: () => new Date('2026-10-11T15:00:00Z') });

    expect(result).toMatchObject({ posted: true, alreadyPosted: false, channelId: 'C5', threadId: '5.0', provider: 'slack' });
    expect(chatReply.mock.calls[0]![0]).toMatchObject({ source: 's1', capability: 'chat.reply', args: { channelId: 'C5', threadId: '5.0', text: 'Filed as ASANA-1' } });
    expect(updates).toHaveLength(1);
    const written = JSON.parse(String(updates[0]![0]));
    expect(written).toMatchObject({ status: 'done', chatThreadReply: { channelId: 'C5', threadId: '5.0', provider: 'slack', postedAt: '2026-10-11T15:00:00.000Z' } });
  });

  it('does not post again when the run already recorded a reply', async () => {
    const { chatReply, deps } = await chatPackage();
    const prior = { channelId: 'C5', threadId: '5.0', messageTs: '1.1', provider: 'slack' };
    const { sql, updates } = triggerRunSql(runRow({ chatThreadReply: prior }));

    const result = await replyToTriggerRun(sql, { workspaceId: WORKSPACE, planRunId: 42, text: 'again' }, deps);

    expect(result).toEqual({ posted: false, alreadyPosted: true, ...prior });
    expect(chatReply).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('refuses an unknown run and an invalid run id', async () => {
    const { deps } = await chatPackage();
    await expect(replyToTriggerRun(triggerRunSql(null).sql, { workspaceId: WORKSPACE, planRunId: 7, text: 'x' }, deps)).rejects.toThrow('chat_reply_trigger_run_not_found:7');
    await expect(replyToTriggerRun(triggerRunSql(null).sql, { workspaceId: WORKSPACE, planRunId: 0, text: 'x' }, deps)).rejects.toThrow('chat_reply_plan_run_id_invalid');
  });
});
