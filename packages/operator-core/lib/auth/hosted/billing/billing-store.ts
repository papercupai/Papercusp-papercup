/**
 * Postgres store for hosted subscription billing (migration 1276), run in the
 * hosted-service context.
 *
 * Webhook application is ONE transaction: the idempotency row and every fact
 * it carries commit or roll back together, so a crash between "recorded" and
 * "applied" cannot strand an event as a false duplicate (the cupboard
 * `webhook-inbox.ts` records before applying; only its digest/replay semantics
 * are reused here).
 *
 * Subscription facts are order-independent max-registers: see
 * `subscriptionOrderKey` (stripe-billing-events.ts) — the SQL row comparison
 * below is the same lexicographic order, with event ids compared under the "C"
 * collation so JavaScript and Postgres agree byte-for-byte.
 *
 * stripe-subscription-signup-2026-10-01 P-003.
 */
import { withHostedServiceContext } from '@papercusp/db-org';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { appendOrganizationAuditEvent } from '../governance';
import { isHostedSubscriptionStatus, parseHostedPaidEntitlementBundle, type HostedSubscriptionEntitlementProvider, type HostedSubscriptionSnapshot } from './entitlement-seam';
import { lockHostedEntitlementAuthority, writeHostedEntitlementAuthority, type HostedEntitlementAuthorityRecords } from '../../hosted-entitlement-store';
import { parseHostedEntitlementAssignment, parseHostedEntitlementBundle, parseHostedEntitlementOverride } from '../../hosted-entitlement-schema';
import { subscriptionOrderKey, type HostedBillingEvent, type HostedBillingFact } from './stripe-billing-events';
import type { StripeBillingEventPageEvidence } from './stripe-billing-client';
import type { HostedBillingRecoveryTarget, HostedBillingDeliveryIssue } from './billing-recovery';

export interface HostedBillingCustomer {
  readonly organizationId: string;
  readonly stripeCustomerId: string;
  readonly livemode: boolean;
}

export type HostedBillingApplyOutcome =
  | { readonly outcome: 'applied' | 'ignored'; readonly organizationId: string | null }
  | { readonly outcome: 'duplicate'; readonly organizationId: string | null }
  | { readonly outcome: 'replay-mismatch' }
  | {
    readonly outcome: 'rejected';
    readonly code: 'livemode_mismatch' | 'unknown_customer' | 'organization_mismatch';
    readonly organizationId: string | null;
  };

export interface HostedBillingStore {
  customerFor(organizationId: string): Promise<HostedBillingCustomer | null>;
  /** Insert-or-keep: returns the ONE customer row for the organization (an earlier winner is kept). */
  recordCustomer(customer: HostedBillingCustomer): Promise<HostedBillingCustomer>;
  currentSubscription(
    organizationId: string,
    planKeyForPrice: (priceId: string | null) => string | null,
  ): Promise<HostedSubscriptionSnapshot | null>;
  applyEvent(input: {
    event: HostedBillingEvent;
    bodyDigest: string;
    expectedLivemode: boolean;
    planKeyForPrice: (priceId: string | null) => string | null;
  }): Promise<HostedBillingApplyOutcome>;
  /** Record an authenticated delivery that could not be parsed into facts (so its retries are duplicates). */
  recordRejectedEvent(input: {
    eventId: string;
    eventType: string;
    bodyDigest: string;
    livemode: boolean;
    code: string;
  }): Promise<'recorded' | 'duplicate' | 'replay-mismatch'>;
}

class FactRejection extends Error {
  constructor(readonly code: 'unknown_customer' | 'organization_mismatch', readonly organizationId: string | null) {
    super(code);
  }
}

export interface HostedBillingReconciliationCheckpoint {
  readonly accountId: string;
  readonly customerId: string;
  readonly organizationId: string;
  readonly livemode: boolean;
  readonly createdFrom: number;
  readonly createdBefore: number;
  readonly startingAfter: string | null;
  readonly revision: number;
  readonly complete: boolean;
  readonly cursors: readonly string[];
}

/** Recovery is a server-only extension of the same billing transaction store. */
export interface HostedBillingRecoveryStore extends HostedBillingStore {
  reconciliationTargets(input: { expectedLivemode: boolean; limit: number }): Promise<HostedBillingRecoveryTarget[]>;
  deliveryIssues(input: { expectedLivemode: boolean; limit: number }): Promise<HostedBillingDeliveryIssue[]>;
  beginReconciliation(input: {
    organizationId: string; accountId: string; expectedLivemode: boolean;
    createdFrom: number; createdBefore: number;
  }): Promise<HostedBillingReconciliationCheckpoint>;
  applyReconciliationPage(input: {
    checkpoint: HostedBillingReconciliationCheckpoint;
    evidence: StripeBillingEventPageEvidence;
    planKeyForPrice: (priceId: string | null) => string | null;
  }): Promise<{ outcome: 'applied' | 'cursor-conflict'; checkpoint: HostedBillingReconciliationCheckpoint }>;
}

