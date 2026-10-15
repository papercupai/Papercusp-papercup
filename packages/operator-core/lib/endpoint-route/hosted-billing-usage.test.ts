/** Billing usage through the real auth/runtime composition, with source seams injected. */
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedBillingStore } from '../auth/hosted/billing/billing-store';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import { buildHostedUsageStatement, type HostedUsageRecord } from '../auth/hosted/billing/usage-statement';
import type { HostedBillingUsageSource } from '../auth/hosted/billing/usage-service';
import { createHostedBillingRuntime } from './hosted-billing-runtime';

const T = Date.UTC(2026, 9, 2);
const CONTROL = 'control-a'; const ORG = 'org-a';
type UsageRead = Parameters<HostedBillingUsageSource>[0];
const resolvePrincipal: HostedPrincipalResolver = async headers => {
  const session = headers.get('test-session');
  if (session === 'outage') return { ok: false, reason: 'authority_unavailable' };
  if (session === 'revoked') return { ok: false, reason: 'membership_not_active' };
  if (!session) return { ok: false, reason: 'session_cookie_missing' };
  return { ok: true, principal: createHostedPrincipal({ workspaceId: CONTROL, userId: 'user-a',
    activeOrganizationId: ORG, sessionId: 'session-a', sessionVersion: 1,
    permissions: session === 'owner' ? ['billing:manage', 'workspace:view'] : ['workspace:view'],
  }), session: {} as never, membership: {} as never };
};
const billingStore: HostedBillingStore = {
  customerFor: async () => null, recordCustomer: async customer => customer,
  currentSubscription: async () => null, applyEvent: async () => ({ outcome: 'ignored', organizationId: null }),
  recordRejectedEvent: async () => 'recorded',
};
function statement(input: Parameters<HostedBillingUsageSource>[0], complete = false) {
  const record: HostedUsageRecord = { ...input.scope, customerWorkspaceId: input.scope.customerWorkspaceId ?? 'customer-a',
    provider: 'fixture-provider', recordId: 'r-1', usageId: 'u-1', revision: 1, category: 'compute', payer: 'consumption',
    occurredAtMs: T - 1, observedAtMs: T, quantity: 60, unit: 'seconds', costSource: 'provider-billed',
    costMicros: 20_003, sourceRef: 'fixture:bill' };
  return buildHostedUsageStatement({ ...input, source: { complete, observedAtMs: T,
    maximumAgeMs: 0, evidenceRef: 'fixture:partial-census' }, records: [record] });
}
async function runtime(usage?: HostedBillingUsageSource, runService?: HostedServiceContextRunner) {
  return createHostedBillingRuntime({ publicOrigin: 'https://app.example', stripeSecretKeyRef: null,
    stripeWebhookSecretRef: null, plans: [],
  }, {
    resolvePrincipal, store: billingStore, usage, runService, clock: () => new Date(T),
  });
}
const headers = (session = 'owner') => ({ headers: { 'test-session': session } });

