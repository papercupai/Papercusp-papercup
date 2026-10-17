import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import { createProviderRegistry } from '../integrations/provider-registry';
const mocks = vi.hoisted(() => ({ sources: vi.fn(), trust: vi.fn(), disclosure: vi.fn(), flag: vi.fn() }));
vi.mock('../external-triggers/source-store', async (original) => ({ ...(await original<object>()), listOwnedExternalTriggerSources: mocks.sources }));
vi.mock('./addressing', async (original) => ({ ...(await original<object>()), assertTrustedAddressee: mocks.trust }));
vi.mock('../personal-vault/disclosure-ledger', async (original) => ({ ...(await original<object>()), assertDisclosurePermits: mocks.disclosure }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: mocks.flag }));
import { postToBlog } from './blog';

const sql = (async () => []) as unknown as postgres.Sql;
const base = { workspaceId: 'ws', userId: 'owner', providerId: 'blog-example', sourceId: 'owned-source',
  title: 'Blog title', markdown: '# Blog content', canonicalUrl: 'https://papercusp.com/blog/title',
  provenance: { from: 'owner-instruction' } as const, agentOwnerId: 'agent' };
beforeEach(() => { vi.resetAllMocks(); mocks.flag.mockResolvedValue(false); mocks.sources.mockResolvedValue([{ id: 'owned-source',
  workspaceId: 'ws', ownerUserId: 'owner', kind: 'blog-example', status: 'active', credentialRef: 'provider-setup:blog-example',
  config: { publicationId: 'source-owned-publication' } }]); });
async function fixture(capabilities = ['blog.post']) {
  const descriptor: ProviderDescriptor = { id: 'blog-example', contractVersion: 1, datatypes: ['blog-post'], sync: false,
    capabilities, egressHosts: ['blog.test'], verification: { verifiedAt: '2026-10-17', sources: ['https://blog.test/docs'], capabilities: Object.fromEntries(capabilities.map((c) => [c, '2026-10-17'])) } };
  const invoke = vi.fn(async (request: ProviderInvokeRequest) => ({ externalId: 'created', published: request.args.published,
    canonicalUrl: request.args.canonicalUrl }));
  const registry = createProviderRegistry();
  await registry.register({ descriptor, pluginName: descriptor.id, adapter: { describe: () => descriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }), invoke } });
  const fetch = vi.fn(); return { registry, invoke, deps: { registry, hostFetchFor: () => fetch } };
}
describe('blog publishing through existing outbound rails', () => {
  it('permits a vendor draft with the publication flag off and source-owned publication config', async () => {
    const f = await fixture(); const result = await postToBlog(sql, base, f.deps);
    expect(result.status).toBe('drafted'); expect(mocks.flag).not.toHaveBeenCalled();
    expect(mocks.trust).toHaveBeenCalledWith(sql, expect.objectContaining({ address: 'blog-example:source-owned-publication', provenance: base.provenance }));
    expect(mocks.disclosure).toHaveBeenCalledWith(sql, expect.objectContaining({ recipients: null, sink: 'blog:blog-example:source-owned-publication' }));
    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ source: base.sourceId, capability: 'blog.post',
      config: { publicationId: 'source-owned-publication' }, args: expect.objectContaining({ published: false }) }), expect.anything());
  });
  it('withholds public publication and reports the real source when the registered setting is off', async () => {
    const f = await fixture(); const result = await postToBlog(sql, { ...base, published: true }, f.deps);
    expect(result).toMatchObject({ status: 'withheld', result: null, echo: { sourceId: base.sourceId }, withheld: { reason: 'publish-flag-off' } });
    expect(mocks.flag).toHaveBeenCalledWith('papercusp-social-auto-publish', 'social-post:ws'); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('publishes only after both outbound rails and owner publication setting permit it', async () => {
    const f = await fixture(); mocks.flag.mockResolvedValue(true);
    expect((await postToBlog(sql, { ...base, published: true }, f.deps)).status).toBe('published');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.trust.mock.invocationCallOrder[0]).toBeLessThan(f.invoke.mock.invocationCallOrder[0]);
    expect(mocks.disclosure.mock.invocationCallOrder[0]).toBeLessThan(f.invoke.mock.invocationCallOrder[0]);
  });
  it.each(['trust', 'disclosure'] as const)('refuses %s failures for drafts and public posts before the provider', async (rail) => {
    for (const published of [false, true]) {
      const f = await fixture(); mocks[rail].mockRejectedValueOnce(new Error('rail refused'));
      await expect(postToBlog(sql, { ...base, published }, f.deps)).rejects.toThrow('rail refused'); expect(f.invoke).not.toHaveBeenCalled();
    }
  });
  it('refuses unowned sources, source/provider mismatch and unsupported capabilities', async () => {
    const f = await fixture();
    await expect(postToBlog(sql, { ...base, sourceId: 'foreign' }, f.deps)).rejects.toThrow('not_connected');
    await expect(postToBlog(sql, { ...base, providerId: 'missing' }, f.deps)).rejects.toThrow('not_connected');
    const unsupported = await fixture(['blog.read']); await expect(postToBlog(sql, base, unsupported.deps)).rejects.toThrow('provider_capability_unsupported');
    expect(f.invoke).not.toHaveBeenCalled(); expect(unsupported.invoke).not.toHaveBeenCalled();
  });
  it('does not invoke an unverified or owner-blocked installed package', async () => {
    for (const verification of [undefined, { verifiedAt: '2026-10-17', sources: ['https://blog.test/docs'], capabilities: { 'blog.post': '2026-10-17' }, blockedOn: 'owner approval' }]) {
      const f = await fixture(); f.registry.get(base.providerId)!.descriptor.verification = verification;
      await expect(postToBlog(sql, base, f.deps)).rejects.toThrow(); expect(f.invoke).not.toHaveBeenCalled();
    }
  });
  it('keeps provider failures and malformed results ambiguous without retry', async () => {
    const f = await fixture(); f.invoke.mockRejectedValueOnce(Object.assign(new Error('ambiguous'), { retrySafe: false }));
    await expect(postToBlog(sql, base, f.deps)).rejects.toMatchObject({ retrySafe: false }); expect(f.invoke).toHaveBeenCalledTimes(1);
    f.invoke.mockResolvedValueOnce({ externalId: '', published: false, canonicalUrl: base.canonicalUrl });
    await expect(postToBlog(sql, base, f.deps)).rejects.toMatchObject({ retrySafe: false }); expect(f.invoke).toHaveBeenCalledTimes(2);
  });
});
