import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';
import { providerRegistry } from './provider-registry';
import { createHostFetch } from './host-fetch';
import { fetchProviderIdentity } from './provider-identity';
import { connectionAdapterForPlugin, resolveOAuthProvider } from './connection-lifecycle';

vi.mock('./provider-registry', async (original) => {
  const actual = await original<typeof import('./provider-registry')>();
  return { ...actual, readyProviderRegistry: async () => actual.providerRegistry() };
});
vi.mock('./oauth-client-registration', async (original) => ({
  ...await original<typeof import('./oauth-client-registration')>(),
  readOAuthClientRegistration: async () => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'https://callback.example.com/oauth' }),
}));

const actualX = JSON.parse(readFileSync(new URL('../../../../libs/papercusp/plugins/x/papercusp.json', import.meta.url), 'utf8')).provider as ProviderDescriptor;
const WALL = actualX.verification!.blockedOn!;
const registry = providerRegistry();
const transport = vi.fn<typeof fetch>(async () => Response.json({ data: { id: 'owner', username: 'fixture' }, access_token: 'fixture-access' }));

async function install(blocked = true): Promise<ProviderDescriptor> {
  registry.unregister(actualX.id);
  const descriptor: ProviderDescriptor = structuredClone(actualX);
  if (!blocked) delete descriptor.verification!.blockedOn;
  await registry.register({ descriptor, pluginName: 'owner-wall-fixture', adapter: {
    describe: () => descriptor, syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }), invoke: async () => ({}),
  } });
  return descriptor;
}

beforeEach(() => { registry.clear(); transport.mockClear(); vi.stubGlobal('fetch', transport); });
afterEach(() => { registry.clear(); vi.unstubAllGlobals(); });

describe('provider owner wall at host request seams', () => {
  it('refuses the actual X wall before reading credentials or making host.fetch requests', async () => {
    const descriptor = await install();
    const accessToken = vi.fn(async () => 'fixture-access');
    const hostFetch = createHostFetch(descriptor.id, { registry,
      resolveSource: async () => ({ sourceId: 'source', providerId: descriptor.id }), accessToken, fetchImpl: transport,
    });
    await expect(hostFetch({ source: 'source', request: { url: 'https://api.x.com/2/users/me' } })).rejects.toThrow(/owner.blocked/);
    expect(accessToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses direct OAuth identity lookup while the actual X wall remains', async () => {
    const descriptor = await install();
    await expect(fetchProviderIdentity(descriptor, 'fixture-access', 'provider_x', transport)).rejects.toThrow(/owner.blocked/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses an OAuth flow before the X wall is cleared', async () => {
    await install();
    await expect(resolveOAuthProvider('provider:x-twitter')).rejects.toThrow(/owner.blocked/);
    expect(transport).not.toHaveBeenCalled();
    expect(actualX.verification!.blockedOn).toBe(WALL);
  });

  it.each(['refresh', 'exchangeCode'] as const)('checks pending OAuth %s again when a replacement package adds a wall', async (method) => {
    await install(false);
    const oauth = await resolveOAuthProvider('provider:x-twitter');
    expect(oauth).not.toBeNull();
    await install();
    await expect(oauth![method]('fixture-argument')).rejects.toThrow(/owner.blocked/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a wall added during an asynchronous credential lookup', async () => {
    const descriptor = await install(false);
    const hostFetch = createHostFetch(descriptor.id, { registry,
      resolveSource: async () => ({ sourceId: 'source', providerId: descriptor.id }),
      accessToken: async () => { await install(); return 'fixture-access'; }, fetchImpl: transport,
    });
    await expect(hostFetch({ source: 'source', request: { url: 'https://api.x.com/2/users/me' } })).rejects.toThrow(/owner.blocked/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a captured OAuth flow after the package is unloaded', async () => {
    await install(false);
    const oauth = await resolveOAuthProvider('provider:x-twitter');
    registry.unregister(actualX.id);
    await expect(oauth!.refresh('fixture-refresh')).rejects.toThrow('not-installed');
    expect(transport).not.toHaveBeenCalled();
  });

  it('checks a previously resolved connection adapter before identity lookup', async () => {
    await install(false);
    const adapter = connectionAdapterForPlugin('provider:x-twitter')!;
    await install();
    await expect(adapter.resolveAccount('fixture-access')).rejects.toThrow(/owner.blocked/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('CONTROL: an unblocked descriptor can use host.fetch and identity against fakes', async () => {
    const descriptor = await install(false);
    const hostFetch = createHostFetch(descriptor.id, { registry,
      resolveSource: async () => ({ sourceId: 'source', providerId: descriptor.id }),
      accessToken: async () => 'fixture-access', fetchImpl: transport,
    });
    await hostFetch({ source: 'source', request: { url: 'https://api.x.com/2/users/me' } });
    expect(await fetchProviderIdentity(descriptor, 'fixture-access', 'provider_x', transport)).toMatchObject({ providerAccountId: 'owner' });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
