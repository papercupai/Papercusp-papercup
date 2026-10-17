/**
 * Hosted organization subscription billing routes (app.papercusp.com).
 *
 *   GET  /hosted/billing/plans         public   — configured plans (no prices: Stripe owns those)
 *   GET  /hosted/billing/subscription  member   — current subscription + what it entitles
 *   POST /hosted/billing/checkout      billing:manage — Stripe Checkout (subscription mode) URL
 *   POST /hosted/billing/portal        billing:manage — Stripe customer-portal URL (manage/cancel)
 *   GET  /hosted/billing/receipts      billing:manage — the org's own payment receipts (P-046)
 *   POST /hosted/billing/webhook       public, Stripe-signed — subscription state intake
 *
 * Mounted only by `hosted-billing-runtime.ts`, never the local route barrel.
 * Entitlement policy is NOT decided here: the subscription route asks the
 * `HostedSubscriptionEntitlementProvider` seam.
 *
 * stripe-subscription-signup-2026-10-01 P-005; receipts:
 * agent-economy-flywheel-2026-08-30 P-046 / D-029 §7 (WI-10004802).
 */
import { randomUUID } from 'node:crypto';
import type { HostedPermission, HostedPrincipal } from '../../../auth/hosted-principal';
import type { HostedBillingStore } from '../../../auth/hosted/billing/billing-store';
import { logHostedBillingFailure, observeHostedBillingFailure, type HostedBillingFailureObserver } from '../../../auth/hosted/billing/billing-recovery';
import type { HostedBillingUsageSource } from '../../../auth/hosted/billing/usage-service';
import type { HostedUsageStatement } from '../../../auth/hosted/billing/usage-statement';
import { HOSTED_COST_CLASSES, type HostedAllocationOrganization, type HostedAllocationReport,
  type HostedAllocationAccountingExport, type HostedCostClass, type KnownOrUnknown,
  type HostedAllocationRequest, type HostedAllocationOutcome } from '../../../auth/hosted/billing/allocation-store';
import {
  SUBSCRIBED_STATUSES,
  resolveHostedSubscriptionEntitlement,
  type HostedSubscriptionEntitlementProvider,
} from '../../../auth/hosted/billing/entitlement-seam';
import type { StripeBillingClient } from '../../../auth/hosted/billing/stripe-billing-client';
import { parseHostedBillingEvent } from '../../../auth/hosted/billing/stripe-billing-events';
import { createStripeAdapter } from '../../../cupboard/payment-adapters/stripe';
import type { CustomerReceiptEntry } from '../../../cupboard/payment-receipt-store';
import { webhookBodyDigest } from '../../../cupboard/webhook-inbox';

export const HOSTED_BILLING_ROUTES = [
  { method: 'GET', path: '/hosted/billing/plans', access: 'public' },
  { method: 'GET', path: '/hosted/billing/subscription', access: 'authenticated' },
  { method: 'POST', path: '/hosted/billing/checkout', access: 'authenticated' },
  { method: 'POST', path: '/hosted/billing/portal', access: 'authenticated' },
  { method: 'GET', path: '/hosted/billing/receipts', access: 'authenticated' },
  { method: 'GET', path: '/hosted/billing/usage', access: 'authenticated' },
  { method: 'POST', path: '/hosted/billing/usage', access: 'authenticated' },
  { method: 'POST', path: '/hosted/billing/webhook', access: 'public' },
] as const;

/**
 * Every payment receipt for ONE Stripe customer, newest first. The route only
 * ever passes the signed-in organization's own customer id; which workspace's
 * ledger holds the receipts is the composition's decision.
 */
export type HostedBillingReceiptSource = (stripeCustomerId: string) => Promise<readonly CustomerReceiptEntry[]>;

/** Server-owned monthly ledger snapshot. Its census covers recorded allocation
 * costs only; it does not attest that every provider bill has been recorded. */
export interface HostedBillingAllocationFinance {
  readonly organization: HostedAllocationOrganization;
  readonly asOfMs: number;
  readonly report: HostedAllocationReport;
  readonly accounting: HostedAllocationAccountingExport;
}
export type HostedBillingAllocationSource = (input: Readonly<{
  organization: HostedAllocationOrganization; month: string; asOfMs: number;
}>) => Promise<HostedBillingAllocationFinance>;

