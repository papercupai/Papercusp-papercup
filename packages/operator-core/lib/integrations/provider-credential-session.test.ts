import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { validateProviderDescriptor, type ProviderDescriptor } from '@papercusp/plugin-sdk';
import type { TokenStorage } from '../oauth/token';
const sourceStore = vi.hoisted(() => ({ upsertOwnedExternalTriggerSource: vi.fn(async () => ({ id: 'source' })) }));
vi.mock('../external-triggers/source-store', async (original) => ({
  ...(await original<object>()), upsertOwnedExternalTriggerSource: sourceStore.upsertOwnedExternalTriggerSource,
}));
import { clearProviderCredential, providerCredentialSession, providerCredentialStatus, saveProviderCredentials, syncProviderCredentialSource } from './provider-credentials';
import { createHostFetch } from './host-fetch';
import { createProviderRegistry } from './provider-registry';

const descriptor: ProviderDescriptor = {
  id: 'session-example', contractVersion: 1, datatypes: ['social-post'], capabilities: ['social.post'],
  egressHosts: ['session.example.com'], setup: {
    credentials: [{ key: 'identifier', label: 'Account' }, { key: 'app_password', label: 'App password' }],
    session: { url: 'https://session.example.com/login', refreshUrl: 'https://session.example.com/refresh',
      parameters: { identifier: 'identifier', password: 'app_password' }, hosts: ['session.example.com'],
      accessTokenField: 'accessJwt', refreshTokenField: 'refreshJwt', activeField: 'active', maxAgeSeconds: 3600,
      identity: { idField: 'did', displayNameField: 'handle', credentialKey: 'identifier' } },
  },
};
const login = { accessJwt: 'private-access', refreshJwt: 'private-refresh', did: 'did:example:alice', handle: 'alice.example' };
function fixture() {
  let data: Record<string, unknown> = {};
  let clock = 1_000_000;
  const storage: TokenStorage = { read: async () => structuredClone(data), update: async (_p, _h, patch) => { data = { ...data, ...patch }; } };
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  let reply: unknown | Response = login;
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
    return reply instanceof Response ? reply.clone() : Response.json(reply);
  }) as unknown as typeof fetch;
  const opts = { storage, fetchImpl, now: () => clock };
  return { storage, fetchImpl, calls, opts, setReply: (value: unknown) => { reply = value; }, advance: () => { clock += 3600_000; },
    save: () => saveProviderCredentials(descriptor, 'test', { identifier: 'alice.example', app_password: 'private-password' }, { storage }),
    session: () => providerCredentialSession(descriptor, 'test', opts) };
}

