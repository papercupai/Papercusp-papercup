import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { RouteDefinition } from '@papercusp/tooldef/define-tool';
import {
  HostedSessionCookieCodec,
  type CreateHostedSessionInput,
  type HostedSession,
} from '../../../auth/hosted-session';
import { createFakeHostedIdentityProvider, FAKE_HOSTED_IDENTITY_NOW_MS } from '../../../auth/hosted/fake-provider';
import { hostedIdentityProviderFailure } from '../../../auth/hosted/provider';
import {
  HOSTED_AUTH_CALLBACK_PATH,
  HOSTED_AUTH_FLOW_COOKIE,
  HOSTED_AUTH_ROUTES,
  HOSTED_SESSION_LIFETIME_MS,
  createHostedAuthRoutes,
  safeHostedReturnTarget,
  type HostedAuthRouteDependencies,
  type HostedAuthSessionStore,
} from './index';
import type { HostedAuthFlow, HostedAuthFlowConsumeResult, HostedAuthFlowStore } from './flow';
import type { HostedSelfSignupAdmission } from '../../../auth/hosted/self-signup';

const ORIGIN = 'https://app.papercusp.com';
const NOW = new Date(FAKE_HOSTED_IDENTITY_NOW_MS);
const SECRET = 'hosted-route-test-cookie-secret-is-at-least-32-bytes';
const SESSION_ID = `hs_${'A'.repeat(43)}`;

class MemoryFlowStore implements HostedAuthFlowStore {
  readonly flows = new Map<string, HostedAuthFlow>();
  private next = 1;

  async create(flow: HostedAuthFlow): Promise<string> {
    const state = `state-${this.next++}`;
    this.flows.set(state, flow);
    return state;
  }

  async consume(state: string): Promise<HostedAuthFlowConsumeResult> {
    const flow = this.flows.get(state);
    if (!flow) return { ok: false, error: 'already-consumed' };
    this.flows.delete(state);
    return { ok: true, flow };
  }
}

class MemorySessionStore implements HostedAuthSessionStore {
  readonly created: CreateHostedSessionInput[] = [];
  readonly revoked: Array<{ id: string; reason: string }> = [];
  current: HostedSession | null = null;

  async create(input: CreateHostedSessionInput): Promise<HostedSession> {
    this.created.push(input);
    this.current = {
      id: SESSION_ID,
      userId: input.userId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId ?? null,
      permissionVersion: input.permissionVersion,
      upstreamProvider: input.upstreamProvider,
      upstreamSessionId: input.upstreamSessionId,
      createdAt: NOW,
      rotatedAt: null,
      expiresAt: input.expiresAt,
      lastSeenAt: null,
      revokedAt: null,
      revocationReason: null,
      updatedAt: NOW,
    };
    return this.current;
  }

  async resolve(id: string): Promise<HostedSession | null> {
    return id === this.current?.id && !this.current.revokedAt ? this.current : null;
  }

  async revoke(id: string, reason = 'logout', at = NOW): Promise<boolean> {
    if (id !== this.current?.id || this.current.revokedAt) return false;
    this.revoked.push({ id, reason });
    this.current = { ...this.current, revokedAt: at, revocationReason: reason };
    return true;
  }
}

function fixedEntropy() {
  let value = 1;
  return (size: number) => new Uint8Array(size).fill(value++);
}

function setup(
  provider = createFakeHostedIdentityProvider(),
  bindIdentity: HostedAuthRouteDependencies['bindIdentity'] = async () => ({
    userId: 'user-local-1',
    organizationId: 'org-local-1',
    workspaceId: 'workspace-local-1',
    permissionVersion: 7,
  }),
  selfSignup?: HostedSelfSignupAdmission,
  onSessionEstablished?: HostedAuthRouteDependencies['onSessionEstablished'],
) {
  const flowStore = new MemoryFlowStore();
  const sessionStore = new MemorySessionStore();
  const codec = new HostedSessionCookieCodec(SECRET);
  const routes = createHostedAuthRoutes({
    provider,
    flowStore,
    sessionStore,
    sessionCookieCodec: codec,
    bindIdentity,
    ...(selfSignup ? { selfSignup } : {}),
    ...(onSessionEstablished ? { onSessionEstablished } : {}),
    publicOrigin: ORIGIN,
    clock: () => NOW,
    randomBytes: fixedEntropy(),
  });
  const route = (method: string, path: string) => {
    const found = routes.find((candidate) => candidate.method === method && candidate.path === path);
    if (!found) throw new Error(`missing route ${method} ${path}`);
    return found as RouteDefinition<any>;
  };
  return { provider, flowStore, sessionStore, codec, route };
}

