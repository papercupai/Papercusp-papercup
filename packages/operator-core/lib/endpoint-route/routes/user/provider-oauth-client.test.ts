/**
 * OAuth app registration over HTTP (cupboard-distributable-integrations-2026-10-10 P-009;
 * SPEC-R-2-P-009, SPEC-R-7-P-009). The routes are thin over oauth-client-registration.ts; what this
 * pins is the HTTP contract: no response ever carries the client secret, a bad value is refused by
 * name without echoing it, a provider without OAuth is refused, cross-origin writes are refused,
 * and every write invalidates the page's live query. Writes land in a real oauth-apps.json under a
 * temporary PAPERCUSP_HOME, under the key the connect flow reads.
 *
 * Fixture values are deliberately neutral, low-entropy strings, not vendor-token-shaped.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDefinition } from '../../define-route';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  invalidate: vi.fn(),
  descriptors: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../auth', () => ({ getSessionUserOrDefault: mocks.getUser }));
// Keep the real module: papercuspPath() resolves the registrations file through it.
vi.mock('../../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../workspace-registry')>()),
  activeWorkspaceId: () => 'ws-test',
}));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: mocks.invalidate }));
vi.mock('../../../integrations/provider-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../integrations/provider-registry')>()),
  readyProviderRegistry: async () => ({
    get: (id: string) => {
      const descriptor = mocks.descriptors.find((d) => d.id === id);
      return descriptor ? { descriptor } : undefined;
    },
    list: () => mocks.descriptors.map((descriptor) => ({ descriptor })),
  }),
}));

import routes from './provider-oauth-client';

const BASE = '/user/integrations/providers/:providerId/oauth-client';
const SECRET = 'route-secret-value';
const oauth = { authorizeUrl: 'https://auth.fixture-tickets.test/authorize', tokenUrl: 'https://auth.fixture-tickets.test/token', scopes: ['read'] };

let home: string;

const route = (method: string): RouteDefinition => {
  const found = (routes as RouteDefinition[]).find((candidate) => candidate.method === method && candidate.path === BASE);
  if (!found) throw new Error(`missing route ${method} ${BASE}`);
  return found;
};

const invoke = (method: string, req: Request, providerId: string) => route(method).handler(req, { params: { providerId } } as never) as Promise<Response>;

const get = (providerId: string) => invoke('GET', new Request('http://127.0.0.1/x'), providerId);

const put = (providerId: string, body: unknown, headers: Record<string, string> = {}) =>
  invoke(
    'PUT',
    new Request(`http://127.0.0.1/api/user/integrations/providers/${providerId}/oauth-client`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    providerId,
  );

const registrations = async () => JSON.parse(await fs.readFile(join(home, 'oauth-apps.json'), 'utf8')) as Record<string, Record<string, unknown>>;

beforeEach(async () => {
  vi.clearAllMocks();
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-oauth-client-route-'));
  vi.stubEnv('PAPERCUSP_HOME', home);
  vi.stubEnv('PAPERCUSP_OPERATOR_BASE', 'https://operator.route.test');
  mocks.getUser.mockResolvedValue({ id: 'user-1' });
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.descriptors = [
    { id: 'fixture-tickets', displayName: 'Fixture Tickets', oauth: { ...oauth, clientRegistrationRef: 'fixture-app' } },
    { id: 'fixture-pkce', displayName: 'Fixture PKCE', oauth: { ...oauth, pkce: true } },
    { id: 'fixture-chat', displayName: 'Fixture Chat', setup: { credentials: [{ key: 'botToken', label: 'Bot token' }] } },
  ];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('provider OAuth client routes', () => {
  it('GET reports an unregistered app, with the redirect URL to give the vendor', async () => {
    const res = await get('fixture-tickets');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      providerId: 'fixture-tickets',
      oauthClient: { ref: 'fixture-app', configured: false, clientId: null, hasClientSecret: false, redirectUri: 'https://operator.route.test/api/oauth/callback' },
    });
  });

  it('PUT stores the registration under the key the connect flow reads and never returns the secret', async () => {
    const res = await put('fixture-tickets', { clientId: 'fixture-client', clientSecret: SECRET });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).oauthClient).toMatchObject({ configured: true, clientId: 'fixture-client', hasClientSecret: true });
    expect((await registrations())['fixture-app']).toMatchObject({ clientId: 'fixture-client', clientSecret: SECRET });

    const read = await (await get('fixture-tickets')).text();
    expect(read).not.toContain(SECRET);
    // The page's query key is { userId }; a { workspaceId, userId } notify can never
    // match it, so the route sends the unscoped refresh only (WI-6554700010008519).
    expect(mocks.invalidate).toHaveBeenCalledWith('integrations.tickets');
    expect(mocks.invalidate.mock.calls.filter(([name]) => name === 'integrations.tickets').every(([, args]) => args === undefined)).toBe(true);
  });

  it('PUT refuses a bad value by name without echoing it, and writes nothing', async () => {
    const res = await put('fixture-tickets', { clientId: 'has space', clientSecret: SECRET });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain('has space');
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: 'invalid-client-id' });
    await expect(fs.stat(join(home, 'oauth-apps.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('PUT needs a secret unless the provider uses PKCE', async () => {
    expect(await (await put('fixture-tickets', { clientId: 'fixture-client' })).json()).toMatchObject({ error: 'client-secret-required' });
    const pkce = await put('fixture-pkce', { clientId: 'public-client' });
    expect(pkce.status).toBe(200);
    expect((await pkce.json()).oauthClient).toMatchObject({ configured: true, hasClientSecret: false });
  });

  it('refuses a provider without OAuth, one that is not installed, and a malformed body', async () => {
    expect((await get('fixture-chat')).status).toBe(409);
    expect(await (await get('missing')).json()).toMatchObject({ error: 'unknown_provider' });
    const malformed = await invoke(
      'PUT',
      new Request('http://127.0.0.1/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '"nope"' }),
      'fixture-tickets',
    );
    expect(malformed.status).toBe(400);
  });

  it('refuses a cross-origin write before touching the file', async () => {
    const res = await put('fixture-tickets', { clientId: 'fixture-client', clientSecret: SECRET }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    await expect(fs.stat(join(home, 'oauth-apps.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
