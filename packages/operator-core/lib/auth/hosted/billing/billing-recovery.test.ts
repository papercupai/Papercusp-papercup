import { describe, expect, it, vi } from 'vitest';
import { reconcileHostedBilling, observeHostedBillingFailure, type HostedBillingRecoveryDependencies } from './billing-recovery';

const checkpoint = (complete = false) => ({ accountId: 'acct_test', customerId: 'cus_test', organizationId: '00000000-0000-0000-0000-000000000001',
  livemode: false, createdFrom: 10, createdBefore: 100, startingAfter: null, revision: 1, complete, cursors: [] });
const page = (hasMore = false) => ({ source: 'stripe-authenticated-api' as const, accountId: 'acct_test', customerId: 'cus_test', organizationId: checkpoint().organizationId,
  livemode: false, createdFrom: 10, createdBefore: 100, startingAfter: null, nextCursor: hasMore ? 'evt_next' : null,
  hasMore, observedAtMs: 1, requestIds: ['req_a', 'req_b', 'req_c'], observations: [], evidenceRef: 'stripe-billing-page:test' });

function deps(overrides: Partial<HostedBillingRecoveryDependencies> = {}): HostedBillingRecoveryDependencies {
  return {
    store: {
      deliveryIssues: vi.fn(async () => []),
      reconciliationTargets: vi.fn(async () => [{ organizationId: checkpoint().organizationId, checkpoint: null }]),
      beginReconciliation: vi.fn(async () => checkpoint()),
      applyReconciliationPage: vi.fn(async ({ checkpoint: pin }) => ({ outcome: 'applied' as const, checkpoint: { ...pin, complete: true } })),
    },
    client: { livemode: false, readBillingEventPage: vi.fn(async () => ({ ok: true as const, evidence: page() })) },
    planKeyForPrice: () => null,
    observe: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('hosted billing recovery coordinator', () => {
  it('advances only after the page apply returns and reports bounded diagnostics', async () => {
    const d = deps();
    await expect(reconcileHostedBilling({ accountId: 'acct_test', createdFrom: 10, createdBefore: 100,
      overlapSeconds: 5, maxCustomers: 1, maxPages: 1 }, d, new AbortController().signal)).resolves.toMatchObject({ customers: 1, pages: 1, completed: 1, failed: 0 });
    expect(d.store.applyReconciliationPage).toHaveBeenCalledOnce();
  });

  it('keeps provider failure observable and never claims completion', async () => {
    const observe = vi.fn(async () => {});
    const d = deps({
      client: { livemode: false, readBillingEventPage: vi.fn(async () => ({ ok: false as const, code: 'provider-error' as const, status: 503, detail: 'redacted' })) },
      observe,
    });
    const out = await reconcileHostedBilling({ accountId: 'acct_test', createdFrom: 10, createdBefore: 100,
      overlapSeconds: 5, maxCustomers: 1, maxPages: 1 }, d, new AbortController().signal);
    expect(out).toMatchObject({ pages: 1, completed: 0, failed: 1 });
    expect(observe).toHaveBeenCalledWith({ failureClass: 'provider-unavailable', eventId: null });
  });

  it('sanitizes provider ids and does not let alert delivery hide the observation', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await observeHostedBillingFailure(async () => { throw new Error('alert route unavailable'); }, 'undelivered', 'raw-secret-or-payload');
    expect(log).toHaveBeenCalledWith('[hosted-billing-observation]', JSON.stringify({ failureClass: 'undelivered', eventId: null }));
    log.mockRestore();
  });

  it('reports a missed delivery discovered after repair even when the initial census was empty', async () => {
    const d = deps(); const issue = { eventId: 'evt_Missed', failureClass: 'undelivered' as const };
    vi.mocked(d.store.deliveryIssues).mockResolvedValueOnce([]).mockResolvedValueOnce([issue]);
    const out = await reconcileHostedBilling({ accountId: 'acct_test', createdFrom: 10, createdBefore: 100,
      overlapSeconds: 5, maxCustomers: 1, maxPages: 1 }, d, new AbortController().signal);
    expect(out.issues).toEqual([issue]);
    expect(d.observe).toHaveBeenCalledWith(issue);
  });

  it('keeps an unfinished window resumable when the total page budget ends', async () => {
    const d = deps();
    vi.mocked(d.store.applyReconciliationPage).mockResolvedValue({ outcome: 'applied',
      checkpoint: { ...checkpoint(), startingAfter: 'evt_next', revision: 2 } });
    const out = await reconcileHostedBilling({ accountId: 'acct_test', createdFrom: 10, createdBefore: 100,
      overlapSeconds: 5, maxCustomers: 1, maxPages: 1 }, d, new AbortController().signal);
    expect(out).toMatchObject({ pages: 1, completed: 0, budgetExhausted: true });
    expect(d.observe).toHaveBeenCalledWith({ failureClass: 'budget-exhausted', eventId: null });
    expect(d.store.beginReconciliation).toHaveBeenCalledOnce();
  });

  it('stops an overlapping stale pass on cursor conflict', async () => {
    const d = deps();
    vi.mocked(d.store.applyReconciliationPage).mockResolvedValue({ outcome: 'cursor-conflict', checkpoint: checkpoint(true) });
    const out = await reconcileHostedBilling({ accountId: 'acct_test', createdFrom: 10, createdBefore: 100,
      overlapSeconds: 5, maxCustomers: 1, maxPages: 10 }, d, new AbortController().signal);
    expect(out).toMatchObject({ pages: 1, conflicts: 1, completed: 0 });
    expect(d.client.readBillingEventPage).toHaveBeenCalledOnce();
  });

  it('extends a prior completed window without losing a scheduler outage gap', async () => {
    const d = deps();
    vi.mocked(d.store.reconciliationTargets).mockResolvedValue([{ organizationId: checkpoint().organizationId, checkpoint: checkpoint(true) }]);
    await reconcileHostedBilling({ accountId: 'acct_test', createdFrom: 500, createdBefore: 600,
      overlapSeconds: 5, maxCustomers: 1, maxPages: 1 }, d, new AbortController().signal);
    expect(d.store.beginReconciliation).toHaveBeenCalledWith(expect.objectContaining({ createdFrom: 95, createdBefore: 600 }));
  });

  it('refuses invalid bounds before any database or provider action', async () => {
    const d = deps();
    await expect(reconcileHostedBilling({ accountId: 'acct_test', createdFrom: 10, createdBefore: 100,
      overlapSeconds: 5, maxCustomers: 1, maxPages: 0 }, d, new AbortController().signal)).rejects.toThrow('invalid_input');
    expect(d.store.deliveryIssues).not.toHaveBeenCalled();
  });

  it('an aborted pass performs no provider read and records an unfinished result', async () => {
    const d = deps(); const controller = new AbortController(); controller.abort();
    const out = await reconcileHostedBilling({ accountId: 'acct_test', createdFrom: 10, createdBefore: 100,
      overlapSeconds: 5, maxCustomers: 1, maxPages: 10 }, d, controller.signal);
    expect(out).toMatchObject({ pages: 0, completed: 0, budgetExhausted: true });
    expect(d.client.readBillingEventPage).not.toHaveBeenCalled();
  });
});
