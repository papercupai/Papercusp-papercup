import { describe, expect, it, vi } from 'vitest';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { HostedIdentityDirectory } from '../auth/hosted-identity-binding';
import { toAuthority, type HostedMembershipAuthorityReader } from '../auth/hosted-membership-authority';
import { type CreateHostedSessionInput, type HostedSession } from '../auth/hosted-session';
import { createFakeHostedIdentityProvider, FAKE_HOSTED_IDENTITY_NOW_MS } from '../auth/hosted/fake-provider';
import { HOSTED_AUTH_CALLBACK_PATH, HOSTED_AUTH_FLOW_COOKIE } from './routes/hosted-auth';
import type { HostedAuthFlow, HostedAuthFlowConsumeResult, HostedAuthFlowStore } from './routes/hosted-auth/flow';
import { assembleHostedControlPlane } from './hosted-control-plane';
import { createHostedBrowserRoutes, HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH, HOSTED_BROWSER_REST_QUERY_PATH, HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH } from './hosted-browser';
import { HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST } from './hosted-profile';
import { ALL_ROUTES } from './routes';

const ORIGIN = 'https://app.papercusp.com';
const NOW = new Date(FAKE_HOSTED_IDENTITY_NOW_MS);
const COOKIE_SECRET = 'hosted-control-plane-test-cookie-secret-is-at-least-32-bytes';
const SESSION_ID = `hs_${'A'.repeat(43)}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTROL_PLANE_WORKSPACE_ID = 'hosted-control-plane';
const MEMBERSHIP_UPDATED_AT = new Date('2026-08-27T12:00:00.000Z');

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

class MemorySessionStore {
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
    return id === this.current?.id && this.current.revokedAt === null ? this.current : null;
  }

  async revoke(id: string, reason = 'logout', at = NOW): Promise<boolean> {
    if (id !== this.current?.id || this.current.revokedAt !== null) return false;
    this.revoked.push({ id, reason });
    this.current = { ...this.current, revokedAt: at, revocationReason: reason };
    return true;
  }
}

function fixedEntropy(): (size: number) => Uint8Array {
  let value = 1;
  return (size) => new Uint8Array(size).fill(value++);
}

function responseCookieValue(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${name}=([^;,]+)`));
  if (!match) throw new Error(`missing response cookie ${name}: ${header}`);
  return decodeURIComponent(match[1]);
}

