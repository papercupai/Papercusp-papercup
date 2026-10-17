import { createRequire } from 'node:module';
import { readFileSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { loadPlugins } from '@papercusp/plugin-loader';
import { jsonResponse, runProviderConformance, validateProviderDescriptor, type HostFetch, type ProviderAdapter } from '@papercusp/plugin-sdk';
import { installPluginFromCupboardCore, InstallPluginError, type InstallPluginManifestReview } from '../../cupboard/install-plugin-core';
import { registerPluginProviders } from '../../plugin-host-runtime';
import { createProviderRegistry, verifiedProviderForCapability } from '../../integrations/provider-registry';
import { stopDaemonProvider } from '../../integrations/daemon-provider';
import { fetchProviderIdentity } from '../../integrations/provider-identity';
import { summarizeIntegrationProvider } from '../../integrations/ticket-integrations';
import { validateDatatypePayload } from '../../datatype-payload-validation';
import { SOCIAL_POST_SCHEMA_FIXTURE } from '../../external-triggers/social/social-post-schema.fixture';

const directory = new URL('../../../../../libs/papercusp/plugins/linkedin-company/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('papercusp.json', directory), 'utf8'));
const source = readFileSync(new URL('index.cjs', directory), 'utf8');
const actual = createRequire(import.meta.url)(new URL('index.cjs', directory).pathname).providerAdapter as ProviderAdapter;
const author = 'urn:li:organization:123';
const config = { organizationId: '123' };
const postArgs = { destination: author, text: 'Company update' };
const created = 'urn:li:share:999';
const api = 'https://api.linkedin.com/rest/posts';
const nextUrl = (start = 100) => `${api}?${new URLSearchParams({ q: 'author', author, count: '100', start: String(start), sortBy: 'LAST_MODIFIED' })}`;

// Offline future-approved control: only the fixture manifest changes. The shipped
// package's wall and all caller config/arguments remain untouched.
function approvedFixture(): ProviderAdapter {
  const fixture = structuredClone(manifest);
  delete fixture.provider.verification.blockedOn;
  const module = { exports: {} as { providerAdapter: ProviderAdapter } };
  runInNewContext(source, { module, URL, URLSearchParams, require: (path: string) => {
    if (path !== './papercusp.json') throw new Error('unexpected standalone dependency');
    return fixture;
  } });
  return module.exports.providerAdapter;
}
function row(id: number, at = 1760000000000 + id) {
  return { id: `urn:li:share:${id}`, author, commentary: `Post ${id}`, lifecycleState: 'PUBLISHED', lastModifiedAt: at };
}
function world() {
  const rows = [row(3), row(2), row(1)];
  const calls: Parameters<HostFetch>[0][] = [];
  const fetch: HostFetch = async (input) => {
    calls.push(input);
    if (input.request.method === 'POST') return jsonResponse(201, {}, { 'X-RestLi-Id': created });
    const start = Number(new URL(input.request.url).searchParams.get('start'));
    return jsonResponse(200, { elements: start === 0 ? rows.slice(0, 2) : rows.slice(2),
      paging: { start, count: 100, links: start === 0 ? [{ rel: 'next', href: nextUrl() }] : [] } });
  };
  return { rows, calls, fetch };
}
async function drain(adapter: ProviderAdapter, fetch: HostFetch, cursor: string | null = null) {
  const records = []; const cursors = [];
  for (let n = 0; n < 5; n++) {
    const page = await adapter.syncPage({ source: 'company-source', config, cursor, mode: cursor ? 'incremental' : 'backfill' }, { fetch });
    records.push(...page.records); cursor = page.nextCursor; cursors.push(cursor);
    if (!page.hasMore) return { records, cursor, cursors };
  }
  throw new Error('fixture failed to complete');
}

describe('LinkedIn company-page package (P-022)', () => {
  it('declares the exact independent registration, Page resource and honest partner wall', async () => {
    const d = await actual.describe();
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d.id).toBe('linkedin-company');
    expect(d.verification?.blockedOn).toMatch(/partner approval/);
    expect(d.oauth).toMatchObject({ clientRegistrationRef: 'linkedin-company', refreshPolicy: 'reauthorize',
      scopes: ['openid', 'profile', 'r_organization_social', 'w_organization_social'],
      identity: { url: 'https://api.linkedin.com/v2/userinfo', idField: 'sub' } });
    expect(d.configSchema?.required).toEqual(['organizationId']);
    expect(d.defaultDestinations).toBeUndefined();
    const personal = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/linkedin/papercusp.json').provider;
    expect(personal.oauth.clientRegistrationRef).toBe('linkedin');
    expect(personal.oauth.scopes).toEqual(['openid', 'profile', 'w_member_social']);
    expect(personal.verification.blockedOn).toBeUndefined();
  });

  it('SPEC-P-022 refuses the shipped package by name before identity, reads or organization writes', async () => {
    const fetch = vi.fn();
    await expect(actual.syncPage({ source: 's', config, cursor: null, mode: 'backfill' }, { fetch })).rejects.toThrow('linkedin-company:partner_approval_required');
    for (const additions of [{}, { approved: true, partnerApproved: true, accessToken: 'not-an-approval' }]) {
      await expect(actual.invoke({ source: 's', config: { ...config, ...additions }, capability: 'social.post', args: { ...postArgs, ...additions } }, { fetch })).rejects.toMatchObject({ kind: 'auth', message: 'linkedin-company:partner_approval_required' });
    }
    await expect(fetchProviderIdentity(await actual.describe(), 'fixture-secret', 'company', fetch)).rejects.toThrow(/owner.blocked/);
    expect(fetch).not.toHaveBeenCalled();
    expect(manifest.provider.verification.blockedOn).toMatch(/pending/);
  });

  it('uses the shared identity seam against an explicitly provisioned offline OIDC control', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ sub: 'connected-member', name: 'Fixture member' }));
    expect(await fetchProviderIdentity(await approvedFixture().describe(), 'fixture-secret', 'company', fetch)).toEqual({ providerAccountId: 'connected-member', displayName: 'Fixture member' });
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.linkedin.com/v2/userinfo');
  });

  it('follows a short page with a next link, resumes and emits only new post versions on the next scan', async () => {
    const adapter = approvedFixture(), w = world();
    const all = await drain(adapter, w.fetch);
    expect(all.records.map((r) => r.nativeId)).toEqual(['urn:li:share:3', 'urn:li:share:2', 'urn:li:share:1']);
    expect(all.records[0]).toMatchObject({ datatype: 'social-post', event: 'post', version: `urn:li:share:3@${w.rows[0].lastModifiedAt}`,
      payload: { platform: 'linkedin-company', author, text: 'Post 3' } });
    expect((await drain(adapter, world().fetch, all.cursors[0])).records).toEqual(all.records.slice(2));
    expect((await drain(adapter, w.fetch, all.cursor)).records).toEqual([]);
    w.rows[0].lastModifiedAt++;
    expect((await drain(adapter, w.fetch, all.cursor)).records).toHaveLength(1);
    expect(w.calls.every((c) => c.source === 'company-source' && !c.request.headers?.authorization)).toBe(true);
    expect(w.calls[0].request.headers).toMatchObject({ 'LinkedIn-Version': '202609', 'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'FINDER' });
  });

  it('keeps offset shifts recoverable by rescanning observed versions instead of skipping to a timestamp', async () => {
    const adapter = approvedFixture(), w = world();
    const first = await adapter.syncPage({ source: 'company-source', config, cursor: null, mode: 'backfill' }, w);
    w.rows.shift(); // A deletion shifts the unobserved final item into the prior offset.
    const finished = await drain(adapter, w.fetch, first.nextCursor);
    expect(finished.records).toEqual([]);
    expect((await drain(adapter, w.fetch, finished.cursor)).records.map((r) => r.nativeId)).toEqual(['urn:li:share:1']);
  });

  it('refuses malformed cursors, foreign authors, nonprogressing/off-host and substituted next links', async () => {
    const adapter = approvedFixture();
    await expect(drain(adapter, world().fetch, '{}')).rejects.toMatchObject({ kind: 'cursor-expired' });
    for (const href of [nextUrl(0), nextUrl().replace('api.linkedin.com', 'evil.example'),
      nextUrl().replace('https:', 'http:'), nextUrl().replace('api.linkedin.com', 'user:password@api.linkedin.com'),
      nextUrl() + '#fragment', nextUrl().replace('123', '456'), nextUrl() + '&q=other',
      nextUrl().replace('/rest/posts?', '/rest/organizationAcls?')]) {
      await expect(drain(adapter, async () => jsonResponse(200, { elements: [], paging: { links: [{ rel: 'next', href }] } }))).rejects.toMatchObject({ kind: 'cursor-expired' });
    }
    await expect(drain(adapter, async () => jsonResponse(200, { elements: [{ ...row(1), author: 'urn:li:person:other' }], paging: { links: [] } }))).rejects.toThrow('malformed_organization_post');
    await expect(drain(adapter, async () => jsonResponse(200, { elements: [], paging: {} }))).rejects.toThrow('malformed_paging');
  });

  it('posts once to the configured organization with the pinned version and a server-issued URN', async () => {
    const adapter = approvedFixture(), w = world();
    expect(await adapter.invoke({ source: 'company-source', config, capability: 'social.post', args: postArgs }, w)).toMatchObject({ externalId: created });
    expect(w.calls).toHaveLength(1);
    expect(JSON.parse(w.calls[0].request.body!)).toEqual({ author, commentary: 'Company update', visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false });
    const fetch = vi.fn();
    for (const args of [{ ...postArgs, destination: 'urn:li:person:owner' }, { ...postArgs, destination: '456' }, { ...postArgs, text: '' }, { ...postArgs, text: 'a'.repeat(3001) }, { ...postArgs, media: ['image'] }, { ...postArgs, visibility: 'followers' }]) {
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args }, { fetch })).rejects.toThrow();
    }
    await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args: postArgs }, { fetch })).rejects.toThrow('capability_unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves authentication, throttling and ambiguous writes without retrying or leaking provider bodies', async () => {
    const adapter = approvedFixture();
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limited'], [503, 'transient']] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, { message: 'must-not-leak' }, { 'retry-after': '17' }));
      await expect(adapter.syncPage({ source: 's', config, cursor: null, mode: 'backfill' }, { fetch })).rejects.toMatchObject({ kind });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    for (const status of [201, 409, 500]) {
      const fetch = vi.fn(async () => jsonResponse(status, {}));
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch })).rejects.toMatchObject({ kind: 'transient', retrySafe: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => { throw new Error('must-not-leak'); });
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch })).rejects.toMatchObject({ message: 'linkedin-company:post_ambiguous_do_not_retry', retrySafe: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes the unchanged SDK conformance kit with a hypothetical approved offline grant', async () => {
    const report = await runProviderConformance({ adapter: approvedFixture(), config, source: 'company-source', createFetch: () => world().fetch,
      validatePayload: (_datatype, payload) => {
        const result = validateDatatypePayload(SOCIAL_POST_SCHEMA_FIXTURE, payload);
        return result.ok ? null : result.errors.join('; ');
      },
      invocations: [{ capability: 'social.post', args: postArgs }] });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('refuses a company package missing its daemon declaration before installation effects', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'linkedin-company-refused-'));
    const globalPluginsDir = join(root, 'plugins');
    const grant = vi.fn(), invalidateHost = vi.fn();
    try {
      await expect(installPluginFromCupboardCore({ githubUrl: 'https://github.com/papercusp/plugins', listingRef: 'linkedin-company' }, {
        cloneRepo: async (_url, dest) => {
          await fs.cp(directory, dest, { recursive: true });
          const fixture = structuredClone(manifest);
          delete fixture.runtime;
          await fs.writeFile(join(dest, 'papercusp.json'), JSON.stringify(fixture));
        },
        globalPluginsDir: () => globalPluginsDir, tmpDir: () => root, grant, invalidateHost,
      })).rejects.toMatchObject({ code: 'provider_runtime_not_sandboxed' });
      expect(await fs.readdir(globalPluginsDir).catch(() => [])).toEqual([]);
      expect(grant).not.toHaveBeenCalled();
      expect(invalidateHost).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('installs and loads the shipped standalone daemon, then refuses the actual approval wall before network access', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'linkedin-company-install-'));
    const globalPluginsDir = join(root, 'plugins');
    const deps = { cloneRepo: async (_url: string, dest: string) => fs.cp(directory, dest, { recursive: true }),
      globalPluginsDir: () => globalPluginsDir, tmpDir: () => root, grant: async () => {}, invalidateHost: () => {} };
    const input = { githubUrl: 'https://github.com/papercusp/plugins', listingRef: 'linkedin-company', harnessSlug: 'papercusp' };
    let review: InstallPluginManifestReview | undefined;
    try { await installPluginFromCupboardCore(input, deps); }
    catch (error) {
      expect(error).toBeInstanceOf(InstallPluginError);
      expect(error).toMatchObject({ code: 'provider_install_consent_required' });
      review = (error as InstallPluginError).data?.review as InstallPluginManifestReview;
    }
    expect(review).toBeDefined();
    try {
      await installPluginFromCupboardCore({ ...input, acceptCapabilities: true, expectedReview: review }, deps);
      const loaded = await loadPlugins({ projectDir: root, harnessSlugs: [], globalPluginsDir });
      expect(loaded.errors).toEqual([]);
      const registry = createProviderRegistry();
      expect(await registerPluginProviders(loaded.loaded, () => {}, registry)).toEqual(['linkedin-company']);
      const entry = registry.get('linkedin-company')!;
      expect(entry.runtime).toBe('daemon');
      expect(await entry.adapter!.describe()).toMatchObject({ id: 'linkedin-company', verification: { blockedOn: manifest.provider.verification.blockedOn } });
      expect(() => verifiedProviderForCapability(registry, 'linkedin-company', 'social.post')).toThrow(/owner.blocked/);
      const fetch = vi.fn();
      await expect(entry.adapter!.invoke({ source: 's', config, capability: 'social.post', args: postArgs }, { fetch })).rejects.toThrow('partner_approval_required');
      expect(fetch).not.toHaveBeenCalled();
      const model = summarizeIntegrationProvider(entry, [], { ref: 'linkedin-company', configured: false,
        clientId: null, hasClientSecret: false, redirectUri: 'https://operator.example/api/oauth/callback', savedAt: null });
      expect(model.requiredConfig).toEqual(['organizationId']);
      expect(model.displayName).toBe('LinkedIn company page');
    } finally { await stopDaemonProvider('linkedin-company'); await fs.rm(root, { recursive: true, force: true }); }
  });
});
