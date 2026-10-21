/**
 * provider-adapters-to-packages-2026-10-11 P-034: google-contacts reaches a running app through a
 * Cupboard install, as a sandboxed provider daemon. The installer refuses an in-process provider,
 * so the package carries the SDK-generated daemon.cjs launcher (byte-checked by
 * social-package-architecture.test.ts's builder check for social packages, and here by loading it).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPlugins } from '@papercusp/plugin-loader';
import { jsonResponse, type HostFetch } from '@papercusp/plugin-sdk';
import { installPluginFromCupboardCore, InstallPluginError, type InstallPluginManifestReview } from '../../cupboard/install-plugin-core';
import { stopDaemonProvider } from '../../integrations/daemon-provider';
import { createProviderRegistry } from '../../integrations/provider-registry';
import { summarizeIntegrationProvider } from '../../integrations/ticket-integrations';
import { registerPluginProviders } from '../../plugin-host-runtime';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE = join(REPO, 'libs/papercusp/plugins/google-contacts');
const ROOT = join(tmpdir(), `google-contacts-install-${process.pid}-${Date.now()}`);
afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

describe('installed google-contacts provider package (P-034)', () => {
  it('is refused by the Cupboard installer when its daemon declaration is removed', async () => {
    const globalPluginsDir = join(ROOT, 'refused-global');
    let writes = 0;
    await expect(installPluginFromCupboardCore({ githubUrl: 'https://github.com/papercusp/plugins', listingRef: 'google-contacts' }, {
      cloneRepo: async (_url, dest) => {
        await fs.cp(PACKAGE, dest, { recursive: true });
        const file = join(dest, 'papercusp.json');
        const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
        delete manifest.runtime;
        await fs.writeFile(file, JSON.stringify(manifest));
      },
      globalPluginsDir: () => globalPluginsDir, tmpDir: () => ROOT,
      grant: async () => { writes++; }, invalidateHost: () => { writes++; },
    })).rejects.toMatchObject({ code: 'provider_runtime_not_sandboxed' });
    expect(await fs.readdir(globalPluginsDir).catch(() => [])).toEqual([]);
    expect(writes).toBe(0);
  });

  it('is absent before install and, after a consented install, syncs and reads contacts across the daemon boundary', async () => {
    const projectDir = join(ROOT, 'project');
    const globalPluginsDir = join(ROOT, 'global-plugins');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(globalPluginsDir, { recursive: true });
    const absent = await loadPlugins({ projectDir, globalPluginsDir, harnessSlugs: [] });
    expect(absent.loaded.map((lp) => lp.plugin.name)).not.toContain('google-contacts');

    const deps = {
      cloneRepo: async (_url: string, dest: string) => { await fs.cp(PACKAGE, dest, { recursive: true }); },
      globalPluginsDir: () => globalPluginsDir, tmpDir: () => ROOT, grant: async () => {}, invalidateHost: () => {},
    };
    const input = { githubUrl: 'https://github.com/papercusp/plugins', listingRef: 'google-contacts', harnessSlug: 'papercusp' };
    let review: InstallPluginManifestReview | undefined;
    try { await installPluginFromCupboardCore(input, deps); } catch (error) {
      expect(error).toBeInstanceOf(InstallPluginError);
      expect(error).toMatchObject({ code: 'provider_install_consent_required' });
      review = (error as InstallPluginError).data?.review as InstallPluginManifestReview;
    }
    expect(review?.provider).toMatchObject({
      id: 'contacts', runtime: 'daemon', datatypes: ['contact'], capabilities: ['contacts.read'],
      oauthScopes: ['https://www.googleapis.com/auth/contacts.readonly'],
      egressHosts: ['accounts.google.com', 'oauth2.googleapis.com', 'people.googleapis.com'],
    });
    expect(await fs.readdir(globalPluginsDir)).toEqual([]);
    const result = await installPluginFromCupboardCore({ ...input, acceptCapabilities: true, expectedReview: review }, deps);
    expect(result.installedTo).toBe(join(globalPluginsDir, 'google-contacts'));

    const { loaded, errors } = await loadPlugins({ projectDir, globalPluginsDir, harnessSlugs: [] });
    expect(errors).toEqual([]);
    const registry = createProviderRegistry();
    const failures: unknown[] = [];
    expect(await registerPluginProviders(loaded, (failure) => failures.push(failure), registry)).toEqual(['contacts']);
    expect(failures).toEqual([]);
    const entry = registry.get('contacts')!;
    expect(entry.runtime).toBe('daemon');
    try {
      expect(await entry.adapter!.describe()).toEqual(entry.descriptor);
      const model = summarizeIntegrationProvider(entry, [], { ref: 'google', configured: false, clientId: null,
        hasClientSecret: false, redirectUri: 'https://operator.test/api/oauth/callback', savedAt: null });
      expect(model).toMatchObject({ id: 'contacts', displayName: 'Google Contacts', capabilities: ['contacts.read'], tracksTickets: false });
      expect(new URL(model.connectHref!, 'https://operator.test').searchParams.get('plugin')).toMatch(/^provider:/);

      const urls: URL[] = [];
      const hostFetch: HostFetch = async ({ source, request }) => {
        expect(source).toBe('owned');
        const url = new URL(request.url); urls.push(url);
        expect(url.host).toBe('people.googleapis.com');
        return jsonResponse(200, url.searchParams.get('pageToken')
          ? { connections: [{ resourceName: 'people/c2', etag: 'e2', names: [{ displayName: 'Bea' }] }] }
          : { connections: [{ resourceName: 'people/c1', etag: 'e1', names: [{ displayName: 'Ada' }], emailAddresses: [{ value: 'ada@example.test' }] }], nextPageToken: 'next' });
      };
      const first = await entry.adapter!.syncPage({ source: 'owned', config: {}, cursor: null, mode: 'incremental' }, { fetch: hostFetch });
      expect(first).toMatchObject({ hasMore: true, records: [{ datatype: 'contact', nativeId: 'people/c1', event: 'contact-changed', version: 'e1',
        payload: { id: 'people/c1', displayName: 'Ada', emails: ['ada@example.test'] } }] });
      const second = await entry.adapter!.syncPage({ source: 'owned', config: {}, cursor: first.nextCursor ?? null, mode: 'incremental' }, { fetch: hostFetch });
      expect(second).toMatchObject({ hasMore: false, nextCursor: null, records: [{ nativeId: 'people/c2', version: 'e2' }] });
      expect(urls.map((url) => url.searchParams.get('pageToken'))).toEqual([null, 'next']);

      const read = await entry.adapter!.invoke({ source: 'owned', config: {}, capability: 'contacts.read', args: {} }, { fetch: hostFetch });
      expect(read).toMatchObject({ contacts: [{ resourceName: 'people/c1' }], nextPageToken: 'next' });
      expect(urls.at(-1)!.searchParams.get('pageSize')).toBe('1');
      await expect(entry.adapter!.invoke({ source: 'owned', config: {}, capability: 'social.post', args: {} }, { fetch: hostFetch }))
        .rejects.toThrow(/capability_unsupported/);
      expect(urls).toHaveLength(3);
    } finally { expect(await stopDaemonProvider('google-contacts')).toBe(true); registry.unregisterPlugin('google-contacts'); }
    expect(registry.get('contacts')).toBeUndefined();
  }, 60_000);
});