describe('pasted credential sessions stay inside the host', () => {
  it('validates the descriptor, creates once, persists across callers, and refreshes with the refresh bearer', async () => {
    const f = fixture(); await f.save();
    expect(validateProviderDescriptor(descriptor)).toEqual([]);
    const first = await f.session();
    expect(first.identity).toEqual({ providerAccountId: login.did, displayName: login.handle });
    expect(f.calls[0]).toMatchObject({ url: descriptor.setup!.session!.url, body: { identifier: 'alice.example', password: 'private-password' } });
    expect(f.calls[0].headers.has('authorization')).toBe(false);
    expect(await f.session()).toEqual(first); expect(f.calls).toHaveLength(1);
    f.advance(); f.setReply({ ...login, accessJwt: 'private-access-next', refreshJwt: 'private-refresh-next' });
    await Promise.all([f.session(), f.session(), f.session()]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].url).toBe(descriptor.setup!.session!.refreshUrl);
    expect(f.calls[1].headers.get('authorization')).toBe('Bearer private-refresh');
    expect(f.calls[1].body).toBeNull();
    expect((await f.session()).refreshToken).toBe('private-refresh-next');
  });
  it('invalidates on rotation and clear and never connects a session from an invalid password', async () => {
    const f = fixture(); await f.save(); await f.session();
    await f.save(); await f.session(); expect(f.calls).toHaveLength(2);
    await clearProviderCredential(descriptor, 'test', 'app_password', f.storage);
    await expect(f.session()).rejects.toThrow('credential_missing');
    expect(f.calls).toHaveLength(2);
    await f.save(); f.setReply(Response.json({ message: 'private-password' }, { status: 401 }));
    await expect(syncProviderCredentialSource({} as postgres.Sql, { workspaceId: 'w', ownerUserId: 'u' }, descriptor,
      await providerCredentialStatus(descriptor, 'test', f.storage), { ...f.opts, harness: 'test' })).rejects.toThrow('http_401');
  });
  it('keeps credential status secret-free and saves only public session identity on the source', async () => {
    const f = fixture(); await f.save();
    const statuses = await providerCredentialStatus(descriptor, 'test', f.storage);
    await syncProviderCredentialSource({} as postgres.Sql, { workspaceId: 'w', ownerUserId: 'u' }, descriptor, statuses, { ...f.opts, harness: 'test' });
    expect(sourceStore.upsertOwnedExternalTriggerSource).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      config: { accountId: login.did, accountLabel: login.handle }, credentialRef: 'provider-setup:session-example',
    }));
    expect(JSON.stringify(statuses)).not.toMatch(/private-(password|access|refresh)/);
  });
  it('blocks direct package access to both session endpoints and redacts API token/password echoes', async () => {
    const f = fixture(); await f.save();
    const registry = createProviderRegistry();
    await registry.register({ descriptor, pluginName: 'session-example', adapter: { describe: () => descriptor,
      syncPage: async () => ({ records: [], cursor: null, hasMore: false }), invoke: async () => ({}) } });
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-access');
      return Response.json({ password: 'private-password', access: 'private-access', refresh: 'private-refresh', id: 'post' },
        { headers: { 'x-echo': 'private-refresh' } });
    }) as unknown as typeof fetch;
    const hostFetch = createHostFetch(descriptor.id, { registry, resolveSource: async (id) => ({ sourceId: id, providerId: descriptor.id }),
      accessToken: async () => { throw new Error('must use session'); }, credentialSession: () => f.session(), fetchImpl });
    for (const url of [descriptor.setup!.session!.url, descriptor.setup!.session!.refreshUrl]) {
      await expect(hostFetch({ source: 's', request: { url: `${url}?extra=1` } })).rejects.toMatchObject({ code: 'credential-endpoint-private' });
    }
    expect(f.calls).toHaveLength(0); expect(fetchImpl).not.toHaveBeenCalled();
    const result = await hostFetch({ source: 's', request: { url: 'https://session.example.com/posts' } });
    expect(result.body).toContain('post'); expect(result.body).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toMatch(/private-(password|access|refresh)/);
  });
  it.each([[401, 'auth'], [429, 'rate-limited'], [503, 'transient']] as const)('surfaces HTTP %s without echoing a secret or retrying', async (status, kind) => {
    const f = fixture(); await f.save(); f.setReply(Response.json({ token: 'private-password' }, { status, headers: { 'retry-after': '12' } }));
    const error = await f.session().catch((e: unknown) => e);
    expect(error).toMatchObject({ kind }); expect(String(error)).not.toContain('private-password'); expect(f.calls).toHaveLength(1);
  });
  it('does not fall back to password login after a refused refresh or an identity change', async () => {
    const f = fixture(); await f.save(); await f.session(); f.advance();
    f.setReply(Response.json({ error: 'ExpiredToken' }, { status: 401 }));
    await expect(f.session()).rejects.toThrow('http_401'); expect(f.calls).toHaveLength(2);
    f.setReply({ ...login, did: 'did:example:other' });
    await expect(f.session()).rejects.toThrow('identity_changed'); expect(f.calls).toHaveLength(3);
    expect(f.calls.slice(1).every((c) => c.url.endsWith('/refresh'))).toBe(true);
  });
  it('rejects malformed/expired or secret-bearing identity responses', async () => {
    for (const reply of [{ ...login, accessJwt: '' }, { ...login, did: 'private-refresh' }, { ...login, handle: 'private-password' },
      { ...login, accessJwt: `a.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.z` }]) {
      const f = fixture(); await f.save(); f.setReply(reply); await expect(f.session()).rejects.toThrow(/provider_session_/);
    }
  });
  it.each([false, 'false', 0])('refuses inactive or malformed active state %s before persisting a session or connecting a source', async (active) => {
    const f = fixture(); await f.save(); f.setReply({ ...login, active });
    sourceStore.upsertOwnedExternalTriggerSource.mockClear();
    await expect(syncProviderCredentialSource({} as postgres.Sql, { workspaceId: 'w', ownerUserId: 'u' }, descriptor,
      await providerCredentialStatus(descriptor, 'test', f.storage), { ...f.opts, harness: 'test' })).rejects.toThrow(/account_inactive|invalid_active_field/);
    expect((await f.storage.read('provider-setup:session-example', 'test')).__session).toBeNull();
    expect(sourceStore.upsertOwnedExternalTriggerSource).not.toHaveBeenCalled();
  });
  it('refuses malformed endpoints, credential mappings, token paths and overlapping credential hosts at descriptor admission', () => {
    for (const patch of [{ url: 'https://outside.example/login' }, { refreshUrl: 'http://session.example.com/refresh' },
      { parameters: { password: 'undeclared' } }, { accessTokenField: '__proto__.token' }, { maxAgeSeconds: 0 },
      { identity: { idField: 'accessJwt' } }]) {
      const d = structuredClone(descriptor); Object.assign(d.setup!.session!, patch);
      expect(validateProviderDescriptor(d).length).toBeGreaterThan(0);
    }
    const d = structuredClone(descriptor); d.setup!.credentials![0].hosts = ['session.example.com'];
    expect(validateProviderDescriptor(d)).toContain('provider.setup.session.hosts cannot overlap another credential');
  });
  it('refuses an in-flight exchange when a credential is cleared before the vendor responds', async () => {
    const f = fixture(); await f.save();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void; const released = new Promise<void>((resolve) => { finish = resolve; });
    const pending = providerCredentialSession(descriptor, 'test', { ...f.opts, fetchImpl: async () => { entered(); await released; return Response.json(login); } });
    await started; await clearProviderCredential(descriptor, 'test', 'app_password', f.storage); finish();
    await expect(pending).rejects.toThrow('credentials_changed');
    expect((await f.storage.read('provider-setup:session-example', 'test')).__session).toBeNull();
  });
});
