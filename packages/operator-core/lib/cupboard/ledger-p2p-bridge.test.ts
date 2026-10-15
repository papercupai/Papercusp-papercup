import { describe, expect, it } from 'vitest';

import { reduceCommerceEvents, type CommerceEvent } from '../p2p/commerce-events';

import { entitlementIdFor, reduceLedger } from './commerce-ledger';
import type { EntitlementGrant, EntitlementProjection } from './entitled-delivery';
import {
  bridgeCommerceEventsToLedger,
  bridgeFromCommerceEntitlements,
  mergeEntitlementProjections,
  perUseDashboard,
  perUseRollup,
} from './ledger-p2p-bridge';

const STREAM = 'stream-acme';
const SPLIT_HASH = `sha256:${'a'.repeat(64)}`;

let nextSequence = 0;

function event(
  kind: CommerceEvent['kind'],
  payload: Record<string, unknown>,
  overrides: Partial<CommerceEvent> = {},
): CommerceEvent {
  const sequence = overrides.sequence ?? nextSequence++;
  return {
    eventId: overrides.eventId ?? `${kind}-${sequence}`,
    streamId: overrides.streamId ?? STREAM,
    kind,
    version: 1,
    issuer: overrides.issuer ?? 'seller-key',
    sequence,
    occurredAtMs: overrides.occurredAtMs ?? 1_000 + sequence,
    idempotencyKey: overrides.idempotencyKey ?? `${kind}-${sequence}`,
    payload,
    signature: overrides.signature ?? 'c2ln',
  };
}

function offerEvent(overrides: Record<string, unknown> = {}): CommerceEvent {
  return event('offer', {
    productId: 'prod-1',
    offerId: 'offer-1',
    skuRef: 'sku-1',
    creatorId: 'creator-1',
    title: 'Widget',
    pricingModel: 'per-use',
    price: { amountMinor: 0, currency: 'USD' },
    perUse: {
      unitPriceMicros: 500,
      meterUnit: 'call',
      priceVersion: 'v1',
      splitManifestHash: SPLIT_HASH,
    },
    ...overrides,
  });
}

/** Bridge a batch the way production does: reduce first, bridge only `accepted`. */
function bridge(events: readonly CommerceEvent[]) {
  return bridgeCommerceEventsToLedger(reduceCommerceEvents(events).accepted);
}

function grant(overrides: Partial<EntitlementGrant> = {}): EntitlementGrant {
  return {
    entitlementId: 'ent-1',
    subject: 'acme',
    releaseRef: 'plugin:widget:1.0.0',
    grantedAtMs: 1_000,
    expiresAtMs: null,
    keyVersion: null,
    revokedAtMs: null,
    revokedReason: null,
    ...overrides,
  };
}

function projection(grants: readonly EntitlementGrant[]): EntitlementProjection {
  return {
    grants: new Map(grants.map((g) => [`${g.subject}\n${g.releaseRef}`, g])),
    unusable: [],
  };
}

