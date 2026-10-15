import { describe, expect, it } from 'vitest';
import { settleRevenue } from '../p2p/revenue-settlement';
import meterInvocation from '../agent-tools/cupboard/meter-invocation';
import {
  IDENTITY_DAO_TAKE_BPS,
  IDENTITY_MARKUP_METER_UNIT,
  IDENTITY_SUGGESTED_MARKUP_BPS,
  identityMarkupSplitManifest,
  identityPerUseOfferTerms,
  identityReleaseSkuRef,
  parseIdentityMarkupPriceVersion,
  identityMarkupPriceVersion,
  parseIdentityReleaseSkuRef,
  quoteIdentityInferenceTurn,
  verifyIdentityPerUseOffer,
} from './identity-per-use-offer';

const ENGINEER = { id: 'papercusp-engineer', version: '1.2.0' };

describe('exact billed inference markup', () => {
  const offered = identityPerUseOfferTerms({ identity: ENGINEER, markupBps: 2500 });
  if (!offered.ok) throw new Error(offered.detail);
  const offer = offered.terms;

  it('reserves ceiling blocks upward but charges the exact billed base', () => {
    expect(quoteIdentityInferenceTurn({ offer, inferenceCeilingMicros: 1001n, billedInferenceMicros: 999n }))
      .toEqual({ ok: true, reservationQuantity: 2n, reservedMarkupMicros: 500n,
        amountMicros: 249n, remainderNumerator: 7500n });
    expect(quoteIdentityInferenceTurn({ offer, inferenceCeilingMicros: 1000n, billedInferenceMicros: 1000n }))
      .toMatchObject({ reservationQuantity: 1n, amountMicros: 250n, remainderNumerator: 0n });
  });

  it('retains fractional micros across turns instead of rounding each sample away', () => {
    let remainder = 0n;
    let charged = 0n;
    for (const billedInferenceMicros of [1n, 1n, 0n, 1n, 1n, 999n]) {
      const quote = quoteIdentityInferenceTurn({ offer, inferenceCeilingMicros: 1000n,
        billedInferenceMicros, priorRemainderNumerator: remainder });
      if (!quote.ok) throw new Error(quote.detail);
      charged += quote.amountMicros;
      remainder = quote.remainderNumerator;
    }
    const aggregate = quoteIdentityInferenceTurn({ offer, inferenceCeilingMicros: 1003n, billedInferenceMicros: 1003n });
    if (!aggregate.ok) throw new Error(aggregate.detail);
    expect({ charged, remainder }).toEqual({ charged: aggregate.amountMicros, remainder: aggregate.remainderNumerator });
    expect(charged).toBe(250n);
  });

  it('keeps a zero billed turn free and preserves its carried remainder', () => {
    expect(quoteIdentityInferenceTurn({ offer, inferenceCeilingMicros: 1n,
      billedInferenceMicros: 0n, priorRemainderNumerator: 9999n }))
      .toMatchObject({ amountMicros: 0n, remainderNumerator: 9999n });
  });

  it('uses bigint arithmetic for cost and markup beyond the JSON safe-integer range', () => {
    const billed = 9_007_199_254_740_993n;
    expect(quoteIdentityInferenceTurn({ offer, inferenceCeilingMicros: billed, billedInferenceMicros: billed }))
      .toMatchObject({ ok: true, amountMicros: 2_251_799_813_685_248n, remainderNumerator: 2500n });
  });

  it('refuses overspend, invalid money, out-of-range remainders and an unrepresentable reservation', () => {
    const quote = (overrides: Partial<Parameters<typeof quoteIdentityInferenceTurn>[0]>) =>
      quoteIdentityInferenceTurn({ offer, inferenceCeilingMicros: 1000n, billedInferenceMicros: 1n, ...overrides });
    expect(quote({ billedInferenceMicros: 1001n })).toMatchObject({ ok: false, code: 'inference-ceiling-exceeded' });
    for (const overrides of [{ billedInferenceMicros: -1n }, { inferenceCeilingMicros: 0n },
      { billedInferenceMicros: 1 as unknown as bigint },
      { inferenceCeilingMicros: BigInt(Number.MAX_SAFE_INTEGER) * 1000n + 1n }]) {
      expect(quote(overrides)).toMatchObject({ ok: false, code: 'invalid-inference-cost' });
    }
    for (const priorRemainderNumerator of [-1n, 10000n, 1 as unknown as bigint]) {
      expect(quote({ priorRemainderNumerator })).toMatchObject({ ok: false, code: 'invalid-markup-remainder' });
    }
  });

  it('refuses forged offer price, meter and split before quoting', () => {
    for (const bad of [{ unitPriceMicros: offer.unitPriceMicros + 1 }, { meterUnit: 'tool-call' },
      { splitManifestHash: `sha256:${'a'.repeat(64)}` }]) {
      expect(quoteIdentityInferenceTurn({ offer: { ...offer, ...bad },
        inferenceCeilingMicros: 1000n, billedInferenceMicros: 1n }))
        .toMatchObject({ ok: false, code: 'identity-offer-mismatch' });
    }
  });
});

