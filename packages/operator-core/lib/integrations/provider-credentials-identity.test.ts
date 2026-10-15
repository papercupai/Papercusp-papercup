/**
 * A pasted credential names the account it belongs to (cupboard-distributable-integrations-
 * 2026-10-10 D-016, SPEC-R-2-P-010): when the package declares an identity endpoint on a host the
 * credential is scoped to, connecting the source asks that endpoint with the credential and stores
 * the account's display name where the generic card reads it (`config.accountLabel`).
 *
 * The identity endpoint is the only faked edge; the source write is a spy on the store seam.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';
import type postgres from 'postgres';
import type { TokenStorage } from '../oauth/token';

const store = vi.hoisted(() => ({
  upsertOwnedExternalTriggerSource: vi.fn(),
  disconnectOwnedExternalTriggerSources: vi.fn(),
}));
vi.mock('../external-triggers/source-store', async (importActual) => ({
  ...(await importActual<typeof import('../external-triggers/source-store')>()),
  upsertOwnedExternalTriggerSource: store.upsertOwnedExternalTriggerSource,
  disconnectOwnedExternalTriggerSources: store.disconnectOwnedExternalTriggerSources,
}));

import { providerCredentialStatus, saveProviderCredentials, syncProviderCredentialSource } from './provider-credentials';
import { fetchProviderIdentity } from './provider-identity';

const TOKEN = 'pat-fixture-SECRETTOKEN';
const OWNER = { workspaceId: 'workspace', ownerUserId: '00000000-0000-4000-8000-000000000001' };

const descriptor: ProviderDescriptor = {
  id: 'example-tickets',
  contractVersion: 1,
  datatypes: ['ticket'],
  capabilities: ['ticket.create'],
  egressHosts: ['api.example.com'],
  oauth: {
    authorizeUrl: 'https://example.com/login/oauth/authorize',
    tokenUrl: 'https://example.com/login/oauth/access_token',
    scopes: [],
    identity: { url: 'https://api.example.com/user', idField: 'id', displayNameField: 'login' },
  } as ProviderDescriptor['oauth'],
  setup: {
    credentials: [{ key: 'personal_access_token', label: 'Personal access token', pattern: 'pat-[A-Za-z0-9-]+', hosts: ['api.example.com'] }],
  },
};

function memoryStorage(): TokenStorage {
  const data = new Map<string, Record<string, unknown>>();
  return {
    async read(plugin, harness) {
      return { ...(data.get(`${harness}/${plugin}`) ?? {}) };
    },
    async update(plugin, harness, patch) {
      data.set(`${harness}/${plugin}`, { ...(data.get(`${harness}/${plugin}`) ?? {}), ...patch });
    },
  };
}

/** The identity endpoint: answers the account for TOKEN, refuses anything else. */
function identityEndpoint(body: unknown = { id: 583231, login: 'octocat' }) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    if (String(input) !== 'https://api.example.com/user') return new Response('{}', { status: 404 });
    if (auth !== `Bearer ${TOKEN}`) return new Response('{"message":"Bad credentials"}', { status: 401 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const sql = vi.fn(async () => []) as unknown as postgres.Sql & ReturnType<typeof vi.fn>;

async function connect(storage: TokenStorage, fetchImpl: typeof fetch) {
  await saveProviderCredentials(descriptor, 'papercusp', { personal_access_token: TOKEN }, { storage });
  const credentials = await providerCredentialStatus(descriptor, 'papercusp', storage);
  return syncProviderCredentialSource(sql, OWNER, descriptor, credentials, { harness: 'papercusp', storage, fetchImpl });
}

beforeEach(() => {
  store.upsertOwnedExternalTriggerSource.mockReset().mockResolvedValue({ id: '00000000-0000-4000-8000-0000000000s1' });
  store.disconnectOwnedExternalTriggerSources.mockReset().mockResolvedValue(undefined);
  (sql as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe('a pasted credential names its account', () => {
  it('asks the declared identity endpoint with the credential and stores the account name on the source', async () => {
    const fetchImpl = identityEndpoint();

    await expect(connect(memoryStorage(), fetchImpl)).resolves.toBe('connected');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.upsertOwnedExternalTriggerSource).toHaveBeenCalledTimes(1);
    expect(store.upsertOwnedExternalTriggerSource.mock.calls[0]![1]).toMatchObject({
      kind: 'example-tickets',
      status: 'connected',
      config: { accountLabel: 'octocat' },
    });
  });

  it('still connects, without a label and with the refusal recorded, when the endpoint refuses the credential', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;

    await expect(connect(memoryStorage(), fetchImpl)).resolves.toBe('connected');

    const written = store.upsertOwnedExternalTriggerSource.mock.calls[0]![1] as Record<string, unknown>;
    expect(written.config).toBeUndefined();
    const recorded = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call as unknown[]).slice(1));
    expect(recorded.flat()).toContain('provider_example_tickets_identity_401');
  });

  it('sends no request for a package without an identity endpoint', async () => {
    const fetchImpl = identityEndpoint();
    const withoutIdentity = { ...descriptor, oauth: undefined };
    const storage = memoryStorage();
    await saveProviderCredentials(withoutIdentity, 'papercusp', { personal_access_token: TOKEN }, { storage });
    const credentials = await providerCredentialStatus(withoutIdentity, 'papercusp', storage);

    await syncProviderCredentialSource(sql, OWNER, withoutIdentity, credentials, { harness: 'papercusp', storage, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect((store.upsertOwnedExternalTriggerSource.mock.calls[0]![1] as Record<string, unknown>).config).toBeUndefined();
  });
});

describe('fetchProviderIdentity', () => {
  it('reads the id and display name the package declares', async () => {
    await expect(fetchProviderIdentity(descriptor, TOKEN, 'p', identityEndpoint())).resolves.toEqual({ providerAccountId: '583231', displayName: 'octocat' });
  });

  it('never sends the credential to a host the package does not declare, or over plain http', async () => {
    const fetchImpl = identityEndpoint();
    const offHost = { ...descriptor, oauth: { ...descriptor.oauth!, identity: { url: 'https://evil.example.net/user', idField: 'id' } } };
    const plain = { ...descriptor, oauth: { ...descriptor.oauth!, identity: { url: 'http://api.example.com/user', idField: 'id' } } };

    await expect(fetchProviderIdentity(offHost, TOKEN, 'p', fetchImpl)).rejects.toThrow('p_identity_endpoint_not_allowed');
    await expect(fetchProviderIdentity(plain, TOKEN, 'p', fetchImpl)).rejects.toThrow('p_identity_endpoint_not_allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an answer without an account id, and never puts the secret in the error', async () => {
    const error = await fetchProviderIdentity(descriptor, TOKEN, 'p', identityEndpoint({ login: 'octocat' })).catch((e: Error) => e);
    expect(String(error)).toContain('p_identity_unavailable');
    expect(String(error)).not.toContain(TOKEN);
  });
});
