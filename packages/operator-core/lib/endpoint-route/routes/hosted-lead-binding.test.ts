import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';
import { createHostedPrincipal } from '../../auth/hosted-principal';
import { createHostedLeadBindingRoutes } from './hosted-lead-binding';

const origin = 'https://app.papercusp.com';
const principal = createHostedPrincipal({ workspaceId: 'control', userId: 'user-a', activeOrganizationId: 'org-a',
  sessionId: 'session-a', sessionVersion: 1, permissions: ['workspace:view'] });
const context = { principal, params: {}, input: undefined, signal: new AbortController().signal, log: () => {} } as RouteContext;
const scope = { graphWorkspaceId: 'graph-a', personRef: 'PER-a' };
const receipt = { ...scope, environment: 'production' as const, ref: 'receipt-a', userId: 'user-a',
  organizationId: 'org-a', redeemedAt: new Date(1000).toISOString() };
function fixture() {
  const service = { redeem: vi.fn(async () => receipt), read: vi.fn(async () => receipt), revoke: vi.fn(async () => true) };
  const routes = createHostedLeadBindingRoutes({ origin, controlPlaneWorkspaceId: 'control', environment: 'production', service });
  const request = (index: number, body: unknown = index === 0 ? { ...scope, token: 'signed-token' } : scope,
    requestOrigin = origin) => {
    const route = routes[index]!;
    const query = index === 1 ? '?' + new URLSearchParams(body as Record<string, string>) : '';
    return new Request(origin + route.path + query, { method: route.method,
      headers: { origin: requestOrigin, 'content-type': 'application/json' },
      ...(index === 1 ? {} : { body: JSON.stringify(body) }) });
  };
  return { service, routes, request };
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
});
