/** P-027: real package discovery feeds the registry and the generic Integrations card model. */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPlugins } from '@papercusp/plugin-loader';
import { registerPluginProviders } from '../plugin-host-runtime';
import { stopDaemonProvider } from '../integrations/daemon-provider';
import { installPluginFromCupboardCore, InstallPluginError, type InstallPluginManifestReview } from '../cupboard/install-plugin-core';
import { providerSyncErrorOf } from '@papercusp/plugin-sdk';
import { createProviderRegistry } from '../integrations/provider-registry';
import { summarizeIntegrationProvider } from '../integrations/ticket-integrations';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = join(tmpdir(), `social-package-install-${process.pid}-${Date.now()}`);
afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

const PACKAGES = ['facebook-pages', 'instagram', 'x'];
describe('installed social packages use the generic Integrations model', () => {
  it.each(PACKAGES)('%s fails closed before installation when its daemon declaration is removed', async (id) => {
    const globalPluginsDir = join(ROOT, `${id}-refused`);
    let writes = 0;
    await expect(installPluginFromCupboardCore({ githubUrl: 'https://github.com/papercusp/plugins', listingRef: id }, {
      cloneRepo: async (_url, dest) => {
        await fs.cp(join(REPO, 'libs/papercusp/plugins', id), dest, { recursive: true });
        const file = join(dest, 'papercusp.json');
        const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
        delete manifest.runtime;
        await fs.writeFile(file, JSON.stringify(manifest));
      },
      globalPluginsDir: () => globalPluginsDir,
      tmpDir: () => ROOT,
      grant: async () => { writes++; },
      invalidateHost: () => { writes++; },
    })).rejects.toMatchObject({ code: 'provider_runtime_not_sandboxed' });
    expect(await fs.readdir(globalPluginsDir).catch(() => [])).toEqual([]);
    expect(writes).toBe(0);
  });

  it.each(PACKAGES)('%s loads from the install path with declared setup and capabilities', async (id) => {
    const providerId = id === 'x' ? 'x-twitter' : id;
    const projectDir = join(ROOT, id);
    const globalPluginsDir = join(projectDir, 'global-plugins');
    const manifest = JSON.parse(await fs.readFile(join(REPO, 'libs/papercusp/plugins', id, 'papercusp.json'), 'utf8'));
    const grants: unknown[] = [];
    let invalidations = 0;
    const deps = {
      cloneRepo: async (_url: string, dest: string) => {
        await fs.cp(join(REPO, 'libs/papercusp/plugins', id), dest, { recursive: true });
      },
      globalPluginsDir: () => globalPluginsDir,
      tmpDir: () => ROOT,
      grant: async (grant: unknown) => { grants.push(grant); },
      invalidateHost: () => { invalidations++; },
    };
    await fs.mkdir(projectDir, { recursive: true });
    const input = { githubUrl: 'https://github.com/papercusp/plugins', listingRef: id, harnessSlug: 'papercusp' };
    let review: InstallPluginManifestReview | undefined;
    try { await installPluginFromCupboardCore(input, deps); }
    catch (error) {
      expect(error).toBeInstanceOf(InstallPluginError);
      expect(error).toMatchObject({ code: 'provider_install_consent_required' });
      review = (error as InstallPluginError).data?.review as InstallPluginManifestReview;
    }
    expect(review).toBeDefined();
    expect(review!.provider).toMatchObject({
      id: providerId, runtime: 'daemon', contractVersion: 1,
      datatypes: [...manifest.provider.datatypes].sort(),
      capabilities: [...manifest.provider.capabilities].sort(),
      oauthScopes: [...manifest.provider.oauth.scopes].sort(),
      egressHosts: [...manifest.provider.egressHosts].sort(),
    });
    expect(await fs.readdir(globalPluginsDir).catch(() => [])).toEqual([]);
    expect(grants).toEqual([]);
    expect(invalidations).toBe(0);
    const result = await installPluginFromCupboardCore({ ...input, acceptCapabilities: true, expectedReview: review }, deps);
    expect(result.review).toEqual(review);
    expect(result.installedTo).toBe(join(globalPluginsDir, providerId));
    expect(invalidations).toBe(1);
    const { loaded, errors } = await loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir });
    expect(errors).toEqual([]);
    const registry = createProviderRegistry();
    const failures: unknown[] = [];
    expect(await registerPluginProviders(loaded, (failure) => failures.push(failure), registry)).toEqual([providerId]);
    expect(failures).toEqual([]);
    const entry = registry.get(providerId)!;
    expect(entry.runtime).toBe('daemon');
    try {
    expect(entry.descriptor.datatypes).toEqual(['social-post']);
    expect(await entry.adapter!.describe()).toEqual(entry.descriptor);
    const model = summarizeIntegrationProvider(entry, [], {
      ref: id === 'x' ? 'x' : 'facebook', configured: false, clientId: null, hasClientSecret: false,
      redirectUri: 'https://operator.example/api/oauth/callback', savedAt: null,
    });
    expect(model).toMatchObject({ id: providerId, tracksTickets: false });
    expect(model.capabilities).toEqual(entry.descriptor.capabilities);
    expect(model.displayName).toBe(id === 'facebook-pages' ? 'Facebook Pages' : id === 'x' ? 'X' : 'Instagram');
    expect(model.requiredConfig).toEqual(id === 'x' ? ['userId', 'username'] : [id === 'facebook-pages' ? 'pageId' : 'igUserId']);
    expect(new URL(model.connectHref!, 'https://operator.example').searchParams.get('plugin')).toContain(providerId);
    expect(model.appRegistration?.createUrl).toBe(id === 'x' ? 'https://console.x.com/' : 'https://developers.facebook.com/apps/');
    expect(model.oauthClient).toMatchObject({ configured: false, secretRequired: id !== 'x' });
    expect(registry.forDatatype('social-post', 'social.post').map((e) => e.descriptor.id)).toEqual([providerId]);
    // These calls cross the installed process boundary and return through host.fetch;
    // a descriptor-only registration cannot satisfy them. No vendor is contacted.
    const config = id === 'x' ? { userId: '42', username: 'owner' } : id === 'facebook-pages' ? { pageId: '42' } : { igUserId: '42' };
    const fetched: unknown[] = [];
    const page = await entry.adapter!.syncPage({ source: 'installed-source', cursor: null, mode: 'incremental', config }, {
      fetch: async (request) => { fetched.push(request); return { status: 200, headers: {}, body: JSON.stringify({ data: [], meta: { result_count: 0 } }) }; },
    });
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'installed-source' })]));
    expect(page.records).toEqual([]);
    let failure: unknown;
    try {
      await entry.adapter!.syncPage({ source: 'installed-source', cursor: null, mode: 'incremental', config }, {
        fetch: async () => ({ status: 429, headers: { 'retry-after': '37' }, body: '{}' }),
      });
    } catch (error) { failure = error; }
    expect(providerSyncErrorOf(failure)).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 37 });
    if (id === 'facebook-pages') {
      const triggerPack = JSON.parse(await fs.readFile(join(REPO, 'libs/papercusp/plugins/social-facebook-pages/papercusp.json'), 'utf8'));
      expect(triggerPack.triggerPack.bindings.map((b: { source: { sourceKind: string }; eventPattern: string }) => [b.source.sourceKind, b.eventPattern])).toEqual([
        [id, `ext:${id}:post`], [id, `ext:${id}:comment`], [id, `ext:${id}:reply`],
      ]);
    } else if (id === 'instagram') {
      const triggerPack = JSON.parse(await fs.readFile(join(REPO, 'libs/papercusp/plugins/social-instagram/papercusp.json'), 'utf8'));
      expect(triggerPack.triggerPack.bindings.map((b: { eventPattern: string }) => b.eventPattern)).toEqual([
        'ext:instagram:mention', 'ext:instagram:comment', 'ext:instagram:reply',
      ]);
      expect(entry.descriptor.push).toMatchObject({ delivery: 'normalize', signature: { header: 'x-hub-signature-256', prefix: 'sha256=' } });
    }
    } finally { registry.unregisterPlugin(providerId); await stopDaemonProvider(providerId); }
  });
});
