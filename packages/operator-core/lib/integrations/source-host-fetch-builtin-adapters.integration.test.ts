/**
 * WI-10006541 regression — a process that has never served an OAuth route must
 * still resolve first-party (Google) source tokens through the production
 * host.fetch.
 *
 * The connector sync driver failed every Google source with
 * `host.fetch: no access token for source "…"` because the google-workspace
 * connection adapter was registered only by the OAuth start/callback routes.
 * This file deliberately imports NO OAuth route module: importing one registers
 * the built-in adapters as a side effect, which is exactly what hid the defect
 * from connection-lifecycle.integration.test.ts.
 *
 * The second case covers the same defect one step later: once the adapter
 * resolved, an EXPIRED token failed with
 * `google_workspace_oauth_provider_not_registered`, because the `google` OAuth
 * provider was loaded from its client file only by OAuth routes and the
 * retired legacy Google poll routines.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { GOOGLE_WORKSPACE_OAUTH_PLUGIN } from '../external-triggers/google-workspace';
import { __resetRegistryForTest, getProvider } from '../oauth/providers';
import { connectionAdapterForPlugin } from './connection-lifecycle';
import { providerSetupStoreKey } from './provider-credentials';
import { providerRegistry } from './provider-registry';
import { createSourceHostFetch } from './source-host-fetch';

const WS = 'source-host-fetch-builtin-test';
const HARNESS = 'papercusp';
const PLUGIN_NAME = 'source-host-fetch-builtin-test-plugin';
const PROVIDER_ID = 'gcal';
const FIELD = 'owner-fixture-account';
const STORED_TOKEN = 'stored-google-access-token';
const EXPIRED_FIELD = 'expired-fixture-account';
const REFRESH_TOKEN = 'google-refresh-token-fixture';
const REFRESHED_TOKEN = 'refreshed-google-access-token';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const descriptor: ProviderDescriptor = {
  id: PROVIDER_ID,
  contractVersion: 1,
  datatypes: ['calendar-event'],
  capabilities: ['calendar.read'],
  egressHosts: ['www.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com'],
  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    pkce: true,
  },
};

const adapter: ProviderAdapter = {
  describe: () => descriptor,
  syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
  invoke: async () => ({ ok: true }),
};

let org: OrgTestDb;
let sql: Sql;
let home: string;
let previousHome: string | undefined;
let previousOsHome: string | undefined;
let previousRedirect: string | undefined;
let sourceId: string;
let expiredSourceId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;

  previousHome = process.env.PAPERCUSP_HOME;
  previousOsHome = process.env.HOME;
  previousRedirect = process.env.PAPERCUSP_GOOGLE_OAUTH_REDIRECT_URI;
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-source-host-fetch-builtin-'));
  process.env.PAPERCUSP_HOME = home;
  // The Google Desktop client file lives under the OS home directory; point it
  // at the fixture so the test never reads the developer's real credential.
  process.env.HOME = home;
  process.env.PAPERCUSP_GOOGLE_OAUTH_REDIRECT_URI = 'http://127.0.0.1:3070/api/oauth/callback';
  await fs.mkdir(join(home, '.config', 'papercusp'), { recursive: true });
  await fs.writeFile(
    join(home, '.config', 'papercusp', 'google-oauth-client.json'),
    JSON.stringify({ installed: { client_id: 'fixture-client', client_secret: 'fixture-secret', token_uri: GOOGLE_TOKEN_URL } }),
  );
  const configDir = join(home, 'harnesses', HARNESS, 'plugin-configs');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    join(configDir, `${GOOGLE_WORKSPACE_OAUTH_PLUGIN}.json`),
    JSON.stringify({
      [FIELD]: STORED_TOKEN,
      [`${FIELD}_expires_at`]: Date.now() + 3_600_000,
      [EXPIRED_FIELD]: 'expired-google-access-token',
      [`${EXPIRED_FIELD}_expires_at`]: Date.now() - 60_000,
      [`${EXPIRED_FIELD}_refresh`]: REFRESH_TOKEN,
    }),
  );

  // Mirrors the live failing source (personal scope, owned): a personal
  // data source requires owner_user_id (data_sources_personal_owner_chk).
  const ownerUserId = randomUUID();
  await sql`
    INSERT INTO harness_shared.users (id, username, display_name)
    VALUES (${ownerUserId}, ${`source-host-fetch-${ownerUserId}`}, 'Source host fetch owner')`;

  sourceId = randomUUID();
  await sql`
    INSERT INTO harness_shared.data_sources
      (workspace_id, id, kind, sync_mode, scope, status, credential_ref, owner_user_id, provider_account_id)
    VALUES
      (${WS}, ${sourceId}, ${PROVIDER_ID}, 'poll', 'personal', 'connected',
       ${`${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:${FIELD}`}, ${ownerUserId}, 'owner@example.com')`;

  expiredSourceId = randomUUID();
  await sql`
    INSERT INTO harness_shared.data_sources
      (workspace_id, id, kind, sync_mode, scope, status, credential_ref, owner_user_id, provider_account_id)
    VALUES
      (${WS}, ${expiredSourceId}, ${PROVIDER_ID}, 'poll', 'personal', 'connected',
       ${`${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:${EXPIRED_FIELD}`}, ${ownerUserId}, 'expired@example.com')`;

  const registry = providerRegistry();
  registry.unregisterPlugin(PLUGIN_NAME);
  await registry.register({ descriptor, adapter, pluginName: PLUGIN_NAME });
}, 180_000);

afterAll(async () => {
  providerRegistry().unregisterPlugin(PLUGIN_NAME);
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousHome;
  if (previousOsHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousOsHome;
  if (previousRedirect === undefined) delete process.env.PAPERCUSP_GOOGLE_OAUTH_REDIRECT_URI;
  else process.env.PAPERCUSP_GOOGLE_OAUTH_REDIRECT_URI = previousRedirect;
  await fs.rm(home, { recursive: true, force: true });
  await org?.cleanup();
}, 300_000);

describe('production host.fetch in a process that never served an OAuth route', () => {
  it('injects the stored Google token for a google-workspace credential ref', async () => {
    // Precondition: nothing in this process has registered the built-in
    // adapters, so this reproduces the connector driver's fresh process.
    expect(connectionAdapterForPlugin(GOOGLE_WORKSPACE_OAUTH_PLUGIN)).toBeNull();

    const seen: Array<string | null> = [];
    const hostFetch = createSourceHostFetch(sql, {
      providerId: PROVIDER_ID,
      workspaceId: WS,
      harness: HARNESS,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ items: [] });
      }) as typeof fetch,
    });

    const response = await hostFetch({
      source: sourceId,
      request: { url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events', method: 'GET' },
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([`Bearer ${STORED_TOKEN}`]);
  });

  it('refreshes an expired Google token without an OAuth route having loaded the provider', async () => {
    // Precondition: the `google` OAuth provider is not registered, as in a
    // bg-host that has never served an OAuth route.
    __resetRegistryForTest();
    expect(getProvider('google')).toBeNull();

    const tokenRequests: string[] = [];
    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (href !== GOOGLE_TOKEN_URL) throw new Error(`unexpected global fetch: ${href}`);
      tokenRequests.push(String(init?.body));
      return Response.json({ access_token: REFRESHED_TOKEN, expires_in: 3600 });
    }) as typeof fetch);

    const seen: Array<string | null> = [];
    const hostFetch = createSourceHostFetch(sql, {
      providerId: PROVIDER_ID,
      workspaceId: WS,
      harness: HARNESS,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ items: [] });
      }) as typeof fetch,
    });

    try {
      const response = await hostFetch({
        source: expiredSourceId,
        request: { url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events', method: 'GET' },
      });
      expect(response.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(tokenRequests).toHaveLength(1);
    expect(new URLSearchParams(tokenRequests[0]).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(tokenRequests[0]).get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(seen).toEqual([`Bearer ${REFRESHED_TOKEN}`]);
  });
});

// WI-6554700010008555: Asana declares a pasted personal access token as an ALTERNATIVE to OAuth,
// on the same host. Declaring it cut the owner's OAuth-connected Asana source off from its own
// account ("Personal access token ... is not set up"). Each source must get its own credential.
describe('production host.fetch for a provider offering OAuth and a pasted credential on one host', () => {
  const PAT_PROVIDER_ID = 'gcal-pat-alternative';
  const PAT_PLUGIN_NAME = 'source-host-fetch-pat-alternative-plugin';
  const OWN_FIELD = 'pat-alternative-oauth-account';
  const OWN_TOKEN = 'own-oauth-access-token';
  const PASTED = 'pasted-personal-access-token';
  const patDescriptor: ProviderDescriptor = {
    ...descriptor,
    id: PAT_PROVIDER_ID,
    setup: {
      credentials: [{ key: 'personal_access_token', label: 'Personal access token', hosts: ['www.googleapis.com'] }],
    },
  };
  let oauthSourceId: string;
  let pastedSourceId: string;

  beforeAll(async () => {
    const configDir = join(home, 'harnesses', HARNESS, 'plugin-configs');
    const tokenFile = join(configDir, `${GOOGLE_WORKSPACE_OAUTH_PLUGIN}.json`);
    const tokens = JSON.parse(await fs.readFile(tokenFile, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(
      tokenFile,
      JSON.stringify({ ...tokens, [OWN_FIELD]: OWN_TOKEN, [`${OWN_FIELD}_expires_at`]: Date.now() + 3_600_000 }),
    );
    await fs.writeFile(
      join(configDir, `${providerSetupStoreKey(PAT_PROVIDER_ID)}.json`),
      JSON.stringify({ personal_access_token: PASTED }),
    );
    const ownerUserId = randomUUID();
    await sql`
      INSERT INTO harness_shared.users (id, username, display_name)
      VALUES (${ownerUserId}, ${`source-host-fetch-pat-${ownerUserId}`}, 'PAT alternative owner')`;
    oauthSourceId = randomUUID();
    pastedSourceId = randomUUID();
    await sql`
      INSERT INTO harness_shared.data_sources
        (workspace_id, id, kind, sync_mode, scope, status, credential_ref, owner_user_id, provider_account_id)
      VALUES
        (${WS}, ${oauthSourceId}, ${PAT_PROVIDER_ID}, 'poll', 'personal', 'connected',
         ${`${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:${OWN_FIELD}`}, ${ownerUserId}, 'oauth@example.com'),
        (${WS}, ${pastedSourceId}, ${PAT_PROVIDER_ID}, 'poll', 'personal', 'connected',
         ${providerSetupStoreKey(PAT_PROVIDER_ID)}, ${ownerUserId}, 'pasted@example.com')`;
    const registry = providerRegistry();
    registry.unregisterPlugin(PAT_PLUGIN_NAME);
    await registry.register({ descriptor: patDescriptor, adapter: { ...adapter, describe: () => patDescriptor }, pluginName: PAT_PLUGIN_NAME });
  });

  afterAll(() => {
    providerRegistry().unregisterPlugin(PAT_PLUGIN_NAME);
  });

  async function authorizationFor(source: string): Promise<Array<string | null>> {
    const seen: Array<string | null> = [];
    const hostFetch = createSourceHostFetch(sql, {
      providerId: PAT_PROVIDER_ID,
      workspaceId: WS,
      harness: HARNESS,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ items: [] });
      }) as typeof fetch,
    });
    const response = await hostFetch({
      source,
      request: { url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events', method: 'GET' },
    });
    expect(response.status).toBe(200);
    return seen;
  }

  it('sends an OAuth-connected source its own token, not the pasted credential', async () => {
    expect(await authorizationFor(oauthSourceId)).toEqual([`Bearer ${OWN_TOKEN}`]);
  });

  it('sends the pasted-credential source the pasted value', async () => {
    expect(await authorizationFor(pastedSourceId)).toEqual([`Bearer ${PASTED}`]);
  });
});