const commitment = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const factDigest = (event: HostedBillingEvent): string => commitment(event);
const validWindow = (from: number, before: number) => Number.isSafeInteger(from) && from >= 0
  && Number.isSafeInteger(before) && before > from && before <= 8_640_000_000_000;

function recoveryPageValid(page: StripeBillingEventPageEvidence, pin: HostedBillingReconciliationCheckpoint): boolean {
  if (page.source !== 'stripe-authenticated-api' || page.accountId !== pin.accountId || page.customerId !== pin.customerId
      || page.organizationId !== pin.organizationId || page.livemode !== pin.livemode
      || page.createdFrom !== pin.createdFrom || page.createdBefore !== pin.createdBefore
      || page.startingAfter !== pin.startingAfter || typeof page.hasMore !== 'boolean'
      || !Number.isSafeInteger(page.observedAtMs) || page.observedAtMs <= 0
      || !Array.isArray(page.requestIds) || page.requestIds.length !== 3 || page.requestIds.some(id => !/^req_[A-Za-z0-9]+$/.test(id))
      || !Array.isArray(page.observations) || page.observations.length > 100
      || (page.hasMore ? !page.nextCursor || !/^evt_[A-Za-z0-9]+$/.test(page.nextCursor)
        || page.nextCursor === pin.startingAfter || pin.cursors.includes(page.nextCursor) : page.nextCursor !== null)) return false;
  const { evidenceRef, ...selected } = page;
  if (evidenceRef !== `stripe-billing-page:${commitment(selected)}`) return false;
  const seen = new Set<string>(); let lastCreated = pin.createdBefore;
  for (const { event, apiObjectDigest } of page.observations) {
    const seconds = event.createdAt instanceof Date ? event.createdAt.getTime() / 1000 : NaN;
    if (!/^evt_[A-Za-z0-9]+$/.test(event.eventId) || event.eventId === pin.startingAfter || seen.has(event.eventId)
        || !/^[0-9a-f]{64}$/.test(apiObjectDigest) || event.livemode !== pin.livemode
        || !Number.isSafeInteger(seconds) || seconds < pin.createdFrom || seconds >= pin.createdBefore || seconds > lastCreated
        || !event.facts.length || event.facts.some((f: HostedBillingFact) => f.stripeCustomerId !== pin.customerId
          || (f.organizationId !== null && f.organizationId !== pin.organizationId))) return false;
    seen.add(event.eventId); lastCreated = seconds;
  }
  return true;
}

interface SubscriptionRow {
  stripe_subscription_id: string;
  organization_id: string;
  status: string;
  price_id: string | null;
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | string | null;
  livemode: boolean;
  latest_invoice_status: string | null;
}

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

export class PostgresHostedBillingStore implements HostedBillingRecoveryStore {
  constructor(private readonly run: HostedServiceContextRunner = (fn) => withHostedServiceContext(fn),
    private readonly entitlementProvider?: HostedSubscriptionEntitlementProvider) {}

  async reconciliationTargets(input: { expectedLivemode: boolean; limit: number }): Promise<HostedBillingRecoveryTarget[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('billing_recovery_invalid_limit');
    return this.run(async sql => {
      const rows = await sql<Array<{ organization_id: string; reconciliation_checkpoint: HostedBillingReconciliationCheckpoint | null }>>`
        SELECT organization_id::text, reconciliation_checkpoint FROM papercusp_auth.hosted_billing_customers
         WHERE livemode = ${input.expectedLivemode}
         ORDER BY (reconciliation_checkpoint->>'createdBefore')::bigint ASC NULLS FIRST, organization_id
         LIMIT ${input.limit}
      `;
      return rows.map(row => ({ organizationId: row.organization_id, checkpoint: row.reconciliation_checkpoint }));
    });
  }

  async deliveryIssues(input: { expectedLivemode: boolean; limit: number }): Promise<HostedBillingDeliveryIssue[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('billing_recovery_invalid_limit');
    return this.run(async sql => {
      const rows = await sql<Array<{ provider_event_id: string; outcome: string; rejection_code: string | null }>>`
        SELECT provider_event_id, outcome, rejection_code FROM papercusp_auth.hosted_billing_webhook_events
         WHERE livemode = ${input.expectedLivemode} AND (outcome = 'rejected' OR body_digest IS NULL)
         ORDER BY received_at, provider_event_id COLLATE "C" LIMIT ${input.limit}
      `;
      return rows.map(row => ({ eventId: row.provider_event_id,
        failureClass: row.outcome === 'rejected'
          ? row.rejection_code === 'unknown_customer' ? 'customer-unmapped' : 'permanent-rejection' : 'undelivered' }));
    });
  }

