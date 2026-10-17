/** Finance limit administration through the real authenticated runtime. */
import { describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { HostedBillingStore } from '../auth/hosted/billing/billing-store';
import type { HostedAllocationRequest } from '../auth/hosted/billing/allocation-store';
import { createHostedBillingRuntime } from './hosted-billing-runtime';
import { createHostedBillingRoutes, type HostedBillingAllocationAdmin } from './routes/hosted-billing';

const origin = 'https://app.example';
const organization = { controlWorkspaceId: 'control-a', organizationId: 'org-a' };
const body = { allocationId: 'project-a', parentAllocationId: 'department-a', level: 'project', costClass: 'model',
  month: '2026-10', capMicros: 100_000, maxUnreconciledMicros: 10_000 };
const principal = createHostedPrincipal({ workspaceId: organization.controlWorkspaceId, activeOrganizationId: organization.organizationId,
  userId: 'finance-user', sessionId: 'finance-session', sessionVersion: 1, permissions: ['billing:manage'] });
const resolvePrincipal: HostedPrincipalResolver = async headers => {
  const session = headers.get('test-session');
  if (!session) return { ok: false, reason: 'session_cookie_missing' };
  if (session === 'revoked') return { ok: false, reason: 'membership_not_active' };
  if (session === 'outage') return { ok: false, reason: 'authority_unavailable' };
  return { ok: true, principal: session === 'owner' ? principal : createHostedPrincipal({
    workspaceId: organization.controlWorkspaceId, activeOrganizationId: organization.organizationId,
    userId: 'member', sessionId: 'member-session', sessionVersion: 1, permissions: ['workspace:view'],
  }), session: {} as never, membership: {} as never };
};
const store: HostedBillingStore = { customerFor: async () => null, recordCustomer: async c => c,
  currentSubscription: async () => null, applyEvent: async () => ({ outcome: 'ignored', organizationId: null }),
  recordRejectedEvent: async () => 'recorded' };
const created = (input: HostedAllocationRequest) => ({ organization: input.organization, result: {
  outcome: 'created' as const, allocation: { allocationId: input.allocationId, parentAllocationId: input.parentAllocationId,
    level: input.level, costClass: input.costClass, month: input.month, capMicros: input.capMicros,
    maxUnreconciledMicros: input.maxUnreconciledMicros, revision: 1 },
} });
async function runtime(allocationAdmin: HostedBillingAllocationAdmin = async input => created(input)) {
  return createHostedBillingRuntime({ publicOrigin: origin, plans: [], stripeSecretKeyRef: null, stripeWebhookSecretRef: null },
    { resolvePrincipal, store, allocationAdmin });
}
const path = '/api/hosted/billing/usage?view=allocations';
function request(value: unknown = body, session = 'owner', requestOrigin: string | null = origin) {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...(session ? { 'test-session': session } : {}),
    ...(requestOrigin ? { origin: requestOrigin } : {}) }, body: JSON.stringify(value) };
}

