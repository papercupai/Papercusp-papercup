import { describe, expect, it, vi } from 'vitest';
import { HOSTED_BILLING_RECONCILE, assertHostedBillingRecoveryRuntime, makeHostedBillingReconcileAction, type HostedBillingReconcileActionDeps } from './hosted-billing-reconcile-action';

describe('hosted billing reconciliation action', () => {
  it('is deterministic, bounded and returns diagnostics without dispatching an agent', async () => {
    const run = vi.fn<NonNullable<HostedBillingReconcileActionDeps['run']>>(async () => ({ customers: 1, pages: 2, completed: 1, conflicts: 0, issues: [], failed: 0, budgetExhausted: false }));
    const action = makeHostedBillingReconcileAction({ run, makeDeps: async () => ({}) as never });
    const out = await action({ installSlug: 'papercusp', workspaceId: 'ws', triggerConfig: {}, payloadTemplate: {
      input: { accountId: 'acct_Test', createdFrom: 10, createdBefore: 100, overlapSeconds: 5, maxCustomers: 2, maxPages: 3 },
    } });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toEqual({ accountId: 'acct_Test', createdFrom: 10, createdBefore: 100, overlapSeconds: 5, maxCustomers: 2, maxPages: 3 });
    expect(out).toEqual({ diagnostics: { hostedBillingReconcile: expect.objectContaining({ pages: 2 }) } });
  });

  it('registers as a plan-schedulable system action', async () => {
    const { getSystemActionEntry } = await import('./system-actions');
    expect(HOSTED_BILLING_RECONCILE).toBe('hosted-billing-reconcile');
    expect(getSystemActionEntry(HOSTED_BILLING_RECONCILE)).toMatchObject({ scheduling: 'on-demand', planSchedulable: true });
  });

  it('refuses a dev-box or mismatched production runtime before resolving secrets', () => {
    const env = { PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'production', PAPERCUSP_DISTRIBUTION_PROFILE: 'hosted-control-plane', PAPERCUSP_STRIPE_ACCOUNT_ID: 'acct_Test' };
    expect(() => assertHostedBillingRecoveryRuntime(env, 'acct_Test')).not.toThrow();
    for (const changed of [{ ...env, PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'development' },
      { ...env, PAPERCUSP_DISTRIBUTION_PROFILE: 'operator' }, { ...env, PAPERCUSP_STRIPE_ACCOUNT_ID: 'acct_Other' }, {}]) {
      expect(() => assertHostedBillingRecoveryRuntime(changed, 'acct_Test')).toThrow('runtime_contract_unavailable');
    }
  });
});
