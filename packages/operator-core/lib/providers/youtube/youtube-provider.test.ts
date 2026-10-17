import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, recordedHostFetch, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter, type ProviderRecord } from '@papercusp/plugin-sdk';
const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/youtube/index.cjs').providerAdapter as ProviderAdapter;
const config = { channelId: 'UC42', maxPages: 4, maxReplyPages: 4 };
const at = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`;
const comment = (id: string, day: number, extra = {}) => ({ id, snippet: { publishedAt: at(day), textDisplay: id, ...extra } });
const activity = (id: string, day: number) => ({ id, snippet: { publishedAt: at(day), type: 'upload', title: id }, contentDetails: { upload: { videoId: 'video' } } });
const thread = (id: string, top: unknown, totalReplyCount = 0) => ({ id, snippet: { topLevelComment: top, totalReplyCount, videoId: 'video', canReply: true, isPublic: true }, replies: { comments: [comment('preview-must-not-be-trusted', 1)] } });
function fake(edited = false) {
  return recordedHostFetch([
    { method: 'GET', url: (u) => u.pathname.endsWith('/activities'), response: (r) => new URL(r.url).searchParams.has('pageToken') ? jsonResponse(200, { items: [activity('a2', 9)] }) : jsonResponse(200, { items: [activity('a1', 10)], nextPageToken: 'activity-2' }) },
    { method: 'GET', url: (u) => u.pathname.endsWith('/commentThreads'), response: (r) => new URL(r.url).searchParams.has('pageToken')
      ? jsonResponse(200, { items: [thread('t2', comment('c2', 5, { updatedAt: at(edited ? 12 : 5) }))] })
      : jsonResponse(200, { items: [thread('t1', comment('c1', 6, { updatedAt: at(11) }), 2)], nextPageToken: 'thread-2' }) },
    { method: 'GET', url: (u) => u.pathname.endsWith('/comments'), response: (r) => new URL(r.url).searchParams.has('pageToken')
      ? jsonResponse(200, { items: [comment('r2', 7, { parentId: 'c1' })] })
      : jsonResponse(200, { items: [comment('r1', 8, { parentId: 'c1' })], nextPageToken: 'reply-2' }) },
    { method: 'POST', url: (u) => u.pathname.endsWith('/comments'), response: jsonResponse(200, { id: 'new-reply' }) },
  ]);
}
async function drain(fetch: HostFetch, cursor: string | null = null) {
  const records: ProviderRecord[] = []; const cursors: string[] = [];
  for (let n = 0; n < 20; n++) {
    const p = await adapter.syncPage({ source: 's', config, cursor, mode: cursor ? 'incremental' : 'backfill' }, { fetch });
    records.push(...p.records); cursor = p.nextCursor!; cursors.push(cursor);
    if (!p.hasMore) return { records, cursor, cursors };
  }
  throw new Error('did not finish');
}
const replyArgs = { target: { platform: 'youtube', parentCommentId: 'c1', videoId: 'video', canReply: true }, text: 'hello' };
describe('YouTube provider package (P-001)', () => {
  it('derives top-level comment coordinates from the stored document inside the package', async () => {
    for (const [externalId, payload] of [['c1', {}], ['nested', { replyToId: 'c1' }]] as const) {
      const world = fake();
      await adapter.invoke({ source: 's', config, capability: 'social.reply', args: {
        text: 'hello', target: { platform: 'youtube', externalId, payload: { ...payload, videoId: 'video', canReply: true }, parentCommentId: 'attacker' },
      } }, world);
      expect(JSON.parse(world.calls[0].request.body!)).toEqual({ snippet: { parentId: 'c1', textOriginal: 'hello' } });
    }
    const fetch = vi.fn(async () => jsonResponse(200, {}));
    for (const target of [
      { platform: 'youtube', externalId: 'nested', payload: { replyToId: 'c1', canReply: false }, canReply: true },
      { platform: 'youtube', externalId: '', payload: { videoId: 'video', threadId: 'thread' } },
      { platform: 'youtube', externalId: 'c1', payload: null, parentCommentId: 'c1' },
    ]) await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { text: 'hello', target } }, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('declares only the implemented reply write and reuses Google account consent', async () => {
    const d = await adapter.describe(); expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.capabilities).toEqual(['social.reply']);
    expect(d.oauth).toMatchObject({ clientRegistrationRef: 'google', credentialGroup: 'google', pkce: true });
    expect(d.oauth?.scopes).toContain('https://www.googleapis.com/auth/youtube.force-ssl');
  });
  it('pages activities, every thread and every reply, preserving exact coordinates and edits', async () => {
    const world = fake(); const run = await drain(world.fetch);
    expect(run.records.map((r) => [r.nativeId, r.event])).toEqual([['a1', 'upload'], ['a2', 'upload'], ['c1', 'comment'], ['r1', 'reply'], ['r2', 'reply'], ['c2', 'comment']]);
    expect(run.records[2].payload).toMatchObject({ editedAt: at(11), threadId: 't1', canReply: true, visibility: 'public' });
    expect(run.records[4].payload).toMatchObject({ replyToId: 'c1', videoId: 'video', threadId: 't1', channelId: 'UC42' });
    expect(world.calls.filter((c) => c.request.url.includes('/commentThreads')).every((c) => !new URL(c.request.url).searchParams.has('publishedAfter'))).toBe(true);
    expect((await drain(fake().fetch, run.cursors[2])).records.map((r) => r.nativeId)).toEqual(['r1', 'r2', 'c2']);
    expect((await drain(fake().fetch, run.cursor)).records).toEqual([]);
    expect((await drain(fake(true).fetch, run.cursor)).records.map((r) => r.nativeId)).toEqual(['c2']);
  });
  it('overlaps the activities timestamp by one millisecond without persisting a query page token', async () => {
    const first = await drain(fake().fetch); const second = fake(); await drain(second.fetch, first.cursor);
    const u = new URL(second.calls[0].request.url);
    expect(u.searchParams.get('publishedAfter')).toBe(new Date(Date.parse(at(10)) - 1).toISOString());
    expect(u.searchParams.has('pageToken')).toBe(false);
  });
  it('passes the shared SDK kit for multi-stream resume and an actual reply', async () => {
    const report = await runProviderConformance({ adapter, source: 's', config, createFetch: () => fake().fetch, invocations: [{ capability: 'social.reply', args: replyArgs }], validatePayload: (_type, p) => typeof p.id === 'string' && typeof p.text === 'string' ? null : 'id/text missing' });
    expect(report.failures).toEqual([]); expect(report.ok).toBe(true);
  });
  it('replies to a supplied top-level parent once, never uploading or opening a new thread', async () => {
    const world = fake();
    expect(await adapter.invoke({ source: 's', config, capability: 'social.reply', args: replyArgs }, world)).toEqual({ externalId: 'new-reply', url: 'https://www.youtube.com/watch?v=video&lc=new-reply' });
    expect(world.calls).toHaveLength(1);
    expect(JSON.parse(world.calls[0].request.body!)).toEqual({ snippet: { parentId: 'c1', textOriginal: 'hello' } });
    const fetch = vi.fn();
    for (const capability of ['social.post', 'social.delete']) await expect(adapter.invoke({ source: 's', config, capability, args: {} }, { fetch })).rejects.toThrow('capability_unsupported');
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { ...replyArgs, target: { ...replyArgs.target, canReply: false } } }, { fetch })).rejects.toMatchObject({ kind: 'auth' });
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { ...replyArgs, visibility: 'direct' } }, { fetch })).rejects.toThrow('visibility_unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies quota exhaustion separately from missing grant and never retries an ambiguous write', async () => {
    for (const [status, reason, kind] of [[403, 'quotaExceeded', 'rate-limited'], [403, 'insufficientPermissions', 'auth'], [401, '', 'auth'], [503, 'backendError', 'transient']] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, { error: { errors: [{ reason }] } }));
      await expect(drain(fetch)).rejects.toMatchObject({ kind }); expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => { throw new Error('disconnected'); });
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: replyArgs }, { fetch })).rejects.toMatchObject({ data: { retrySafe: false } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses unreadable and non-progressing cursors and an unclosed page bound', async () => {
    await expect(drain(fake().fetch, '{}')).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(drain(async () => jsonResponse(200, { items: [], nextPageToken: 'same' }))).rejects.toThrow('paging_made_no_progress');
    await expect(adapter.syncPage({ source: 's', config: { ...config, maxPages: 1 }, cursor: null, mode: 'backfill' }, fake())).rejects.toThrow('activity_page_bound_exceeded');
    const first = await drain(fake().fetch);
    const fetch = vi.fn(async (_r: Parameters<HostFetch>[0]) => jsonResponse(200, { items: [] }));
    await adapter.syncPage({ source: 's', config: { ...config, channelId: 'other' }, cursor: first.cursor, mode: 'incremental' }, { fetch });
    expect(new URL(fetch.mock.calls[0][0].request.url).searchParams.has('publishedAfter')).toBe(false);
  });
});
