/**
 * The seam between hosted subscription facts and server-configured allowances.
 *
 * Signup, checkout and webhook code depend ONLY on this interface. They never
 * encode entitlement policy themselves; they persist subscription FACTS
 * (status, price, period) and ask the configured provider what those facts are
 * worth. Resource-capable providers also project version-pinned authority into
 * the existing grant ledger atomically with accepted billing facts.
 *
 * The output reuses the org-scoped entitlement vocabulary of
 * `hosted-entitlement-schema.ts` (WI-40806): a subscription resolves to a
 * bundle key plus an optional `HostedEntitlementPatch`, with source `billing` —
 * the source that schema already reserves for "a future billing projection".
 *
 * stripe-subscription-signup-2026-10-01 P-001 / D-001.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import { parseHostedEntitlementBundle, type HostedEntitlementBundle, type HostedEntitlementPatch } from '../../hosted-entitlement-schema';

/** Stripe subscription statuses, plus `pending` = known from checkout, no subscription event yet. */
export const HOSTED_SUBSCRIPTION_STATUSES = [
  'pending',
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type HostedSubscriptionStatus = (typeof HOSTED_SUBSCRIPTION_STATUSES)[number];

export function isHostedSubscriptionStatus(value: unknown): value is HostedSubscriptionStatus {
  return typeof value === 'string' && (HOSTED_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/** Statuses after which Stripe never revives the subscription. */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<HostedSubscriptionStatus> = new Set(['canceled', 'incomplete_expired']);

/** Statuses that block starting a second subscription for the same organization. */
export const SUBSCRIBED_STATUSES: ReadonlySet<HostedSubscriptionStatus> = new Set([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
]);

/** The persisted facts about an organization's current subscription. */
export interface HostedSubscriptionSnapshot {
  readonly organizationId: string;
  readonly stripeSubscriptionId: string;
  readonly status: HostedSubscriptionStatus;
  /** Configured plan key for `priceId`; null when the price is not (or no longer) configured. */
  readonly planKey: string | null;
  readonly priceId: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
  readonly livemode: boolean;
  readonly latestInvoiceStatus: 'paid' | 'payment_failed' | null;
}

export type HostedSubscriptionEntitlementReason =
  | 'active'
  | 'trialing'
  | 'grace_past_due'
  | 'not_subscribed'
  | 'inactive'
  | 'unknown_plan';

export interface HostedSubscriptionEntitlement {
  readonly entitled: boolean;
  readonly reason: HostedSubscriptionEntitlementReason;
  /** The hosted entitlement bundle this subscription maps to; null when not entitled. */
  readonly bundleKey: string | null;
  /**
   * Allowances (quotas/budgets/limits) the subscription adds. NULL means the
   * provider makes no allowance claim — the stub's answer until metering lands.
   * It never means "unlimited".
   */
  readonly patch: HostedEntitlementPatch | null;
  readonly source: 'billing';
  /** Which provider produced this answer (for audit and for the UI). */
  readonly providerId: string;
}

export interface HostedSubscriptionEntitlementProvider {
  readonly id: string;
  /** Server-only, version-pinned resource policy. Absent means no resource claim. */
  resourceBundleFor?(snapshot: HostedSubscriptionSnapshot | null, now: Date): HostedEntitlementBundle | null;
  entitlementFor(
    snapshot: HostedSubscriptionSnapshot | null,
    now: Date,
  ): HostedSubscriptionEntitlement | Promise<HostedSubscriptionEntitlement>;
}

export const STUB_ENTITLEMENT_PROVIDER_ID = 'stub:plan-key-bundle';

/** Explicit operator configuration; never a price/label-derived allowance. */
export function parseHostedPaidEntitlementBundle(value: unknown): HostedEntitlementBundle {
  const parsed = parseHostedEntitlementBundle(JSON.parse(JSON.stringify(value)));
  if (!parsed.ok) throw new Error('hosted_paid_policy_invalid');
  const bundle = parsed.value; const e = bundle.entitlements;
  if (bundle.record.source !== 'billing' || bundle.record.actor.kind !== 'service' || !e.allowedProviders.length ||
      e.limits.workspaces < 1 || e.limits.members < 1 ||
      ['pool.agents', 'pool.hosts', 'pool.cpu-millicores', 'pool.memory-mib', 'pool.db-gib', 'pool.workspace-gib']
        .some(key => !Number.isSafeInteger(e.quotas[key]) || e.quotas[key]! < 0) ||
      (e.quotas['pool.reserved-hosts'] ?? 0) > e.quotas['pool.hosts']! ||
      !Object.entries(e.budgets).some(([key, amount]) => /^pool\.cost\.[a-z]{3}\.minor$/.test(key) && Number.isSafeInteger(amount) && amount >= 0)) {
    throw new Error('hosted_paid_allowances_invalid');
  }
  return bundle;
}

export function createConfiguredHostedSubscriptionEntitlementProvider(plans: readonly {
  planKey: string; priceId: string; entitlementBundle?: HostedEntitlementBundle;
}[]): HostedSubscriptionEntitlementProvider {
  const policies = plans.filter(plan => plan.entitlementBundle).map(plan => ({
    planKey: plan.planKey, priceId: plan.priceId, bundle: parseHostedPaidEntitlementBundle(plan.entitlementBundle),
  }));
  const id = 'configured:hosted-billing-resource-policy-v1';
  const resourceBundleFor = (snapshot: HostedSubscriptionSnapshot | null, now: Date) => {
    if (!snapshot || !['active', 'trialing', 'past_due'].includes(snapshot.status) ||
        !snapshot.currentPeriodEnd || !Number.isFinite(snapshot.currentPeriodEnd.getTime()) ||
        snapshot.currentPeriodEnd.getTime() <= now.getTime()) return null;
    const policy = policies.find(row => row.planKey === snapshot.planKey && row.priceId === snapshot.priceId);
    if (!policy || policy.bundle.record.effectiveFrom.getTime() > now.getTime() ||
        (policy.bundle.record.effectiveUntil && policy.bundle.record.effectiveUntil.getTime() <= now.getTime())) return null;
    return structuredClone(policy.bundle);
  };
  return { id, resourceBundleFor, entitlementFor(snapshot, now) {
    const bundle = resourceBundleFor(snapshot, now);
    return { source: 'billing', providerId: id, entitled: bundle !== null,
      reason: bundle ? snapshot!.status === 'past_due' ? 'grace_past_due' : snapshot!.status === 'trialing' ? 'trialing' : 'active'
        : !snapshot ? 'not_subscribed' : !policies.some(row => row.planKey === snapshot.planKey && row.priceId === snapshot.priceId) ? 'unknown_plan' : 'inactive',
      bundleKey: bundle?.bundleId ?? null, patch: bundle?.entitlements ?? null };
  } };
}

/**
 * Default provider until metering is ready: an entitled status maps the plan
 * key to the `hosted-paid:<planKey>` bundle and claims NO allowances.
 * `past_due` stays entitled (Stripe's own retry window is the grace period);
 * an unconfigured price fails closed.
 */
export const stubHostedSubscriptionEntitlementProvider: HostedSubscriptionEntitlementProvider = {
  id: STUB_ENTITLEMENT_PROVIDER_ID,
  entitlementFor(snapshot) {
    const base = { source: 'billing' as const, providerId: STUB_ENTITLEMENT_PROVIDER_ID, patch: null };
    if (!snapshot) return { ...base, entitled: false, reason: 'not_subscribed', bundleKey: null };
    const reason: HostedSubscriptionEntitlementReason | null =
      snapshot.status === 'active' ? 'active'
        : snapshot.status === 'trialing' ? 'trialing'
          : snapshot.status === 'past_due' ? 'grace_past_due'
            : null;
    if (!reason) return { ...base, entitled: false, reason: 'inactive', bundleKey: null };
    if (!snapshot.planKey) return { ...base, entitled: false, reason: 'unknown_plan', bundleKey: null };
    return { ...base, entitled: true, reason, bundleKey: `hosted-paid:${snapshot.planKey}` };
  },
};

const state = pinModuleState('@papercusp/operator-core.hosted-billing-entitlement-seam', () => ({
  provider: stubHostedSubscriptionEntitlementProvider as HostedSubscriptionEntitlementProvider,
}));

/** Install the provider the metering work supplies. Returns the previous one (tests restore it). */
export function configureHostedSubscriptionEntitlementProvider(
  provider: HostedSubscriptionEntitlementProvider,
): HostedSubscriptionEntitlementProvider {
  const previous = state.provider;
  state.provider = provider;
  return previous;
}

export function currentHostedSubscriptionEntitlementProvider(): HostedSubscriptionEntitlementProvider {
  return state.provider;
}

/**
 * Resolve through a provider, failing CLOSED: a provider that throws or answers
 * malformed yields `entitled:false` rather than taking billing down with it.
 */
export async function resolveHostedSubscriptionEntitlement(
  snapshot: HostedSubscriptionSnapshot | null,
  options: { provider?: HostedSubscriptionEntitlementProvider; now?: Date } = {},
): Promise<HostedSubscriptionEntitlement> {
  const provider = options.provider ?? state.provider;
  try {
    const answer = await provider.entitlementFor(snapshot, options.now ?? new Date());
    if (!answer || typeof answer.entitled !== 'boolean' || answer.source !== 'billing') throw new Error('malformed');
    if (answer.entitled && !answer.bundleKey) throw new Error('entitled without a bundle');
    return answer;
  } catch {
    return {
      entitled: false,
      reason: 'inactive',
      bundleKey: null,
      patch: null,
      source: 'billing',
      providerId: provider.id,
    };
  }
}