async function invoke(route: RouteDefinition<any>, req: Request): Promise<Response> {
  return route.handler(req, {} as never);
}

function responseCookieValue(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${name}=([^;,]+)`));
  if (!match) throw new Error(`missing response cookie ${name}: ${header}`);
  return decodeURIComponent(match[1]);
}

async function begin(setupResult: ReturnType<typeof setup>, returnTo = '/workspaces/ws-1') {
  const response = await invoke(
    setupResult.route('GET', '/hosted/auth/sign-in'),
    new Request(`${ORIGIN}/api/hosted/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`),
  );
  const location = response.headers.get('location') ?? '';
  return {
    response,
    state: new URL(location).searchParams.get('state') ?? '',
    flowCookie: responseCookieValue(response, HOSTED_AUTH_FLOW_COOKIE),
  };
}

async function beginWithIntent(
  setupResult: ReturnType<typeof setup>,
  intent: 'sign-in' | 'sign-up',
  returnTo = '/',
) {
  const response = await invoke(
    setupResult.route('GET', '/hosted/auth/sign-in'),
    new Request(`${ORIGIN}/api/hosted/auth/sign-in?intent=${intent}&returnTo=${encodeURIComponent(returnTo)}`),
  );
  const location = response.headers.get('location') ?? '';
  return {
    response,
    state: new URL(location).searchParams.get('state') ?? '',
    flowCookie: responseCookieValue(response, HOSTED_AUTH_FLOW_COOKIE),
  };
}

describe('hosted auth route contract', () => {
  // `callbackRecoveryRedirect` deliberately logs the refusal code: a
  // fail-closed callback 303s to `/`, which is indistinguishable in the
  // browser from an ordinary bounce, so that line is the only server-side
  // trace the refusal leaves. `vitest-fail-on-console` turns any console.warn
  // into a suite failure, so capture it and ASSERT on it — silencing it with a
  // bare mock would keep the suite green while quietly removing the guard on
  // the observability seam.
  let recoveryWarnings: string[] = [];
  beforeEach(() => {
    recoveryWarnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      recoveryWarnings.push(args.map((value) => String(value)).join(' '));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the explicit route manifest with concrete hosted auth posture', () => {
    expect(HOSTED_AUTH_ROUTES).toEqual([
      { method: 'GET', path: '/hosted/auth/sign-in', access: 'public' },
      { method: 'GET', path: '/hosted/auth/callback', access: 'public' },
      { method: 'POST', path: '/hosted/auth/logout', access: 'authenticated' },
      { method: 'GET', path: '/hosted/auth/session', access: 'authenticated' },
    ]);
    const { route } = setup();
    expect(route('GET', '/hosted/auth/sign-in').auth).toBe('public');
    expect(route('GET', '/hosted/auth/callback').auth).toBe('public');
    expect(route('POST', '/hosted/auth/logout').auth).toEqual({ capabilities: ['workspace:view'] });
    expect(route('GET', '/hosted/auth/session').auth).toEqual({ capabilities: ['workspace:view'] });
  });

  it('starts a browser-bound state/nonce/PKCE flow without exposing the verifier', async () => {
    const s = setup();
    const started = await begin(s);

    expect(started.response.status).toBe(302);
    expect(started.response.headers.get('set-cookie')).toContain(
      `Path=${HOSTED_AUTH_CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(s.provider.calls.beginSignIn).toHaveLength(1);
    const input = s.provider.calls.beginSignIn[0];
    expect(input.redirectUri).toBe(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}`);
    expect(input.pkce.method).toBe('S256');
    expect(input.pkce.challenge).not.toBe(s.flowStore.flows.get(started.state)?.pkceCodeVerifier);
    expect(started.response.headers.get('location')).not.toContain('pkceCodeVerifier');
    expect(started.response.headers.get('set-cookie')).not.toContain(
      s.flowStore.flows.get(started.state)?.pkceCodeVerifier ?? 'never',
    );
  });

  it('consumes the callback once, binds membership, and issues only a signed opaque session id', async () => {
    const s = setup();
    const started = await begin(s, '/workspaces/ws-1?tab=activity');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/workspaces/ws-1?tab=activity`);
    expect(response.headers.get('set-cookie')).toContain('__Host-papercusp_session=');
    expect(response.headers.get('set-cookie')).toContain(`${HOSTED_AUTH_FLOW_COOKIE}=`);
    expect(s.provider.calls.exchangeCallback[0]).toMatchObject({
      code: 'code-1',
      redirectUri: `${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}`,
    });
    expect(s.sessionStore.created).toEqual([
      {
        userId: 'user-local-1',
        organizationId: 'org-local-1',
        workspaceId: 'workspace-local-1',
        permissionVersion: 7,
        upstreamProvider: 'fake',
        upstreamSessionId: 'session_test_001',
        // The hosted session lifetime from sign-in — never the access token's expiry,
        // which made every sign-in last five minutes (2026-09-23).
        expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + HOSTED_SESSION_LIFETIME_MS),
      },
    ]);
    expect(s.sessionStore.created[0]).not.toHaveProperty('permissions');
    expect(s.sessionStore.created[0]).not.toHaveProperty('capabilities');
    const signedCookie = responseCookieValue(response, '__Host-papercusp_session');
    expect(s.codec.decode(signedCookie)).toBe(SESSION_ID);

    const replay = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: 'invalid_state_already-consumed' } });
  });

  it('observes only a persisted authenticated session and never waits on analytics', async () => {
    const observer = vi.fn<NonNullable<HostedAuthRouteDependencies['onSessionEstablished']>>(() => new Promise(() => {}));
    const s = setup(undefined, undefined, undefined, observer);
    const started = await begin(s);
    const callback = () => invoke(s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` } }));
    expect((await callback()).status).toBe(303);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0]![0]).toBe(s.sessionStore.current);
    expect((await callback()).status).toBe(400);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit sign-up separate from read-only sign-in binding', async () => {
    const bindIdentity = vi.fn(async () => {
      throw new Error('sign-in binder must not run for sign-up');
    });
    const admittedSession: HostedSession = {
      id: SESSION_ID,
      userId: 'new-user',
      organizationId: 'new-org',
      workspaceId: null,
      permissionVersion: 9,
      upstreamProvider: 'fake',
      upstreamSessionId: 'session_test_001',
      createdAt: NOW,
      rotatedAt: null,
      expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + HOSTED_SESSION_LIFETIME_MS),
      lastSeenAt: null,
      revokedAt: null,
      revocationReason: null,
      updatedAt: NOW,
    };
    const complete = vi.fn(async () => ({
      ok: true as const,
      binding: {
        userId: 'new-user',
        organizationId: 'new-org',
        workspaceId: null,
        permissionVersion: 9,
      },
      session: admittedSession,
    }));
    const s = setup(createFakeHostedIdentityProvider(), bindIdentity, { complete });
    const started = await beginWithIntent(s, 'sign-up');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/`);
    expect(bindIdentity).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: started.state,
      providerId: 'fake',
      identity: expect.objectContaining({ externalUserId: 'user_test_001', emailVerified: true }),
      upstreamSessionId: 'session_test_001',
    }));
    expect(s.sessionStore.created).toHaveLength(0);
  });

  it('fails closed when sign-up admission is not wired', async () => {
    const s = setup();
    const started = await beginWithIntent(s, 'sign-up');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/?hosted_auth_error=signup_unavailable&hosted_auth_recovery=1`,
    );
    expect(s.sessionStore.created).toHaveLength(0);
  });

  it.each(['signup', 'binding', 'session'] as const)(
    'keeps customer data and credentials out of %s failure logs',
    async (stage) => {
      const email = 'log-canary@example.test';
      const displayName = 'Private Customer Canary';
      const credential = 'opaque-provider-credential-canary';
      const cause = Object.assign(new Error(`constraint failed for ${email}: ${displayName} ${credential}`), {
        detail: { primary_email: email, sealed_session: credential },
      });
      cause.stack = `${cause.message}\nprivate provider response`;
      const s = setup(
        createFakeHostedIdentityProvider(),
        stage === 'binding' ? async () => { throw cause; } : undefined,
        stage === 'signup' ? { complete: async () => { throw cause; } } : undefined,
      );
      if (stage === 'session') vi.spyOn(s.sessionStore, 'create').mockRejectedValue(cause);
      const started = await beginWithIntent(s, stage === 'signup' ? 'sign-up' : 'sign-in');
      const response = await invoke(
        s.route('GET', '/hosted/auth/callback'),
        new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=private-code&state=${started.state}`, {
          headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
        }),
      );
      expect(response.status).toBe(503);
      const logs = JSON.stringify(vi.mocked(console.warn).mock.calls);
      for (const value of [email, displayName, credential, 'private-code', 'private provider response']) {
        expect(logs).not.toContain(value);
      }
      expect(logs).toContain(stage === 'signup' ? 'signup_unavailable'
        : stage === 'binding' ? 'identity_binding_unavailable' : 'session_create_failed');
      expect(logs).toContain('fingerprint');
    },
  );

  it('signs in a returning user whose sign-up admission reports duplicate_identity', async () => {
    const bindIdentity = vi.fn(async () => ({
      userId: 'user-local-1',
      organizationId: 'org-local-1',
      workspaceId: 'workspace-local-1',
      permissionVersion: 7,
    }));
    const complete = vi.fn(async () => ({
      ok: false as const,
      code: 'duplicate_identity' as const,
      retryable: false,
    }));
    const s = setup(createFakeHostedIdentityProvider(), bindIdentity, { complete });
    const started = await beginWithIntent(s, 'sign-up', '/workspaces/ws-1');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );

    // An identity the provider already knows is a RETURNING user, not a
    // refusal: bouncing them to `/` produced a loop, because the only action
    // the portal then offered was the sign-up that had just failed.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/workspaces/ws-1`);
    expect(response.headers.get('location')).not.toContain('hosted_auth_error');
    expect(response.headers.get('set-cookie')).toContain('__Host-papercusp_session=');
    expect(bindIdentity).toHaveBeenCalledTimes(1);
    expect(s.sessionStore.created).toHaveLength(1);
    expect(s.provider.calls.revokeSession).toEqual([]);
    // No recovery redirect happened, so the refusal seam must stay silent.
    expect(recoveryWarnings).toEqual([]);
  });

  it('keeps duplicate_identity fail-closed when no membership is attached', async () => {
    const complete = vi.fn(async () => ({
      ok: false as const,
      code: 'duplicate_identity' as const,
      retryable: false,
    }));
    const s = setup(createFakeHostedIdentityProvider(), async () => null, { complete });
    const started = await beginWithIntent(s, 'sign-up', '/workspaces/ws-1');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );

    // Binding an existing identity never creates membership, so admission is
    // still closed — the fall-through must not become a way in.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/?hosted_auth_error=membership_required&hosted_auth_recovery=1`,
    );
    expect(response.headers.get('set-cookie')).not.toContain('__Host-papercusp_session=');
    expect(s.sessionStore.created).toHaveLength(0);
  });

  it('still recovers a non-duplicate sign-up admission failure without binding', async () => {
    const bindIdentity = vi.fn(async () => {
      throw new Error('sign-in binder must not run for a terminal sign-up failure');
    });
    const complete = vi.fn(async () => ({
      ok: false as const,
      code: 'rate_limited' as const,
      retryable: false,
    }));
    const s = setup(createFakeHostedIdentityProvider(), bindIdentity, { complete });
    const started = await beginWithIntent(s, 'sign-up', '/workspaces/ws-1');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/?hosted_auth_error=signup_rate_limited&hosted_auth_recovery=1`,
    );
    expect(bindIdentity).not.toHaveBeenCalled();
    expect(s.sessionStore.created).toHaveLength(0);
    // The refusal code is the only server-side trace of this failure.
    expect(recoveryWarnings).toHaveLength(1);
    expect(recoveryWarnings[0]).toContain('code=signup_rate_limited');
  });

  it('rejects an external return target and a callback from the wrong browser', async () => {
    const s = setup();
    const invalid = await invoke(
      s.route('GET', '/hosted/auth/sign-in'),
      new Request(`${ORIGIN}/api/hosted/auth/sign-in?returnTo=${encodeURIComponent('//evil.example')}`),
    );
    expect(invalid.status).toBe(400);
    expect(s.provider.calls.beginSignIn).toHaveLength(0);

    const started = await begin(s);
    const mismatch = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=wrong-browser` },
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: 'browser_flow_mismatch' } });
    expect(s.provider.calls.exchangeCallback).toHaveLength(0);
  });

  it('recovers a callback that omitted state to the public unified-auth entry point', async () => {
    const s = setup();
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1`),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/?hosted_auth_error=state_required&hosted_auth_recovery=1`,
    );
    expect(response.headers.get('set-cookie')).toContain(`${HOSTED_AUTH_FLOW_COOKIE}=`);
    expect(s.provider.calls.exchangeCallback).toHaveLength(0);
    expect(s.sessionStore.created).toHaveLength(0);
  });

  it('recovers a valid provider callback with no active Papercusp membership', async () => {
    const s = setup(createFakeHostedIdentityProvider(), async () => null);
    const started = await begin(s, '/workspaces/ws-1');
    const response = await invoke(
      s.route('GET', '/hosted/auth/callback'),
      new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=code-1&state=${started.state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(started.flowCookie)}` },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/?hosted_auth_error=membership_required&hosted_auth_recovery=1`,
    );
    expect(response.headers.get('set-cookie')).toContain(`${HOSTED_AUTH_FLOW_COOKIE}=`);
    expect(s.provider.calls.exchangeCallback).toHaveLength(1);
    expect(s.provider.calls.revokeSession).toEqual([{ externalSessionId: 'session_test_001', reason: 'security_event' }]);
    expect(s.sessionStore.created).toHaveLength(0);
  });

  it('validates an upstream session and returns metadata with no authority payload', async () => {
    const s = setup();
    await s.sessionStore.create({
      userId: 'user-local-1',
      organizationId: 'org-local-1',
      workspaceId: 'workspace-local-1',
      permissionVersion: 7,
      upstreamProvider: 'fake',
      upstreamSessionId: 'session_test_001',
      expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + 3_600_000),
    });
    const cookie = s.codec.serialize(SESSION_ID, s.sessionStore.current!.expiresAt, NOW);
    const response = await invoke(
      s.route('GET', '/hosted/auth/session'),
      new Request(`${ORIGIN}/api/hosted/auth/session`, { headers: { cookie } }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      identity: { externalUserId: 'user_test_001', emailVerified: true },
      session: {
        sessionId: SESSION_ID,
        userId: 'user-local-1',
        organizationId: 'org-local-1',
        workspaceId: 'workspace-local-1',
        permissionVersion: 7,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/permissions|capabilities/);
  });

  it('revokes and clears a locally valid session when upstream rejects it', async () => {
    const provider = createFakeHostedIdentityProvider({
      script: {
        validateSession: hostedIdentityProviderFailure({
          code: 'session_revoked',
          safeMessage: 'The session was revoked.',
          retryable: false,
        }),
      },
    });
    const s = setup(provider);
    await s.sessionStore.create({
      userId: 'user-local-1',
      organizationId: 'org-local-1',
      workspaceId: null,
      permissionVersion: 7,
      upstreamProvider: 'fake',
      upstreamSessionId: 'session_test_001',
      expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + 3_600_000),
    });
    const cookie = s.codec.serialize(SESSION_ID, s.sessionStore.current!.expiresAt, NOW);
    const response = await invoke(
      s.route('GET', '/hosted/auth/session'),
      new Request(`${ORIGIN}/api/hosted/auth/session`, { headers: { cookie } }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(s.sessionStore.revoked[0]).toMatchObject({ id: SESSION_ID });
  });

  it('requires exact-origin logout and clears locally even when upstream operations fail', async () => {
    const provider = createFakeHostedIdentityProvider({
      script: {
        beginLogout: hostedIdentityProviderFailure({
          code: 'provider_unavailable',
          safeMessage: 'Unavailable.',
          retryable: true,
        }),
        revokeSession: hostedIdentityProviderFailure({
          code: 'provider_unavailable',
          safeMessage: 'Unavailable.',
          retryable: true,
        }),
      },
    });
    const s = setup(provider);
    await s.sessionStore.create({
      userId: 'user-local-1',
      organizationId: 'org-local-1',
      workspaceId: null,
      permissionVersion: 7,
      upstreamProvider: 'fake',
      upstreamSessionId: 'session_test_001',
      expiresAt: new Date(FAKE_HOSTED_IDENTITY_NOW_MS + 3_600_000),
    });
    const cookie = s.codec.serialize(SESSION_ID, s.sessionStore.current!.expiresAt, NOW);

    const crossOrigin = await invoke(
      s.route('POST', '/hosted/auth/logout'),
      new Request(`${ORIGIN}/api/hosted/auth/logout`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', cookie },
        body: '{}',
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(s.sessionStore.revoked).toHaveLength(0);

    const response = await invoke(
      s.route('POST', '/hosted/auth/logout'),
      new Request(`${ORIGIN}/api/hosted/auth/logout`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ returnTo: '/signed-out' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      returnTo: '/signed-out',
      redirectTo: '/signed-out',
      upstreamRevoked: false,
    });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(s.sessionStore.revoked).toEqual([{ id: SESSION_ID, reason: 'user_logout' }]);
  });
});

describe('safeHostedReturnTarget', () => {
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
    'rejects %s',
    (value) => {
      expect(safeHostedReturnTarget(value, ORIGIN)).toBeNull();
    },
  );

  it('preserves a same-origin relative path, query, and hash', () => {
    expect(safeHostedReturnTarget('/workspaces/ws-1?tab=activity#recent', ORIGIN)).toBe(
      '/workspaces/ws-1?tab=activity#recent',
    );
  });
});