describe('bridgeCommerceEventsToLedger', () => {
  it('defines the product before the offer that depends on it, even at one timestamp', () => {
    const bridged = bridge([offerEvent()]);
    const state = reduceLedger(bridged.ledgerEvents);

    // The precondition is what this asserts: `offer.defined` is rejected
    // `unknown-product` unless `product.defined` folds first, and both events
    // carry the SAME occurredAtMs, so only the id ordering can separate them.
    expect(state.rejected).toEqual([]);
    expect(state.products.get('prod-1')?.title).toBe('Widget');
    expect(state.offers.get('offer-1')?.pricingModel).toBe('per-use');
    expect(state.offers.get('offer-1')?.perUse?.unitPriceMicros).toBe(500);
  });

  it('carries a paid order through to an active ledger entitlement', () => {
    const bridged = bridge([
      offerEvent({ pricingModel: 'one-time', price: { amountMinor: 2_500, currency: 'USD' }, perUse: null }),
      event('order', { orderId: 'ord-1', offerId: 'offer-1', buyerId: 'acme', paid: true }),
    ]);
    const state = reduceLedger(bridged.ledgerEvents);

    expect(state.rejected).toEqual([]);
    expect(state.orders.get('ord-1')?.state).toBe('paid');
    expect(state.entitlements.get(entitlementIdFor('ord-1'))?.state).toBe('active');
  });

  it('leaves an order that does not claim payment PENDING and entitles nobody', () => {
    const bridged = bridge([
      offerEvent({ pricingModel: 'one-time', price: { amountMinor: 2_500, currency: 'USD' }, perUse: null }),
      event('order', { orderId: 'ord-1', offerId: 'offer-1', buyerId: 'acme' }),
    ]);
    const state = reduceLedger(bridged.ledgerEvents);

    expect(state.orders.get('ord-1')?.state).toBe('pending');
    expect(state.entitlements.size).toBe(0);
  });

  it('propagates a full refund into a revoked entitlement', () => {
    const bridged = bridge([
      offerEvent({ pricingModel: 'one-time', price: { amountMinor: 2_500, currency: 'USD' }, perUse: null }),
      event('order', { orderId: 'ord-1', offerId: 'offer-1', buyerId: 'acme', paid: true }),
      event('refund', {
        refundId: 'ref-1',
        orderId: 'ord-1',
        amount: { amountMinor: 2_500, currency: 'USD' },
        state: 'succeeded',
      }),
    ]);
    const state = reduceLedger(bridged.ledgerEvents);

    expect(state.rejected).toEqual([]);
    expect(state.orders.get('ord-1')?.state).toBe('refunded');
    const entitlement = state.entitlements.get(entitlementIdFor('ord-1'));
    expect(entitlement?.state).toBe('revoked');
    expect(entitlement?.revokeReason).toBe('refunded');
  });

  it('revokes on a reversal that names the entitlement', () => {
    const bridged = bridge([
      offerEvent({ pricingModel: 'one-time', price: { amountMinor: 2_500, currency: 'USD' }, perUse: null }),
      event('order', { orderId: 'ord-1', offerId: 'offer-1', buyerId: 'acme', paid: true }),
      event('reversal', { entitlementId: entitlementIdFor('ord-1'), reason: 'chargeback' }),
    ]);
    const state = reduceLedger(bridged.ledgerEvents);

    expect(state.entitlements.get(entitlementIdFor('ord-1'))?.revokeReason).toBe('chargeback');
  });

  it('emits no ledger event for an entitlement fact, so an order cannot grant twice', () => {
    const bridged = bridge([
      offerEvent({ pricingModel: 'one-time', price: { amountMinor: 2_500, currency: 'USD' }, perUse: null }),
      event('order', { orderId: 'ord-1', offerId: 'offer-1', buyerId: 'acme', paid: true }),
      event('entitlement', {
        entitlementId: 'ent-p2p-1',
        subject: 'acme',
        releaseRef: 'plugin:widget:1.0.0',
        productId: 'prod-1',
        buyerId: 'acme',
      }),
    ]);
    const state = reduceLedger(bridged.ledgerEvents);

    // One order, one entitlement — and it is the ledger's own `ent:<orderId>`,
    // not a second grant under the P2P id that a revocation could miss.
    expect([...state.entitlements.keys()]).toEqual([entitlementIdFor('ord-1')]);
    expect(bridged.deferredToRollup).toHaveLength(1);
    expect(bridged.deferredToRollup[0]).toMatch(/^entitlement-/);
  });

  it('re-bridging a SUPERSET batch replays the shared facts identically', () => {
    const first = [
      offerEvent({ pricingModel: 'one-time', price: { amountMinor: 2_500, currency: 'USD' }, perUse: null }),
      event('order', { orderId: 'ord-1', offerId: 'offer-1', buyerId: 'acme', paid: true }),
    ];
    const later = event('reversal', { entitlementId: entitlementIdFor('ord-1') });

    const a = bridge(first);
    const b = bridge([...first, later]);

    // Ids derive from (streamId, sequence), never from batch position — so the
    // ledger sees a replay as a DUPLICATE rather than rejecting `ord-1` as an
    // order that already exists.
    const sharedIds = a.ledgerEvents.map((e) => e.ledgerEventId);
    expect(b.ledgerEvents.map((e) => e.ledgerEventId).slice(0, sharedIds.length)).toEqual(sharedIds);

    const replayed = reduceLedger([...a.ledgerEvents, ...b.ledgerEvents]);
    expect(replayed.rejected).toEqual([]);
    expect(replayed.duplicates.length).toBe(sharedIds.length);
  });

  it('refuses an offer whose price is not integer minor units', () => {
    const bridged = bridge([offerEvent({ price: { amountMinor: 12.5, currency: 'USD' } })]);
    expect(bridged.ledgerEvents).toEqual([]);
    expect(bridged.unbridged[0]?.reason).toMatch(/integer minor units/);
  });

  it('never turns a usage receipt into a ledger event', () => {
    // The design property: a receipt worth 500 micros is 0.05 CENTS, so any
    // conversion to the ledger's minor units floors it to zero and the revenue
    // disappears. Deferring it to the rollup is what keeps it exact.
    const bridged = bridge([
      event('usage-receipt', { channelId: 'chan-1', amountMicros: '500' }),
    ]);
    expect(bridged.ledgerEvents).toEqual([]);
    expect(bridged.unbridged).toEqual([]);
    expect(bridged.deferredToRollup).toHaveLength(1);
  });
});