describe('identity release skuRef', () => {
  it('round-trips, including a namespaced id', () => {
    expect(identityReleaseSkuRef(ENGINEER)).toBe('identity-release:papercusp-engineer@1.2.0');
    expect(parseIdentityReleaseSkuRef('identity-release:papercusp-engineer@1.2.0')).toEqual(ENGINEER);
    expect(parseIdentityReleaseSkuRef('identity-release:acme/reviewer@2.0.0-rc.1')).toEqual({
      id: 'acme/reviewer',
      version: '2.0.0-rc.1',
    });
  });

  it('rejects other namespaces and malformed refs', () => {
    expect(parseIdentityReleaseSkuRef('sku-use')).toBeNull();
    expect(parseIdentityReleaseSkuRef('identity-release:no-version')).toBeNull();
    expect(parseIdentityReleaseSkuRef('identity-release:@1.0.0')).toBeNull();
    expect(parseIdentityReleaseSkuRef('identity-release:bad id@1.0.0')).toBeNull();
  });
});

describe('identityPerUseOfferTerms', () => {
  it('round-trips exact component authors through the persisted price term and reconciles the resulting split', () => {
    const componentDependencies = [
      { packageKind: 'blueprint', ref: 'dependency', revision: '2.0.0', contentHash: 'a'.repeat(64), author: 'alice' },
      { packageKind: 'pack', ref: 'knowledge', revision: '3.0.0', contentHash: 'b'.repeat(64), author: 'bob' },
    ];
    const offered = identityPerUseOfferTerms({ identity: ENGINEER, componentBps: 3000, componentDependencies });
    if (!offered.ok) throw new Error(offered.detail);
    expect(offered.terms.priceVersion.length).toBeGreaterThan(200);
    const { skuRef, ...meterTerms } = offered.terms;
    const reserve = meterInvocation.args.safeParse({ op: 'reserve', channelId: 'channel', workspaceId: 'workspace',
      hiveSlug: 'buyer', offerId: 'offer', payer: 'buyer', seller: 'seller', releaseRef: skuRef,
      usageNonce: 'one', quantity: 1, ...meterTerms });
    expect(reserve.success ? true : reserve.error.issues).toBe(true);
    const restored = verifyIdentityPerUseOffer(offered.terms);
    if (!restored.ok) throw new Error(restored.detail);
    expect(restored.manifest).toEqual(offered.manifest);
    const settled = settleRevenue({ settlementId: 'components', grossMicros: 1000n, providerCostMicros: 0n,
      splitManifest: restored.manifest, daoTreasury: 'dao' });
    expect(settled).toMatchObject({ ok: true, receipt: { allocationsMicros: { creator: 600n, dao: 100n },
      componentAllocationsMicros: { alice: 150n, bob: 150n } } });
    const changed = identityPerUseOfferTerms({ identity: ENGINEER, componentBps: 3000,
      componentDependencies: componentDependencies.map((pin) => ({ ...pin, author: 'mallory' })) });
    if (!changed.ok) throw new Error(changed.detail);
    expect(verifyIdentityPerUseOffer({ ...offered.terms, priceVersion: changed.terms.priceVersion }))
      .toMatchObject({ ok: false, code: 'identity-offer-mismatch' });
    expect(verifyIdentityPerUseOffer({ ...offered.terms, priceVersion: offered.terms.priceVersion + '!' })).toMatchObject({ ok: false });
    expect(identityPerUseOfferTerms({ identity: ENGINEER, componentBps: 3000, componentDependencies: [] }))
      .toMatchObject({ ok: false, code: 'invalid-split' });
  });

  it('refuses an oversized exact component closure while accepting a populated closure below the term limit', () => {
    const components = (count: number) => Array.from({ length: count }, (_, i) => ({
      packageKind: 'blueprint', ref: `component-${i}-${'x'.repeat(384)}`, revision: '1.0.0',
      contentHash: 'a'.repeat(64), author: 'alice',
    }));
    const valid = identityPerUseOfferTerms({ identity: ENGINEER, componentBps: 3000, componentDependencies: components(80) });
    if (!valid.ok) throw new Error(valid.detail);
    expect(valid.terms.priceVersion.length).toBeLessThanOrEqual(64_000);
    expect(verifyIdentityPerUseOffer(valid.terms)).toMatchObject({ ok: true });
    const oversizedPins = components(160);
    const oversized = identityMarkupPriceVersion({ markupBps: 2000, creatorBps: 6000, componentBps: 3000,
      componentDependencies: oversizedPins });
    expect(oversized.length).toBeGreaterThan(64_000);
    expect(parseIdentityMarkupPriceVersion(oversized)).toBeNull();
    expect(identityPerUseOfferTerms({ identity: ENGINEER, componentBps: 3000, componentDependencies: oversizedPins }))
      .toMatchObject({ ok: false, code: 'invalid-split', detail: expect.stringContaining('size limit') });
  });

  it('defaults to the suggested 20% markup with the whole seller share to the creator', () => {
    const result = identityPerUseOfferTerms({ identity: ENGINEER });
    if (!result.ok) throw new Error(result.detail);
    expect(result.markup).toEqual({ markupBps: IDENTITY_SUGGESTED_MARKUP_BPS, creatorBps: 9000, componentBps: 0 });
    expect(result.terms).toEqual({
      skuRef: 'identity-release:papercusp-engineer@1.2.0',
      meterUnit: IDENTITY_MARKUP_METER_UNIT,
      // 20% of a 1,000-micro inference block.
      unitPriceMicros: 200,
      priceVersion: 'identity-markup-v1;markup=2000;creator=9000;component=0;dao=1000',
      splitManifestHash: identityMarkupSplitManifest({ creatorBps: 9000, componentBps: 0 }).manifestHash,
    });
    expect(result.manifest.sharesBps).toEqual({
      creator: 9000, host: 0, component: 0, dao: IDENTITY_DAO_TAKE_BPS, reserve: 0, tax: 0, operating: 0,
    });
  });

  it('gives the rest of the seller share to the creator when only a component share is named', () => {
    const result = identityPerUseOfferTerms({ identity: ENGINEER, componentBps: 2500 });
    if (!result.ok) throw new Error(result.detail);
    expect(result.markup).toMatchObject({ creatorBps: 6500, componentBps: 2500 });
  });

  it('refuses a markup that is not a whole micro per block, and a split that does not leave the DAO 1000 bps', () => {
    expect(identityPerUseOfferTerms({ identity: ENGINEER, markupBps: 0 })).toMatchObject({ ok: false, code: 'invalid-markup' });
    expect(identityPerUseOfferTerms({ identity: ENGINEER, markupBps: 15 })).toMatchObject({ ok: false, code: 'invalid-markup' });
    expect(identityPerUseOfferTerms({ identity: ENGINEER, markupBps: 2000.5 })).toMatchObject({ ok: false, code: 'invalid-markup' });
    expect(identityPerUseOfferTerms({ identity: ENGINEER, creatorBps: 10000, componentBps: 0 })).toMatchObject({
      ok: false,
      code: 'invalid-split',
    });
    expect(identityPerUseOfferTerms({ identity: ENGINEER, creatorBps: 5000, componentBps: 3000 })).toMatchObject({
      ok: false,
      code: 'invalid-split',
    });
    expect(identityPerUseOfferTerms({ identity: ENGINEER, creatorBps: -1, componentBps: 9001 })).toMatchObject({
      ok: false,
      code: 'invalid-split',
    });
  });

  it('refuses an identity that cannot be named unambiguously in a skuRef', () => {
    expect(identityPerUseOfferTerms({ identity: { id: 'a@b', version: '1.0.0' } })).toMatchObject({
      ok: false,
      code: 'invalid-identity-release',
    });
    expect(identityPerUseOfferTerms({ identity: { id: 'ok', version: '' } })).toMatchObject({
      ok: false,
      code: 'invalid-identity-release',
    });
  });

  it('splits a settled markup payment so the DAO receives exactly 10%', () => {
    const result = identityPerUseOfferTerms({ identity: ENGINEER, markupBps: 3000, componentBps: 3000 });
    if (!result.ok) throw new Error(result.detail);
    // 1,234,560 micros of markup: a BYOC markup has no provider cost to deduct.
    const settled = settleRevenue({
      settlementId: 'identity-markup-1',
      grossMicros: 1_234_560n,
      providerCostMicros: 0n,
      splitManifest: result.manifest,
      daoTreasury: '0xDA0',
    });
    if (!settled.ok) throw new Error(settled.detail);
    expect(settled.receipt.allocationsMicros.dao).toBe(123_456n);
    expect(settled.receipt.allocationsMicros.creator).toBe(740_736n);
    expect(settled.receipt.allocationsMicros.component).toBe(370_368n);
  });
});