  async beginReconciliation(input: {
    organizationId: string; accountId: string; expectedLivemode: boolean; createdFrom: number; createdBefore: number;
  }): Promise<HostedBillingReconciliationCheckpoint> {
    const pin = { ...input };
    if (!/^acct_[A-Za-z0-9]+$/.test(pin.accountId) || !validWindow(pin.createdFrom, pin.createdBefore)) {
      throw new Error('billing_recovery_invalid_window');
    }
    return this.run(async sql => {
      const rows = await sql<Array<{ stripe_customer_id: string; livemode: boolean; reconciliation_checkpoint: HostedBillingReconciliationCheckpoint | null }>>`
        SELECT stripe_customer_id, livemode, reconciliation_checkpoint FROM papercusp_auth.hosted_billing_customers
         WHERE organization_id = ${pin.organizationId}::uuid FOR UPDATE
      `;
      const row = rows[0];
      if (!row || row.livemode !== pin.expectedLivemode) throw new Error('billing_recovery_customer_pin_mismatch');
      const prior = row.reconciliation_checkpoint;
      if (prior && prior.accountId !== pin.accountId) throw new Error('billing_recovery_account_pin_mismatch');
      // Resume the unfinished fixed window even if a later wake asks for a
      // newer one. Never silently abandon its tail after a crash.
      if (prior && (!prior.complete || (prior.createdFrom === pin.createdFrom && prior.createdBefore === pin.createdBefore))) return prior;
      if (prior && (pin.createdFrom > prior.createdBefore || pin.createdBefore <= prior.createdBefore)) {
        throw new Error('billing_recovery_window_gap');
      }
      const checkpoint: HostedBillingReconciliationCheckpoint = { accountId: pin.accountId,
        customerId: row.stripe_customer_id, organizationId: pin.organizationId, livemode: row.livemode,
        createdFrom: pin.createdFrom, createdBefore: pin.createdBefore, startingAfter: null,
        revision: (prior?.revision ?? 0) + 1, complete: false, cursors: [] };
      await sql`UPDATE papercusp_auth.hosted_billing_customers SET reconciliation_checkpoint = ${sql.json({ ...checkpoint, cursors: [...checkpoint.cursors] })}, updated_at = now()
        WHERE organization_id = ${pin.organizationId}::uuid`;
      return checkpoint;
    });
  }