describe('perUseRollup', () => {
  it('states submitted component payouts separately from settled allocations and deduplicates author receipts', () => {
    const payload = { channelId: 'authors', payer: 'acme', receiptHash: 'receipt-1', safeTxHash: 'safe-1',
      payoutStatus: 'submitted', transactionHash: `0x${'a'.repeat(64)}`, recipient: `0x${'b'.repeat(40)}` };
    const alice = event('revenue-split', { ...payload, share: 'component', payeeId: 'alice', amountMicros: '76' });
    const bob = event('revenue-split', { ...payload, share: 'component', payeeId: 'bob', amountMicros: '75' });
    const dao = event('revenue-split', { ...payload, share: 'dao', amountMicros: '300' });
    const duplicate = event('revenue-split', alice.payload);
    const rollup = perUseRollup([alice, bob, dao, duplicate]);
    expect(rollup.channels[0]?.submittedPayouts).toEqual({ daoMicros: '300', componentAuthorsMicros: { alice: '76', bob: '75' } });
    expect(rollup.channels[0]?.settledAllocations).toBeUndefined();
    expect(rollup.channels[0]?.settledMicros).toBe('0');
    expect(perUseDashboard(rollup, 'acme').channels).toHaveLength(1);
    expect(perUseDashboard(rollup, 'stranger').channels).toEqual([]);
    for (const patch of [{ amountMicros: '75.5' }, { transactionHash: null }, { payeeId: null }, { payoutStatus: 'pending' }]) {
      const invalid = perUseRollup([event('revenue-split', { ...alice.payload, ...patch })]);
      expect(invalid.channels[0]?.submittedPayouts).toBeUndefined();
      expect(invalid.unusable).toHaveLength(1);
    }
  });

  it('states component authors and DAO allocations only after finality, without counting the claim twice', () => {
    const payload = { channelId: 'authors', requestHash: 'author-batch', claimMicros: '3000', payer: 'acme', seller: 'seller',
      allocationsMicros: { dao: '300', component: '151' }, componentAllocationsMicros: { alice: '76', bob: '75' } };
    const claimed = event('settlement-proof', { ...payload, final: false });
    expect(perUseRollup([claimed]).channels[0]?.settledAllocations).toBeUndefined();
    const final = event('settlement-proof', { ...payload, final: true });
    for (const events of [[claimed, final], [final, claimed]]) {
      const rollup = perUseRollup(events);
      expect(rollup.channels[0]?.settledAllocations).toEqual({ daoMicros: '300', componentAuthorsMicros: { alice: '76', bob: '75' } });
      expect(perUseDashboard(rollup, 'acme').channels[0]?.settledAllocations?.daoMicros).toBe('300');
      expect(perUseDashboard(rollup, 'stranger').channels).toEqual([]);
    }
  });

  it('reports invalid component allocation sums and never invents payable statement lines', () => {
    for (const authors of [{ alice: '150' }, { alice: '150.5' }, { alice: '-151' }, null]) {
      const rollup = perUseRollup([event('settlement-proof', { channelId: 'authors', claimMicros: '3000', final: true,
        allocationsMicros: { dao: '300', component: '151' }, componentAllocationsMicros: authors })]);
      expect(rollup.channels[0]?.settledAllocations).toBeUndefined();
      expect(rollup.unusable[0]?.reason).toContain('summing to the component share');
    }
  });

  it('counts sub-cent receipts exactly instead of rounding them away', () => {
    const rollup = perUseRollup(
      reduceCommerceEvents([
        event('usage-receipt', { channelId: 'chan-1', amountMicros: '500', payer: 'acme', seller: 'creator-1' }),
        event('usage-receipt', { channelId: 'chan-1', amountMicros: '500' }),
        event('usage-receipt', { channelId: 'chan-1', amountMicros: '1' }),
      ]).accepted,
    );

    // 1001 micros is a tenth of a cent. Rounding to minor units would report 0.
    expect(rollup.totals.claimedMicros).toBe('1001');
    expect(rollup.channels[0]?.receipts).toBe(3);
    expect(rollup.channels[0]?.payer).toBe('acme');
  });

  it('keeps a CLAIM separate from FINALITY', () => {
    const rollup = perUseRollup(
      reduceCommerceEvents([
        event('usage-receipt', { channelId: 'chan-1', amountMicros: '9000' }),
        event('settlement-proof', {
          channelId: 'chan-1',
          requestHash: 'req-1',
          claimMicros: '9000',
          finality: 'claimed',
          final: false,
        }),
      ]).accepted,
    );

    expect(rollup.totals.claimedMicros).toBe('9000');
    expect(rollup.totals.settledMicros).toBe('0');
    expect(rollup.totals.pendingSettlementMicros).toBe('9000');
  });

  it('moves a batch out of pending when its final proof lands', () => {
    const rollup = perUseRollup(
      reduceCommerceEvents([
        event('settlement-proof', {
          channelId: 'chan-1',
          requestHash: 'req-1',
          claimMicros: '9000',
          finality: 'claimed',
          final: false,
        }),
        event('settlement-proof', {
          channelId: 'chan-1',
          requestHash: 'req-1',
          claimMicros: '9000',
          finality: 'final',
          final: true,
        }),
      ]).accepted,
    );

    expect(rollup.totals.settledMicros).toBe('9000');
    expect(rollup.totals.pendingSettlementMicros).toBe('0');
  });

  it('reports a reversal against settled revenue without going negative', () => {
    const rollup = perUseRollup(
      reduceCommerceEvents([
        event('settlement-proof', {
          channelId: 'chan-1',
          requestHash: 'req-1',
          claimMicros: '9000',
          final: true,
        }),
        event('reversal', { channelId: 'chan-1', amountMicros: '12000', entitlementId: 'ent-1' }),
      ]).accepted,
    );

    expect(rollup.totals.reversedMicros).toBe('12000');
    expect(rollup.totals.netSettledMicros).toBe('0');
  });

  it('reads micros beyond MAX_SAFE_INTEGER without losing digits', () => {
    const huge = '9007199254740993000';
    const rollup = perUseRollup(
      reduceCommerceEvents([
        event('usage-receipt', { channelId: 'chan-1', amountMicros: huge }),
      ]).accepted,
    );
    expect(rollup.totals.claimedMicros).toBe(huge);
  });

  it('refuses a receipt whose amount is not a non-negative integer', () => {
    const rollup = perUseRollup(
      reduceCommerceEvents([
        event('usage-receipt', { channelId: 'chan-1', amountMicros: '12.5' }),
      ]).accepted,
    );
    expect(rollup.totals.claimedMicros).toBe('0');
    expect(rollup.unusable[0]?.reason).toMatch(/amountMicros/);
  });
});

