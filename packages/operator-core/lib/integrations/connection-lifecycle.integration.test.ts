/**
 * Provider-neutral connection lifecycle against real Postgres (P-003 of
 * generalized-integrations-google-migration-cupboard-workflows-2026-10-05).
 *
 * Drives the REAL OAuth callback route for a descriptor provider credential
 * group (two providers sharing one grant) and for the real Google package group
 * (`provider:google`: gmail, gcal, contacts, youtube — provider-adapters-to-packages-2026-10-11
 * D-036). Only the network edge is faked: the token and identity
 * endpoints answer through a stubbed global fetch, and the signed state store
 * is replaced by an in-memory map so each test controls its claims and
 * server-held flow context. Source rows, cursors, bindings and the token file
 * are the real stores.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { RouteContext } from '../endpoint-route/define-route';
import type { OAuthFlowPrivateContext, StateClaims } from '../oauth/state';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as import('postgres').Sql,
  states: new Map<string, { claims: unknown; privateContext: Record<string, string> }>(),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
}));
vi.mock('../plugin-configs-pg', () => ({ mirrorPluginConfig: async () => undefined }));
vi.mock('../oauth/providers', async (orig) => ({
  ...(await orig<typeof import('../oauth/providers')>()),
  loadAndRegisterProvidersFromDisk: async () => {},
}));
vi.mock('../oauth/state', async (orig) => ({
  ...(await orig<typeof import('../oauth/state')>()),
  verifyAndConsumeState: async (token: string) => {
    const entry = h.states.get(token);
    if (!entry) return { ok: false, error: 'unknown-nonce' };
    h.states.delete(token);
    return { ok: true, claims: entry.claims, privateContext: entry.privateContext };
  },
}));

import callbackRoute from '../endpoint-route/routes/oauth/callback';
import { fsTokenStorage } from '../oauth/storage-fs';
import { __resetRegistryForTest } from '../oauth/providers';
import { createRequire } from 'node:module';
/** An ordinary hive harness for the fixture; nothing here depends on its name. */
const GMAIL_RESPOND_DRAFT_HARNESS = 'email';
import { providerRegistry } from './provider-registry';
import { saveOAuthClientRegistration } from './oauth-client-registration';
import { createSourceHostFetch } from './source-host-fetch';
import { settableTicketConfigKeys, summarizeIntegrationProvider } from './ticket-integrations';
import {
  adoptLegacyProviderCredentials,
  connectionAdapterFor,
  connectionAdapterForPlugin,
  connectionAccessToken,
  descriptorOAuthPlugin,
  disconnectConnection,
  missingRefreshTokenRefusal,
  refreshConnectionCredential,
} from './connection-lifecycle';

const WS = 'connection-lifecycle-test';
const HARNESS = 'papercusp';
const GROUP = 'fake-suite';
const PLUGIN = `provider:${GROUP}`;
const PROVIDER_PLUGIN_NAME = 'fake-suite-plugin';
const TOKEN_URL = 'https://auth.example-mail.test/token';
const IDENTITY_URL = 'https://api.example-mail.test/me';
const GOOGLE_PLUGIN = 'provider:google';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REQUESTED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly',
];
/** Every package in the `google` credential group, loaded from the real package sources. */
const GOOGLE_GROUP_PACKAGES = ['gmail', 'google-calendar', 'google-contacts', 'youtube'] as const;
const requirePlugin = createRequire(import.meta.url);
/** A GraphQL-shaped identity request (linear-asana-task-sync P-004): the host must POST this body. */
const IDENTITY_BODY = JSON.stringify({ query: '{ viewer { id } }' });

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

interface SourceRow {
  id: string;
  kind: string;
  providerAccountId: string;
  credentialRef: string | null;
  status: string;
  cursor: Record<string, unknown>;
  lastError: string | null;
}

const net = {
  account: { id: 'acct-1', name: 'Alpha' },
  googleEmail: 'owner@example.com',
  refreshError: null as string | null,
  tokenSeq: 0,
};

let org: OrgTestDb;
let sql: Sql;
let userId: string;
let home: string;
let stateSeq = 0;

