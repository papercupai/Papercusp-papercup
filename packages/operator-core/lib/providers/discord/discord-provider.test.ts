/**
 * The discord provider package (provider-adapters-to-packages-2026-10-11 P-005, D-034/D-035):
 * notify.send posts as the owner's bot; community.presence reads the server's public widget.
 * Offline, against the package's real index.cjs with a fake host.fetch.
 */
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter } from '@papercusp/plugin-sdk';

const require = createRequire(import.meta.url);
const adapter = require('../../../../../libs/papercusp/plugins/discord/index.cjs').providerAdapter as ProviderAdapter;

const channelId = '123456789012345678';
const guildId = '987654321098765432';
const messageId = '111111111111111111';
const config = { channelId, guildId, inviteUrl: 'https://discord.gg/papercusp' };
const args = { text: 'Release 0.4 is out.', idempotencyKey: 'release-0.4' };
const sent = () => jsonResponse(200, { id: messageId, channel_id: channelId, content: args.text });
type Call = Parameters<HostFetch>[0];
const callOf = (fetch: ReturnType<typeof vi.fn>, n = 0) => (fetch.mock.calls[n] as unknown as [Call])[0];
const send = (a: Record<string, unknown> = args, fetch: HostFetch = vi.fn(async () => sent()), c: Record<string, unknown> = config) =>
  adapter.invoke({ source: 'source', config: c, capability: 'notify.send', args: a }, { fetch });
const presence = (fetch: HostFetch, c: Record<string, unknown> = config) =>
  adapter.invoke({ source: 'source', config: c, capability: 'community.presence', args: {} }, { fetch });