describe('perUseDashboard', () => {
  const rollup = perUseRollup(
    reduceCommerceEvents([
      event('settlement-proof', {
        channelId: 'chan-mine',
        requestHash: 'req-1',
        claimMicros: '9000',
        final: true,
        payer: 'acme',
        seller: 'creator-1',
      }),
      event('settlement-proof', {
        channelId: 'chan-theirs',
        requestHash: 'req-2',
        claimMicros: '5000',
        final: true,
        payer: 'globex',
        seller: 'creator-9',
      }),
    ]).accepted,
  );

  it('shows only channels the org is a party to, and says how many it hid', () => {
    const view = perUseDashboard(rollup, 'acme');
    expect(view.channels.map((c) => c.channelId)).toEqual(['chan-mine']);
    expect(view.excludedChannels).toBe(1);
    // Recomputed over the VISIBLE rows: a total carrying the hidden channel's
    // 5000 micros would leak the amount while hiding the row.
    expect(view.totals.settledMicros).toBe('9000');
  });

  it('distinguishes an unwired source from a quiet one', () => {
    expect(perUseDashboard(null, 'acme').excludedChannels).toBe(0);
    expect(perUseDashboard(null, 'acme').totals.settledMicros).toBe('0');
  });
});

describe('mergeEntitlementProjections', () => {
  it('makes revocation terminal across sources', () => {
    const merged = mergeEntitlementProjections(
      projection([grant()]),
      projection([grant({ revokedAtMs: 5_000, revokedReason: 'refunded' })]),
    );
    const only = [...merged.grants.values()][0];
    expect(only?.revokedAtMs).toBe(5_000);
    expect(only?.revokedReason).toBe('refunded');
  });

  it('revokes even when the REVOKED view is passed first', () => {
    // Order-independence is the property that matters: whichever projection is
    // stale, the buyer must not keep delivery.
    const merged = mergeEntitlementProjections(
      projection([grant({ revokedAtMs: 5_000, revokedReason: 'refunded' })]),
      projection([grant()]),
    );
    expect([...merged.grants.values()][0]?.revokedAtMs).toBe(5_000);
  });

  it('keeps the EARLIEST revocation when both sides revoked', () => {
    const merged = mergeEntitlementProjections(
      projection([grant({ revokedAtMs: 9_000, revokedReason: 'late' })]),
      projection([grant({ revokedAtMs: 5_000, revokedReason: 'early' })]),
    );
    const only = [...merged.grants.values()][0];
    expect(only?.revokedAtMs).toBe(5_000);
    expect(only?.revokedReason).toBe('early');
  });

  it('keeps distinct subject/release pairs apart', () => {
    const merged = mergeEntitlementProjections(
      projection([grant()]),
      projection([grant({ subject: 'globex', revokedAtMs: 5_000 })]),
    );
    expect(merged.grants.size).toBe(2);
    expect([...merged.grants.values()].filter((g) => g.revokedAtMs === null)).toHaveLength(1);
  });
});

describe('bridgeFromCommerceEntitlements', () => {
  it('resolves product→release and buyer→subject from the signed facts', () => {
    const mapping = bridgeFromCommerceEntitlements(
      reduceCommerceEvents([
        event('entitlement', {
          entitlementId: 'ent-p2p-1',
          productId: 'prod-1',
          releaseRef: 'plugin:widget:1.0.0',
          buyerId: 'acme',
          subject: 'acme-install',
        }),
      ]).accepted,
    );

    const entitlement = {
      entitlementId: 'ent:ord-1',
      orderId: 'ord-1',
      productId: 'prod-1',
      buyerId: 'acme',
      state: 'active' as const,
      grantedAtMs: 1_000,
      revokedAtMs: null,
      revokeReason: null,
    };
    expect(mapping.releaseRefForProduct('prod-1', entitlement)).toBe('plugin:widget:1.0.0');
    expect(mapping.subjectForBuyer('acme', entitlement)).toBe('acme-install');
    // No guessed convention: an unmapped product resolves to null, and
    // `projectLedgerEntitlements` then produces no grant at all.
    expect(mapping.releaseRefForProduct('prod-unknown', entitlement)).toBeNull();
  });
});
