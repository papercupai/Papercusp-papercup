/**
 * Hosted subscription billing store against real Postgres, real roles and real
 * RLS (migration 1276). Every case runs the production `PostgresHostedBillingStore`
 * on `harness_app` switched into `hosted_service` with `SET LOCAL ROLE` — the
 * privilege path `withHostedServiceContext` takes — and inspects rows through the
 * RLS-bypassing admin client.
 *
 * The unit suites prove the routes (`hosted-billing-runtime.test.ts`) and the
 * order key in JavaScript (`stripe-billing-events.test.ts`); only a real database
 * can prove the SQL row comparison, the "C"-collation tie-break, the one
 * transaction that binds the idempotency row to its facts, and the grants.
 *
 * Events are built as Stripe JSON and run through `parseHostedBillingEvent`, so
 * the parser→store seam is exercised exactly as the webhook route uses it.
 *
 * stripe-subscription-signup-2026-10-01 P-003.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import { webhookBodyDigest } from '../../../cupboard/webhook-inbox';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { PostgresHostedBillingStore, type HostedBillingReconciliationCheckpoint } from './billing-store';
import { reconcileHostedBilling, type HostedBillingFailureObservation } from './billing-recovery';
import { createStripeBillingClient, type StripeBillingEventPageEvidence } from './stripe-billing-client';
import { parseHostedBillingEvent, type HostedBillingEvent } from './stripe-billing-events';
import { createConfiguredHostedSubscriptionEntitlementProvider, parseHostedPaidEntitlementBundle } from './entitlement-seam';
import { readHostedEntitlementAuthority, lockHostedEntitlementAuthority } from '../../hosted-entitlement-store';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');

let db: OrgTestDb;

/** Production's hosted-service transaction shape: harness_app, then SET LOCAL ROLE. */
const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;

const planKeyForPrice = (priceId: string | null) => (priceId === 'price_team' ? 'team' : priceId === 'price_pro' ? 'pro' : null);

const hex = () => randomBytes(6).toString('hex');

interface Fixture {
  organizationId: string;
  customerId: string;
  subscriptionId: string;
}

async function fixture(store = new PostgresHostedBillingStore(runService)): Promise<Fixture> {
  const f = { organizationId: randomUUID(), customerId: `cus_${hex()}`, subscriptionId: `sub_${hex()}` };
  await store.recordCustomer({ organizationId: f.organizationId, stripeCustomerId: f.customerId, livemode: false });
  return f;
}

const T0 = 1_790_000_000; // seconds

function subscriptionJson(f: Fixture, input: {
  id: string;
  created: number;
  status: string;
  priceId?: string;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
  periodEnd?: number;
  organizationId?: string;
  livemode?: boolean;
  type?: string;
}): string {
  return JSON.stringify({
    id: input.id,
    type: input.type ?? 'customer.subscription.updated',
    created: input.created,
    livemode: input.livemode ?? false,
    data: {
      object: {
        id: f.subscriptionId,
        customer: f.customerId,
        status: input.status,
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
        canceled_at: input.canceledAt ?? null,
        metadata: { organizationId: input.organizationId ?? f.organizationId },
        items: { data: [{ price: { id: input.priceId ?? 'price_team' }, current_period_end: input.periodEnd ?? T0 + 2_592_000 }] },
      },
    },
  });
}

function invoiceJson(f: Fixture, input: { id: string; created: number; invoiceId: string; paid: boolean }): string {
  return JSON.stringify({
    id: input.id,
    type: input.paid ? 'invoice.paid' : 'invoice.payment_failed',
    created: input.created,
    livemode: false,
    data: { object: { id: input.invoiceId, customer: f.customerId, subscription: f.subscriptionId } },
  });
}

function checkoutJson(f: Fixture, input: { id: string; created: number }): string {
  return JSON.stringify({
    id: input.id,
    type: 'checkout.session.completed',
    created: input.created,
    livemode: false,
    data: {
      object: {
        mode: 'subscription', customer: f.customerId, subscription: f.subscriptionId,
        client_reference_id: f.organizationId, metadata: {},
      },
    },
  });
}

function parsed(raw: string): HostedBillingEvent {
  const result = parseHostedBillingEvent(raw);
  if (!result.ok) throw new Error(`fixture event did not parse: ${result.code}`);
  return result.event;
}

async function deliver(store: PostgresHostedBillingStore, raw: string, expectedLivemode = false) {
  return store.applyEvent({ event: parsed(raw), bodyDigest: webhookBodyDigest(raw), expectedLivemode, planKeyForPrice });
}

const startRecovery = (f: Fixture, store = new PostgresHostedBillingStore(runService)) => store.beginReconciliation({
  organizationId: f.organizationId, accountId: 'acct_Recovery', expectedLivemode: false, createdFrom: T0 - 1, createdBefore: T0 + 200,
});

function recoveryPage(pin: HostedBillingReconciliationCheckpoint, raws: readonly string[],
  changes: Partial<StripeBillingEventPageEvidence> = {}): StripeBillingEventPageEvidence {
  const selected = { source: 'stripe-authenticated-api' as const, accountId: pin.accountId, customerId: pin.customerId,
    organizationId: pin.organizationId, livemode: pin.livemode, createdFrom: pin.createdFrom, createdBefore: pin.createdBefore,
    startingAfter: pin.startingAfter, nextCursor: null, hasMore: false, observedAtMs: Date.now(),
    requestIds: ['req_Account', 'req_Customer', 'req_Events'], observations: raws.map(raw => ({ event: parsed(raw),
      apiObjectDigest: createHash('sha256').update(raw).digest('hex') })), ...changes };
  return { ...selected, evidenceRef: `stripe-billing-page:${createHash('sha256').update(JSON.stringify(selected)).digest('hex')}` };
}
const applyPage = (pin: HostedBillingReconciliationCheckpoint, page: StripeBillingEventPageEvidence,
  store = new PostgresHostedBillingStore(runService)) => store.applyReconciliationPage({ checkpoint: pin, evidence: page, planKeyForPrice });

