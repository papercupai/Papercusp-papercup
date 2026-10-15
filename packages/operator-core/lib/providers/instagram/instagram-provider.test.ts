import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  jsonResponse,
  recordedHostFetch,
  runProviderConformance,
  validateProviderDescriptor,
  type HostFetch,
  type ProviderAdapter,
  type ProviderRecord,
  type ProviderSyncPage,
} from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/instagram/index.cjs').providerAdapter as ProviderAdapter;
const API = 'https://graph.facebook.com/v26.0';
const config = { igUserId: '17841400000000000', watchWindow: 2, maxMediaPages: 2 };
const at = (n: number) => `2026-10-0${n}T00:00:00+0000`;

function fake() {
  return recordedHostFetch([
    { method: 'GET', url: (u) => u.pathname === '/v26.0/17841400000000000/media', response: jsonResponse(200, { data: [{ id: 'media-1' }, { id: 'media-2' }] }) },
    { url: (u) => u.pathname === '/v26.0/media-1/comments', response: jsonResponse(200, { data: [
      { id: 'c1', timestamp: at(1), text: 'hello', username: 'avi', like_count: 3 },
      { id: 'c2', timestamp: at(2), text: 'reply', username: 'sam', parent_id: 'c1' },
    ] }) },
    { url: (u) => u.pathname === '/v26.0/media-2/comments', response: jsonResponse(200, { data: [] }) },
    { method: 'POST', url: (u) => u.pathname === '/v26.0/c1/replies', response: jsonResponse(200, { id: 'reply-1' }) },
    { method: 'POST', url: (u) => u.pathname === '/v26.0/17841400000000000/media', response: jsonResponse(200, { id: 'container-1' }) },
    { url: (u) => u.pathname === '/v26.0/container-1', response: jsonResponse(200, { status_code: 'FINISHED' }) },
    { method: 'POST', url: (u) => u.pathname === '/v26.0/17841400000000000/media_publish', response: jsonResponse(200, { id: 'media-new' }) },
    { method: 'GET', url: (u) => u.pathname === '/v26.0/c1', response: jsonResponse(200, { id: 'c1', text: 'hello', media: { id: 'media-1' } }) },
    { method: 'GET', url: (u) => u.pathname === '/v26.0/media-1', response: jsonResponse(200, { id: 'media-1', media_type: 'IMAGE', owner: { id: config.igUserId } }) },
    { method: 'DELETE', url: `${API}/c1`, response: jsonResponse(200, { success: true }) },
  ]);
}

async function drain(fetch: HostFetch, cursor: string | null = null) {
  const records: ProviderRecord[] = [];
  const pages: ProviderSyncPage[] = [];
  for (let n = 0; n < 10; n += 1) {
    const page = await adapter.syncPage({ source: 'instagram-source', cursor, mode: cursor ? 'incremental' : 'backfill', config }, { fetch });
    pages.push(page); records.push(...page.records); cursor = page.nextCursor;
    if (!page.hasMore) return { records, cursor, pages };
  }
  throw new Error('Instagram package did not finish');
}

