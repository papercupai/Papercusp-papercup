import { describe, expect, it, vi } from 'vitest';
import { HostedSessionCookieCodec, type CreateHostedSessionInput, type HostedSession } from '../auth/hosted-session';
import { createFakeHostedIdentityProvider, FAKE_HOSTED_IDENTITY_NOW_MS } from '../auth/hosted/fake-provider';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { RouteDefinition } from './define-route';
import { ALL_ROUTES } from './routes';
import { HOSTED_AUTH_ROUTES, type HostedAuthSessionStore } from './routes/hosted-auth';
import type {
  HostedAuthFlow,
  HostedAuthFlowConsumeResult,
  HostedAuthFlowStore,
} from './routes/hosted-auth/flow';
import {
  HOSTED_AUTH_ROUTE_ALLOWLIST,
  HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
  createHostedControlPlane,
  createHostedControlPlaneApp,
  selectHostedControlPlaneRoutes,
  type HostedRouteAllowlistEntry,
} from './hosted-profile';

function route(
  method: RouteDefinition['method'],
  path: string,
  auth: RouteDefinition['auth'],
  body = path,
): RouteDefinition {
  return {
    method,
    path,
    auth,
    handler: () => new Response(body),
  };
}

describe('hosted control-plane route profile', () => {
  it('keeps the production default allowlist explicit and minimal', () => {
    expect(HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST).toEqual([
      { method: 'GET', path: '/health', access: 'public' },
      { method: 'GET', path: '/health/ready', access: 'public' },
    ]);

    expect(
      selectHostedControlPlaneRoutes(ALL_ROUTES).map(({ method, path }) => `${method} ${path}`),
    ).toEqual(['GET /health', 'GET /health/ready']);
  });

  it('mounts only explicitly approved public and capability-scoped routes', async () => {
    const routes = [
      route('GET', '/status', 'public', 'public'),
      route('GET', '/workspaces/:id', { capabilities: ['workspace:view'] }, 'authenticated'),
      route('POST', '/local-only', 'loopback', 'local'),
    ];
    const allowlist: HostedRouteAllowlistEntry[] = [
      { method: 'GET', path: '/status', access: 'public' },
      { method: 'GET', path: '/workspaces/:id', access: 'authenticated' },
    ];
    const app = createHostedControlPlaneApp(routes, allowlist);

    expect((await app.request('/api/status')).status).toBe(200);
    expect((await app.request('/api/local-only')).status).toBe(404);
    // The route is mounted, then the ordinary route stack owns the exact auth
    // response. This focused profile test intentionally does not mock the
    // principal resolver; a non-404 proves registration without coupling the
    // mount matrix to that resolver's infrastructure.
    expect((await app.request('/api/workspaces/ws-1')).status).not.toBe(404);
    expect((await app.request('/api/not-allowlisted')).status).toBe(404);
  });

  it.each([
    ['POST', '/auth/login'],
    ['POST', '/auth/logout'],
    ['POST', '/auth/signup'],
    ['POST', '/auth/change-password'],
    ['GET', '/auth/me'],
    ['PATCH', '/auth/me'],
    ['POST', '/cupboard/install-plugin'],
    ['POST', '/desktop/install-papercusp-files'],
    ['POST', '/provision/run'],
  ] as const)('rejects forbidden local surface %s %s even when explicitly allowlisted', (method, path) => {
    const def = route(method, path, 'public');
    expect(() => selectHostedControlPlaneRoutes(
      [def],
      [{ method, path, access: 'public' }],
    )).toThrow(/forbidden/);
  });

  it('fails closed on missing, duplicate, catch-all, and auth-drifted entries', () => {
    expect(() => selectHostedControlPlaneRoutes([], [
      { method: 'GET', path: '/missing', access: 'public' },
    ])).toThrow(/not registered/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/same', 'public')],
      [
        { method: 'GET', path: '/same', access: 'public' },
        { method: 'GET', path: '/same', access: 'public' },
      ],
    )).toThrow(/duplicate allowlist/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/files/*', 'public')],
      [{ method: 'GET', path: '/files/*', access: 'public' }],
    )).toThrow(/catch-all/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/private', 'loopback')],
      [{ method: 'GET', path: '/private', access: 'authenticated' }],
    )).toThrow(/authenticated principal/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/weak', {})],
      [{ method: 'GET', path: '/weak', access: 'authenticated' }],
    )).toThrow(/concrete capability/);

    expect(() => selectHostedControlPlaneRoutes(
      [route('GET', '/wildcard', { capabilities: ['*'] })],
      [{ method: 'GET', path: '/wildcard', access: 'authenticated' }],
    )).toThrow(/wildcard capability/);
  });

  it('requires an explicit session tier with exact verified-user requirements', () => {
    const session = route('GET', '/onboarding', { capabilities: [], kind: ['user'], trust: ['verified'] });
    expect(selectHostedControlPlaneRoutes([session], [
      { method: 'GET', path: '/onboarding', access: 'session' },
    ])).toEqual([session]);
    expect(() => selectHostedControlPlaneRoutes([session], [
      { method: 'GET', path: '/onboarding', access: 'authenticated' },
    ])).toThrow(/concrete capability/);
    for (const auth of [
      'public', {}, { capabilities: [] },
      { capabilities: [], kind: ['user'], trust: ['verified', 'trusted'] },
      { capabilities: [], kind: ['user', 'system'], trust: ['verified'] },
      { capabilities: ['*'], kind: ['user'], trust: ['verified'] },
      { capabilities: ['workspace:view'], kind: ['user'], trust: ['verified'] },
    ] satisfies RouteDefinition['auth'][]) {
      expect(() => selectHostedControlPlaneRoutes([route('GET', '/onboarding', auth)], [
        { method: 'GET', path: '/onboarding', access: 'session' },
      ])).toThrow(/authenticated principal|verified user/);
    }
  });
});

/* ─── The integration: hosted auth routes actually mounted ──────────────── */

const HOSTED_ORIGIN = 'https://app.papercusp.com';
const HOSTED_NOW = new Date(FAKE_HOSTED_IDENTITY_NOW_MS);
const COOKIE_SECRET = 'hosted-profile-test-cookie-secret-is-at-least-32-bytes';

class NullSessionStore implements HostedAuthSessionStore {
  async create(input: CreateHostedSessionInput): Promise<HostedSession> {
    return {
      id: `hs_${'A'.repeat(43)}`,
      userId: input.userId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId ?? null,
      permissionVersion: input.permissionVersion,
      upstreamProvider: input.upstreamProvider,
      upstreamSessionId: input.upstreamSessionId,
      createdAt: HOSTED_NOW,
      rotatedAt: null,
      expiresAt: input.expiresAt,
      lastSeenAt: null,
      revokedAt: null,
      revocationReason: null,
      updatedAt: HOSTED_NOW,
    };
  }

  async resolve(): Promise<HostedSession | null> {
    return null;
  }

  async revoke(): Promise<boolean> {
    return false;
  }
}

class MemoryFlowStore implements HostedAuthFlowStore {
  private readonly flows = new Map<string, HostedAuthFlow>();
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

function hostedControlPlane(
  resolvePrincipal?: HostedPrincipalResolver,
  extra: {
    routes?: ReadonlyArray<RouteDefinition>;
    staticAllowlist?: ReadonlyArray<HostedRouteAllowlistEntry>;
  } = {},
) {
  return createHostedControlPlane({
    hostedAuth: {
      provider: createFakeHostedIdentityProvider(),
      bindIdentity: async () => ({
        userId: 'user-1',
        organizationId: 'org-1',
        workspaceId: 'workspace-1',
        permissionVersion: 7,
      }),
      sessionStore: new NullSessionStore(),
      sessionCookieCodec: new HostedSessionCookieCodec(COOKIE_SECRET),
      // Injected: the default flow store is Postgres-backed, and a unit test
      // that silently fell back to it would report a provider 503 rather than
      // exercise the mount.
      flowStore: new MemoryFlowStore(),
      publicOrigin: HOSTED_ORIGIN,
      clock: () => HOSTED_NOW,
    },
    resolvePrincipal:
      resolvePrincipal ?? (async () => ({ ok: false, reason: 'session_cookie_missing' })),
    ...(extra.routes === undefined ? {} : { routes: extra.routes }),
    ...(extra.staticAllowlist === undefined ? {} : { staticAllowlist: extra.staticAllowlist }),
  });
}

describe('hosted control plane integration', () => {
  it('derives the hosted auth allowlist from the route module manifest', () => {
    // Not restated here: the mounted set cannot drift from the implemented set.
    expect(HOSTED_AUTH_ROUTE_ALLOWLIST).toBe(HOSTED_AUTH_ROUTES);
  });

  it('mounts the static allowlist plus every hosted auth route', () => {
    const { mounted } = hostedControlPlane();

    expect(mounted.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /health',
      'GET /health/ready',
      'GET /hosted/auth/sign-in',
      'GET /hosted/auth/callback',
      'POST /hosted/auth/logout',
      'GET /hosted/auth/session',
    ]);
  });

  it('serves the hosted auth routes rather than 404ing them', async () => {
    // The regression this exists to prevent: createHostedAuthRoutes was
    // implemented and tested but never registered, so every hosted auth path
    // 404'd in production while its unit tests stayed green.
    const { app } = hostedControlPlane();

    // Sweeping every route bare-handed necessarily drives GET /hosted/auth/callback
    // with no `state`, and that path's recovery redirect deliberately warns — it is
    // the SOLE observability seam for state_required (see routes/hosted-auth/index.ts,
    // whose comment says to keep it). vitest-fail-on-console otherwise reads that
    // working seam as a test failure.
    //
    // ASSERTED rather than merely silenced: a bare mockImplementation would also stay
    // green if someone deleted the warn, which is precisely the observability
    // regression the seam exists to prevent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnCalls: readonly unknown[][] = [];
    try {
      for (const { method, path } of HOSTED_AUTH_ROUTES) {
        const res = await app.request(`/api${path}`, { method });
        expect(res.status).not.toBe(404);
      }
      warnCalls = warn.mock.calls.map((call) => [...call]);
    } finally {
      // Restore before the assertion below, so a failure here cannot leave the spy
      // installed and cascade into every later test in the file.
      warn.mockRestore();
    }

    expect(
      warnCalls.some(
        ([first]) =>
          typeof first === 'string' &&
          first.includes('[hosted-auth] callback recovery redirect code=state_required'),
      ),
      'the hosted-auth state_required observability seam did not fire',
    ).toBe(true);
  });

  it('answers unauthenticated hosted requests through the HOSTED stack', async () => {
    const { app } = hostedControlPlane();

    const res = await app.request('/api/hosted/auth/session');
    expect(res.status).toBe(401);
    // The hosted resolver's typed reason — proof the hosted auth step ran, not
    // the local principal chain.
    expect((await res.json()).error.message).toBe('session_cookie_missing');
  });

  it('runs a public hosted auth route end to end', async () => {
    const { app } = hostedControlPlane();

    const res = await app.request(
      `/api/hosted/auth/sign-in?returnTo=${encodeURIComponent('/workspaces/ws-1')}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBeTruthy();
  });

  it('admits an authenticated request and hands the handler the hosted principal', async () => {
    const { createHostedPrincipal } = await import('../auth/hosted-principal');
    const probe: RouteDefinition = {
      method: 'GET',
      path: '/hosted/probe',
      auth: { capabilities: ['workspace:view'] },
      handler: (_req, ctx) =>
        Response.json({
          organizationId: (ctx.principal as { activeOrganizationId?: string } | null)
            ?.activeOrganizationId ?? null,
        }),
    };
    const { app } = hostedControlPlane(
      async () => ({
        ok: true,
        principal: createHostedPrincipal({
          workspaceId: 'papercusp-control-plane',
          userId: 'user-1',
          activeOrganizationId: 'org-1',
          sessionId: `hs_${'A'.repeat(43)}`,
          sessionVersion: 7,
          permissions: ['workspace:view'],
        }),
        session: { id: `hs_${'A'.repeat(43)}` } as never,
        membership: { organizationId: 'org-1' } as never,
      }),
      {
        routes: [probe],
        staticAllowlist: [{ method: 'GET', path: '/hosted/probe', access: 'authenticated' }],
      },
    );

    const res = await app.request('/api/hosted/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: 'org-1' });
  });

  it('denies that same authenticated route when no principal resolves', async () => {
    const probe: RouteDefinition = {
      method: 'GET',
      path: '/hosted/probe',
      auth: { capabilities: ['workspace:view'] },
      handler: () => Response.json({ reached: true }),
    };
    const { app } = hostedControlPlane(undefined, {
      routes: [probe],
      staticAllowlist: [{ method: 'GET', path: '/hosted/probe', access: 'authenticated' }],
    });

    const res = await app.request('/api/hosted/probe');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'session_cookie_missing' },
    });
  });

  it('still refuses every local authority surface after the hosted routes are added', async () => {
    const { app } = hostedControlPlane();

    for (const path of [
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/signup',
      '/api/auth/me',
      '/api/auth/change-password',
    ]) {
      expect((await app.request(path, { method: 'POST' })).status).toBe(404);
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it('refuses to mount a hosted auth manifest entry that is not implemented', () => {
    expect(() =>
      createHostedControlPlane({
        hostedAuth: {
          provider: createFakeHostedIdentityProvider(),
          bindIdentity: async () => null,
          sessionStore: new NullSessionStore(),
          sessionCookieCodec: new HostedSessionCookieCodec(COOKIE_SECRET),
          publicOrigin: HOSTED_ORIGIN,
          clock: () => HOSTED_NOW,
        },
        resolvePrincipal: async () => ({ ok: false, reason: 'session_cookie_missing' }),
        // A deployment cannot widen the surface with a route nobody implemented.
        staticAllowlist: [{ method: 'GET', path: '/not-implemented', access: 'public' }],
      }),
    ).toThrow(/not registered/);
  });
});

/**
 * P-013 / D-023 ruling 5 — the hosted profile can never mount a loopback route.
 *
 * The plan item requires that the `auth: 'loopback'` desktop routes are never
 * mounted in the hosted profile. That is already structural rather than
 * configured, so what this suite owes is a FALSIFIABLE guard rather than new
 * mounting code.
 *
 * The distinction matters: a test that merely asserted the desktop route is
 * absent from `HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST` would pass against a broken
 * version, because the allowlist is two health routes and absence is its default
 * state. These tests instead ATTEMPT the unsafe thing — allowlisting a loopback
 * route under each access tier — and require the refusal.
 *
 * They are written over the whole loopback CLASS rather than one path so that a
 * desktop route added later inherits the guard instead of needing a new case.
 */
describe('hosted profile refuses loopback routes (P-013 / D-023 ruling 5)', () => {
  const DESKTOP_VNC_ROUTE = { method: 'POST' as const, path: '/deploy/:slug/vnc-session' };

  const loopbackRoutes = ALL_ROUTES.filter((r) => r.auth === 'loopback');

  it('anchors on a real registered loopback desktop route', () => {
    // If this fails the guard below is testing nothing, so it is asserted first.
    const desktop = ALL_ROUTES.find(
      (r) => r.method === DESKTOP_VNC_ROUTE.method && r.path === DESKTOP_VNC_ROUTE.path,
    );
    expect(desktop, 'the local desktop VNC route must still exist to guard').toBeDefined();
    expect(desktop?.auth).toBe('loopback');
    expect(loopbackRoutes.length).toBeGreaterThan(0);
  });

  it('refuses the desktop VNC route allowlisted as authenticated', () => {
    expect(() =>
      selectHostedControlPlaneRoutes(ALL_ROUTES, [{ ...DESKTOP_VNC_ROUTE, access: 'authenticated' }]),
    ).toThrow(/must require an authenticated principal/);
  });

  it('refuses the desktop VNC route allowlisted as public', () => {
    expect(() =>
      selectHostedControlPlaneRoutes(ALL_ROUTES, [{ ...DESKTOP_VNC_ROUTE, access: 'public' }]),
    ).toThrow(/different auth tier/);
  });

  it('refuses EVERY registered loopback route under both access tiers', () => {
    for (const route of loopbackRoutes) {
      const entry = { method: route.method, path: route.path };
      expect(() =>
        selectHostedControlPlaneRoutes(ALL_ROUTES, [{ ...entry, access: 'authenticated' }]),
        `${route.method} ${route.path} must not be allowlistable as authenticated`,
      ).toThrow();
      expect(() =>
        selectHostedControlPlaneRoutes(ALL_ROUTES, [{ ...entry, access: 'public' }]),
        `${route.method} ${route.path} must not be allowlistable as public`,
      ).toThrow();
    }
  });

  it('mounts no loopback route in the shipped hosted allowlist', () => {
    const shipped = [...HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST, ...HOSTED_AUTH_ROUTE_ALLOWLIST];
    const loopbackKeys = new Set(loopbackRoutes.map((r) => `${r.method} ${r.path}`));
    for (const entry of shipped) {
      expect(loopbackKeys.has(`${entry.method} ${entry.path}`)).toBe(false);
    }
  });
});
