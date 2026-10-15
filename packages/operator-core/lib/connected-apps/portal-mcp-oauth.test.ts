/**
 * The PORTAL half of MCP OAuth (plan external-app-access-to-workspaces-2026-09-29 P-325,
 * WI-10004189; D-019, D-021), driven through the real handler with an in-memory store and a fake
 * connector port. The port stands in for HostedWorkspaceSessionBroker: it reports liveness and
 * opens the `app-key-mint` channel the handler asks the machine to mint on. The machine end of that
 * channel is pinned by hosted-app-key-mint-channel.test.ts.
 *
 * What is pinned here: discovery for one workspace's issuer; registration and authorization refuse
 * an offline workspace; only a signed-in account of the owning organization may consent, only from
 * the consent page itself; the approver may only NARROW the requested scope (R-37 analogue); the
 * token endpoint burns a code on a PKCE or redirect mismatch, refuses a replay, and gives the code
 * back when the machine is offline so the app can retry.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HostedPrincipal } from '../auth/hosted-principal';
import type { AppRelayConnector, AppRelayPort } from '../workspace-host/hosted-app-relay';
import type { Sql } from 'postgres';
import {
  InMemoryPortalOAuthStore,
  PORTAL_MCP_OAUTH_ROUTES,
  PostgresPortalOAuthStore,
  handleHostedMcpOAuth,
  isPortalMcpOAuthPath,
  matchPortalMcpOAuthRoute,
  narrowedGrant,
  portalMcpOAuthRoutePath,
  type PortalMcpOAuthDependencies,
} from './portal-mcp-oauth';
import type { AppRelayServiceRunner } from '../workspace-host/hosted-app-relay';
import { cspAdmitsFormTarget } from './consent-csp';

const PORTAL = 'https://app.papercusp.com';
const WS = 'ws-1';
const ISSUER = `${PORTAL}/api/workspaces/${WS}`;
const REDIRECT = 'https://client.example/callback';
const APP_KEY = `pcapp_${'a'.repeat(16)}_${'s'.repeat(43)}`;
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

type MintRequest = { type: string; requestId: string; label: string; scopes: Record<string, unknown>; approvedBy: string };

function principal(organization = 'org-1', permissions: string[] = ['workspace:operate']): HostedPrincipal {
  return {
    userId: 'user-1',
    workspaceId: 'control-1',
    activeOrganizationId: organization,
    permissions: new Set(permissions),
  } as unknown as HostedPrincipal;
}

function harness() {
  const state = { live: true, mints: [] as MintRequest[], closed: [] as string[] };
  let answer: (request: MintRequest) => Record<string, unknown> | null = (request) => ({
    type: 'mint.issued',
    requestId: request.requestId,
    key: APP_KEY,
    scopes: request.scopes,
  });
  const connector = (): AppRelayConnector => ({
    binding: { controlPlaneWorkspaceId: 'control-1', organizationId: 'org-1', customerWorkspaceId: WS, hostId: 'h', generation: 1 },
    lastSeenAt: new Date(),
  });
  const port: AppRelayPort = {
    appConnector: (id) => (state.live && id === WS ? connector() : null),
    openAppChannel(_connector, handlers, kind) {
      if (kind !== 'app-key-mint') throw new Error(`unexpected channel kind ${kind}`);
      return {
        send(payload) {
          const request = payload as unknown as MintRequest;
          state.mints.push(request);
          queueMicrotask(() => {
            const frame = answer(request);
            if (frame) handlers.onFrame(frame);
            else handlers.onClose('connector_closed');
          });
          return true;
        },
        close(reason) {
          state.closed.push(reason);
        },
      };
    },
  };
  const sessions = new Map<string, HostedPrincipal>([['me', principal()], ['other', principal('org-2')]]);
  const deps: PortalMcpOAuthDependencies = {
    store: new InMemoryPortalOAuthStore(),
    port,
    async resolvePrincipal(headers) {
      const who = /session=(\w+)/.exec(headers.get('cookie') ?? '')?.[1];
      const found = who ? sessions.get(who) : undefined;
      return found ? { ok: true, principal: found } : { ok: false, reason: 'session_cookie_missing' };
    },
  };
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await handleHostedMcpOAuth(new Request(`${PORTAL}${path}`, init), deps);
    if (!response) throw new Error(`not served: ${path}`);
    return response;
  };
  return {
    state,
    deps,
    call,
    setAnswer(next: typeof answer) {
      answer = next;
    },
  };
}

type Harness = ReturnType<typeof harness>;

async function register(h: Harness): Promise<string> {
  const response = await h.call(`/api/workspaces/${WS}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorize(h: Harness, clientId: string, scope = 'tool:plans:get tool:work_items:list harness:papercusp'): Promise<string> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope,
  });
  const response = await h.call(`/api/workspaces/${WS}/oauth/authorize?${q}`);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/oauth/consent`);
  return location.searchParams.get('request')!;
}

function consent(h: Harness, handle: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return h.call(`/api/workspaces/${WS}/oauth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=me', origin: PORTAL, ...headers },
    body: new URLSearchParams({ request: handle, ...fields }).toString(),
  });
}

async function approve(h: Harness, handle: string, fields: Record<string, string> = { tools: 'plans:get', harnesses: 'papercusp' }) {
  const response = await consent(h, handle, { decision: 'approve', ...fields });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe('st-1');
  expect(location.searchParams.get('iss')).toBe(ISSUER);
  return location.searchParams.get('code')!;
}

function token(h: Harness, clientId: string, code: string, verifier = VERIFIER, redirect = REDIRECT) {
  return h.call(`/api/workspaces/${WS}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect }).toString(),
  });
}

describe('portal MCP OAuth discovery (P-325)', () => {
  it('publishes one issuer per workspace, at both RFC 8414 locations', async () => {
    const h = harness();
    const resource = await (await h.call(`/.well-known/oauth-protected-resource/api/workspaces/${WS}/mcp`)).json();
    expect(resource).toMatchObject({ resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER] });
    for (const path of [`/.well-known/oauth-authorization-server/api/workspaces/${WS}`, `/api/workspaces/${WS}/.well-known/oauth-authorization-server`]) {
      const server = await (await h.call(path)).json();
      expect(server).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
      });
    }
  });

  it('claims only its own paths, so the relay and the plane keep theirs', () => {
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/oauth/token`)).toBe(true);
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/mcp`)).toBe(false);
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/agent-tools/plans/get`)).toBe(false);
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/oauth/../mcp`)).toBe(false);
    // A template's dots are literal, not regex wildcards.
    expect(isPortalMcpOAuthPath(`/api/workspaces/${WS}/xwell-known/oauth-authorization-server`)).toBe(false);
    expect(isPortalMcpOAuthPath(`/xwell-known/oauth-protected-resource/api/workspaces/${WS}/mcp`)).toBe(false);
  });

  it('matches every route of PORTAL_MCP_OAUTH_ROUTES at its own path, for the workspace it names (WI-10005092)', () => {
    for (const route of PORTAL_MCP_OAUTH_ROUTES) {
      expect(matchPortalMcpOAuthRoute(portalMcpOAuthRoutePath(route, WS))).toEqual({ route, workspaceId: WS });
    }
    expect(new Set(PORTAL_MCP_OAUTH_ROUTES.map((route) => route.template)).size).toBe(PORTAL_MCP_OAUTH_ROUTES.length);
  });

  it('accepts each route at its sampleMethod, the method the hosted ingress probe sends (WI-10005092)', async () => {
    const h = harness();
    for (const route of PORTAL_MCP_OAUTH_ROUTES) {
      const response = await h.call(portalMcpOAuthRoutePath(route, WS), { method: route.sampleMethod });
      expect({ template: route.template, method: route.sampleMethod, status: response.status }).not.toMatchObject({ status: 405 });
    }
  });
});

describe('portal MCP OAuth flow (P-325)', () => {
  it('refuses offline BYOC OAuth verbs with typed ingress alternatives', async () => {
    const h = harness();
    h.state.live = false;
    Object.assign(h.deps, { resolveCustomerWorkspaceHosting: async (id: string) => id === WS ? 'byoc' : null });
    for (const path of [`/api/workspaces/${WS}/oauth/register`, `/api/workspaces/${WS}/oauth/token`]) {
      const response = await h.call(path, { method: 'POST', body: 'BYOC_SECRET' });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'byoc_plaintext_relay_refused',
        alternatives: ['customer_controlled_ingress', 'sealed_channel'],
      });
    }
    expect(h.state.mints).toEqual([]);
  });

  it('refuses to register or authorize for an offline workspace', async () => {
    const h = harness();
    const clientId = await register(h);
    h.state.live = false;
    const offline = await h.call(`/api/workspaces/${WS}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
    });
    expect(offline.status).toBe(503);
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256' });
    const auth = await h.call(`/api/workspaces/${WS}/oauth/authorize?${q}`);
    expect(auth.status).toBe(302);
    expect(new URL(auth.headers.get('location')!).searchParams.get('error')).toBe('temporarily_unavailable');
  });

  it('issues the key the MACHINE minted, for exactly the narrowed grant, approved by the signed-in account', async () => {
    const h = harness();
    const clientId = await register(h);
    const handle = await authorize(h, clientId);
    const code = await approve(h, handle);

    const response = await token(h, clientId, code);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: APP_KEY, token_type: 'Bearer', scope: 'tool:plans:get harness:papercusp' });
    expect(h.state.mints).toEqual([
      {
        type: 'mint.request',
        requestId: expect.any(String),
        label: 'Claude',
        scopes: { tools: ['plans:get'], harnesses: ['papercusp'] },
        approvedBy: 'portal:user-1',
      },
    ]);
    expect(h.state.closed).toEqual(['mint_complete']);

    // The code is single-use.
    const replay = await token(h, clientId, code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect(h.state.mints).toHaveLength(1);
  });

  it('asks a signed-out visitor to sign in, and refuses an account of another organization', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h));
    const page = (cookie?: string) =>
      h.call(`/api/workspaces/${WS}/oauth/consent?request=${encodeURIComponent(handle)}`, cookie ? { headers: { cookie } } : {});
    const signedOut = await page();
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toContain('/api/hosted/auth/sign-in');
    expect((await page('session=other')).status).toBe(403);
    expect((await consent(h, handle, { decision: 'approve', tools: 'plans:get' }, { cookie: 'session=other' })).status).toBe(403);
    const form = await page('session=me');
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('name="tools" value="plans:get work_items:list"');
  });

  it('accepts a consent only from its own page (same Origin)', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h));
    expect((await consent(h, handle, { decision: 'approve', tools: 'plans:get' }, { origin: 'https://evil.example' })).status).toBe(403);
    const noOrigin = await h.call(`/api/workspaces/${WS}/oauth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=me' },
      body: new URLSearchParams({ request: handle, decision: 'approve', tools: 'plans:get' }).toString(),
    });
    expect(noOrigin.status).toBe(403);
    // `Origin: null` from another site (or an opaque sandbox) is refused too.
    expect(
      (await consent(h, handle, { decision: 'approve', tools: 'plans:get' }, { origin: 'null', 'sec-fetch-site': 'cross-site' })).status,
    ).toBe(403);
    // Still pending: the refused posts decided nothing.
    await approve(h, handle);
  });

  /**
   * WI-10004462: a real browser posts this page's form with `Origin: null` whenever the page (or the
   * user's privacy setting) runs under a no-referrer policy. The page sent `no-referrer`, so every
   * browser's Allow was refused with 403 while the hand-set Origin above passed. The page now sends
   * `same-origin`, and a same-origin post that still arrives with `Origin: null` is accepted on
   * Fetch Metadata.
   */
  it('accepts the browser-shaped consent post: Origin null with Sec-Fetch-Site same-origin', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h));
    const form = await h.call(`/api/workspaces/${WS}/oauth/consent?request=${encodeURIComponent(handle)}`, {
      headers: { cookie: 'session=me' },
    });
    expect(form.status).toBe(200);
    expect(form.headers.get('referrer-policy')).toBe('same-origin');
    expect(await form.text()).not.toMatch(/no-referrer/);

    const response = await consent(
      h,
      handle,
      { decision: 'approve', tools: 'plans:get', harnesses: 'papercusp' },
      { origin: 'null', 'sec-fetch-site': 'same-origin' },
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('st-1');
  });

  it('serves the consent form under a form-action that admits where its Allow and Deny answers send the browser (WI-10004470)', async () => {
    // A browser enforces form-action on every hop of the submission's redirect chain, so a page
    // that answers with a redirect to the client but allows only 'self' never delivers the code.
    const consentPage = async (h: Harness, handle: string) => {
      const url = `${ISSUER}/oauth/consent?request=${encodeURIComponent(handle)}`;
      const res = await h.call(`/api/workspaces/${WS}/oauth/consent?request=${encodeURIComponent(handle)}`, { headers: { cookie: 'session=me' } });
      expect(res.status).toBe(200);
      return { url, csp: res.headers.get('content-security-policy') ?? '' };
    };
    for (const decision of ['approve', 'deny'] as const) {
      const h = harness();
      const handle = await authorize(h, await register(h));
      const page = await consentPage(h, handle);
      const answer = await consent(h, handle, { decision, tools: 'plans:get', harnesses: 'papercusp' });
      expect(answer.status).toBe(302);
      const target = answer.headers.get('location')!;
      expect(target.startsWith(REDIRECT)).toBe(true);
      expect(cspAdmitsFormTarget(page.csp, page.url, target), `${decision}: ${page.csp}`).toBe(true);
      // Still narrow: only this request's redirect origin, never an arbitrary one.
      expect(cspAdmitsFormTarget(page.csp, page.url, 'https://attacker.example/collect')).toBe(false);
    }
    // The re-rendered form after a refused scope answers the same way, so it needs the same allowance.
    const h = harness();
    const handle = await authorize(h, await register(h));
    const refused = await consent(h, handle, { decision: 'approve', tools: 'plans:get work_items:delete', harnesses: 'papercusp' });
    expect(refused.status).toBe(400);
    expect(cspAdmitsFormTarget(refused.headers.get('content-security-policy') ?? '', `${ISSUER}/oauth/consent`, `${REDIRECT}?code=x`)).toBe(true);
  });

  it('lets the approver narrow the grant but never widen it, or empty a list the app restricted', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h));
    const widened = await consent(h, handle, { decision: 'approve', tools: 'plans:get admin:shutdown', harnesses: 'papercusp' });
    expect(widened.status).toBe(400);
    expect(await widened.text()).toContain('admin:shutdown was not requested by the app');
    const emptiedHarnesses = await consent(h, handle, { decision: 'approve', tools: 'plans:get', harnesses: '' });
    expect(emptiedHarnesses.status).toBe(400);
    const emptiedTools = await consent(h, handle, { decision: 'approve', tools: ' ', harnesses: 'papercusp' });
    expect(emptiedTools.status).toBe(400);
    expect(h.state.mints).toHaveLength(0);
  });

  it('narrowedGrant: a request that named no tools gets only what the approver lists', () => {
    expect(narrowedGrant({}, { tools: 'plans:get' })).toEqual({ ok: true, scopes: { tools: ['plans:get'] } });
    expect(narrowedGrant({}, {})).toEqual({ ok: true, scopes: {} });
    expect(narrowedGrant({ harnesses: ['a'] }, { harnesses: 'a b' })).toEqual({ ok: false, problem: 'b was not requested by the app' });
  });

  it('tells the approver that a request naming no tools grants none until they list some', async () => {
    const h = harness();
    const handle = await authorize(h, await register(h), '');
    const html = await (await h.call(`/api/workspaces/${WS}/oauth/consent?request=${encodeURIComponent(handle)}`, { headers: { cookie: 'session=me' } })).text();
    expect(html).toContain('none yet (the app named no tools)');
    expect(html).not.toContain('every tool');
  });

  it('burns the code on a PKCE or redirect mismatch', async () => {
    for (const [verifier, redirect] of [['w'.repeat(64), REDIRECT], [VERIFIER, 'https://client.example/other']] as const) {
      const h = harness();
      const clientId = await register(h);
      const code = await approve(h, await authorize(h, clientId));
      const bad = await token(h, clientId, code, verifier, redirect);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });
      const retry = await token(h, clientId, code);
      expect(retry.status).toBe(400);
      expect(h.state.mints).toHaveLength(0);
    }
  });

  it('gives the code back when the machine is offline or silent, so the app can retry', async () => {
    const h = harness();
    const clientId = await register(h);
    const code = await approve(h, await authorize(h, clientId));
    h.state.live = false;
    const offline = await token(h, clientId, code);
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ error: 'temporarily_unavailable' });

    h.state.live = true;
    h.setAnswer(() => null); // the channel closes without an answer
    expect((await token(h, clientId, code)).status).toBe(503);

    h.setAnswer((request) => ({ type: 'mint.issued', requestId: request.requestId, key: APP_KEY, scopes: request.scopes }));
    const retried = await token(h, clientId, code);
    expect(retried.status).toBe(200);
  });

  it('consumes the code when the machine refuses the consented scope', async () => {
    const h = harness();
    const clientId = await register(h);
    const code = await approve(h, await authorize(h, clientId));
    h.setAnswer((request) => ({ type: 'mint.error', requestId: request.requestId, code: 'invalid_scope' }));
    const refused = await token(h, clientId, code);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_scope' });
    h.setAnswer((request) => ({ type: 'mint.issued', requestId: request.requestId, key: APP_KEY, scopes: request.scopes }));
    expect((await token(h, clientId, code)).status).toBe(400);
  });

  it('never delivers a short-lived pcat_ token as the key a consented grant mints', async () => {
    const h = harness();
    const clientId = await register(h);
    const code = await approve(h, await authorize(h, clientId));
    h.setAnswer((request) => ({ type: 'mint.issued', requestId: request.requestId, key: ACCESS_TOKEN, scopes: request.scopes }));
    const refused = await token(h, clientId, code);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ error: 'server_error' });
  });
});