/** Defines limits only; this seam cannot credit funding or settle provider costs. */
export type HostedBillingAllocationAdmin = (input: HostedAllocationRequest) => Promise<{
  readonly organization: HostedAllocationOrganization;
  readonly result: HostedAllocationOutcome;
}>;

/** One entry of `GET /hosted/billing/receipts`. */
export interface HostedBillingReceiptView {
  readonly balanceTransactionId: string;
  readonly created: string;
  readonly amount: number;
  readonly currency: string;
  /** `anchored` carries the verifiable receipt; anything else is still waiting for an anchored root. */
  readonly status: 'anchored' | 'not-yet-anchored';
  /** Why a not-yet-anchored entry is waiting (`not-chained` | `not-in-log` | `not-yet-anchored` | …). */
  readonly pendingReason: string | null;
  /** The receipt exactly as `scripts/verify-payment-receipt.mts` checks it; null until anchored. */
  readonly receipt: unknown;
}

export function hostedBillingReceiptView(entry: CustomerReceiptEntry): HostedBillingReceiptView {
  const base = {
    balanceTransactionId: entry.balanceTransactionId,
    created: new Date(entry.created * 1000).toISOString(),
    amount: entry.amount,
    currency: entry.currency,
  };
  return entry.result.ok
    ? { ...base, status: 'anchored', pendingReason: null, receipt: entry.result.receipt }
    : { ...base, status: 'not-yet-anchored', pendingReason: entry.result.error, receipt: null };
}

/** Browser path (under the `/api` base) the Checkout and portal flows return to. */
export const HOSTED_BILLING_RETURN_PATH = '/billing';

export interface HostedBillingPlan {
  readonly planKey: string;
  /** Stripe price id (`price_…`) — configuration, never code. Dollar amounts live in Stripe. */
  readonly priceId: string;
  readonly label: string;
  readonly description: string | null;
  /** Server-authored resource policy, excluded from the public plan list. */
  readonly entitlementBundle?: import('../../../auth/hosted-entitlement-schema').HostedEntitlementBundle;
}

/** Everything that exists only once Stripe is configured. */
export interface HostedBillingStripe {
  readonly client: StripeBillingClient;
  readonly webhookSecret: string;
  /** Explicit customer-portal configuration (`bpc_…`); null = the account's dashboard default. */
  readonly portalConfigurationId?: string | null;
}

export interface HostedBillingRouteDependencies {
  /** Independent of billing receipt/fact transactions. */
  readonly observeFailure?: HostedBillingFailureObserver;
  readonly publicOrigin: string;
  readonly plans: readonly HostedBillingPlan[];
  readonly store: HostedBillingStore;
  /** Null = billing is not configured on this host; mutating routes answer 503. */
  readonly stripe: HostedBillingStripe | null;
  /** Why `stripe` is null, surfaced to the UI (e.g. `live_mode_not_allowed`). */
  readonly unavailableReason?: string | null;
  readonly entitlementProvider?: HostedSubscriptionEntitlementProvider;
  /** Absent = receipts are not configured on this host; `/receipts` answers 503. */
  readonly receipts?: HostedBillingReceiptSource;
  /** A server-owned collector/read composition; the request supplies no billing facts. */
  readonly usage?: HostedBillingUsageSource;
  readonly allocations?: HostedBillingAllocationSource;
  readonly allocationAdmin?: HostedBillingAllocationAdmin;
  readonly clock?: () => Date;
}

export interface HostedBillingRouteContext {
  readonly principal: HostedPrincipal | null;
}

export interface HostedBillingRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly auth: 'public' | { readonly capabilities: readonly HostedPermission[] };
  handler(req: Request, ctx: HostedBillingRouteContext): Promise<Response>;
}

function jsonError(code: string, safeMessage: string, status: number): Response {
  return Response.json({ ok: false, error: { code, safeMessage } }, { status });
}

