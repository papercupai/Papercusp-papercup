import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter, type ProviderRecord } from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/mastodon/index.cjs').providerAdapter as ProviderAdapter;
const origin = 'https://mastodon.social';
const config = { connectionOrigin: origin, connectionAccountId: 'owner', pageSize: 2, maxPages: 50 };
const status = (id: string, extra: Record<string, unknown> = {}) => ({ id, uri: `${origin}/users/ada/statuses/${id}`, url: `${origin}/@ada/${id}`,
  created_at: '2026-10-15T10:00:00Z', edited_at: null, content: `<p>${id} &amp;lt;script&amp;gt; &#x1F600;</p>`,
  visibility: 'private', in_reply_to_id: null, account: { id: 'owner', acct: 'ada' }, ...extra });
const postArgs = { destination: 'mastodon.social', text: 'hello', visibility: 'followers', idempotencyKey: 'host-stable-key' };
const replyArgs = { ...postArgs, target: { platform: 'mastodon', instanceHost: 'mastodon.social', inReplyToId: 'local-status' } };
function world() {
  // Server order deliberately disagrees with numeric AND lexical sorting.
  const timeline = ['opaque-z', '9007199254740993', '9', '10', 'opaque-a'].map((id) => status(id));
  const mentions = ['notif-z', 'notif-a', 'notif-9'].map((id, n) => ({ id, type: 'mention', status: status(`mention-${n}`, { in_reply_to_id: 'parent' }) }));
  const calls: Parameters<HostFetch>[0][] = [];
  const fetch: HostFetch = async (input) => {
    calls.push(input); const u = new URL(input.request.url); const method = input.request.method ?? 'GET';
    if (u.pathname === '/api/v1/statuses' && method === 'POST') return jsonResponse(200, status('created'));
    if (u.pathname.startsWith('/api/v1/statuses/')) return jsonResponse(200, status(decodeURIComponent(u.pathname.split('/').at(-1)!)));
    const rows = u.pathname.endsWith('/notifications') ? mentions : timeline;
    const limit = Number(u.searchParams.get('limit'));
    const min = u.searchParams.get('min_id'); const max = u.searchParams.get('max_id');
    const start = min ? rows.findIndex((r) => r.id === min) + 1 : max ? Math.max(0, rows.findIndex((r) => r.id === max) - limit) : Math.max(0, rows.length - limit);
    const end = min ? start + limit : max ? rows.findIndex((r) => r.id === max) : rows.length;
    return jsonResponse(200, rows.slice(start, end).reverse(), { link: '<https://foreign.example/steal?access_token=secret>; rel="next"' });
  };
  return { fetch, calls, timeline, mentions };
}
async function drain(fetch: HostFetch, cursor: string | null = null, chosen = config) {
  const records: ProviderRecord[] = []; const cursors: string[] = [];
  for (let n = 0; n < 100; n++) {
    const page = await adapter.syncPage({ source: 'mastodon-source', config: chosen, cursor, mode: cursor ? 'incremental' : 'backfill' }, { fetch });
    records.push(...page.records); cursor = page.nextCursor; cursors.push(cursor!);
    expect(page.lossRisk).toBeUndefined();
    if (!page.hasMore) return { records, cursor, cursors };
  }
  throw new Error('Mastodon fixture failed to settle');
}
describe('Mastodon provider package (P-001, D-019)', () => {
  it('derives instance-local selectors from stored records and refuses absent or foreign hosts before fetching', async () => {
    const w = world();
    const target = { platform: 'mastodon', externalId: `${origin}/users/ada/statuses/local-status`,
      payload: { statusId: 'local-status', instanceHost: 'mastodon.social' } };
    await adapter.invoke({ source: 's', config, capability: 'social.reply', args: { ...postArgs, target } }, { fetch: w.fetch });
    expect(new URLSearchParams(w.calls[0].request.body).get('in_reply_to_id')).toBe('local-status');
    w.calls.length = 0;
    for (const capability of ['social.reply', 'social.delete']) {
      for (const payload of [{ statusId: 'local-status' }, { statusId: 'local-status', instanceHost: 'foreign.example' }]) {
        await expect(adapter.invoke({ source: 's', config, capability, args: { ...postArgs, target: { ...target, payload } } }, { fetch: w.fetch })).rejects.toThrow('instance_mismatch');
      }
    }
    expect(w.calls).toHaveLength(0);
    await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target } }, { fetch: w.fetch });
    expect(new URL(w.calls[0].request.url).pathname).toBe('/api/v1/statuses/local-status');
  });
  it('declares a generic instance OAuth grant and all three actual write capabilities', async () => {
    const d = await adapter.describe(); expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.egressHosts).toEqual([]); expect(d.oauth).toMatchObject({ instance: true, tokenUrl: '/oauth/token', identity: { idField: 'id' } });
    expect(d.capabilities).toEqual(['social.post', 'social.reply', 'social.delete']);
  });
  it('reads both histories with opaque IDs, preserves HTML and coordinates, and resumes mid-walk', async () => {
    const w = world(); const full = await drain(w.fetch);
    expect(full.records.map((r) => r.payload.statusId)).toEqual(['opaque-a', '10', '9', '9007199254740993', 'opaque-z', 'mention-2', 'mention-1', 'mention-0']);
    expect(full.records[0].payload).toMatchObject({ text: 'opaque-a &lt;script&gt; 😀', visibility: 'private', instanceHost: 'mastodon.social', statusId: 'opaque-a' });
    expect(full.records.at(-1)).toMatchObject({ event: 'mention', payload: { replyToId: 'parent' } });
    expect(full.records[0].nativeId).toBe(status('opaque-a').uri);
    expect(full.records[0].version).toBe('opaque-a@2026-10-15T10:00:00Z');
    expect((await drain(world().fetch, full.cursors[0])).records.map((r) => r.payload.statusId)).toEqual(full.records.slice(2).map((r) => r.payload.statusId));
    expect((await drain(w.fetch, full.cursor)).records).toEqual([]);
    expect(w.calls.every(({ request }) => new URL(request.url).origin === origin)).toBe(true);
    expect(JSON.stringify(full)).not.toContain('secret');
    expect(w.calls.filter(({ request }) => request.url.includes('/notifications')).every(({ request }) => new URL(request.url).searchParams.get('types[]') === 'mention')).toBe(true);
  });
  it('closes multi-page offline gaps in both streams using min_id, without dropping the middle', async () => {
    const w = world(); const prior = await drain(w.fetch); w.calls.length = 0;
    w.timeline.push(...['z-next', '1-next', '9007199254740995', 'middle', 'last'].map((id) => status(id)));
    w.mentions.push(...['n4', 'n5', 'n6'].map((id) => ({ id, type: 'mention', status: status(id) })));
    const resumed = await drain(w.fetch, prior.cursor);
    expect(resumed.records.map((r) => r.payload.statusId).sort()).toEqual(['z-next', '1-next', '9007199254740995', 'middle', 'last', 'n4', 'n5', 'n6'].sort());
    expect(new Set(resumed.records.map((r) => r.nativeId)).size).toBe(8);
    expect(w.calls.every(({ request }) => { const u = new URL(request.url); return u.searchParams.has('min_id') && !u.searchParams.has('since_id') && !u.searchParams.has('max_id'); })).toBe(true);
    expect((await drain(w.fetch, resumed.cursor)).records).toEqual([]);
  });
  it('keeps edit versions distinct and collapses an overlapping page replay', async () => {
    const w = world(); let reads = 0; const base = w.fetch;
    const full = await drain(async (r) => {
      if (new URL(r.request.url).pathname.endsWith('/home') && ++reads === 2) return jsonResponse(200, [status('opaque-a'), status('10', { edited_at: '2026-10-16T10:00:00Z' }), status('9')]);
      return base(r);
    });
    expect(full.records.filter((r) => r.payload.statusId === 'opaque-a')).toHaveLength(1);
    expect(full.records.filter((r) => r.payload.statusId === '10').map((r) => r.version)).toEqual(['10@2026-10-15T10:00:00Z', '10@2026-10-16T10:00:00Z']);
  });
  it('refuses unreadable, impossible and stalled cursors and successful page truncation', async () => {
    await expect(drain(world().fetch, 'not-json')).rejects.toMatchObject({ kind: 'cursor-expired' });
    const prior = await drain(world().fetch); const bad = JSON.parse(prior.cursor!); bad.phase = '2';
    await expect(drain(world().fetch, JSON.stringify(bad))).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(drain(async () => jsonResponse(200, [status('same')]))).rejects.toThrow('paging_made_no_progress');
    await expect(drain(world().fetch, null, { ...config, maxPages: 1 })).rejects.toThrow('page_bound_exceeded');
  });
  it('starts fresh after instance or connected-account changes', async () => {
    const prior = await drain(world().fetch);
    for (const chosen of [{ ...config, connectionOrigin: 'https://hachyderm.io' }, { ...config, connectionAccountId: 'another' }]) {
      const calls: string[] = [];
      await adapter.syncPage({ source: 's', config: chosen, cursor: prior.cursor, mode: 'incremental' }, { fetch: async ({ request }) => { calls.push(request.url); return jsonResponse(200, []); } });
      expect(new URL(calls[0]).origin).toBe(chosen.connectionOrigin); expect(new URL(calls[0]).searchParams.has('min_id')).toBe(false);
    }
  });
  it('passes the unchanged SDK kit against paged records and all actual writes', async () => {
    const report = await runProviderConformance({ adapter, source: 'mastodon-source', config, createFetch: () => world().fetch,
      invocations: [{ capability: 'social.post', args: postArgs }, { capability: 'social.reply', args: replyArgs }, { capability: 'social.delete', args: { target: replyArgs.target } }],
      validatePayload: (_type, payload) => typeof payload.id === 'string' && typeof payload.text === 'string' ? null : 'id/text missing' });
    expect(report.failures).toEqual([]); expect(report.ok).toBe(true);
  });
  it.each([['public', 'public'], ['unlisted', 'unlisted'], ['followers', 'private'], ['direct', 'direct']])('maps neutral %s to %s and forwards the host idempotency key', async (visibility, native) => {
    const w = world();
    expect(await adapter.invoke({ source: 's', config, capability: 'social.reply', args: { ...replyArgs, visibility } }, w)).toEqual({ externalId: status('created').uri, url: status('created').url });
    expect(w.calls).toHaveLength(1); expect(w.calls[0].request.headers?.['Idempotency-Key']).toBe('host-stable-key');
    expect(Object.fromEntries(new URLSearchParams(w.calls[0].request.body))).toEqual({ in_reply_to_id: 'local-status', status: 'hello', visibility: native });
  });
  it('deletes only the connected account’s status and distinguishes absence and a disappearance race', async () => {
    const w = world(); expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target: replyArgs.target } }, w)).toEqual({ deleted: true });
    expect(w.calls.map(({ request }) => request.method)).toEqual(['GET', 'DELETE']);
    const fetch = vi.fn(async () => jsonResponse(200, status('local-status', { account: { id: 'another', acct: 'not-ada' } })));
    await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target: replyArgs.target } }, { fetch })).rejects.toMatchObject({ kind: 'auth' }); expect(fetch).toHaveBeenCalledTimes(1);
    for (const race of [false, true]) {
      const absent = vi.fn(async ({ request }: Parameters<HostFetch>[0]) => !race || request.method === 'DELETE' ? jsonResponse(404, {}) : jsonResponse(200, status('local-status')));
      expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target: replyArgs.target } }, { fetch: absent })).toEqual({ deleted: false });
      expect(absent).toHaveBeenCalledTimes(race ? 2 : 1);
    }
  });
  it('rejects cross-instance writes, unsupported media/visibility and missing keys before fetching', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, {}));
    for (const capability of ['social.reply', 'social.delete']) await expect(adapter.invoke({ source: 's', config, capability, args: { ...replyArgs, target: { ...replyArgs.target, instanceHost: 'hachyderm.io' } } }, { fetch })).rejects.toThrow('instance_mismatch');
    for (const patch of [{ destination: 'hachyderm.io' }, { idempotencyKey: '' }, { visibility: 'constructor' }, { media: [{ type: 'image', url: 'https://cdn.example/photo.jpg' }] }]) await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { ...postArgs, ...patch } }, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies auth, throttle/reset and server errors without retrying', async () => {
    for (const [statusCode, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limited'], [503, 'transient']] as const) {
      const fetch = vi.fn(async () => jsonResponse(statusCode, {}, { 'Retry-After': '37' }));
      await expect(drain(fetch)).rejects.toMatchObject({ kind, ...(statusCode === 429 ? { retryAfterSeconds: 37 } : {}) }); expect(fetch).toHaveBeenCalledTimes(1);
    }
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    try { await expect(drain(async () => jsonResponse(429, {}, { 'X-RateLimit-Reset': '2026-10-16T10:00:19Z' }))).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 19 }); } finally { vi.useRealTimers(); }
    const fetch = vi.fn(async () => jsonResponse(503, {}));
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch })).rejects.toThrow('write_unconfirmed_do_not_retry'); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