// ── the client-credentials grant, relayed to the machine (P-016, D-022) ───────────────────────

const ACCESS_TOKEN = `pcat_${'b'.repeat(16)}_${'t'.repeat(43)}`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
type TokenRequest = { type: string; requestId: string; fields: Record<string, string>; basic: unknown; audience: string };

function clientCredentials(h: Harness, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return h.call(`/api/workspaces/${WS}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...fields }).toString(),
  });
}

function answerToken(h: Harness, status: number, body: Record<string, unknown>) {
  h.setAnswer((request) => ({ type: 'token.answer', requestId: request.requestId, status, body }));
}

const sentTokenRequests = (h: Harness) => h.state.mints as unknown as TokenRequest[];

describe('portal client-credentials grant (P-016)', () => {
  it('advertises client_credentials and signed-JWT client authentication at the workspace issuer', async () => {
    const h = harness();
    const server = await (await h.call(`/.well-known/oauth-authorization-server/api/workspaces/${WS}`)).json();
    expect(server.grant_types_supported).toEqual(['authorization_code', 'client_credentials']);
    expect(server.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(['client_secret_basic', 'private_key_jwt']));
    expect(server.token_endpoint_auth_signing_alg_values_supported).toEqual(['RS256', 'PS256', 'ES256', 'EdDSA']);
  });

  it('relays only the grant fields, with the portal token endpoint as audience, and returns the machine answer', async () => {
    const h = harness();
    const issued = { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'tool:plans:get' };
    answerToken(h, 200, issued);
    const response = await clientCredentials(h, {
      client_id: 'c'.repeat(16),
      client_secret: APP_KEY,
      scope: 'tool:plans:get',
      resource: 'https://evil.example/mcp',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(issued);
    const [sent, ...more] = sentTokenRequests(h);
    expect(more).toEqual([]);
    expect(sent).toEqual({
      type: 'token.request',
      requestId: expect.any(String),
      fields: { grant_type: 'client_credentials', client_id: 'c'.repeat(16), client_secret: APP_KEY, scope: 'tool:plans:get' },
      basic: null,
      audience: TOKEN_ENDPOINT,
    });
    expect(h.state.closed).toEqual(['token_complete']);
  });

  it('relays Basic credentials, and passes a refused client back as 401 with a Basic challenge', async () => {
    const h = harness();
    answerToken(h, 401, { error: 'invalid_client', error_description: 'client authentication failed' });
    const basic = Buffer.from(`${'c'.repeat(16)}:${APP_KEY}`).toString('base64');
    const response = await clientCredentials(h, {}, { authorization: `Basic ${basic}` });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="papercusp"');
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
    expect(sentTokenRequests(h)[0]!.basic).toEqual({ id: 'c'.repeat(16), secret: APP_KEY });
  });

  it('refuses a long-lived key, or any answer that is not an OAuth token answer, as a token', async () => {
    for (const [status, body] of [
      [200, { access_token: APP_KEY, token_type: 'Bearer' }],
      [200, { token_type: 'Bearer' }],
      [500, { error: 'server_error' }],
      [400, { message: 'no error field' }],
    ] as const) {
      const h = harness();
      answerToken(h, status, body);
      const response = await clientCredentials(h, { client_id: 'c'.repeat(16), client_secret: APP_KEY });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: 'server_error' });
    }
  });

  it('answers 503 when the workspace is offline or silent, and relays nothing when offline', async () => {
    const h = harness();
    h.state.live = false;
    const offline = await clientCredentials(h, { client_id: 'c'.repeat(16), client_secret: APP_KEY });
    expect(offline.status).toBe(503);
    expect(sentTokenRequests(h)).toEqual([]);
    h.state.live = true;
    h.setAnswer(() => null);
    expect((await clientCredentials(h, { client_id: 'c'.repeat(16), client_secret: APP_KEY })).status).toBe(503);
  });

  it('refuses an oversized field without relaying it, and still refuses an unknown grant type', async () => {
    const h = harness();
    const big = await clientCredentials(h, { client_assertion: 'x'.repeat(9000) });
    expect(big.status).toBe(400);
    expect(await big.json()).toMatchObject({ error: 'invalid_request' });
    expect(sentTokenRequests(h)).toEqual([]);
    const password = await h.call(`/api/workspaces/${WS}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', username: 'u', password: 'p' }).toString(),
    });
    expect(password.status).toBe(400);
    expect(await password.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

/**
 * WI-10004446: once anything drizzle-wraps the shared pool, a raw `timestamptz` read comes back as
 * Postgres text, not a Date (connected-apps/pg-dates.ts). The hosted control plane's pool did, and
 * registration answered 500 on `createdAt.getTime()`. This runner answers every query the way that
 * pool does, so the store must turn the text into Dates itself.
 */
function textTimestampRunner(rowsFor: (query: string) => Record<string, unknown>[]): AppRelayServiceRunner {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ''), '');
    return Promise.resolve(rowsFor(query));
  };
  const sql = Object.assign(tag, { unsafe: (text: string) => text }) as unknown as Sql;
  return ((fn: (tx: Sql) => Promise<unknown>) => fn(sql)) as AppRelayServiceRunner;
}