function descriptor(id: string, datatype: string, capability: string, withIdentity: boolean): ProviderDescriptor {
  return {
    id,
    contractVersion: 1,
    datatypes: [datatype],
    capabilities: [capability],
    egressHosts: ['*.example-mail.test'],
    oauth: {
      authorizeUrl: 'https://auth.example-mail.test/authorize',
      tokenUrl: TOKEN_URL,
      scopes: [capability],
      pkce: true,
      credentialGroup: GROUP,
      ...(withIdentity ? { identity: { url: IDENTITY_URL, idField: 'id', displayNameField: 'profile.name', method: 'POST' as const, body: IDENTITY_BODY } } : {}),
    },
  };
}

function adapter(d: ProviderDescriptor): ProviderAdapter {
  return {
    describe: () => d,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async () => ({ ok: true }),
  };
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (href === TOKEN_URL) {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (form.get('grant_type') === 'refresh_token') {
      if (net.refreshError) return Response.json({ error: net.refreshError }, { status: 400 });
      return Response.json({ access_token: 'refreshed-access', expires_in: 3600 });
    }
    net.tokenSeq += 1;
    return Response.json({
      access_token: `access-${net.tokenSeq}`,
      refresh_token: `refresh-${net.tokenSeq}`,
      expires_in: 3600,
      scope: 'mail.read calendar.read',
    });
  }
  if (href === IDENTITY_URL) {
    // Answers only the declared request: POST with the descriptor's JSON body.
    if (init?.method !== 'POST' || init?.body !== IDENTITY_BODY) return new Response('method not allowed', { status: 405 });
    return Response.json({ id: net.account.id, profile: { name: net.account.name } });
  }
  if (href === GOOGLE_TOKEN_URL) {
    net.tokenSeq += 1;
    return Response.json({
      access_token: `google-access-${net.tokenSeq}`,
      refresh_token: `google-refresh-${net.tokenSeq}`,
      expires_in: 3600,
      scope: GOOGLE_REQUESTED_SCOPES.join(' '),
    });
  }
  // The group's identity is read from the declared endpoint of whichever member holds it;
  // every Google member that declares one resolves the same mailbox address here.
  if (href === 'https://www.googleapis.com/calendar/v3/calendars/primary') {
    return Response.json({ id: net.googleEmail, summary: net.googleEmail });
  }
  if (href === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return Response.json({ emailAddress: net.googleEmail });
  throw new Error(`unexpected fetch ${href}`);
}

async function runCallback(
  claims: StateClaims,
  privateContext: OAuthFlowPrivateContext,
): Promise<{ connected: string | null; error: string | null }> {
  stateSeq += 1;
  const token = `state-${stateSeq}`;
  h.states.set(token, { claims, privateContext: { ...privateContext } });
  const response = await callbackRoute.handler(
    new Request(`https://papercusp.example/api/oauth/callback?code=code-${stateSeq}&state=${token}`),
    CTX,
  );
  const location = response.headers.get('location');
  if (!location) throw new Error(`callback answered ${response.status}: ${await response.text()}`);
  const url = new URL(location);
  return { connected: url.searchParams.get('oauth_connected'), error: url.searchParams.get('oauth_error') };
}

function descriptorConnect(field: string, reconnectProviderAccountId?: string) {
  return runCallback(
    { plugin: PLUGIN, harness: HARNESS, field, provider: PLUGIN, providerHost: 'auth.example-mail.test' },
    {
      ownerUserId: userId,
      workspaceId: WS,
      codeVerifier: 'verifier-'.padEnd(60, 'x'),
      requestedScopes: JSON.stringify(['mail.read', 'calendar.read']),
      ...(reconnectProviderAccountId ? { reconnectProviderAccountId } : {}),
    },
  );
}

function googleConnect(field: string, reconnectProviderAccountId?: string) {
  return runCallback(
    { plugin: GOOGLE_PLUGIN, harness: HARNESS, field, provider: GOOGLE_PLUGIN, providerHost: 'accounts.google.com' },
    {
      ownerUserId: userId,
      workspaceId: WS,
      codeVerifier: 'verifier-'.padEnd(60, 'x'),
      requestedScopes: JSON.stringify(GOOGLE_REQUESTED_SCOPES),
      ...(reconnectProviderAccountId ? { reconnectProviderAccountId } : {}),
    },
  );
}

async function sources(kinds: string[]): Promise<SourceRow[]> {
  return sql<SourceRow[]>`
    SELECT id::text,
           kind,
           provider_account_id AS "providerAccountId",
           credential_ref AS "credentialRef",
           status,
           cursor,
           last_error AS "lastError"
      FROM harness_shared.data_sources
     WHERE workspace_id = ${WS}
       AND owner_user_id = ${userId}::uuid
       AND kind = ANY(${kinds})
     ORDER BY provider_account_id, kind`;
}

const SUITE_KINDS = ['fake-calendar', 'fake-mail'];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'connection-lifecycle-owner-' + Date.now()}, 'Lifecycle Owner')
    RETURNING id`;
  userId = users[0].id;
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${GMAIL_RESPOND_DRAFT_HARNESS}, ${Buffer.from([3])}, 'kc-connection-lifecycle', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (
      ${WS},
      ${JSON.stringify({
        projects: [{ slug: GMAIL_RESPOND_DRAFT_HARNESS, path: '/tmp/connection-lifecycle-email', harness_kind: 'hive' }],
      })}::text::jsonb
    )
    ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;

  const registry = providerRegistry();
  registry.unregisterPlugin(PROVIDER_PLUGIN_NAME);
  for (const d of [
    descriptor('fake-mail', 'email-message', 'mail.read', true),
    descriptor('fake-calendar', 'calendar-event', 'calendar.read', false),
  ]) {
    await registry.register({ descriptor: d, adapter: adapter(d), pluginName: PROVIDER_PLUGIN_NAME });
  }
  for (const pluginName of GOOGLE_GROUP_PACKAGES) {
    const packageAdapter = requirePlugin(`../../../../libs/papercusp/plugins/${pluginName}/index.cjs`).providerAdapter as ProviderAdapter;
    const d = await packageAdapter.describe();
    registry.unregister(d.id);
    await registry.register({ descriptor: d, adapter: packageAdapter, pluginName });
  }
}, 180_000);

afterAll(async () => {
  providerRegistry().unregisterPlugin(PROVIDER_PLUGIN_NAME);
  for (const pluginName of GOOGLE_GROUP_PACKAGES) providerRegistry().unregisterPlugin(pluginName);
  await org?.cleanup();
}, 300_000);

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-connection-lifecycle-'));
  process.env.PAPERCUSP_HOME = home;
  await fs.writeFile(
    join(home, 'oauth-apps.json'),
    JSON.stringify({
      [GROUP]: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://papercusp.example/api/oauth/callback' },
      // The Google packages' clientRegistrationRef.
      google: { clientId: 'google-client', clientSecret: 'google-secret', redirectUri: 'https://papercusp.example/api/oauth/callback' },
    }),
  );
  __resetRegistryForTest();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  net.account = { id: 'acct-1', name: 'Alpha' };
  net.googleEmail = 'owner@example.com';
  net.refreshError = null;
  net.tokenSeq = 0;
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  __resetRegistryForTest();
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe('descriptor credential group through the real OAuth callback', () => {
  it('reauthorization is explicit for every group member, and expired grants stop syncing', async () => {
    const registry = providerRegistry();
    const originals = registry.list().filter((entry) => entry.pluginName === PROVIDER_PLUGIN_NAME);
    const tokens = { accessToken: 'manual-access', expiresAt: Date.now() + 3600000 };
    const owner = { workspaceId: WS, ownerUserId: userId, reconnectProviderAccountId: null };
    const reset = async (manual: boolean) => {
      registry.unregisterPlugin(PROVIDER_PLUGIN_NAME);
      for (const entry of originals) {
        const d = { ...entry.descriptor, oauth: { ...entry.descriptor.oauth!, ...(manual ? { refreshPolicy: 'reauthorize' as const } : {}) } };
        await registry.register({ descriptor: d, adapter: adapter(d), pluginName: PROVIDER_PLUGIN_NAME });
      }
    };
    try {
      expect(missingRefreshTokenRefusal(connectionAdapterForPlugin(PLUGIN)!, owner, [], tokens)).toBe('provider_fake_suite_refresh_token_missing');
      await reset(true);
      expect(missingRefreshTokenRefusal(connectionAdapterForPlugin(PLUGIN)!, owner, [], tokens)).toBeNull();
      const [source] = await sql<{ id: string }[]>`INSERT INTO harness_shared.data_sources
        (workspace_id, kind, owner_user_id, provider_account_id, credential_ref, status)
        VALUES (${WS}, 'fake-mail', ${userId}, 'manual-account', ${PLUGIN + ':manual'}, 'connected') RETURNING id::text`;
      await fsTokenStorage.update(PLUGIN, HARNESS, { manual: tokens.accessToken, manual_expires_at: tokens.expiresAt });
      await expect(connectionAccessToken(sql, { workspaceId: WS, harness: HARNESS, credentialRef: PLUGIN + ':manual' }))
        .resolves.toEqual({ accessToken: 'manual-access' });
      await expect(connectionAccessToken(sql, { workspaceId: WS, harness: HARNESS, credentialRef: PLUGIN + ':manual', now: tokens.expiresAt + 1 }))
        .resolves.toMatchObject({ reconnectRequired: true, reason: 'provider_fake_suite_refresh_token_missing' });
      const [row] = await sql<{ status: string }[]>`SELECT status FROM harness_shared.data_sources WHERE id = ${source.id}::uuid`;
      expect(row.status).toBe('reconnect_required');
      // Mixing a normal member into a manual group preserves the stricter contract.
      const first = originals[0];
      registry.unregister(first.descriptor.id);
      await registry.register(first);
      expect(connectionAdapterForPlugin(PLUGIN)!.requiresRefreshToken(tokens)).toBe(true);
    } finally {
      await reset(false);
    }
  });

  it('derives one adapter per credential group, bound to its own provider id', () => {
    const adapter = connectionAdapterForPlugin(PLUGIN);
    expect(adapter).toMatchObject({ oauthPlugin: PLUGIN, oauthProviderId: PLUGIN, errorPrefix: 'provider_fake_suite' });
    expect([...adapter!.sourceKinds].sort()).toEqual(SUITE_KINDS);
    expect(connectionAdapterFor(PLUGIN, 'google')).toBeNull();
  });

  it('connects one shared credential and provisions a connected source per group member for the consented account', async () => {
    await expect(descriptorConnect('slot-a')).resolves.toEqual({ connected: PLUGIN, error: null });
    const rows = await sources(SUITE_KINDS);
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'fake-calendar', providerAccountId: 'acct-1', credentialRef: `${PLUGIN}:slot-a`, status: 'connected' }),
      expect.objectContaining({ kind: 'fake-mail', providerAccountId: 'acct-1', credentialRef: `${PLUGIN}:slot-a`, status: 'connected' }),
    ]);
    const stored = await fsTokenStorage.read(PLUGIN, HARNESS);
    expect(stored).toMatchObject({
      'slot-a': 'access-1',
      'slot-a_refresh': 'refresh-1',
      'slot-a_expired': false,
      'slot-a_scopes': ['mail.read', 'calendar.read'],
    });
    // The identity endpoint was called by the host with the fresh token; the provider never received it.
    const identityCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input instanceof URL ? input.href : input) === IDENTITY_URL);
    expect(identityCall?.[1]).toMatchObject({
      method: 'POST',
      body: IDENTITY_BODY,
      headers: { authorization: 'Bearer access-1', 'content-type': 'application/json' },
    });
  });

  it('keeps source ids and cursors when the same account reconnects', async () => {
    await descriptorConnect('slot-a');
    const before = await sources(SUITE_KINDS);
    await sql`UPDATE harness_shared.data_sources SET cursor = '{"page":"p-7"}'::jsonb WHERE id = ${before[1].id}::uuid`;

    await expect(descriptorConnect('slot-a', 'acct-1')).resolves.toEqual({ connected: PLUGIN, error: null });
    const after = await sources(SUITE_KINDS);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after[1]).toMatchObject({ cursor: { page: 'p-7' }, status: 'connected', credentialRef: `${PLUGIN}:slot-a` });
    await expect(fsTokenStorage.read(PLUGIN, HARNESS)).resolves.toMatchObject({ 'slot-a': 'access-2' });
  });

  it('refuses a reconnect that authenticates a different account and leaves the original binding alone', async () => {
    await descriptorConnect('slot-a');
    net.account = { id: 'acct-other', name: 'Other' };
    await expect(descriptorConnect('slot-a', 'acct-1')).resolves.toEqual({
      connected: null,
      error: 'provider_fake_suite_account_mismatch',
    });
    const rows = await sources(SUITE_KINDS);
    expect(rows.map((row) => row.providerAccountId)).toEqual(['acct-1', 'acct-1']);
    await expect(fsTokenStorage.read(PLUGIN, HARNESS)).resolves.toMatchObject({ 'slot-a': 'access-1' });
  });

  it('adds a second account as its own sources and credential, and refuses re-adding a connected account', async () => {
    await descriptorConnect('slot-a');
    net.account = { id: 'acct-2', name: 'Beta' };
    await expect(descriptorConnect('slot-b')).resolves.toEqual({ connected: PLUGIN, error: null });
    const rows = await sources(SUITE_KINDS);
    expect(rows.map((row) => [row.providerAccountId, row.kind, row.credentialRef])).toEqual([
      ['acct-1', 'fake-calendar', `${PLUGIN}:slot-a`],
      ['acct-1', 'fake-mail', `${PLUGIN}:slot-a`],
      ['acct-2', 'fake-calendar', `${PLUGIN}:slot-b`],
      ['acct-2', 'fake-mail', `${PLUGIN}:slot-b`],
    ]);

    net.account = { id: 'acct-1', name: 'Alpha' };
    await expect(descriptorConnect('slot-c')).resolves.toEqual({
      connected: null,
      error: 'provider_fake_suite_account_already_connected',
    });
    expect(await sources(SUITE_KINDS)).toHaveLength(4);
  });

  it('disconnects one account: sync stops and tokens clear, but source ids, cursors and the other account remain', async () => {
    await descriptorConnect('slot-a');
    net.account = { id: 'acct-2', name: 'Beta' };
    await descriptorConnect('slot-b');
    const before = await sources(SUITE_KINDS);
    await sql`UPDATE harness_shared.data_sources SET cursor = '{"page":"p-3"}'::jsonb WHERE id = ${before[0].id}::uuid`;

    const adapter = connectionAdapterForPlugin(PLUGIN)!;
    await expect(
      disconnectConnection(sql, adapter, { workspaceId: WS, ownerUserId: userId, providerAccountId: 'acct-1', harness: HARNESS }),
    ).resolves.toEqual({ sources: 2, clearedFields: ['slot-a'] });

    const after = await sources(SUITE_KINDS);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => [row.providerAccountId, row.status])).toEqual([
      ['acct-1', 'disabled'],
      ['acct-1', 'disabled'],
      ['acct-2', 'connected'],
      ['acct-2', 'connected'],
    ]);
    expect(after[0].cursor).toEqual({ page: 'p-3' });
    const stored = await fsTokenStorage.read(PLUGIN, HARNESS);
    expect(stored).toMatchObject({ 'slot-a': null, 'slot-a_refresh': null, 'slot-a_expired': true, 'slot-b': 'access-2' });
  });

  it('moves every source on a revoked credential to reconnect_required, and a reconnect restores them in place', async () => {
    await descriptorConnect('slot-a');
    const before = await sources(SUITE_KINDS);
    const adapter = connectionAdapterForPlugin(PLUGIN)!;

    await expect(refreshConnectionCredential(sql, adapter, { workspaceId: WS, harness: HARNESS, field: 'slot-a' })).resolves.toEqual({
      ok: true,
      accessToken: 'refreshed-access',
    });

    net.refreshError = 'invalid_grant';
    await expect(refreshConnectionCredential(sql, adapter, { workspaceId: WS, harness: HARNESS, field: 'slot-a' })).resolves.toMatchObject({
      ok: false,
      reconnectRequired: true,
    });
    const revoked = await sources(SUITE_KINDS);
    expect(revoked.map((row) => row.status)).toEqual(['reconnect_required', 'reconnect_required']);
    expect(revoked[0].lastError).toMatch(/invalid_grant/);
    await expect(fsTokenStorage.read(PLUGIN, HARNESS)).resolves.toMatchObject({ 'slot-a_expired': true });

    net.refreshError = null;
    await expect(descriptorConnect('slot-a', 'acct-1')).resolves.toEqual({ connected: PLUGIN, error: null });
    const restored = await sources(SUITE_KINDS);
    expect(restored.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(restored.map((row) => [row.status, row.lastError])).toEqual([
      ['connected', null],
      ['connected', null],
    ]);
  });

  it('a non-revocation refresh failure throws instead of demanding a reconnect', async () => {
    await descriptorConnect('slot-a');
    net.refreshError = 'temporarily_unavailable';
    await expect(
      refreshConnectionCredential(sql, connectionAdapterForPlugin(PLUGIN)!, { workspaceId: WS, harness: HARNESS, field: 'slot-a' }),
    ).rejects.toThrow(/temporarily_unavailable/);
    expect((await sources(SUITE_KINDS)).map((row) => row.status)).toEqual(['connected', 'connected']);
  });
});

describe('instance-scoped providers through the real OAuth callback and source fetch', () => {
  it('keeps two equal local account IDs separate and pins old refresh credentials after changing the selected instance', async () => {
    const d: ProviderDescriptor = { id: 'instance-fixture', contractVersion: 1, datatypes: ['social-post'], capabilities: [], egressHosts: [],
      oauth: { instance: true, userAgentRequired: true, authorizeUrl: '/oauth/authorize', tokenUrl: '/oauth/token', scopes: ['read'],
        identity: { url: '/api/v1/me', idField: 'id', displayNameField: 'name' } },
      configSchema: { type: 'object', properties: { connectionOrigin: { type: 'string' }, connectionAccountId: { type: 'string' }, label: { type: 'string' } } },
    };
    const registry = providerRegistry();
    const entry = await registry.register({ descriptor: d, adapter: adapter(d), pluginName: PROVIDER_PLUGIN_NAME });
    expect(summarizeIntegrationProvider(entry, [], { ref: d.id, origin: 'https://first.example.com', configured: true,
      clientId: 'legacy', hasClientSecret: true, redirectUri: 'https://operator.example.com/api/oauth/callback', savedAt: null }).oauthClient)
      .toMatchObject({ configured: false, userAgentRequired: true });
    const tokenRequests: Array<{ origin: string; client: string | null; secret: string | null; refresh: string | null; redirect: RequestRedirect | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('user-agent')).toBe(`${url.hostname}-app/1.0`);
      if (url.pathname === '/api/v1/me') return Response.json({ id: '42', name: url.hostname });
      if (url.pathname !== '/oauth/token') throw new Error('unexpected instance endpoint');
      const form = new URLSearchParams(String(init?.body));
      tokenRequests.push({ origin: url.origin, client: form.get('client_id'), secret: form.get('client_secret'), refresh: form.get('refresh_token'), redirect: init?.redirect });
      return Response.json({ access_token: `${url.hostname}-access`, refresh_token: `${url.hostname}-refresh`, expires_in: 3600 });
    }));
    try {
      const firstOrigin = 'https://first.example.com'; const secondOrigin = 'https://second.example.com';
      for (const [origin, slot] of [[firstOrigin, 'first'], [secondOrigin, 'second']]) {
        const status = await saveOAuthClientRegistration(d.id, { origin, clientId: `${slot}-client`, clientSecret: `${slot}-secret`, userAgent: `${new URL(origin).hostname}-app/1.0` }, { requireSecret: true, requireOrigin: true, requireUserAgent: true });
        const model = summarizeIntegrationProvider(entry, [], status);
        expect(model.oauthClient).toMatchObject({ configured: true, userAgent: `${new URL(origin).hostname}-app/1.0`, userAgentRequired: true });
        const plugin = descriptorOAuthPlugin(d, origin);
        expect(new URL(model.connectHref!, 'https://operator.example.com').searchParams.get('provider')).toBe(plugin);
        const claims = { plugin, provider: plugin, providerHost: new URL(origin).hostname, harness: HARNESS, field: slot };
        await expect(runCallback(claims, { ownerUserId: userId, workspaceId: WS })).resolves.toEqual({ connected: plugin, error: null });
      }
      const rows = await sql<Array<{ id: string; provider_account_id: string; config: Record<string, unknown> }>>`
        SELECT id::text, provider_account_id, config FROM harness_shared.data_sources
         WHERE workspace_id = ${WS} AND kind = ${d.id} ORDER BY provider_account_id`;
      expect(rows.map((row) => [row.provider_account_id, row.config.connectionOrigin, row.config.connectionAccountId])).toEqual([
        ['first.example.com:42', firstOrigin, '42'], ['second.example.com:42', secondOrigin, '42'],
      ]);
      expect(settableTicketConfigKeys(d.configSchema!)).toEqual(['label', 'harnessSlug']);
      const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => Response.json([]));
      const host = createSourceHostFetch(sql, { providerId: d.id, workspaceId: WS, harness: HARNESS, sourceIds: [rows[0].id], fetchImpl });
      await expect(host({ source: rows[0].id, request: { url: `${secondOrigin}/api/v1/timelines/home` } })).rejects.toMatchObject({ code: 'egress-denied' });
      expect(fetchImpl).not.toHaveBeenCalled();
      const firstPlugin = descriptorOAuthPlugin(d, firstOrigin);
      await fsTokenStorage.update(firstPlugin, HARNESS, { first_expires_at: Date.now() - 60_000 });
      await host({ source: rows[0].id, request: { url: `${firstOrigin}/api/v1/timelines/home`, headers: { 'user-agent': 'package-cannot-override' } } });
      expect(tokenRequests.at(-1)).toEqual({ origin: firstOrigin, client: 'first-client', secret: 'first-secret', refresh: 'first.example.com-refresh', redirect: 'manual' });
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer first.example.com-access');
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('user-agent')).toBe('first.example.com-app/1.0');
      // Even a corrupted persisted origin cannot move the existing credential to another server.
      await sql`UPDATE harness_shared.data_sources SET config = jsonb_set(config, '{connectionOrigin}', ${JSON.stringify(secondOrigin)}::text::jsonb) WHERE id = ${rows[0].id}::uuid`;
      await expect(host({ source: rows[0].id, request: { url: `${secondOrigin}/api/v1/timelines/home` } })).rejects.toMatchObject({ code: 'token-unavailable' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { registry.unregister(d.id); }
  });
});

describe('the Google package group through the same lifecycle', () => {
  const GOOGLE_KINDS = ['contacts', 'gcal', 'gmail', 'youtube'];

  async function googleBindings(): Promise<Array<{ kind: string; armed: boolean }>> {
    return sql<Array<{ kind: string; armed: boolean }>>`
      SELECT source.kind, binding.armed
        FROM harness_shared.trigger_bindings AS binding
        JOIN harness_shared.data_sources AS source ON source.id = binding.source_id
       WHERE binding.workspace_id = ${WS} AND source.kind = ANY(${GOOGLE_KINDS})`;
  }

  // Connect creates NO binding on any Google source. Gmail: plan
  // generalized-integrations-google-migration-cupboard-workflows-2026-10-05
  // D-019.3 (a draft responder is opt-in through the email-draft-responder
  // trigger pack). Calendar: plan app-agent-tasks-durable-execution-2026-10-06
  // D-011 (meeting prep is submitted by the Calendar app itself; the built-in
  // launch-plan binding is retired, EI-25243055141955619). A binding count above
  // zero after connect or reconnect is the regression this guards.
  it('shares one credential across every Google package and creates no binding on connect or reconnect', async () => {
    await expect(googleConnect('owner-slot')).resolves.toEqual({ connected: GOOGLE_PLUGIN, error: null });
    const first = await sources(GOOGLE_KINDS);
    expect(first.map((row) => [row.kind, row.providerAccountId, row.credentialRef, row.status])).toEqual(
      GOOGLE_KINDS.map((kind) => [kind, 'owner@example.com', 'provider:google:owner-slot', 'connected']),
    );
    expect(await googleBindings()).toEqual([]);
    const tokens = await fsTokenStorage.read(GOOGLE_PLUGIN, HARNESS);
    expect(tokens['owner-slot']).toBe('google-access-1');
    expect(tokens['owner-slot_refresh']).toBe('google-refresh-1');

    await expect(googleConnect('owner-slot', 'owner@example.com')).resolves.toEqual({
      connected: GOOGLE_PLUGIN,
      error: null,
    });
    const second = await sources(GOOGLE_KINDS);
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(await googleBindings()).toEqual([]);
  });

  it('refuses a Google reconnect that signs in to a different mailbox', async () => {
    await googleConnect('owner-slot');
    net.googleEmail = 'someone-else@example.com';
    await expect(googleConnect('owner-slot', 'owner@example.com')).resolves.toEqual({
      connected: null,
      error: 'provider_google_account_mismatch',
    });
  });
});

// provider-adapters-to-packages-2026-10-11 D-037: the credentials the first-party
// `google-workspace` connection stored move into the descriptor group plugin the Google
// packages declare (`oauth.legacyCredentialPlugins`), and the source rows follow them.
describe('legacy credential adoption into the descriptor group plugin', () => {
  const LEGACY = 'google-workspace';
  const OTHER_WS = `${WS}-other`;

  async function sourceRow(workspaceId: string, kind: string, providerAccountId: string, credentialRef: string) {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.data_sources
        (workspace_id, kind, owner_user_id, provider_account_id, status, credential_ref)
      VALUES (${workspaceId}, ${kind}, ${userId}, ${providerAccountId}, 'connected', ${credentialRef})
      RETURNING id`;
    return row.id;
  }

  async function refs(ids: string[]) {
    const rows = await sql<Array<{ id: string; credential_ref: string | null; provider_account_id: string | null }>>`
      SELECT id, credential_ref, provider_account_id FROM harness_shared.data_sources WHERE id = ANY(${ids})`;
    return ids.map((id) => {
      const row = rows.find((candidate) => candidate.id === id)!;
      return [row.credential_ref, row.provider_account_id];
    });
  }

  it('copies tokens, rewrites refs and provisional ids, clears the legacy fields, and is idempotent', async () => {
    await fsTokenStorage.update(LEGACY, HARNESS, {
      'slot-l': 'legacy-access',
      'slot-l_refresh': 'legacy-refresh',
      'slot-l_expires_at': 1_700_000_000_000,
    });
    // A field the descriptor plugin already holds is never overwritten by the legacy copy.
    await fsTokenStorage.update(GOOGLE_PLUGIN, HARNESS, { 'slot-l_refresh': 'descriptor-refresh' });
    const gmail = await sourceRow(WS, 'gmail', 'owner@example.com', `${LEGACY}:slot-l`);
    const contacts = await sourceRow(WS, 'contacts', `${LEGACY}:pending-1`, `${LEGACY}:slot-l`);
    const unrelated = await sourceRow(WS, 'gcal', 'owner@example.com', `${PLUGIN}:slot-x`);
    const foreign = await sourceRow(OTHER_WS, 'gmail', 'owner@example.com', `${LEGACY}:slot-l`);
    try {
      await expect(adoptLegacyProviderCredentials(sql, { workspaceId: WS, harness: HARNESS })).resolves.toEqual([
        { legacyPlugin: LEGACY, plugin: GOOGLE_PLUGIN, fieldsCopied: 2, sourcesRewritten: 2 },
      ]);
      const adopted = await fsTokenStorage.read(GOOGLE_PLUGIN, HARNESS);
      expect(adopted).toMatchObject({
        'slot-l': 'legacy-access',
        'slot-l_refresh': 'descriptor-refresh',
        'slot-l_expires_at': 1_700_000_000_000,
      });
      const legacy = await fsTokenStorage.read(LEGACY, HARNESS);
      for (const key of ['slot-l', 'slot-l_refresh', 'slot-l_expires_at']) expect(legacy[key] ?? null).toBeNull();
      expect(await refs([gmail, contacts, unrelated, foreign])).toEqual([
        [`${GOOGLE_PLUGIN}:slot-l`, 'owner@example.com'],
        [`${GOOGLE_PLUGIN}:slot-l`, `${GOOGLE_PLUGIN}:pending-1`],
        [`${PLUGIN}:slot-x`, 'owner@example.com'],
        // Another workspace's rows are its own sync's to adopt.
        [`${LEGACY}:slot-l`, 'owner@example.com'],
      ]);

      // A second pass has nothing left to move and changes nothing.
      await expect(adoptLegacyProviderCredentials(sql, { workspaceId: WS, harness: HARNESS })).resolves.toEqual([]);
      expect(await fsTokenStorage.read(GOOGLE_PLUGIN, HARNESS)).toEqual(adopted);
      expect((await refs([gmail, contacts]))).toEqual([
        [`${GOOGLE_PLUGIN}:slot-l`, 'owner@example.com'],
        [`${GOOGLE_PLUGIN}:slot-l`, `${GOOGLE_PLUGIN}:pending-1`],
      ]);
    } finally {
      await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${OTHER_WS}`;
    }
  });
});
