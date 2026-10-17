import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { validateProviderDeclaration } from '@papercusp/plugin-sdk';
import { createProviderRegistry, ProviderRegistrationError, verifiedProviderForCapability } from './provider-registry';
import { createHostFetch, HostFetchError } from './host-fetch';

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: 'outlook-mail',
    contractVersion: 1,
    datatypes: ['email-message'],
    capabilities: ['mail.read', 'mail.draft'],
    egressHosts: ['graph.microsoft.com', 'login.microsoftonline.com'],
    oauth: {
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['Mail.Read'],
      pkce: true,
    },
    ...overrides,
  };
}

function adapter(d: ProviderDescriptor): ProviderAdapter {
  return {
    describe: () => d,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async () => ({ ok: true }),
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe(code);
}

describe('provider descriptor validation', () => {
  it('accepts a well-formed descriptor', () => {
    expect(validateProviderDeclaration({ provider: descriptor() })).toEqual([]);
    expect(validateProviderDeclaration({})).toEqual([]);
  });

  it('refuses an OAuth endpoint outside the declared egress hosts', () => {
    const issues = validateProviderDeclaration({ provider: descriptor({ egressHosts: ['graph.microsoft.com'] }) });
    expect(issues.some((i) => i.includes('login.microsoftonline.com'))).toBe(true);
  });

  it('refuses secrets in the OAuth descriptor and malformed capability ids', () => {
    const d = descriptor({ capabilities: ['send-mail'] });
    (d.oauth as unknown as Record<string, unknown>).clientSecret = 'x';
    const issues = validateProviderDeclaration({ provider: d });
    expect(issues.some((i) => i.includes('clientSecret'))).toBe(true);
    expect(issues.some((i) => i.includes('send-mail'))).toBe(true);
  });
});

describe('provider registry', () => {
  it('uses the installed manifest evidence, refuses unloads, and re-evaluates a replacement capability set', async () => {
    const registry = createProviderRegistry();
    const d = descriptor({ id: 'example-social', datatypes: ['social-post'], capabilities: ['social.reply'],
      verification: { verifiedAt: '2026-10-16', sources: ['https://example.com/api'], capabilities: { 'social.reply': '2026-10-16' } } });
    expect(() => verifiedProviderForCapability(registry, d.id, 'social.reply')).toThrow(/not-installed/);
    // The adapter's stale metadata cannot replace the installed manifest's evidence.
    await registry.register({ descriptor: d, adapter: adapter({ ...d, verification: undefined }), pluginName: 'example' });
    expect(verifiedProviderForCapability(registry, d.id, 'social.reply').descriptor).toBe(d);
    registry.unregisterPlugin('example');
    expect(() => verifiedProviderForCapability(registry, d.id, 'social.reply')).toThrow(/not-installed/);
    const replacement = { ...d, capabilities: ['social.post'], verification: undefined };
    await registry.register({ descriptor: replacement, adapter: adapter(replacement), pluginName: 'replacement' });
    expect(() => verifiedProviderForCapability(registry, d.id, 'social.reply')).toThrow(/capability-unsupported/);
    expect(() => verifiedProviderForCapability(registry, d.id, 'social.post')).toThrow(/unverified/);
  });

  it('refuses invalid evidence at registration before the package is described', async () => {
    const registry = createProviderRegistry();
    const d = descriptor({ verification: { verifiedAt: '2026-10-16', sources: [], capabilities: { 'social.post': '2026-10-16' } } });
    const describe = vi.fn(() => d);
    await expectCode(registry.register({ descriptor: d, adapter: { ...adapter(d), describe }, pluginName: 'invalid' }), 'invalid-descriptor');
    expect(describe).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });

  it('registers a provider and finds it by datatype and capability', async () => {
    const registry = createProviderRegistry();
    const d = descriptor();
    await registry.register({ descriptor: d, adapter: adapter(d), pluginName: 'outlook' });
    expect(registry.get('outlook-mail')?.pluginName).toBe('outlook');
    expect(registry.forDatatype('email-message', 'mail.draft').map((p) => p.descriptor.id)).toEqual(['outlook-mail']);
    expect(registry.forDatatype('email-message', 'mail.send')).toEqual([]);
    expect(registry.forDatatype('calendar-event')).toEqual([]);
  });

  it('refuses a duplicate provider id with a named error', async () => {
    const registry = createProviderRegistry();
    const d = descriptor();
    await registry.register({ descriptor: d, adapter: adapter(d), pluginName: 'first' });
    await expectCode(registry.register({ descriptor: d, adapter: adapter(d), pluginName: 'second' }), 'duplicate-provider');
    expect(registry.get('outlook-mail')?.pluginName).toBe('first');
  });

  it('refuses an unsupported contract version', async () => {
    const registry = createProviderRegistry();
    const d = descriptor({ contractVersion: 2 });
    await expectCode(registry.register({ descriptor: d, adapter: adapter(d), pluginName: 'p' }), 'unsupported-contract-version');
  });

  it('refuses an invalid descriptor, an incomplete adapter and a describe() mismatch', async () => {
    const registry = createProviderRegistry();
    const bad = descriptor({ datatypes: [] });
    await expectCode(registry.register({ descriptor: bad, adapter: adapter(bad), pluginName: 'p' }), 'invalid-descriptor');
    const d = descriptor();
    await expectCode(registry.register({ descriptor: d, adapter: { describe: () => d }, pluginName: 'p' }), 'invalid-adapter');
    await expectCode(
      registry.register({ descriptor: d, adapter: adapter(descriptor({ id: 'other-mail' })), pluginName: 'p' }),
      'descriptor-mismatch',
    );
    expect(registry.list()).toEqual([]);
  });

  it('unregisters every provider owned by an unloaded plugin', async () => {
    const registry = createProviderRegistry();
    const a = descriptor();
    const b = descriptor({ id: 'outlook-calendar', datatypes: ['calendar-event'], capabilities: ['calendar.read'] });
    await registry.register({ descriptor: a, adapter: adapter(a), pluginName: 'outlook' });
    await registry.register({ descriptor: b, adapter: adapter(b), pluginName: 'outlook' });
    expect(registry.unregisterPlugin('outlook').sort()).toEqual(['outlook-calendar', 'outlook-mail']);
    expect(registry.list()).toEqual([]);
    // A re-load after unload registers cleanly.
    await registry.register({ descriptor: a, adapter: adapter(a), pluginName: 'outlook' });
    expect(registry.get('outlook-mail')).toBeDefined();
  });
});

describe('host.fetch', () => {
  it('uses host-held source identification over caller headers and refuses missing required identification before credentials or network', async () => {
    const registry = createProviderRegistry();
    const d = descriptor(); d.oauth!.userAgentRequired = true;
    await registry.register({ descriptor: d, adapter: adapter(d), pluginName: 'test' });
    const accessToken = vi.fn(async () => 'host-token');
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => Response.json({}));
    const host = createHostFetch(d.id, { registry, accessToken, fetchImpl,
      resolveSource: async (sourceId) => ({ sourceId, providerId: d.id }),
      userAgent: async (source) => source.sourceId === 'missing' ? null : `desktop:${source.sourceId}:1.0`,
    });
    await expect(host({ source: 'missing', request: { url: 'https://graph.microsoft.com/me', headers: { 'user-agent': 'forged' } } }))
      .rejects.toMatchObject({ code: 'user-agent-required' });
    expect(accessToken).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    for (const source of ['first-app', 'second-app']) {
      await host({ source, request: { url: 'https://graph.microsoft.com/me', headers: { 'User-Agent': 'forged' } } });
      expect(new Headers(fetchImpl.mock.calls.at(-1)![1]?.headers).get('user-agent')).toBe(`desktop:${source}:1.0`);
    }
  });
  it('binds instance requests to persisted source config before reading credentials or fetching', async () => {
    const registry = createProviderRegistry();
    const d = descriptor({ egressHosts: [], oauth: { instance: true, authorizeUrl: '/oauth/authorize', tokenUrl: '/oauth/token', scopes: ['read'] } });
    await registry.register({ descriptor: d, adapter: adapter(d), pluginName: 'instance-provider' });
    const accessToken = vi.fn(async (source: { sourceId: string }) => `${source.sourceId}-secret`);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const hostFetch = createHostFetch(d.id, { registry, accessToken, fetchImpl,
      resolveSource: async (sourceId) => ({ sourceId, providerId: d.id, config: sourceId === 'unbound' ? {} : { connectionOrigin: `https://${sourceId}.example.com` } }),
    });
    for (const [source, url] of [['first', 'https://second.example.com/api'], ['first', 'https://first.example.com:8443/api'], ['unbound', 'https://first.example.com/api']]) {
      await expect(hostFetch({ source, request: { url } })).rejects.toMatchObject({ code: 'egress-denied' });
    }
    expect(accessToken).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    await hostFetch({ source: 'second', request: { url: 'https://second.example.com/api' } });
    expect(accessToken).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls as unknown as [URL, RequestInit][])[0]![1];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer second-secret');
    expect(init.redirect).toBe('manual');
  });
  async function setup() {
    const registry = createProviderRegistry();
    const d = descriptor();
    await registry.register({ descriptor: d, adapter: adapter(d), pluginName: 'outlook' });
    const g = descriptor({ id: 'gmail', egressHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com'], oauth: undefined });
    await registry.register({ descriptor: g, adapter: adapter(g), pluginName: 'google' });
    const sources: Record<string, { sourceId: string; providerId: string }> = {
      'src-outlook-a': { sourceId: 'src-outlook-a', providerId: 'outlook-mail' },
      'src-outlook-b': { sourceId: 'src-outlook-b', providerId: 'outlook-mail' },
      'src-gmail': { sourceId: 'src-gmail', providerId: 'gmail' },
    };
    const tokens: Record<string, string> = { 'src-outlook-a': 'tok-a', 'src-outlook-b': 'tok-b', 'src-gmail': 'tok-g' };
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response('{"value":[]}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } }),
    );
    const hostFetch = createHostFetch('outlook-mail', {
      registry,
      resolveSource: async (id) => sources[id] ?? null,
      accessToken: async (s) => tokens[s.sourceId] ?? null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { hostFetch, fetchImpl };
  }

  it('injects the token for exactly the requested source and strips set-cookie', async () => {
    const { hostFetch, fetchImpl } = await setup();
    const res = await hostFetch({ source: 'src-outlook-b', request: { url: 'https://graph.microsoft.com/v1.0/me/messages' } });
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"value":[]}');
    expect(res.headers['set-cookie']).toBeUndefined();
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-b');
  });

  it('refuses hosts outside the egress allowlist without sending a request', async () => {
    const { hostFetch, fetchImpl } = await setup();
    const error = await hostFetch({ source: 'src-outlook-a', request: { url: 'https://evil.example.com/collect' } }).catch((e) => e);
    expect(error).toBeInstanceOf(HostFetchError);
    expect(error.code).toBe('egress-denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a source owned by another provider, so no provider can borrow a foreign account', async () => {
    const { hostFetch, fetchImpl } = await setup();
    const error = await hostFetch({ source: 'src-gmail', request: { url: 'https://graph.microsoft.com/v1.0/me' } }).catch((e) => e);
    expect(error.code).toBe('source-provider-mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses provider-supplied Authorization headers, plain http and unknown sources', async () => {
    const { hostFetch } = await setup();
    const auth = await hostFetch({
      source: 'src-outlook-a',
      request: { url: 'https://graph.microsoft.com/v1.0/me', headers: { Authorization: 'Bearer stolen' } },
    }).catch((e) => e);
    expect(auth.code).toBe('caller-authorization-header');
    const http = await hostFetch({ source: 'src-outlook-a', request: { url: 'http://graph.microsoft.com/v1.0/me' } }).catch((e) => e);
    expect(http.code).toBe('insecure-url');
    const unknown = await hostFetch({ source: 'nope', request: { url: 'https://graph.microsoft.com/v1.0/me' } }).catch((e) => e);
    expect(unknown.code).toBe('unknown-source');
  });

  it('refuses a registration error type distinct from fetch errors', () => {
    expect(new ProviderRegistrationError('duplicate-provider', 'x')).toBeInstanceOf(Error);
  });
});
