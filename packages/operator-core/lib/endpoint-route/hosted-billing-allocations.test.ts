/** Allocation finance view through the authenticated Hono/runtime composition. */
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { HostedBillingStore } from '../auth/hosted/billing/billing-store';
import { HOSTED_COST_CLASSES } from '../auth/hosted/billing/allocation-store';
import { projectHostedMonthlyCost } from '../auth/hosted/billing/usage-statement';
import { createHostedBillingRuntime, hostedBillingAllocationSource } from './hosted-billing-runtime';
import { createHostedBillingRoutes, type HostedBillingAllocationSource,
  type HostedBillingAllocationFinance } from './routes/hosted-billing';

const T = Date.UTC(2026, 9, 2);
const organization = { controlWorkspaceId: 'control-a', organizationId: 'org-a' };
const store: HostedBillingStore = {
  customerFor: async () => null, recordCustomer: async c => c,
  currentSubscription: async () => null, applyEvent: async () => ({ outcome: 'ignored', organizationId: null }),
  recordRejectedEvent: async () => 'recorded',
};
const principal = createHostedPrincipal({ workspaceId: organization.controlWorkspaceId, userId: 'user-a',
  activeOrganizationId: organization.organizationId, sessionId: 'session-a', sessionVersion: 1,
  permissions: ['billing:manage', 'workspace:view'] });
const resolvePrincipal: HostedPrincipalResolver = async headers => {
  const session = headers.get('test-session');
  if (!session) return { ok: false, reason: 'session_cookie_missing' };
  if (session === 'revoked') return { ok: false, reason: 'membership_not_active' };
  if (session === 'outage') return { ok: false, reason: 'authority_unavailable' };
  return { ok: true, principal: session === 'owner' ? principal : createHostedPrincipal({
    workspaceId: organization.controlWorkspaceId, userId: 'member', activeOrganizationId: organization.organizationId,
    sessionId: 'session-b', sessionVersion: 1, permissions: ['workspace:view'],
  }), session: {} as never, membership: {} as never };
};
type Input = Parameters<HostedBillingAllocationSource>[0];
function finance(input: Input): HostedBillingAllocationFinance {
  const forecast = { ...projectHostedMonthlyCost({ month: input.month, asOfMs: input.asOfMs,
    source: { complete: true, observedAtMs: T, maximumAgeMs: 0, evidenceRef: 'fixture:recorded-ledger' },
    gaps: new Set(), basisMicrosExact: '20003' }),
    scope: 'recorded-allocation-costs' as const, evidenceRef: 'fixture:recorded-ledger' };
  return { organization: input.organization, asOfMs: input.asOfMs,
    report: { month: input.month, byCostClass: Object.fromEntries(HOSTED_COST_CLASSES.map(c => [c, {
      committedMicros: 20003, unreconciledMicros: 0, providerFinalMicros: 20003, forecast,
      allocations: [{ allocationId: c, parentAllocationId: null, level: 'organization', capMicros: 100000,
        maxUnreconciledMicros: 10000, committedMicros: 20003, unreconciledMicros: 0,
        providerFinalMicros: 20003, availableMicros: 79997, openHolds: 0 }],
    }])) as unknown as HostedBillingAllocationFinance['report']['byCostClass'], outcomes: [{
      allocationId: 'model', outcomes: 1, byState: { accepted: 1, rejected: 0, 'rework-requested': 0, unknown: 0 },
      evidenceClasses: ['internal-simulation'], acceptedResultCostMicros: 20003, acceptedWithUnknownCost: 0,
      costPerAcceptedOutcomeMicros: 20003, costPerAcceptedUnknownReason: null,
      reviewEffortKnownSeconds: 0, reviewEffortUnknown: 1, reworkKnownTotal: 0, reworkUnknown: 1,
    }] },
    accounting: { organization: input.organization, month: input.month, currency: 'USD',
      byCostClass: Object.fromEntries(HOSTED_COST_CLASSES.map(c => [c, { reservations: 1, pendingProviderFinal: 0,
        committedMicros: 20003, unreconciledMicros: 0, providerFinalMicros: 20003,
      }])) as HostedBillingAllocationFinance['accounting']['byCostClass'],
      rows: [{ reservationId: 'r-1', allocationId: 'model', allocationPath: ['model'], costClass: 'model',
        revision: 2, observedAtMs: T, costSource: 'provider-billed', maximumCostMicros: 25000,
        observedCostMicros: { value: 20003 }, providerFinalCostMicros: { value: 20003 },
        committedMicros: 20003, unreconciledMicros: 0, outcomeIds: ['o-1'] }],
      outcomes: [{ outcomeId: 'o-1', revision: 1, allocationId: 'model', workflowRef: 'workflow:1',
        evidenceClass: 'internal-simulation', resultState: 'accepted', resultUnknownReason: null,
        reservationIds: ['r-1'], resultCostMicros: { value: 20003 },
        reviewEffortSeconds: { unknownReason: 'not-measured' }, reworkCount: { unknownReason: 'not-measured' } }],
      gaps: [{ kind: 'unknown-review-effort', ref: 'o-1', reason: 'not-measured' }],
    } };
}
async function runtime(allocations?: HostedBillingAllocationSource, runService?: HostedServiceContextRunner) {
  return createHostedBillingRuntime({ publicOrigin: 'https://app.example', stripeSecretKeyRef: null,
    stripeWebhookSecretRef: null, plans: [],
  }, { resolvePrincipal, store, allocations, runService, clock: () => new Date(T) });
}
const headers = (session = 'owner') => ({ headers: { 'test-session': session } });
const path = '/api/hosted/billing/usage?view=allocations';

