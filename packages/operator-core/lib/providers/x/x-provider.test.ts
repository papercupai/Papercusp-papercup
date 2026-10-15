import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  jsonResponse, recordedHostFetch, runProviderConformance, validateProviderDescriptor,
  type HostFetch, type ProviderAdapter, type ProviderRecord, type ProviderSyncPage,
} from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/x/index.cjs').providerAdapter as ProviderAdapter;
const config = { userId: '42', username: 'Avi' };
const NOW = new Date('2026-10-15T08:00:00Z');
const at = '2026-10-14T08:00:00Z';
const tweet = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `post ${id}`, created_at: at, author_id: '43', ...extra });
const reply = (id: string) => tweet(id, { in_reply_to_user_id: '42', conversation_id: '1000', referenced_tweets: [{ type: 'replied_to', id: '1001' }] });
const collection = (data: unknown[], next?: string) => jsonResponse(200, {
  data, meta: { result_count: data.length, ...(next ? { next_token: next } : {}) }, includes: { users: [{ id: '43', username: 'sam' }] },
});

function fake() {
  return recordedHostFetch([
    { method: 'GET', url: (u) => u.pathname === '/2/users/42/mentions', response: ({ url }) => {
      const u = new URL(url);
      if (u.searchParams.has('since_id')) return collection([]);
      return u.searchParams.has('pagination_token')
        ? collection([tweet('52'), tweet('51', { note_tweet: { text: 'long post' } })])
        : collection([tweet('52'), reply('54')], 'mention-page-2');
    } },
    { method: 'GET', url: (u) => u.pathname === '/2/tweets/search/recent', response: ({ url }) => new URL(url).searchParams.has('since_id')
      ? collection([]) : collection([reply('54')]) },
    { method: 'POST', url: (u) => u.pathname === '/2/tweets', response: jsonResponse(201, { data: { id: '55', text: 'test' } }) },
    { method: 'DELETE', url: (u) => u.pathname === '/2/tweets/55', response: jsonResponse(200, { data: { deleted: true } }) },
  ]);
}