describe('hosted allocation limit administration', () => {
  it('binds organization, actor and evidence on the server, independent of Stripe', async () => {
    const admin = vi.fn(async (input: HostedAllocationRequest) => created(input)); const built = await runtime(admin);
    const response = await built.app.request(path, request());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(built.configured).toBe(false);
    expect(admin).toHaveBeenCalledExactlyOnceWith({ ...body, organization, recordedBy: 'finance-user',
      evidenceRef: expect.stringMatching(/^hosted-billing-allocation:[a-f0-9-]+$/) });
    const input = admin.mock.calls[0][0]; expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.organization)).toBe(true);
    expect(await response.json()).toEqual({ ok: true, outcome: 'created', allocation: { ...body, revision: 1 } });
  });

  it.each([['', 401], ['member', 403], ['revoked', 403], ['outage', 503]] as const)(
    'denies %s before saving a limit', async (session, status) => {
      const admin = vi.fn(async (input: HostedAllocationRequest) => created(input)); const built = await runtime(admin);
      expect((await built.app.request(path, request(body, session))).status).toBe(status);
      expect(admin).not.toHaveBeenCalled();
    });

  it.each([null, 'https://other.example'])('refuses cross-origin writes: %s', async other => {
    const admin = vi.fn(async (input: HostedAllocationRequest) => created(input)); const built = await runtime(admin);
    expect((await built.app.request(path, request(body, 'owner', other))).status).toBe(403); expect(admin).not.toHaveBeenCalled();
  });

  it.each(['', '?view=usage', '?view=allocations&view=allocations', '?view=allocations&month=2026-10',
    '?view=allocations&organizationId=other', '?view=allocations&workspaceId=other'])(
    'rejects ambiguous or caller-owned query scope: %s', async query => {
      const admin = vi.fn(async (input: HostedAllocationRequest) => created(input)); const built = await runtime(admin);
      expect((await built.app.request('/api/hosted/billing/usage' + query, request())).status).toBe(400);
      expect(admin).not.toHaveBeenCalled();
    });

  it.each(['organization', 'organizationId', 'controlWorkspaceId', 'recordedBy', 'evidenceRef', 'providerFinal', 'funding'])(
    'rejects caller-authored authority or accounting field %s', async key => {
      const admin = vi.fn(async (input: HostedAllocationRequest) => created(input)); const built = await runtime(admin);
      expect((await built.app.request(path, request({ ...body, [key]: 'forged' }))).status).toBe(400);
      expect(admin).not.toHaveBeenCalled();
    });

  it.each([null, [], {}, { ...body, capMicros: -1 }, { ...body, capMicros: 0.5 }, { ...body, capMicros: '100000' },
    { ...body, capMicros: Number.MAX_SAFE_INTEGER + 1 }, { ...body, maxUnreconciledMicros: -1 },
    { ...body, maxUnreconciledMicros: 100001 }, { ...body, level: 'constructor' }, { ...body, costClass: 'other' },
    { ...body, month: '2026-13' }, { ...body, allocationId: 'bad space' }, { ...body, parentAllocationId: 'project-a' },
    { ...body, parentAllocationId: null }, { ...body, level: 'organization' }])('rejects invalid allocation %j', async invalid => {
    const admin = vi.fn(async (input: HostedAllocationRequest) => created(input)); const built = await runtime(admin);
    expect((await built.app.request(path, request(invalid))).status).toBe(400); expect(admin).not.toHaveBeenCalled();
  });

  it('refuses malformed JSON and non-JSON content without a write', async () => {
    const admin = vi.fn(async (input: HostedAllocationRequest) => created(input)); const built = await runtime(admin);
    expect((await built.app.request(path, { ...request(), body: '{' })).status).toBe(400);
    expect((await built.app.request(path, { ...request(), headers: { ...request().headers, 'content-type': 'text/plain' } })).status).toBe(400);
    expect(admin).not.toHaveBeenCalled();
  });

  it.each(['created', 'revised', 'duplicate'] as const)('returns only the public allocation fields on %s', async outcome => {
    const built = await runtime(async input => { const r = created(input); return { ...r, providerPayload: 'private',
      organization: { ...r.organization, providerPayload: 'private' }, result: { ...r.result, outcome,
        providerPayload: 'private', allocation: { ...r.result.allocation, providerPayload: 'private' } } }; });
    const response = await built.app.request(path, request());
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('private');
  });

  it.each(['parent-missing', 'children-exceed-parent', 'cap-below-children', 'cap-below-committed',
    'immutable-allocation-fields', 'organization-root-exists', 'level-order'])('preserves the store refusal %s', async reason => {
    const built = await runtime(async input => ({ organization: input.organization, result: { outcome: 'refused', reason,
      allocation: { ...created(input).result.allocation, allocationId: 'private-prior' } } }));
    const response = await built.app.request(path, request());
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'allocation_refused', safeMessage: reason } });
  });

  it.each(['scope-control', 'scope-org', 'id', 'month', 'limit', 'revision', 'private-refusal', 'mutation'])(
    'contains an invalid source result: %s', async mismatch => {
      const built = await runtime(async input => {
        if (mismatch === 'mutation') (input.organization as { organizationId: string }).organizationId = 'private';
        const r = created(input);
        if (mismatch === 'scope-control') return { ...r, organization: { ...organization, controlWorkspaceId: 'private' } };
        if (mismatch === 'scope-org') return { ...r, organization: { ...organization, organizationId: 'private' } };
        if (mismatch === 'private-refusal') return { ...r, result: { outcome: 'refused', reason: 'private-sql-error', allocation: null } };
        return { ...r, result: { ...r.result, allocation: { ...r.result.allocation,
          ...(mismatch === 'id' ? { allocationId: 'private' } : {}), ...(mismatch === 'month' ? { month: '2026-09' } : {}),
          ...(mismatch === 'limit' ? { capMicros: 100001 } : {}), ...(mismatch === 'revision' ? { revision: 0 } : {}) } } };
      });
      const response = await built.app.request(path, request());
      expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
    });

  it('contains a source outage and refuses unconfigured direct composition', async () => {
    const built = await runtime(async () => { throw new Error('private-store-error'); });
    const response = await built.app.request(path, request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-store-error');
    const route = createHostedBillingRoutes({ publicOrigin: origin, store, stripe: null, plans: [] })
      .find(r => r.method === 'POST' && r.path === '/hosted/billing/usage')!;
    expect((await route.handler(new Request(origin + path, request()), { principal })).status).toBe(503);
  });
});
