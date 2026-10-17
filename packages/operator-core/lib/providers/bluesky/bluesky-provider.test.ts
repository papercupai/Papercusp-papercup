import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { runProviderConformance } from '@papercusp/plugin-sdk/provider-conformance';
import { validateProviderDescriptor, type HostFetch, type ProviderAdapter, type ProviderRecord } from '@papercusp/plugin-sdk';
const require = createRequire(import.meta.url);
const adapter = require('../../../../../libs/papercusp/plugins/bluesky/index.cjs').providerAdapter as ProviderAdapter;
const DID = 'did:plc:owner'; const FOREIGN = 'did:plc:other'; const COLLECTION = 'app.bsky.feed.post';
const uri = (key: string, did = DID) => `at://${did}/${COLLECTION}/${key}`;
const config = { accountId: DID, pageSize: 2, maxPages: 20 };
const target = { platform: 'bluesky', parentUri: uri('parent'), parentCid: 'parent-cid', rootUri: uri('root'), rootCid: 'root-cid' };
const json = (body: unknown, status = 200, headers = {}) => ({ status, headers, body: JSON.stringify(body), bodyEncoding: 'utf8' as const });
function post(key: string, did = DID) {
  return { uri: uri(key, did), cid: `cid-${key}`, author: { did, handle: `${did.slice(8)}.example` }, indexedAt: '2026-10-16T10:00:00Z',
    record: { $type: COLLECTION, text: `text ${key} 😀`, createdAt: '2026-10-16T09:00:00Z' } };
}
function world() {
  const notifications = ['n4', 'n3', 'n2', 'n1'].map((key) => ({ ...post(key, FOREIGN), reason: 'mention' }));
  const feed = ['f4', 'f3', 'f2', 'f1'].map((key) => ({ post: post(key) }));
  const calls: Parameters<HostFetch>[0][] = [];
  const writes = new Map<string, unknown>();
  const fetch: HostFetch = async (input) => {
    calls.push(input); const u = new URL(input.request.url);
    if (u.pathname.endsWith('createRecord')) {
      const body = JSON.parse(input.request.body!); writes.set(body.rkey, body);
      return json({ uri: uri(body.rkey), cid: 'created-cid' });
    }
    if (u.pathname.endsWith('deleteRecord')) return json({});
    const isFeed = u.pathname.endsWith('getAuthorFeed');
    const rows = isFeed ? feed : notifications;
    const offset = Number(u.searchParams.get('cursor')?.split(':')[1] || 0);
    const limit = Number(u.searchParams.get('limit'));
    return json({ [isFeed ? 'feed' : 'notifications']: rows.slice(offset, offset + limit),
      ...(offset + limit < rows.length ? { cursor: `opaque:${offset + limit}` } : {}) });
  };
  return { fetch, calls, writes, notifications, feed };
}
async function drain(fetch: HostFetch, cursor: string | null = null, chosen = config) {
  const records: ProviderRecord[] = []; const cursors: string[] = []; const risks: unknown[] = [];
  for (let i = 0; i < 100; i++) {
    const page = await adapter.syncPage({ source: 's', config: chosen, cursor, mode: cursor ? 'incremental' : 'backfill' }, { fetch });
    records.push(...page.records); cursor = page.nextCursor; cursors.push(cursor!); if (page.lossRisk) risks.push(page.lossRisk);
    if (!page.hasMore) return { records, cursor, cursors, risks };
  }
  throw new Error('fixture did not settle');
}
describe('Bluesky provider package (P-030)', () => {
  it('derives strong refs from stored package records and legacy metadata before writes', async () => {
    for (const payload of [
      { parentUri: uri('parent'), parentCid: 'parent-cid', rootUri: uri('root'), rootCid: 'root-cid' },
      { uri: uri('parent'), cid: 'parent-cid', rootUri: uri('root'), rootCid: 'root-cid' },
      { cid: 'parent-cid' },
    ]) {
      const w = world();
      await adapter.invoke({ source: 's', config, capability: 'social.reply', args: { text: 'reply', idempotencyKey: 'stored',
        target: { platform: 'bluesky', externalId: uri('parent'), payload } } }, { fetch: w.fetch });
      const record = JSON.parse(w.calls[0].request.body!).record;
      expect(record.reply).toEqual({ parent: { uri: uri('parent'), cid: 'parent-cid' },
        root: { uri: 'rootUri' in payload ? uri('root') : uri('parent'), cid: 'rootCid' in payload ? 'root-cid' : 'parent-cid' } });
    }
    const w = world();
    for (const payload of [{}, { cid: 'parent-cid', rootUri: uri('root') }]) {
      await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { text: 'reply', idempotencyKey: 'stored',
        target: { platform: 'bluesky', externalId: uri('parent'), payload } } }, { fetch: w.fetch })).rejects.toThrow('invalid_strong_ref');
    }
    expect(w.calls).toHaveLength(0);
    await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target: {
      platform: 'bluesky', externalId: uri('parent'), payload: { parentCid: 'exact-cid' } } } }, { fetch: w.fetch });
    expect(JSON.parse(w.calls[0].request.body!)).toMatchObject({ repo: DID, rkey: 'parent', swapRecord: 'exact-cid' });
  });
  it('uses generic app-password sessions without an OAuth descriptor or package access to tokens', async () => {
    const d = await adapter.describe(); expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.oauth).toBeUndefined(); expect(d.setup!.session!.parameters).toEqual({ identifier: 'identifier', password: 'app_password' });
    expect(d.capabilities).toEqual(['social.post', 'social.reply', 'social.delete']);
    expect(d.setup!.credentials!.every((field) => field.hosts === undefined)).toBe(true);
  });
  it('walks both histories, resumes mid-walk and treats completed cursors as a new bounded gap scan', async () => {
    const w = world(); const full = await drain(w.fetch);
    expect(full.records.map((r) => r.nativeId)).toEqual(['n4', 'n3', 'n2', 'n1'].map((key) => uri(key, FOREIGN)).concat(['f4', 'f3', 'f2', 'f1'].map((key) => uri(key))));
    expect(full.records[0]).toMatchObject({ version: `${uri('n4', FOREIGN)}@cid-n4`, event: 'mention', payload: {
      parentUri: uri('n4', FOREIGN), parentCid: 'cid-n4', rootUri: uri('n4', FOREIGN), rootCid: 'cid-n4', text: 'text n4 😀' } });
    expect((await drain(world().fetch, full.cursors[0])).records).toEqual(full.records.slice(2));
    expect((await drain(w.fetch, full.cursor)).records).toEqual([]);
    w.notifications.unshift(...['n8', 'n7', 'n6', 'n5'].map((key) => ({ ...post(key, FOREIGN), reason: 'mention' })));
    const gap = await drain(w.fetch, full.cursor);
    expect(gap.records.map((r) => r.nativeId)).toEqual(['n8', 'n7', 'n6', 'n5'].map((key) => uri(key, FOREIGN)));
    expect(gap.risks).toEqual([]); expect((await drain(w.fetch, gap.cursor)).records).toEqual([]);
    expect(w.calls.every((c) => !c.request.headers?.authorization && !c.request.url.includes('createSession'))).toBe(true);
  });
  it('ignores non-post notifications and reposts and retains full reply coordinates', async () => {
    const w = world();
    w.notifications[0] = { ...w.notifications[0], uri: `at://${FOREIGN}/app.bsky.graph.follow/follow`, reason: 'follow' };
    Object.assign(w.notifications[1], { reason: 'reply', record: { ...w.notifications[1].record,
      reply: { root: { uri: uri('root'), cid: 'root-cid' }, parent: { uri: uri('middle'), cid: 'middle-cid' } } } });
    Object.assign(w.feed[0], { reason: { $type: 'app.bsky.feed.defs#reasonRepost' } });
    const full = await drain(w.fetch);
    expect(full.records).toHaveLength(6);
    expect(full.records[0]).toMatchObject({ event: 'reply', payload: { parentUri: uri('n3', FOREIGN), parentCid: 'cid-n3', rootUri: uri('root'), rootCid: 'root-cid', replyToId: uri('middle') } });
  });
  it('reports unreachable URI/CID markers and refuses malformed, cyclic and bounded pages', async () => {
    const w = world(); const first = await drain(w.fetch);
    w.notifications[0].cid = 'edited';
    const changed = await drain(w.fetch, first.cursor); expect(changed.records[0].version).toContain('@edited');
    expect(changed.risks).toMatchObject([{ kind: 'retention-window-exceeded' }]);
    await expect(drain(w.fetch, '{}')).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(drain(w.fetch, null, { ...config, maxPages: 1 })).rejects.toThrow('page_bound_exceeded');
    await expect(drain(async () => json({ notifications: w.notifications.slice(0, 1), cursor: 'same' }))).rejects.toThrow('paging_made_no_progress');
    await expect(drain(async () => json({ notifications: [{ ...post('bad'), reason: 'mention', record: {} }] }))).rejects.toThrow('malformed_post');
  });
  it('passes the unchanged provider kit with actual pages and all three writes', async () => {
    const report = await runProviderConformance({ adapter, source: 's', config, createFetch: () => world().fetch, invocations: [
      { capability: 'social.post', args: { text: 'post', idempotencyKey: 'kit-post' } },
      { capability: 'social.reply', args: { target, text: 'reply', idempotencyKey: 'kit-reply' } },
      { capability: 'social.delete', args: { target } },
    ] });
    expect(report.failures).toEqual([]); expect(report.ok).toBe(true);
  });
  it('uses a stable collision-resistant record key and both root and parent on replies', async () => {
    const w = world(); const args = { text: 'reply', idempotencyKey: 'same-host-key', target };
    const one = await adapter.invoke({ source: 's', config, capability: 'social.reply', args }, { fetch: w.fetch });
    const two = await adapter.invoke({ source: 's', config, capability: 'social.reply', args }, { fetch: w.fetch });
    expect(two).toEqual(one); expect(w.writes.size).toBe(1);
    const body = [...w.writes.values()][0] as { rkey: string; record: unknown };
    expect(body.rkey).toMatch(/^pc[a-f0-9]{64}$/);
    expect(body.record).toMatchObject({ reply: { root: { uri: target.rootUri, cid: target.rootCid }, parent: { uri: target.parentUri, cid: target.parentCid } } });
  });
  it('deletes only its account with CID compare-and-swap and distinguishes an absent version', async () => {
    const w = world(); expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target } }, { fetch: w.fetch })).toEqual({ deleted: true });
    expect(JSON.parse(w.calls[0].request.body!)).toEqual({ repo: DID, collection: COLLECTION, rkey: 'parent', swapRecord: 'parent-cid' });
    expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target } }, { fetch: async () => json({ error: 'InvalidSwap' }, 400) })).toMatchObject({ deleted: false });
    await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { target: { ...target, parentUri: uri('foreign', FOREIGN) } } }, { fetch: w.fetch })).rejects.toMatchObject({ kind: 'auth' });
    expect(w.calls).toHaveLength(1);
  });
  it('rejects unsupported visibility/media, invalid reply coordinates and missing host idempotency before network calls', async () => {
    const w = world();
    for (const args of [{ text: 'x' }, { text: 'x', idempotencyKey: 'k', visibility: 'followers' }, { text: 'x', idempotencyKey: 'k', media: ['x'] }, { text: 'x'.repeat(301), idempotencyKey: 'k' }]) {
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args }, { fetch: w.fetch })).rejects.toThrow('bluesky:');
    }
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: { text: 'x', idempotencyKey: 'k', target: { ...target, rootCid: '' } } }, { fetch: w.fetch })).rejects.toThrow('invalid_strong_ref');
    expect(w.calls).toHaveLength(0);
  });
  it('preserves auth/throttle errors and refuses ambiguous writes without a package retry', async () => {
    for (const [status, kind] of [[401, 'auth'], [429, 'rate-limited'], [503, 'transient']] as const) {
      await expect(adapter.syncPage({ source: 's', config, cursor: null, mode: 'backfill' }, { fetch: async () => json({}, status, { 'retry-after': '17' }) })).rejects.toMatchObject({ kind });
    }
    let calls = 0;
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { text: 'x', idempotencyKey: 'k' } }, {
      fetch: async () => { calls++; throw new Error('lost response'); },
    })).rejects.toMatchObject({ retrySafe: false }); expect(calls).toBe(1);
  });
});
