/**
 * P-024 containment follows the package descriptor and the actual host fetch.
 * The old app-side egress policy is retired; no vendor request leaves these tests.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { providerSourceEgressAllows, type ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createProviderRegistry } from '../../integrations/provider-registry';
import { createHostFetch } from '../../integrations/host-fetch';

const packagesRoot = new URL('../../../../../libs/papercusp/plugins/', import.meta.url);
const packages = readdirSync(packagesRoot).flatMap((name) => {
  const manifest = new URL(`${name}/papercusp.json`, packagesRoot);
  if (!existsSync(manifest)) return [];
  const descriptor = JSON.parse(readFileSync(manifest, 'utf8')).provider as ProviderDescriptor | undefined;
  return descriptor?.datatypes?.includes('social-post') ? [{ name, descriptor }] : [];
});

async function boundFetch(descriptor: ProviderDescriptor, config: Record<string, unknown> = {}) {
  const registry = createProviderRegistry();
  await registry.register({ descriptor, pluginName: 'egress-control', adapter: {
    describe: () => descriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async () => ({}),
  } });
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const accessToken = vi.fn(async () => 'fixture-host-held-token');
  const hostFetch = createHostFetch(descriptor.id, {
    registry, resolveSource: async () => ({ sourceId: 'source', providerId: descriptor.id, config }),
    accessToken, fetchImpl,
  });
  return { fetch: hostFetch, fetchImpl, accessToken, registry };
}

describe('social package egress containment', () => {
  it('measures every installed-shape social package and keeps the retired runtime absent', () => {
    expect(packages.map(({ name }) => name).sort()).toEqual(expect.arrayContaining([
      'bluesky', 'facebook-pages', 'instagram', 'linkedin', 'mastodon',
      'reddit', 'threads', 'tiktok', 'x', 'youtube',
    ]));
    expect(new Set(packages.map(({ descriptor }) => descriptor.id)).size).toBe(packages.length);
    expect(existsSync(new URL('./social-egress.ts', import.meta.url))).toBe(false);
    const host = readFileSync(new URL('../../integrations/host-fetch.ts', import.meta.url), 'utf8');
    expect(host).toContain('providerSourceEgressAllows(registered.descriptor, url, resolved.config)');
    expect(host).toContain("redirect: 'manual'");
  });

  it.each(packages)('$name refuses foreign, lookalike, insecure and credential-bearing URLs before credentials or transport', async ({ descriptor }) => {
    const bound = await boundFetch(descriptor);
    const declared = descriptor.egressHosts[0] ?? 'instance.example';
    for (const url of [
      'https://exfil.example/api', `https://${declared}.exfil.example/api`,
      `https://exfil-${declared}/api`, `https://owner:secret@${declared}/api`,
      `http://${declared}/api`, 'https://127.0.0.1/api',
    ]) {
      await expect(bound.fetch({ source: 'source', request: { url } }))
        .rejects.toMatchObject(descriptor.verification?.blockedOn
          ? { reason: 'owner-blocked' }
          : { code: url.startsWith('http:') ? 'insecure-url' : 'egress-denied' });
    }
    expect(bound.accessToken).not.toHaveBeenCalled();
    expect(bound.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(packages)('$name uses its own declared fixed hosts or exact connection origin', ({ descriptor }) => {
    for (const host of descriptor.egressHosts) {
      expect(providerSourceEgressAllows(descriptor, new URL(`https://${host}/api`))).toBe(true);
    }
    if (descriptor.oauth?.instance) {
      expect(descriptor.egressHosts).toEqual([]);
      const config = { connectionOrigin: 'https://chosen.example.com' };
      expect(providerSourceEgressAllows(descriptor, new URL('https://chosen.example.com/api'), config)).toBe(true);
      for (const url of ['https://other.example.com/api', 'https://sub.chosen.example.com/api', 'https://chosen.example.com:8443/api']) {
        expect(providerSourceEgressAllows(descriptor, new URL(url), config)).toBe(false);
      }
      expect(providerSourceEgressAllows(descriptor, new URL('https://chosen.example.com/api'))).toBe(false);
    } else {
      expect(descriptor.egressHosts.length).toBeGreaterThan(0);
      const foreign = packages.find(({ descriptor: other }) =>
        other.egressHosts.some((host) => !providerSourceEgressAllows(descriptor, new URL(`https://${host}/api`))))!;
      const host = foreign.descriptor.egressHosts.find((host) =>
        !providerSourceEgressAllows(descriptor, new URL(`https://${host}/api`)))!;
      expect(providerSourceEgressAllows(descriptor, new URL(`https://${host}/api`))).toBe(false);
    }
  });

  it('CONTROL: allows a declared request with a host-injected credential and refuses after unload', async () => {
    const descriptor = packages.find(({ name }) => name === 'threads')!.descriptor;
    const bound = await boundFetch(descriptor);
    await bound.fetch({ source: 'source', request: { url: 'https://graph.threads.net/control' } });
    expect(bound.fetchImpl).toHaveBeenCalledOnce();
    const [, init] = bound.fetchImpl.mock.calls[0]!;
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-host-held-token');
    expect(init?.redirect).toBe('manual');
    bound.registry.unregister(descriptor.id);
    await expect(bound.fetch({ source: 'source', request: { url: 'https://graph.threads.net/control' } }))
      .rejects.toMatchObject({ code: 'unknown-source' });
    expect(bound.fetchImpl).toHaveBeenCalledOnce();
  });

  it('CONTROL: a connected instance authorizes only that exact origin through host.fetch', async () => {
    const descriptor = packages.find(({ name }) => name === 'mastodon')!.descriptor;
    const bound = await boundFetch(descriptor, { connectionOrigin: 'https://chosen.example.com' });
    await bound.fetch({ source: 'source', request: { url: 'https://chosen.example.com/api/v1/control' } });
    expect(bound.fetchImpl).toHaveBeenCalledOnce();
    for (const url of ['https://other.example.com/api', 'https://sub.chosen.example.com/api', 'https://chosen.example.com:8443/api']) {
      await expect(bound.fetch({ source: 'source', request: { url } })).rejects.toMatchObject({ code: 'egress-denied' });
    }
    expect(bound.fetchImpl).toHaveBeenCalledOnce();
  });
});
