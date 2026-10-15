import { describe, expect, it } from 'vitest';

import { reduceLedger, type LedgerState, type Money } from './commerce-ledger';
import type { CreatorProfile, Installation, Organization, SeatPolicy } from './commerce-accounts';
import {
  auditExport,
  checkoutDashboard,
  commerceCatalogDashboard,
  identityUsageStatement,
  refundDashboard,
  sumMoney,
  supportDashboard,
} from './commerce-dashboards';
import { identityPerUseOfferTerms, quoteIdentityInferenceTurn } from './identity-per-use-offer';
import type { UsageReceiptWire } from './metered-invocation-door-io';
import { settleRevenue } from '../p2p/revenue-settlement';

describe('identity usage statement (P-018)', () => {
  const offered = identityPerUseOfferTerms({ identity: { id: 'analyst', version: '1.0.0' },
    markupBps: 2500, componentBps: 3000, componentDependencies: [
      { packageKind: 'blueprint', ref: 'base', revision: '1', contentHash: 'a'.repeat(64), author: 'alice' },
      { packageKind: 'rule', ref: 'review', revision: '1', contentHash: 'b'.repeat(64), author: 'bob' },
    ] });
  if (!offered.ok) throw new Error(offered.detail);
  const receipt = (overrides: Partial<UsageReceiptWire> = {}, billed = 999n): UsageReceiptWire => {
    const q = quoteIdentityInferenceTurn({ offer: offered.terms, billedInferenceMicros: billed,
      inferenceCeilingMicros: 1000n, priorRemainderNumerator: 0n });
    if (!q.ok) throw new Error(q.detail);
    return { channelId: 'c1', usageNonce: 'turn1', offerId: 'o1', payer: 'buyer', seller: 'seller',
      releaseRef: offered.terms.skuRef, meterUnit: offered.terms.meterUnit,
      meterQuantity: q.reservationQuantity.toString(), unitPriceMicros: String(offered.terms.unitPriceMicros),
      priceVersion: offered.terms.priceVersion, splitManifestHash: offered.terms.splitManifestHash,
      reservedMicros: q.reservedMarkupMicros.toString(), amountMicros: q.amountMicros.toString(),
      cumulativeClaimMicros: '250', expiresAtMs: 3000, voucherDigest: 'digest', voucherSignature: 'payer-signature',
      receiptSignature: 'seller-signature', state: 'settled', reservedAtMs: 1000, settledAtMs: 2000,
      identityInference: { ceilingMicros: '1000', billedInferenceMicros: billed.toString(),
        priorRemainderNumerator: '0', remainderNumerator: q.remainderNumerator.toString() }, ...overrides };
  };

  it('states sub-cent BYOC base, markup and component quotes without claiming payout or inventing outcome success', () => {
    const statement = identityUsageStatement([receipt()], 'buyer');
    expect(statement).toMatchObject({ basis: 'hosted-settled-usage', chainFinality: 'not-measured',
      allocationBasis: 'per-receipt-quote', markupMicros: '249', complete: true, issues: [],
      costPerAcceptedOutcomeMicros: null, outcomeEvidence: 'unavailable' });
    expect(statement.lines[0]).toMatchObject({ billedInferenceMicros: '999', markupMicros: '249',
      allocationQuote: { creatorMicros: '149', daoMicros: '26', componentMicros: '74',
        componentAuthorsMicros: { alice: '37', bob: '37' } } });
    const settled = settleRevenue({ settlementId: 'batch', grossMicros: 249n, providerCostMicros: 0n,
      splitManifest: offered.manifest, daoTreasury: 'actual-treasury' });
    if (!settled.ok) throw new Error(settled.detail);
    expect(settled.receipt.allocationsMicros.dao.toString()).toBe(statement.lines[0]!.allocationQuote.daoMicros);
    expect(JSON.parse(JSON.stringify(statement))).toEqual(statement);
  });

  it('does not add the repeated inference base of stacked identities to markup charges', () => {
    const statement = identityUsageStatement([receipt(), receipt({ usageNonce: 'turn2', offerId: 'o2' })], 'buyer');
    expect(statement.markupMicros).toBe('498');
    expect(statement.lines.map((line) => line.billedInferenceMicros)).toEqual(['999', '999']);
    expect(statement).not.toHaveProperty('totalInferenceMicros');
  });

  it('shows identical buyer/seller lines and never exposes third-party rows or issues', () => {
    const own = receipt(), foreign = receipt({ payer: 'other-buyer', seller: 'other-seller', usageNonce: 'foreign', amountMicros: '-1' });
    expect(identityUsageStatement([own, foreign], 'buyer')).toEqual(identityUsageStatement([own], 'seller'));
    expect(identityUsageStatement([own, foreign], 'stranger')).toMatchObject({ lines: [], markupMicros: '0', issues: [] });
  });

  it('deduplicates exact retries and refuses both orders of a conflicting nonce', () => {
    const own = receipt(), changed = receipt({ amountMicros: '250' });
    expect(identityUsageStatement([own, own], 'buyer').markupMicros).toBe('249');
    for (const rows of [[own, changed], [changed, own]]) {
      expect(identityUsageStatement(rows, 'buyer')).toMatchObject({ lines: [], markupMicros: '0', complete: false,
        issues: [{ reason: 'conflicting-receipt' }] });
    }
  });

  it('keeps pending reservations out of inferred cost and charges', () => {
    const pending = receipt({ state: 'reserved', amountMicros: null, receiptSignature: null, settledAtMs: null,
      identityInference: { ceilingMicros: '1000', billedInferenceMicros: null, priorRemainderNumerator: null, remainderNumerator: null } });
    expect(identityUsageStatement([pending], 'buyer')).toMatchObject({ lines: [], markupMicros: '0', reservedReceipts: 1 });
  });

  it.each([
    { amountMicros: '250' }, { reservedMicros: '249' }, { meterQuantity: '2' },
    { splitManifestHash: 'substitution' }, { priceVersion: 'different-price' },
    { identityInference: { ceilingMicros: '1000', billedInferenceMicros: '1001', priorRemainderNumerator: '0', remainderNumerator: '7500' } },
    { identityInference: { ceilingMicros: '1000', billedInferenceMicros: '999', priorRemainderNumerator: '0', remainderNumerator: '0' } },
  ])('refuses inconsistent recorded terms or quote %j', (overrides) => {
    expect(identityUsageStatement([receipt(overrides)], 'buyer')).toMatchObject({ lines: [], complete: false,
      issues: [{ reason: 'identity-quote-mismatch' }] });
  });

  it.each([{ amountMicros: '0249' }, { receiptSignature: null }, { identityInference: undefined },
    { settledAtMs: 999 }, { unitPriceMicros: '9007199254740992' }])('keeps incomplete evidence visible %j', (overrides) => {
    expect(identityUsageStatement([receipt(overrides)], 'buyer')).toMatchObject({ complete: false, lines: [],
      issues: [{ reason: 'incomplete-identity-receipt' }] });
  });

  it('preserves a recorded zero cost and produces stable receipt order', () => {
    const zero = receipt({ usageNonce: 'a' }, 0n), paid = receipt({ usageNonce: 'z' });
    expect(identityUsageStatement([paid, zero], 'buyer')).toEqual(identityUsageStatement([zero, paid], 'buyer'));
    expect(identityUsageStatement([zero], 'buyer').lines[0]).toMatchObject({ billedInferenceMicros: '0', markupMicros: '0' });
  });
});

