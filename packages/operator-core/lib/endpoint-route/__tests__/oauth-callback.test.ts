/**
 * Smoke tests for GET /api/oauth/callback.
 *
 * Ported from app/api/oauth/callback/route.test.ts — the route is now
 * routes/oauth/callback.ts. Keeps the resetModules + doMock pattern: the
 * PG mirror in fsTokenStorage is mocked, and the on-first-request
 * provider disk-load is neutralised and the registry is fully test-controlled.
 * Mocks are stable at module scope: a per-test resetModules()+dynamic import
 * made the first assertion pay the entire cold transform graph and exceed
 * Vitest's 5-second test timeout before the handler even ran.
 *
 * Google and Facebook both connect through the descriptor connection adapter
 * (`provider:<credentialGroup>`): the host resolves the account through the
 * group's declared identity endpoint (`fetchProviderIdentity`) and upserts one
 * source row per group member (`upsertOwnedExternalTriggerSource`). Google is
 * the `google` credential group (provider-adapters-to-packages-2026-10-11 D-036).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';
import { createRequire } from 'node:module';
import { providerRegistry } from '../../integrations/provider-registry';
const requirePlugin = createRequire(import.meta.url);
const facebookAdapter = requirePlugin('../../../../../libs/papercusp/plugins/facebook/index.cjs').providerAdapter;
// Every package in the `google` credential group, so one consent provisions what it really would.
const GOOGLE_GROUP_PACKAGES = ['gmail', 'google-calendar', 'google-contacts', 'youtube'] as const;
const GOOGLE_GROUP_KINDS = ['contacts', 'gcal', 'gmail', 'youtube'];
const googleAdapters = GOOGLE_GROUP_PACKAGES.map((pluginName) => ({
  pluginName,
  adapter: requirePlugin(`../../../../../libs/papercusp/plugins/${pluginName}/index.cjs`).providerAdapter,
}));
vi.mock('../../integrations/provider-registry', async (original) => {
  const actual = await original<typeof import('../../integrations/provider-registry')>();
  return { ...actual, readyProviderRegistry: async () => actual.providerRegistry() };
});

const OWNER = '22222222-2222-4222-8222-222222222222';

const sourceMocks = vi.hoisted(() => ({
  upsertSource: vi.fn(async (_sql: unknown, input: { kind: string }) => ({
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId: 'workspace-1',
    kind: input.kind,
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef: 'provider:facebook:owner',
    status: 'connected',
    config: {},
    cursor: {},
  })),
  resolveIdentity: vi.fn(async () => ({
    providerAccountId: 'facebook-user-1',
    displayName: 'Owner One',
  })),
  listOwned: vi.fn(async (): Promise<unknown[]> => []),
  renameAccount: vi.fn(async (): Promise<unknown[]> => []),
  sql: { test: true },
}));

vi.mock('../../plugin-configs-pg', () => ({
  mirrorPluginConfig: async () => undefined,
}));
vi.mock('../../oauth/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../oauth/providers')>()),
  loadAndRegisterProvidersFromDisk: async () => {},
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sourceMocks.sql }),
}));
vi.mock('../../external-triggers/source-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../external-triggers/source-store')>()),
  listOwnedExternalTriggerSources: sourceMocks.listOwned,
  upsertOwnedExternalTriggerSource: sourceMocks.upsertSource,
  renameOwnedExternalTriggerSourceAccount: sourceMocks.renameAccount,
}));
vi.mock('../../integrations/provider-identity', () => ({ fetchProviderIdentity: sourceMocks.resolveIdentity }));
vi.mock('../../oauth/state', () => ({
  verifyAndConsumeState: async (token: string) => {
    if (!token.includes('.') || token === 'garbage.sig') {
      return { ok: false, error: 'bad-signature' };
    }
    if (
      token === 'google.valid' ||
      token === 'google.external' ||
      token === 'google.missing' ||
      token === 'google.legacy' ||
      token === 'google.mismatch'
    ) {
      const reconnectProviderAccountId =
        token === 'google.legacy'
          ? 'provider:google:legacy-field'
          : token === 'google.mismatch'
            ? 'owner@example.com'
            : undefined;
      return {
        ok: true,
        privateContext: {
          codeVerifier: 'persisted-verifier',
          ...(token === 'google.missing'
            ? {}
            : {
                ownerUserId: '22222222-2222-4222-8222-222222222222',
                workspaceId: 'workspace-1',
                requestedScopes: JSON.stringify([
                  'https://www.googleapis.com/auth/gmail.readonly',
                  'https://www.googleapis.com/auth/calendar.events',
                ]),
                ...(token === 'google.external' ? { returnMode: 'external-browser' } : {}),
                ...(reconnectProviderAccountId ? { reconnectProviderAccountId } : {}),
              }),
        },
        claims: {
          plugin: 'provider:google',
          harness: 'papercusp',
          field: token === 'google.legacy' ? 'legacy-field' : 'owner-22222222-2222-4222-8222-222222222222',
          providerHost: 'accounts.google.com',
          provider: 'provider:google',
        },
      };
    }
    if (token === 'google.integrations' || token === 'google.offsite') {
      // A start that named a return page (D-014.2); the offsite one could only come from a forged
      // or stale state, and the callback must ignore it rather than redirect off-app.
      return {
        ok: true,
        privateContext: {
          codeVerifier: 'persisted-verifier',
          ownerUserId: '22222222-2222-4222-8222-222222222222',
          workspaceId: 'workspace-1',
          returnPath: token === 'google.integrations' ? '/settings/integrations' : 'https://evil.example/steal',
        },
        claims: {
          plugin: 'provider:google',
          harness: 'papercusp',
          field: 'owner-22222222-2222-4222-8222-222222222222',
          providerHost: 'accounts.google.com',
          provider: 'provider:google',
        },
      };
    }
    if (token === 'facebook.valid' || token === 'facebook.missing' || token === 'facebook.mismatch') {
      return {
        ok: true,
        privateContext:
          token === 'facebook.missing'
            ? {}
            : {
                ownerUserId: '22222222-2222-4222-8222-222222222222',
                workspaceId: 'workspace-1',
                ...(token === 'facebook.mismatch'
                  ? { reconnectProviderAccountId: 'facebook-user-1' }
                  : {}),
              },
        claims: {
          plugin: 'provider:facebook',
          harness: 'papercusp',
          field:
            token === 'facebook.mismatch'
              ? 'existing-facebook-field'
              : 'owner-22222222-2222-4222-8222-222222222222',
          providerHost: 'www.facebook.com',
          provider: 'provider:facebook',
        },
      };
    }
    return {
      ok: true,
      privateContext: { codeVerifier: 'persisted-verifier' },
      claims: {
        plugin: 'github-repo',
        harness: 'demo',
        field: 'github_token',
        providerHost: 'example.com',
        provider: 'github',
      },
    };
  },
}));

import callbackRoute from '../routes/oauth/callback';
import * as providers from '../../oauth/providers';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

let TMP_HOME: string;

/** A `provider:google` OAuth provider stub; the exchange is what each case varies. */
function registerGoogleProvider(exchangeCode: providers.OAuthProvider['exchangeCode']): void {
  providers.registerProvider({
    id: 'provider:google',
    config: {
      clientId: 'cid',
      clientSecret: 'sec',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      redirectUri: 'http://localhost:3055/api/oauth/callback',
    },
    buildAuthorizeUrl: () => '',
    exchangeCode,
    refresh: async () => ({ accessToken: 'unused' }),
  });
}

