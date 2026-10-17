import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter, type ProviderRecord } from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/reddit/index.cjs').providerAdapter as ProviderAdapter;
const config = { accountLabel: 'fixture-user', pageSize: 2, maxPages: 10 };
const target = { platform: 'reddit', parentFullname: 't1_a' };
function thing(id: string, extra: Record<string, unknown> = {}) {
  const kind = id.slice(0, 2);
  return { kind, data: { name: id, id: id.slice(3), created_utc: 1800000000, edited: false, author: config.accountLabel,
    subreddit: 'papercusp', ...(kind === 't3' ? { title: id, selftext: 'post text' } : { body: 'reply & <text>', was_comment: true, parent_id: 't3_root', context: '/r/papercusp/comments/root/title/a/?context=3' }), ...extra } };
}
const listing = (children: unknown[]) => jsonResponse(200, { kind: 'Listing', data: { children, after: null } });
function world() {
  const rows = { comments: [thing('t1_d'), thing('t1_c'), thing('t1_b'), thing('t1_a')], mentions: [thing('t1_m')], submitted: [thing('t3_p')] };
  const calls: Parameters<HostFetch>[0][] = []; let deleted = false;
  const fetch: HostFetch = async (input) => {
    calls.push(input); const url = new URL(input.request.url); const form = new URLSearchParams(input.request.body);
    if (url.pathname === '/api/comment') return jsonResponse(200, { json: { errors: [], data: { things: [thing('t1_new')] } } });
    if (url.pathname === '/api/submit') return jsonResponse(200, { json: { errors: [], data: { name: 't3_new', url: 'https://www.reddit.com/r/papercusp/comments/new' } } });
    if (url.pathname === '/api/del') { expect(form.get('id')).toBe('t1_a'); deleted = true; return jsonResponse(200, {}); }
    if (url.pathname === '/api/info') return listing([thing('t1_a', { author: deleted ? '[deleted]' : config.accountLabel })]);
    const stream = url.pathname.endsWith('/submitted') ? 'submitted' : url.pathname.split('/').at(-1)! as keyof typeof rows;
    const chosen = rows[stream]; if (!chosen) throw new Error(`unexpected endpoint ${url.pathname}`);
    const after = url.searchParams.get('after'); const start = after ? chosen.findIndex((r) => r.data.name === after) + 1 : 0;
    return listing(chosen.slice(start, start + Number(url.searchParams.get('limit'))));
  };
  return { rows, calls, fetch };
}
async function drain(fetch: HostFetch, cursor: string | null = null, chosen = config) {
  const records: ProviderRecord[] = []; const cursors: string[] = [];
  for (let n = 0; n < 50; n++) {
    const page = await adapter.syncPage({ source: 'source', config: chosen, cursor, mode: cursor ? 'incremental' : 'backfill' }, { fetch });
    records.push(...page.records); cursor = page.nextCursor; cursors.push(cursor!);
    if (!page.hasMore) return { records, cursor, cursors, catchUp: page.catchUp };
  }
  throw new Error('fixture did not settle');
}
describe('Reddit provider package (P-031)', () => {
  it('derives stored comment and submission fullnames without accepting messages or bare ids', async () => {
    const w = world();
    for (const payload of [{ parentFullname: 't1_a' }, { fullname: 't1_a' }, {}]) {
      await adapter.invoke({ source: 's', config, capability: 'social.reply', args: { text: 'reply',
        target: { platform: 'reddit', externalId: 't1_a', payload } } }, { fetch: w.fetch });
      expect(new URLSearchParams(w.calls.at(-1)!.request.body).get('thing_id')).toBe('t1_a');
    }
    w.calls.length = 0;
    for (const externalId of ['t4_message', 'abc', '../other']) {
      await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { text: 'reply',
        target: { platform: 'reddit', externalId, payload: {} } } }, { fetch: w.fetch })).rejects.toThrow('invalid_content_target');
    }
    expect(w.calls).toHaveLength(0);
    await adapter.invoke({ source: 's', config, capability: 'social.delete', args: {
      target: { platform: 'reddit', externalId: 't1_a', payload: {} } } }, { fetch: w.fetch });
    expect(new URL(w.calls[0].request.url).searchParams.get('id')).toBe('t1_a');
  });
  it('requires host-held Basic OAuth and truthful owner-supplied identification', async () => {
    const d = await adapter.describe(); expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.oauth).toMatchObject({ tokenEndpointAuthMethod: 'client_secret_basic', userAgentRequired: true, identity: { displayNameField: 'name' } });
    expect(d.configSchema?.required).toEqual(['accountLabel']);
    expect(d.capabilities).toEqual(['social.post', 'social.reply', 'social.delete']);
  });
  it('walks all three streams, retains reply coordinates and resumes a multi-page checkpoint without re-emitting prior pages', async () => {
    const w = world(); const full = await drain(w.fetch);
    expect(full.records.map((r) => r.nativeId)).toEqual(['t1_d', 't1_c', 't1_b', 't1_a', 't1_m', 't3_p']);
    expect(full.records[0]).toMatchObject({ event: 'reply', payload: { parentFullname: 't1_d', replyToId: 't3_root', subjectId: 't3_root', text: 'reply & <text>' } });
    expect(full.records[4].event).toBe('mention'); expect(full.records[5].event).toBe('post');
    expect((await drain(world().fetch, full.cursors[0])).records.map((r) => r.nativeId)).toEqual(full.records.slice(2).map((r) => r.nativeId));
    expect((await drain(w.fetch, full.cursor)).records).toEqual([]);
    expect(w.calls.every((c) => !c.request.headers?.authorization && !c.request.headers?.['user-agent'])).toBe(true);
    expect(w.calls.every((c) => new URL(c.request.url).searchParams.get('raw_json') === '1')).toBe(true);
  });
  it('closes a gap across multiple pages without passing its saved marker as a before anchor', async () => {
    const w = world(); const prior = await drain(w.fetch); w.calls.length = 0;
    w.rows.comments.unshift(...['t1_h', 't1_g', 't1_f', 't1_e'].map((id) => thing(id)));
    const next = await drain(w.fetch, prior.cursor);
    expect(next.records.map((r) => r.nativeId)).toEqual(['t1_h', 't1_g', 't1_f', 't1_e']);
    expect(w.calls.every((r) => !new URL(r.request.url).searchParams.has('before'))).toBe(true);
    const again = await drain(w.fetch, next.cursor); expect(again.records).toEqual([]);
  });
  it('detects a changed marker edit version and ignores direct messages without treating their ids as content ids', async () => {
    const w = world(); const prior = await drain(w.fetch);
    w.rows.comments[0] = thing('t1_d', { edited: true, body: 'edited' });
    expect((await drain(w.fetch, prior.cursor)).records).toMatchObject([{ nativeId: 't1_d', version: 't1_d@e-legacy', payload: { text: 'edited' } }]);
    const withDm = world(); withDm.rows.comments.unshift(thing('t4_msg', { was_comment: false }));
    expect((await drain(withDm.fetch)).records.some((r) => r.nativeId === 't4_msg')).toBe(false);
  });
  it('refuses invalid, non-progressing and over-bound pages and resets on a different connected username', async () => {
    await expect(drain(world().fetch, '{}')).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(drain(async () => listing([thing('t1_a'), thing('t1_b')]))).rejects.toThrow('paging_made_no_progress');
    await expect(drain(world().fetch, null, { ...config, maxPages: 1 })).rejects.toThrow('page_bound_exceeded');
    const prior = await drain(world().fetch); const changed = world();
    await adapter.syncPage({ source: 's', cursor: prior.cursor, config: { ...config, accountLabel: 'another-user' }, mode: 'incremental' }, { fetch: changed.fetch });
    expect(new URL(changed.calls[0].request.url).searchParams.has('after')).toBe(false);
  });
  it('passes the unchanged provider kit with actual pagination, resume and all three writes', async () => {
    const report = await runProviderConformance({ adapter, source: 'source', config, createFetch: () => world().fetch,
      invocations: [{ capability: 'social.post', args: { destination: 'r/papercusp#Required title', text: 'one post' } },
        { capability: 'social.reply', args: { target, text: 'one reply' } }, { capability: 'social.delete', args: { target } }],
      validatePayload: (_type, payload) => typeof payload.id === 'string' && typeof payload.text === 'string' ? null : 'id/text missing' });
    expect(report.failures).toEqual([]); expect(report.ok).toBe(true);
  });
  it('publishes explicit titles, keeps duplicate suppression enabled and permits only content replies', async () => {
    const w = world();
    expect(await adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: 'reddit:r/papercusp#A real title', text: 'body' } }, { fetch: w.fetch })).toMatchObject({ externalId: 't3_new' });
    const form = new URLSearchParams(w.calls[0].request.body); expect(form.get('title')).toBe('A real title'); expect(form.get('resubmit')).toBe('false');
    expect(await adapter.invoke({ source: 's', config, capability: 'social.reply', args: { target, text: 'reply' } }, { fetch: w.fetch })).toMatchObject({ externalId: 't1_new' });
    expect(new URLSearchParams(w.calls[1].request.body).get('thing_id')).toBe('t1_a');
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { target: { ...target, parentFullname: 't4_message' }, text: 'not a DM' } }, { fetch: w.fetch })).rejects.toThrow('invalid_content_target');
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: 'r/papercusp', text: 'no title' } }, { fetch: w.fetch })).rejects.toThrow('destination_needs');
    expect(w.calls).toHaveLength(2);
  });
  it('checks ownership and verifies deletion instead of assuming an empty response proves removal', async () => {
    const w = world(); expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target } }, { fetch: w.fetch })).toEqual({ deleted: true });
    expect(w.calls.map((r) => new URL(r.request.url).pathname)).toEqual(['/api/info', '/api/del', '/api/info']);
    const foreign = vi.fn(async () => listing([thing('t1_a', { author: 'someone-else' })]));
    await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target } }, { fetch: foreign })).rejects.toMatchObject({ kind: 'auth' });
    expect(foreign).toHaveBeenCalledTimes(1);
    const unchanged: HostFetch = async ({ request }) => new URL(request.url).pathname === '/api/del' ? jsonResponse(200, {}) : listing([thing('t1_a')]);
    expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target } }, { fetch: unchanged })).toMatchObject({ deleted: false, detail: expect.stringContaining('not yet confirmed') });
  });
  it('reports vendor delay to the host and never retries an ambiguous write', async () => {
    await expect(drain(async () => jsonResponse(429, {}, { 'x-ratelimit-reset': '12.3' }))).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 13 });
    const fetch = vi.fn(async () => { throw new Error('connection closed after write'); });
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { target, text: 'one reply' } }, { fetch })).rejects.toMatchObject({ retrySafe: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