// ---------------------------------------------------------------------------
// Fixtures — built through the REAL reducer, not hand-written state literals.
// A projection tested only against hand-built state cannot notice P-010
// changing the shape it actually emits.
// ---------------------------------------------------------------------------

const USD = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

let seq = 0;
function ev(kind: string, payload: Record<string, unknown>, occurredAtMs = 1_000 + seq * 10) {
  seq += 1;
  return {
    ledgerEventId: `e-${seq}`,
    kind,
    occurredAtMs,
    source: { provider: 'stripe', providerEventId: null },
    payload,
  };
}

/** One creator, one product, one $50 offer, one paid order by `buyer`. */
function baseEvents(buyer = 'org-acme') {
  seq = 0;
  return [
    ev('product.defined', { productId: 'prod-1', skuRef: 'sku-1', creatorId: 'creator-1', title: 'Widget' }),
    ev('offer.defined', { offerId: 'offer-1', productId: 'prod-1', pricingModel: 'one-time', price: USD(5000) }),
    ev('order.created', { orderId: 'ord-1', offerId: 'offer-1', buyerId: buyer }),
    ev('order.paid', { orderId: 'ord-1' }),
  ];
}

function ledgerOf(events: readonly unknown[]): LedgerState {
  return reduceLedger(events);
}