  async applyReconciliationPage(input: {
    checkpoint: HostedBillingReconciliationCheckpoint; evidence: StripeBillingEventPageEvidence;
    planKeyForPrice: (priceId: string | null) => string | null;
  }): Promise<{ outcome: 'applied' | 'cursor-conflict'; checkpoint: HostedBillingReconciliationCheckpoint }> {
    // Snapshot Dates and arrays too: queued callers cannot switch scope.
    const pin = structuredClone(input.checkpoint); const page = structuredClone(input.evidence);
    const planKeyForPrice = input.planKeyForPrice;
    if (!recoveryPageValid(page, pin)) throw new Error('billing_recovery_invalid_page');
    return this.run(async sql => {
      // All billing writers take organization before customer/event/subscription
      // rows. Admission uses this same lock; webhook/recovery cannot deadlock by
      // taking the shared event receipt in the opposite order.
      await lockHostedEntitlementAuthority(sql, pin.organizationId);
      const rows = await sql<Array<{ stripe_customer_id: string; livemode: boolean; reconciliation_checkpoint: HostedBillingReconciliationCheckpoint | null }>>`
        SELECT stripe_customer_id, livemode, reconciliation_checkpoint FROM papercusp_auth.hosted_billing_customers
         WHERE organization_id = ${pin.organizationId}::uuid FOR UPDATE
      `;
      const row = rows[0]; const current = row?.reconciliation_checkpoint;
      if (!current || row?.stripe_customer_id !== page.customerId || row.livemode !== page.livemode) {
        throw new Error('billing_recovery_customer_pin_mismatch');
      }
      if (current.complete || current.revision !== pin.revision || current.accountId !== pin.accountId
          || current.createdFrom !== pin.createdFrom || current.createdBefore !== pin.createdBefore
          || current.startingAfter !== pin.startingAfter) return { outcome: 'cursor-conflict', checkpoint: current };
      // Recheck visited cursors from the authoritative row, not caller memory.
      if (!recoveryPageValid(page, current) || current.cursors.length >= 1000) throw new Error('billing_recovery_cursor_cycle_or_budget');
      for (const observation of [...page.observations].sort((a, b) => a.event.eventId < b.event.eventId ? -1 : 1)) {
        const { event, apiObjectDigest } = observation; const digest = factDigest(event);
        const provenance = { source: page.source, accountId: page.accountId, apiObjectDigest, factDigest: digest,
          observedAtMs: page.observedAtMs, requestIds: [...page.requestIds], evidenceRef: page.evidenceRef };
        await sql`INSERT INTO papercusp_auth.hosted_billing_webhook_events
          (provider_event_id, event_type, body_digest, livemode, outcome, organization_id, api_observation)
          VALUES (${event.eventId}, ${event.eventType}, NULL, ${event.livemode}, 'ignored', ${page.organizationId}::uuid, ${sql.json(provenance)})
          ON CONFLICT (provider_event_id) DO NOTHING`;
        const receipts = await sql<Array<{ event_type: string; livemode: boolean; outcome: string; rejection_code: string | null;
          organization_id: string | null; fact_digest: string | null; api_observation: typeof provenance | null }>>`
          SELECT event_type, livemode, outcome, rejection_code, organization_id::text AS organization_id, fact_digest, api_observation
            FROM papercusp_auth.hosted_billing_webhook_events WHERE provider_event_id = ${event.eventId} FOR UPDATE
        `;
        const receipt = receipts[0]!;
        if (receipt.event_type !== event.eventType || receipt.livemode !== event.livemode
            || (receipt.organization_id !== null && receipt.organization_id !== page.organizationId)
            || (receipt.fact_digest !== null && receipt.fact_digest !== digest)
            || (receipt.api_observation && (receipt.api_observation.accountId !== page.accountId
              || receipt.api_observation.apiObjectDigest !== apiObjectDigest || receipt.api_observation.factDigest !== digest))) {
          throw new Error('billing_recovery_event_mismatch');
        }
        // Only unknown-customer refusals become repairable once their real
        // mapping exists. Permanent parse/mode/tenant refusals stay refused.
        if (receipt.outcome === 'rejected' && receipt.rejection_code !== 'unknown_customer') {
          throw new Error('billing_recovery_permanent_rejection');
        }
        for (const fact of event.facts) await applyFact(sql, fact, event, planKeyForPrice, true);
        await sql`UPDATE papercusp_auth.hosted_billing_webhook_events SET api_observation = ${sql.json(provenance)}
          WHERE provider_event_id = ${event.eventId}`;
        await appendOrganizationAuditEvent({ organizationId: page.organizationId, actorKind: 'system', actorId: 'stripe',
          action: 'billing.event.reconciled', purpose: 'hosted_subscription_billing', targetType: 'billing_event', targetId: event.eventId,
          metadata: { providerEventId: event.eventId, source: page.source, accountId: page.accountId,
            apiObjectDigest, evidenceRef: page.evidenceRef, requestIds: [...page.requestIds] } }, sql);
      }
      const checkpoint: HostedBillingReconciliationCheckpoint = { ...current, startingAfter: page.nextCursor,
        revision: current.revision + 1, complete: !page.hasMore,
        cursors: page.nextCursor ? [...current.cursors, page.nextCursor] : current.cursors };
      await this.projectEntitlementAuthority(sql, pin.organizationId, planKeyForPrice, page.evidenceRef);
      await sql`UPDATE papercusp_auth.hosted_billing_customers SET reconciliation_checkpoint = ${sql.json({ ...checkpoint, cursors: [...checkpoint.cursors] })}, updated_at = now()
        WHERE organization_id = ${page.organizationId}::uuid`;
      return { outcome: 'applied', checkpoint };
    });
  }

  async customerFor(organizationId: string): Promise<HostedBillingCustomer | null> {
    return this.run(async (sql) => {
      const rows = await sql<Array<{ stripe_customer_id: string; livemode: boolean }>>`
        SELECT stripe_customer_id, livemode
          FROM papercusp_auth.hosted_billing_customers
         WHERE organization_id = ${organizationId}::uuid
      `;
      return rows[0] ? { organizationId, stripeCustomerId: rows[0].stripe_customer_id, livemode: rows[0].livemode } : null;
    });
  }