describe('verifyIdentityPerUseOffer', () => {
  const derived = identityPerUseOfferTerms({ identity: ENGINEER, markupBps: 2500, componentBps: 1000 });
  if (!derived.ok) throw new Error(derived.detail);
  const terms = derived.terms;

  it('accepts exactly the derived terms and returns the identity and markup they spell out', () => {
    expect(verifyIdentityPerUseOffer(terms)).toMatchObject({
      ok: true,
      identity: ENGINEER,
      markup: { markupBps: 2500, creatorBps: 8000, componentBps: 1000 },
    });
    expect(parseIdentityMarkupPriceVersion(terms.priceVersion)).toEqual({ markupBps: 2500, creatorBps: 8000, componentBps: 1000 });
  });

  it('refuses each term that disagrees with what the priceVersion derives', () => {
    for (const bad of [
      { meterUnit: 'tool-call' },
      { unitPriceMicros: terms.unitPriceMicros + 1 },
      { splitManifestHash: identityMarkupSplitManifest({ creatorBps: 9000, componentBps: 0 }).manifestHash },
    ]) {
      expect(verifyIdentityPerUseOffer({ ...terms, ...bad })).toMatchObject({ ok: false, code: 'identity-offer-mismatch' });
    }
  });

  it('refuses a priceVersion that is not the identity scheme or that changes the DAO take', () => {
    expect(verifyIdentityPerUseOffer({ ...terms, priceVersion: 'price-v1' })).toMatchObject({
      ok: false,
      code: 'identity-offer-mismatch',
    });
    expect(
      verifyIdentityPerUseOffer({ ...terms, priceVersion: 'identity-markup-v1;markup=2500;creator=8500;component=1000;dao=500' }),
    ).toMatchObject({ ok: false, code: 'identity-offer-mismatch' });
  });

  it('tells a non-identity offer apart from a malformed identity one', () => {
    expect(verifyIdentityPerUseOffer({ ...terms, skuRef: 'sku-use' })).toMatchObject({ ok: false, code: 'not-an-identity-offer' });
    expect(verifyIdentityPerUseOffer({ ...terms, skuRef: 'identity-release:missing-version' })).toMatchObject({
      ok: false,
      code: 'invalid-identity-release',
    });
  });
});
