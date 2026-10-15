/** Bounded server-only Stripe recovery. The store owns cursor/fact atomicity;
 * observations never masquerade as signed webhook deliveries. P-016. */
import type { HostedBillingReconciliationCheckpoint } from './billing-store';
import type { StripeBillingClient } from './stripe-billing-client';

export type HostedBillingFailureClass = 'endpoint-store-unavailable' | 'permanent-rejection'
  | 'customer-unmapped' | 'replay-mismatch' | 'undelivered' | 'provider-unavailable' | 'recovery-unavailable' | 'budget-exhausted';
export interface HostedBillingFailureObservation {
  readonly failureClass: HostedBillingFailureClass;
  readonly eventId: string | null;
}
export type HostedBillingFailureObserver = (observation: HostedBillingFailureObservation) => Promise<void>;

/** Safe structured stderr survives a billing-transaction rollback. Production
 * log routing must consume this marker; no credentials, body or thrown error. */
export async function logHostedBillingFailure(observation: HostedBillingFailureObservation): Promise<void> {
  console.error('[hosted-billing-observation]', JSON.stringify(observation));
}
export async function observeHostedBillingFailure(observer: HostedBillingFailureObserver,
  failureClass: HostedBillingFailureClass, eventId: string | null): Promise<void> {
  const observation = { failureClass, eventId: eventId && /^evt_[A-Za-z0-9]+$/.test(eventId) ? eventId : null };
  try { await observer(observation); }
  catch { await logHostedBillingFailure(observation); }
}

export interface HostedBillingRecoveryTarget {
  readonly organizationId: string;
  readonly checkpoint: HostedBillingReconciliationCheckpoint | null;
}
export interface HostedBillingDeliveryIssue {
  readonly eventId: string;
  readonly failureClass: 'undelivered' | 'permanent-rejection' | 'customer-unmapped';
}
export interface HostedBillingRecoveryDependencies {
  readonly store: Pick<import('./billing-store').HostedBillingRecoveryStore,
    'beginReconciliation' | 'applyReconciliationPage' | 'reconciliationTargets' | 'deliveryIssues'>;
  readonly client: Pick<StripeBillingClient, 'livemode' | 'readBillingEventPage'>;
  readonly planKeyForPrice: (priceId: string | null) => string | null;
  readonly observe: HostedBillingFailureObserver;
}
export interface HostedBillingRecoveryInput {
  readonly accountId: string;
  readonly createdFrom: number;
  readonly createdBefore: number;
  readonly overlapSeconds: number;
  readonly maxCustomers: number;
  /** Total page budget across customers, not per customer. */
  readonly maxPages: number;
}

export async function reconcileHostedBilling(input: HostedBillingRecoveryInput,
  deps: HostedBillingRecoveryDependencies, signal: AbortSignal): Promise<{
    customers: number; pages: number; completed: number; conflicts: number;
    issues: HostedBillingDeliveryIssue[]; failed: number; budgetExhausted: boolean;
  }> {
  const pin = { ...input };
  if (!/^acct_[A-Za-z0-9]+$/.test(pin.accountId)
      || !Number.isSafeInteger(pin.createdFrom) || pin.createdFrom < 0
      || !Number.isSafeInteger(pin.createdBefore) || pin.createdBefore <= pin.createdFrom
      || !Number.isSafeInteger(pin.overlapSeconds) || pin.overlapSeconds < 0 || pin.overlapSeconds > 86400
      || !Number.isSafeInteger(pin.maxCustomers) || pin.maxCustomers < 1 || pin.maxCustomers > 100
      || !Number.isSafeInteger(pin.maxPages) || pin.maxPages < 1 || pin.maxPages > 100) {
    throw new Error('billing_recovery_invalid_input');
  }
  const out = { customers: 0, pages: 0, completed: 0, conflicts: 0,
    issues: [] as HostedBillingDeliveryIssue[], failed: 0, budgetExhausted: false };
  // Independent census BEFORE repair. It includes prior API-only receipts and
  // permanent refusals, so an empty newer provider window cannot clear them.
  out.issues = await deps.store.deliveryIssues({ expectedLivemode: deps.client.livemode, limit: 100 });
  for (const issue of out.issues) await observeHostedBillingFailure(deps.observe, issue.failureClass, issue.eventId);
  const targets = await deps.store.reconciliationTargets({ expectedLivemode: deps.client.livemode, limit: pin.maxCustomers });
  for (const target of targets) {
    if (signal.aborted || out.pages >= pin.maxPages) { out.budgetExhausted = true; break; }
    out.customers += 1;
    try {
      const prior = target.checkpoint;
      if (prior?.complete && prior.createdBefore >= pin.createdBefore) { out.completed += 1; continue; }
      // Resume older incomplete windows through the store. Completed windows
      // extend without a gap even if the scheduler was down for several days.
      const createdFrom = prior ? Math.max(0, prior.createdBefore - pin.overlapSeconds) : pin.createdFrom;
      let checkpoint = await deps.store.beginReconciliation({ organizationId: target.organizationId,
        accountId: pin.accountId, expectedLivemode: deps.client.livemode, createdFrom, createdBefore: pin.createdBefore });
      while (!checkpoint.complete && out.pages < pin.maxPages && !signal.aborted) {
        out.pages += 1;
        const page = await deps.client.readBillingEventPage({ accountId: checkpoint.accountId,
          customerId: checkpoint.customerId, organizationId: checkpoint.organizationId,
          createdFrom: checkpoint.createdFrom, createdBefore: checkpoint.createdBefore,
          ...(checkpoint.startingAfter ? { startingAfter: checkpoint.startingAfter } : {}) }, signal);
        if (!page.ok) {
          out.failed += 1;
          await observeHostedBillingFailure(deps.observe, 'provider-unavailable', null);
          break;
        }
        const applied = await deps.store.applyReconciliationPage({ checkpoint, evidence: page.evidence,
          planKeyForPrice: deps.planKeyForPrice });
        if (applied.outcome === 'cursor-conflict') { out.conflicts += 1; break; }
        checkpoint = applied.checkpoint;
      }
      if (checkpoint.complete) out.completed += 1;
      else if (out.pages >= pin.maxPages || signal.aborted) out.budgetExhausted = true;
    } catch {
      out.failed += 1;
      await observeHostedBillingFailure(deps.observe, 'recovery-unavailable', null);
    }
  }
  // Read again after committed pages: catches never-delivered provider events
  // even though there was no endpoint or receipt to inspect before repair.
  out.issues = await deps.store.deliveryIssues({ expectedLivemode: deps.client.livemode, limit: 100 });
  for (const issue of out.issues) await observeHostedBillingFailure(deps.observe, issue.failureClass, issue.eventId);
  if (out.budgetExhausted) await observeHostedBillingFailure(deps.observe, 'budget-exhausted', null);
  return out;
}

