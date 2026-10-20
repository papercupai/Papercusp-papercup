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
  it('declares notify.send and community.presence behind a host-held Bot token, with an honestly empty sync', async () => {
    const d = await adapter.describe();
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d).toMatchObject({ id: 'discord', datatypes: ['notification'], capabilities: ['notify.send', 'community.presence'], sync: false, egressHosts: ['discord.com'] });
    expect(d.oauth).toBeUndefined();
    expect(d.setup?.credentials).toEqual([expect.objectContaining({ key: 'bot_token', hosts: ['discord.com'], auth: { header: 'authorization', scheme: 'bot' } })]);
    expect(d.verification?.capabilities).toEqual({ 'notify.send': '2026-10-20', 'community.presence': '2026-10-20' });
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
    await expect(adapter.invoke({ source: 'source', config, capability: 'chat.reply', args }, { fetch })).rejects.toThrow('capability_unsupported');
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

  it('passes the shared conformance kit with both of its actual invocations', async () => {
    const widget = () => jsonResponse(200, { id: guildId, name: 'Papercusp', presence_count: 42 });
    const report = await runProviderConformance({ adapter, source: 'source', config,
      createFetch: () => async ({ request }) => request.url.endsWith('/widget.json') ? widget() : sent(),
      faults: { rateLimited: false, auth: false, serverError: false },
      invocations: [
        { capability: 'notify.send', args, check: (r) => (r as { externalId?: unknown }).externalId === messageId ? null : 'message id required' },
        { capability: 'community.presence', args: {}, check: (r) => (r as { presenceCount?: unknown }).presenceCount === 42 ? null : 'online count required' },
      ] });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
