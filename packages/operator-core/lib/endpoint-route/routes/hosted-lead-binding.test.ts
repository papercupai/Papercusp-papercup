import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { RouteContext } from '@papercusp/tooldef';
import { createHostedPrincipal } from '../../auth/hosted-principal';
import { createHostedLeadBindingRoutes } from './hosted-lead-binding';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT, type CloudTelemetryConsent } from '../../telemetry-kinds';

vi.mock('../../posthog-config', () => ({ getPosthogConfigWithSource: () => ({ config: {
  host: 'https://posthog.invalid', projectKey: 'capture-key', personalApiKey: 'admin-key',
} }) }));
afterEach(() => vi.unstubAllGlobals());

const origin = 'https://app.papercusp.com';
const principal = createHostedPrincipal({ workspaceId: 'control', userId: 'user-a', activeOrganizationId: 'org-a',
  sessionId: 'session-a', sessionVersion: 1, permissions: ['workspace:view'] });
const context = { principal, params: {}, input: undefined, signal: new AbortController().signal, log: () => {} } as RouteContext;
const scope = { graphWorkspaceId: 'graph-a', personRef: 'PER-a' };
const receipt = { ...scope, environment: 'production' as const, ref: 'receipt-a', userId: 'user-a',
  organizationId: 'org-a', redeemedAt: new Date(1000).toISOString() };