describe('assembleHostedControlPlane', () => {
  it('mounts the complete browser manifest and serves account progress before workspace selection', async () => {
    const membership = toAuthority({
      organization_id: ORGANIZATION_ID, user_id: USER_ID, role: 'member',
      status: 'active', updated_at: MEMBERSHIP_UPDATED_AT,
    });
    if (!membership) throw new Error('test membership must be authoritative');
    const sessionStore = new MemorySessionStore();
    await sessionStore.create({
      userId: USER_ID, organizationId: ORGANIZATION_ID, workspaceId: null,
      permissionVersion: membership.permissionVersion, upstreamProvider: 'fake',
      upstreamSessionId: 'session_test_001', expiresAt: new Date(NOW.getTime() + 60_000),
    });
    let active = true;
    const runTenant = vi.fn(async (_context: VerifiedTenantServerContext) => null as never);
    const recordTransportFallback = vi.fn(() => true);
    const browser = createHostedBrowserRoutes({
      publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE_ID,
      dependencies: { runTenant, recordTransportFallback },
    });
    const plane = assembleHostedControlPlane({
      provider: createFakeHostedIdentityProvider(), publicOrigin: ORIGIN,
      sessionCookieSecret: COOKIE_SECRET, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE_ID,
      sessionStore, flowStore: new MemoryFlowStore(), clock: () => NOW,
      identityDirectory: {
        resolveLinkedUser: async () => ({ userId: USER_ID }),
        resolveOrganization: async () => ({ organizationId: ORGANIZATION_ID }),
        listActiveOrganizationIds: async () => [ORGANIZATION_ID],
      },
      membershipAuthority: {
        resolveActive: async () => active ? membership : null,
        workspaceBelongsToOrganization: async () => true,
      },
      // A custom registry replaces the default; retain the health leaves that
      // the complete production allowlist requires.
      routes: [...ALL_ROUTES, ...browser.routes],
      staticAllowlist: [...HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST, ...browser.allowlist],
    });
    const cookie = plane.components.sessionCookieCodec.serialize(SESSION_ID, new Date(NOW.getTime() + 60_000), NOW).split(';')[0];
    const path = `/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}?scope=account&version=3`;
    expect((await plane.app.request('/api/health')).status).toBe(200);
    expect((await plane.app.request(path)).status).toBe(401);
    expect(runTenant).not.toHaveBeenCalled();

    const response = await plane.app.request(path, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ record: null });
    expect(runTenant).toHaveBeenCalledTimes(1);
    expect(runTenant.mock.calls[0][0]).toMatchObject({ principal: {
      userId: USER_ID, activeOrganizationId: ORGANIZATION_ID, workspaceId: CONTROL_PLANE_WORKSPACE_ID,
    } });
    expect(runTenant.mock.calls[0][0]).not.toHaveProperty('selectedWorkspace');

    for (const [method, requestPath, headers] of [
      ['GET', path, { cookie, 'x-papercusp-workspace': 'other-tenant-workspace' }],
      ['POST', path, { cookie, origin: 'https://untrusted.example' }],
      ['GET', `/api${HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH}`, { cookie }],
      ['GET', `/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=workspaceHosts.control`, { cookie }],
    ] as const) {
      expect((await plane.app.request(requestPath, { method, headers })).status).toBe(403);
    }
    expect(runTenant).toHaveBeenCalledTimes(1);

    // Exercise the mounted production auth stack, rather than calling only the leaf.
    const diagnosticsPath = `/api${HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH}`;
    const transportBody = JSON.stringify({ kind: 'fallback-observation', payload: {
      source: 'sync-transport', mechanism: 'browser-sync-transport', eligible: 1,
      applied: 0, reason: 'preferred-unavailable', scope: 'SSE',
    } });
    expect((await plane.app.request(diagnosticsPath, {
      method: 'POST', headers: { origin: ORIGIN }, body: transportBody,
    })).status).toBe(401);
    expect((await plane.app.request(diagnosticsPath, {
      method: 'POST', headers: { cookie, origin: ORIGIN }, body: transportBody,
    })).status).toBe(403);
    expect(recordTransportFallback).not.toHaveBeenCalled();
    if (!sessionStore.current) throw new Error('test session must exist');
    sessionStore.current = { ...sessionStore.current, workspaceId: 'tenant-a' };
    expect((await plane.app.request(diagnosticsPath, {
      method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: transportBody,
    })).status).toBe(202);
    expect(recordTransportFallback).toHaveBeenCalledExactlyOnceWith('browser-sync-transport', {
      eligible: 1, applied: 0, reason: 'preferred-unavailable', scope: 'SSE',
    }, { processTag: 'browser-sync-ingress' });
    expect((await plane.app.request(diagnosticsPath, {
      method: 'POST', headers: { cookie, origin: 'https://untrusted.example' }, body: transportBody,
    })).status).toBe(403);
    expect((await plane.app.request(diagnosticsPath, { method: 'GET', headers: { cookie } })).status).toBe(404);
    expect((await plane.app.request('/api/desktop/telemetry-report', {
      method: 'POST', headers: { cookie, origin: ORIGIN }, body: transportBody,
    })).status).toBe(404);
    expect(recordTransportFallback).toHaveBeenCalledTimes(1);
    active = false;
    expect((await plane.app.request(path, { headers: { cookie } })).status).toBe(403);
    expect((await plane.app.request(diagnosticsPath, {
      method: 'POST', headers: { cookie, origin: ORIGIN }, body: transportBody,
    })).status).toBe(403);
    expect(recordTransportFallback).toHaveBeenCalledTimes(1);
    expect(runTenant).toHaveBeenCalledTimes(1);
  });

  it('shares one authority, session store, and cookie codec from mint through first request', async () => {
    const membership = toAuthority({
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      role: 'admin',
      status: 'active',
      updated_at: MEMBERSHIP_UPDATED_AT,
    });
    if (!membership) throw new Error('test membership must be authoritative');

    const authorityCalls: Array<{ userId: string; organizationId: string }> = [];
    const membershipAuthority: HostedMembershipAuthorityReader = {
      async resolveActive(input) {
        authorityCalls.push(input);
        return membership;
      },
      async workspaceBelongsToOrganization() {
        return true;
      },
    };
    const identityDirectory: HostedIdentityDirectory = {
      async resolveLinkedUser() {
        return { userId: USER_ID };
      },
      async resolveOrganization() {
        return { organizationId: ORGANIZATION_ID };
      },
      async listActiveOrganizationIds() {
        return [ORGANIZATION_ID];
      },
    };
    const sessionStore = new MemorySessionStore();
    const flowStore = new MemoryFlowStore();
    const provider = createFakeHostedIdentityProvider();

    const plane = assembleHostedControlPlane({
      provider,
      publicOrigin: ORIGIN,
      sessionCookieSecret: COOKIE_SECRET,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE_ID,
      sessionStore,
      membershipAuthority,
      identityDirectory,
      flowStore,
      clock: () => NOW,
      randomBytes: fixedEntropy(),
    });

    expect(plane.components.sessionStore).toBe(sessionStore);
    expect(plane.components.membershipAuthority).toBe(membershipAuthority);
    expect(plane.components.identityDirectory).toBe(identityDirectory);
    expect(plane.mounted.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /health',
      'GET /health/ready',
      'GET /hosted/auth/sign-in',
      'GET /hosted/auth/callback',
      'POST /hosted/auth/logout',
      'GET /hosted/auth/session',
    ]);

    const signIn = await plane.app.request(`/api/hosted/auth/sign-in?returnTo=${encodeURIComponent('/workspaces')}`);
    expect(signIn.status).toBe(302);
    const state = new URL(signIn.headers.get('location') ?? '').searchParams.get('state');
    expect(state).toBeTruthy();
    const flowCookie = responseCookieValue(signIn, HOSTED_AUTH_FLOW_COOKIE);

    const callback = await plane.app.request(
      `/api/hosted/auth/callback?code=code-1&state=${encodeURIComponent(state ?? '')}`,
      {
        headers: {
          cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(flowCookie)}`,
        },
      },
    );
    expect(callback.status).toBe(303);
    const sessionCookie = responseCookieValue(callback, '__Host-papercusp_session');
    expect(sessionStore.created).toHaveLength(1);
    expect(sessionStore.created[0]).toMatchObject({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      workspaceId: null,
      permissionVersion: membership.permissionVersion,
      upstreamProvider: provider.providerId,
      upstreamSessionId: 'session_test_001',
    });

    const firstAuthenticatedRequest = await plane.app.request('/api/hosted/auth/session', {
      headers: {
        cookie: `__Host-papercusp_session=${encodeURIComponent(sessionCookie)}`,
      },
    });
    expect(firstAuthenticatedRequest.status).toBe(200);
    expect(await firstAuthenticatedRequest.json()).toMatchObject({
      ok: true,
      session: {
        sessionId: SESSION_ID,
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        workspaceId: null,
        permissionVersion: membership.permissionVersion,
      },
    });

    // One call minted the snapshot; the second re-derived it during the very
    // first authenticated request. A second authority instance/store/codec on
    // either side makes this route fail even though the callback succeeded.
    expect(authorityCalls).toEqual([
      { userId: USER_ID, organizationId: ORGANIZATION_ID },
      { userId: USER_ID, organizationId: ORGANIZATION_ID },
    ]);
  });

  it('refuses an empty control-plane workspace at boot', () => {
    expect(() =>
      assembleHostedControlPlane({
        provider: createFakeHostedIdentityProvider(),
        publicOrigin: ORIGIN,
        sessionCookieSecret: COOKIE_SECRET,
        controlPlaneWorkspaceId: '  ',
      }),
    ).toThrow('hosted_control_plane_requires_a_control_plane_workspace_id');
  });
});
