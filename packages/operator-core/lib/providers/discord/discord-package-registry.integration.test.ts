/**
 * The installed discord package (P-005, D-034): Cupboard consent, registry discovery, the real
 * daemon process, and the host credential boundary that writes the bot token as `Bot <token>`.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPlugins } from '@papercusp/plugin-loader';
import { registerPluginProviders } from '../../plugin-host-runtime';
import { stopDaemonProvider } from '../../integrations/daemon-provider';
import { installPluginFromCupboardCore, InstallPluginError, type InstallPluginManifestReview } from '../../cupboard/install-plugin-core';
import { createProviderRegistry, verifiedProviderForCapability } from '../../integrations/provider-registry';
import { createHostFetch } from '../../integrations/host-fetch';
import { summarizeIntegrationProvider } from '../../integrations/ticket-integrations';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ROOT = join(tmpdir(), `discord-package-install-${process.pid}-${Date.now()}`);
const channelId = '123456789012345678';
const guildId = '987654321098765432';
afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

describe('installed discord notification package', () => {
  it('survives Cupboard consent, registry discovery and the daemon/host credential boundary', async () => {
    const projectDir = join(ROOT, 'discord'); const globalPluginsDir = join(projectDir, 'plugins');
    const deps = { cloneRepo: async (_url: string, dest: string) => { await fs.cp(join(REPO, 'libs/papercusp/plugins/discord'), dest, { recursive: true }); },
      globalPluginsDir: () => globalPluginsDir, tmpDir: () => ROOT, grant: async () => {}, invalidateHost: () => {} };
    const input = { githubUrl: 'https://github.com/papercusp/plugins', listingRef: 'discord', harnessSlug: 'papercusp' };
    let review: InstallPluginManifestReview | undefined;
    try { await installPluginFromCupboardCore(input, deps); }
    catch (error) {
      expect(error).toBeInstanceOf(InstallPluginError);
      expect(error).toMatchObject({ code: 'provider_install_consent_required' });
      review = (error as InstallPluginError).data?.review as InstallPluginManifestReview;
    }
    // The consent review lists capabilities sorted, not in manifest order.
    expect(review?.provider).toMatchObject({ id: 'discord', runtime: 'daemon', capabilities: ['community.presence', 'notify.send'], datatypes: ['notification'], oauthScopes: [] });
    expect(await fs.readdir(globalPluginsDir).catch(() => [])).toEqual([]);
    await installPluginFromCupboardCore({ ...input, acceptCapabilities: true, expectedReview: review }, deps);
    const { loaded, errors } = await loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir });
    expect(errors).toEqual([]);
    const registry = createProviderRegistry();
    expect(await registerPluginProviders(loaded, () => {}, registry)).toEqual(['discord']);
    const entry = verifiedProviderForCapability(registry, 'discord', 'notify.send');
    expect(verifiedProviderForCapability(registry, 'discord', 'community.presence')).toBe(entry);
    try {
      const descriptor = await entry.adapter!.describe();
      expect(descriptor).toEqual(entry.descriptor);
      expect(summarizeIntegrationProvider(entry, [], null)).toMatchObject({ id: 'discord', displayName: 'Discord',
        capabilities: ['notify.send', 'community.presence'], connectHref: null, oauthClient: null, requiredConfig: [] });
      expect(registry.forDatatype('notification', 'notify.send').map((x) => x.descriptor.id)).toEqual(['discord']);
      const seen: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
      const fetch = createHostFetch('discord', { registry, resolveSource: async (source) => source === 'owned' ? { sourceId: source, providerId: 'discord' } : null,
        accessToken: async () => { throw new Error('OAuth must not be consulted'); }, pastedCredential: async () => 'host-private-bot-token',
        fetchImpl: (async (url, init) => {
          seen.push({ url: String(url), method: String(init?.method), headers: new Headers(init?.headers), body: String(init?.body ?? '') });
          return String(url).endsWith('/widget.json')
            ? Response.json({ id: guildId, name: 'Papercusp', presence_count: 12 })
            : Response.json({ id: '111111111111111111', channel_id: channelId, content: 'Hello' });
        }) as typeof globalThis.fetch });
      const config = { channelId, guildId };
      const sent = await entry.adapter!.invoke({ source: 'owned', config, capability: 'notify.send', args: { text: 'Hello', idempotencyKey: 'k1' } }, { fetch });
      expect(sent).toEqual({ externalId: '111111111111111111', channelId, url: `https://discord.com/channels/${guildId}/${channelId}/111111111111111111` });
      const presence = await entry.adapter!.invoke({ source: 'owned', config, capability: 'community.presence', args: {} }, { fetch });
      expect(presence).toMatchObject({ widget: 'enabled', presenceCount: 12, name: 'Papercusp' });
      expect(seen.map((s) => [s.method, s.url])).toEqual([
        ['POST', `https://discord.com/api/v10/channels/${channelId}/messages`],
        ['GET', `https://discord.com/api/v10/guilds/${guildId}/widget.json`],
      ]);
      expect(seen[0].headers.get('authorization')).toBe('Bot host-private-bot-token');
      for (const call of seen) expect(call.body).not.toContain('host-private-bot-token');
      expect(JSON.stringify([sent, presence])).not.toContain('host-private-bot-token');
      await expect(entry.adapter!.invoke({ source: 'owned', config, capability: 'social.post', args: {} }, { fetch })).rejects.toThrow('capability_unsupported');
      expect(seen).toHaveLength(2);
    } finally {
      expect(await stopDaemonProvider('discord')).toBe(true);
      registry.unregisterPlugin('discord');
    }
    expect(registry.get('discord')).toBeUndefined();
  });
});