  async recordCustomer(customer: HostedBillingCustomer): Promise<HostedBillingCustomer> {
    return this.run(async (sql) => {
      const inserted = await sql`
        INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
        VALUES (${customer.organizationId}::uuid, ${customer.stripeCustomerId}, ${customer.livemode})
        ON CONFLICT (organization_id) DO NOTHING
        RETURNING organization_id
      `;
      const rows = await sql<Array<{ stripe_customer_id: string; livemode: boolean }>>`
        SELECT stripe_customer_id, livemode
          FROM papercusp_auth.hosted_billing_customers
         WHERE organization_id = ${customer.organizationId}::uuid
      `;
      if (!rows[0]) throw new Error('hosted_billing_customer_unavailable');
      if (inserted.length) {
        await appendOrganizationAuditEvent({
          organizationId: customer.organizationId, actorKind: 'system', actorId: 'hosted-billing',
          action: 'billing.customer.linked', purpose: 'hosted_subscription_billing',
          targetType: 'billing_customer', targetId: rows[0].stripe_customer_id,
          metadata: { livemode: rows[0].livemode },
        }, sql);
      }
      return { organizationId: customer.organizationId, stripeCustomerId: rows[0].stripe_customer_id, livemode: rows[0].livemode };
    });
  }

  async currentSubscription(
    organizationId: string,
    planKeyForPrice: (priceId: string | null) => string | null,
  ): Promise<HostedSubscriptionSnapshot | null> {
    return this.run(sql => currentSubscription(sql, organizationId, planKeyForPrice));
  }

  private async projectEntitlementAuthority(sql: Sql, organizationId: string,
    planKeyForPrice: (priceId: string | null) => string | null, evidenceRef: string): Promise<void> {
    if (!this.entitlementProvider?.resourceBundleFor) return;
    await lockHostedEntitlementAuthority(sql, organizationId);
    const now = new Date();
    const snapshot = await currentSubscription(sql, organizationId, planKeyForPrice);
    const selected = this.entitlementProvider.resourceBundleFor(snapshot, now);
    const bundle = selected === null ? null : parseHostedPaidEntitlementBundle(selected);
    const rows = await sql<Array<{ user_id: string; kind: string; authority: HostedEntitlementAuthorityRecords | null; authority_revision: string | number }>>`
      SELECT user_id::text, kind, authority, authority_revision FROM papercusp_auth.hosted_entitlements
       WHERE organization_id = ${organizationId}::uuid ORDER BY user_id, kind FOR UPDATE`;
    const authorities = rows.filter(row => row.authority !== null);
    const candidates = authorities.length ? authorities : rows.filter(row => row.kind === 'hosted-free');
    if (candidates.length !== 1) {
      if (!bundle && !authorities.length) return;
      throw new Error('hosted_billing_entitlement_grant_ambiguous_or_missing');
    }
    const grant = candidates[0]!; const prior = grant.authority;
    if (prior && (prior.schemaVersion !== 1 || !Array.isArray(prior.bundles) ||
        !Array.isArray(prior.assignments) || !Array.isArray(prior.overrides))) throw new Error('hosted_billing_prior_authority_invalid');
    const bundles = (prior?.bundles ?? []).map(value => {
      const parsed = parseHostedEntitlementBundle(value); if (!parsed.ok) throw new Error('hosted_billing_prior_authority_invalid'); return parsed.value;
    });
    const assignments = (prior?.assignments ?? []).map(value => {
      const parsed = parseHostedEntitlementAssignment(value);
      if (!parsed.ok || parsed.value.organizationId !== organizationId) throw new Error('hosted_billing_prior_authority_invalid'); return parsed.value;
    });
    const overrides = (prior?.overrides ?? []).map(value => {
      const parsed = parseHostedEntitlementOverride(value);
      if (!parsed.ok || parsed.value.organizationId !== organizationId) throw new Error('hosted_billing_prior_authority_invalid'); return parsed.value;
    });
    if (!bundle && !assignments.some(row => row.record.source === 'billing')) return;
    const until = bundle && snapshot?.currentPeriodEnd
      ? Math.min(snapshot.currentPeriodEnd.getTime(), bundle.record.effectiveUntil?.getTime() ?? Infinity) : null;
    if (bundle && (!until || until <= now.getTime() || bundle.record.effectiveFrom > now)) throw new Error('hosted_billing_policy_inactive');
    const fingerprint = bundle ? `billing:${commitment([snapshot!.stripeSubscriptionId, snapshot!.priceId, bundle.bundleId, bundle.bundleVersion, until])}:` : null;
    const active = assignments.filter(row => row.record.effectiveFrom <= now && (!row.record.effectiveUntil || row.record.effectiveUntil > now));
    if (bundle) {
      const pinned = bundles.find(row => row.bundleId === bundle.bundleId && row.bundleVersion === bundle.bundleVersion);
      if (pinned && !isDeepStrictEqual(pinned, bundle)) throw new Error('hosted_billing_bundle_version_reused');
      if (active.length === 1 && active[0]!.assignmentId.startsWith(fingerprint!)) return;
      if (!pinned) bundles.push(bundle);
    } else if (!active.length) return;
    // A not-yet-effective/same-tick assignment has no elapsed interval to retain;
    // its previous bytes remain in the organization audit transition below.
    const end = <T extends { record: { effectiveFrom: Date; effectiveUntil: Date | null } }>(rows: T[]): T[] => rows
      .filter(row => row.record.effectiveFrom < now)
      .map(row => row.record.effectiveUntil && row.record.effectiveUntil <= now ? row
        : { ...row, record: { ...row.record, effectiveUntil: now } });
    const nextAssignments = end(assignments);
    if (bundle) nextAssignments.push({ schemaVersion: 1, assignmentId: `${fingerprint}${Number(grant.authority_revision) + 1}`,
      organizationId, bundleId: bundle.bundleId, bundleVersion: bundle.bundleVersion,
      record: { source: 'billing', actor: bundle.record.actor, auditReceiptId: evidenceRef,
        effectiveFrom: now, effectiveUntil: new Date(until!) } });
    const authority: HostedEntitlementAuthorityRecords = { schemaVersion: 1, bundles, assignments: nextAssignments, overrides: end(overrides) };
    const revision = await writeHostedEntitlementAuthority({ organizationId, userId: grant.user_id, kind: grant.kind,
      expectedRevision: Number(grant.authority_revision), authority }, async fn => fn(sql));
    await appendOrganizationAuditEvent({ organizationId, actorKind: 'system', actorId: 'hosted-billing',
      action: 'billing.entitlement.projected', purpose: 'hosted_subscription_billing', targetType: 'hosted_entitlement', targetId: grant.user_id,
      metadata: { evidenceRef, revision, priorAuthorityJson: prior ? JSON.stringify(prior) : null, bundleId: bundle?.bundleId ?? null,
        bundleVersion: bundle?.bundleVersion ?? null, subscriptionId: snapshot?.stripeSubscriptionId ?? null } }, sql);
  }