describe('Instagram provider package (P-028)', () => {
  it('validates the descriptor and declares the media-primary capabilities', async () => {
    const descriptor = await adapter.describe();
    expect(validateProviderDescriptor(descriptor)).toEqual([]);
    expect(descriptor.capabilities).toEqual(['social.post', 'social.reply', 'social.delete', 'ingress.normalize']);
    expect(descriptor.oauth?.clientRegistrationRef).toBe('facebook');
  });

  it('maps comments and nested replies through the installed package', async () => {
    const result = await drain(fake().fetch);
    expect(result.records.map((r) => [r.nativeId, r.event])).toEqual([['c1', 'comment'], ['c2', 'reply']]);
    expect(result.records[0]?.payload).toMatchObject({ platform: 'instagram', kind: 'comment', subjectId: 'media-1', likeCount: 3 });
    expect(result.records[1]?.payload).toMatchObject({ platform: 'instagram', kind: 'reply', subjectId: 'media-1' });
    expect(result.records[1]?.payload.replyToId).toBe('c1');
  });

  it('retrieves webhook comment and caption mentions with the documented IG User fields', async () => {
    const calls: string[] = [];
    const fetch: HostFetch = async ({ request }) => {
      const url = new URL(request.url); calls.push(url.searchParams.get('fields')!);
      expect(url.pathname).toBe(`/v26.0/${config.igUserId}`);
      return jsonResponse(200, { id: config.igUserId, ...(calls.length === 1
        ? { mentioned_comment: { id: '111', text: '@avi hello', timestamp: at(1), like_count: 2, media: { id: '222' } } }
        : { mentioned_media: { id: '333', caption: 'avi caption', timestamp: at(2), username: 'sam' } }) });
    };
    const value = await adapter.invoke({ source: 's', capability: 'ingress.normalize', args: {
      sourceConfig: config, envelope: { object: 'instagram', entry: [
        { id: 'another-account', changes: [{ field: 'mentions', value: { media_id: '444' } }] },
        { id: config.igUserId, changes: [
          { field: 'mentions', value: { comment_id: '111', media_id: '222' } },
          { field: 'mentions', value: { comment_id: '111', media_id: '222' } },
          { field: 'mentions', value: { media_id: '333' } },
          { field: 'comments', value: { id: '555' } },
        ] },
      ] },
    } }, { fetch }) as { records: ProviderRecord[] };
    expect(calls).toEqual([
      'mentioned_comment.comment_id(111){id,text,timestamp,like_count,media{id}}',
      'mentioned_media.media_id(333){id,caption,timestamp,like_count,username,media_type}',
    ]);
    expect(value.records.map((r) => [r.nativeId, r.event])).toEqual([['111', 'mention'], ['333', 'mention']]);
    expect(value.records[0]?.payload).toMatchObject({ subjectId: '222', commentId: '111', mentionKind: 'comment', likeCount: 2 });
    expect(value.records[1]?.payload).toMatchObject({ subjectId: '333', text: 'avi caption', mentionKind: 'caption', author: 'sam' });
  });

  it('refuses forged lookup selectors and mismatched mention responses without retry', async () => {
    const invoke = (value: unknown, fetch: HostFetch) => adapter.invoke({ source: 's', capability: 'ingress.normalize', args: {
      sourceConfig: config, envelope: { object: 'instagram', entry: [{ id: config.igUserId, changes: [{ field: 'mentions', value }] }] },
    } }, { fetch });
    const fetch = vi.fn(async () => jsonResponse(200, { id: config.igUserId, mentioned_media: { id: '999', timestamp: at(1) } }));
    await expect(invoke({ media_id: '333){access_token}' }, fetch)).rejects.toThrow('malformed_mention_ids');
    expect(fetch).not.toHaveBeenCalled();
    await expect(invoke({ media_id: '333' }, fetch)).rejects.toThrow('malformed_mention_lookup');
    expect(fetch).toHaveBeenCalledTimes(1);
    const throttled = vi.fn(async () => jsonResponse(429, {}));
    await expect(invoke({ media_id: '333' }, throttled)).rejects.toMatchObject({ kind: 'rate-limited' });
    expect(throttled).toHaveBeenCalledTimes(1);
  });

  it('resumes without replaying a completed media window', async () => {
    const world = fake();
    const first = await drain(world.fetch);
    expect((await drain(world.fetch, first.cursor)).records).toEqual([]);
  });

  it('replies to stored comment and caption mentions through the IG User mentions edge', async () => {
    for (const mentionKind of ['comment', 'caption']) {
      const fetch = vi.fn(async ({ request }: Parameters<HostFetch>[0]) => {
        expect(request.method).toBe('POST');
        expect(new URL(request.url).pathname).toBe(`/v26.0/${config.igUserId}/mentions`);
        expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
          media_id: '222', ...(mentionKind === 'comment' ? { comment_id: '111' } : {}), message: 'thanks',
        });
        return jsonResponse(200, { id: '444' });
      });
      expect(await adapter.invoke({ source: 's', config, capability: 'social.reply', args: {
        target: { platform: 'instagram', topLevelCommentId: 'wrong-for-a-mention' }, text: 'thanks',
        payload: { platform: 'instagram', kind: 'mention', mentionKind, mediaId: '222', commentId: '111' },
      } }, { fetch })).toEqual({ externalId: '444' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses malformed mention selectors before writing and never retries an unconfirmed mention reply', async () => {
    const args = { target: { platform: 'instagram' }, text: 'thanks',
      payload: { platform: 'instagram', kind: 'mention', mentionKind: 'comment', mediaId: '222', commentId: '111' } };
    const fetch = vi.fn(async () => jsonResponse(503, {}));
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { ...args,
      payload: { ...args.payload, commentId: '111&access_token=forged' },
    } }, { fetch })).rejects.toThrow('invalid_mention_reply');
    expect(fetch).not.toHaveBeenCalled();
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args }, { fetch })).rejects.toThrow('write_unconfirmed_do_not_retry');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes the shared provider conformance kit for all declared writes', async () => {
    const prior = await drain(fake().fetch);
    const report = await runProviderConformance({
      retentionGap: { cursor: prior.cursor!, oldestReachableAt: '2026-10-03T00:00:00.000Z', createFetch: () => async ({ request }) =>
        new URL(request.url).pathname.endsWith('/media')
          ? jsonResponse(200, { data: [{ id: 'media-1' }] })
          : jsonResponse(200, { data: Array.from({ length: 50 }, (_, n) => ({ id: `gap-${n}`, text: 'new', timestamp: at(3) })) }),
      },
      adapter, source: 'instagram-source', config, createFetch: () => {
        const base = fake().fetch;
        return async (input) => {
          const url = new URL(input.request.url);
          if (url.pathname === `/v26.0/${config.igUserId}`) {
            return jsonResponse(200, { id: config.igUserId, mentioned_media: { id: '333', caption: 'mentioned', timestamp: at(1) } });
          }
          return base(input);
        };
      },
      invocations: [
        { capability: 'social.post', args: { destination: config.igUserId, text: 'caption', media: [{ type: 'image', url: 'https://cdn.example/image.jpg' }] } },
        { capability: 'social.reply', args: { target: { objectId: 'c1' }, text: 'reply' } },
        { capability: 'social.delete', args: { externalId: 'c1' } },
        { capability: 'ingress.normalize', args: { sourceConfig: config, envelope: { object: 'instagram', entry: [{ id: config.igUserId, changes: [{ field: 'mentions', value: { media_id: '333' } }] }] } } },
      ],
      validatePayload: (_datatype, payload) => typeof payload.id === 'string' && typeof payload.text === 'string' ? null : 'id/text missing',
    });
    expect(report.failures.map((failure) => `${failure.check}: ${failure.detail}`)).toEqual([]);
    expect(report.checksRun).toContain('retention-loss-reported');
  });

  it('refuses a text-only post before host.fetch', async () => {
    let calls = 0;
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: config.igUserId, text: 'caption' } }, { fetch: async () => { calls += 1; return jsonResponse(200, {}); } })).rejects.toThrow('media_required');
    expect(calls).toBe(0);
  });

  it('keeps Graph faults classified and never retries them', async () => {
    let calls = 0;
    await expect(adapter.syncPage({ source: 's', cursor: null, mode: 'backfill', config }, { fetch: async () => { calls += 1; return jsonResponse(429, { error: { code: 80002 } }); } })).rejects.toMatchObject({ kind: 'rate-limited' });
    expect(calls).toBe(1);
  });

  it('admits a capped window with typed incomplete-history evidence when the watermark was lost', async () => {
    const first = await drain(fake().fetch);
    const fetch: HostFetch = async ({ request }) => new URL(request.url).pathname.endsWith('/media')
      ? jsonResponse(200, { data: [{ id: 'media-1' }] })
      : jsonResponse(200, { data: Array.from({ length: 50 }, (_, n) => ({ id: `new-${n}`, text: 'new', timestamp: at(3) })) });
    const result = await drain(fetch, first.cursor);
    expect(result.records).toHaveLength(50);
    expect(result.pages.at(-1)).toMatchObject({ catchUp: { path: 'backfill', reason: 'no-replay-supported' },
      lossRisk: { kind: 'capped-window-overflow', oldestReachableAt: '2026-10-03T00:00:00.000Z' } });
    expect(result.pages.at(-1)!.lossRisk!.detail).toContain('media-1');
    expect((await drain(fetch, result.cursor)).records).toEqual([]);
  });

  it('reports the same capped-history risk on a full cold-start window', async () => {
    const fetch: HostFetch = async ({ request }) => new URL(request.url).pathname.endsWith('/media')
      ? jsonResponse(200, { data: [{ id: 'media-1' }] })
      : jsonResponse(200, { data: Array.from({ length: 50 }, (_, n) => ({ id: `old-${n}`, text: 'history', timestamp: at(1) })) });
    const result = await drain(fetch);
    expect(result.records).toHaveLength(50);
    expect(result.pages.at(-1)).toMatchObject({ catchUp: { path: 'cold-start' },
      lossRisk: { kind: 'capped-window-overflow', oldestReachableAt: '2026-10-01T00:00:00.000Z' } });
  });

  it('accepts a full warm window that still reaches the stored watermark', async () => {
    const first = await drain(fake().fetch);
    const fetch: HostFetch = async ({ request }) => new URL(request.url).pathname.endsWith('/media')
      ? jsonResponse(200, { data: [{ id: 'media-1' }] })
      : jsonResponse(200, { data: [
        { id: 'c1', text: 'old boundary', timestamp: at(1) },
        ...Array.from({ length: 49 }, (_, n) => ({ id: `new-${n}`, text: 'new', timestamp: at(3) })),
      ] });
    const result = await drain(fetch, first.cursor);
    expect(result.records).toHaveLength(49);
    expect(result.pages.every((page) => page.lossRisk === undefined)).toBe(true);
  });

  it('keeps timestamp boundary ids, captionless replies and partial-page resume lossless', async () => {
    const first = await drain(fake().fetch);
    const fetch: HostFetch = async ({ request }) => new URL(request.url).pathname.endsWith('/media')
      ? jsonResponse(200, { data: [{ id: 'media-1' }] })
      : jsonResponse(200, { data: [{ id: 'c2', timestamp: at(2), text: 'old', parent_id: 'c1' }, { id: 'c3', timestamp: at(2), text: null, replies: { data: [{ id: 'r3', timestamp: at(3), text: 'reply' }] } }] });
    const result = await drain(fetch, first.cursor);
    expect(result.records.map((r) => r.nativeId)).toEqual(['c3', 'r3']);
    expect(result.records[0]?.payload).toMatchObject({ text: '', textAbsent: true });
    expect(result.records[1]?.payload.replyToId).toBe('c3');
    const page = await adapter.syncPage({ source: 's', cursor: null, mode: 'backfill', config }, fake());
    expect((await drain(fake().fetch, page.nextCursor)).records).toHaveLength(2);
  });

  it('a newer nested reply does not move the top-level comment watermark', async () => {
    const world = (withNew: boolean): HostFetch => async ({ request }) => new URL(request.url).pathname.endsWith('/media')
      ? jsonResponse(200, { data: [{ id: 'media-1' }] })
      : jsonResponse(200, { data: [
        { id: 'top-1', timestamp: at(1), text: 'old', replies: { data: [{ id: 'reply-1', timestamp: at(4), text: 'newer reply' }] } },
        ...(withNew ? [{ id: 'top-2', timestamp: at(2), text: 'later top-level comment' }] : []),
      ] });
    const first = await drain(world(false));
    expect((await drain(world(true), first.cursor)).records.map((r) => r.nativeId)).toEqual(['top-2']);
  });

  it('refuses malformed cursors, unsafe paging, hidden replies and unsupported media before writing', async () => {
    await expect(drain(fake().fetch, 'broken')).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(drain(async () => jsonResponse(200, { data: [], paging: { next: 'https://evil.example/x?after=token' } }))).rejects.toThrow('paging_outside_resource');
    for (const args of [
      { target: { objectId: 'c1', hidden: true }, text: 'reply' },
      { target: { objectId: 'c1', platform: 'facebook-pages' }, text: 'reply' },
    ]) {
      const world = fake();
      await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args }, world)).rejects.toThrow();
      expect(world.calls).toEqual([]);
    }
    const world = fake();
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: config.igUserId, media: [{ type: 'image', url: 'https://cdn.example/a.jpg' }, { type: 'image', url: 'https://cdn.example/b.jpg' }] } }, world)).rejects.toThrow('carousel_unsupported');
    expect(world.calls).toEqual([]);
  });

  it('polls container readiness once per minute without recreating or republishing', async () => {
    vi.useFakeTimers();
    try {
      const world = fake(); let probes = 0;
      const fetch: HostFetch = async (input) => new URL(input.request.url).pathname === '/v26.0/container-1'
        ? jsonResponse(200, { status_code: ++probes === 1 ? 'IN_PROGRESS' : 'FINISHED' })
        : world.fetch(input);
      const pending = adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: config.igUserId, text: 'caption', media: [{ type: 'image', url: 'https://cdn.example/a.jpg' }] } }, { fetch });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(probes).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ externalId: 'media-new' });
      expect(probes).toBe(2);
      expect(world.calls.filter((c) => c.request.method === 'POST')).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('reports the measured status after an ambiguous publish without retrying or inventing a permalink', async () => {
    for (const afterStatus of ['PUBLISHED', 'FINISHED', 'IN_PROGRESS']) {
      const world = fake(); let probes = 0; let publishes = 0;
      const fetch: HostFetch = async (input) => {
        const path = new URL(input.request.url).pathname;
        if (path.endsWith('/media_publish')) { publishes++; return jsonResponse(503, {}); }
        if (path.endsWith('/container-1')) return jsonResponse(200, { status_code: ++probes === 1 ? 'FINISHED' : afterStatus });
        return world.fetch(input);
      };
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: config.igUserId, text: 'caption', media: [{ type: 'image', url: 'https://cdn.example/a.jpg' }] } }, { fetch })).rejects.toMatchObject({ observedStatus: afterStatus, retrySafe: afterStatus === 'FINISHED' ? true : afterStatus === 'PUBLISHED' ? false : null });
      expect(publishes).toBe(1);
    }
  });

  it('refuses deletion when the supplied id is not confirmed as a comment', async () => {
    for (const body of [false, {}, { id: 'media-1' }, { id: 'different', media: { id: 'media-1' } }]) {
      const calls: string[] = [];
      await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: 'media-1' } }, { fetch: async ({ request }) => { calls.push(request.method!); return jsonResponse(200, body); } })).rejects.toThrow('delete_requires_comment_object');
      expect(calls).toEqual(['GET']);
    }
  });

  it('deletes owned media only after the API identifies the object and its account', async () => {
    const calls: string[] = [];
    const fetch: HostFetch = async ({ request }) => {
      const url = new URL(request.url); calls.push(`${request.method}:${url.searchParams.get('fields') || ''}`);
      if (request.method === 'DELETE') return jsonResponse(200, { success: true });
      if (url.searchParams.get('fields') === 'id,media') return jsonResponse(400, { error: { code: 100, message: 'Tried accessing nonexisting field (media) on node type (IGMedia)' } });
      return jsonResponse(200, { id: 'media-1', media_type: 'IMAGE', owner: { id: config.igUserId } });
    };
    expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: 'media-1' } }, { fetch })).toEqual({ deleted: true });
    expect(calls).toEqual(['GET:id,media', 'GET:id,media_type,owner', 'DELETE:']);
  });

  it('checks comment media ownership and refuses another account before deleting', async () => {
    for (const externalId of ['c1', 'media-1']) {
      const methods: string[] = [];
      const fetch: HostFetch = async ({ request }) => {
        methods.push(request.method!);
        const url = new URL(request.url);
        if (url.searchParams.get('fields') === 'id,media') return externalId === 'c1'
          ? jsonResponse(200, { id: 'c1', media: { id: 'media-1' } })
          : jsonResponse(400, { error: { code: 100, message: 'Tried accessing nonexisting field (media) on node type (IGMedia)' } });
        return jsonResponse(200, { id: 'media-1', media_type: 'VIDEO', owner: { id: 'another-account' } });
      };
      await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId } }, { fetch })).rejects.toThrow('delete_media_not_owned');
      expect(methods).toEqual(['GET', 'GET']);
    }
    const world = fake();
    expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: 'c1' } }, world)).toEqual({ deleted: true });
    expect(world.calls.map((call) => call.request.method)).toEqual(['GET', 'GET', 'DELETE']);
  });

  it('never treats auth, throttling, missing objects or transient faults as a different deletion type', async () => {
    for (const [status, code, message, kind] of [
      [403, 200, 'Permission denied', 'auth'],
      [429, 4, 'Throttled', 'rate-limited'],
      [400, 100, 'Unsupported get request: object does not exist or cannot be loaded', 'transient'],
      [503, 2, 'Temporary failure', 'transient'],
    ] as const) {
      let calls = 0;
      await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: 'media-1' } }, {
        fetch: async () => { calls++; return jsonResponse(status, { error: { code, message } }); },
      })).rejects.toMatchObject({ kind });
      expect(calls).toBe(1);
    }
  });
});
