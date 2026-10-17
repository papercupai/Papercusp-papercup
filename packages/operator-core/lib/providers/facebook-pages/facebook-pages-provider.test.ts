import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { jsonResponse, recordedHostFetch, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter, type ProviderRecord, type ProviderSyncPage } from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/facebook-pages/index.cjs').providerAdapter as ProviderAdapter;
const API = 'https://graph.facebook.com/v23.0';
const config = { pageId: '123', watchWindow: 1, maxPostPages: 3, maxCommentPages: 2 };
const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00+0000`;
const post = (id: string, day: number, extra: Record<string, unknown> = {}) => ({ id, message: `post ${id}`, created_time: at(day), ...extra });
const comment = (id: string, day: number, extra: Record<string, unknown> = {}) => ({ id, message: `comment ${id}`, created_time: at(day), ...extra });

function fake() {
  return recordedHostFetch([
    { url: (u) => u.pathname === '/v23.0/123/published_posts', response: (r) => {
      const after = new URL(r.url).searchParams.get('after');
      if (after === 'posts-3') return jsonResponse(200, { data: [post('123_3', 3)] });
      if (after === 'posts-2') return jsonResponse(200, { data: [], paging: { next: `${API}/123/published_posts?after=posts-3&access_token=vendor-token` } });
      return jsonResponse(200, { data: [post('123_1', 1, { from: { name: 'Avi' }, attachments: { data: [{ type: 'photo' }] } }), post('123_2', 2)], paging: { next: `${API}/123/published_posts?after=posts-2` } });
    } },
    { url: (u) => u.pathname === '/v23.0/123_1/comments', response: (r) => new URL(r.url).searchParams.has('after')
      ? jsonResponse(200, { data: [comment('113', 6, { message: null })] })
      : jsonResponse(200, { data: [comment('111', 4, { from: { id: 'u1' }, can_comment: false }), comment('112', 5, { parent: { id: '111' }, permalink_url: 'https://www.facebook.com/reply' })], paging: { next: `${API}/123_1/comments?after=comments-2` } }) },
    { method: 'POST', url: (u) => u.pathname === '/v23.0/123/feed', response: jsonResponse(200, { id: '123_900', permalink_url: 'https://www.facebook.com/123_900' }) },
    { method: 'POST', url: (u) => u.pathname === '/v23.0/111/comments', response: jsonResponse(200, { id: '114' }) },
    { method: 'DELETE', url: `${API}/123_900`, response: jsonResponse(200, { success: true }) },
  ]);
}

async function drain(fetch: HostFetch, cursor: string | null = null) {
  const records: ProviderRecord[] = [];
  const pages: ProviderSyncPage[] = [];
  for (let n = 0; n < 20; n++) {
    const page = await adapter.syncPage({ source: 'facebook-source', cursor, mode: cursor ? 'incremental' : 'backfill', config }, { fetch });
    pages.push(page); records.push(...page.records); cursor = page.nextCursor;
    if (!page.hasMore) return { records, pages, cursor };
  }
  throw new Error('test drain did not finish');
}

describe('Facebook Pages provider package (P-027)', () => {
  it('uses the stored object id and enforces a definite cannot-comment marker inside the package', async () => {
    const w = fake();
    const target = { platform: 'facebook-pages', externalId: '111', payload: { objectId: '999', replyToId: '999' } };
    expect(await adapter.invoke({ source: 's', config, capability: 'social.reply', args: { target, text: 'reply' } }, w)).toMatchObject({ externalId: '114' });
    let calls = 0;
    const host = { fetch: async () => { calls++; return jsonResponse(200, {}); } };
    for (const invalid of [{ ...target, externalId: '../other' }, { ...target, platform: 'x-twitter' },
      { ...target, payload: { canComment: false } }]) {
      await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { target: invalid, text: 'reply' } }, host)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it('validates the descriptor and declares host-held Page selection', async () => {
    const descriptor = await adapter.describe();
    expect(validateProviderDescriptor(descriptor)).toEqual([]);
    expect(descriptor.capabilities).toEqual(['social.post', 'social.reply', 'social.delete']);
    expect(descriptor.oauth?.resourceToken).toMatchObject({ configKey: 'pageId', tokenField: 'access_token', permissions: { required: ['MODERATE', 'CREATE_CONTENT'] } });
  });

  it('maps ranked posts, captionless comments and nested replies without leaking paging tokens', async () => {
    const world = fake(); const result = await drain(world.fetch);
    expect(result.pages).toHaveLength(5);
    expect(result.records.map((r) => [r.nativeId, r.event])).toEqual([['123_1', 'post'], ['123_2', 'post'], ['123_3', 'post'], ['111', 'comment'], ['112', 'reply'], ['113', 'comment']]);
    expect(result.records[0]).toMatchObject({ version: `123_1@${at(1)}`, payload: { author: 'Avi', media: [{ type: 'photo' }] } });
    expect(result.records[3].payload).toMatchObject({ postId: '123_1', replyToId: '123_1', canComment: false });
    expect(result.records[4].payload.replyToId).toBe('111');
    expect(result.records[5].payload).toMatchObject({ text: '', textAbsent: true });
    expect(world.calls.filter((c) => c.request.url.includes('/comments')).every((c) => new URL(c.request.url).searchParams.get('filter') === 'stream')).toBe(true);
    expect(JSON.stringify(result.pages)).not.toContain('vendor-token');
    expect((await drain(fake().fetch, result.cursor)).records).toEqual([]);
  });

  it('passes the shared SDK conformance kit for paging, faults and all writes', async () => {
    const report = await runProviderConformance({
      adapter, source: 'facebook-source', config, createFetch: () => fake().fetch,
      invocations: [
        { capability: 'social.post', args: { destination: '123', text: 'test' } },
        { capability: 'social.reply', args: { target: { objectId: '111' }, text: 'reply' } },
        { capability: 'social.delete', args: { externalId: '123_900' } },
      ],
      validatePayload: (_datatype, payload) => typeof payload.id === 'string' && typeof payload.text === 'string' ? null : 'id/text missing',
    });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('classifies Graph throttles and HTTP faults without retries or response echo', async () => {
    const throttle: HostFetch = async () => jsonResponse(400, { error: { code: 80001, message: 'secret body' } }, { 'X-Business-Use-Case-Usage': JSON.stringify({ x: [{ estimated_time_to_regain_access: 7 }] }) });
    await expect(drain(throttle)).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 420, message: 'facebook_pages:graph_throttled' });
    for (const [status, kind] of [[401, 'auth'], [429, 'rate-limited'], [503, 'transient']] as const) {
      let calls = 0;
      await expect(drain(async () => { calls++; return jsonResponse(status, { error: { message: 'secret body' } }); })).rejects.toMatchObject({ kind });
      expect(calls).toBe(1);
    }
  });

  it('keeps equal-timestamp boundary ids and finds edits beyond older ranked rows', async () => {
    const before = await drain(fake().fetch);
    const fetch: HostFetch = async ({ request }) => new URL(request.url).pathname.endsWith('/published_posts')
      ? jsonResponse(200, { data: [post('123_1', 1), post('123_3', 3), post('123_4', 3), post('123_2', 2, { updated_time: at(7) })] })
      : jsonResponse(200, { data: [] });
    expect((await drain(fetch, before.cursor)).records.map((r) => r.nativeId)).toEqual(['123_4', '123_2']);
  });

  it('dedupes overlapping pages and keeps resume lossless', async () => {
    const fetch: HostFetch = async ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/comments')) return jsonResponse(200, { data: [] });
      return url.searchParams.has('after')
        ? jsonResponse(200, { data: [post('123_1', 1), post('123_2', 2)] })
        : jsonResponse(200, { data: [post('123_1', 1)], paging: { next: `${API}/123/published_posts?after=second` } });
    };
    const full = await drain(fetch);
    expect(full.records.map((r) => r.nativeId)).toEqual(['123_1', '123_2']);
    expect((await drain(fetch, full.pages[0].nextCursor)).records.map((r) => r.nativeId)).toEqual(['123_2']);
  });

  it('applies configured bounds and resets a cursor when the Page changes', async () => {
    const page = await adapter.syncPage({ source: 's', config: { ...config, maxPostPages: 1 }, cursor: null, mode: 'backfill' }, fake());
    expect(JSON.parse(page.nextCursor!).phase).toBe('comments');
    const changed = recordedHostFetch([{ url: (u) => u.pathname === '/v23.0/999/published_posts', response: jsonResponse(200, { data: [] }) }]);
    expect((await adapter.syncPage({ source: 's', config: { ...config, pageId: '999' }, cursor: page.nextCursor, mode: 'incremental' }, changed)).hasMore).toBe(false);
  });

  it('refuses malformed cursors, unsafe paging and ambiguous writes before retrying', async () => {
    const world = fake();
    await expect(drain(world.fetch, 'broken')).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(drain(async () => jsonResponse(200, { data: [], paging: { next: 'https://evil.example/x?after=x' } }))).rejects.toThrow(/paging/);
    let calls = 0;
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: '123', text: 'x' } }, { fetch: async () => { calls++; return jsonResponse(200, {}); } })).rejects.toThrow('write_unconfirmed');
    expect(calls).toBe(1);
  });

  it('publishes, replies and deletes using provider ids and the declared readback fields', async () => {
    const world = fake();
    expect(await adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: '123', text: 'A & B' } }, world)).toMatchObject({ externalId: '123_900' });
    expect(new URLSearchParams(world.calls[0].request.body).get('fields')).toBe('id,permalink_url,created_time');
    expect(await adapter.invoke({ source: 's', config, capability: 'social.reply', args: { target: { objectId: '111' }, text: 'reply' } }, world)).toMatchObject({ externalId: '114' });
    expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: '123_900' } }, { fetch: async () => jsonResponse(200, { success: false }) })).toEqual({ deleted: false });
  });
});