describe('discord provider package (P-005)', () => {
  it('declares its capabilities behind a host-held Bot token, with an honestly empty sync', async () => {
    const d = await adapter.describe();
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d).toMatchObject({
      id: 'discord', datatypes: ['notification', 'chat-message'], sync: false, egressHosts: ['discord.com'],
      capabilities: ['notify.send', 'community.presence', 'ingress.normalize', 'chat.reply'],
    });
    expect(d.oauth).toBeUndefined();
    expect(d.setup?.credentials).toEqual([expect.objectContaining({ key: 'bot_token', hosts: ['discord.com'], auth: { header: 'authorization', scheme: 'bot' } })]);
    expect(d.verification?.capabilities).toEqual({
      'notify.send': '2026-10-20', 'community.presence': '2026-10-20', 'ingress.normalize': '2026-10-20', 'chat.reply': '2026-10-20',
    });
    const fetch = vi.fn();
    expect(await adapter.syncPage({ source: 'source', config, cursor: null, mode: 'backfill' }, { fetch })).toMatchObject({ records: [], nextCursor: null, hasMore: false });
    await expect(adapter.syncPage({ source: 'source', config, cursor: 'foreign', mode: 'incremental' }, { fetch })).rejects.toMatchObject({ kind: 'cursor-expired' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts the text to the configured channel with a stable nonce and no pings, never handling the token', async () => {
    const fetch = vi.fn(async () => sent());
    const result = await send(args, fetch);
    expect(result).toEqual({ externalId: messageId, channelId, url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}` });
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = callOf(fetch);
    expect(call.source).toBe('source');
    expect(call.request).toMatchObject({ url: `https://discord.com/api/v10/channels/${channelId}/messages`, method: 'POST' });
    expect(Object.keys(call.request.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
    const body = JSON.parse(call.request.body!);
    expect(body).toEqual({ content: args.text, nonce: expect.any(String), enforce_nonce: true, allowed_mentions: { parse: [] } });
    expect(body.nonce).toHaveLength(25);
    // The same idempotency key repeats the nonce (Discord returns the first message); a new key does not.
    const again = vi.fn(async () => sent());
    await send(args, again);
    expect(JSON.parse(callOf(again).request.body!).nonce).toBe(body.nonce);
    const other = vi.fn(async () => sent());
    await send({ ...args, idempotencyKey: 'release-0.5' }, other);
    expect(JSON.parse(callOf(other).request.body!).nonce).not.toBe(body.nonce);
  });

  it('omits the message link when no server is configured', async () => {
    expect(await send(args, vi.fn(async () => sent()), { channelId })).toEqual({ externalId: messageId, channelId });
  });

  it('refuses a bad channel, text, idempotency key or capability before any request', async () => {
    const fetch = vi.fn();
    for (const c of [{}, { channelId: '123' }, { channelId: '../../guilds/1' }, { channelId: 123456789012345678 }]) {
      await expect(send(args, fetch, c)).rejects.toThrow('invalid_channel_id');
    }
    for (const a of [{ ...args, text: '' }, { ...args, text: '   ' }, { ...args, text: 'x'.repeat(2001) }, { ...args, text: 5 }]) {
      await expect(send(a, fetch)).rejects.toThrow('invalid_text');
    }
    for (const a of [{ text: args.text }, { ...args, idempotencyKey: ' ' }, { ...args, idempotencyKey: 'k'.repeat(201) }]) {
      await expect(send(a, fetch)).rejects.toThrow('invalid_idempotency_key');
    }
    await expect(adapter.invoke({ source: 'source', config, capability: 'social.post', args }, { fetch })).rejects.toThrow('capability_unsupported');
    expect(fetch).not.toHaveBeenCalled();
    // 2000 code points is the vendor limit, not 2000 UTF-16 units.
    await expect(send({ ...args, text: '😀'.repeat(2000) })).resolves.toMatchObject({ externalId: messageId });
  });

  it('classifies refused auth and throttling without leaking the vendor body', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limited']] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, { message: 'private vendor detail' }, { 'Retry-After': '7' }));
      const error = await send(args, fetch).catch((e: unknown) => e);
      expect(error).toMatchObject({ kind });
      expect(String(error)).not.toContain('private vendor detail');
      expect(fetch).toHaveBeenCalledTimes(1);
      if (status === 429) expect(error).toMatchObject({ retryAfterSeconds: 7 });
    }
    // Discord also reports the wait in the JSON body (seconds, fractional).
    const fromBody = await send(args, vi.fn(async () => jsonResponse(429, { retry_after: 1.2, global: false }))).catch((e: unknown) => e);
    expect(fromBody).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 2 });
    await expect(send(args, vi.fn(async () => jsonResponse(404, { code: 10003 })))).rejects.toMatchObject({ kind: 'transient', retrySafe: false });
  });

  it('keeps network errors, server errors and unconfirmed successes ambiguous, never retrying', async () => {
    const replies = [jsonResponse(500, {}), jsonResponse(503, {}), jsonResponse(200, {}),
      jsonResponse(200, { id: messageId, channel_id: '999999999999999999' }),
      { status: 200, headers: {}, body: '{', bodyEncoding: 'utf8' as const }];
    for (const reply of replies) {
      const fetch = vi.fn(async () => reply);
      await expect(send(args, fetch)).rejects.toMatchObject({ kind: 'transient', retrySafe: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => { throw new Error('private transport details'); });
    const error = await send(args, fetch).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'transient', retrySafe: false });
    expect(String(error)).not.toContain('private transport details');
  });

  it('reads the public widget online count and prefers the configured invite', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { id: guildId, name: 'Papercusp', presence_count: 42, instant_invite: 'https://discord.com/invite/widget1' }));
    expect(await presence(fetch)).toEqual({ guildId, widget: 'enabled', presenceCount: 42, name: 'Papercusp', inviteUrl: 'https://discord.gg/papercusp' });
    expect(callOf(fetch).request).toMatchObject({ url: `https://discord.com/api/v10/guilds/${guildId}/widget.json`, method: 'GET' });
    const fallback = vi.fn(async () => jsonResponse(200, { presence_count: 3, instant_invite: 'https://discord.com/invite/widget1' }));
    expect(await presence(fallback, { guildId })).toMatchObject({ presenceCount: 3, inviteUrl: 'https://discord.com/invite/widget1', name: null });
    const hostile = vi.fn(async () => jsonResponse(200, { presence_count: -1, instant_invite: 'https://evil.test/invite/x' }));
    expect(await presence(hostile, { guildId })).toMatchObject({ presenceCount: null, inviteUrl: null });
  });

  it('reports a disabled widget as a state and refuses bad server or invite config before fetching', async () => {
    for (const status of [403, 404]) {
      expect(await presence(vi.fn(async () => jsonResponse(status, { code: 50004 })))).toEqual({ guildId, widget: 'disabled', presenceCount: null, name: null, inviteUrl: config.inviteUrl });
    }
    const fetch = vi.fn();
    for (const c of [{}, { guildId: 'abc' }]) await expect(presence(fetch, c)).rejects.toThrow('invalid_guild_id');
    for (const inviteUrl of ['http://discord.gg/papercusp', 'https://discord.gg.evil.test/papercusp', 'https://evil.test/invite/x',
      'https://discord.gg/papercusp?x=1', 'https://user@discord.gg/papercusp', 'https://discord.com/channels/1', 'not a url']) {
      await expect(presence(fetch, { guildId, inviteUrl })).rejects.toThrow('invalid_invite_url');
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(presence(vi.fn(async () => jsonResponse(429, {}, { 'Retry-After': '30' })))).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 30 });
    await expect(presence(vi.fn(async () => jsonResponse(502, {})))).rejects.toMatchObject({ kind: 'transient' });
    await expect(presence(vi.fn(async () => { throw new Error('down'); }))).rejects.toMatchObject({ kind: 'transient' });
  });

  it('passes the shared conformance kit with each of its actual invocations', async () => {
    const widget = () => jsonResponse(200, { id: guildId, name: 'Papercusp', presence_count: 42 });
    const envelope = { op: 0, s: 1, t: 'MESSAGE_CREATE', d: { id: messageId, channel_id: channelId, guild_id: guildId, type: 0,
      content: 'hi', author: { id: '333333333333333333', username: 'member1' }, mentions: [] } };
    const report = await runProviderConformance({ adapter, source: 'source', config,
      createFetch: () => async ({ request }) => request.url.endsWith('/widget.json') ? widget() : sent(),
      faults: { rateLimited: false, auth: false, serverError: false },
      invocations: [
        { capability: 'notify.send', args, check: (r) => (r as { externalId?: unknown }).externalId === messageId ? null : 'message id required' },
        { capability: 'community.presence', args: {}, check: (r) => (r as { presenceCount?: unknown }).presenceCount === 42 ? null : 'online count required' },
        { capability: 'ingress.normalize', args: { envelope, sourceConfig: { guildId } },
          check: (r) => (r as { records?: unknown[] }).records?.length === 1 ? null : 'one chat-message record required' },
        { capability: 'chat.reply', args: { channelId, threadId: messageId, text: 'hello' },
          check: (r) => (r as { messageTs?: unknown }).messageTs === messageId ? null : 'reply message id required' },
      ] });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// P-025 (D-038): the community bot reads members' messages from the Gateway and replies to them.
describe('discord community bot (P-025)', () => {
  const botUserId = '222222222222222222';
  const authorId = '333333333333333333';
  const message = (d: Record<string, unknown> = {}) => ({
    op: 0, s: 12, t: 'MESSAGE_CREATE',
    d: {
      id: messageId, channel_id: channelId, guild_id: guildId, type: 0, content: 'How do I install the desktop app?',
      timestamp: '2026-10-20T17:00:00.000000+00:00', author: { id: authorId, username: 'member1' }, mentions: [], ...d,
    },
  });
  const normalize = (envelope: unknown, sourceConfig: Record<string, unknown> = { guildId, botUserId }) =>
    adapter.invoke({ source: 'source', capability: 'ingress.normalize', args: { envelope, sourceConfig } }, { fetch: vi.fn() }) as Promise<{ records: Array<Record<string, any>> }>;

  it('maps a member\'s message to a chat-message record whose own id is its reply thread', async () => {
    const { records } = await normalize(message());
    expect(records).toEqual([{
      datatype: 'chat-message',
      nativeId: `${channelId}:${messageId}`,
      event: 'message',
      version: `message:${channelId}:${messageId}`,
      occurredAt: '2026-10-20T17:00:00.000Z',
      payload: {
        id: `${channelId}:${messageId}`, channelId, threadId: messageId, threadKey: null, sender: authorId,
        text: 'How do I install the desktop app?', mentions: [], occurredAt: '2026-10-20T17:00:00.000Z',
        extensions: { discord: { messageId, guildId, authorName: 'member1' } },
      },
    }]);
  });

  it('records a mention of the bot, a direct message and a reply as such', async () => {
    const mention = await normalize(message({ content: `<@${botUserId}> help`, mentions: [{ id: botUserId, bot: true }] }));
    expect(mention.records[0]).toMatchObject({ event: 'mention', payload: { mentions: [botUserId] } });
    // Without the bot's id configured, a mention is an ordinary message.
    expect((await normalize(message({ mentions: [{ id: botUserId }] }), { guildId })).records[0]!.event).toBe('message');
    const dm = await normalize(message({ guild_id: undefined }));
    expect(dm.records[0]).toMatchObject({ event: 'dm', payload: { extensions: { discord: { guildId: null } } } });
    const replyTo = '444444444444444444';
    const reply = await normalize(message({ type: 19, message_reference: { message_id: replyTo } }));
    expect(reply.records[0]!.payload).toMatchObject({ threadId: messageId, threadKey: replyTo, extensions: { discord: { replyTo } } });
  });

  it('never records bots (its own replies included), webhooks, system posts, empty text, other servers or other events', async () => {
    for (const envelope of [
      message({ author: { id: botUserId, bot: true } }),
      message({ webhook_id: '555555555555555555' }),
      message({ author: { id: authorId, system: true } }),
      message({ type: 7 }),
      message({ content: '' }),
      message({ content: '   ' }),
      message({ guild_id: '666666666666666666' }),
      message({ id: '../../x' }),
      { ...message(), t: 'MESSAGE_UPDATE' },
      { op: 11 },
      null,
    ]) {
      expect((await normalize(envelope)).records).toEqual([]);
    }
    // With no server configured, every server's messages are read.
    expect((await normalize(message({ guild_id: '666666666666666666' }), {})).records).toHaveLength(1);
  });

  it('replies to the message without pinging anyone and returns the new message id', async () => {
    const replyId = '777777777777777777';
    const fetch = vi.fn(async () => jsonResponse(200, { id: replyId, channel_id: channelId }));
    const replyArgs = { channelId, threadId: messageId, text: 'See https://papercusp.com/download' };
    const result = await adapter.invoke({ source: 'source', config: {}, capability: 'chat.reply', args: replyArgs }, { fetch });
    expect(result).toEqual({ channelId, threadId: messageId, messageTs: replyId });
    const call = callOf(fetch);
    expect(call.request).toMatchObject({ url: `https://discord.com/api/v10/channels/${channelId}/messages`, method: 'POST' });
    expect(Object.keys(call.request.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
    const body = JSON.parse(call.request.body!);
    expect(body).toEqual({
      content: replyArgs.text, nonce: expect.any(String), enforce_nonce: true,
      message_reference: { message_id: messageId, fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    });
    expect(body.nonce).toHaveLength(25);
    const again = vi.fn(async () => jsonResponse(200, { id: replyId, channel_id: channelId }));
    await adapter.invoke({ source: 'source', config: {}, capability: 'chat.reply', args: replyArgs }, { fetch: again });
    expect(JSON.parse(callOf(again).request.body!).nonce).toBe(body.nonce);
  });

  it('refuses bad reply coordinates or text before any request, and keeps an unconfirmed reply ambiguous', async () => {
    const fetch = vi.fn();
    const reply = (args: Record<string, unknown>, f: HostFetch = fetch) =>
      adapter.invoke({ source: 'source', config: {}, capability: 'chat.reply', args }, { fetch: f });
    await expect(reply({ channelId: 'C1', threadId: messageId, text: 'x' })).rejects.toThrow('invalid_channel_id');
    await expect(reply({ channelId, threadId: '1.2', text: 'x' })).rejects.toThrow('invalid_thread_id');
    await expect(reply({ channelId, threadId: messageId, text: 'x'.repeat(2001) })).rejects.toThrow('invalid_text');
    expect(fetch).not.toHaveBeenCalled();
    await expect(reply({ channelId, threadId: messageId, text: 'x' }, vi.fn(async () => jsonResponse(500, {}))))
      .rejects.toMatchObject({ kind: 'transient', retrySafe: false });
    await expect(reply({ channelId, threadId: messageId, text: 'x' }, vi.fn(async () => jsonResponse(403, {}))))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  it('declares the Gateway session the host runs: Bot auth, v10 JSON, identify with the needed intents, heartbeats, dispatch only', async () => {
    const d = await adapter.describe();
    const socket = d.ingress!.socket;
    expect(socket.credential).toBe('bot_token');
    expect(socket.open).toEqual({ url: 'https://discord.com/api/v10/gateway/bot', method: 'GET', urlField: 'url', query: { v: '10', encoding: 'json' } });
    // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
    expect(socket.session!.identify.frame).toMatchObject({ op: 2, d: { token: '{{credential}}', intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15) } });
    expect(socket.session!.heartbeat).toEqual({ frame: { op: 1, d: '{{sequence}}' }, requestMatch: { field: 'op', values: ['1'] } });
    expect(socket.session!.deliver).toEqual({ field: 'op', values: ['0'] });
    expect(socket.reconnect).toEqual({ field: 'op', values: ['7', '9'] });
    expect(d.defaultDestinations).toEqual({ 'chat-message': ['document', 'event'] });
  });
});