async function recoveryReceipt(eventId: string) {
  return (await db.adminSql<Array<{ body_digest: string | null; outcome: string; rejection_code: string | null; api_observation: Record<string, unknown> | null }>>`
    SELECT body_digest, outcome, rejection_code, api_observation FROM papercusp_auth.hosted_billing_webhook_events
      WHERE provider_event_id = ${eventId}`)[0] ?? null;
}
async function recoveryCheckpoint(f: Fixture) {
  return (await db.adminSql<Array<{ reconciliation_checkpoint: HostedBillingReconciliationCheckpoint | null }>>`
    SELECT reconciliation_checkpoint FROM papercusp_auth.hosted_billing_customers WHERE organization_id = ${f.organizationId}::uuid`)[0]!.reconciliation_checkpoint;
}

interface SubscriptionRow {
  status: string;
  price_id: string | null;
  plan_key: string | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  latest_invoice_id: string | null;
  latest_invoice_status: string | null;
}

async function subscriptionRow(subscriptionId: string): Promise<SubscriptionRow | null> {
  const rows = await db.adminSql<SubscriptionRow[]>`
    SELECT status, price_id, plan_key, current_period_end, cancel_at_period_end, canceled_at,
           latest_invoice_id, latest_invoice_status
      FROM papercusp_auth.hosted_subscriptions
     WHERE stripe_subscription_id = ${subscriptionId}
  `;
  return rows[0] ?? null;
}

async function eventRow(eventId: string) {
  const rows = await db.adminSql<Array<{ outcome: string; rejection_code: string | null; organization_id: string | null }>>`
    SELECT outcome, rejection_code, organization_id::text AS organization_id
      FROM papercusp_auth.hosted_billing_webhook_events
     WHERE provider_event_id = ${eventId}
  `;
  return rows[0] ?? null;
}