const ACME: Organization = {
  orgId: 'org-acme',
  displayName: 'Acme',
  memberships: [
    { userId: 'alice', role: 'owner', addedAtMs: 1 },
    { userId: 'bob', role: 'member', addedAtMs: 2 },
  ],
};
const ORGS = new Map<string, Organization>([[ACME.orgId, ACME]]);
const TWO_SEATS = new Map<string, SeatPolicy>([['offer-1', { offerId: 'offer-1', seats: 2 }]]);

function install(overrides: Partial<Installation> = {}): Installation {
  return {
    installationId: 'inst-1',
    entitlementId: 'ent:ord-1',
    holderId: 'alice',
    deviceRef: 'dev-1',
    state: 'active',
    allocatedAtMs: 2_000,
    releasedAtMs: null,
    ...overrides,
  };
}

// The entitlement id the reducer mints is derived, not guessed — assert it once
// so every fixture below that hardcodes it fails loudly if the rule changes.
it('fixture: the reducer mints the entitlement id these tests assume', () => {
  const ledger = ledgerOf(baseEvents());
  expect([...ledger.entitlements.keys()]).toEqual(['ent:ord-1']);
});

// ---------------------------------------------------------------------------
// Rail 1 — money never silently aggregates across currencies
// ---------------------------------------------------------------------------