const googleConfigPath = () => join(TMP_HOME, 'harnesses/papercusp/plugin-configs/provider:google.json');

/** The source kinds one Google consent upserted, in call order. */
const upsertedKinds = () => sourceMocks.upsertSource.mock.calls.map(([, input]) => input.kind);

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-callback-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  providers.__resetRegistryForTest();
  providerRegistry().unregister('facebook');
  await providerRegistry().register({ descriptor: await facebookAdapter.describe(), adapter: facebookAdapter, pluginName: 'facebook' });
  for (const { pluginName, adapter } of googleAdapters) {
    const descriptor = await adapter.describe();
    providerRegistry().unregister(descriptor.id);
    await providerRegistry().register({ descriptor, adapter, pluginName });
  }
  sourceMocks.upsertSource.mockClear();
  sourceMocks.resolveIdentity.mockReset();
  sourceMocks.resolveIdentity.mockResolvedValue({
    providerAccountId: 'facebook-user-1',
    displayName: 'Owner One',
  });
  sourceMocks.listOwned.mockReset();
  sourceMocks.listOwned.mockResolvedValue([]);
  sourceMocks.renameAccount.mockReset();
  sourceMocks.renameAccount.mockResolvedValue([]);
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  providers.__resetRegistryForTest();
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

const GET = (req: Request) => Promise.resolve(callbackRoute.handler(req, CTX));