  async recordRejectedEvent(input: {
    eventId: string;
    eventType: string;
    bodyDigest: string;
    livemode: boolean;
    code: string;
  }): Promise<'recorded' | 'duplicate' | 'replay-mismatch'> {
    return this.run(async (sql) => {
      const inserted = await sql`
        INSERT INTO papercusp_auth.hosted_billing_webhook_events
          (provider_event_id, event_type, body_digest, livemode, outcome, rejection_code)
        VALUES (${input.eventId}, ${input.eventType}, ${input.bodyDigest}, ${input.livemode}, 'rejected', ${input.code})
        ON CONFLICT (provider_event_id) DO UPDATE SET body_digest = EXCLUDED.body_digest,
          outcome = EXCLUDED.outcome, rejection_code = EXCLUDED.rejection_code, received_at = now()
        WHERE hosted_billing_webhook_events.body_digest IS NULL
          AND hosted_billing_webhook_events.event_type = EXCLUDED.event_type
          AND hosted_billing_webhook_events.livemode = EXCLUDED.livemode
        RETURNING provider_event_id
      `;
      if (inserted.length) return 'recorded';
      return (await priorDigest(sql, input.eventId)) === input.bodyDigest ? 'duplicate' : 'replay-mismatch';
    });
  }

  async applyEvent(input: {
    event: HostedBillingEvent;
    bodyDigest: string;
    expectedLivemode: boolean;
    planKeyForPrice: (priceId: string | null) => string | null;
  }): Promise<HostedBillingApplyOutcome> {
    const { event, bodyDigest } = input;
    try {
      return await this.run(async (sql) => {
        const organizationsToLock = new Set<string>();
        for (const fact of event.facts) {
          const mapped = await organizationForCustomer(sql, fact.stripeCustomerId);
          if (mapped) organizationsToLock.add(mapped);
        }
        for (const id of [...organizationsToLock].sort()) await lockHostedEntitlementAuthority(sql, id);
        // Claim the event id after organization serialization. A duplicate blocks on the primary
        // key until this transaction ends, then sees the committed row.
        const claimed = await sql`
          INSERT INTO papercusp_auth.hosted_billing_webhook_events
            (provider_event_id, event_type, body_digest, fact_digest, livemode, outcome)
          VALUES (${event.eventId}, ${event.eventType}, ${bodyDigest}, ${factDigest(event)}, ${event.livemode}, 'ignored')
          ON CONFLICT (provider_event_id) DO UPDATE SET body_digest = EXCLUDED.body_digest,
            fact_digest = EXCLUDED.fact_digest, received_at = now()
          WHERE hosted_billing_webhook_events.body_digest IS NULL
            AND hosted_billing_webhook_events.event_type = EXCLUDED.event_type
            AND hosted_billing_webhook_events.livemode = EXCLUDED.livemode
            AND (hosted_billing_webhook_events.api_observation IS NULL
              OR hosted_billing_webhook_events.api_observation->>'factDigest' = EXCLUDED.fact_digest)
          RETURNING provider_event_id
        `;
        if (!claimed.length) {
          const prior = await sql<Array<{ body_digest: string; organization_id: string | null }>>`
            SELECT body_digest, organization_id::text AS organization_id
              FROM papercusp_auth.hosted_billing_webhook_events
             WHERE provider_event_id = ${event.eventId}
          `;
          if (prior[0]?.body_digest !== bodyDigest) return { outcome: 'replay-mismatch' };
          return { outcome: 'duplicate', organizationId: prior[0]?.organization_id ?? null };
        }

        if (event.livemode !== input.expectedLivemode) {
          await markRejected(sql, event.eventId, 'livemode_mismatch', null);
          return { outcome: 'rejected', code: 'livemode_mismatch', organizationId: null };
        }
        if (event.facts.length === 0) return { outcome: 'ignored', organizationId: null };

        let organizationId: string | null = null;
        const organizations = new Set<string>();
        for (const fact of event.facts) {
          organizationId = await applyFact(sql, fact, event, input.planKeyForPrice);
          organizations.add(organizationId);
        }
        await sql`
          UPDATE papercusp_auth.hosted_billing_webhook_events
             SET outcome = 'applied', organization_id = ${organizationId}::uuid
           WHERE provider_event_id = ${event.eventId}
        `;
        for (const organization of organizations) {
          await this.projectEntitlementAuthority(sql, organization, input.planKeyForPrice, `stripe-event:${event.eventId}`);
          await appendOrganizationAuditEvent({
            organizationId: organization, actorKind: 'system', actorId: 'stripe',
            action: 'billing.event.applied', purpose: 'hosted_subscription_billing',
            targetType: 'billing_event', targetId: event.eventId,
            metadata: { providerEventId: event.eventId, eventType: event.eventType, livemode: event.livemode },
          }, sql);
        }
        return { outcome: 'applied', organizationId };
      });
    } catch (error) {
      if (!(error instanceof FactRejection)) throw error;
      // The fact transaction rolled back; record the refusal in its own
      // transaction so Stripe's retries of this event are duplicates, not reapplies.
      const recorded = await this.recordRejectedEvent({
        eventId: event.eventId,
        eventType: event.eventType,
        bodyDigest,
        livemode: event.livemode,
        code: error.code,
      });
      if (recorded === 'replay-mismatch') return { outcome: 'replay-mismatch' };
      return { outcome: 'rejected', code: error.code, organizationId: error.organizationId };
    }
  }
}

