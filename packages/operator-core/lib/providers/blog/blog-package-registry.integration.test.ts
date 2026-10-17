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
const ROOT = join(tmpdir(), `blog-package-install-${process.pid}-${Date.now()}`);
afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });
describe.each(['devto', 'hashnode'])('installed %s publishing package', (id) => {
  it('survives Cupboard consent, registry discovery and the daemon/host credential boundary', async () => {
    const projectDir = join(ROOT, id); const globalPluginsDir = join(projectDir, 'plugins');
    const deps = { cloneRepo: async (_url: string, dest: string) => { await fs.cp(join(REPO, 'libs/papercusp/plugins', id), dest, { recursive: true }); },
      globalPluginsDir: () => globalPluginsDir, tmpDir: () => ROOT, grant: async () => {}, invalidateHost: () => {} };
    const input = { githubUrl: 'https://github.com/papercusp/plugins', listingRef: id, harnessSlug: 'papercusp' };
    let review: InstallPluginManifestReview | undefined;
    try { await installPluginFromCupboardCore(input, deps); }
    catch (error) { expect(error).toBeInstanceOf(InstallPluginError); expect(error).toMatchObject({ code: 'provider_install_consent_required' }); review = (error as InstallPluginError).data?.review as InstallPluginManifestReview; }
    expect(review?.provider).toMatchObject({ id, runtime: 'daemon', capabilities: ['blog.post'], datatypes: ['blog-post'], oauthScopes: [] });
    expect(await fs.readdir(globalPluginsDir).catch(() => [])).toEqual([]);
    await installPluginFromCupboardCore({ ...input, acceptCapabilities: true, expectedReview: review }, deps);
    const { loaded, errors } = await loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir }); expect(errors).toEqual([]);
    const registry = createProviderRegistry(); expect(await registerPluginProviders(loaded, () => {}, registry)).toEqual([id]);
    const entry = verifiedProviderForCapability(registry, id, 'blog.post');
    try {
      const descriptor = await entry.adapter!.describe(); expect(descriptor).toEqual(entry.descriptor);
      const model = summarizeIntegrationProvider(entry, [], null);
      expect(model).toMatchObject({ id, displayName: id === 'devto' ? 'dev.to' : 'Hashnode', capabilities: ['blog.post'], connectHref: null, oauthClient: null });
      expect(model.requiredConfig).toEqual(id === 'hashnode' ? ['publicationId'] : []);
      expect(descriptor.setup?.credentials).toHaveLength(1);
      expect(registry.forDatatype('blog-post', 'blog.post').map((x) => x.descriptor.id)).toEqual([id]);
      const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
      const fetch = createHostFetch(id, { registry, resolveSource: async (source) => source === 'owned' ? { sourceId: source, providerId: id } : null,
        accessToken: async () => { throw new Error('OAuth must not be consulted'); }, pastedCredential: async () => 'host-private-key',
        fetchImpl: (async (url, init) => {
          const body = JSON.parse(String(init?.body)); seen.push({ url: String(url), headers: new Headers(init?.headers), body });
          return id === 'devto' ? Response.json({ id: 123, url: 'https://dev.to/papercusp/post' }, { status: 201 }) :
            Response.json({ data: body.query.includes('PublishPostInput') ? { publishPost: { post: { id: 'post-123', url: 'https://blog.example/post' } } } : { createDraft: { draft: { id: 'draft-123' } } } });
        }) as typeof globalThis.fetch });
      const config = id === 'hashnode' ? { publicationId: '0123456789abcdef01234567' } : {};
      const page = await entry.adapter!.syncPage({ source: 'owned', config, cursor: null, mode: 'incremental' }, { fetch });
      expect(page).toMatchObject({ records: [], hasMore: false }); expect(seen).toEqual([]);
      for (const published of [false, true]) {
        const result = await entry.adapter!.invoke({ source: 'owned', config, capability: 'blog.post',
          args: { title: 'Installed package', markdown: '# Content', canonicalUrl: 'https://papercusp.com/blog/content', published } }, { fetch });
        expect(result).toMatchObject({ published, canonicalUrl: 'https://papercusp.com/blog/content' }); expect(JSON.stringify(result)).not.toContain('host-private-key');
      }
      expect(seen).toHaveLength(2);
      for (const call of seen) {
        expect(call.headers.get(id === 'devto' ? 'api-key' : 'authorization')).toBe(id === 'devto' ? 'host-private-key' : 'Bearer host-private-key');
        expect(JSON.stringify(call.body)).not.toContain('host-private-key');
      }
      await expect(entry.adapter!.invoke({ source: 'owned', config, capability: 'social.post', args: {} }, { fetch })).rejects.toThrow('capability_unsupported');
      expect(seen).toHaveLength(2);
    } finally { expect(await stopDaemonProvider(id)).toBe(true); registry.unregisterPlugin(id); }
    expect(registry.get(id)).toBeUndefined();
  });
});