describe('GET /api/oauth/callback', () => {
  it('returns 400 when code or state is missing', async () => {
    const r = await GET(new Request('http://x/api/oauth/callback'));
    expect(r.status).toBe(400);
  });

  it('redirects with oauth_error when provider sent error= param', async () => {
    const r = await GET(new Request('http://x/api/oauth/callback?error=access_denied'));
    expect(r.status).toBe(307);
    expect(r.headers.get('location') ?? '').toContain('oauth_error=access_denied');
  });

  it('returns a cancelled Google consent to Personal Vault settings', async () => {
    const response = await GET(new Request('http://x/api/oauth/callback?error=access_denied&state=google.valid'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://x/settings/personal-vault?oauth_error=access_denied');
  });

  it('returns to the Settings page the start named, and ignores a return path outside Settings (D-014.2)', async () => {
    const named = await GET(new Request('http://x/api/oauth/callback?error=access_denied&state=google.integrations'));
    expect(named.headers.get('location')).toBe('http://x/settings/integrations?oauth_error=access_denied');
    const offsite = await GET(new Request('http://x/api/oauth/callback?error=access_denied&state=google.offsite'));
    expect(offsite.headers.get('location')).toBe('http://x/settings/personal-vault?oauth_error=access_denied');
  });

  it('rejects state with bad signature', async () => {
    const r = await GET(new Request('http://x/api/oauth/callback?code=c&state=garbage.sig'));
    expect(r.status).toBe(400);
  });

  it('exchanges code, writes token to config on happy path', async () => {
    providers.__resetRegistryForTest();
    providers.registerProvider({
      id: 'github',
      config: {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizeUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
        redirectUri: 'http://localhost:3055/cb',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({
        accessToken: 'gho_realtoken',
        refreshToken: 'gho_refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      refresh: async () => ({ accessToken: 'unused' }),
    });

    // Token shape is irrelevant — verifyAndConsumeState is stubbed (see
    // beforeEach) to return the demo claims for any well-formed token.
    const r = await GET(new Request('http://x/api/oauth/callback?code=abc&state=valid.token'));
    expect(r.status).toBe(307);
    expect(r.headers.get('location') ?? '').toContain('connected=github-repo');

    const cfgPath = join(TMP_HOME, 'harnesses/demo/plugin-configs/github-repo.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(cfg.github_token).toBe('gho_realtoken');
    expect(cfg.github_token_refresh).toBe('gho_refresh');
    expect(typeof cfg.github_token_expires_at).toBe('number');
  });

  it('passes the server-side flow context to the provider exchange', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: 'google-token' }));
    providers.__resetRegistryForTest();
    providers.registerProvider({
      id: 'github',
      config: {
        clientId: 'cid',
        clientSecret: 'sec',
        authorizeUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
        redirectUri: 'http://localhost:3055/cb',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode,
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=valid.token'));
    expect(response.status).toBe(307);
    expect(exchangeCode).toHaveBeenCalledWith('authorization-code', { codeVerifier: 'persisted-verifier' });
  });

  it('provisions every Google group source for one account without replacing another account token', async () => {
    await fs.mkdir(join(TMP_HOME, 'harnesses/papercusp/plugin-configs'), { recursive: true });
    await fs.writeFile(
      googleConfigPath(),
      JSON.stringify({
        'other-private-field': 'keep-other-access',
        'other-private-field_refresh': 'keep-other-refresh',
      }),
    );
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '44444444-4444-4444-8444-444444444444',
        workspaceId: 'workspace-1',
        kind: 'gmail',
        ownerUserId: OWNER,
        providerAccountId: 'other@example.com',
        credentialRef: 'provider:google:other-private-field',
        status: 'connected',
        config: {},
        cursor: { historyId: 'keep-other-cursor' },
      },
    ]);
    sourceMocks.resolveIdentity.mockResolvedValue({ providerAccountId: 'owner@example.com', displayName: 'owner@example.com' });
    registerGoogleProvider(async () => ({
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events'],
    }));

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.valid'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://x/settings/personal-vault?oauth_connected=provider%3Agoogle');
    // One grant, one source row per group member, all on the same field-keyed credential.
    expect(upsertedKinds()).toEqual(GOOGLE_GROUP_KINDS);
    for (const kind of GOOGLE_GROUP_KINDS) {
      expect(sourceMocks.upsertSource).toHaveBeenCalledWith(
        sourceMocks.sql,
        expect.objectContaining({
          workspaceId: 'workspace-1',
          kind,
          ownerUserId: OWNER,
          providerAccountId: 'owner@example.com',
          credentialRef: `provider:google:owner-${OWNER}`,
          status: 'connected',
          config: { accountLabel: 'owner@example.com' },
          createdBy: `owner:${OWNER}`,
        }),
      );
    }
    const cfg = JSON.parse(await fs.readFile(googleConfigPath(), 'utf8'));
    expect(cfg[`owner-${OWNER}`]).toBe('google-access');
    expect(cfg[`owner-${OWNER}_refresh`]).toBe('google-refresh');
    expect(cfg[`owner-${OWNER}_scopes`]).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
    expect(cfg['other-private-field']).toBe('keep-other-access');
    expect(cfg['other-private-field_refresh']).toBe('keep-other-refresh');
  });

  it('renders a no-store completion page after a successful external-browser flow', async () => {
    sourceMocks.resolveIdentity.mockResolvedValue({ providerAccountId: 'owner@example.com', displayName: 'owner@example.com' });
    registerGoogleProvider(async () => ({
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    }));

    const response = await GET(
      new Request(
        'http://x/api/oauth/callback?code=authorization-code&state=google.external',
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain('Connection complete');
    expect(html).toContain('close this tab and return to Papercusp');
    expect(html).not.toContain('authorization-code');
    expect(html).not.toContain('google-access');
    expect(upsertedKinds()).toEqual(GOOGLE_GROUP_KINDS);
  });

  it('renders an escaped error page when an external-browser flow is denied', async () => {
    const response = await GET(
      new Request(
        'http://x/api/oauth/callback?error=%3Cscript%3Ealert%281%29%3C%2Fscript%3E&state=google.external',
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    const html = await response.text();
    expect(html).toContain('Connection not completed');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('WI-129473: fails closed when an ADD-account Google consent comes back with an already-connected account', async () => {
    // The mismatch guard compares against `reconnectProviderAccountId`, so it only
    // protects a RECONNECT. An add-account flow has no expected account; without
    // this guard a consent screen answered with the already-connected mailbox
    // would be written under the fresh field oauth/start had just allocated — a
    // second credential slot pointing at the SAME account.
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '44444444-4444-4444-8444-444444444444',
        workspaceId: 'workspace-1',
        kind: 'gmail',
        ownerUserId: OWNER,
        // identical to what the identity endpoint returns for this consent
        providerAccountId: 'owner@example.com',
        credentialRef: 'provider:google:already-connected-field',
        status: 'connected',
        config: {},
        cursor: { historyId: 'existing-cursor' },
      },
    ]);
    sourceMocks.resolveIdentity.mockResolvedValue({ providerAccountId: 'owner@example.com', displayName: 'owner@example.com' });
    // a full, healthy token response — the defect is the ACCOUNT, not the token
    registerGoogleProvider(async () => ({
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    }));

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.valid'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_error=provider_google_account_already_connected',
    );
    // the decisive assertion: nothing was provisioned, so no duplicate slot exists
    expect(sourceMocks.upsertSource).not.toHaveBeenCalled();
  });

  it('WI-129473: fails closed when a NEW Google account arrives without a refresh token', async () => {
    // access_type=offline only yields a refresh_token on a genuine consent. If
    // Google satisfies the request from an existing grant, the response carries an
    // access token alone — which expires within the hour with nothing to renew it.
    sourceMocks.resolveIdentity.mockResolvedValue({ providerAccountId: 'owner@example.com', displayName: 'owner@example.com' });
    registerGoogleProvider(async () => ({
      accessToken: 'google-access',
      // no refreshToken — the incremental-auth outcome
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    }));

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.valid'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_error=provider_google_refresh_token_missing',
    );
    expect(sourceMocks.upsertSource).not.toHaveBeenCalled();
  });

  it('adopts a canonical Google account identity in place for a provisional reconnect', async () => {
    // A source adopted from the legacy plugin (D-037) can still carry a provisional
    // `provider:google:<field>` account id; the first reconnect replaces it in place.
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'workspace-1',
        kind: 'gmail',
        ownerUserId: OWNER,
        providerAccountId: 'owner@example.com',
        credentialRef: 'provider:google:legacy-field',
        status: 'connected',
        config: {},
        cursor: { historyId: 'keep-me' },
      },
    ]);
    sourceMocks.resolveIdentity.mockResolvedValue({ providerAccountId: 'owner@example.com', displayName: 'owner@example.com' });
    registerGoogleProvider(async () => ({ accessToken: 'google-access' }));

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.legacy'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://x/settings/personal-vault?oauth_connected=provider%3Agoogle');
    expect(sourceMocks.renameAccount).toHaveBeenCalledWith(sourceMocks.sql, {
      workspaceId: 'workspace-1',
      ownerUserId: OWNER,
      previousProviderAccountId: 'provider:google:legacy-field',
      providerAccountId: 'owner@example.com',
    });
    expect(sourceMocks.upsertSource).toHaveBeenCalledWith(
      sourceMocks.sql,
      expect.objectContaining({ kind: 'gmail', providerAccountId: 'owner@example.com', credentialRef: 'provider:google:legacy-field' }),
    );
  });

  it('fails closed when a targeted Google reconnect authenticates a different canonical account', async () => {
    sourceMocks.resolveIdentity.mockResolvedValue({
      providerAccountId: 'other@example.com',
      displayName: 'other@example.com',
    });
    registerGoogleProvider(async () => ({ accessToken: 'must-not-store' }));

    const response = await GET(
      new Request('http://x/api/oauth/callback?code=authorization-code&state=google.mismatch'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_error=provider_google_account_mismatch',
    );
    expect(sourceMocks.renameAccount).not.toHaveBeenCalled();
    expect(sourceMocks.upsertSource).not.toHaveBeenCalled();
    await expect(fs.access(googleConfigPath())).rejects.toThrow();
  });

  it('fails closed when a Google callback lacks server-owned identity context', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: 'must-not-store' }));
    registerGoogleProvider(exchangeCode);

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=google.missing'));
    expect(response.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(sourceMocks.upsertSource).not.toHaveBeenCalled();
  });

  it('stores one Facebook account without replacing another account token or source', async () => {
    const cfgDir = join(TMP_HOME, 'harnesses/papercusp/plugin-configs');
    const cfgPath = join(cfgDir, 'provider:facebook.json');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        'other-facebook-field': 'keep-other-facebook-access',
        'other-facebook-field_refresh': 'keep-other-facebook-refresh',
      }),
    );
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '44444444-4444-4444-8444-444444444444',
        workspaceId: 'workspace-1',
        kind: 'facebook',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        providerAccountId: 'facebook-user-2',
        credentialRef: 'provider:facebook:other-facebook-field',
        status: 'connected',
        config: { displayName: 'Owner Two' },
        cursor: { since: 'keep-other-cursor' },
      },
    ]);
    providers.registerProvider({
      id: 'provider:facebook',
      config: {
        clientId: 'facebook-app',
        clientSecret: 'facebook-secret',
        authorizeUrl: 'https://www.facebook.com/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/oauth/access_token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      defaultScopes: ['public_profile', 'user_posts', 'user_photos'],
      allowedScopes: ['public_profile', 'user_posts', 'user_photos'],
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({
        accessToken: 'facebook-long-lived',
        refreshToken: 'facebook-long-lived',
        expiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000,
      }),
      refresh: async () => ({ accessToken: 'facebook-refreshed' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=facebook.valid'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_connected=provider%3Afacebook',
    );
    expect(sourceMocks.upsertSource).toHaveBeenCalledWith(sourceMocks.sql, {
      workspaceId: 'workspace-1',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      providerAccountId: 'facebook-user-1',
      kind: 'facebook',
      credentialRef: 'provider:facebook:owner-22222222-2222-4222-8222-222222222222',
      status: 'connected',
      config: { accountLabel: 'Owner One' },
      createdBy: 'owner:22222222-2222-4222-8222-222222222222',
    });
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    expect(cfg['owner-22222222-2222-4222-8222-222222222222']).toBe('facebook-long-lived');
    expect(cfg['owner-22222222-2222-4222-8222-222222222222_refresh']).toBe('facebook-long-lived');
    expect(cfg['other-facebook-field']).toBe('keep-other-facebook-access');
    expect(cfg['other-facebook-field_refresh']).toBe('keep-other-facebook-refresh');
  });

  it('WI-133209: fails closed when an ADD-account Facebook consent comes back with an already-connected account', async () => {
    // Symmetric to the Google case. The test directly above is the CONTRAST that
    // makes this one meaningful: there the owned source is facebook-user-2 while
    // the consent resolves facebook-user-1, so it is a genuine second account and
    // must succeed. Here the owned source IS facebook-user-1 — the same account the
    // consent came back with — so a new slot would duplicate an existing connection.
    // Facebook reaches this more easily than Google: its authorize URL carries no
    // account-chooser hint, so an active session just continues as the logged-in user.
    sourceMocks.listOwned.mockResolvedValue([
      {
        id: '55555555-5555-4555-8555-555555555555',
        workspaceId: 'workspace-1',
        kind: 'facebook',
        ownerUserId: '22222222-2222-4222-8222-222222222222',
        // identical to what resolveIdentity returns for this consent
        providerAccountId: 'facebook-user-1',
        credentialRef: 'provider:facebook:already-connected-field',
        status: 'connected',
        config: { displayName: 'Owner One' },
        cursor: { since: 'existing-cursor' },
      },
    ]);
    providers.registerProvider({
      id: 'provider:facebook',
      config: {
        clientId: 'facebook-app',
        clientSecret: 'facebook-secret',
        authorizeUrl: 'https://www.facebook.com/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/oauth/access_token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      defaultScopes: ['public_profile', 'user_posts', 'user_photos'],
      allowedScopes: ['public_profile', 'user_posts', 'user_photos'],
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({
        accessToken: 'facebook-long-lived',
        refreshToken: 'facebook-long-lived',
        expiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000,
      }),
      refresh: async () => ({ accessToken: 'facebook-refreshed' }),
    });

    const response = await GET(new Request('http://x/api/oauth/callback?code=authorization-code&state=facebook.valid'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_error=provider_facebook_account_already_connected',
    );
    expect(sourceMocks.upsertSource).not.toHaveBeenCalled();
  });

  it('fails closed when a targeted Facebook reconnect authenticates a different account', async () => {
    sourceMocks.resolveIdentity.mockResolvedValue({
      providerAccountId: 'facebook-user-2',
      displayName: 'Owner Two',
    });
    providers.registerProvider({
      id: 'provider:facebook',
      config: {
        clientId: 'facebook-app',
        clientSecret: 'facebook-secret',
        authorizeUrl: 'https://www.facebook.com/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/oauth/access_token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({ accessToken: 'must-not-store' }),
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(
      new Request('http://x/api/oauth/callback?code=authorization-code&state=facebook.mismatch'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://x/settings/personal-vault?oauth_error=provider_facebook_account_mismatch',
    );
    expect(sourceMocks.renameAccount).not.toHaveBeenCalled();
    expect(sourceMocks.upsertSource).not.toHaveBeenCalled();
    await expect(
      fs.access(join(TMP_HOME, 'harnesses/papercusp/plugin-configs/provider:facebook.json')),
    ).rejects.toThrow();
  });

  it('fails closed when a Facebook callback lacks server-owned identity context', async () => {
    const exchangeCode = vi.fn(async () => ({ accessToken: 'must-not-store' }));
    providers.registerProvider({
      id: 'provider:facebook',
      config: {
        clientId: 'facebook-app',
        clientSecret: 'facebook-secret',
        authorizeUrl: 'https://www.facebook.com/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/oauth/access_token',
        redirectUri: 'http://localhost:3055/api/oauth/callback',
      },
      buildAuthorizeUrl: () => '',
      exchangeCode,
      refresh: async () => ({ accessToken: 'unused' }),
    });

    const response = await GET(
      new Request('http://x/api/oauth/callback?code=authorization-code&state=facebook.missing'),
    );
    expect(response.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(sourceMocks.upsertSource).not.toHaveBeenCalled();
  });
});