async function currentSubscription(sql: Sql, organizationId: string,
  planKeyForPrice: (priceId: string | null) => string | null): Promise<HostedSubscriptionSnapshot | null> {
  const rows = await sql<SubscriptionRow[]>`
    SELECT stripe_subscription_id, organization_id::text AS organization_id, status, price_id,
           current_period_end, cancel_at_period_end, canceled_at, livemode, latest_invoice_status
      FROM papercusp_auth.hosted_subscriptions WHERE organization_id = ${organizationId}::uuid
     ORDER BY sub_terminal ASC, sub_event_created DESC, stripe_subscription_id COLLATE "C" DESC LIMIT 1`;
  const row = rows[0];
  if (!row || !isHostedSubscriptionStatus(row.status)) return null;
  return { organizationId: row.organization_id, stripeSubscriptionId: row.stripe_subscription_id,
    status: row.status, planKey: planKeyForPrice(row.price_id), priceId: row.price_id,
    currentPeriodEnd: toDate(row.current_period_end), cancelAtPeriodEnd: row.cancel_at_period_end,
    canceledAt: toDate(row.canceled_at), livemode: row.livemode,
    latestInvoiceStatus: row.latest_invoice_status === 'paid' || row.latest_invoice_status === 'payment_failed' ? row.latest_invoice_status : null };
}

async function priorDigest(sql: Sql, eventId: string): Promise<string | null> {
  const rows = await sql<Array<{ body_digest: string }>>`
    SELECT body_digest FROM papercusp_auth.hosted_billing_webhook_events WHERE provider_event_id = ${eventId}
  `;
  return rows[0]?.body_digest ?? null;
}

async function markRejected(sql: Sql, eventId: string, code: string, organizationId: string | null): Promise<void> {
  await sql`
    UPDATE papercusp_auth.hosted_billing_webhook_events
       SET outcome = 'rejected', rejection_code = ${code}, organization_id = ${organizationId}::uuid
     WHERE provider_event_id = ${eventId}
  `;
}

/** The organization a Stripe customer belongs to — the ONLY authority for attribution (R3). */
async function organizationForCustomer(sql: Sql, stripeCustomerId: string): Promise<string | null> {
  const rows = await sql<Array<{ organization_id: string }>>`
    SELECT organization_id::text AS organization_id
      FROM papercusp_auth.hosted_billing_customers
     WHERE stripe_customer_id = ${stripeCustomerId}
  `;
  return rows[0]?.organization_id ?? null;
}

