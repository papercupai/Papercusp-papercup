import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';
import { createHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { SyncEvent } from '../sync-sse';
import type { HostedFirstWorkspace, HostedFirstWorkspaceResult } from '../auth/hosted/first-workspace';
import { HostedCustomerDeletionAdmissionError } from '../data-governance/hosted-customer-data';
import {
  HOSTED_BROWSER_ACTION_PATH,
  HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH,
  HOSTED_BROWSER_FIRST_WORKSPACE_PATH,
  HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH,
  HOSTED_BROWSER_USER_EXPORT_PATH,
  HOSTED_BROWSER_ORGANIZATION_DELETE_PATH,
  HOSTED_BROWSER_USER_DELETE_PATH,
  HOSTED_BROWSER_QUERY_NAME,
  HOSTED_BROWSER_REST_QUERY_PATH,
  HOSTED_BROWSER_SELECT_WORKSPACE_PATH,
  HOSTED_BROWSER_SSE_PATH,
  createHostedBrowserRoutes,
  hostedProvisionBringUp,
  type HostedBrowserRouteDependencies,
} from './hosted-browser';

const ORIGIN = 'https://app.papercusp.com';
const CONTROL_PLANE_WORKSPACE = 'control-plane';
const SELECTED_WORKSPACE = 'tenant-a';
const NEVER_EMIT_MARKER = 'never-emit-me';

const principal = createHostedPrincipal({
  workspaceId: CONTROL_PLANE_WORKSPACE,
  userId: 'user-1',
  activeOrganizationId: 'org-1',
  selectedWorkspaceId: SELECTED_WORKSPACE,
  sessionId: 'session-1',
  sessionVersion: 1,
  permissions: ['workspace:view', 'workspace:operate', 'workspace:destroy', 'cloud-connection:manage'],
});

const fakeSql = (() => []) as unknown as Sql;

function context(current: HostedPrincipal = principal): RouteContext {
  return {
    principal: current,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
  };
}

function routeHandler(routes: ReturnType<typeof createHostedBrowserRoutes>['routes'], path: string) {
  const route = routes.find((candidate) => candidate.path === path);
  if (!route) throw new Error(`missing route ${path}`);
  return route.handler;
}

function tenantRunner(calls: Array<{ selectedWorkspaceId?: string }>) {
  return async <T>(ctx: VerifiedTenantServerContext, fn: (sql: Sql) => Promise<T>): Promise<T> => {
    calls.push({ selectedWorkspaceId: ctx.selectedWorkspace?.id });
    return fn(fakeSql);
  };
}

describe('hosted browser route boundary', () => {
  it('admits deletion only with exact confirmation and authenticated scope, returning durable acceptance', async () => {
    const requestCustomerDeletion = vi.fn(async () => ({ operationId: 'operation-1' }));
    const browser = createHostedBrowserRoutes({ publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { requestCustomerDeletion } });
    const handler = routeHandler(browser.routes, HOSTED_BROWSER_USER_DELETE_PATH);
    const request = (confirmation: string, origin = ORIGIN) => new Request(`${ORIGIN}/api${HOSTED_BROWSER_USER_DELETE_PATH}`, {
      method: 'POST', headers: { origin }, body: JSON.stringify({ confirmation, userId: 'another-user',
        organizationId: 'another-org', policy: { stripe: 'delete' }, operationId: 'caller-operation' }),
    });
    expect((await handler(request('DELETE MY ACCOUNT', 'https://other.test'), context())).status).toBe(403);
    expect((await handler(request('DELETE MY ACCOUNT'), { ...context(), principal: null })).status).toBe(401);
    expect((await handler(request('yes'), context())).status).toBe(400);
    expect(requestCustomerDeletion).not.toHaveBeenCalled();
    const response = await handler(request('DELETE MY ACCOUNT'), context());
    expect(response.status).toBe(202); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'accepted', operationId: 'operation-1' });
    expect(requestCustomerDeletion).toHaveBeenCalledExactlyOnceWith(principal, { kind: 'user', confirmation: 'DELETE MY ACCOUNT' });
    expect(browser.allowlist).toContainEqual({ method: 'POST', path: HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, access: 'session' });
  });

  it('reports pending retention and ownership transfer without exposing provider errors', async () => {
    const requestCustomerDeletion = vi.fn(async () => { throw new HostedCustomerDeletionAdmissionError('retention_policy_pending'); });
    const handler = routeHandler(createHostedBrowserRoutes({ publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { requestCustomerDeletion } }).routes, HOSTED_BROWSER_ORGANIZATION_DELETE_PATH);
    const request = () => new Request(`${ORIGIN}/api${HOSTED_BROWSER_ORGANIZATION_DELETE_PATH}`, {
      method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ confirmation: 'DELETE ORGANIZATION' }),
    });
    expect((await handler(request(), context())).status).toBe(409);
    requestCustomerDeletion.mockRejectedValueOnce(new Error('provider-secret-never-emit'));
    const failed = await handler(request(), context());
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('provider-secret-never-emit');
  });

  it('lets a verified member export their own account without a selected workspace or accepting a body-selected user', async () => {
    const member = createHostedPrincipal({ workspaceId: CONTROL_PLANE_WORKSPACE, userId: 'member',
      activeOrganizationId: 'org-a', sessionId: 'session', sessionVersion: 1, permissions: ['workspace:view'] });
    const exportUserData = vi.fn(async () => ({ receiptId: 'user-receipt', stores: [] }));
    const browser = createHostedBrowserRoutes({ publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { exportUserData } });
    expect(browser.allowlist).toContainEqual({ method: 'POST', path: HOSTED_BROWSER_USER_EXPORT_PATH, access: 'session' });
    const handler = routeHandler(browser.routes, HOSTED_BROWSER_USER_EXPORT_PATH);
    const request = (origin: string) => new Request(`${ORIGIN}/api${HOSTED_BROWSER_USER_EXPORT_PATH}`, {
      method: 'POST', headers: { origin }, body: JSON.stringify({ userId: 'someone-else', organizationId: 'other' }),
    });
    expect((await handler(request('https://other.test'), context(member))).status).toBe(403);
    expect((await handler(request(ORIGIN), { ...context(), principal: null })).status).toBe(401);
    expect(exportUserData).not.toHaveBeenCalled();
    const response = await handler(request(ORIGIN), context(member));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('user-data.json');
    expect(exportUserData).toHaveBeenCalledExactlyOnceWith(member);
  });

  it('exports the authenticated organization without a workspace and ignores caller-supplied scope', async () => {
    const account = createHostedPrincipal({ workspaceId: CONTROL_PLANE_WORKSPACE, userId: 'owner',
      activeOrganizationId: 'org-a', sessionId: 'session', sessionVersion: 1, permissions: ['members:manage'] });
    const exportOrganizationData = vi.fn(async () => ({ receiptId: 'receipt', stores: [] }));
    const browser = createHostedBrowserRoutes({ publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { exportOrganizationData } });
    expect(browser.allowlist).toContainEqual({ method: 'POST', path: HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH, access: 'session' });
    const response = await routeHandler(browser.routes, HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH)(new Request(
      `${ORIGIN}/api${HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH}`, { method: 'POST', headers: { origin: ORIGIN },
        body: JSON.stringify({ organizationId: 'org-b', workspaceIds: ['other'], userId: 'other' }) }), context(account));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(await response.json()).toEqual({ receiptId: 'receipt', stores: [] });
    expect(exportOrganizationData).toHaveBeenCalledExactlyOnceWith(account);
  });

  it('refuses unauthenticated, foreign-origin, foreign-workspace and non-admin exports before execution', async () => {
    const exportOrganizationData = vi.fn(async () => ({ receiptId: 'receipt', stores: [] }));
    const handler = routeHandler(createHostedBrowserRoutes({ publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE, dependencies: { exportOrganizationData } }).routes,
    HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH);
    const admin = createHostedPrincipal({ ...principal, permissions: ['members:manage'] });
    const request = (headers: Record<string, string>) => new Request(`${ORIGIN}/api${HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH}`,
      { method: 'POST', headers });
    expect((await handler(request({ origin: ORIGIN }), { ...context(), principal: null })).status).toBe(401);
    expect((await handler(request({ origin: 'https://other.test' }), context(admin))).status).toBe(403);
    expect((await handler(request({ origin: ORIGIN, 'x-papercusp-workspace': 'foreign' }), context(admin))).status).toBe(403);
    expect((await handler(request({ origin: ORIGIN }), context())).status).toBe(403);
    expect(exportOrganizationData).not.toHaveBeenCalled();
  });

  it('records only allowlisted transport outcomes through the shared local recorder', async () => {
    const recordTransportFallback = vi.fn(() => true);
    const browser = createHostedBrowserRoutes({
      publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { recordTransportFallback },
    });
    expect(browser.allowlist).toContainEqual({
      method: 'POST', path: HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH, access: 'authenticated',
    });
    const handler = routeHandler(browser.routes, HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH);
    for (const applied of [0, 1]) {
      const response = await handler(new Request(`${ORIGIN}/api${HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH}`, {
        method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'fallback-observation', workspaceId: 'tenant-b', payload: {
          source: 'sync-transport', mechanism: 'browser-sync-transport', eligible: 1, applied,
          reason: applied ? 'applied' : 'preferred-unavailable', scope: 'SSE',
          message: NEVER_EMIT_MARKER, url: '/private', processTag: 'spoofed', sql: 'spoofed',
        } }),
      }), context());
      expect(response.status).toBe(202);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(recordTransportFallback).toHaveBeenLastCalledWith('browser-sync-transport', {
        eligible: 1, applied, reason: applied ? 'applied' : 'preferred-unavailable', scope: 'SSE',
      }, { processTag: 'browser-sync-ingress' });
    }
    recordTransportFallback.mockReturnValue(false);
    const response = await handler(new Request(`${ORIGIN}/api${HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH}`, {
      method: 'POST', headers: { origin: ORIGIN },
      body: JSON.stringify({ kind: 'fallback-observation', payload: {
        source: 'sync-transport', mechanism: 'browser-sync-transport', eligible: 1,
        applied: 0, reason: 'preferred-unavailable', scope: 'WEBSOCKETS',
      } }),
    }), context());
    expect(response.status).toBe(503);
  });

  it('refuses unauthenticated, cross-origin and foreign-workspace diagnostic writes before recording', async () => {
    const recordTransportFallback = vi.fn(() => true);
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { recordTransportFallback },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH);
    // Exercise the missing-auth runtime boundary before the route dispatcher supplies a principal.
    const unauthenticated = { ...context(), principal: undefined } as unknown as RouteContext;
    for (const [ctx, headers, status] of [
      [unauthenticated, { origin: ORIGIN }, 401],
      [context(createHostedPrincipal({ ...principal, selectedWorkspaceId: undefined })), { origin: ORIGIN }, 403],
      [context(createHostedPrincipal({ ...principal, workspaceId: 'foreign' })), { origin: ORIGIN }, 403],
      [context(), {}, 403],
      [context(), { origin: 'https://untrusted.example' }, 403],
      [context(), { origin: ORIGIN, 'x-papercusp-workspace': 'tenant-b' }, 403],
    ] as const) {
      const response = await handler(new Request(`${ORIGIN}/api${HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH}`, {
        method: 'POST', headers, body: '{}',
      }), ctx);
      expect(response.status).toBe(status);
    }
    expect(recordTransportFallback).not.toHaveBeenCalled();
  });

  it('rejects crash reports, malformed JSON and arbitrary transport names on hosted diagnostics', async () => {
    const recordTransportFallback = vi.fn(() => true);
    const handler = routeHandler(createHostedBrowserRoutes({
      publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { recordTransportFallback },
    }).routes, HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH);
    const payload = { source: 'sync-transport', mechanism: 'browser-sync-transport', eligible: 1,
      applied: 0, reason: 'preferred-unavailable', scope: 'SSE' };
    for (const body of ['{', 'null', '[]', JSON.stringify({ kind: 'crash', payload }),
      JSON.stringify({ kind: 'fallback-observation', payload: { ...payload, scope: NEVER_EMIT_MARKER } }),
      JSON.stringify({ kind: 'fallback-observation', payload: { ...payload, eligible: 1000 } })]) {
      const response = await handler(new Request(`${ORIGIN}/api${HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH}`, {
        method: 'POST', headers: { origin: ORIGIN }, body,
      }), context());
      expect(response.status).toBe(400);
    }
    expect(recordTransportFallback).not.toHaveBeenCalled();
  });

  it('reads the fixed control-plane source inside the selected tenant transaction', async () => {
    const tenantCalls: Array<{ selectedWorkspaceId?: string }> = [];
    const readControl = vi.fn(async (workspaceId: string, tx?: Sql) => {
      expect(workspaceId).toBe(CONTROL_PLANE_WORKSPACE);
      expect(tx).toBe(fakeSql);
      return [{ kind: 'workspace', id: SELECTED_WORKSPACE }];
    });
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { runTenant: tenantRunner(tenantCalls), readControl },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_REST_QUERY_PATH);
    const request = new Request(
      `${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${encodeURIComponent(HOSTED_BROWSER_QUERY_NAME)}&args=%7B%7D`,
      { headers: { 'x-papercusp-workspace': CONTROL_PLANE_WORKSPACE } },
    );

    const response = await handler(request, context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rows: [{ kind: 'workspace', id: SELECTED_WORKSPACE }],
    });
    expect(readControl).toHaveBeenCalledTimes(1);
    expect(tenantCalls).toEqual([{ selectedWorkspaceId: SELECTED_WORKSPACE }]);
  });

  it('observes readiness only for the selected bound host and persisted active workspace; isolates analytics failure', async () => {
    const operation = { id: '00000000-0000-4000-8000-000000000002', action: 'provision', status: 'succeeded',
      startedAt: '2026-10-14T08:00:00Z', finishedAt: '2026-10-14T08:01:00Z', error: { message: NEVER_EMIT_MARKER } };
    const readBoundWorkspaceState = vi.fn(async () => 'active');
    const deliverCloudTelemetry = vi.fn<NonNullable<HostedBrowserRouteDependencies['deliverCloudTelemetry']>>(async () => { throw new Error('analytics down'); });
    const handler = routeHandler(createHostedBrowserRoutes({ publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { runTenant: tenantRunner([]), readBoundHostId: async () => 'own-host', readBoundWorkspaceState,
        readControl: async () => [{ kind: 'workspace', id: 'own-host', target: 'gcp', observedState: 'running', operation },
          { kind: 'workspace', id: 'foreign-host', target: 'gcp', observedState: 'running', operation: { ...operation, id: '00000000-0000-4000-8000-000000000003' } }],
        deliverCloudTelemetry } }).routes, HOSTED_BROWSER_REST_QUERY_PATH);
    const request = () => new Request(`${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}`);
    expect((await handler(request(), context())).status).toBe(200);
    await vi.waitFor(() => expect(deliverCloudTelemetry).toHaveBeenCalledTimes(1));
    const [event, telemetryContext] = deliverCloudTelemetry.mock.calls[0] as unknown as [unknown, { principal: HostedPrincipal; origin: string; observedAt: string }];
    expect(event).toMatchObject({ event: 'cloud_workspace_provisioning', operation_id: operation.id,
      properties: { phase: 'ready', duration_ms: 60_000, hosting_mode: 'unknown' } });
    expect(JSON.stringify(event)).not.toContain(NEVER_EMIT_MARKER);
    expect(telemetryContext.principal).toBe(principal);
    expect(telemetryContext.origin).toBe('control-plane');
    expect(telemetryContext.observedAt).toBe(operation.finishedAt);
    expect((await handler(request(), context())).status).toBe(200);
    await vi.waitFor(() => expect(deliverCloudTelemetry).toHaveBeenCalledTimes(2));
    expect(deliverCloudTelemetry.mock.calls[1]?.[0]).toEqual(event);
    readBoundWorkspaceState.mockResolvedValue('provisioning');
    expect((await handler(request(), context())).status).toBe(200);
    await vi.waitFor(() => expect(readBoundWorkspaceState).toHaveBeenCalledTimes(3));
    expect(deliverCloudTelemetry).toHaveBeenCalledTimes(2);
  });

  it('returns the successful portal read while the analytics sink remains unresolved', async () => {
    const deliverCloudTelemetry = vi.fn(() => new Promise<{ delivered: boolean }>(() => {}));
    const handler = routeHandler(createHostedBrowserRoutes({ publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { runTenant: tenantRunner([]), readBoundHostId: async () => 'own-host', readBoundWorkspaceState: async () => 'active',
        readControl: async () => [{ kind: 'workspace', id: 'own-host', target: 'gcp', observedState: 'running',
          operation: { id: '00000000-0000-4000-8000-000000000002', action: 'provision', status: 'succeeded',
            startedAt: '2026-10-14T08:00:00Z', finishedAt: '2026-10-14T08:01:00Z' } }], deliverCloudTelemetry } }).routes, HOSTED_BROWSER_REST_QUERY_PATH);
    expect((await handler(new Request(`${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}`), context())).status).toBe(200);
    await vi.waitFor(() => expect(deliverCloudTelemetry).toHaveBeenCalledTimes(1));
  });

  it('rejects a mismatched workspace header before touching tenant data', async () => {
    const readControl = vi.fn(async () => []);
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { readControl },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_REST_QUERY_PATH);
    const response = await handler(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}`, {
        headers: { 'x-papercusp-workspace': 'tenant-b' },
      }),
      context(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'workspace_binding_mismatch' });
    expect(readControl).not.toHaveBeenCalled();
  });

  it('rejects a hosted principal from a different control-plane instance', async () => {
    const readControl = vi.fn(async () => []);
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { readControl },
    }).routes;
    const foreignPrincipal = createHostedPrincipal({
      ...principal,
      workspaceId: 'other-control-plane',
    });
    const response = await routeHandler(routes, HOSTED_BROWSER_REST_QUERY_PATH)(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}`),
      context(foreignPrincipal),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'control_plane_binding_mismatch' });
    expect(readControl).not.toHaveBeenCalled();
  });

  it('keeps a denial fail-closed when the global Response constructor identity changes', async () => {
    const nativeResponse = globalThis.Response;
    const responseDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Response');
    class AlternateRealmResponse extends nativeResponse {}
    Object.defineProperty(globalThis, 'Response', {
      configurable: true,
      enumerable: responseDescriptor?.enumerable ?? false,
      writable: true,
      value: AlternateRealmResponse,
    });

    try {
      // Response.json is not polymorphic: the inherited factory returns a
      // native Response, which is not instanceof AlternateRealmResponse.
      const calibration = Response.json({ ok: false }, { status: 403 });
      expect(calibration).not.toBeInstanceOf(AlternateRealmResponse);

      const readControl = vi.fn(async () => []);
      const routes = createHostedBrowserRoutes({
        publicOrigin: ORIGIN,
        controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
        dependencies: { readControl },
      }).routes;
      const foreignPrincipal = createHostedPrincipal({
        ...principal,
        workspaceId: 'other-control-plane',
      });
      const response = await routeHandler(routes, HOSTED_BROWSER_REST_QUERY_PATH)(
        new Request(`${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}`),
        context(foreignPrincipal),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'control_plane_binding_mismatch' });
      expect(readControl).not.toHaveBeenCalled();
    } finally {
      if (responseDescriptor) Object.defineProperty(globalThis, 'Response', responseDescriptor);
      else Object.defineProperty(globalThis, 'Response', { configurable: true, writable: true, value: nativeResponse });
    }
  });

  it('requires the exact configured Origin for hosted cookie writes', async () => {
    const action = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: {
        provisioningAvailable: () => true,
        readTarget: async () => null,
        readConnection: async () => null,
        startLifecycle: action as never,
        startDestroy: action as never,
      },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_ACTION_PATH);

    const missingOrigin = await handler(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_ACTION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stop', workspaceId: 'host-1' }),
      }),
      context(),
    );
    const wrongOrigin = await handler(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_ACTION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ action: 'stop', workspaceId: 'host-1' }),
      }),
      context(),
    );

    expect(missingOrigin.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps workspace-host row keys on the fixed control plane while RLS scopes the selected tenant', async () => {
    const tenantCalls: Array<{ selectedWorkspaceId?: string }> = [];
    const readConnection = vi.fn(async (workspaceId: string, _connectionId: string, tx?: Sql) => {
      expect(workspaceId).toBe(CONTROL_PLANE_WORKSPACE);
      expect(tx).toBe(fakeSql);
      return {
        id: 'gcp:connection',
        label: 'Hosted GCP',
        target: 'gcp',
        status: 'connected' as const,
        connection: {
          target: 'gcp',
          cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://default' },
          provider: {
            projectId: 'project-a',
            serviceAccountEmail: 'runtime@developer.gserviceaccount.com',
          },
        },
      };
    });
    const upsertConnection = vi.fn(async (input: { workspaceId: string }, tx?: Sql) => {
      expect(tx).toBe(fakeSql);
      expect(input.workspaceId).toBe(CONTROL_PLANE_WORKSPACE);
    });
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: {
        runTenant: tenantRunner(tenantCalls),
        readConnection,
        upsertConnection,
        inspectConnection: async () => ({
          validation: {
            ok: true,
            checkedAt: '2026-08-30T00:00:00.000Z',
            identity: 'runtime@developer.gserviceaccount.com',
            warnings: [],
            errors: [],
          },
          scopes: [],
          regions: [],
          sizes: [],
          images: [],
        }),
      },
    }).routes;
    const handler = routeHandler(routes, '/hosted/browser/workspace-hosts/connection');
    const response = await handler(
      new Request(`${ORIGIN}/api/hosted/browser/workspace-hosts/connection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ action: 'validate-connection', connectionId: 'gcp:connection' }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(readConnection).toHaveBeenCalledTimes(1);
    expect(upsertConnection).toHaveBeenCalledTimes(1);
    expect(tenantCalls).toEqual([
      { selectedWorkspaceId: SELECTED_WORKSPACE },
      { selectedWorkspaceId: SELECTED_WORKSPACE },
    ]);
  });

  it('provisions only the host the selected workspace is bound to (D-397)', async () => {
    const tenantCalls: Array<{ selectedWorkspaceId?: string }> = [];
    const readBoundHostId = vi.fn(async (
      controlPlaneWorkspaceId: string,
      customerWorkspaceId: string,
      tx?: Sql,
    ): Promise<string | null> => {
      expect(controlPlaneWorkspaceId).toBe(CONTROL_PLANE_WORKSPACE);
      expect(customerWorkspaceId).toBe(SELECTED_WORKSPACE);
      expect(tx).toBe(fakeSql);
      return 'host-bound';
    });
    const startProvisioning = vi.fn();
    const readConnection = vi.fn(async () => null);
    const provision = (provisioningAvailable: boolean, hostId: string) => routeHandler(createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: {
        runTenant: tenantRunner(tenantCalls),
        readBoundHostId,
        readConnection,
        provisioningAvailable: () => provisioningAvailable,
        startProvisioning: startProvisioning as never,
      },
    }).routes, '/hosted/browser/workspace-hosts/provision')(
      new Request(`${ORIGIN}/api/hosted/browser/workspace-hosts/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ connectionId: 'gcp:connection', name: 'My workspace', desired: { hostId, target: 'gcp' } }),
      }),
      context(),
    );

    // Another host — a fresh id or another tenant's — is refused BEFORE the controller forward
    // that an unavailable local provisioner would otherwise take with the body as-is.
    const minted = await provision(false, 'host-minted-by-caller');
    expect(minted.status).toBe(403);
    await expect(minted.json()).resolves.toMatchObject({ error: 'workspace_host_not_bound' });

    // The bound host passes authorization and reaches the connection check.
    const bound = await provision(true, 'host-bound');
    expect(bound.status).toBe(404);
    expect(readConnection).toHaveBeenCalledTimes(1);
    expect(startProvisioning).not.toHaveBeenCalled();
    expect(tenantCalls.every((call) => call.selectedWorkspaceId === SELECTED_WORKSPACE)).toBe(true);

    // No live binding at all (deleted workspace) authorizes nothing.
    readBoundHostId.mockResolvedValueOnce(null);
    expect((await provision(true, 'host-bound')).status).toBe(403);
  });

  // aws-byoc-gcp-parity D-015: a hosted provision RETRY of a failed first build must still bring
  // the workspace up, or it stays 'provisioning' forever (measured on canary host
  // host-0f9b1ba8db30d143becc130a, 2026-10-02). Derived server-side, and never for a workspace
  // that already left 'provisioning'.
  describe('hosted provision bring-up (D-015)', () => {
    const gcpInput = { desired: { hostId: 'host-bound', target: 'gcp', scope: { kind: 'project', id: 'p' } } } as never;

    it('owes a still-provisioning workspace its bring-up, with only the local-inference agent', async () => {
      const readState = vi.fn(async () => 'provisioning');
      await expect(hostedProvisionBringUp(gcpInput, SELECTED_WORKSPACE, readState)).resolves.toEqual({
        customerWorkspaceId: SELECTED_WORKSPACE,
        requestedAgents: ['omp'],
      });
      expect(readState).toHaveBeenCalledWith(SELECTED_WORKSPACE);
    });

    it('never re-runs it for a workspace that is active, suspended or gone', async () => {
      for (const state of ['active', 'suspended', 'deleted', null]) {
        await expect(hostedProvisionBringUp(gcpInput, SELECTED_WORKSPACE, async () => state)).resolves.toBeUndefined();
      }
    });

    it('owes an AWS account host the same bring-up (D-015 rule 3, WI-10005354)', async () => {
      const readState = vi.fn(async () => 'provisioning');
      const awsInput = { desired: { hostId: 'host-bound', target: 'aws', scope: { kind: 'account', id: '1' } } } as never;
      await expect(hostedProvisionBringUp(awsInput, SELECTED_WORKSPACE, readState)).resolves.toEqual({
        customerWorkspaceId: SELECTED_WORKSPACE,
        requestedAgents: ['omp'],
      });
    });

    it('requests none for an unsupported host or without a selected workspace, reading nothing', async () => {
      const readState = vi.fn(async () => 'provisioning');
      const azureInput = {
        desired: { hostId: 'host-bound', target: 'azure', scope: { kind: 'subscription', id: 's' } },
      } as never;
      // A supported target with the wrong scope kind is not a bring-up host either.
      const awsInProject = { desired: { hostId: 'host-bound', target: 'aws', scope: { kind: 'project', id: 'p' } } } as never;
      await expect(hostedProvisionBringUp(azureInput, SELECTED_WORKSPACE, readState)).resolves.toBeUndefined();
      await expect(hostedProvisionBringUp(awsInProject, SELECTED_WORKSPACE, readState)).resolves.toBeUndefined();
      await expect(hostedProvisionBringUp(gcpInput, undefined, readState)).resolves.toBeUndefined();
      expect(readState).not.toHaveBeenCalled();
    });

    // The hosted control plane never runs DBOS. Without the enqueuer the route forwarded the RAW
    // body to the controller, which cannot know the selected workspace, so the actor and the
    // bring-up never reached the workflow (measured: canary retries r2..r6, 2026-10-02).
    function hostedRetry(provisioning: { enqueue: ReturnType<typeof vi.fn> }) {
      return routeHandler(createHostedBrowserRoutes({
        publicOrigin: ORIGIN,
        controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
        dependencies: {
          runTenant: tenantRunner([]),
          readBoundHostId: async () => 'host-bound',
          readBoundWorkspaceState: async () => 'provisioning',
          readConnection: async () => ({
            id: 'gcp:connection',
            target: 'gcp',
            status: 'connected' as const,
            connection: {
              target: 'gcp',
              cloudCredentialRef: { kind: 'cloud' as const, ref: 'delegation://tenant-a/gcp:connection' },
              provider: { projectId: 'p', serviceAccountEmail: 'papercusp-host-operator@p.iam.gserviceaccount.com' },
            },
          }) as never,
          listLiveHostIds: async () => [],
          readSpentHostId: async () => null,
          provisioning: provisioning as never,
        },
      }).routes, '/hosted/browser/workspace-hosts/provision')(
        new Request(`${ORIGIN}/api/hosted/browser/workspace-hosts/provision`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({
            connectionId: 'gcp:connection',
            name: 'My workspace',
            operationId: 'prov-host-bound-r6',
            desired: {
              hostId: 'host-bound',
              target: 'gcp',
              scope: { kind: 'project', id: 'p' },
              region: 'us-central1',
              zone: 'us-central1-c',
              size: 'e2-standard-4',
              image: { id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404' },
              data: { volumeGiB: 100, encrypted: true },
            },
          }),
        }),
        context(),
      );
    }

    it('enqueues a hosted retry with its actor and bring-up instead of forwarding the bare body', async () => {
      const enqueue = vi.fn(async (_input: unknown) => ({ workflowId: 'wf' }));
      const response = await hostedRetry({ enqueue });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        status: 'accepted',
        operationId: 'prov-host-bound-r6',
        hostId: 'host-bound',
      });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
        workspaceId: CONTROL_PLANE_WORKSPACE,
        operationId: 'prov-host-bound-r6',
        actorId: 'user-1',
        bringUp: { customerWorkspaceId: SELECTED_WORKSPACE, requestedAgents: ['omp'] },
      });
    });

    it('answers a duplicate enqueue with the same 409 conflict as an in-process start', async () => {
      const enqueue = vi.fn(async () => {
        throw Object.assign(new Error('duplicate'), { dbosErrorCode: 28 });
      });
      const response = await hostedRetry({ enqueue });
      expect(response.status).toBe(409);
    });

    // WI-10005363: lifecycle actions took the same raw-forward path, so a portal repair reached the
    // workflow with no actor and the portal got a false 504 (measured: canary repair r1, 07:39Z).
    function hostedAction(operations: { enqueueLifecycle: ReturnType<typeof vi.fn>; enqueueDestroy: ReturnType<typeof vi.fn> }) {
      return routeHandler(createHostedBrowserRoutes({
        publicOrigin: ORIGIN,
        controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
        dependencies: {
          runTenant: tenantRunner([]),
          readTarget: async () => ({
            hostId: 'host-bound',
            target: 'gcp',
            connectionId: 'gcp:connection',
            desired: { hostId: 'host-bound', target: 'gcp', scope: { kind: 'project', id: 'p' } },
          }) as never,
          readConnection: async () => ({
            id: 'gcp:connection',
            target: 'gcp',
            status: 'connected' as const,
            connection: {
              target: 'gcp',
              cloudCredentialRef: { kind: 'cloud' as const, ref: 'delegation://tenant-a/gcp:connection' },
            },
          }) as never,
          operations: operations as never,
        },
      }).routes, '/hosted/browser/workspace-hosts/action')(
        new Request(`${ORIGIN}/api/hosted/browser/workspace-hosts/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ action: 'repair', workspaceId: 'host-bound', operationId: 'repair-host-bound-r1' }),
        }),
        context(),
      );
    }

    it('enqueues a hosted lifecycle action with its actor and answers 202 instead of forwarding', async () => {
      const enqueueLifecycle = vi.fn(async (input: { operationId?: string }) => ({
        workflowId: 'wf',
        operationId: input.operationId ?? 'generated',
      }));
      const enqueueDestroy = vi.fn();
      const response = await hostedAction({ enqueueLifecycle, enqueueDestroy });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ operationId: 'repair-host-bound-r1', hostId: 'host-bound' });
      expect(enqueueLifecycle).toHaveBeenCalledTimes(1);
      expect(enqueueLifecycle.mock.calls[0]?.[0]).toMatchObject({
        workspaceId: CONTROL_PLANE_WORKSPACE,
        hostId: 'host-bound',
        action: 'repair',
        operationId: 'repair-host-bound-r1',
        actorId: 'user-1',
      });
      expect(enqueueDestroy).not.toHaveBeenCalled();
    });

    it('answers a duplicate lifecycle enqueue with the in-process 409 conflict', async () => {
      const enqueueLifecycle = vi.fn(async () => {
        throw Object.assign(new Error('duplicate'), { dbosErrorCode: 28 });
      });
      const response = await hostedAction({ enqueueLifecycle, enqueueDestroy: vi.fn() });
      expect(response.status).toBe(409);
    });
  });

  it('forwards only tenant-safe invalidations over SSE and strips row payloads', async () => {
    let emit: ((event: SyncEvent) => void) | undefined;
    const close = vi.fn();
    const relevant: SyncEvent = {
      id: 1,
      ts: 123,
      name: HOSTED_BROWSER_QUERY_NAME,
      args: { workspaceId: SELECTED_WORKSPACE },
      data: [{ secret: NEVER_EMIT_MARKER }],
    };
    const foreign: SyncEvent = {
      id: 2,
      ts: 124,
      name: HOSTED_BROWSER_QUERY_NAME,
      args: { workspaceId: 'tenant-b' },
      data: [{ secret: 'foreign' }],
    };
    const subscribe = vi.fn(async (listener: (event: SyncEvent) => void) => {
      emit = listener;
      return { send: listener, close };
    });
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: {
        subscribe,
        backfillSince: () => [relevant, foreign],
      },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_SSE_PATH);
    const abort = new AbortController();
    const response = await handler(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_SSE_PATH}`, {
        headers: { 'x-papercusp-workspace': CONTROL_PLANE_WORKSPACE, 'last-event-id': '0' },
        signal: abort.signal,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const replay = await reader.read();
    const replayText = decoder.decode(replay.value);
    expect(decoder.decode(first.value)).toContain('event: heartbeat');
    expect(replayText).toContain('event: invalidate');
    expect(replayText).toContain('"name":"workspaceHosts.control"');
    expect(replayText).toContain('"tsMs":123');
    expect(replayText).not.toContain(NEVER_EMIT_MARKER);
    expect(replayText).not.toContain('foreign');

    // The live callback is scoped the same way as replay.
    emit?.(relevant);
    const live = await reader.read();
    expect(decoder.decode(live.value)).toContain('"tsMs":123');
    abort.abort();
    await reader.cancel();
    expect(close).toHaveBeenCalled();
  });
});