async function drain(fetch: HostFetch, cursor: string | null = null, budget = 20) {
  const records: ProviderRecord[] = [];
  const pages: ProviderSyncPage[] = [];
  for (let n = 0; n < budget; n++) {
    const page = await adapter.syncPage({ source: 'x-source', cursor, mode: cursor ? 'incremental' : 'backfill', config }, { fetch });
    records.push(...page.records); pages.push(page); cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  return { records, pages, cursor };
}

describe('X provider package (P-023)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('validates OAuth PKCE, account identity and the generic social capabilities', async () => {
    const d = await adapter.describe();
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.oauth).toMatchObject({ pkce: true, clientRegistrationRef: 'x', scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'], identity: { idField: 'data.id' } });
    expect(d.capabilities).toEqual(['social.post', 'social.reply', 'social.delete']);
  });

  it('maps mentions and incoming replies once across overlapping endpoints and pages', async () => {
    const world = fake(); const result = await drain(world.fetch);
    expect(result.records.map((r) => [r.nativeId, r.event])).toEqual([['52', 'mention'], ['51', 'mention'], ['54', 'reply']]);
    expect(result.records[1]?.payload).toMatchObject({ platform: 'x-twitter', text: 'long post', author: 'sam' });
    expect(result.records[2]).toMatchObject({ version: '54', payload: { replyToId: '1001', threadId: '1000', subjectId: '1001' } });
    expect(world.calls).toHaveLength(3);
    expect(new URL(world.calls[2].request.url).searchParams.get('query')).toBe('to:avi is:reply');
    expect(new URL(world.calls[2].request.url).searchParams.get('sort_order')).toBe('recency');
    expect(world.calls.every((c) => c.source === 'x-source' && c.request.headers?.authorization === undefined)).toBe(true);
    expect((await drain(world.fetch, result.cursor)).records).toEqual([]);
  });

  it('passes the shared SDK conformance kit with actual reads and every declared write', async () => {
    const report = await runProviderConformance({ adapter, config, createFetch: () => fake().fetch,
      faults: { expiredCursor: { cursor: 'invalid-json' } },
      invocations: [
        { capability: 'social.post', args: { destination: '42', text: 'test' } },
        { capability: 'social.reply', args: { target: { objectId: '1001' }, text: 'reply' } },
        { capability: 'social.delete', args: { externalId: '55' } },
      ],
      validatePayload: (_type, p) => typeof p.id === 'string' && typeof p.text === 'string' && p.platform === 'x-twitter' ? null : 'bad social post',
    });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checksRun).toContain('resume-without-duplicates');
  });

  it('makes one ten-result request per page and preserves work at the host pass budget', async () => {
    const firstWorld = fake(); const first = await drain(firstWorld.fetch, null, 1);
    expect(firstWorld.calls).toHaveLength(1);
    expect(first.pages[0].hasMore).toBe(true);
    expect(new URL(firstWorld.calls[0].request.url).searchParams.get('max_results')).toBe('10');
    const secondWorld = fake(); const rest = await drain(secondWorld.fetch, first.cursor);
    expect(secondWorld.calls).toHaveLength(2);
    expect(new URL(secondWorld.calls[0].request.url).searchParams.get('pagination_token')).toBe('mention-page-2');
    expect([...first.records, ...rest.records]).toEqual((await drain(fake().fetch)).records);
  });

  it('keeps large adjacent snowflake ids distinct at the incremental boundary', async () => {
    const first = await drain(recordedHostFetch([
      { url: (u) => u.pathname.endsWith('/mentions'), response: collection([tweet('9007199254740992')]) },
      { url: (u) => u.pathname.endsWith('/recent'), response: collection([]) },
    ]).fetch);
    const result = await drain(recordedHostFetch([
      { url: (u) => u.pathname.endsWith('/mentions'), response: collection([tweet('9007199254740992'), tweet('9007199254740993')]) },
      { url: (u) => u.pathname.endsWith('/recent'), response: collection([]) },
    ]).fetch, first.cursor);
    expect(result.records.map((r) => r.nativeId)).toEqual(['9007199254740993']);
  });

  it('reports a measured retention gap and carries it through host cursor recovery', async () => {
    const initial = await drain(fake().fetch);
    vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
    const old = JSON.parse(initial.cursor!);
    const page = await adapter.syncPage({ source: 's', config, cursor: initial.cursor, mode: 'incremental' }, fake());
    expect(page.lossRisk).toMatchObject({ kind: 'retention-window-exceeded', oldestReachableAt: '2026-10-16T08:01:00.000Z' });
    const reset = await adapter.syncPage({ source: 's', config, cursor: null, mode: 'backfill', catchUpFrom: JSON.stringify(old) }, fake());
    expect(reset.catchUp).toEqual({ path: 'backfill', reason: 'cursor-expired' });
    expect(reset.lossRisk).toEqual(page.lossRisk);
    const cold = await adapter.syncPage({ source: 's', config, cursor: null, mode: 'backfill', catchUpFrom: 'unknown' }, fake());
    expect(cold.lossRisk).toBeUndefined();
  });

  it('classifies throttling, revoked grants and server faults without retry or response echo', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limited'], [503, 'transient']] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, { detail: 'secret response' }, { 'Retry-After': '19' }));
      const err = await adapter.syncPage({ source: 's', config, cursor: null, mode: 'backfill' }, { fetch }).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind });
      expect(String(err)).not.toContain('secret response');
      expect(fetch).toHaveBeenCalledTimes(1);
      if (status === 429) expect(err).toMatchObject({ retryAfterSeconds: 19 });
    }
    const fetch: HostFetch = async () => jsonResponse(429, {}, { 'x-rate-limit-reset': String(NOW.getTime() / 1000 + 45) });
    await expect(drain(fetch)).rejects.toMatchObject({ retryAfterSeconds: 45 });
  });

  it('returns expired pagination to the host and rejects token cycles', async () => {
    const first = await drain(fake().fetch, null, 1);
    const fetch = vi.fn(async () => jsonResponse(400, { detail: 'bad token' }));
    await expect(drain(fetch, first.cursor)).rejects.toMatchObject({ kind: 'cursor-expired' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const cycle = vi.fn(async () => collection([], 'mention-page-2'));
    await expect(drain(cycle, first.cursor)).rejects.toMatchObject({ kind: 'cursor-expired', message: 'x:pagination_made_no_progress' });
  });

  it('refuses malformed configuration and cursor state before network access', async () => {
    const fetch = vi.fn(async () => collection([]));
    for (const cursor of ['broken', '{}', JSON.stringify({ v: 1, config, phase: 'ready' })]) {
      await expect(drain(fetch, cursor)).rejects.toMatchObject({ kind: 'cursor-expired' });
    }
    await expect(adapter.syncPage({ source: 's', config: { ...config, username: 'a OR from:other' }, cursor: null, mode: 'backfill' }, { fetch })).rejects.toThrow('invalid_account_config');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects partial errors and malformed collections without committing a cursor', async () => {
    for (const body of [{ data: [tweet('1')], errors: [{ detail: 'partial' }], meta: { result_count: 1 } }, { meta: {} }, { data: [{}], meta: { result_count: 1 } }]) {
      const fetch = vi.fn(async () => jsonResponse(200, body));
      await expect(drain(fetch)).rejects.toMatchObject({ kind: 'transient' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('publishes and replies with JSON, returning only confirmed server ids', async () => {
    const world = fake();
    expect(await adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: '42', text: 'A & B' } }, world)).toMatchObject({ externalId: '55', url: 'https://x.com/i/web/status/55' });
    expect(JSON.parse(world.calls[0].request.body!)).toEqual({ text: 'A & B' });
    expect(await adapter.invoke({ source: 's', config, capability: 'social.reply', args: { target: { objectId: '1001' }, text: 'reply' } }, world)).toMatchObject({ externalId: '55' });
    expect(JSON.parse(world.calls[1].request.body!)).toEqual({ text: 'reply', reply: { in_reply_to_tweet_id: '1001' } });
    const fetch = vi.fn(async () => jsonResponse(201, { data: { text: 'unconfirmed' } }));
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: '42', text: 'test' } }, { fetch })).rejects.toThrow('write_unconfirmed_no_server_id');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses wrong destinations, unsupported media and forged reply ids before writes', async () => {
    const fetch = vi.fn(async () => jsonResponse(201, { data: { id: '55' } }));
    for (const args of [{ destination: '99', text: 'x' }, { destination: '42', text: 'x', media: ['photo'] }, { destination: '42', text: ' ' }]) {
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args }, { fetch })).rejects.toMatchObject({ kind: 'transient' });
    }
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { target: { objectId: '../secrets' }, text: 'x' } }, { fetch })).rejects.toThrow('invalid_reply_id');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the delete acknowledgement and preserves an explicit refusal', async () => {
    const args = { source: 's', config, capability: 'social.delete', args: { externalId: '55' } };
    expect(await adapter.invoke(args, fake())).toEqual({ deleted: true });
    expect(await adapter.invoke(args, { fetch: async () => jsonResponse(200, { data: { deleted: false } }) })).toEqual({ deleted: false });
    await expect(adapter.invoke(args, { fetch: async () => jsonResponse(200, {}) })).rejects.toThrow('delete_unconfirmed');
  });
});
