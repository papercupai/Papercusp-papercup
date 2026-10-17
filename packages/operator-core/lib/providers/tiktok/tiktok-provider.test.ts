import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, recordedHostFetch, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter, type ProviderRecord } from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/tiktok/index.cjs').providerAdapter as ProviderAdapter;
const config = { openId: 'owner', maxCount: 20, maxPages: 4 };
const video = (id: string, at: number, extra = {}) => ({ id, create_time: at, title: id, ...extra });
const response = (videos: unknown[], has_more = false, cursor = 0) => jsonResponse(200, { data: { videos, has_more, cursor }, error: { code: 'ok' } });
function fake() {
  return recordedHostFetch([{ method: 'POST', url: (u) => u.pathname === '/v2/video/list/', response: (r) => JSON.parse(r.body!).cursor === undefined
    ? response([video('3', 1800000003), video('2', 1800000002)], true, 1800000002000)
    : response([video('2', 1800000002, { comment_count: 99 }), video('1', 1800000001, { title: '' })]) }]);
}
async function drain(fetch: HostFetch, cursor: string | null = null) {
  const records: ProviderRecord[] = []; const cursors: string[] = [];
  for (let n = 0; n < 10; n++) {
    const p = await adapter.syncPage({ source: 's', config, cursor, mode: cursor ? 'incremental' : 'backfill' }, { fetch });
    records.push(...p.records); cursor = p.nextCursor!; cursors.push(cursor);
    if (!p.hasMore) return { records, cursor, cursors };
  }
  throw new Error('did not finish');
}
describe('TikTok provider package (P-001)', () => {
  it('declares read-only Display API scope and the vendor OAuth dialect', async () => {
    const d = await adapter.describe(); expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.oauth).toMatchObject({ clientIdParameter: 'client_key', scopeSeparator: ',', scopes: ['user.info.basic', 'video.list'] });
    expect(d.capabilities).toEqual([]);
  });
  it('uses a millisecond pager only within the scan and normalizes video metadata', async () => {
    const world = fake(); const run = await drain(world.fetch);
    expect(run.records.map((r) => r.nativeId)).toEqual(['3', '2', '1']);
    expect(run.records[0].occurredAt).toBe(new Date(1800000003000).toISOString());
    expect(run.records[2].payload).toMatchObject({ text: '', textAbsent: true, platform: 'tiktok', subjectOwnerId: 'owner' });
    expect(JSON.parse(world.calls[0].request.body!)).toEqual({ max_count: 20 });
    expect(JSON.parse(world.calls[1].request.body!)).toEqual({ max_count: 20, cursor: 1800000002000 });
    expect(world.calls.every((c) => !c.request.headers?.authorization)).toBe(true);
    expect((await drain(fake().fetch, run.cursors[0])).records.map((r) => r.nativeId)).toEqual(['1']);
    const second = fake(); expect((await drain(second.fetch, run.cursor)).records).toEqual([]);
    expect(JSON.parse(second.calls[0].request.body!)).toEqual({ max_count: 20 });
  });
  it('keeps scanning an equal-second page for a new boundary id', async () => {
    const first = await drain(fake().fetch); let calls = 0;
    const second = await drain(async () => ++calls === 1 ? response([video('3', 1800000003)], true, 1800000003000) : response([video('4', 1800000003), video('2', 1800000002)]), first.cursor);
    expect(second.records.map((r) => r.nativeId)).toEqual(['4']); expect(calls).toBe(2);
  });
  it('preserves media-only posts, expiring covers and stable versions when counters change', async () => {
    const run = await drain(async () => response([video('1', 1800000001, { title: '', cover_image_url: 'https://cdn.example/p.jpg', embed_link: 'https://www.tiktok.com/embed/1', duration: 4, comment_count: 10 })]));
    expect(run.records[0].payload).toMatchObject({ textAbsent: true, commentCount: 10, media: [{ type: 'video', coverImageUrlExpires: true, durationSeconds: 4 }] });
    expect((await drain(async () => response([video('1', 1800000001, { comment_count: 11 })]), run.cursor)).records).toEqual([]);
  });
  it('passes the shared conformance kit with real paging and resume', async () => {
    const report = await runProviderConformance({ adapter, source: 's', config, createFetch: () => fake().fetch, validatePayload: (_type, p) => typeof p.id === 'string' && typeof p.text === 'string' ? null : 'id/text missing' });
    expect(report.failures).toEqual([]); expect(report.ok).toBe(true);
  });
  it('rejects malformed cursors, non-progressing vendor cursors and successful truncation', async () => {
    await expect(drain(fake().fetch, '{}')).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(drain(async () => response([], true, 12))).rejects.toThrow('paging_made_no_progress');
    const fetch = fake().fetch;
    await expect(adapter.syncPage({ source: 's', config: { ...config, maxPages: 1 }, cursor: null, mode: 'backfill' }, { fetch })).rejects.toThrow('page_bound_exceeded');
    await expect(drain(async () => response([video('bad', -1)]))).rejects.toThrow('malformed_video');
    await expect(drain(async () => jsonResponse(200, { data: { videos: [] }, error: { code: 'ok' } }))).rejects.toThrow('malformed_collection');
  });
  it('resets the watermark on account changes and refuses writes before fetching', async () => {
    const first = await drain(fake().fetch); const fetch = vi.fn(async (_r: Parameters<HostFetch>[0]) => response([]));
    await adapter.syncPage({ source: 's', config: { ...config, openId: 'other' }, cursor: first.cursor, mode: 'incremental' }, { fetch });
    expect(JSON.parse(fetch.mock.calls[0][0].request.body!)).toEqual({ max_count: 20 });
    fetch.mockClear();
    for (const capability of ['social.post', 'social.reply', 'social.delete']) await expect(adapter.invoke({ source: 's', config, capability, args: {} }, { fetch })).rejects.toThrow('capability_unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies HTTP and body errors with one request and no hidden retry', async () => {
    for (const [status, code, kind] of [[401, 'bad', 'auth'], [200, 'access_token_invalid', 'auth'], [429, 'rate_limit_exceeded', 'rate-limited'], [200, 'rate_limit_exceeded', 'rate-limited'], [503, 'internal_error', 'transient']] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, { error: { code, message: 'private provider text' } }, { 'retry-after': '37' }));
      await expect(drain(fetch)).rejects.toMatchObject({ kind }); expect(fetch).toHaveBeenCalledTimes(1);
    }
    for (const [status, kind] of [[401, 'auth'], [429, 'rate-limited'], [503, 'transient']] as const) {
      await expect(drain(async () => ({ ...jsonResponse(status, {}), body: '<html>unavailable</html>' }))).rejects.toMatchObject({ kind });
    }
  });
});
