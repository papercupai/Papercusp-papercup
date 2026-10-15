import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type {
  HostedPrincipalResolution,
  HostedPrincipalResolver,
} from '../auth/hosted-principal-resolver';
import { hostedPermissionsForMembership } from '../auth/hosted-role-permissions';
import type { RouteDefinition } from './define-route';
import { registerRoute } from './define-route';
import { createHostedRouteStack } from './hosted-route-stack';
import { DEFAULT_ROUTE_STACK } from './route-stack';

const CONTROL_PLANE_WORKSPACE = 'papercusp-control-plane';
const SESSION_ID = `hs_${'A'.repeat(43)}`;

function principal(role: 'owner' | 'admin' | 'member' | 'billing' = 'member') {
  return createHostedPrincipal({
    workspaceId: CONTROL_PLANE_WORKSPACE,
    userId: 'user-1',
    activeOrganizationId: 'org-1',
    sessionId: SESSION_ID,
    sessionVersion: 7,
    permissions: hostedPermissionsForMembership({ role, status: 'active' }),
  });
}

function allow(role: 'owner' | 'admin' | 'member' | 'billing' = 'member'): HostedPrincipalResolver {
  return async () =>
    ({
      ok: true,
      principal: principal(role),
      session: { id: SESSION_ID } as never,
      membership: { organizationId: 'org-1' } as never,
    }) as HostedPrincipalResolution;
}

function deny(reason: string): HostedPrincipalResolver {
  return async () => ({ ok: false, reason }) as HostedPrincipalResolution;
}

function route(
  auth: RouteDefinition['auth'],
  path = '/hosted/probe',
  method: RouteDefinition['method'] = 'GET',
): RouteDefinition {
  return {
    method,
    path,
    auth,
    handler: (_req, ctx) =>
      Response.json({
        principalKind: ctx.principal?.kind ?? null,
        capabilities: ctx.principal ? [...ctx.principal.capabilities].sort() : null,
      }),
  };
}

function mount(def: RouteDefinition, resolve: HostedPrincipalResolver, sessionRoutes: ReadonlyArray<RouteDefinition> = []): Hono {
  const app = new Hono().basePath('/api');
  registerRoute(app, def, createHostedRouteStack(resolve, sessionRoutes));
  return app;
}

