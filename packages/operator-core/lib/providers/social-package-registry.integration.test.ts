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
import { createProviderRegistry, verifiedProviderForCapability } from '../integrations/provider-registry';
import { summarizeIntegrationProvider } from '../integrations/ticket-integrations';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = join(tmpdir(), `social-package-install-${process.pid}-${Date.now()}`);
afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

const PACKAGES = ['facebook-pages', 'instagram', 'x', 'threads', 'tiktok', 'linkedin', 'youtube', 'mastodon', 'reddit', 'bluesky'];
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
      oauthScopes: [...(manifest.provider.oauth?.scopes ?? [])].sort(),
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
    // Evidence must survive Cupboard review, installation and the daemon boundary.
    // Installation and fake calls do not remove the owner's live-account prerequisites.
    expect(entry.descriptor.verification).toEqual(manifest.provider.verification);
    expect(entry.descriptor.verification?.verifiedAt).toMatch(/^2026-10-1[56]$/);
    expect(entry.descriptor.verification?.sources.length).toBeGreaterThan(0);
    expect(Object.keys(entry.descriptor.verification!.capabilities!).sort()).toEqual([...entry.descriptor.capabilities].sort());
    for (const capability of entry.descriptor.capabilities) {
      if (id === 'x') expect(() => verifiedProviderForCapability(registry, providerId, capability)).toThrow(/owner-blocked.*\$25/);
      else expect(verifiedProviderForCapability(registry, providerId, capability)).toBe(entry);
    }
    for (const capability of ['social.post', 'social.reply', 'social.delete']) {
      if (!entry.descriptor.capabilities.includes(capability)) {
        expect(() => verifiedProviderForCapability(registry, providerId, capability)).toThrow(/capability-unsupported/);
      }
    }
    expect(await entry.adapter!.describe()).toEqual(entry.descriptor);
    const model = summarizeIntegrationProvider(entry, [], id === 'bluesky' ? null : {
      ref: manifest.provider.oauth.clientRegistrationRef, configured: false, clientId: null, hasClientSecret: false,
      redirectUri: 'https://operator.example/api/oauth/callback', savedAt: null,
    });
    expect(model).toMatchObject({ id: providerId, tracksTickets: false });
    expect(model.capabilities).toEqual(entry.descriptor.capabilities);
    expect(model.displayName).toBe(({ 'facebook-pages': 'Facebook Pages', x: 'X', instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', linkedin: 'LinkedIn', youtube: 'YouTube', mastodon: 'Mastodon', reddit: 'Reddit', bluesky: 'Bluesky' })[id]);
    expect(model.requiredConfig).toEqual(['mastodon', 'reddit', 'bluesky'].includes(id) ? [] : id === 'x' ? ['userId', 'username'] : [id === 'facebook-pages' ? 'pageId' : id === 'threads' ? 'userId' : id === 'tiktok' ? 'openId' : id === 'linkedin' ? 'memberId' : id === 'youtube' ? 'channelId' : 'igUserId']);
    if (id === 'bluesky') {
      expect(model.connectHref).toBeNull(); expect(model.oauthClient).toBeNull(); expect(model.appRegistration).toBeNull();
      expect(entry.descriptor.setup?.credentials?.map((field) => field.key)).toEqual(['identifier', 'app_password']);
      expect(entry.descriptor.setup?.session?.identity.idField).toBe('did');
    } else {
    expect(new URL(model.connectHref!, 'https://operator.example').searchParams.get('plugin')).toBe(`provider:${id === 'youtube' ? 'google' : providerId}`);
    expect(model.appRegistration?.createUrl).toBe(id === 'reddit' ? 'https://www.reddit.com/prefs/apps' : id === 'mastodon' ? '/settings/applications/new' : id === 'x' ? 'https://console.x.com/' : id === 'tiktok' ? 'https://developers.tiktok.com/apps/' : id === 'linkedin' ? 'https://www.linkedin.com/developers/apps' : id === 'youtube' ? 'https://console.cloud.google.com/apis/credentials' : 'https://developers.facebook.com/apps/');
    expect(model.oauthClient).toMatchObject({ configured: false, secretRequired: !['x', 'youtube'].includes(id) });
    }
    expect(registry.forDatatype('social-post', 'social.post').map((e) => e.descriptor.id)).toEqual(['tiktok', 'youtube'].includes(id) ? [] : [providerId]);
    expect(registry.forDatatype('social-post').map((e) => e.descriptor.id)).toEqual([providerId]);
    // These calls cross the installed process boundary and return through host.fetch;
    // a descriptor-only registration cannot satisfy them. No vendor is contacted.
    const config = id === 'bluesky' ? { accountId: 'did:plc:owner' } : id === 'reddit' ? { accountLabel: 'fixture-user' } : id === 'mastodon' ? { connectionOrigin: 'https://mastodon.social', connectionAccountId: '42' } : id === 'x' ? { userId: '42', username: 'owner' } : id === 'facebook-pages' ? { pageId: '42' } : id === 'threads' ? { userId: '42' } : id === 'tiktok' ? { openId: 'owner' } : id === 'linkedin' ? { memberId: 'owner' } : id === 'youtube' ? { channelId: 'UC42' } : { igUserId: '42' };
    const fetched: unknown[] = [];
    const page = await entry.adapter!.syncPage({ source: 'installed-source', cursor: null, mode: 'incremental', config }, {
      fetch: async (request) => { fetched.push(request); return { status: 200, headers: {}, body: JSON.stringify(id === 'bluesky' ? { notifications: [], feed: [] } : id === 'reddit' ? { kind: 'Listing', data: { children: [], after: null } } : id === 'mastodon' ? [] : id === 'tiktok' ? { data: { videos: [], has_more: false }, error: { code: 'ok' } } : id === 'youtube' ? { items: [] } : { data: [], meta: { result_count: 0 } }), bodyEncoding: 'utf8' as const }; },
    });
    if (id === 'linkedin') {
      expect(fetched).toEqual([]);
      expect(await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.post', args: { destination: 'owner', text: 'installed test' } }, {
        fetch: async (request) => { fetched.push(request); return { status: 201, headers: { 'x-restli-id': 'urn:li:share:123' }, body: '{}', bodyEncoding: 'utf8' as const }; },
      })).toMatchObject({ externalId: 'urn:li:share:123' });
    }
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'installed-source' })]));
    expect(page.records).toEqual([]);
    if (['youtube', 'instagram', 'threads'].includes(id)) {
      const writes: Array<{ url: string; body?: string }> = [];
      const payload = { replyToId: '101', subjectOwnerId: '42', canReply: true };
      const result = await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.reply', args: {
        text: 'installed reply', target: { platform: providerId, externalId: '202', payload },
      } }, {
        fetch: async ({ request }) => {
          writes.push(request);
          const path = new URL(request.url).pathname;
          return { status: 200, headers: {}, bodyEncoding: 'utf8' as const,
            body: JSON.stringify(id === 'threads' && path.endsWith('/42/threads') ? { id: 'container-1' }
              : id === 'threads' && path.endsWith('/container-1') ? { status: 'FINISHED' } : { id: '303' }) };
        },
      });
      expect(result).toMatchObject({ externalId: '303' });
      if (id === 'youtube') expect(JSON.parse(writes[0].body!).snippet.parentId).toBe('101');
      else if (id === 'instagram') expect(new URL(writes[0].url).pathname).toBe('/v26.0/101/replies');
      else expect(new URLSearchParams(writes[0].body).get('reply_to_id')).toBe('202');
      let calls = 0; let refused: unknown;
      try { await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.reply', args: {
        text: 'refused reply', target: { platform: providerId, externalId: '202', payload: { ...payload, canReply: false, hidden: true, subjectOwnerId: 'another' } },
      } }, { fetch: async () => { calls++; return { status: 200, headers: {}, bodyEncoding: 'utf8', body: '{}' }; } }); }
      catch (error) { refused = error; }
      expect(refused).toBeDefined();
      expect(calls).toBe(0);
    }
    let failure: unknown;
    try {
      const host = { fetch: async () => ({ status: 429, headers: { 'retry-after': '37' }, body: '{}', bodyEncoding: 'utf8' as const }) };
      if (id === 'linkedin') await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.post', args: { destination: 'owner', text: 'test' } }, host);
      else await entry.adapter!.syncPage({ source: 'installed-source', cursor: null, mode: 'incremental', config }, host);
    } catch (error) { failure = error; }
    expect(providerSyncErrorOf(failure)).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 37 });
    if (['facebook-pages', 'x', 'reddit', 'bluesky'].includes(id)) {
      const externalId = id === 'reddit' ? 't1_parent' : id === 'bluesky' ? 'at://did:plc:other/app.bsky.feed.post/parent' : '202';
      const payload = id === 'bluesky' ? { parentCid: 'parent-cid' } : { id: '999', replyToId: '999' };
      const writes: Array<{ url: string; body?: string }> = [];
      const result = await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.reply', args: {
        text: 'installed reply', idempotencyKey: 'installed-key', target: { platform: providerId, externalId, payload },
      } }, { fetch: async ({ request }) => {
        writes.push(request);
        const body = id === 'bluesky' ? { uri: `at://did:plc:owner/app.bsky.feed.post/${JSON.parse(request.body!).rkey}`, cid: 'created-cid' }
          : id === 'reddit' ? { json: { errors: [], data: { things: [{ data: { name: 't1_new', permalink: '/r/test/comments/post/title/new' } }] } } }
          : id === 'x' ? { data: { id: '303' } } : { id: '303' };
        return { status: 200, headers: {}, bodyEncoding: 'utf8' as const, body: JSON.stringify(body) };
      } });
      expect(result).toBeDefined(); expect(writes).toHaveLength(1);
      if (id === 'facebook-pages') expect(new URL(writes[0].url).pathname).toBe('/v23.0/202/comments');
      else if (id === 'x') expect(JSON.parse(writes[0].body!).reply.in_reply_to_tweet_id).toBe('202');
      else if (id === 'reddit') expect(new URLSearchParams(writes[0].body).get('thing_id')).toBe('t1_parent');
      else expect(JSON.parse(writes[0].body!).record.reply).toEqual({ parent: { uri: externalId, cid: 'parent-cid' }, root: { uri: externalId, cid: 'parent-cid' } });
      let calls = 0; let refused: unknown;
      const invalidId = id === 'reddit' ? 't4_message' : id === 'bluesky' ? externalId : '../other';
      try { await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.reply', args: {
        text: 'refused reply', idempotencyKey: 'refused-key', target: { platform: providerId, externalId: invalidId, payload: {} },
      } }, { fetch: async () => { calls++; return { status: 200, headers: {}, bodyEncoding: 'utf8', body: '{}' }; } }); }
      catch (error) { refused = error; }
      expect(refused).toBeDefined(); expect(calls).toBe(0);
    }
    if (id === 'mastodon') {
      expect(model.oauthClient).toMatchObject({ instanceRequired: true, configured: false });
      const target = { platform: 'mastodon', externalId: 'https://mastodon.social/users/owner/statuses/local', payload: { instanceHost: 'mastodon.social', statusId: 'local' } };
      const calls: Array<{ url: string; method?: string; body?: string; headers?: Record<string, string> }> = [];
      const actualHost = { fetch: async ({ request }: { request: typeof calls[number] }) => {
        calls.push(request); return { status: 200, headers: {}, bodyEncoding: 'utf8' as const,
          body: JSON.stringify({ id: 'local', uri: 'https://mastodon.social/users/owner/statuses/local', account: { id: '42' } }) };
      } };
      expect(await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.reply', args: {
        target, text: 'one reply', visibility: 'followers', idempotencyKey: 'host-key',
      } }, actualHost)).toMatchObject({ externalId: 'https://mastodon.social/users/owner/statuses/local' });
      expect(calls[0].headers?.['Idempotency-Key']).toBe('host-key');
      expect(new URLSearchParams(calls[0].body).get('visibility')).toBe('private');
      expect(new URLSearchParams(calls[0].body).get('in_reply_to_id')).toBe('local');
      expect(await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.delete', args: { target } }, actualHost)).toEqual({ deleted: true });
      expect(calls.map((request) => request.method)).toEqual(['POST', 'GET', 'DELETE']);
      let refused: unknown;
      try { await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.delete', args: { target } }, {
        fetch: async () => ({ status: 200, headers: {}, bodyEncoding: 'utf8', body: JSON.stringify({ id: 'local', account: { id: 'someone-else' } }) }),
      }); } catch (error) { refused = error; }
      expect(providerSyncErrorOf(refused)).toMatchObject({ kind: 'auth' });
    }
    if (id === 'threads') {
      let publications = 0; let statusReads = 0;
      let ambiguous: unknown;
      try {
        await entry.adapter!.invoke({ source: 'installed-source', config, capability: 'social.post', args: { destination: '42', text: 'one write' } }, {
          fetch: async ({ request }) => {
            const path = new URL(request.url).pathname;
            const body = path.endsWith('/threads_publish') ? (publications++, {})
              : path.endsWith('/container-1') ? { status: ++statusReads === 1 ? 'FINISHED' : 'PUBLISHED' }
              : { id: 'container-1' };
            return { status: path.endsWith('/threads_publish') ? 503 : 200, headers: {}, body: JSON.stringify(body), bodyEncoding: 'utf8' as const };
          },
        });
      } catch (error) { ambiguous = error; }
      expect(ambiguous).toMatchObject({ data: { kind: 'transient', containerId: 'container-1', observedStatus: 'PUBLISHED', retrySafe: false } });
      expect(publications).toBe(1);
    }
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