describe('PostgresPortalOAuthStore reads timestamps a drizzle-wrapped pool returns as text (WI-10004446)', () => {
  const workspace = { controlPlaneWorkspaceId: 'control-1', organizationId: 'org-1', customerWorkspaceId: WS };
  const clientRow = {
    client_id: `pcoc_${'c'.repeat(22)}`,
    client_name: 'Scripted client',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
    client_secret_hash: null,
    created_at: '2026-09-30 21:52:12.123456+00',
  };
  const requestRow = {
    handle_hash: 'h'.repeat(64),
    client_id: clientRow.client_id,
    control_workspace_id: 'control-1',
    organization_id: 'org-1',
    customer_workspace_id: WS,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    oauth_state: null,
    resource: null,
    requested_scopes: {},
    granted_scopes: null,
    state: 'pending',
    approved_by: null,
    code_expires_at: null,
    expires_at: '2026-09-30 22:02:12.5-04',
  };

  it('registers and reads a client whose created_at arrives as text', async () => {
    const store = new PostgresPortalOAuthStore(textTimestampRunner(() => [clientRow]));
    const registered = await store.registerClient(
      workspace,
      { clientName: 'Scripted client', redirectUris: [REDIRECT], tokenEndpointAuthMethod: 'none' },
      new Date('2026-09-30T21:52:12Z'),
    );
    expect(registered.client.createdAt).toBeInstanceOf(Date);
    expect(registered.client.createdAt.toISOString()).toBe('2026-09-30T21:52:12.123Z');
    const read = await store.getClient(WS, clientRow.client_id);
    expect(read?.createdAt.toISOString()).toBe('2026-09-30T21:52:12.123Z');
  });

  it('answers the registration endpoint with client_id_issued_at, not a 500', async () => {
    const h = harness();
    const deps: PortalMcpOAuthDependencies = {
      ...h.deps,
      store: new PostgresPortalOAuthStore(textTimestampRunner(() => [clientRow])),
    };
    const response = await handleHostedMcpOAuth(
      new Request(`${ISSUER}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Scripted client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
      }),
      deps,
    );
    expect(response?.status).toBe(201);
    expect(await response!.json()).toMatchObject({ client_id_issued_at: 1790805132 });
  });

  it('reads request expiry and code expiry as Dates, keeping a NULL code expiry null', async () => {
    const pending = new PostgresPortalOAuthStore(textTimestampRunner(() => [requestRow]));
    const request = await pending.getRequest(WS, requestRow.handle_hash);
    expect(request?.expiresAt.toISOString()).toBe('2026-10-01T02:02:12.500Z');
    expect(request?.codeExpiresAt).toBeNull();

    const approved = new PostgresPortalOAuthStore(
      textTimestampRunner(() => [{ ...requestRow, state: 'approved', code_expires_at: '2026-09-30 21:53:12+00' }]),
    );
    const claimed = await approved.claimCode(WS, 'x'.repeat(64), new Date('2026-09-30T21:52:30Z'));
    expect(claimed?.codeExpiresAt?.toISOString()).toBe('2026-09-30T21:53:12.000Z');
  });

  it('refuses a timestamp column that does not parse, naming it', async () => {
    const store = new PostgresPortalOAuthStore(textTimestampRunner(() => [{ ...clientRow, created_at: 'infinity' }]));
    await expect(store.getClient(WS, clientRow.client_id)).rejects.toThrow(/hosted_mcp_oauth_clients\.created_at/);
  });
});