/** Project only the public usage contract; provider payloads and extra fields never pass through. */
function usageView(statement: HostedUsageStatement): HostedUsageStatement {
  return {
    scope: { controlWorkspaceId: statement.scope.controlWorkspaceId, organizationId: statement.scope.organizationId,
      customerWorkspaceId: statement.scope.customerWorkspaceId },
    month: statement.month, currency: statement.currency, asOfMs: statement.asOfMs, sourceRef: statement.sourceRef,
    settlementEligible: statement.settlementEligible, gaps: [...statement.gaps],
    lines: statement.lines.map(line => ({
      customerWorkspaceId: line.customerWorkspaceId, provider: line.provider, category: line.category,
      payer: line.payer, unit: line.unit, quantity: line.quantity, usages: line.usages,
      unpricedUsages: line.unpricedUsages, estimatedMicros: line.estimatedMicros,
      reportedMicros: line.reportedMicros, billedMicros: line.billedMicros,
      ...(line.estimatedMicrosExact === undefined ? {} : { estimatedMicrosExact: line.estimatedMicrosExact }),
      ...(line.reportedMicrosExact === undefined ? {} : { reportedMicrosExact: line.reportedMicrosExact }),
      ...(line.billedMicrosExact === undefined ? {} : { billedMicrosExact: line.billedMicrosExact }),
    })),
    consumptionBilled: { micros: statement.consumptionBilled.micros, wholeCents: statement.consumptionBilled.wholeCents,
      roundingMicros: statement.consumptionBilled.roundingMicros,
      ...(statement.consumptionBilled.microsExact === undefined ? {} : { microsExact: statement.consumptionBilled.microsExact }),
      ...(statement.consumptionBilled.roundingMicrosExact === undefined ? {} : { roundingMicrosExact: statement.consumptionBilled.roundingMicrosExact }) },
    platformBilledMicros: statement.platformBilledMicros, customerDirectBilledMicros: statement.customerDirectBilledMicros,
    ...(statement.platformBilledMicrosExact === undefined ? {} : { platformBilledMicrosExact: statement.platformBilledMicrosExact }),
    ...(statement.customerDirectBilledMicrosExact === undefined ? {} : { customerDirectBilledMicrosExact: statement.customerDirectBilledMicrosExact }),
    forecast: { method: statement.forecast.method, basisMicros: statement.forecast.basisMicros,
      elapsedMs: statement.forecast.elapsedMs, periodMs: statement.forecast.periodMs,
      projectedConsumptionMicros: statement.forecast.projectedConsumptionMicros,
      provisional: statement.forecast.provisional, unavailableReason: statement.forecast.unavailableReason,
      ...(statement.forecast.basisMicrosExact === undefined ? {} : { basisMicrosExact: statement.forecast.basisMicrosExact }) },
    history: statement.history.map(history => ({ customerWorkspaceId: history.customerWorkspaceId,
      provider: history.provider, usageId: history.usageId, revisions: history.revisions.map(revision => ({
        recordId: revision.recordId, revision: revision.revision, sourceRef: revision.sourceRef,
        costSource: revision.costSource, costMicros: revision.costMicros, observedAtMs: revision.observedAtMs,
        ...(revision.costMicrosExact === undefined ? {} : { costMicrosExact: revision.costMicrosExact }),
      })) })),
  };
}

type ReportCostClassView = HostedAllocationReport['byCostClass'][HostedCostClass];