describe('hosted billing allocation finance view', () => {
  it('binds scope/time on the server and preserves separate classes, unknowns and recorded-ledger forecast scope', async () => {
    const source = vi.fn(async (input: Input) => finance(input)); const built = await runtime(source);
    const response = await built.app.request(path + '&month=2026-10', headers());
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(source).toHaveBeenCalledExactlyOnceWith({ organization, month: '2026-10', asOfMs: T });
    const result = (await response.json()).allocations;
    expect(result.accounting.rows[0]).toMatchObject({ observedCostMicros: { value: 20003 }, outcomeIds: ['o-1'] });
    expect(result.accounting.outcomes[0]).toMatchObject({ reviewEffortSeconds: { unknownReason: 'not-measured' } });
    expect(Object.keys(result.report.byCostClass)).toEqual([...HOSTED_COST_CLASSES]);
    expect(result.report.byCostClass.model.forecast).toMatchObject({ basisMicros: 20003,
      projectedConsumptionMicros: 620093, provisional: true, scope: 'recorded-allocation-costs' });
  });

  it('defaults the allocation month to UTC without requiring Stripe', async () => {
    const source = vi.fn(async (input: Input) => finance(input)); const built = await runtime(source);
    expect((await built.app.request(path, headers())).status).toBe(200);
    expect(source.mock.calls[0][0].month).toBe('2026-10'); expect(built.configured).toBe(false);
  });

  it.each([['', 401], ['member', 403], ['revoked', 403], ['outage', 503]] as const)(
    'denies %s before reading allocations', async (session, status) => {
      const source = vi.fn(async (input: Input) => finance(input)); const built = await runtime(source);
      expect((await built.app.request(path, session ? headers(session) : {})).status).toBe(status);
      expect(source).not.toHaveBeenCalled();
    });

  it.each(['&workspaceId=customer-a', '&organizationId=other', '&controlWorkspaceId=other', '&complete=true',
    '&source=client', '&asOfMs=0', '&month=', '&month=2026-13', '&month=2026-10&month=2026-09', '&view=allocations'])(
    'rejects caller authority/census or ambiguous filters: %s', async query => {
      const source = vi.fn(async (input: Input) => finance(input)); const built = await runtime(source);
      expect((await built.app.request(path + query, headers())).status).toBe(400); expect(source).not.toHaveBeenCalled();
    });

  it.each(['', 'unknown', 'usage'])('rejects unsupported view=%s', async view => {
    const source = vi.fn(async (input: Input) => finance(input)); const built = await runtime(source);
    expect((await built.app.request('/api/hosted/billing/usage?view=' + view, headers())).status).toBe(400);
    expect(source).not.toHaveBeenCalled();
  });

  it.each(['control', 'organization', 'accounting-control', 'accounting-org', 'report-month', 'accounting-month', 'time', 'census'])(
    'withholds mismatched source %s', async mismatch => {
      const built = await runtime(async input => {
        const result = finance(input);
        if (mismatch === 'control') return { ...result, organization: { ...organization, controlWorkspaceId: 'foreign' } };
        if (mismatch === 'organization') return { ...result, organization: { ...organization, organizationId: 'foreign' } };
        if (mismatch === 'time') return { ...result, asOfMs: T + 1 };
        if (mismatch === 'report-month') return { ...result, report: { ...result.report, month: '2026-09' } };
        if (mismatch === 'accounting-month') return { ...result, accounting: { ...result.accounting, month: '2026-09' } };
        if (mismatch === 'census') {
          delete (result.report.byCostClass.model as { forecast?: unknown }).forecast; return result;
        }
        return { ...result, accounting: { ...result.accounting, organization: { ...organization,
          [mismatch === 'accounting-control' ? 'controlWorkspaceId' : 'organizationId']: 'foreign' } } };
      });
      const response = await built.app.request(path, headers());
      expect(response.status).toBe(503); expect(await response.text()).not.toContain('foreign');
    });

  it('contains source failures and prevents source mutation of request authority', async () => {
    for (const source of [async () => { throw new Error('private-sql-provider-body'); }, async (input: Input) => {
      (input.organization as { organizationId: string }).organizationId = 'foreign'; return finance(input);
    }, async (input: Input) => {
      (input as { month: string }).month = '2026-09'; return finance(input);
    }]) {
      const built = await runtime(source); const response = await built.app.request(path, headers());
      expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-sql-provider-body');
    }
  });

  it('whitelists nested objects rather than forwarding private source diagnostics', async () => {
    const built = await runtime(async input => {
      const result = structuredClone(finance(input));
      const contaminate = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        for (const child of Object.values(value)) contaminate(child);
        if (!Array.isArray(value)) Object.assign(value, { providerPayload: 'private-provider-body' });
      };
      contaminate(result); return result;
    });
    const response = await built.app.request(path, headers());
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('private-provider-body');
  });

  it('fails safely when the route has no allocation source', async () => {
    const route = createHostedBillingRoutes({ publicOrigin: 'https://app.example', store, stripe: null, plans: [],
      clock: () => new Date(T) }).find(r => r.path === '/hosted/billing/usage')!;
    expect((await route.handler(new Request('https://app.example' + path), { principal })).status).toBe(503);
  });

  it('composes both default projections in one service transaction under the scoped organization fence', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray, ..._parameters: unknown[]) => []);
    let transactions = 0;
    const run: HostedServiceContextRunner = fn => { transactions++; return fn(sql as unknown as Sql); };
    const built = await runtime(undefined, run);
    const response = await built.app.request(path, headers());
    expect(response.status).toBe(200); expect(transactions).toBe(1);
    const result = (await response.json()).allocations;
    expect(result.accounting.rows).toEqual([]);
    expect(result.report.byCostClass.model.forecast.scope).toBe('recorded-allocation-costs');
    const queries = sql.mock.calls.map(([q]) => q.join(' '));
    expect(queries[0]).toContain('lock_hosted_stripe_funding_population');
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries).toEqual(expect.arrayContaining([expect.stringContaining('hosted_budget_allocations'),
      expect.stringContaining('hosted_budget_allocation_holds')]));
    for (const [q, ...parameters] of sql.mock.calls) {
      if (q.join(' ').includes('pg_advisory_xact_lock')) {
        expect(parameters.join(' ')).toContain(organization.controlWorkspaceId);
        expect(parameters.join(' ')).toContain(organization.organizationId);
      } else if (q.join(' ').includes('control_workspace_id')) {
        expect(parameters).toEqual(expect.arrayContaining(Object.values(organization)));
      }
    }
    sql.mockRejectedValueOnce(new Error('private-sql-error'));
    await expect(hostedBillingAllocationSource(run)({ organization, month: '2026-10', asOfMs: T })).rejects.toThrow('private-sql-error');
  });
});