describe('sumMoney', () => {
  it('sums a single-currency set', () => {
    const sum = sumMoney([USD(100), USD(250)], 'USD');
    expect(sum).toEqual({ ok: true, total: { amountMinor: 350, currency: 'USD' } });
  });

  it('returns a typed zero for an empty set rather than an untyped 0', () => {
    expect(sumMoney([], 'JPY')).toEqual({ ok: true, total: { amountMinor: 0, currency: 'JPY' } });
  });

  it('REFUSES a mixed-currency set instead of adding minor units', () => {
    const sum = sumMoney([USD(100), { amountMinor: 100, currency: 'JPY' }], 'USD');
    expect(sum.ok).toBe(false);
    if (sum.ok) throw new Error('unreachable');
    expect(sum.code).toBe('currency-mismatch');
    expect(sum.detail).toContain('JPY');
  });

  it('a mixed-currency buyer gets zeroed totals AND a stated reason, never a bogus number', () => {
    seq = 0;
    const ledger = ledgerOf([
      ...baseEvents('buyer-1'),
      ev('product.defined', { productId: 'prod-2', skuRef: 'sku-2', creatorId: 'creator-1', title: 'Yen thing' }),
      ev('offer.defined', {
        offerId: 'offer-2',
        productId: 'prod-2',
        pricingModel: 'one-time',
        price: { amountMinor: 900, currency: 'JPY' },
      }),
      ev('order.created', { orderId: 'ord-2', offerId: 'offer-2', buyerId: 'buyer-1' }),
      ev('order.paid', { orderId: 'ord-2' }),
    ]);

    const view = checkoutDashboard({
      buyerId: 'buyer-1',
      ledger,
      orgs: ORGS,
      seatPolicies: TWO_SEATS,
      installations: [],
      currency: 'USD',
    });

    expect(view.currencyMismatch).toContain('JPY');
    expect(view.grossMinor).toBe(0);
    expect(view.netMinor).toBe(0);
    // The lines themselves are still reported — the refusal is on AGGREGATION.
    expect(view.lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Checkout dashboard
// ---------------------------------------------------------------------------

describe('checkoutDashboard', () => {
  it('projects the purchase with its entitlement and seat usage', () => {
    const ledger = ledgerOf(baseEvents());
    const view = checkoutDashboard({
      buyerId: 'org-acme',
      ledger,
      orgs: ORGS,
      seatPolicies: TWO_SEATS,
      installations: [install()],
      currency: 'USD',
    });

    expect(view.principal.kind).toBe('organization');
    expect(view.lines).toHaveLength(1);
    const line = view.lines[0];
    expect(line.orderState).toBe('paid');
    expect(line.productTitle).toBe('Widget');
    expect(line.pricingModel).toBe('one-time');
    expect(line.perUse).toBeNull();
    expect(line.entitlementId).toBe('ent:ord-1');
    expect(line.entitlementState).toBe('active');
    expect(line.seats).toEqual({ granted: 2, used: 1, available: 1 });
    expect(view.grossMinor).toBe(5000);
    expect(view.netMinor).toBe(5000);
  });

  it('keeps exact per-use terms on catalog and checkout projections', () => {
    const splitManifestHash = `sha256:${'a'.repeat(64)}`;
    const ledger = ledgerOf([
      ev('product.defined', {
        productId: 'prod-use',
        skuRef: 'sku-use',
        creatorId: 'creator-1',
        title: 'Metered tool',
      }),
      ev('offer.defined', {
        offerId: 'offer-use',
        productId: 'prod-use',
        pricingModel: 'per-use',
        price: USD(0),
        perUse: {
          unitPriceMicros: 25,
          meterUnit: 'tool-call',
          priceVersion: 'price-v1',
          splitManifestHash,
        },
      }),
      ev('order.created', {
        orderId: 'ord-use',
        offerId: 'offer-use',
        buyerId: 'org-acme',
      }),
    ]);

    expect(commerceCatalogDashboard(ledger)).toEqual([
      expect.objectContaining({
        offerId: 'offer-use',
        pricingModel: 'per-use',
        perUse: {
          unitPriceMicros: 25,
          meterUnit: 'tool-call',
          priceVersion: 'price-v1',
          splitManifestHash,
        },
      }),
    ]);

    const checkout = checkoutDashboard({
      buyerId: 'org-acme',
      ledger,
      orgs: ORGS,
      seatPolicies: new Map(),
      installations: [],
      currency: 'USD',
    });
    expect(checkout.lines[0].perUse?.priceVersion).toBe('price-v1');
  });

  it('an offer with no seat policy is single-seat', () => {
    const ledger = ledgerOf(baseEvents());
    const view = checkoutDashboard({
      buyerId: 'org-acme',
      ledger,
      orgs: ORGS,
      seatPolicies: new Map(),
      installations: [],
      currency: 'USD',
    });
    expect(view.lines[0].seats).toEqual({ granted: 1, used: 0, available: 1 });
  });

  it('REPORTS a refund-revoked entitlement rather than hiding the line', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'ord-1', amount: USD(5000) }),
    ]);
    const view = checkoutDashboard({
      buyerId: 'org-acme',
      ledger,
      orgs: ORGS,
      seatPolicies: TWO_SEATS,
      installations: [],
      currency: 'USD',
    });

    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].orderState).toBe('refunded');
    expect(view.lines[0].entitlementState).toBe('revoked');
    // The money is still counted gross, net nets out — an invisible line would
    // make a paid-then-refunded purchase look like it never happened.
    expect(view.grossMinor).toBe(5000);
    expect(view.refundedMinor).toBe(5000);
    expect(view.netMinor).toBe(0);
  });

  it('excludes a failed order from the totals but still lists it', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('order.created', { orderId: 'ord-fail', offerId: 'offer-1', buyerId: 'org-acme' }),
      ev('order.failed', { orderId: 'ord-fail' }),
    ]);
    const view = checkoutDashboard({
      buyerId: 'org-acme',
      ledger,
      orgs: ORGS,
      seatPolicies: TWO_SEATS,
      installations: [],
      currency: 'USD',
    });
    expect(view.lines).toHaveLength(2);
    expect(view.grossMinor).toBe(5000);
  });

  it("never leaks another buyer's orders", () => {
    const ledger = ledgerOf([
      ...baseEvents('buyer-a'),
      ev('order.created', { orderId: 'ord-b', offerId: 'offer-1', buyerId: 'buyer-b' }),
      ev('order.paid', { orderId: 'ord-b' }),
    ]);
    const view = checkoutDashboard({
      buyerId: 'buyer-a',
      ledger,
      orgs: ORGS,
      seatPolicies: TWO_SEATS,
      installations: [],
      currency: 'USD',
    });
    expect(view.lines.map((l) => l.orderId)).toEqual(['ord-1']);
  });
});