/** Copy the public contract at every level, including unknown measurements. */
function allocationFinanceView(finance: HostedBillingAllocationFinance): HostedBillingAllocationFinance {
  const measurement = (m: KnownOrUnknown<number>): KnownOrUnknown<number> =>
    'value' in m ? { value: m.value } : { unknownReason: m.unknownReason };
  const organization = { controlWorkspaceId: finance.organization.controlWorkspaceId,
    organizationId: finance.organization.organizationId };
  return { organization, asOfMs: finance.asOfMs,
    report: { month: finance.report.month,
      byCostClass: Object.fromEntries(HOSTED_COST_CLASSES.map((costClass): [HostedCostClass, ReportCostClassView] => {
        const c = finance.report.byCostClass[costClass]; const f = c.forecast;
        return [costClass, { committedMicros: c.committedMicros, unreconciledMicros: c.unreconciledMicros,
          providerFinalMicros: c.providerFinalMicros,
          allocations: c.allocations.map(a => ({ allocationId: a.allocationId, parentAllocationId: a.parentAllocationId,
            level: a.level, capMicros: a.capMicros, maxUnreconciledMicros: a.maxUnreconciledMicros,
            committedMicros: a.committedMicros, unreconciledMicros: a.unreconciledMicros,
            providerFinalMicros: a.providerFinalMicros, availableMicros: a.availableMicros, openHolds: a.openHolds })),
          ...(f ? { forecast: { method: f.method, basisMicros: f.basisMicros,
            ...(f.basisMicrosExact === undefined ? {} : { basisMicrosExact: f.basisMicrosExact }),
            elapsedMs: f.elapsedMs, periodMs: f.periodMs, projectedConsumptionMicros: f.projectedConsumptionMicros,
            provisional: f.provisional, unavailableReason: f.unavailableReason, scope: f.scope, evidenceRef: f.evidenceRef } } : {}),
        }];
      })) as HostedAllocationReport['byCostClass'],
      outcomes: finance.report.outcomes.map(o => ({ allocationId: o.allocationId, outcomes: o.outcomes,
        byState: { accepted: o.byState.accepted, rejected: o.byState.rejected,
          'rework-requested': o.byState['rework-requested'], unknown: o.byState.unknown },
        evidenceClasses: [...o.evidenceClasses], acceptedResultCostMicros: o.acceptedResultCostMicros,
        acceptedWithUnknownCost: o.acceptedWithUnknownCost, costPerAcceptedOutcomeMicros: o.costPerAcceptedOutcomeMicros,
        costPerAcceptedUnknownReason: o.costPerAcceptedUnknownReason, reviewEffortKnownSeconds: o.reviewEffortKnownSeconds,
        reviewEffortUnknown: o.reviewEffortUnknown, reworkKnownTotal: o.reworkKnownTotal, reworkUnknown: o.reworkUnknown })),
    },
    accounting: { organization: { ...organization }, month: finance.accounting.month, currency: finance.accounting.currency,
      byCostClass: Object.fromEntries(HOSTED_COST_CLASSES.map(costClass => {
        const c = finance.accounting.byCostClass[costClass];
        return [costClass, { reservations: c.reservations, pendingProviderFinal: c.pendingProviderFinal,
          committedMicros: c.committedMicros, unreconciledMicros: c.unreconciledMicros, providerFinalMicros: c.providerFinalMicros }];
      })) as HostedAllocationAccountingExport['byCostClass'],
      rows: finance.accounting.rows.map(r => ({ reservationId: r.reservationId, allocationId: r.allocationId,
        allocationPath: [...r.allocationPath], costClass: r.costClass, revision: r.revision, observedAtMs: r.observedAtMs,
        costSource: r.costSource, maximumCostMicros: r.maximumCostMicros,
        observedCostMicros: measurement(r.observedCostMicros), providerFinalCostMicros: measurement(r.providerFinalCostMicros),
        committedMicros: r.committedMicros, unreconciledMicros: r.unreconciledMicros, outcomeIds: [...r.outcomeIds] })),
      outcomes: finance.accounting.outcomes.map(o => ({ outcomeId: o.outcomeId, revision: o.revision,
        allocationId: o.allocationId, workflowRef: o.workflowRef, evidenceClass: o.evidenceClass,
        resultState: o.resultState, resultUnknownReason: o.resultUnknownReason, reservationIds: [...o.reservationIds],
        resultCostMicros: measurement(o.resultCostMicros), reviewEffortSeconds: measurement(o.reviewEffortSeconds),
        reworkCount: measurement(o.reworkCount) })),
      gaps: finance.accounting.gaps.map(g => ({ kind: g.kind, ref: g.ref, reason: g.reason })),
    },
  };
}