async function ensureSubscriptionRow(
  sql: Sql,
  input: { stripeSubscriptionId: string; organizationId: string; stripeCustomerId: string; livemode: boolean },
): Promise<void> {
  await sql`
    INSERT INTO papercusp_auth.hosted_subscriptions
      (stripe_subscription_id, organization_id, stripe_customer_id, livemode)
    VALUES (${input.stripeSubscriptionId}, ${input.organizationId}::uuid, ${input.stripeCustomerId}, ${input.livemode})
    ON CONFLICT (stripe_subscription_id) DO NOTHING
  `;
  const rows = await sql<Array<{ organization_id: string; stripe_customer_id: string }>>`
    SELECT organization_id::text AS organization_id, stripe_customer_id
      FROM papercusp_auth.hosted_subscriptions
     WHERE stripe_subscription_id = ${input.stripeSubscriptionId}
     FOR UPDATE
  `;
  const row = rows[0];
  if (!row || row.organization_id !== input.organizationId || row.stripe_customer_id !== input.stripeCustomerId) {
    throw new FactRejection('organization_mismatch', input.organizationId);
  }
}

async function applyFact(
  sql: Sql,
  fact: HostedBillingFact,
  event: HostedBillingEvent,
  planKeyForPrice: (priceId: string | null) => string | null,
  repairSameOrder = false,
): Promise<string> {
  const mapped = await organizationForCustomer(sql, fact.stripeCustomerId);
  if (!mapped) throw new FactRejection('unknown_customer', fact.organizationId);
  const organizationId = fact.organizationId ?? mapped;
  if (organizationId !== mapped) throw new FactRejection('organization_mismatch', fact.organizationId);
  await ensureSubscriptionRow(sql, {
    stripeSubscriptionId: fact.stripeSubscriptionId,
    organizationId,
    stripeCustomerId: fact.stripeCustomerId,
    livemode: event.livemode,
  });

  if (fact.kind === 'subscription') {
    const key = subscriptionOrderKey(fact.status, event.createdAt, event.eventId);
    await sql`
      UPDATE papercusp_auth.hosted_subscriptions AS s
         SET status = ${fact.status},
             price_id = ${fact.priceId},
             plan_key = ${planKeyForPrice(fact.priceId)},
             current_period_end = ${fact.currentPeriodEnd},
             cancel_at_period_end = ${fact.cancelAtPeriodEnd},
             canceled_at = ${fact.canceledAt},
             sub_terminal = ${key.terminal},
             sub_event_created = ${event.createdAt},
             sub_status_rank = ${key.statusRank},
             sub_event_id = ${event.eventId},
             updated_at = now()
       WHERE s.stripe_subscription_id = ${fact.stripeSubscriptionId}
         AND (${key.terminal}::boolean, ${event.createdAt}::timestamptz, ${key.statusRank}::int, ${event.eventId}::text COLLATE "C")
           > (s.sub_terminal, s.sub_event_created, s.sub_status_rank, s.sub_event_id COLLATE "C")
          OR (s.stripe_subscription_id = ${fact.stripeSubscriptionId} AND ${repairSameOrder}
            AND (${key.terminal}::boolean, ${event.createdAt}::timestamptz, ${key.statusRank}::int, ${event.eventId}::text COLLATE "C")
              = (s.sub_terminal, s.sub_event_created, s.sub_status_rank, s.sub_event_id COLLATE "C"))
    `;
  } else if (fact.kind === 'invoice') {
    await sql`
      UPDATE papercusp_auth.hosted_subscriptions AS s
         SET latest_invoice_id = ${fact.invoiceId},
             latest_invoice_status = ${fact.invoiceStatus},
             invoice_event_created = ${event.createdAt},
             invoice_event_id = ${event.eventId},
             updated_at = now()
       WHERE s.stripe_subscription_id = ${fact.stripeSubscriptionId}
         AND (${event.createdAt}::timestamptz, ${event.eventId}::text COLLATE "C")
           > (s.invoice_event_created, s.invoice_event_id COLLATE "C")
          OR (s.stripe_subscription_id = ${fact.stripeSubscriptionId} AND ${repairSameOrder}
            AND (${event.createdAt}::timestamptz, ${event.eventId}::text COLLATE "C") = (s.invoice_event_created, s.invoice_event_id COLLATE "C"))
    `;
  }
  // 'checkout' needs nothing beyond ensureSubscriptionRow: the row now exists in
  // 'pending' so the UI shows "processing" until the subscription event lands.
  return organizationId;
}