describe('hosted first-workspace bootstrap route', () => {
  const unselected = createHostedPrincipal({
    workspaceId: CONTROL_PLANE_WORKSPACE,
    userId: 'user-1',
    activeOrganizationId: 'org-1',
    sessionId: 'session-1',
    sessionVersion: 3,
    permissions: ['workspace:operate', 'cloud-connection:manage'],
  });
  const expiresAt = new Date('2026-10-01T00:00:00.000Z');
  const created: HostedFirstWorkspaceResult = {
    ok: true,
    workspaceId: 'ws-derived',
    connectionId: 'conn-derived',
    provisionOperationId: 'prov-derived',
    sessionId: 'session-rotated',
    sessionExpiresAt: expiresAt,
  };

  function bootstrap(result: HostedFirstWorkspaceResult = created) {
    const run = vi.fn(async () => result);
    const issueSessionCookie = vi.fn((sessionId: string) => `hosted_session=${sessionId}; HttpOnly`);
    const handler = routeHandler(
      createHostedBrowserRoutes({
        publicOrigin: ORIGIN,
        controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
        dependencies: {
          firstWorkspace: { run } as unknown as HostedFirstWorkspace,
          issueSessionCookie,
        },
      }).routes,
      HOSTED_BROWSER_FIRST_WORKSPACE_PATH,
    );
    return { run, issueSessionCookie, handler };
  }

  function post(body: unknown, origin: string | null = ORIGIN): Request {
    return new Request(`${ORIGIN}/api${HOSTED_BROWSER_FIRST_WORKSPACE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
  }

  const validBody = {
    attemptKey: 'attempt-0123456789abcdef',
    displayName: 'My workspace',
    label: 'My GCP project',
    configuration: { provider: 'gcp' },
  };

  it('refuses a session that already has a workspace — the door is for the FIRST one only', async () => {
    const { run, handler } = bootstrap();

    const response = await handler(post(validBody), context(principal));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'workspace_already_selected' });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a principal bound to a different control plane', async () => {
    const { run, handler } = bootstrap();
    const foreign = createHostedPrincipal({
      workspaceId: 'other-control-plane',
      userId: 'user-1',
      activeOrganizationId: 'org-1',
      sessionId: 'session-1',
      sessionVersion: 3,
      permissions: ['workspace:operate', 'cloud-connection:manage'],
    });

    const response = await handler(post(validBody), context(foreign));

    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it('requires the exact configured Origin', async () => {
    const { run, handler } = bootstrap();

    const missing = await handler(post(validBody, null), context(unselected));
    const wrong = await handler(post(validBody, 'https://evil.example'), context(unselected));

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 501 rather than a half-wired admission when the runtime supplied no bootstrap', async () => {
    const handler = routeHandler(
      createHostedBrowserRoutes({ publicOrigin: ORIGIN, controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE }).routes,
      HOSTED_BROWSER_FIRST_WORKSPACE_PATH,
    );

    const response = await handler(post(validBody), context(unselected));

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: 'first_workspace_unavailable' });
  });

  it('takes tenant and identifiers from the session, never from the body', async () => {
    const { run, handler } = bootstrap();

    await handler(
      post({
        ...validBody,
        organizationId: 'org-victim',
        userId: 'user-victim',
        workspaceId: 'ws-victim',
        connectionId: 'conn-victim',
        credentialRef: 'delegation://ws-victim/conn-victim',
      }),
      context(unselected),
    );

    expect(run).toHaveBeenCalledTimes(1);
    const request = (run.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      organizationId: 'org-1',
      userId: 'user-1',
      sessionId: 'session-1',
      sessionVersion: 3,
      attemptKey: validBody.attemptKey,
    });
    expect(Object.keys(request).sort()).toEqual(
      ['attemptKey', 'configuration', 'displayName', 'hosting', 'label', 'organizationId', 'sessionId', 'sessionVersion', 'userId'],
    );
    expect(JSON.stringify(request)).not.toContain('victim');
  });

  it('returns 201 and re-issues the cookie for the ROTATED session', async () => {
    const { handler, issueSessionCookie } = bootstrap();

    const response = await handler(post(validBody), context(unselected));

    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toBe('hosted_session=session-rotated; HttpOnly');
    expect(issueSessionCookie).toHaveBeenCalledWith('session-rotated', expiresAt);
    expect(await response.json()).toEqual({
      ok: true,
      workspaceId: 'ws-derived',
      connectionId: 'conn-derived',
      provisionOperationId: 'prov-derived',
    });
  });

  it('passes a pending delegation through with its grant template and no cookie', async () => {
    const template = { provider: 'gcp', steps: ['grant roles/iam.serviceAccountTokenCreator'] };
    const { handler, issueSessionCookie } = bootstrap({
      ok: false,
      code: 'delegation_pending',
      status: 409,
      retryable: true,
      template,
      connectionId: 'conn-derived',
    } as unknown as HostedFirstWorkspaceResult);

    const response = await handler(post(validBody), context(unselected));

    expect(response.status).toBe(409);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(issueSessionCookie).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      error: 'delegation_pending',
      retryable: true,
      template,
      connectionId: 'conn-derived',
    });
  });
});

describe('hosted select-workspace route', () => {
  // Sign-in never selects a workspace, so a returning member arrives here with none
  // (the owner's own account, 2026-09-23).
  const unselected = createHostedPrincipal({
    workspaceId: CONTROL_PLANE_WORKSPACE,
    userId: 'user-1',
    activeOrganizationId: 'org-1',
    sessionId: 'session-1',
    sessionVersion: 3,
    permissions: ['workspace:view'],
  });
  const expiresAt = new Date('2026-10-01T00:00:00.000Z');

  function selecting(result: Awaited<ReturnType<HostedFirstWorkspace['selectExisting']>> = {
    ok: true,
    workspaceId: 'ws-existing',
    sessionId: 'session-rotated',
    sessionExpiresAt: expiresAt,
  }) {
    const selectExisting = vi.fn(async () => result);
    const issueSessionCookie = vi.fn((sessionId: string) => `hosted_session=${sessionId}; HttpOnly`);
    const handler = routeHandler(
      createHostedBrowserRoutes({
        publicOrigin: ORIGIN,
        controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
        dependencies: {
          firstWorkspace: { selectExisting } as unknown as HostedFirstWorkspace,
          issueSessionCookie,
        },
      }).routes,
      HOSTED_BROWSER_SELECT_WORKSPACE_PATH,
    );
    return { selectExisting, issueSessionCookie, handler };
  }

  function post(body: unknown = {}, origin: string | null = ORIGIN): Request {
    return new Request(`${ORIGIN}/api${HOSTED_BROWSER_SELECT_WORKSPACE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
  }

  it('selects from the SESSION organization, ignores any body, and re-issues the rotated cookie', async () => {
    const { selectExisting, issueSessionCookie, handler } = selecting();

    const response = await handler(
      post({ organizationId: 'org-victim', workspaceId: 'ws-victim' }),
      context(unselected),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, workspaceId: 'ws-existing' });
    expect(response.headers.get('set-cookie')).toBe('hosted_session=session-rotated; HttpOnly');
    expect(issueSessionCookie).toHaveBeenCalledWith('session-rotated', expiresAt);
    expect(selectExisting).toHaveBeenCalledWith({ organizationId: 'org-1', sessionId: 'session-1', sessionVersion: 3 });
  });

  it('never moves a session off a workspace it already holds', async () => {
    const { selectExisting, handler } = selecting();

    const response = await handler(post(), context(principal));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'workspace_already_selected' });
    expect(selectExisting).not.toHaveBeenCalled();
  });

  it('requires the exact configured Origin', async () => {
    const { selectExisting, handler } = selecting();

    const missing = await handler(post({}, null), context(unselected));
    const wrong = await handler(post({}, 'https://evil.example'), context(unselected));

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(selectExisting).not.toHaveBeenCalled();
  });

  it('reports an organization with no workspace yet as no_workspace, with no cookie', async () => {
    const { handler, issueSessionCookie } = selecting({ ok: false, code: 'no_workspace', status: 404, retryable: false });

    const response = await handler(post(), context(unselected));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'no_workspace', retryable: false });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(issueSessionCookie).not.toHaveBeenCalled();
  });
});