// ---------------------------------------------------------------------------
// Rail 2 — refundability subtracts refunds still in flight
// ---------------------------------------------------------------------------

describe('refundDashboard', () => {
  it('reports the full amount refundable when nothing is in flight', () => {
    const ledger = ledgerOf(baseEvents());
    const [pos] = refundDashboard({ ledger, installations: [] });
    expect(pos.settledMinor).toBe(0);
    expect(pos.pendingMinor).toBe(0);
    expect(pos.refundableMinor).toBe(5000);
  });

  it('SUBTRACTS a pending refund the ledger has not settled yet', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('refund.requested', { refundId: 'ref-1', orderId: 'ord-1', amount: USD(2000) }),
    ]);
    const [pos] = refundDashboard({ ledger, installations: [] });

    // The ledger's own figure is still 0 — money has not moved.
    expect(ledger.orders.get('ord-1')!.refundedMinor).toBe(0);
    expect(pos.settledMinor).toBe(0);
    expect(pos.pendingMinor).toBe(2000);
    // Reporting 5000 here is what sends a second operator to refund the
    // remainder; the conservative figure is the whole point of this rail.
    expect(pos.refundableMinor).toBe(3000);
  });

  it('a pending FULL refund leaves nothing refundable', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('refund.requested', { refundId: 'ref-1', orderId: 'ord-1', amount: USD(5000) }),
    ]);
    const [pos] = refundDashboard({ ledger, installations: [] });
    expect(pos.refundableMinor).toBe(0);
  });

  it('holds at zero once a second full refund is REFUSED at request time', () => {
    // This test was filed (EI-22438759043480870) as proof-by-execution that the
    // reducer accepted TWO full-amount pending refunds, because `refund.requested`
    // validated against `Order.refundedMinor`, which only advances on
    // `refund.succeeded`. That defect is FIXED in P-010: capacity is now
    // settled + RESERVED, so the second request is refused where it is still
    // actionable rather than at settlement, on a refund already promised.
    //
    // The dashboard rail this test guards is unchanged and still load-bearing:
    // `refundableMinor` is computed from settled + pending, never from
    // `refundedMinor` alone, so a refund in flight is never reported refundable.
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('refund.requested', { refundId: 'ref-1', orderId: 'ord-1', amount: USD(5000) }),
      ev('refund.requested', { refundId: 'ref-2', orderId: 'ord-1', amount: USD(5000) }),
    ]);
    expect(ledger.rejected.map((r) => r.code)).toEqual(['refund-exceeds-order']);
    expect(ledger.refunds.size).toBe(1);
    expect(ledger.orders.get('ord-1')!.refundedMinor).toBe(0);

    const [pos] = refundDashboard({ ledger, installations: [] });
    expect(pos.pendingMinor).toBe(5000);
    expect(pos.refundableMinor).toBe(0);
  });

  it('a FAILED refund frees its amount again', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('refund.requested', { refundId: 'ref-1', orderId: 'ord-1', amount: USD(2000) }),
      ev('refund.failed', { refundId: 'ref-1' }),
    ]);
    const [pos] = refundDashboard({ ledger, installations: [] });
    expect(pos.pendingMinor).toBe(0);
    expect(pos.refundableMinor).toBe(5000);
  });

  it('settled and pending compose without double-counting', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'ord-1', amount: USD(1000) }),
      ev('refund.requested', { refundId: 'ref-2', orderId: 'ord-1', amount: USD(1500) }),
    ]);
    const [pos] = refundDashboard({ ledger, installations: [] });
    expect(pos.settledMinor).toBe(1000);
    expect(pos.pendingMinor).toBe(1500);
    expect(pos.refundableMinor).toBe(2500);
    expect(pos.orderState).toBe('partially-refunded');
  });

  it('never reports a negative remainder', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'ord-1', amount: USD(5000) }),
    ]);
    const [pos] = refundDashboard({ ledger, installations: [] });
    expect(pos.refundableMinor).toBe(0);
  });

  it('reports revocation blast radius as D-042 defines it — repair survives', () => {
    const ledger = ledgerOf(baseEvents());
    const [pos] = refundDashboard({ ledger, installations: [install()] });
    expect(pos.activeInstallations).toBe(1);
    expect(pos.intentsSurvivingRevocation).toEqual(['repair']);
  });

  it('a released installation is not counted as blast radius', () => {
    const ledger = ledgerOf(baseEvents());
    const [pos] = refundDashboard({
      ledger,
      installations: [install({ state: 'released', releasedAtMs: 3_000 })],
    });
    expect(pos.activeInstallations).toBe(0);
    expect(pos.intentsSurvivingRevocation).toEqual([]);
  });

  it('scopes to one buyer when asked', () => {
    const ledger = ledgerOf([
      ...baseEvents('buyer-a'),
      ev('order.created', { orderId: 'ord-b', offerId: 'offer-1', buyerId: 'buyer-b' }),
      ev('order.paid', { orderId: 'ord-b' }),
    ]);
    expect(refundDashboard({ ledger, installations: [] })).toHaveLength(2);
    expect(refundDashboard({ ledger, installations: [], buyerId: 'buyer-b' }).map((p) => p.orderId)).toEqual([
      'ord-b',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Support dashboard
// ---------------------------------------------------------------------------

describe('supportDashboard', () => {
  const common = {
    buyerId: 'org-acme',
    orgs: ORGS,
    seatPolicies: TWO_SEATS,
  };

  it('clears a member with a free seat', () => {
    const ledger = ledgerOf(baseEvents());
    const view = supportDashboard({
      ...common,
      userId: 'bob',
      intent: 'install',
      ledger,
      installations: [],
    });
    expect(view.orgRole).toBe('member');
    expect(view.entitled).toBe(true);
    expect(view.findings[0].blocked).toBeNull();
    expect(view.anyPermitted).toBe(true);
  });

  it('blocks a NON-MEMBER before it ever mentions seats', () => {
    const ledger = ledgerOf(baseEvents());
    const view = supportDashboard({
      ...common,
      userId: 'mallory',
      intent: 'install',
      ledger,
      installations: [],
    });
    expect(view.entitled).toBe(false);
    expect(view.orgRole).toBeNull();
    // The ordering rail: "no seats available" would send an admin to buy seats
    // that could not possibly help someone who is not in the org.
    expect(view.findings[0].blocked?.code).toBe('not-entitled');
  });

  it('blocks on capacity only once membership is established', () => {
    const ledger = ledgerOf(baseEvents());
    const view = supportDashboard({
      ...common,
      userId: 'bob',
      intent: 'install',
      ledger,
      installations: [
        install({ installationId: 'i-1', holderId: 'alice', deviceRef: 'd1' }),
        install({ installationId: 'i-2', holderId: 'carol', deviceRef: 'd2' }),
      ],
    });
    expect(view.findings[0].blocked?.code).toBe('no-seats-available');
    expect(view.findings[0].seats).toEqual({ granted: 2, used: 2, available: 0 });
  });

  it('DELEGATES the revoked-entitlement verdict to the shared D-042 rule', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('refund.succeeded', { refundId: 'ref-1', orderId: 'ord-1', amount: USD(5000) }),
    ]);
    const installations = [install({ holderId: 'alice' })];

    const update = supportDashboard({
      ...common,
      userId: 'alice',
      intent: 'update',
      ledger,
      installations,
    });
    expect(update.findings[0].blocked?.code).toBe('entitlement-revoked');
    expect(update.anyPermitted).toBe(false);

    // Same state, same user, different intent: repair still works. If this
    // pair ever disagrees with authorizeSeatIntent, the two doors have forked.
    const repair = supportDashboard({
      ...common,
      userId: 'alice',
      intent: 'repair',
      ledger,
      installations,
    });
    expect(repair.findings[0].blocked).toBeNull();
    expect(repair.anyPermitted).toBe(true);
  });

  it('a released installation blocks even before revocation is considered', () => {
    const ledger = ledgerOf(baseEvents());
    const view = supportDashboard({
      ...common,
      userId: 'alice',
      intent: 'repair',
      ledger,
      installations: [install({ state: 'released', releasedAtMs: 5_000 })],
    });
    expect(view.findings[0].blocked?.code).toBe('installation-released');
  });

  it('reports no findings at all when the buyer owns nothing', () => {
    const ledger = ledgerOf(baseEvents('someone-else'));
    const view = supportDashboard({
      ...common,
      userId: 'alice',
      intent: 'install',
      ledger,
      installations: [],
    });
    expect(view.findings).toEqual([]);
    expect(view.anyPermitted).toBe(false);
  });

  it('an individual buyer entitles only themselves', () => {
    const ledger = ledgerOf(baseEvents('alice'));
    const mine = supportDashboard({
      ...common,
      buyerId: 'alice',
      userId: 'alice',
      intent: 'install',
      ledger,
      installations: [],
    });
    expect(mine.principal.kind).toBe('individual');
    expect(mine.findings[0].blocked).toBeNull();

    const theirs = supportDashboard({
      ...common,
      buyerId: 'alice',
      userId: 'bob',
      intent: 'install',
      ledger,
      installations: [],
    });
    expect(theirs.findings[0].blocked?.code).toBe('not-entitled');
  });
});

// ---------------------------------------------------------------------------
// Rail 3 — the audit export carries rejections, and is reproducible
// ---------------------------------------------------------------------------

describe('auditExport', () => {
  const PROFILES = new Map<string, CreatorProfile>([
    [
      'creator-1',
      {
        creatorId: 'creator-1',
        displayName: 'Creator One',
        payout: { provider: 'stripe', externalRef: 'acct_1', verifiedAtMs: 10 },
      },
    ],
  ]);

  it('exports every family sorted by id, so two replicas compare directly', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('order.created', { orderId: 'ord-0', offerId: 'offer-1', buyerId: 'org-acme' }),
      ev('order.paid', { orderId: 'ord-0' }),
    ]);
    const out = auditExport({
      ledger,
      installations: [install({ installationId: 'inst-z' }), install({ installationId: 'inst-a' })],
      orgs: ORGS,
      creatorProfiles: PROFILES,
    });

    expect(out.schema).toBe('cupboard.audit.v1');
    expect(out.products.map((p) => p.productId)).toEqual(['prod-1']);
    expect(out.offers.map((o) => o.offerId)).toEqual(['offer-1']);
    expect(out.orders.map((o) => o.orderId)).toEqual(['ord-0', 'ord-1']);
    expect(out.entitlements.map((e) => e.entitlementId)).toEqual(['ent:ord-0', 'ent:ord-1']);
    expect(out.installations.map((i) => i.installationId)).toEqual(['inst-a', 'inst-z']);
    expect(out.organizations).toEqual([{ orgId: 'org-acme', memberCount: 2 }]);
  });

  it('is byte-stable under input reordering', () => {
    const ledger = ledgerOf(baseEvents());
    const a = auditExport({
      ledger,
      installations: [install({ installationId: 'i-1' }), install({ installationId: 'i-2' })],
      orgs: ORGS,
      creatorProfiles: PROFILES,
    });
    const b = auditExport({
      ledger,
      installations: [install({ installationId: 'i-2' }), install({ installationId: 'i-1' })],
      orgs: ORGS,
      creatorProfiles: PROFILES,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('CARRIES rejections rather than exporting a clean-looking ledger', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      // Refund more than was ever paid — the reducer rejects it.
      ev('refund.succeeded', { refundId: 'ref-x', orderId: 'ord-1', amount: USD(999_999) }),
    ]);
    expect(ledger.rejected.length).toBeGreaterThan(0);

    const out = auditExport({ ledger, installations: [], orgs: ORGS, creatorProfiles: PROFILES });
    expect(out.integrity.rejectedCount).toBe(ledger.rejected.length);
    expect(out.integrity.rejections).toEqual(ledger.rejected);
    expect(out.integrity.rejectionCodes).toContain('refund-exceeds-order');
    // The refund never entered the books.
    expect(out.refunds).toEqual([]);
  });

  it('counts exact duplicate replays separately from applied events', () => {
    const events = baseEvents();
    const ledger = ledgerOf([...events, events[3]]);
    const out = auditExport({ ledger, installations: [], orgs: ORGS, creatorProfiles: PROFILES });
    expect(out.integrity.appliedCount).toBe(4);
    expect(out.integrity.duplicateCount).toBe(1);
    expect(out.integrity.rejectedCount).toBe(0);
  });

  it('flags a payout whose creator cannot actually be paid', () => {
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(4000) }),
      ev('payout.created', { payoutId: 'po-2', creatorId: 'creator-ghost', amount: USD(100) }),
    ]);
    const out = auditExport({ ledger, installations: [], orgs: ORGS, creatorProfiles: PROFILES });

    const byId = new Map(out.payouts.map((p) => [p.payoutId, p]));
    expect(byId.get('po-1')).toMatchObject({ payoutReady: true, payoutBlockCode: null });
    expect(byId.get('po-2')).toMatchObject({ payoutReady: false, payoutBlockCode: 'no-profile' });
  });

  it('flags an unverified payout destination before money is meant to move', () => {
    const unverified = new Map<string, CreatorProfile>([
      [
        'creator-1',
        {
          creatorId: 'creator-1',
          displayName: 'Creator One',
          payout: { provider: 'stripe', externalRef: 'acct_1', verifiedAtMs: null },
        },
      ],
    ]);
    const ledger = ledgerOf([
      ...baseEvents(),
      ev('payout.created', { payoutId: 'po-1', creatorId: 'creator-1', amount: USD(4000) }),
    ]);
    const out = auditExport({ ledger, installations: [], orgs: ORGS, creatorProfiles: unverified });
    expect(out.payouts[0]).toMatchObject({ payoutReady: false, payoutBlockCode: 'payout-unverified' });
  });
});

