import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';
import { createOperatorLeadBindingRoute } from './operator-lead-binding';
import { hostedLeadBindingIssuerRef } from '../../auth/hosted-lead-binding-authority';

const origin = 'https://operator.example';
const session = 'a'.repeat(64);
const principal = { kind: 'user', trust: 'verified', authMethod: 'cookie-session', slug: 'operator-a',
  workspaceId: 'graph-a', capabilities: new Set(['*']) } as const;
const context = { principal, params: {}, input: undefined, signal: new AbortController().signal, log: () => {} } as RouteContext;
function fixture() {
  const issue = vi.fn(async () => 'signed-challenge');
  const resolveOperatorSession = vi.fn(async () => session as string | undefined);
  const route = createOperatorLeadBindingRoute({ origin, graphWorkspaceId: 'graph-a', environment: 'production',
    service: { issue }, resolveOperatorSession });
  const request = (body: unknown = { personRef: 'PER-a' }, suppliedOrigin = origin) => new Request(origin + route.path,
    { method: 'POST', headers: { origin: suppliedOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { route, issue, resolveOperatorSession, request };
}
describe('operator lead binding issuance', () => {
  it('derives issuer from the cookie and fixes workspace/environment on the server', async () => {
    const f = fixture(); const response = await f.route.handler(f.request(), context);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ token: 'signed-challenge' });
    expect(f.issue).toHaveBeenCalledWith({ graphWorkspaceId: 'graph-a', personRef: 'PER-a', environment: 'production' },
      hostedLeadBindingIssuerRef(session));
  });
  it('rejects wrong workspace, missing operator capability, cross-origin and missing cookie', async () => {
    const f = fixture();
    for (const patch of [{ workspaceId: 'other' }, { capabilities: new Set(['workspace:view']) }, { authMethod: 'bearer' }]) {
      expect((await f.route.handler(f.request(), { ...context, principal: { ...principal, ...patch } } as RouteContext)).status).toBe(403);
    }
    expect((await f.route.handler(f.request(undefined, 'https://attacker.example'), context)).status).toBe(403);
    f.resolveOperatorSession.mockResolvedValueOnce(undefined);
    expect((await f.route.handler(f.request(), context)).status).toBe(403);
    expect(f.issue).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied issuer and scopes without acquiring a session', async () => {
    const f = fixture();
    expect((await f.route.handler(f.request({ personRef: 'PER-a', issuerRef: 'forged', graphWorkspaceId: 'other' }), context)).status).toBe(400);
    expect(f.resolveOperatorSession).not.toHaveBeenCalled(); expect(f.issue).not.toHaveBeenCalled();
  });
});