export function createHostedBillingRoutes(deps: HostedBillingRouteDependencies): readonly HostedBillingRoute[] {
  const origin = new URL(deps.publicOrigin).origin;
  const clock = deps.clock ?? (() => new Date());
  const observe = deps.observeFailure ?? logHostedBillingFailure;
  const planByKey = new Map(deps.plans.map((plan) => [plan.planKey, plan]));
  const planKeyForPrice = (priceId: string | null): string | null =>
    (priceId ? deps.plans.find((plan) => plan.priceId === priceId)?.planKey : null) ?? null;
  const unavailable = () =>
    jsonError('billing_unavailable', deps.unavailableReason ?? 'billing_not_configured', 503);
  const sameOrigin = (req: Request) => req.headers.get('origin') === origin;
  const organizationOf = (ctx: HostedBillingRouteContext): string | null => ctx.principal?.activeOrganizationId ?? null;

  const plans: HostedBillingRoute = {
    method: 'GET',
    path: '/hosted/billing/plans',
    auth: 'public',
    async handler() {
      return Response.json({
        ok: true,
        configured: deps.stripe !== null,
        livemode: deps.stripe?.client.livemode ?? false,
        unavailableReason: deps.stripe ? null : deps.unavailableReason ?? 'billing_not_configured',
        plans: deps.plans.map(({ planKey, label, description }) => ({ planKey, label, description })),
      });
    },
  };

  const subscription: HostedBillingRoute = {
    method: 'GET',
    path: '/hosted/billing/subscription',
    auth: { capabilities: ['workspace:view'] },
    async handler(_req, ctx) {
      const organizationId = organizationOf(ctx);
      if (!organizationId) return jsonError('organization_required', 'An active organization is required.', 403);
      let snapshot;
      try {
        snapshot = await deps.store.currentSubscription(organizationId, planKeyForPrice);
      } catch {
        return jsonError('billing_store_unavailable', 'Billing state could not be read.', 503);
      }
      const entitlement = await resolveHostedSubscriptionEntitlement(snapshot, {
        provider: deps.entitlementProvider,
        now: clock(),
      });
      return Response.json({
        ok: true,
        configured: deps.stripe !== null,
        canManage: ctx.principal?.capabilities.has('billing:manage') === true,
        subscription: snapshot && {
          status: snapshot.status,
          planKey: snapshot.planKey,
          planLabel: snapshot.planKey ? planByKey.get(snapshot.planKey)?.label ?? null : null,
          currentPeriodEnd: snapshot.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
          canceledAt: snapshot.canceledAt?.toISOString() ?? null,
          livemode: snapshot.livemode,
          latestInvoiceStatus: snapshot.latestInvoiceStatus,
        },
        entitlement,
      });
    },
  };

  const checkout: HostedBillingRoute = {
    method: 'POST',
    path: '/hosted/billing/checkout',
    auth: { capabilities: ['billing:manage'] },
    async handler(req, ctx) {
      if (!sameOrigin(req)) return jsonError('cross_origin_blocked', 'The request origin is not allowed.', 403);
      if (!deps.stripe) return unavailable();
      const organizationId = organizationOf(ctx);
      if (!organizationId) return jsonError('organization_required', 'An active organization is required.', 403);
      const body = await req.json().catch(() => null) as { planKey?: unknown } | null;
      const plan = typeof body?.planKey === 'string' ? planByKey.get(body.planKey) : undefined;
      if (!plan) return jsonError('unknown_plan', 'The selected plan is not available.', 400);

      const { client } = deps.stripe;
      try {
        const current = await deps.store.currentSubscription(organizationId, planKeyForPrice);
        if (current && SUBSCRIBED_STATUSES.has(current.status)) {
          return jsonError('already_subscribed', 'This organization already has a subscription; manage it instead.', 409);
        }
        let customer = await deps.store.customerFor(organizationId);
        if (!customer) {
          const created = await client.createCustomer({ organizationId });
          if (!created.ok) return jsonError('provider_error', 'Stripe could not create the billing customer.', 502);
          customer = await deps.store.recordCustomer({
            organizationId,
            stripeCustomerId: created.customerId,
            livemode: client.livemode,
          });
        }
        if (customer.livemode !== client.livemode) {
          return jsonError('customer_mode_mismatch', 'The billing customer belongs to the other Stripe mode.', 409);
        }
        // A double-click inside the same 10-minute window returns the SAME
        // Checkout Session (Stripe idempotency), never a second one.
        const window = Math.floor(clock().getTime() / 600_000);
        const session = await client.createSubscriptionCheckout({
          customerId: customer.stripeCustomerId,
          organizationId,
          priceId: plan.priceId,
          successUrl: `${origin}${HOSTED_BILLING_RETURN_PATH}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}${HOSTED_BILLING_RETURN_PATH}?checkout=canceled`,
          idempotencyKey: `papercusp-sub-checkout:${organizationId}:${plan.planKey}:${window}`,
        });
        if (!session.ok) return jsonError('provider_error', 'Stripe could not start checkout.', 502);
        return Response.json({ ok: true, url: session.url });
      } catch {
        return jsonError('billing_store_unavailable', 'Billing state could not be read.', 503);
      }
    },
  };

  const portal: HostedBillingRoute = {
    method: 'POST',
    path: '/hosted/billing/portal',
    auth: { capabilities: ['billing:manage'] },
    async handler(req, ctx) {
      if (!sameOrigin(req)) return jsonError('cross_origin_blocked', 'The request origin is not allowed.', 403);
      if (!deps.stripe) return unavailable();
      const organizationId = organizationOf(ctx);
      if (!organizationId) return jsonError('organization_required', 'An active organization is required.', 403);
      let customer;
      try {
        customer = await deps.store.customerFor(organizationId);
      } catch {
        return jsonError('billing_store_unavailable', 'Billing state could not be read.', 503);
      }
      if (!customer) return jsonError('no_billing_customer', 'This organization has no billing account yet.', 409);
      const session = await deps.stripe.client.createPortalSession({
        customerId: customer.stripeCustomerId,
        returnUrl: `${origin}${HOSTED_BILLING_RETURN_PATH}`,
        configurationId: deps.stripe.portalConfigurationId ?? null,
      });
      if (!session.ok) return jsonError('provider_error', 'Stripe could not open the billing portal.', 502);
      return Response.json({ ok: true, url: session.url });
    },
  };

  const receipts: HostedBillingRoute = {
    method: 'GET',
    path: '/hosted/billing/receipts',
    auth: { capabilities: ['billing:manage'] },
    async handler(_req, ctx) {
      const organizationId = organizationOf(ctx);
      if (!organizationId) return jsonError('organization_required', 'An active organization is required.', 403);
      if (!deps.receipts) return jsonError('receipts_unavailable', 'Payment receipts are not configured on this host.', 503);
      let customer;
      try {
        customer = await deps.store.customerFor(organizationId);
      } catch {
        return jsonError('billing_store_unavailable', 'Billing state could not be read.', 503);
      }
      // No billing customer yet means nothing was ever paid: an empty list, not an error.
      if (!customer) return Response.json({ ok: true, receipts: [] });
      let entries;
      try {
        entries = await deps.receipts(customer.stripeCustomerId);
      } catch {
        return jsonError('receipts_unavailable', 'Payment receipts could not be read.', 503);
      }
      return Response.json({ ok: true, receipts: entries.map(hostedBillingReceiptView) });
    },
  };

  const webhook: HostedBillingRoute = {
    method: 'POST',
    path: '/hosted/billing/webhook',
    auth: 'public',
    async handler(req) {
      if (!deps.stripe) return unavailable();
      const rawBody = await req.text();
      const verdict = createStripeAdapter({ webhookSecret: deps.stripe.webhookSecret }).verifySignature({
        rawBody,
        headers: Object.fromEntries(req.headers),
        nowMs: clock().getTime(),
      });
      // Unauthenticated deliveries are refused before parsing and never recorded.
      if (!verdict.ok) return jsonError(verdict.code, 'The webhook signature is not valid.', 400);
      const bodyDigest = webhookBodyDigest(rawBody);
      const parsed = parseHostedBillingEvent(rawBody);
      try {
        if (!parsed.ok) {
          if (!parsed.eventId || !parsed.eventType || parsed.livemode === null) {
            await observeHostedBillingFailure(observe, 'permanent-rejection', parsed.eventId);
            return jsonError(parsed.code, 'The webhook body is not a Stripe event.', 400);
          }
          const recorded = await deps.store.recordRejectedEvent({
            eventId: parsed.eventId,
            eventType: parsed.eventType,
            bodyDigest,
            livemode: parsed.livemode,
            code: parsed.code,
          });
          if (recorded === 'replay-mismatch') {
            await observeHostedBillingFailure(observe, 'replay-mismatch', parsed.eventId);
            return jsonError('replay-mismatch', 'The event id was already received with different bytes.', 409);
          }
          await observeHostedBillingFailure(observe, 'permanent-rejection', parsed.eventId);
          // A permanent content refusal is acknowledged (2xx) so Stripe does not retry it for days.
          return Response.json({ ok: true, outcome: recorded === 'duplicate' ? 'duplicate' : 'rejected', code: parsed.code });
        }
        const result = await deps.store.applyEvent({
          event: parsed.event,
          bodyDigest,
          expectedLivemode: deps.stripe.client.livemode,
          planKeyForPrice,
        });
        if (result.outcome === 'replay-mismatch') {
          await observeHostedBillingFailure(observe, 'replay-mismatch', parsed.event.eventId);
          return jsonError('replay-mismatch', 'The event id was already received with different bytes.', 409);
        }
        if (result.outcome === 'rejected') await observeHostedBillingFailure(observe, 'permanent-rejection', parsed.event.eventId);
        return Response.json({ ok: true, outcome: result.outcome, ...(result.outcome === 'rejected' ? { code: result.code } : {}) });
      } catch {
        // Transient: a non-2xx makes Stripe redeliver, and the transaction left no partial state.
        await observeHostedBillingFailure(observe, 'endpoint-store-unavailable', parsed.ok ? parsed.event.eventId : parsed.eventId);
        return jsonError('billing_store_unavailable', 'The event could not be recorded.', 503);
      }
    },
  };

  const usage: HostedBillingRoute = {
    method: 'GET', path: '/hosted/billing/usage', auth: { capabilities: ['billing:manage'] },
    async handler(req, ctx) {
      const organizationId = organizationOf(ctx);
      if (!organizationId || !ctx.principal) return jsonError('organization_required', 'An active organization is required.', 403);
      const parameters = new URL(req.url).searchParams;
      const allocations = parameters.get('view') === 'allocations';
      if ((parameters.has('view') && !allocations)
          || [...parameters.keys()].some(key => !(allocations ? ['month', 'view'] : ['month', 'workspaceId']).includes(key))
          || parameters.getAll('view').length > 1
          || parameters.getAll('month').length > 1 || parameters.getAll('workspaceId').length > 1) {
        return jsonError('invalid_usage_filter', 'Choose one month and an optional workspace.', 400);
      }
      const now = clock().getTime();
      if (!Number.isSafeInteger(now) || now < 0) return jsonError('usage_unavailable', 'Usage could not be read.', 503);
      const month = parameters.get('month') ?? new Date(now).toISOString().slice(0, 7);
      const customerWorkspaceId = parameters.get('workspaceId');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
          || (customerWorkspaceId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(customerWorkspaceId))) {
        return jsonError('invalid_usage_filter', 'Choose a valid month and workspace.', 400);
      }
      if (allocations) {
        if (!deps.allocations) return jsonError('usage_unavailable', 'Usage is not configured.', 503);
        const organization = Object.freeze({ controlWorkspaceId: ctx.principal.workspaceId, organizationId });
        try {
          const finance = await deps.allocations(Object.freeze({ organization, month, asOfMs: now }));
          if (finance.organization.controlWorkspaceId !== organization.controlWorkspaceId
              || finance.organization.organizationId !== organizationId || finance.asOfMs !== now
              || finance.report.month !== month || finance.accounting.month !== month
              || finance.accounting.organization.controlWorkspaceId !== organization.controlWorkspaceId
              || finance.accounting.organization.organizationId !== organizationId
              || HOSTED_COST_CLASSES.some(c => finance.report.byCostClass[c].forecast?.scope !== 'recorded-allocation-costs')) {
            return jsonError('usage_unavailable', 'Usage could not be read.', 503);
          }
          return Response.json({ ok: true, allocations: allocationFinanceView(finance) },
            { headers: { 'cache-control': 'no-store' } });
        } catch {
          return jsonError('usage_unavailable', 'Usage could not be read.', 503);
        }
      }
      if (!deps.usage) return jsonError('usage_unavailable', 'Usage is not configured.', 503);
      const scope = Object.freeze({ controlWorkspaceId: ctx.principal.workspaceId, organizationId, customerWorkspaceId });
      try {
        const statement = await deps.usage(Object.freeze({ scope, month, asOfMs: now }));
        if (statement.scope.controlWorkspaceId !== scope.controlWorkspaceId || statement.scope.organizationId !== organizationId
            || statement.scope.customerWorkspaceId !== customerWorkspaceId || statement.month !== month || statement.asOfMs !== now
            || (customerWorkspaceId !== null && [...statement.lines, ...statement.history].some(line => line.customerWorkspaceId !== customerWorkspaceId))) {
          return jsonError('usage_unavailable', 'Usage could not be read.', 503);
        }
        return Response.json({ ok: true, statement: usageView(statement) }, { headers: { 'cache-control': 'no-store' } });
      } catch {
        return jsonError('usage_unavailable', 'Usage could not be read.', 503);
      }
    },
  };

  const allocationAdmin: HostedBillingRoute = {
    method: 'POST', path: '/hosted/billing/usage', auth: { capabilities: ['billing:manage'] },
    async handler(req, ctx) {
      if (!sameOrigin(req)) return jsonError('cross_origin_blocked', 'The request origin is not allowed.', 403);
      const organizationId = organizationOf(ctx);
      if (!organizationId || !ctx.principal) return jsonError('organization_required', 'An active organization is required.', 403);
      const parameters = new URL(req.url).searchParams;
      if (parameters.size !== 1 || parameters.get('view') !== 'allocations') {
        return jsonError('invalid_allocation', 'Choose the allocation view.', 400);
      }
      if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return jsonError('invalid_allocation', 'Send an allocation as JSON.', 400);
      }
      const body: unknown = await req.json().catch(() => null);
      const keys = ['allocationId', 'parentAllocationId', 'level', 'costClass', 'month', 'capMicros', 'maxUnreconciledMicros'];
      const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== keys.length || Object.keys(body).some(key => !keys.includes(key))) {
        return jsonError('invalid_allocation', 'Send only the allocation fields.', 400);
      }
      const b = body as Record<string, unknown>;
      if (!id(b.allocationId) || !(b.parentAllocationId === null || id(b.parentAllocationId))
          || !['organization', 'department', 'project'].includes(b.level as string)
          || !HOSTED_COST_CLASSES.includes(b.costClass as HostedCostClass)
          || typeof b.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month)
          || !Number.isSafeInteger(b.capMicros) || (b.capMicros as number) < 0
          || !Number.isSafeInteger(b.maxUnreconciledMicros) || (b.maxUnreconciledMicros as number) < 0
          || (b.maxUnreconciledMicros as number) > (b.capMicros as number)
          || (b.level === 'organization') !== (b.parentAllocationId === null)
          || b.parentAllocationId === b.allocationId) {
        return jsonError('invalid_allocation', 'Choose valid allocation limits and hierarchy.', 400);
      }
      if (!deps.allocationAdmin) return jsonError('usage_unavailable', 'Allocation limits are not configured.', 503);
      const organization = Object.freeze({ controlWorkspaceId: ctx.principal.workspaceId, organizationId });
      const input: HostedAllocationRequest = Object.freeze({ organization, allocationId: b.allocationId,
        parentAllocationId: b.parentAllocationId as string | null, level: b.level as HostedAllocationRequest['level'],
        costClass: b.costClass as HostedCostClass, month: b.month, capMicros: b.capMicros as number,
        maxUnreconciledMicros: b.maxUnreconciledMicros as number, recordedBy: ctx.principal.userId,
        evidenceRef: `hosted-billing-allocation:${randomUUID()}` });
      try {
        const reply = await deps.allocationAdmin(input);
        if (reply.organization.controlWorkspaceId !== organization.controlWorkspaceId
            || reply.organization.organizationId !== organizationId) throw new Error('allocation scope mismatch');
        const r = reply.result;
        if (r.outcome === 'conflict' || r.outcome === 'refused') {
          const reasons = ['immutable-allocation-fields', 'organization-root-exists', 'parent-missing', 'level-order',
            'children-exceed-parent', 'cap-below-children', 'cap-below-committed'];
          if (!reasons.includes(r.reason)) throw new Error('unknown allocation refusal');
          return jsonError('allocation_refused', r.reason, 409);
        }
        if (!['created', 'revised', 'duplicate'].includes(r.outcome)) throw new Error('unknown allocation result');
        const a = r.allocation;
        if (!a || a.allocationId !== input.allocationId || a.parentAllocationId !== input.parentAllocationId
            || a.level !== input.level || a.costClass !== input.costClass || a.month !== input.month
            || a.capMicros !== input.capMicros || a.maxUnreconciledMicros !== input.maxUnreconciledMicros
            || !Number.isSafeInteger(a.revision) || a.revision < 1) throw new Error('allocation binding mismatch');
        return Response.json({ ok: true, outcome: r.outcome, allocation: { allocationId: a.allocationId,
          parentAllocationId: a.parentAllocationId, level: a.level, costClass: a.costClass, month: a.month,
          capMicros: a.capMicros, maxUnreconciledMicros: a.maxUnreconciledMicros, revision: a.revision } },
        { headers: { 'cache-control': 'no-store' } });
      } catch {
        return jsonError('usage_unavailable', 'Allocation limits could not be saved.', 503);
      }
    },
  };

  return [plans, subscription, checkout, portal, receipts, usage, allocationAdmin, webhook];
}
