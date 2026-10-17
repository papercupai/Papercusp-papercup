import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, recordedHostFetch, runProviderConformance, validateProviderDescriptor, type ProviderAdapter } from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/linkedin/index.cjs').providerAdapter as ProviderAdapter;
const config = { memberId: 'owner' };
const urn = 'urn:li:share:123456';
const postArgs = { destination: 'owner', text: 'Hello' };
function fake() {
  return recordedHostFetch([
    { method: 'POST', url: 'https://api.linkedin.com/rest/posts', response: jsonResponse(201, {}, { 'X-RestLi-Id': urn }) },
    { method: 'DELETE', url: `https://api.linkedin.com/rest/posts/${encodeURIComponent(urn)}`, response: jsonResponse(204, {}) },
  ]);
}
describe('LinkedIn personal-profile provider package (P-001)', () => {
  it('declares ordinary profile publishing and reauthorization without partner privileges', async () => {
    const d = await adapter.describe(); expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.sync).toBe(false);
    expect(d.capabilities).toEqual(['social.post', 'social.delete']);
    expect(d.oauth).toMatchObject({ scopes: ['openid', 'profile', 'w_member_social'], refreshPolicy: 'reauthorize', identity: { idField: 'sub' } });
    const fetch = vi.fn();
    expect(await adapter.syncPage({ source: 's', config, cursor: null, mode: 'backfill' }, { fetch })).toMatchObject({ records: [], hasMore: false });
    await expect(adapter.syncPage({ source: 's', config, cursor: 'foreign-cursor', mode: 'incremental' }, { fetch })).rejects.toMatchObject({ kind: 'cursor-expired' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('posts once with the configured personal author, pinned version and visibility', async () => {
    const world = fake();
    expect(await adapter.invoke({ source: 's', config, capability: 'social.post', args: { ...postArgs, visibility: 'followers' } }, world)).toMatchObject({ externalId: urn });
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0].request.headers).toMatchObject({ 'LinkedIn-Version': '202608', 'X-Restli-Protocol-Version': '2.0.0' });
    expect(world.calls[0].request.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(world.calls[0].request.body!)).toEqual({ author: 'urn:li:person:owner', commentary: 'Hello', visibility: 'CONNECTIONS', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false });
  });
  it('refuses organization destinations, unsupported capabilities, media and invalid text before fetching', async () => {
    const fetch = vi.fn();
    for (const args of [{ ...postArgs, destination: 'urn:li:organization:123' }, { ...postArgs, text: '' }, { ...postArgs, text: 'x'.repeat(3001) }, { ...postArgs, media: [{ url: 'https://cdn.example/image.jpg' }] }, { ...postArgs, visibility: 'direct' }, { ...postArgs, visibility: 'unlisted' }]) {
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args }, { fetch })).rejects.toThrow();
    }
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: {} }, { fetch })).rejects.toThrow('capability_unsupported');
    await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: '../../elsewhere' } }, { fetch })).rejects.toThrow('invalid_post_urn');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies auth and rate limits without retries or provider error-text leakage', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limited']] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, { message: 'secret' }, { 'retry-after': '37' }));
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch })).rejects.toMatchObject({ kind });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('retains ambiguity on transport failure, 409, 5xx and missing created-id', async () => {
    for (const status of [201, 409, 500, 503]) {
      const fetch = vi.fn(async () => jsonResponse(status, {}));
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch })).rejects.toMatchObject({ kind: 'transient', retrySafe: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => { throw new Error('network'); });
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch })).rejects.toMatchObject({ message: 'linkedin:post_ambiguous_do_not_retry', retrySafe: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('encodes a post URN once and distinguishes successful absence from 404', async () => {
    for (const [status, deleted] of [[204, true], [404, false]] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, {}));
      expect(await adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: urn } }, { fetch })).toEqual({ deleted });
      expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ method: 'DELETE', url: `https://api.linkedin.com/rest/posts/${encodeURIComponent(urn)}` }) }));
    }
  });
  it('passes the shared kit for an honestly empty read surface and both declared writes', async () => {
    const report = await runProviderConformance({ adapter, source: 's', config, createFetch: () => fake().fetch,
      // Ordinary Share grants have no readable endpoint to return HTTP faults.
      // Invoke fault checks and the direct auth/rate-limit tests still exercise writes.
      faults: { rateLimited: false, auth: false, serverError: false },
      invocations: [{ capability: 'social.post', args: postArgs }, { capability: 'social.delete', args: { externalId: urn } }] });
    expect(report.failures).toEqual([]); expect(report.ok).toBe(true);
  });
});
