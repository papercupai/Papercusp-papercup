import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, recordedHostFetch, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter, type ProviderRecord, type ProviderSyncPage } from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/threads/index.cjs').providerAdapter as ProviderAdapter;
const API = 'https://graph.threads.net/v1.0';
const config = { userId: '42', watchWindow: 2, maxPagesPerMedia: 4 };
const at = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00+0000`;
const reply = (id: string, day: number, extra: Record<string, unknown> = {}) => ({ id, timestamp: at(day), text: id, username: 'sam', is_reply: true, root_post: { id: '100' }, replied_to: { id: '100' }, ...extra });
function fake() {
  return recordedHostFetch([
    { method: 'GET', url: (u) => u.pathname === '/v1.0/42/threads', response: jsonResponse(200, { data: [{ id: '100', timestamp: at(1), text: 'root', is_reply: false }] }) },
    { method: 'GET', url: (u) => u.pathname === '/v1.0/100/conversation', response: (r) => new URL(r.url).searchParams.has('after')
      ? jsonResponse(200, { data: [reply('202', 3), reply('201', 2, { text: undefined })] })
      : jsonResponse(200, { data: [reply('203', 3, { replied_to: { id: '202' } }), reply('202', 3)], paging: { next: `${API}/100/conversation?after=older&access_token=never-retain` } }) },
    { method: 'POST', url: (u) => u.pathname === '/v1.0/42/threads', response: jsonResponse(200, { id: 'container' }) },
    { method: 'GET', url: `${API}/container?fields=status`, response: jsonResponse(200, { status: 'FINISHED' }) },
    { method: 'POST', url: `${API}/42/threads_publish`, response: jsonResponse(200, { id: '300' }) },
  ]);
}
async function drain(fetch: HostFetch, cursor: string | null = null) {
  const records: ProviderRecord[] = []; const pages: ProviderSyncPage[] = [];
  for (let n = 0; n < 20; n++) {
    const page = await adapter.syncPage({ source: 'threads-source', config, cursor, mode: cursor ? 'incremental' : 'backfill' }, { fetch });
    pages.push(page); records.push(...page.records); cursor = page.nextCursor;
    if (!page.hasMore) return { records, pages, cursor };
  }
  throw new Error('Threads test drain did not finish');
}
const postArgs = { destination: '42', text: 'hello' };
const replyArgs = { target: { platform: 'threads', replyToId: '202', rootPostOwnerId: '42' }, text: 'reply' };
describe('Threads provider package (P-001)', () => {
  it('derives the exact nested reply id and ownership from the stored document', async () => {
    const world = fake();
    await adapter.invoke({ source: 's', config, capability: 'social.reply', args: {
      text: 'reply', target: { platform: 'threads', externalId: '202', payload: { id: '203', replyToId: '100', subjectOwnerId: '42' }, replyToId: 'attacker', rootPostOwnerId: 'attacker' },
    } }, world);
    expect(new URLSearchParams(world.calls[0].request.body).get('reply_to_id')).toBe('202');
    const fetch = vi.fn(async () => jsonResponse(200, {}));
    for (const payload of [{}, { subjectOwnerId: 'other' }, null]) await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: {
      text: 'reply', target: { platform: 'threads', externalId: '202', payload, rootPostOwnerId: '42' },
    } }, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('declares separate OAuth and only approved account-root post/reply capabilities', async () => {
    const d = await adapter.describe();
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.oauth?.clientRegistrationRef).toBe('threads');
    expect(d.oauth?.scopes).toEqual(['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_read_replies']);
    expect(d.capabilities).toEqual(['social.post', 'social.reply']);
  });
  it('pages older unseen replies, dedupes overlap, preserves parents and resumes without duplicates', async () => {
    const world = fake(); const full = await drain(world.fetch);
    expect(full.records.map((r) => [r.nativeId, r.event])).toEqual([['100', 'post'], ['203', 'reply'], ['202', 'reply'], ['201', 'reply']]);
    expect(full.records[1].payload).toMatchObject({ subjectId: '100', subjectOwnerId: '42', replyToId: '202' });
    expect(full.records[3].payload).toMatchObject({ text: '', textAbsent: true });
    expect(JSON.stringify(full.pages)).not.toContain('never-retain');
    expect(full.pages.every((p) => p.lossRisk === undefined)).toBe(true);
    expect(world.calls.filter((c) => c.request.url.includes('/conversation')).every((c) => new URL(c.request.url).searchParams.get('reverse') === 'true')).toBe(true);
    expect((await drain(fake().fetch, full.pages[1].nextCursor)).records.map((r) => r.nativeId)).toEqual(['201']);
    expect((await drain(fake().fetch, full.cursor)).records).toEqual([]);
  });
  it('admits unseen equal-timestamp boundary ids on the next rescan', async () => {
    const first = await drain(fake().fetch); const base = fake().fetch;
    const second = await drain(async (r) => new URL(r.request.url).pathname.endsWith('/conversation')
      ? jsonResponse(200, { data: [reply('204', 3), reply('203', 3), reply('202', 3), reply('201', 2)] }) : base(r), first.cursor);
    expect(second.records.map((r) => r.nativeId)).toEqual(['204']);
  });
  it('refuses foreign, repeating and runaway pagination without successful truncation', async () => {
    const c = { ...config, maxPagesPerMedia: 1 };
    const first = await adapter.syncPage({ source: 's', config: c, cursor: null, mode: 'backfill' }, fake());
    await expect(adapter.syncPage({ source: 's', config: c, cursor: first.nextCursor, mode: 'incremental' }, fake())).rejects.toThrow('conversation_page_bound_exceeded');
    await expect(drain(async () => jsonResponse(200, { data: [], paging: { next: 'https://foreign.example/a?after=a' } }))).rejects.toThrow('paging_outside_resource');
    const root = await adapter.syncPage({ source: 's', config, cursor: null, mode: 'backfill' }, fake());
    const one = await adapter.syncPage({ source: 's', config, cursor: root.nextCursor, mode: 'incremental' }, fake());
    await expect(adapter.syncPage({ source: 's', config, cursor: one.nextCursor, mode: 'incremental' }, { fetch: async () => jsonResponse(200, { data: [], paging: { next: `${API}/100/conversation?after=older` } }) })).rejects.toMatchObject({ kind: 'cursor-expired' });
  });
  it('rejects malformed cursors and resets after a source-account change', async () => {
    await expect(drain(fake().fetch, 'broken')).rejects.toMatchObject({ kind: 'cursor-expired' });
    const prior = await drain(fake().fetch); const calls: string[] = [];
    await adapter.syncPage({ source: 's', config: { ...config, userId: '43' }, cursor: prior.cursor, mode: 'incremental' }, { fetch: async ({ request }) => { calls.push(request.url); return jsonResponse(200, { data: [] }); } });
    expect(new URL(calls[0]).pathname).toBe('/v1.0/43/threads');
  });
  it('passes the shared SDK conformance kit for paged records and both actual writes', async () => {
    const report = await runProviderConformance({ adapter, source: 'threads-source', config, createFetch: () => fake().fetch,
      invocations: [{ capability: 'social.post', args: postArgs }, { capability: 'social.reply', args: replyArgs }],
      validatePayload: (_type, p) => typeof p.id === 'string' && typeof p.text === 'string' ? null : 'id/text missing' });
    expect(report.failures).toEqual([]); expect(report.ok).toBe(true);
  });
  it('publishes text or one media item while preserving the exact nested reply id', async () => {
    const world = fake();
    expect(await adapter.invoke({ source: 's', config, capability: 'social.reply', args: replyArgs }, world)).toEqual({ externalId: '300' });
    expect(Object.fromEntries(new URLSearchParams(world.calls[0].request.body))).toEqual({ media_type: 'TEXT', text: 'reply', reply_to_id: '202' });
    const media = fake();
    await adapter.invoke({ source: 's', config, capability: 'social.post', args: { ...postArgs, media: [{ type: 'image', url: 'https://cdn.example/p.jpg' }] } }, media);
    expect(new URLSearchParams(media.calls[0].request.body).get('image_url')).toBe('https://cdn.example/p.jpg');
    expect(media.calls.map((r) => r.request.method ?? 'GET')).toEqual(['POST', 'GET', 'POST']);
  });
  it('refuses unknown or unowned roots, wrong destinations and deletion before fetching', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, {}));
    for (const rootPostOwnerId of [undefined, 'another']) await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { ...replyArgs, target: { ...replyArgs.target, rootPostOwnerId } } }, { fetch })).rejects.toMatchObject({ kind: 'auth' });
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { ...postArgs, destination: 'other' } }, { fetch })).rejects.toThrow('destination_mismatch');
    await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: '1' } }, { fetch })).rejects.toThrow('capability_unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('counts emoji graphemes and refuses over-limit text', async () => {
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { ...postArgs, text: '👨‍👩‍👧‍👦'.repeat(500) } }, fake())).resolves.toEqual({ externalId: '300' });
    const fetch = vi.fn(async () => jsonResponse(200, {}));
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { ...postArgs, text: 'x'.repeat(501) } }, { fetch })).rejects.toThrow('invalid_text'); expect(fetch).not.toHaveBeenCalled();
  });
  it('observes container readiness without repeating either write', async () => {
    vi.useFakeTimers();
    try {
      const world = fake(); const base = world.fetch; let probes = 0;
      const result = adapter.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch: async (r) => new URL(r.request.url).pathname === '/v1.0/container' ? (probes++, jsonResponse(200, { status: probes < 3 ? 'IN_PROGRESS' : 'FINISHED' })) : base(r) });
      await vi.runAllTimersAsync(); await expect(result).resolves.toEqual({ externalId: '300' }); expect(probes).toBe(3); expect(world.calls.filter((c) => c.request.method === 'POST')).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it('retains ambiguous-publish evidence and never retries publication', async () => {
    const world = fake(); const base = world.fetch; let publications = 0; let statuses = 0;
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch: async (r) => {
      const u = new URL(r.request.url); if (u.pathname.endsWith('/threads_publish')) { publications++; return jsonResponse(503, {}); }
      if (u.pathname.endsWith('/container')) return jsonResponse(200, { status: ++statuses === 1 ? 'FINISHED' : 'PUBLISHED' }); return base(r);
    } })).rejects.toMatchObject({ message: 'threads:publish_ambiguous_do_not_retry', containerId: 'container', observedStatus: 'PUBLISHED', retrySafe: false }); expect(publications).toBe(1);
  });
  it('classifies HTTP failures once and never imports unrelated Meta throttle codes', async () => {
    for (const [status, kind] of [[401, 'auth'], [429, 'rate-limited'], [503, 'transient']] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, { error: { message: 'secret' } }, { 'retry-after': '37' }));
      await expect(drain(fetch)).rejects.toMatchObject({ kind }); expect(fetch).toHaveBeenCalledTimes(1);
    }
    await expect(drain(async () => jsonResponse(400, { error: { code: 80002, message: 'secret' } }))).rejects.toMatchObject({ kind: 'transient', message: 'threads:graph_request_failed' });
  });
});