describe('GET /hosted/billing/usage', () => {
  it('derives control/org authority from the verified principal and accepts only month/workspace filters', async () => {
    const usage = vi.fn(async (input: UsageRead) => statement(input)); const built = await runtime(usage);
    const response = await built.app.request('/api/hosted/billing/usage?month=2026-10&workspaceId=customer-a', headers());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(usage).toHaveBeenCalledExactlyOnceWith({ scope: { controlWorkspaceId: CONTROL, organizationId: ORG,
      customerWorkspaceId: 'customer-a' }, month: '2026-10', asOfMs: T });
    const body = await response.json();
    expect(body.statement.consumptionBilled).toEqual({ micros: 20_003, wholeCents: 2, roundingMicros: 3 });
    expect(body.statement.settlementEligible).toBe(false);
    expect(body.statement.gaps).toContain('incomplete-source');
    expect(body.statement.forecast).toMatchObject({ projectedConsumptionMicros: null, unavailableReason: 'incomplete-source' });
  });

  it('exposes a provisional monthly forecast while retaining the exact billed amount', async () => {
    const built = await runtime(async input => statement(input, true));
    const response = await built.app.request('/api/hosted/billing/usage?month=2026-10', headers());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.statement.consumptionBilled.micros).toBe(20_003);
    expect(body.statement.forecast).toMatchObject({ method: 'linear-elapsed-utc-month', basisMicros: 20_003,
      projectedConsumptionMicros: 620_093, provisional: true, unavailableReason: null });
  });

  it('defaults to the UTC month and organization-wide scope without requiring Stripe configuration', async () => {
    const usage = vi.fn(async (input: UsageRead) => statement(input)); const built = await runtime(usage);
    const response = await built.app.request('/api/hosted/billing/usage', headers());
    expect(response.status).toBe(200); expect(built.configured).toBe(false);
    expect(usage).toHaveBeenCalledExactlyOnceWith({ scope: { controlWorkspaceId: CONTROL, organizationId: ORG,
      customerWorkspaceId: null }, month: '2026-10', asOfMs: T });
  });

  it.each([['', 401], ['member', 403], ['revoked', 403], ['outage', 503]] as const)('denies %s before invoking the usage source', async (session, status) => {
    const usage = vi.fn(async (input: UsageRead) => statement(input)); const built = await runtime(usage);
    const response = await built.app.request('/api/hosted/billing/usage', session ? headers(session) : {});
    expect(response.status).toBe(status); expect(usage).not.toHaveBeenCalled();
  });

  it.each(['month=2026-13', 'month=', 'month=2026-10&month=2026-09', 'workspaceId=',
    'workspaceId=customer-a&workspaceId=customer-b', 'organizationId=org-b', 'controlWorkspaceId=control-b', 'complete=true'])('refuses ambiguous or caller-authored authority/census: %s', async query => {
    const usage = vi.fn(async (input: UsageRead) => statement(input)); const built = await runtime(usage);
    expect((await built.app.request('/api/hosted/billing/usage?' + query, headers())).status).toBe(400);
    expect(usage).not.toHaveBeenCalled();
  });

  it('contains source failures without returning provider diagnostics or a false zero bill', async () => {
    const built = await runtime(async () => { throw new Error('private-provider-body'); });
    const response = await built.app.request('/api/hosted/billing/usage', headers());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-provider-body');
  });

  it.each(['controlWorkspaceId', 'organizationId', 'customerWorkspaceId'] as const)('contains a source scope mismatch in %s', async key => {
    const built = await runtime(async input => ({ ...statement(input), scope: { ...input.scope, [key]: 'foreign' } }));
    const response = await built.app.request('/api/hosted/billing/usage?workspaceId=customer-a', headers());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('foreign');
  });

  it('refuses request-binding mutation and strips extra provider fields at every response level', async () => {
    const mutating = await runtime(async input => {
      (input.scope as { organizationId: string }).organizationId = 'foreign'; return statement(input);
    });
    expect((await mutating.app.request('/api/hosted/billing/usage', headers())).status).toBe(503);
    const built = await runtime(async input => {
      const result = statement(input);
      return { ...result, providerPayload: 'private', scope: { ...result.scope, providerPayload: 'private' },
        forecast: { ...result.forecast, providerPayload: 'private' },
        lines: result.lines.map(line => ({ ...line, providerPayload: 'private' })),
        history: result.history.map(history => ({ ...history, providerPayload: 'private',
          revisions: history.revisions.map(revision => ({ ...revision, providerPayload: 'private' })) })),
      };
    });
    const response = await built.app.request('/api/hosted/billing/usage', headers());
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('private');
  });

  it('returns whitelisted exact amounts and fractional residue through the authenticated usage route', async () => {
    const built = await runtime(async input => buildHostedUsageStatement({ ...input,
      source: { complete: false, observedAtMs: T, maximumAgeMs: 0, evidenceRef: 'fixture:decimal' }, records: [{
        ...input.scope, customerWorkspaceId: input.scope.customerWorkspaceId ?? 'customer-a', provider: 'fixture-provider',
        recordId: 'decimal-r', usageId: 'decimal-u', revision: 1, category: 'compute', payer: 'consumption',
        occurredAtMs: T - 1, observedAtMs: T, quantity: 1, unit: 'seconds', costSource: 'provider-billed',
        costMicros: 20003, costMicrosExact: '20003.56', sourceRef: 'fixture:decimal-bill',
      }] }));
    const response = await built.app.request('/api/hosted/billing/usage', headers());
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.statement.consumptionBilled).toMatchObject({ microsExact: '20003.56', roundingMicrosExact: '3.56', wholeCents: 2 });
    expect(body.statement.lines[0]).toMatchObject({ billedMicrosExact: '20003.56' });
    expect(body.statement.history[0].revisions[0]).toMatchObject({ costMicrosExact: '20003.56' });
  });

  it('mounts the default durable store source and keeps an empty unmeasured population incomplete', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray, ..._parameters: unknown[]) => []);
    const runService: HostedServiceContextRunner = fn => fn(sql as unknown as Sql);
    const built = await runtime(undefined, runService);
    const response = await built.app.request('/api/hosted/billing/usage', headers());
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body.statement.lines).toEqual([]);
    expect(body.statement.settlementEligible).toBe(false); expect(body.statement.gaps).toContain('incomplete-source');
    // The default source reads collector bindings before reading durable usage.
    // Assert both purposes and their tenant scope instead of an obsolete query count.
    expect(sql.mock.calls.map(([query]) => query.join(' '))).toEqual(expect.arrayContaining([
      expect.stringContaining("b.provider = 'openrouter'"),
      expect.stringContaining('ORDER BY customer_workspace_id'),
    ]));
    for (const [_query, ...parameters] of sql.mock.calls) {
      expect(parameters).toContain(CONTROL);
      expect(parameters).toContain(ORG);
    }
    expect(sql.mock.calls[0]).toEqual(expect.arrayContaining([CONTROL, ORG]));
  });
});