/** Deterministic Fisher–Yates so a failing order is reproducible from its seed. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function applyRecoveryMigration(testDb: OrgTestDb) {
  const draft = new URL('../../../../../../libs/papercusp/libs/db/sql/1515-hosted-billing-api-recovery.sql.DRAFT', import.meta.url);
  const armed = new URL('../../../../../../libs/papercusp/libs/db/sql/1515-hosted-billing-api-recovery.sql', import.meta.url);
  let migration: string;
  try { migration = readFileSync(draft, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; migration = readFileSync(armed, 'utf8'); }
  // Additive upgrade and reapplication on the actual migrated schema.
  await testDb.adminSql.unsafe(migration); await testDb.adminSql.unsafe(migration);
}

describe('PostgresHostedBillingStore (real Postgres, real roles)', () => {
  const store = () => new PostgresHostedBillingStore(runService);

  beforeAll(async () => {
    db = await createOrgTestDb();
    await applyRecoveryMigration(db);
    await db.adminSql.unsafe(readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1524-hosted-entitlement-authority.sql', import.meta.url), 'utf8'));
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const resourceBundle = (plan = 'team', agents = 20) => parseHostedPaidEntitlementBundle({ schemaVersion: 1,
    bundleId: `paid-${plan}`, bundleVersion: 1,
    record: { source: 'billing', actor: { kind: 'service', principalId: 'service:billing' },
      auditReceiptId: `policy:${plan}:1`, effectiveFrom: '2026-01-01T00:00:00Z', effectiveUntil: null },
    entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 5 },
      browserAccess: { pty: true, files: true }, supportTier: 'paid',
      quotas: { 'pool.agents': agents, 'pool.hosts': 2, 'pool.cpu-millicores': 8000, 'pool.memory-mib': 16384,
        'pool.db-gib': 256, 'pool.workspace-gib': 32, 'pool.reserved-hosts': 1 },
      budgets: { 'pool.cost.usd.minor': 10000 }, rolloutFlags: {} } });
  const resourceStore = (teamAgents = 20) => new PostgresHostedBillingStore(runService,
    createConfiguredHostedSubscriptionEntitlementProvider(['team', 'pro'].map(planKey => ({ planKey, priceId: `price_${planKey}`,
      entitlementBundle: resourceBundle(planKey, planKey === 'team' ? teamAgents : 50) }))));
  const resourceRead = (org: string, at?: Date) => runService(sql => readHostedEntitlementAuthority(sql, org, at));
  const authorityRow = async (org: string) => (await db.adminSql<Array<{ authority_revision: string; authority: unknown }>>`
    SELECT authority_revision, authority FROM papercusp_auth.hosted_entitlements WHERE organization_id = ${org}::uuid`)[0]!;
  const resourceGrant = async (f: Fixture) => {
    const userId = randomUUID();
    await runService(async sql => { await sql`INSERT INTO papercusp_auth.hosted_entitlements (organization_id, user_id, kind, source)
      VALUES (${f.organizationId}::uuid, ${userId}::uuid, 'hosted-free', 'self_signup')`; });
    return userId;
  };
  const periodEnd = () => Math.floor(Date.now() / 1000) + 3600;

  it('projects upgrades/downgrades from winning facts, ignores stale/replayed facts, and revokes cancellation without deleting grants', async () => {
    const s = resourceStore(); const f = await fixture(s); await resourceGrant(f); const end = periodEnd();
    const first = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active', periodEnd: end });
    await deliver(s, first);
    expect(await resourceRead(f.organizationId)).toMatchObject({ ok: true, authorityRevision: 1,
      resolution: { bundleId: 'paid-team', quotas: { 'pool.agents': 20, 'pool.reserved-hosts': 1 } } });
    const before = await authorityRow(f.organizationId);
    expect((await deliver(s, first)).outcome).toBe('duplicate');
    await deliver(s, subscriptionJson(f, { id: `evt_${hex()}`, created: T0 - 1, status: 'active', priceId: 'price_pro', periodEnd: end }));
    expect(await authorityRow(f.organizationId)).toEqual(before);
    await deliver(s, subscriptionJson(f, { id: `evt_${hex()}`, created: T0 + 1, status: 'active', priceId: 'price_pro', periodEnd: end }));
    expect(await resourceRead(f.organizationId)).toMatchObject({ ok: true, resolution: { quotas: { 'pool.agents': 50 } } });
    await deliver(s, subscriptionJson(f, { id: `evt_${hex()}`, created: T0 + 2, status: 'active', periodEnd: end, cancelAtPeriodEnd: true }));
    expect(await resourceRead(f.organizationId)).toMatchObject({ ok: true, resolution: { quotas: { 'pool.agents': 20 } } });
    expect(await resourceRead(f.organizationId, new Date(end * 1000))).toMatchObject({ ok: false, reason: 'no_active_assignment' });
    await deliver(s, subscriptionJson(f, { id: `evt_${hex()}`, created: T0 + 3, status: 'canceled', periodEnd: end }));
    expect(await resourceRead(f.organizationId)).toMatchObject({ ok: false, reason: 'no_active_assignment' });
    expect((await authorityRow(f.organizationId)).authority).toMatchObject({ bundles: expect.arrayContaining([
      expect.objectContaining({ bundleId: 'paid-team' }), expect.objectContaining({ bundleId: 'paid-pro' })]) });
  });

  it('rolls back billing facts and receipt if no canonical grant exists, then accepts the authenticated retry', async () => {
    const s = resourceStore(); const f = await fixture(s);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active', periodEnd: periodEnd() });
    await expect(deliver(s, raw)).rejects.toThrow('hosted_billing_entitlement_grant_ambiguous_or_missing');
    expect(await eventRow(parsed(raw).eventId)).toBeNull(); expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    await resourceGrant(f); expect((await deliver(s, raw)).outcome).toBe('applied');
    expect(await resourceRead(f.organizationId)).toMatchObject({ ok: true });
  });

  it('rejects policy content changes under an existing version pin atomically', async () => {
    const s = resourceStore(); const f = await fixture(s); await resourceGrant(f); const end = periodEnd();
    await deliver(s, subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active', periodEnd: end }));
    const before = await authorityRow(f.organizationId);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0 + 1, status: 'past_due', periodEnd: end });
    await expect(deliver(resourceStore(999), raw)).rejects.toThrow('hosted_billing_bundle_version_reused');
    expect(await eventRow(parsed(raw).eventId)).toBeNull(); expect(await authorityRow(f.organizationId)).toEqual(before);
    expect((await subscriptionRow(f.subscriptionId))!.status).toBe('active');
  });

  it('uses the same authority projection for authenticated recovery and concurrent webhook delivery', async () => {
    const s = resourceStore(); const f = await fixture(s); await resourceGrant(f); const end = periodEnd();
    const pin = await startRecovery(f, s);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active', periodEnd: end });
    await Promise.all([applyPage(pin, recoveryPage(pin, [raw]), s), deliver(s, raw)]);
    expect(await resourceRead(f.organizationId)).toMatchObject({ ok: true, authorityRevision: 1,
      resolution: { quotas: { 'pool.agents': 20 } } });
    expect((await recoveryCheckpoint(f))?.complete).toBe(true);
  });

  it('serializes a billing downgrade behind an in-flight authority/admission transaction', async () => {
    const s = resourceStore(); const f = await fixture(s); await resourceGrant(f); const end = periodEnd();
    await deliver(s, subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active', priceId: 'price_pro', periodEnd: end }));
    let writer!: Promise<unknown>;
    await runService(async sql => {
      await lockHostedEntitlementAuthority(sql, f.organizationId);
      writer = deliver(s, subscriptionJson(f, { id: `evt_${hex()}`, created: T0 + 1, status: 'active', periodEnd: end }));
      expect(await readHostedEntitlementAuthority(sql, f.organizationId)).toMatchObject({ ok: true,
        resolution: { quotas: { 'pool.agents': 50 } } });
    });
    await writer;
    expect(await resourceRead(f.organizationId)).toMatchObject({ ok: true, resolution: { quotas: { 'pool.agents': 20 } } });
  });

  it('independently detects API-only deliveries and permanent refusals in the real hosted-service role', async () => {
    const s = store(); const f = await fixture(s);
    const pin = await startRecovery(f, s);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    const eventId = parsed(raw).eventId;
    await applyPage(pin, recoveryPage(pin, [raw]), s);
    const rejectedId = `evt_${hex()}`;
    await s.recordRejectedEvent({ eventId: rejectedId, eventType: 'customer.subscription.updated',
      bodyDigest: 'a'.repeat(64), livemode: false, code: 'missing-organization' });
    expect(await s.deliveryIssues({ expectedLivemode: false, limit: 100 })).toEqual(expect.arrayContaining([
      { eventId, failureClass: 'undelivered' }, { eventId: rejectedId, failureClass: 'permanent-rejection' },
    ]));
    expect(await s.deliveryIssues({ expectedLivemode: true, limit: 100 })).toEqual([]);
    expect(await s.reconciliationTargets({ expectedLivemode: false, limit: 100 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ organizationId: f.organizationId, checkpoint: expect.objectContaining({ complete: true }) }),
    ]));
    // The API fact commitment is not the signed-delivery receipt. A genuine
    // later delivery clears only its own missing-delivery classification.
    await deliver(s, raw);
    expect(await s.deliveryIssues({ expectedLivemode: false, limit: 100 })).not.toEqual(expect.arrayContaining([
      { eventId, failureClass: 'undelivered' },
    ]));
    expect(await s.deliveryIssues({ expectedLivemode: false, limit: 100 })).toEqual(expect.arrayContaining([
      { eventId: rejectedId, failureClass: 'permanent-rejection' },
    ]));
  });

  it('keeps exactly one customer per organization (insert-or-keep, the earlier winner stays)', async () => {
    const organizationId = randomUUID();
    const first = await store().recordCustomer({ organizationId, stripeCustomerId: `cus_${hex()}`, livemode: false });
    const second = await store().recordCustomer({ organizationId, stripeCustomerId: `cus_${hex()}`, livemode: false });
    expect(second).toEqual(first);
    expect(await store().customerFor(organizationId)).toEqual(first);
    expect(await store().customerFor(randomUUID())).toBeNull();
  });

  it('appends tenant billing receipts exactly once with the customer link and accepted webhook', async () => {
    const f = await fixture();
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'applied' });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'duplicate' });
    await store().recordCustomer({ organizationId: f.organizationId, stripeCustomerId: f.customerId, livemode: false });
    const audit = await db.adminSql<Array<{ action: string; actor_kind: string; metadata: Record<string, unknown> }>>`
      SELECT action, actor_kind, metadata FROM papercusp_auth.organization_audit_events
       WHERE organization_id = ${f.organizationId}::uuid ORDER BY recorded_at, id`;
    expect(audit.map((e) => e.action)).toEqual(['billing.customer.linked', 'billing.event.applied']);
    expect(audit.every((e) => e.actor_kind === 'system')).toBe(true);
    expect(audit[1].metadata).toMatchObject({ providerEventId: parsed(raw).eventId });
    expect(JSON.stringify(audit)).not.toContain('price_team');
  });

  it('rolls back billing facts and provider processing when a tenant audit append fails', async () => {
    const f = await fixture();
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    await db.adminSql.unsafe('REVOKE INSERT ON papercusp_auth.organization_audit_events FROM hosted_service');
    try {
      await expect(deliver(store(), raw)).rejects.toThrow(/permission denied/);
      expect(await subscriptionRow(f.subscriptionId)).toBeNull();
      expect(await eventRow(parsed(raw).eventId)).toBeNull();
    } finally {
      await db.adminSql.unsafe('GRANT INSERT ON papercusp_auth.organization_audit_events TO hosted_service');
    }
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'applied' });
  });

  it('converges to the same final row for every delivery order (order-independent max-registers)', async () => {
    // A realistic signup → upgrade → schedule-cancel lifecycle, including a
    // same-second pair (incomplete → active) that only the status rank orders,
    // and two invoices where the later one wins.
    const lifecycle = (f: Fixture, tag: string) => [
      checkoutJson(f, { id: `evt_${tag}a`, created: T0 }),
      subscriptionJson(f, { id: `evt_${tag}b`, created: T0 + 1, status: 'incomplete', type: 'customer.subscription.created' }),
      subscriptionJson(f, { id: `evt_${tag}c`, created: T0 + 1, status: 'active' }),
      invoiceJson(f, { id: `evt_${tag}d`, created: T0 + 2, invoiceId: 'in_first', paid: false }),
      invoiceJson(f, { id: `evt_${tag}e`, created: T0 + 3, invoiceId: 'in_second', paid: true }),
      subscriptionJson(f, { id: `evt_${tag}f`, created: T0 + 4, status: 'active', priceId: 'price_pro', periodEnd: T0 + 5_000_000 }),
      subscriptionJson(f, { id: `evt_${tag}g`, created: T0 + 5, status: 'active', priceId: 'price_pro', cancelAtPeriodEnd: true, periodEnd: T0 + 5_000_000 }),
    ];
    const expected: SubscriptionRow = {
      status: 'active',
      price_id: 'price_pro',
      plan_key: 'pro',
      current_period_end: new Date((T0 + 5_000_000) * 1000),
      cancel_at_period_end: true,
      canceled_at: null,
      latest_invoice_id: 'in_second',
      latest_invoice_status: 'paid',
    };

    const orders: Array<{ label: string; order: (events: string[]) => string[] }> = [
      { label: 'in order', order: (e) => e },
      { label: 'reversed', order: (e) => [...e].reverse() },
      ...[11, 23, 37, 41, 59, 73, 97, 101].map((seed) => ({ label: `seed ${seed}`, order: (e: string[]) => shuffled(e, seed) })),
    ];
    for (const { label, order } of orders) {
      const f = await fixture();
      for (const raw of order(lifecycle(f, hex()))) {
        const result = await deliver(store(), raw);
        expect(result.outcome, `${label}: ${raw.slice(0, 60)}`).toBe('applied');
      }
      expect(await subscriptionRow(f.subscriptionId), label).toEqual(expected);
      expect(await store().currentSubscription(f.organizationId, planKeyForPrice), label).toMatchObject({
        status: 'active', planKey: 'pro', cancelAtPeriodEnd: true, latestInvoiceStatus: 'paid',
      });
    }
  });

  it('a canceled subscription is never resurrected by a late or later non-terminal update', async () => {
    const f = await fixture();
    const tag = hex();
    await deliver(store(), subscriptionJson(f, { id: `evt_${tag}x`, created: T0 + 10, status: 'canceled', canceledAt: T0 + 10 }));
    // Older update arriving late.
    await deliver(store(), subscriptionJson(f, { id: `evt_${tag}y`, created: T0 + 5, status: 'active' }));
    // A non-terminal update stamped AFTER the cancellation (Stripe never revives; a bad clock must not either).
    await deliver(store(), subscriptionJson(f, { id: `evt_${tag}z`, created: T0 + 20, status: 'past_due' }));
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'canceled', canceled_at: new Date((T0 + 10) * 1000) });
    expect(await store().currentSubscription(f.organizationId, planKeyForPrice)).toMatchObject({ status: 'canceled' });
  });

  it('a live subscription outranks an organization’s older terminal one in currentSubscription', async () => {
    const f = await fixture();
    const tag = hex();
    await deliver(store(), subscriptionJson(f, { id: `evt_${tag}a`, created: T0 + 50, status: 'canceled', canceledAt: T0 + 50 }));
    const next: Fixture = { ...f, subscriptionId: `sub_${hex()}` };
    await deliver(store(), subscriptionJson(next, { id: `evt_${tag}b`, created: T0 + 40, status: 'active' }));
    expect(await store().currentSubscription(f.organizationId, planKeyForPrice)).toMatchObject({
      stripeSubscriptionId: next.subscriptionId, status: 'active', planKey: 'team',
    });
  });

  it('a checkout alone leaves a pending row the UI can show as processing', async () => {
    const f = await fixture();
    expect(await deliver(store(), checkoutJson(f, { id: `evt_${hex()}`, created: T0 }))).toMatchObject({ outcome: 'applied' });
    expect(await store().currentSubscription(f.organizationId, planKeyForPrice)).toMatchObject({ status: 'pending', planKey: null });
  });

  it('a byte-identical redelivery is a duplicate and changes nothing; different bytes under the same id is a replay', async () => {
    const f = await fixture();
    const id = `evt_${hex()}`;
    const raw = subscriptionJson(f, { id, created: T0, status: 'active' });
    expect(await deliver(store(), raw)).toEqual({ outcome: 'applied', organizationId: f.organizationId });
    expect(await deliver(store(), raw)).toEqual({ outcome: 'duplicate', organizationId: f.organizationId });
    const tampered = subscriptionJson(f, { id, created: T0, status: 'canceled', canceledAt: T0 });
    expect(await deliver(store(), tampered)).toEqual({ outcome: 'replay-mismatch' });
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'active' });
    expect(await eventRow(id)).toEqual({ outcome: 'applied', rejection_code: null, organization_id: f.organizationId });
  });

  it('refuses an event for an unrecorded customer, records the refusal, and treats its retry as a duplicate', async () => {
    const stranger: Fixture = { organizationId: randomUUID(), customerId: `cus_${hex()}`, subscriptionId: `sub_${hex()}` };
    const id = `evt_${hex()}`;
    const raw = subscriptionJson(stranger, { id, created: T0, status: 'active' });
    expect(await deliver(store(), raw)).toEqual({ outcome: 'rejected', code: 'unknown_customer', organizationId: stranger.organizationId });
    expect(await subscriptionRow(stranger.subscriptionId)).toBeNull();
    expect(await eventRow(id)).toEqual({ outcome: 'rejected', rejection_code: 'unknown_customer', organization_id: null });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'duplicate' });
  });

  it('refuses an event whose metadata names another organization than the customer belongs to', async () => {
    const f = await fixture();
    const id = `evt_${hex()}`;
    const raw = subscriptionJson(f, { id, created: T0, status: 'active', organizationId: randomUUID() });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'rejected', code: 'organization_mismatch' });
    expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    expect(await eventRow(id)).toMatchObject({ outcome: 'rejected', rejection_code: 'organization_mismatch' });
  });

  it('refuses a subscription id that is already bound to a different organization', async () => {
    const a = await fixture();
    const b = await fixture();
    await deliver(store(), subscriptionJson(a, { id: `evt_${hex()}`, created: T0, status: 'active' }));
    const hijack: Fixture = { ...b, subscriptionId: a.subscriptionId };
    const result = await deliver(store(), subscriptionJson(hijack, { id: `evt_${hex()}`, created: T0 + 1, status: 'canceled', canceledAt: T0 + 1 }));
    expect(result).toMatchObject({ outcome: 'rejected', code: 'organization_mismatch' });
    expect(await subscriptionRow(a.subscriptionId)).toMatchObject({ status: 'active' });
  });

  it('refuses an event from the other Stripe mode without touching facts', async () => {
    const f = await fixture();
    const id = `evt_${hex()}`;
    const result = await deliver(store(), subscriptionJson(f, { id, created: T0, status: 'active', livemode: true }), false);
    expect(result).toEqual({ outcome: 'rejected', code: 'livemode_mismatch', organizationId: null });
    expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    expect(await eventRow(id)).toMatchObject({ outcome: 'rejected', rejection_code: 'livemode_mismatch' });
  });

  it('records an unparseable-but-authenticated delivery once; its retries are duplicates, altered bytes a replay', async () => {
    const id = `evt_${hex()}`;
    const input = { eventId: id, eventType: 'customer.subscription.updated', bodyDigest: 'a'.repeat(64), livemode: false, code: 'missing-organization' };
    expect(await store().recordRejectedEvent(input)).toBe('recorded');
    expect(await store().recordRejectedEvent(input)).toBe('duplicate');
    expect(await store().recordRejectedEvent({ ...input, bodyDigest: 'b'.repeat(64) })).toBe('replay-mismatch');
  });

  it('is atomic: a crash before commit leaves neither the idempotency row nor any fact, so the redelivery applies', async () => {
    const f = await fixture();
    const id = `evt_${hex()}`;
    const raw = subscriptionJson(f, { id, created: T0, status: 'active' });
    const crashing: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
      db.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        await fn(tx as unknown as Sql);
        throw new Error('simulated crash before commit');
      }) as Promise<T>;
    await expect(deliver(new PostgresHostedBillingStore(crashing), raw)).rejects.toThrow('simulated crash');
    expect(await eventRow(id)).toBeNull();
    expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    expect(await db.adminSql`SELECT id FROM papercusp_auth.organization_audit_events
      WHERE organization_id = ${f.organizationId}::uuid AND action = 'billing.event.applied'`).toHaveLength(0);
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'applied' });
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'active' });
    const audit = await db.adminSql`SELECT metadata FROM papercusp_auth.organization_audit_events
      WHERE organization_id = ${f.organizationId}::uuid AND action = 'billing.event.applied'`;
    expect(audit).toHaveLength(1); expect(audit[0].metadata).toMatchObject({ providerEventId: id });
  });

  it('serializes a concurrent duplicate delivery: exactly one applies, the other sees a duplicate', async () => {
    const f = await fixture();
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    const outcomes = (await Promise.all([deliver(store(), raw), deliver(store(), raw)])).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['applied', 'duplicate']);
    expect(await eventRow(parsed(raw).eventId)).toEqual({ outcome: 'applied', rejection_code: null, organization_id: f.organizationId });
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'active', plan_key: 'team' });
    const audit = await db.adminSql`SELECT metadata FROM papercusp_auth.organization_audit_events
      WHERE organization_id = ${f.organizationId}::uuid AND action = 'billing.event.applied'`;
    expect(audit).toHaveLength(1); expect(audit[0].metadata).toMatchObject({ providerEventId: parsed(raw).eventId });
  });

  it('applies the authenticated reader output and later accepts original webhook bytes without inventing a signature or digest', async () => {
    const f = await fixture(); const pin = await startRecovery(f);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    const constructed = createStripeBillingClient({ secretKey: 'sk_test_Recovery', liveModeAllowed: false,
      fetchImpl: async url => {
        const path = new URL(String(url)).pathname;
        const body = path === '/v1/account' ? { object: 'account', id: pin.accountId }
          : path.startsWith('/v1/customers/') ? { object: 'customer', id: f.customerId, livemode: false, metadata: { organizationId: f.organizationId } }
            : { object: 'list', data: [{ ...JSON.parse(raw), object: 'event' }], has_more: false };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'request-id': `req_${path === '/v1/account' ? 'Account' : path.startsWith('/v1/customers/') ? 'Customer' : 'Events'}` } });
      } });
    if (!constructed.ok) throw new Error('fixture client construction');
    const page = await constructed.client.readBillingEventPage({ ...pin, startingAfter: undefined });
    if (!page.ok) throw new Error(page.detail);
    expect(await applyPage(pin, page.evidence)).toMatchObject({ outcome: 'applied', checkpoint: { complete: true } });
    expect(await recoveryReceipt(parsed(raw).eventId)).toMatchObject({ body_digest: null, outcome: 'ignored',
      api_observation: { source: 'stripe-authenticated-api', evidenceRef: page.evidence.evidenceRef } });
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'active', plan_key: 'team' });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'applied' });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'duplicate' });
    expect(await deliver(store(), `${raw} `)).toEqual({ outcome: 'replay-mismatch' });
    expect((await recoveryReceipt(parsed(raw).eventId))?.body_digest).toBe(webhookBodyDigest(raw));
  });

  it('repairs a same-order mirror drift while preserving the original signed receipt and later ordering', async () => {
    const f = await fixture(); const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    await deliver(store(), raw);
    await db.adminSql`UPDATE papercusp_auth.hosted_subscriptions SET price_id = 'price_broken', plan_key = NULL
      WHERE stripe_subscription_id = ${f.subscriptionId}`;
    const pin = await startRecovery(f);
    const first = await applyPage(pin, recoveryPage(pin, [raw], { hasMore: true, nextCursor: parsed(raw).eventId }));
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ price_id: 'price_team', plan_key: 'team' });
    expect((await recoveryReceipt(parsed(raw).eventId))?.body_digest).toBe(webhookBodyDigest(raw));
    await deliver(store(), subscriptionJson(f, { id: `evt_${hex()}`, created: T0 + 20, status: 'canceled' }));
    await applyPage(first.checkpoint, recoveryPage(first.checkpoint, [subscriptionJson(f, { id: `evt_${hex()}`, created: T0 - 1, status: 'active' })]));
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'canceled' });
  });

  it('commits a paginated cursor once, resumes its fixed window, and rejects a stale concurrent page', async () => {
    const f = await fixture(); const pin = await startRecovery(f);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    const page = recoveryPage(pin, [raw], { hasMore: true, nextCursor: parsed(raw).eventId });
    const results = await Promise.all([applyPage(pin, page), applyPage(pin, page)]);
    expect(results.map(r => r.outcome).sort()).toEqual(['applied', 'cursor-conflict']);
    const current = results.find(r => r.outcome === 'applied')!.checkpoint;
    expect(current).toMatchObject({ revision: pin.revision + 1, startingAfter: parsed(raw).eventId, complete: false });
    expect(await store().beginReconciliation({ organizationId: f.organizationId, accountId: pin.accountId,
      expectedLivemode: false, createdFrom: T0 + 201, createdBefore: T0 + 400 })).toEqual(current);
    const audit = await db.adminSql`SELECT metadata FROM papercusp_auth.organization_audit_events
      WHERE organization_id = ${f.organizationId}::uuid AND action = 'billing.event.reconciled'`;
    expect(audit).toHaveLength(1); expect(audit[0].metadata).toMatchObject({ evidenceRef: page.evidenceRef });
    expect(await applyPage(current, recoveryPage(current, []))).toMatchObject({ checkpoint: { complete: true } });
    await expect(store().beginReconciliation({ organizationId: f.organizationId, accountId: pin.accountId,
      expectedLivemode: false, createdFrom: T0 + 201, createdBefore: T0 + 400 })).rejects.toThrow('window_gap');
  });

  it.each(['fetch', 'body'] as const)('resumes the durable cursor after a page %s deadline without losing or duplicating billing state', async phase => {
    // Separate database: exercise the real target/census queries as well as the
    // coordinator, authenticated reader and hosted_service transactions.
    const deadlineDb = await createOrgTestDb();
    try {
      await applyRecoveryMigration(deadlineDb);
      const run: HostedServiceContextRunner = fn => deadlineDb.appSql.begin(async tx => {
        await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        return fn(tx as unknown as Sql);
      }) as ReturnType<typeof fn>;
      const firstStore = new PostgresHostedBillingStore(run);
      const f = await fixture(firstStore);
      const firstId = `evt_${hex()}`; const tailId = `evt_${hex()}`; const invoiceId = `in_${hex()}`;
      // Stripe pages descend by creation time; the older invoice updates its
      // own register without rolling back the newer subscription state.
      const first = JSON.parse(subscriptionJson(f, { id: firstId, created: T0 + 10, status: 'active' }));
      const tail = JSON.parse(invoiceJson(f, { id: tailId, created: T0, invoiceId, paid: true }));
      const requests: URL[] = [];
      let interruptedSignal: AbortSignal | undefined; let pendingIo = false;
      const client = (interrupt: boolean) => {
        const built = createStripeBillingClient({ secretKey: 'sk_test_Recovery', liveModeAllowed: false, readTimeoutMs: 1000,
          fetchImpl: async (url, init) => {
            const request = new URL(String(url));
            const response = (body: unknown, requestId: string) => new Response(JSON.stringify(body),
              { headers: { 'request-id': requestId } });
            if (request.pathname === '/v1/account') return response({ object: 'account', id: 'acct_Recovery' }, 'req_Account');
            if (request.pathname === `/v1/customers/${f.customerId}`) return response({ object: 'customer',
              id: f.customerId, livemode: false, metadata: { organizationId: f.organizationId } }, 'req_Customer');
            requests.push(request);
            const isTail = request.searchParams.get('starting_after') === firstId;
            const page = response({ object: 'list', data: [{ ...(isTail ? tail : first), object: 'event' }],
              has_more: !isTail }, isTail ? 'req_Tail' : 'req_First');
            if (!interrupt || !isTail) return page;
            interruptedSignal = init!.signal as AbortSignal;
            const stall = () => new Promise<never>((_resolve, reject) => {
              pendingIo = true;
              interruptedSignal!.addEventListener('abort', () => {
                pendingIo = false; reject(new Error('private provider failure'));
              }, { once: true });
            });
            if (phase === 'fetch') return stall();
            page.json = stall;
            return page;
          } });
        if (!built.ok) throw new Error('fixture client construction');
        return built.client;
      };
      const observations: HostedBillingFailureObservation[] = [];
      const observe = async (observation: HostedBillingFailureObservation) => { observations.push(observation); };
      const input = { accountId: 'acct_Recovery', createdFrom: T0 - 1, createdBefore: T0 + 200,
        overlapSeconds: 5, maxCustomers: 1, maxPages: 10 };
      const snapshot = async () => ({
        checkpoint: (await deadlineDb.adminSql<Array<{ checkpoint: HostedBillingReconciliationCheckpoint }>>`
          SELECT reconciliation_checkpoint AS checkpoint FROM papercusp_auth.hosted_billing_customers
          WHERE organization_id = ${f.organizationId}::uuid`)[0]!.checkpoint,
        mirror: (await deadlineDb.adminSql`SELECT status, plan_key, latest_invoice_id, latest_invoice_status
          FROM papercusp_auth.hosted_subscriptions WHERE stripe_subscription_id = ${f.subscriptionId}`)[0],
        receipts: await deadlineDb.adminSql`SELECT provider_event_id, body_digest, api_observation
          FROM papercusp_auth.hosted_billing_webhook_events WHERE organization_id = ${f.organizationId}::uuid ORDER BY provider_event_id`,
        audit: await deadlineDb.adminSql`SELECT id, target_id, metadata FROM papercusp_auth.organization_audit_events
          WHERE organization_id = ${f.organizationId}::uuid AND action = 'billing.event.reconciled' ORDER BY id`,
      });
      expect(await reconcileHostedBilling(input, { store: firstStore, client: client(true), planKeyForPrice, observe },
        new AbortController().signal)).toMatchObject({ customers: 1, pages: 2, completed: 0, failed: 1,
        conflicts: 0, budgetExhausted: false });
      expect(interruptedSignal?.aborted).toBe(true); expect(pendingIo).toBe(false);
      expect(observations).toContainEqual({ failureClass: 'provider-unavailable', eventId: null });
      const interrupted = await snapshot();
      expect(interrupted.checkpoint).toMatchObject({ createdFrom: T0 - 1, createdBefore: T0 + 200,
        startingAfter: firstId, revision: 2, complete: false, cursors: [firstId] });
      expect(interrupted.mirror).toEqual({ status: 'active', plan_key: 'team', latest_invoice_id: null, latest_invoice_status: null });
      expect(interrupted.receipts).toHaveLength(1);
      expect(interrupted.receipts[0]).toMatchObject({ provider_event_id: firstId, body_digest: null,
        api_observation: { source: 'stripe-authenticated-api', requestIds: ['req_Account', 'req_Customer', 'req_First'] } });
      expect(interrupted.audit).toHaveLength(1); expect(interrupted.audit[0].target_id).toBe(firstId);

      // New instances and a newer requested window must recover the pending
      // old tail from Postgres, rather than advance past its failed read.
      const resumed = await reconcileHostedBilling({ ...input, createdFrom: T0 + 201, createdBefore: T0 + 400 },
        { store: new PostgresHostedBillingStore(run), client: client(false), planKeyForPrice, observe }, new AbortController().signal);
      expect(resumed).toMatchObject({ customers: 1, pages: 1, completed: 1, failed: 0, conflicts: 0, budgetExhausted: false });
      expect(requests.map(request => request.searchParams.get('starting_after'))).toEqual([null, firstId, firstId]);
      for (const request of requests) {
        expect(request.pathname).toBe('/v1/events');
        expect(request.searchParams.get('created[gte]')).toBe(String(T0 - 1));
        expect(request.searchParams.get('created[lt]')).toBe(String(T0 + 200));
      }
      const completed = await snapshot();
      expect(completed.checkpoint).toEqual({ ...interrupted.checkpoint, startingAfter: null, revision: 3, complete: true });
      expect(completed.mirror).toEqual({ status: 'active', plan_key: 'team', latest_invoice_id: invoiceId, latest_invoice_status: 'paid' });
      expect(completed.receipts).toHaveLength(2);
      expect(completed.receipts.find(receipt => receipt.provider_event_id === firstId)).toEqual(interrupted.receipts[0]);
      expect(completed.receipts.find(receipt => receipt.provider_event_id === tailId)).toMatchObject({ body_digest: null,
        api_observation: { source: 'stripe-authenticated-api', requestIds: ['req_Account', 'req_Customer', 'req_Tail'] } });
      expect(completed.audit).toHaveLength(2);
      expect(completed.audit.map(row => row.target_id).sort()).toEqual([firstId, tailId].sort());
      expect(completed.audit.find(row => row.target_id === firstId)).toEqual(interrupted.audit[0]);
    } finally { await deadlineDb.cleanup(); }
  }, 180_000);

  it('rolls back receipt, facts, audit and cursor on a crash before commit, then recovers with the same page', async () => {
    const f = await fixture(); const pin = await startRecovery(f);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' }); const page = recoveryPage(pin, [raw]);
    const crashing: HostedServiceContextRunner = fn => runService(async sql => { await fn(sql); throw new Error('recovery crash before commit'); });
    await expect(applyPage(pin, page, new PostgresHostedBillingStore(crashing))).rejects.toThrow('recovery crash');
    expect(await recoveryReceipt(parsed(raw).eventId)).toBeNull(); expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    expect(await recoveryCheckpoint(f)).toEqual(pin);
    expect(await db.adminSql`SELECT id FROM papercusp_auth.organization_audit_events
      WHERE organization_id = ${f.organizationId}::uuid AND action = 'billing.event.reconciled'`).toHaveLength(0);
    expect(await applyPage(pin, page)).toMatchObject({ outcome: 'applied', checkpoint: { complete: true } });
  });

  it('leaves the cursor replayable when the audit write fails', async () => {
    const f = await fixture(); const pin = await startRecovery(f);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' }); const page = recoveryPage(pin, [raw]);
    await db.adminSql.unsafe('REVOKE INSERT ON papercusp_auth.organization_audit_events FROM hosted_service');
    try {
      await expect(applyPage(pin, page)).rejects.toThrow(/permission denied/);
      expect(await recoveryCheckpoint(f)).toEqual(pin); expect(await recoveryReceipt(parsed(raw).eventId)).toBeNull();
      expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    } finally { await db.adminSql.unsafe('GRANT INSERT ON papercusp_auth.organization_audit_events TO hosted_service'); }
    expect(await applyPage(pin, page)).toMatchObject({ outcome: 'applied' });
  });

  it('serializes concurrent webhook/recovery and keeps byte replay authority', async () => {
    const f = await fixture(); const pin = await startRecovery(f);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    const results = await Promise.all([deliver(store(), raw), applyPage(pin, recoveryPage(pin, [raw]))]);
    expect(results.map(r => r.outcome)).toEqual(['applied', 'applied']);
    expect(await recoveryReceipt(parsed(raw).eventId)).toMatchObject({ body_digest: webhookBodyDigest(raw), outcome: 'applied' });
    expect(await deliver(store(), `${raw}\n`)).toEqual({ outcome: 'replay-mismatch' });
  });

  it.each(['livemode_mismatch', 'organization_mismatch', 'missing-organization', 'malformed-body'])('does not reset permanent webhook rejection %s or advance the cursor', async code => {
    const f = await fixture(); const pin = await startRecovery(f);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    await store().recordRejectedEvent({ eventId: parsed(raw).eventId, eventType: parsed(raw).eventType,
      bodyDigest: webhookBodyDigest(raw), livemode: false, code });
    await expect(applyPage(pin, recoveryPage(pin, [raw]))).rejects.toThrow('permanent_rejection');
    expect(await recoveryReceipt(parsed(raw).eventId)).toMatchObject({ outcome: 'rejected', rejection_code: code, api_observation: null });
    expect(await recoveryCheckpoint(f)).toEqual(pin); expect(await subscriptionRow(f.subscriptionId)).toBeNull();
  });

  it('repairs a former unknown-customer refusal only after customer mapping exists, without rewriting the refusal', async () => {
    const f = { organizationId: randomUUID(), customerId: `cus_${hex()}`, subscriptionId: `sub_${hex()}` };
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'rejected', code: 'unknown_customer' });
    await store().recordCustomer({ organizationId: f.organizationId, stripeCustomerId: f.customerId, livemode: false });
    const pin = await startRecovery(f); await applyPage(pin, recoveryPage(pin, [raw]));
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'active' });
    expect(await recoveryReceipt(parsed(raw).eventId)).toMatchObject({ outcome: 'rejected', rejection_code: 'unknown_customer', body_digest: webhookBodyDigest(raw) });
  });

  it.each(['account', 'tenant', 'mode', 'window', 'provenance', 'cycle', 'repeat'])('refuses %s page tampering before advancing any fact or cursor', async kind => {
    const f = await fixture(); const pin = await startRecovery(f);
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    const page = recoveryPage(pin, kind === 'repeat' ? [raw, raw] : [raw], kind === 'account' ? { accountId: 'acct_Other' }
      : kind === 'tenant' ? { organizationId: randomUUID() } : kind === 'mode' ? { livemode: true }
        : kind === 'window' ? { createdBefore: T0 + 300 } : kind === 'cycle' ? { hasMore: true, nextCursor: 'bad' } : {});
    if (kind === 'provenance') (page as { evidenceRef: string }).evidenceRef = 'stripe-billing-page:bad';
    await expect(applyPage(pin, page)).rejects.toThrow('invalid_page');
    expect(await recoveryCheckpoint(f)).toEqual(pin); expect(await recoveryReceipt(parsed(raw).eventId)).toBeNull();
  });

  it('detects a cursor cycle across pages, including pages that contain no selected customer events', async () => {
    const f = await fixture(); const pin = await startRecovery(f);
    const a = (await applyPage(pin, recoveryPage(pin, [], { hasMore: true, nextCursor: 'evt_PageA' }))).checkpoint;
    const b = (await applyPage(a, recoveryPage(a, [], { hasMore: true, nextCursor: 'evt_PageB' }))).checkpoint;
    await expect(applyPage(b, recoveryPage(b, [], { hasMore: true, nextCursor: 'evt_PageA' }))).rejects.toThrow('invalid_page');
    expect(await recoveryCheckpoint(f)).toEqual(b);
  });

  it('rejects altered provider facts for an existing signed event without overwriting the signed body digest', async () => {
    const f = await fixture(); const id = `evt_${hex()}`;
    const raw = subscriptionJson(f, { id, created: T0, status: 'active' }); await deliver(store(), raw);
    const pin = await startRecovery(f);
    await expect(applyPage(pin, recoveryPage(pin, [subscriptionJson(f, { id, created: T0, status: 'canceled' })]))).rejects.toThrow('event_mismatch');
    expect(await recoveryReceipt(id)).toMatchObject({ body_digest: webhookBodyDigest(raw), api_observation: null });
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'active' }); expect(await recoveryCheckpoint(f)).toEqual(pin);
  });

  it.each(['accountId', 'apiObjectDigest', 'factDigest', 'observedAtMs', 'evidenceRef'])('fails closed on a null API provenance field %s even through direct SQL', async field => {
    const provenance = { source: 'stripe-authenticated-api', accountId: 'acct_Recovery', apiObjectDigest: 'a'.repeat(64),
      factDigest: 'b'.repeat(64), observedAtMs: Date.now(), requestIds: ['req_A', 'req_B', 'req_C'],
      evidenceRef: `stripe-billing-page:${'c'.repeat(64)}`, [field]: null };
    await expect(runService(async sql => sql`INSERT INTO papercusp_auth.hosted_billing_webhook_events
      (provider_event_id, event_type, body_digest, livemode, outcome, api_observation)
      VALUES (${`evt_${hex()}`}, 'customer.subscription.updated', NULL, false, 'ignored', ${sql.json(provenance)})`))
      .rejects.toThrow('hosted_billing_api_observation_ck');
  });

  it.each(['accountId', 'organizationId', 'customerId', 'livemode', 'revision', 'createdFrom', 'createdBefore', 'complete'])('fails closed on null checkpoint field %s', async field => {
    const f = await fixture(); const pin = await startRecovery(f);
    await expect(runService(async sql => sql`UPDATE papercusp_auth.hosted_billing_customers
      SET reconciliation_checkpoint = ${sql.json({ ...pin, cursors: [], [field]: null })}
      WHERE organization_id = ${f.organizationId}::uuid`)).rejects.toThrow('hosted_billing_reconciliation_checkpoint_ck');
    expect(await recoveryCheckpoint(f)).toEqual(pin);
  });

  it('grants the billing tables to hosted_service only — the tenant-facing hosted_app role cannot read them', async () => {
    // Switch from the superuser so the ROLE switch itself always succeeds: the
    // denial must come from the table grant, not from "permission denied to set role".
    for (const table of ['hosted_billing_customers', 'hosted_subscriptions', 'hosted_billing_webhook_events']) {
      const denied = db.adminSql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE hosted_app');
        return tx.unsafe(`SELECT count(*) FROM papercusp_auth.${table}`);
      });
      await expect(denied).rejects.toThrow(new RegExp(`permission denied for table ${table}`));
    }
  });
});
