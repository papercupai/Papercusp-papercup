import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeDescriptorOAuthProvider } from './connection-lifecycle';

/**
 * The authorize URL a provider descriptor produces (linear-asana-task-sync-2026-10-05 P-004).
 * Linear documents a comma-separated `scope` and installs as an app user with `actor=app`, which
 * the descriptor carries in its own authorize URL; a REST provider keeps the space default.
 */
const client = { clientId: 'client-1', redirectUri: 'https://papercusp.test/oauth/callback' };

function authorize(oauth: Parameters<typeof makeDescriptorOAuthProvider>[1]): URL {
  const provider = makeDescriptorOAuthProvider('provider:example', oauth, client);
  return new URL(provider.buildAuthorizeUrl(oauth.scopes, 'state-1'));
}

afterEach(() => vi.unstubAllGlobals());

describe('makeDescriptorOAuthProvider: authorize URL', () => {
  it('refuses a required missing or unsafe User-Agent before issuing a request', () => {
    const tokenFetch = vi.fn(); vi.stubGlobal('fetch', tokenFetch);
    const oauth = { authorizeUrl: 'https://api.example.com/authorize', tokenUrl: 'https://api.example.com/token', scopes: [], userAgentRequired: true as const };
    for (const userAgent of [undefined, '', 'injected\r\nHeader: value']) {
      expect(() => makeDescriptorOAuthProvider('provider:example', oauth, { ...client, userAgent })).toThrow('user_agent_required');
    }
    expect(tokenFetch).not.toHaveBeenCalled();
  });
  it('joins scopes with the declared comma and keeps the descriptor URL\'s own query (actor=app)', () => {
    const url = authorize({
      authorizeUrl: 'https://linear.app/oauth/authorize?actor=app',
      tokenUrl: 'https://api.linear.app/oauth/token',
      scopes: ['read', 'write', 'app:assignable', 'app:mentionable'],
      scopeSeparator: ',',
    });
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read,write,app:assignable,app:mentionable');
    expect(url.searchParams.get('actor')).toBe('app');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('joins scopes with a space when no separator is declared', () => {
    const url = authorize({
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:user'],
    });
    expect(url.searchParams.get('scope')).toBe('repo read:user');
    expect(url.searchParams.has('actor')).toBe(false);
  });

  it('uses a declared client_key for authorization, exchange and refresh while retaining rotated tokens', async () => {
    const tokenFetch = vi.fn(async () => Response.json({ access_token: 'access', refresh_token: 'rotated', scope: 'user.info.basic,video.list' }));
    vi.stubGlobal('fetch', tokenFetch);
    const provider = makeDescriptorOAuthProvider('provider:tiktok', {
      authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/', tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
      scopes: ['user.info.basic', 'video.list'], scopeSeparator: ',', clientIdParameter: 'client_key',
    }, { ...client, clientSecret: 'host-secret' });
    const url = new URL(provider.buildAuthorizeUrl([...(provider.defaultScopes ?? [])], 'state-1'));
    expect(url.searchParams.get('client_key')).toBe('client-1');
    expect(url.searchParams.has('client_id')).toBe(false);
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.list');
    expect(await provider.exchangeCode('code')).toMatchObject({ refreshToken: 'rotated', scopes: ['user.info.basic', 'video.list'] });
    expect(await provider.refresh('old-refresh')).toMatchObject({ refreshToken: 'rotated' });
    expect(tokenFetch).toHaveBeenCalledTimes(2);
    for (const call of tokenFetch.mock.calls as unknown as [string, RequestInit][]) expect(call[1].redirect).toBe('manual');
    const forms = tokenFetch.mock.calls.map((call) => new URLSearchParams((call as unknown as [string, RequestInit])[1].body as string));
    for (const form of forms) {
      expect(form.get('client_key')).toBe('client-1'); expect(form.has('client_id')).toBe(false);
      expect(form.get('client_secret')).toBe('host-secret');
    }
    expect(forms[0].get('code')).toBe('code'); expect(forms[0].get('redirect_uri')).toBe(client.redirectUri);
    expect(forms[1].get('refresh_token')).toBe('old-refresh'); expect(forms[1].get('grant_type')).toBe('refresh_token');
  });

  it.each([3070, 3170])('uses the exact host callback on port %i for authorization and token exchange', async (port) => {
    const redirectUri = `http://localhost:${port}/api/oauth/callback`;
    const tokenFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ access_token: 'test-access-token', refresh_token: 'test-refresh-token' }),
    );
    vi.stubGlobal('fetch', tokenFetch);
    const provider = makeDescriptorOAuthProvider(
      'provider:example',
      {
        authorizeUrl: 'https://provider.example/authorize',
        tokenUrl: 'https://provider.example/token',
        scopes: ['read'],
      },
      { ...client, redirectUri },
    );

    const authorizationUrl = new URL(provider.buildAuthorizeUrl(['read'], 'state-1'));
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(redirectUri);
    await provider.exchangeCode('test-code');
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    const [endpoint, request] = tokenFetch.mock.calls[0]!;
    expect(endpoint).toBe('https://provider.example/token');
    const form = new URLSearchParams(request?.body as string);
    expect(form.get('redirect_uri')).toBe(redirectUri);
    expect(form.get('code')).toBe('test-code');
  });

  it.each(['host-secret', ''])('authenticates exchange and refresh with HTTP Basic, including an installed app empty secret (%j)', async (clientSecret) => {
    const tokenFetch = vi.fn(async () => Response.json({ access_token: 'access', scope: 'read submit' }));
    vi.stubGlobal('fetch', tokenFetch);
    const provider = makeDescriptorOAuthProvider('provider:example', {
      authorizeUrl: 'https://api.example.com/authorize?duration=permanent', tokenUrl: 'https://api.example.com/token',
      scopes: ['read', 'submit'], tokenEndpointAuthMethod: 'client_secret_basic',
    }, { ...client, clientSecret });
    expect(new URL(provider.buildAuthorizeUrl(['read'], 'state')).searchParams.get('client_id')).toBe(client.clientId);
    await provider.exchangeCode('the-code');
    expect(await provider.refresh('prior-refresh')).toMatchObject({ refreshToken: 'prior-refresh' });
    expect(tokenFetch).toHaveBeenCalledTimes(2);
    for (const [, request] of tokenFetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(new Headers(request.headers).get('authorization')).toBe(`Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString('base64')}`);
      expect(request.redirect).toBe('manual');
      const form = new URLSearchParams(request.body as URLSearchParams);
      expect(form.has('client_id')).toBe(false); expect(form.has('client_secret')).toBe(false);
    }
  });

  it('form-encodes Basic credentials before joining them and keeps the secret out of authorization URLs', async () => {
    const tokenFetch = vi.fn(async () => Response.json({ access_token: 'access' }));
    vi.stubGlobal('fetch', tokenFetch);
    const provider = makeDescriptorOAuthProvider('provider:example', {
      authorizeUrl: 'https://api.example.com/authorize', tokenUrl: 'https://api.example.com/token', scopes: [],
      tokenEndpointAuthMethod: 'client_secret_basic',
    }, { ...client, clientId: 'client:name +', clientSecret: 'secret: +/%' });
    const url = new URL(provider.buildAuthorizeUrl([], 'state'));
    expect(url.searchParams.get('client_id')).toBe('client:name +'); expect(url.searchParams.has('client_secret')).toBe(false);
    await provider.exchangeCode('code');
    const request = (tokenFetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    const header = new Headers(request.headers).get('authorization')!;
    expect(Buffer.from(header.slice(6), 'base64').toString()).toBe('client%3Aname+%2B:secret%3A+%2B%2F%25');
  });
});
