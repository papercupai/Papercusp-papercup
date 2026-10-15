/**
 * Smoke tests for GET /api/oauth/start.
 *
 * Ported from app/api/oauth/start/route.test.ts — the route is now
 * routes/oauth/start.ts. The handler is called directly. The on-first-
 * request `loadAndRegisterProvidersFromDisk()` is mocked to a no-op so
 * the test controls the provider registry entirely via registerProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateMocks = vi.hoisted(() => ({
  signState: vi.fn(async (_claims: { field: string }) => 'test-state-token'),
}));
const authMocks = vi.hoisted(() => ({
  getSessionUserOrDefault: vi.fn(async () => ({
    id: '22222222-2222-4222-8222-222222222222',
    username: 'owner',
    display_name: 'Owner',
    has_password: false,
  })),
}));
const sourceMocks = vi.hoisted(() => ({
  listOwned: vi.fn(async (): Promise<unknown[]> => []),
  sql: { test: true },
}));

vi.mock('../../oauth/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../oauth/providers')>();
  return { ...actual, loadAndRegisterProvidersFromDisk: async () => {} };
});
// The state token's nonce is persisted to PG (harness_shared.oauth_nonces).
// This route test exercises route behaviour, not the nonce store — stub
// signState so the test is hermetic (no DB).
vi.mock('../../oauth/state', () => ({
  signState: stateMocks.signState,
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: authMocks.getSessionUserOrDefault,
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'workspace-1',
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sourceMocks.sql }),
}));
vi.mock('../../external-triggers/source-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../external-triggers/source-store')>()),
  listOwnedExternalTriggerSources: sourceMocks.listOwned,
}));

import startRoute from '../routes/oauth/start';
import { __resetRegistryForTest, registerProvider, type OAuthProvider } from '../../oauth/providers';
import type { RouteContext } from '../define-route';
import { createRequire } from 'node:module';
import { providerRegistry } from '../../integrations/provider-registry';
const facebookAdapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/facebook/index.cjs').providerAdapter;
vi.mock('../../integrations/provider-registry', async (original) => {
  const actual = await original<typeof import('../../integrations/provider-registry')>();
  return { ...actual, readyProviderRegistry: async () => actual.providerRegistry() };
});


const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};
const GET = (req: Request) => Promise.resolve(startRoute.handler(req, CTX));

const stubProvider: OAuthProvider = {
  id: 'github',
  config: {
    clientId: 'Iv1.test',
    clientSecret: 'secret',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    redirectUri: 'http://localhost:3055/api/oauth/callback',
  },
  buildAuthorizeUrl: (scopes, state) =>
    `https://github.com/login/oauth/authorize?scope=${encodeURIComponent(scopes.join(' '))}&state=${state}`,
  exchangeCode: async () => ({ accessToken: 'unused' }),
  refresh: async () => ({ accessToken: 'unused' }),
};

beforeEach(async () => {
  __resetRegistryForTest();
  providerRegistry().unregister('facebook');
  await providerRegistry().register({ descriptor: await facebookAdapter.describe(), adapter: facebookAdapter, pluginName: 'facebook' });
  stateMocks.signState.mockClear();
  authMocks.getSessionUserOrDefault.mockClear();
  sourceMocks.listOwned.mockReset();
  sourceMocks.listOwned.mockResolvedValue([]);
});

afterEach(() => {
  __resetRegistryForTest();
});

describe('GET /api/oauth/start', () => {
  it('rejects missing params with 400', async () => {
    const r = await GET(new Request('http://x/api/oauth/start?provider=github'));
    expect(r.status).toBe(400);
  });

  it('rejects unknown providers with 404', async () => {
    const r = await GET(new Request('http://x/api/oauth/start?provider=xyz&plugin=p&harness=h&field=f'));
    expect(r.status).toBe(404);
  });

  it('redirects 302 to provider authorize URL with state attached', async () => {
    registerProvider(stubProvider);
    const r = await GET(
      new Request('http://x/api/oauth/start?provider=github&plugin=p&harness=h&field=tok&scopes=repo,read:user'),
    );
    expect(r.status).toBe(302);
    const loc = r.headers.get('location') ?? '';
    expect(loc).toContain('https://github.com/login/oauth/authorize');
    expect(loc).toContain('scope=repo%20read%3Auser');
    expect(loc).toContain('state=');
  });

  it('returns the server-built authorize URL for an external-browser flow', async () => {
    const buildAuthorizeUrl = vi.fn(
      (_scopes: string[], state: string) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    );
    registerProvider({
      ...stubProvider,
      id: 'google',
      defaultScopes: ['scope:mail'],
      allowedScopes: ['scope:mail'],
      createFlowContext: () => ({ codeVerifier: 'server-only-verifier' }),
      buildAuthorizeUrl,
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=google&plugin=p&harness=h&field=tok&response=json',
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      ok: true,
      authorizationUrl:
        'https://accounts.google.com/o/oauth2/v2/auth?state=test-state-token',
      shareUrl: 'http://x/api/oauth/start?provider=google&plugin=p&harness=h&field=tok',
      instruction: 'Open authorizationUrl immediately. Share shareUrl with another person; it creates fresh OAuth state when opened.',
    });
    expect(stateMocks.signState).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
      {
        privateContext: {
          codeVerifier: 'server-only-verifier',
          returnMode: 'external-browser',
        },
      },
    );
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      ['scope:mail'],
      'test-state-token',
      {
        codeVerifier: 'server-only-verifier',
        returnMode: 'external-browser',
      },
    );
  });

  it('mints fresh state when a shared start URL is visited later', async () => {
    registerProvider(stubProvider);
    stateMocks.signState.mockResolvedValueOnce('initial-state').mockResolvedValueOnce('fresh-state');

    const initial = await GET(new Request(
      'http://x/api/oauth/start?provider=github&plugin=p&harness=h&field=tok&response=json',
    ));
    const { shareUrl } = await initial.json() as { shareUrl: string };
    const laterVisit = await GET(new Request(shareUrl));

    expect(laterVisit.status).toBe(302);
    expect(laterVisit.headers.get('location')).toContain('state=fresh-state');
    expect(stateMocks.signState).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown response mode before creating OAuth state', async () => {
    registerProvider(stubProvider);

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=github&plugin=p&harness=h&field=tok&response=popup',
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'response must be redirect or json',
    });
    expect(stateMocks.signState).not.toHaveBeenCalled();
  });

  it('persists private flow context and enforces provider scope policy', async () => {
    const buildAuthorizeUrl = vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth');
    registerProvider({
      ...stubProvider,
      id: 'google',
      defaultScopes: ['scope:mail'],
      allowedScopes: ['scope:mail'],
      createFlowContext: () => ({ codeVerifier: 'server-only-verifier' }),
      buildAuthorizeUrl,
    });

    const ok = await GET(new Request('http://x/api/oauth/start?provider=google&plugin=p&harness=h&field=tok'));
    expect(ok.status).toBe(302);
    expect(stateMocks.signState).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }), {
      privateContext: { codeVerifier: 'server-only-verifier' },
    });
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(['scope:mail'], 'test-state-token', {
      codeVerifier: 'server-only-verifier',
    });

    const denied = await GET(
      new Request('http://x/api/oauth/start?provider=google&plugin=p&harness=h&field=tok&scopes=scope:admin'),
    );
    expect(denied.status).toBe(400);
  });

  it('captures the local user and workspace only for the Google Workspace connection', async () => {
    const buildAuthorizeUrl = vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth');
    registerProvider({
      ...stubProvider,
      id: 'google',
      defaultScopes: ['scope:mail', 'scope:calendar'],
      allowedScopes: ['scope:mail', 'scope:calendar', 'scope:calendar-write'],
      createFlowContext: () => ({ codeVerifier: 'server-only-verifier' }),
      buildAuthorizeUrl,
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&scopes=scope:calendar-write',
        { headers: { cookie: 'papercusp_session=opaque' } },
      ),
    );
    expect(response.status).toBe(302);
    expect(authMocks.getSessionUserOrDefault).toHaveBeenCalledTimes(1);
    expect(stateMocks.signState).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        plugin: 'google-workspace',
        harness: 'papercusp',
        field: expect.stringMatching(/^owner-22222222-2222-4222-8222-222222222222-[a-f0-9]{16}$/),
      }),
      {
        privateContext: {
          codeVerifier: 'server-only-verifier',
          ownerUserId: '22222222-2222-4222-8222-222222222222',
          workspaceId: 'workspace-1',
          returnPath: '/settings/personal-vault',
          requestedScopes: JSON.stringify(['scope:mail', 'scope:calendar', 'scope:calendar-write']),
        },
      },
    );
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      ['scope:mail', 'scope:calendar', 'scope:calendar-write'],
      'test-state-token',
      expect.objectContaining({
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        workspaceId: 'workspace-1',
        returnPath: '/settings/personal-vault',
        requestedScopes: JSON.stringify(['scope:mail', 'scope:calendar', 'scope:calendar-write']),
      }),
    );
  });

  it('carries an internal Settings return path in the signed state, and refuses any other (D-014.2)', async () => {
    registerProvider({ ...stubProvider, id: 'google', defaultScopes: ['scope:mail'], allowedScopes: ['scope:mail'] });
    const start = (ret: string) =>
      GET(new Request(`http://x/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&return=${encodeURIComponent(ret)}`));

    expect((await start('/settings/integrations')).status).toBe(302);
    expect(stateMocks.signState).toHaveBeenLastCalledWith(
      expect.objectContaining({ plugin: 'google-workspace' }),
      { privateContext: expect.objectContaining({ returnPath: '/settings/integrations' }) },
    );

    stateMocks.signState.mockClear();
    for (const offsite of ['https://evil.example/x', '//evil.example/x', '/settings/../admin', '/harness/x', '/settings\\evil', '']) {
      const refused = await start(offsite);
      expect(refused.status, offsite).toBe(400);
      expect(await refused.json()).toEqual({ ok: false, error: 'return must be an internal /settings/ path' });
    }
    expect(stateMocks.signState).not.toHaveBeenCalled();
  });

  it('carries the return path for a plugin flow with no connection adapter too', async () => {
    registerProvider(stubProvider);
    const response = await GET(
      new Request('http://x/api/oauth/start?provider=github&plugin=github-repo&harness=demo&field=github_token&return=/settings/integrations'),
    );
    expect(response.status).toBe(302);
    expect(stateMocks.signState).toHaveBeenLastCalledWith(
      expect.objectContaining({ plugin: 'github-repo' }),
      { privateContext: { returnPath: '/settings/integrations' } },
    );
  });

  it('uses a unique private token field for each Google Workspace Add Account flow', async () => {
    registerProvider({
      ...stubProvider,
      id: 'google',
      defaultScopes: ['scope:mail'],
      allowedScopes: ['scope:mail'],
      buildAuthorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    });

    const url = 'http://x/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner';
    expect((await GET(new Request(url))).status).toBe(302);
    expect((await GET(new Request(url))).status).toBe(302);

    const fields = stateMocks.signState.mock.calls.slice(-2).map(([claims]) => claims.field);
    expect(fields[0]).toMatch(/^owner-22222222-2222-4222-8222-222222222222-[a-f0-9]{16}$/);
    expect(fields[1]).toMatch(/^owner-22222222-2222-4222-8222-222222222222-[a-f0-9]{16}$/);
    expect(fields[0]).not.toBe(fields[1]);
  });

  it('reuses only the selected owned account field for a targeted Google Workspace reconnect', async () => {
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'workspace-1',
        kind: 'gmail',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        providerAccountId: 'owner@example.com',
        credentialRef: 'google-workspace:existing-private-field',
        status: 'disabled',
        config: {},
        cursor: {},
      },
    ]);
    registerProvider({
      ...stubProvider,
      id: 'google',
      defaultScopes: ['scope:mail'],
      allowedScopes: ['scope:mail'],
      buildAuthorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&account=owner%40example.com',
      ),
    );
    expect(response.status).toBe(302);
    expect(sourceMocks.listOwned).toHaveBeenCalledWith(
      sourceMocks.sql,
      'workspace-1',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(stateMocks.signState).toHaveBeenCalledWith(expect.objectContaining({ field: 'existing-private-field' }), {
      privateContext: expect.objectContaining({
        reconnectProviderAccountId: 'owner@example.com',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        workspaceId: 'workspace-1',
      }),
    });
  });

  it('rejects a Google Workspace reconnect for an account not owned by the local user', async () => {
    registerProvider({
      ...stubProvider,
      id: 'google',
      defaultScopes: ['scope:mail'],
      allowedScopes: ['scope:mail'],
      buildAuthorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&account=other%40example.com',
      ),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'google_workspace_account_not_found' });
    expect(stateMocks.signState).not.toHaveBeenCalled();
  });

  it('rejects a non-Google provider under the reserved Workspace plugin id', async () => {
    registerProvider(stubProvider);
    const response = await GET(
      new Request('http://x/api/oauth/start?provider=github&plugin=google-workspace&harness=papercusp&field=owner'),
    );
    expect(response.status).toBe(400);
    expect(authMocks.getSessionUserOrDefault).not.toHaveBeenCalled();
  });

  it('captures the owner for Facebook Personal Vault and always requests the capability-accurate scope set', async () => {
    const buildAuthorizeUrl = vi.fn(() => 'https://www.facebook.com/dialog/oauth');
    registerProvider({
      ...stubProvider,
      id: 'provider:facebook',
      defaultScopes: ['public_profile', 'user_posts', 'user_photos'],
      allowedScopes: ['public_profile', 'user_posts', 'user_photos'],
      buildAuthorizeUrl,
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=provider%3Afacebook&plugin=provider%3Afacebook&harness=papercusp&field=ignored&scopes=public_profile',
        { headers: { cookie: 'papercusp_session=opaque' } },
      ),
    );
    expect(response.status).toBe(302);
    expect(stateMocks.signState).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'provider:facebook',
        plugin: 'provider:facebook',
        harness: 'papercusp',
        field: expect.stringMatching(/^owner-22222222-2222-4222-8222-222222222222-[a-f0-9]{16}$/),
      }),
      {
        privateContext: {
          ownerUserId: '22222222-2222-4222-8222-222222222222',
          workspaceId: 'workspace-1',
          returnPath: '/settings/personal-vault',
          requestedScopes: JSON.stringify(['public_profile', 'user_posts', 'user_photos']),
        },
      },
    );
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      ['public_profile', 'user_posts', 'user_photos'],
      'test-state-token',
      expect.objectContaining({ ownerUserId: '22222222-2222-4222-8222-222222222222' }),
    );
  });

  it('reuses only the selected owned Facebook account field for reconnect', async () => {
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'workspace-1',
        kind: 'facebook',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        providerAccountId: 'facebook-user-2',
        credentialRef: 'provider:facebook:existing-facebook-field',
        status: 'disabled',
        config: {},
        cursor: {},
      },
    ]);
    registerProvider({
      ...stubProvider,
      id: 'provider:facebook',
      defaultScopes: ['public_profile', 'user_posts', 'user_photos'],
      allowedScopes: ['public_profile', 'user_posts', 'user_photos'],
      buildAuthorizeUrl: () => 'https://www.facebook.com/dialog/oauth',
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=provider%3Afacebook&plugin=provider%3Afacebook&harness=papercusp&field=owner&account=facebook-user-2',
      ),
    );
    expect(response.status).toBe(302);
    expect(stateMocks.signState).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'existing-facebook-field' }),
      {
        privateContext: expect.objectContaining({
          reconnectProviderAccountId: 'facebook-user-2',
          ownerUserId: '22222222-2222-4222-8222-222222222222',
          workspaceId: 'workspace-1',
        }),
      },
    );
  });

  it('rejects a Facebook reconnect for an account not owned by the local user', async () => {
    registerProvider({
      ...stubProvider,
      id: 'provider:facebook',
      defaultScopes: ['public_profile', 'user_posts', 'user_photos'],
      allowedScopes: ['public_profile', 'user_posts', 'user_photos'],
      buildAuthorizeUrl: () => 'https://www.facebook.com/dialog/oauth',
    });

    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=provider%3Afacebook&plugin=provider%3Afacebook&harness=papercusp&field=owner&account=other-facebook-user',
      ),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'provider_facebook_account_not_found',
    });
    expect(stateMocks.signState).not.toHaveBeenCalled();
  });

  it('rejects a non-Facebook provider under the reserved Facebook Personal Vault plugin id', async () => {
    registerProvider(stubProvider);
    const response = await GET(
      new Request(
        'http://x/api/oauth/start?provider=github&plugin=provider%3Afacebook&harness=papercusp&field=owner',
      ),
    );
    expect(response.status).toBe(400);
    expect(authMocks.getSessionUserOrDefault).not.toHaveBeenCalled();
  });
});