function fixture(consents: CloudTelemetryConsent[] = [{ ...DEFAULT_CLOUD_TELEMETRY_CONSENT,
  analytics: { enabled: true, since: '2026-10-15T00:00:00Z' } }]) {
  const service = { redeem: vi.fn(async () => receipt), read: vi.fn(async () => receipt), revoke: vi.fn(async () => true) };
  const tenantCalls: unknown[] = [];
  let consentIndex = 0;
  const sql = (async (strings: TemplateStringsArray) => strings.join(' ').includes('current_setting')
    ? [{ organization: 'org-a', user: 'user-a' }]
    : [{ consent: consents[Math.min(consentIndex++, consents.length - 1)] }]) as unknown as Sql;
  const routes = createHostedLeadBindingRoutes({ origin, controlPlaneWorkspaceId: 'control', environment: 'production', service,
    runTenant: async (account, fn) => { tenantCalls.push(account); return fn(sql); } });
  const request = (index: number, body: unknown = index === 0 ? { ...scope, token: 'signed-token' } : scope,
    requestOrigin = origin) => {
    const route = routes[index]!;
    const query = index === 1 ? '?' + new URLSearchParams(body as Record<string, string>) : '';
    return new Request(origin + route.path + query, { method: route.method,
      headers: { origin: requestOrigin, 'content-type': 'application/json' },
      ...(index === 1 ? {} : { body: JSON.stringify(body) }) });
  };
  return { service, routes, request, tenantCalls };
}
describe('hosted lead binding browser routes', () => {
  it('uses authenticated identity and server environment for redemption, read and revoke', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      const response = await f.routes[i]!.handler(f.request(i), context);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.service.redeem).toHaveBeenCalledWith({ ...scope, environment: 'production' }, 'signed-token', principal);
    expect(f.service.read).toHaveBeenCalledWith({ ...scope, environment: 'production' }, principal);
    expect(f.service.revoke).toHaveBeenCalledWith({ ...scope, environment: 'production' }, principal);
  });
  it('refuses a local principal or wrong control plane before service access', async () => {
    const f = fixture();
    for (const patch of [{ profile: 'local' }, { workspaceId: 'other-control' }]) {
      const response = await f.routes[0]!.handler(f.request(0), { ...context, principal: { ...principal, ...patch } } as RouteContext);
      expect([401, 403]).toContain(response.status);
    }
    expect(f.service.redeem).not.toHaveBeenCalled();
  });
  it('requires exact same origin for both mutations', async () => {
    const f = fixture();
    for (const i of [0, 2]) expect((await f.routes[i]!.handler(f.request(i, i === 0 ? { ...scope, token: 'token' } : scope,
      'https://attacker.example'), context)).status).toBe(403);
    expect(f.service.redeem).not.toHaveBeenCalled(); expect(f.service.revoke).not.toHaveBeenCalled();
  });
  it.each(['userId', 'organizationId', 'issuerRef', 'environment', 'consent'])('rejects caller-supplied authority field %s', async key => {
    const f = fixture();
    expect((await f.routes[0]!.handler(f.request(0, { ...scope, token: 'token', [key]: 'forged' }), context)).status).toBe(400);
    expect(f.service.redeem).not.toHaveBeenCalled();
  });
  it('conceals a refused receipt and internal failure without leaking exception details', async () => {
    const f = fixture();
    f.service.read.mockResolvedValueOnce(null as never);
    expect((await f.routes[1]!.handler(f.request(1), context)).status).toBe(404);
    f.service.redeem.mockRejectedValueOnce(new Error('secret-token SQL user-b'));
    const response = await f.routes[0]!.handler(f.request(0), context);
    expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/secret-token|SQL|user-b/);
  });
  const window = { windowStart: '2026-10-10T00:00:00Z', windowEnd: '2026-10-27T00:00:00Z' };
  function usageTransport(onQuery?: () => void) {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/projects/') return Response.json({ results: [{ id: 7, api_token: 'capture-key' }], next: null });
      if (path === '/api/projects/7/query/') {
        onQuery?.();
        return Response.json({ columns: ['observations', 'portalSessionObservations', 'readyProvisioningObservations', 'featureAdoptionObservations'],
          results: [[4, 2, 1, 1]] });
      }
      throw new Error('unexpected test transport');
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }
  it('reads consented usage only for the current bound hosted identity and tenant', async () => {
    const f = fixture(); const fetcher = usageTransport();
    const response = await f.routes[1]!.handler(f.request(1, { ...scope, ...window }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ receipt, usage: { status: 'observed', observations: 4,
      windowStart: '2026-10-15T00:00:00.000Z' } });
    expect(f.tenantCalls).toHaveLength(2);
    expect(f.tenantCalls[0]).toMatchObject({ principal: { userId: 'user-a', activeOrganizationId: 'org-a', sessionId: 'session-a' } });
    expect(f.service.read).toHaveBeenCalledTimes(4);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not query without a binding or with disabled consent', async () => {
    const fetcher = usageTransport(); const missing = fixture();
    missing.service.read.mockResolvedValue(null as never);
    expect((await missing.routes[1]!.handler(missing.request(1, { ...scope, ...window }), context)).status).toBe(404);
    const disabled = fixture([DEFAULT_CLOUD_TELEMETRY_CONSENT]);
    const response = await disabled.routes[1]!.handler(disabled.request(1, { ...scope, ...window }), context);
    expect(await response.json()).toMatchObject({ usage: { status: 'unknown', reason: 'consent_disabled' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('withholds the result if the binding is revoked during the network query', async () => {
    const f = fixture(); usageTransport(() => f.service.read.mockResolvedValue(null as never));
    const response = await f.routes[1]!.handler(f.request(1, { ...scope, ...window }), context);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/observations|user-a|org-a/);
  });
  it('keeps revoked consent unknown after the network read', async () => {
    const enabled = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT, analytics: { enabled: true, since: '2026-10-15T00:00:00Z' } };
    const f = fixture([enabled, DEFAULT_CLOUD_TELEMETRY_CONSENT]); usageTransport();
    const response = await f.routes[1]!.handler(f.request(1, { ...scope, ...window }), context);
    expect(await response.json()).toMatchObject({ usage: { status: 'unknown', reason: 'consent_changed' } });
  });
  it.each([{ windowStart: window.windowStart }, { ...window, windowStart: '2026-09-01T00:00:00Z' },
    { ...window, windowEnd: window.windowStart }, { ...window, userId: 'other-user' }])('rejects malformed windows or supplied usage identity: %j', async input => {
    const f = fixture(); const fetcher = usageTransport();
    expect((await f.routes[1]!.handler(f.request(1, { ...scope, ...input }), context)).status).toBe(400);
    expect(f.service.read).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
