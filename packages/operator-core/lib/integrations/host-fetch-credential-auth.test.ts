import { describe, expect, it, vi } from 'vitest';
import type { ProviderCredentialField, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createHostFetch } from './host-fetch';
import { createProviderRegistry } from './provider-registry';

async function fixture(auth?: ProviderCredentialField['auth'], perPrincipal = false, ownCredential = false) {
  const descriptor: ProviderDescriptor = { id: 'blog-fixture', contractVersion: 1, datatypes: ['blog-post'], sync: false,
    capabilities: ['blog.post'], egressHosts: ['blog.test'], setup: { credentials: [
      { key: 'api_key', label: 'API key', hosts: ['blog.test'], ...(auth ? { auth } : {}), perPrincipal },
    ] } };
  const registry = createProviderRegistry();
  await registry.register({ descriptor, pluginName: descriptor.id, adapter: {
    describe: () => descriptor, syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }), invoke: async () => ({}),
  } });
  const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    return Response.json({ echoed: headers.get(auth?.header ?? 'authorization') }, { headers: { 'x-reflected': 'private-key' } });
  });
  const pastedCredential = vi.fn(async () => 'private-key');
  const principalCredential = vi.fn(async () => 'private-key');
  const fetch = createHostFetch(descriptor.id, { registry, fetchImpl: fetchImpl as typeof globalThis.fetch,
    resolveSource: async (id) => id === 'source' ? { sourceId: id, providerId: descriptor.id, ownCredential } : null,
    accessToken: async () => 'own-oauth', pastedCredential, ...(perPrincipal ? { principalCredential } : {}) });
  return { call: (headers?: Record<string, string>, url = 'https://blog.test/posts') => fetch({ source: 'source', request: { url, headers } }),
    fetchImpl, pastedCredential, principalCredential };
}

describe('host-owned pasted credential authentication', () => {
  it.each([
    [undefined, 'authorization', 'Bearer private-key'],
    [{ header: 'api-key', scheme: 'raw' }, 'api-key', 'private-key'],
    [{ header: 'authorization', scheme: 'raw' }, 'authorization', 'private-key'],
    [{ header: 'x-api-key', scheme: 'bearer' }, 'x-api-key', 'Bearer private-key'],
    // Discord bot tokens (P-005, D-034): `Authorization: Bot <token>`.
    [{ header: 'authorization', scheme: 'bot' }, 'authorization', 'Bot private-key'],
  ] as const)('injects %j and redacts reflected secrets in response body and headers', async (auth, name, value) => {
    const f = await fixture(auth);
    const result = await f.call();
    expect(new Headers(f.fetchImpl.mock.calls[0][1]?.headers).get(name)).toBe(value);
    expect(result.body).not.toContain('private-key');
    expect(result.headers['x-reflected']).not.toContain('private-key');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('uses per-person custom authentication without consulting the source credential', async () => {
    const f = await fixture({ header: 'api-key', scheme: 'raw' }, true);
    await f.call(); expect(f.principalCredential).toHaveBeenCalledWith('api_key'); expect(f.pastedCredential).not.toHaveBeenCalled();
    expect(new Headers(f.fetchImpl.mock.calls[0][1]?.headers).get('api-key')).toBe('private-key');
  });
  it('preserves connected OAuth precedence over an alternative pasted API key', async () => {
    const f = await fixture({ header: 'api-key', scheme: 'raw' }, false, true);
    await f.call(); const headers = new Headers(f.fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer own-oauth'); expect(headers.has('api-key')).toBe(false);
    expect(f.pastedCredential).not.toHaveBeenCalled();
  });
  it('refuses package-supplied authentication headers and out-of-scope hosts before fetching', async () => {
    const f = await fixture({ header: 'api-key', scheme: 'raw' });
    for (const name of ['Authorization', 'API-Key', 'X-API-Key']) {
      await expect(f.call({ [name]: 'override' })).rejects.toMatchObject({ code: 'caller-authorization-header' });
    }
    await expect(f.call({}, 'https://elsewhere.test/posts')).rejects.toMatchObject({ code: 'egress-denied' });
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.pastedCredential).not.toHaveBeenCalled();
  });
  it('fails closed when the source credential is missing', async () => {
    const f = await fixture({ header: 'api-key', scheme: 'raw' });
    f.pastedCredential.mockResolvedValueOnce(null as unknown as string);
    await expect(f.call()).rejects.toMatchObject({ code: 'credential-unavailable' }); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