// ---------------------------------------------------------------------------
// Purity — a dashboard that could change what it reports is not a dashboard
// ---------------------------------------------------------------------------

describe('projection purity', () => {
  it('no dashboard mutates the ledger it reads', () => {
    const ledger = ledgerOf(baseEvents());
    const before = JSON.stringify({
      orders: [...ledger.orders.values()],
      entitlements: [...ledger.entitlements.values()],
      refunds: [...ledger.refunds.values()],
      applied: ledger.applied,
      rejected: ledger.rejected,
    });
    const installations = [install()];

    checkoutDashboard({
      buyerId: 'org-acme',
      ledger,
      orgs: ORGS,
      seatPolicies: TWO_SEATS,
      installations,
      currency: 'USD',
    });
    refundDashboard({ ledger, installations });
    supportDashboard({
      userId: 'alice',
      buyerId: 'org-acme',
      intent: 'install',
      ledger,
      orgs: ORGS,
      seatPolicies: TWO_SEATS,
      installations,
    });
    auditExport({ ledger, installations, orgs: ORGS, creatorProfiles: new Map() });

    expect(
      JSON.stringify({
        orders: [...ledger.orders.values()],
        entitlements: [...ledger.entitlements.values()],
        refunds: [...ledger.refunds.values()],
        applied: ledger.applied,
        rejected: ledger.rejected,
      }),
    ).toBe(before);
    // and the caller's installation array is untouched
    expect(installations).toHaveLength(1);
    expect(installations[0].state).toBe('active');
  });
});
