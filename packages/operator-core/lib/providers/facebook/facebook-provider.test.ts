import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { jsonResponse, recordedHostFetch, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter, type ProviderRecord } from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/facebook/index.cjs').providerAdapter as ProviderAdapter;
const API = 'https://graph.facebook.com/v23.0';
function world() {
  return recordedHostFetch([
    { url: (u) => u.pathname === '/v23.0/me', response: jsonResponse(200, { id: 'owner', name: 'Owner', about: 'Builder' }) },
    { url: (u) => u.pathname === '/v23.0/me/feed', response: (r) => new URL(r.url).searchParams.has('after')
      ? jsonResponse(200, { data: [{ id: 'post-1', message: 'Hello' }, { id: 'post-2', story: 'Shared a link', from: { name: 'Owner' } }] })
      : jsonResponse(200, { data: [{ id: 'post-1', message: 'Hello' }], paging: { cursors: { after: 'second' }, next: `${API}/me/feed?after=second&access_token=vendor-secret` } }) },
    { url: (u) => u.pathname === '/v23.0/me/photos', response: jsonResponse(200, { data: [{ id: 'post-1', name: 'Launch photo', picture: 'https://images.test/photo.jpg' }] }) },
  ]);
}
async function drain(fetch: HostFetch, cursor: string | null = null) {
  const records: ProviderRecord[] = [];
  const cursors: string[] = [];
  for (let i = 0; i < 10; i++) {
    const page = await adapter.syncPage({ source: 'vault-source', config: {}, mode: cursor ? 'incremental' : 'backfill', cursor }, { fetch });
    records.push(...page.records); cursors.push(page.nextCursor!); cursor = page.nextCursor;
    if (!page.hasMore) return { records, cursors, cursor };
  }
  throw new Error('drain did not finish');
}

describe('Facebook Personal Vault provider (P-003)', () => {
  it('declares read-only host-held OAuth and the supported personal surface', async () => {
    const d = await adapter.describe();
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d).toMatchObject({ id: 'facebook', datatypes: ['social-post'], capabilities: [], oauth: { clientRegistrationRef: 'facebook', scopes: ['public_profile', 'user_posts', 'user_photos'] } });
    await expect(adapter.invoke({ source: 's', config: {}, capability: 'social.post', args: {} }, world())).rejects.toThrow('provider_capability_unsupported:social.post');
  });

  it('pages, resumes without duplicates and keeps profile/post/photo identities distinct', async () => {
    const fake = world(); const first = await drain(fake.fetch);
    expect(first.records.map((r) => r.nativeId)).toEqual(['owner', 'post-1', 'post-2', 'post-1']);
    expect(first.records.map((r) => r.event)).toEqual(['profile.synced', 'post.synced', 'post.synced', 'photo.synced']);
    expect(first.records[0].payload).toMatchObject({ id: 'owner', entityType: 'profile', author: 'Owner', text: 'Builder' });
    expect(first.records[2].payload).toMatchObject({ author: 'Owner', text: 'Shared a link' });
    expect(first.records[3].payload.media).toEqual([{ url: 'https://images.test/photo.jpg' }]);
    expect((await drain(world().fetch, first.cursors[1])).records.map((r) => r.nativeId)).toEqual(['post-2', 'post-1']);
    expect((await drain(world().fetch, first.cursor)).records).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('vendor-secret');
    expect(fake.calls.every((c) => !new URL(c.request.url).searchParams.has('access_token') && !c.request.headers?.authorization)).toBe(true);
  });

  it('finds changed old posts without a creation-time watermark and advances after an empty page', async () => {
    const initial = await drain(world().fetch);
    const fake = world();
    const fetch: HostFetch = async (input) => {
      const url = new URL(input.request.url);
      expect(url.searchParams.has('since')).toBe(false);
      if (url.pathname.endsWith('/feed') && !url.searchParams.has('after')) return jsonResponse(200, { data: [], paging: { next: 'https://untrusted.invalid/?access_token=secret', cursors: { after: 'older' } } });
      if (url.pathname.endsWith('/feed')) return jsonResponse(200, { data: [{ id: 'post-1', message: 'Edited', created_time: '2020-01-01T00:00:00Z' }] });
      return fake.fetch(input);
    };
    expect((await drain(fetch, initial.cursor)).records).toEqual([expect.objectContaining({ nativeId: 'post-1', payload: expect.objectContaining({ text: 'Edited' }) })]);
  });

  it('surfaces HTTP and Graph faults without retries or error-body disclosure', async () => {
    for (const [status, body, kind] of [[401, {}, 'auth'], [429, {}, 'rate-limited'], [503, {}, 'transient'], [400, { error: { code: 190, message: 'secret' } }, 'auth'], [400, { error: { code: 4, message: 'secret' } }, 'rate-limited']] as const) {
      let calls = 0;
      await expect(drain(async () => { calls++; return jsonResponse(status, body, { 'Retry-After': '7' }); })).rejects.toMatchObject({ kind, message: expect.not.stringContaining('secret') });
      expect(calls).toBe(1);
    }
    await expect(drain(async () => jsonResponse(429, {}, { 'Retry-After': '7' }))).rejects.toMatchObject({ retryAfterSeconds: 7 });
  });

  it('rejects corrupt cursors and incomplete pagination before losing a page', async () => {
    await expect(drain(world().fetch, 'broken')).rejects.toMatchObject({ kind: 'cursor-expired' });
    const first = await adapter.syncPage({ source: 's', config: {}, mode: 'backfill', cursor: null }, world());
    await expect(drain(async () => jsonResponse(200, { data: [], paging: { next: 'https://graph.facebook.com/next' } }), first.nextCursor)).rejects.toMatchObject({ kind: 'cursor-expired' });
  });

  it('runs the shared SDK conformance kit with no write or adoption capabilities', async () => {
    const report = await runProviderConformance({ adapter, source: 'vault-source', config: {}, createFetch: () => world().fetch,
      validatePayload: (_id, p) => typeof p.id === 'string' && typeof p.text === 'string' ? null : 'id/text required' });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