describe('hosted route stack', () => {
  it('admits only the reviewed session route without granting any workspace authority', async () => {
    const def = route({ capabilities: [], kind: ['user'], trust: ['verified'] });
    const user = createHostedPrincipal({
      workspaceId: CONTROL_PLANE_WORKSPACE, userId: 'user-1', activeOrganizationId: 'org-1',
      sessionId: SESSION_ID, sessionVersion: 7, permissions: [],
    });
    const resolve: HostedPrincipalResolver = async () => ({
      ok: true, principal: user, session: { id: SESSION_ID } as never,
      membership: { organizationId: 'org-1' } as never,
    });
    const response = await mount(def, resolve, [def]).request('/api/hosted/probe');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principalKind: 'user', capabilities: [] });
    expect((await mount(def, resolve).request('/api/hosted/probe')).status).toBe(403);
    expect((await mount({ ...def }, resolve, [def]).request('/api/hosted/probe')).status).toBe(403);
    expect((await mount(def, deny('session_cookie_missing'), [def]).request('/api/hosted/probe')).status).toBe(401);
    expect((await mount(def, deny('membership_not_active'), [def]).request('/api/hosted/probe')).status).toBe(403);
    expect((await mount(route({ capabilities: ['workspace:view'] }), resolve, [def]).request('/api/hosted/probe')).status).toBe(403);
    const drifted = route({ capabilities: ['*'], kind: ['user'], trust: ['verified'] });
    expect((await mount(drifted, resolve, [drifted]).request('/api/hosted/probe')).status).toBe(403);
  });

  it('replaces exactly the auth step and inherits input and invoke', () => {
    const stack = createHostedRouteStack(allow());
    expect(stack.map((step) => step.name)).toEqual(['auth', 'input', 'invoke']);

    const defaultAuth = DEFAULT_ROUTE_STACK.find((step) => step.name === 'auth');
    expect(stack[0]).not.toBe(defaultAuth);
    // input and invoke are the SAME objects as the default stack's, so timeout,
    // telemetry and census behaviour cannot drift between the two profiles.
    for (const name of ['input', 'invoke'] as const) {
      expect(stack.find((step) => step.name === name)).toBe(
        DEFAULT_ROUTE_STACK.find((step) => step.name === name),
      );
    }
  });

  it('admits a public route with no principal', async () => {
    const app = mount(route('public'), deny('session_cookie_missing'));
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ principalKind: null, capabilities: null });
  });

  it('never reflects a hosted handler exception into its HTTP error body', async () => {
    const privateValue = 'hosted-private-sql-customer@example.test';
    const app = mount({
      ...route('public', '/hosted/fault'),
      handler: () => { throw new Error(`SQL failed for ${privateValue}`); },
    }, allow());
    const res = await app.request('/api/hosted/fault');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'handler_error', message: 'The hosted service could not complete the request.' },
    });
    expect(JSON.stringify(body)).not.toContain(privateValue);
  });

  it('never reflects a hosted auth-resolver exception into its HTTP error body', async () => {
    const privateValue = 'hosted-private-provider-token';
    const app = mount(route({ capabilities: ['workspace:view'] }), async () => {
      throw new Error(`provider payload ${privateValue}`);
    });
    const res = await app.request('/api/hosted/probe');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'handler_error', message: 'The hosted service could not complete the request.' },
    });
    expect(JSON.stringify(body)).not.toContain(privateValue);
  });

  it('admits an authenticated route and hands the handler the hosted principal', async () => {
    const app = mount(route({ capabilities: ['workspace:view'] }), allow('member'));
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principalKind: 'user',
      capabilities: ['workspace:operate', 'workspace:view'],
    });
  });

  it('refuses a loopback declaration rather than treating it as public', async () => {
    const app = mount(route('loopback'), allow());
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/loopback routes are not mounted/);
  });

  it.each([
    ['session_cookie_missing', 401],
    ['session_not_found', 401],
    ['session_permission_version_stale', 401],
    ['membership_not_active', 403],
    ['session_organization_mismatch', 403],
    ['workspace_not_in_organization', 403],
    ['authority_unavailable', 503],
  ] as const)('maps denial %s to HTTP %i', async (reason, status) => {
    const app = mount(route({ capabilities: ['workspace:view'] }), deny(reason));
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(status);
    expect((await res.json()).error.message).toBe(reason);
  });

  it('re-authentication is only suggested when it would help', async () => {
    // A 401 tells the browser to restart hosted sign-in. A permission failure
    // must NOT, or the user is sent into a sign-in loop that cannot succeed.
    const forbidden = mount(route({ capabilities: ['workspace:view'] }), deny('membership_not_active'));
    expect((await forbidden.request('/api/hosted/probe')).status).toBe(403);
  });

  it('denies a permission the role does not carry', async () => {
    const app = mount(route({ capabilities: ['workspace:destroy'] }), allow('member'));
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('missing permission: workspace:destroy');
  });

  it('requires every declared capability, not just one', async () => {
    const app = mount(
      route({ capabilities: ['workspace:view', 'billing:manage'] }),
      allow('member'),
    );
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('missing permission: billing:manage');
  });

  it('never satisfies a route from a wildcard capability', async () => {
    // The local gate admits any requirement when the principal holds '*'. This
    // stack has no such branch — and a route REQUIRING '*' is refused outright.
    const app = mount(route({ capabilities: ['*'] }), allow('owner'));
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/wildcard capability is not grantable/);
  });

  it('refuses a capability outside the hosted vocabulary', async () => {
    const app = mount(route({ capabilities: ['admin:everything'] }), allow('owner'));
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('unknown hosted permission: admin:everything');
  });

  it('refuses an authenticated route that declares no concrete capability', async () => {
    const app = mount(route({}), allow('owner'));
    const res = await app.request('/api/hosted/probe');

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/at least one concrete capability/);
  });

  it('enforces declared trust and kind allowlists against the hosted principal', async () => {
    const wrongKind = mount(
      route({ capabilities: ['workspace:view'], kind: ['system'] }),
      allow('member'),
    );
    expect((await wrongKind.request('/api/hosted/probe')).status).toBe(403);

    const wrongTrust = mount(
      route({ capabilities: ['workspace:view'], trust: ['trusted'] }),
      allow('member'),
    );
    expect((await wrongTrust.request('/api/hosted/probe')).status).toBe(403);
  });

  describe('the local principal chain is unreachable', () => {
    // The hosted resolver is the ONLY authenticator. These are the credentials
    // that satisfy the local chain (`requirePrincipal`: cookie session, device
    // JWT, superuser bearer, agent bearer, loopback); none may authenticate a
    // hosted request. The resolver here denies unconditionally, so a 200 could
    // only come from some other authenticator running.
    const resolver = deny('session_cookie_missing');

    it.each([
      ['local session cookie', { cookie: 'papercusp_session=local-operator-session' }],
      ['superuser bearer', { authorization: 'Bearer papercusp-superuser-token' }],
      ['agent bearer', { authorization: 'Bearer agent-token-0' }],
      ['device jwt', { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig' }],
      ['loopback host', { host: '127.0.0.1' }],
      ['forwarded loopback', { 'x-forwarded-for': '127.0.0.1' }],
    ])('rejects a request carrying a %s', async (_label, headers) => {
      const app = mount(route({ capabilities: ['workspace:view'] }), resolver);
      const res = await app.request('/api/hosted/probe', { headers });

      expect(res.status).toBe(401);
      expect((await res.json()).error.message).toBe('session_cookie_missing');
    });

    it('rejects a query-string token even when the route opts into tokenIn query', async () => {
      const app = mount(
        route({ capabilities: ['workspace:view'], tokenIn: ['query'] }),
        resolver,
      );
      const res = await app.request('/api/hosted/probe?token=papercusp-superuser-token');

      expect(res.status).toBe(401);
    });
  });
});
