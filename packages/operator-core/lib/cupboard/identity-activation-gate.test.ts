import { describe, expect, it } from 'vitest';
import type {
  FundingChannelView,
  IdentityOfferView,
  IdentityPricingVerdict,
  InstalledIdentityReleaseLayer,
  PrepaidBalanceView,
  Readout,
} from './identity-activation-gate';
import { identityPerUseOfferTerms } from './identity-per-use-offer';

// The supported copy-out mutation runner points this suite at isolated source.
// Production imports keep using the canonical module.
const {
  evaluateIdentityActivation,
  identityReleasePricing,
  IdentityActivationRefusedError,
  isIdentityActivationRefusedError,
} = (await import(process.env.IDENTITY_ACTIVATION_GATE_MODULE_PATH ?? './identity-activation-gate')) as typeof import('./identity-activation-gate');

function release(id: string, version = '1.0.0'): { layer: InstalledIdentityReleaseLayer; offer: IdentityOfferView } {
  const derived = identityPerUseOfferTerms({ identity: { id, version } });
  if (!derived.ok) throw new Error(derived.detail);
  const { skuRef, ...perUse } = derived.terms;
  return {
    layer: { layerRef: `persona:${id}`, identity: { id, version }, skuRef },
    offer: { offerId: `off_${id}`, skuRef, active: true, productActive: true, perUse },
  };
}

const read = <T>(value: T): Readout<T> => ({ ok: true, value });
const credits = (availableMicros: number, debtMicros = 0): Readout<PrepaidBalanceView> =>
  read({ availableMicros, debtMicros });
const channel = (overrides: Partial<FundingChannelView> = {}): FundingChannelView => ({
  channelId: 'ch_1',
  state: 'open',
  escrowMicros: 10_000,
  committedMicros: 0,
  ...overrides,
});

function pricingFor(...offers: IdentityOfferView[]) {
  return (layer: InstalledIdentityReleaseLayer): [string, IdentityPricingVerdict] =>
    [layer.skuRef, identityReleasePricing(layer.skuRef, offers)];
}

describe('identityReleasePricing', () => {
  const { layer, offer } = release('acme/reviewer');

  it('treats a release with no live offer as free', () => {
    expect(identityReleasePricing(layer.skuRef, [])).toEqual({ kind: 'free' });
    expect(identityReleasePricing(layer.skuRef, [{ ...offer, active: false }])).toEqual({ kind: 'free' });
    expect(identityReleasePricing(layer.skuRef, [{ ...offer, productActive: false }])).toEqual({ kind: 'free' });
  });

  it('prices a release by its verified per-use offer (20% markup = 200 micros per block)', () => {
    expect(identityReleasePricing(layer.skuRef, [offer])).toEqual({
      kind: 'priced',
      offerId: 'off_acme/reviewer',
      unitPriceMicros: 200,
    });
  });

  it('chooses the cheapest verified offer', () => {
    const cheaper = identityPerUseOfferTerms({ identity: layer.identity, markupBps: 1_000 });
    if (!cheaper.ok) throw new Error(cheaper.detail);
    const { skuRef: _sku, ...perUse } = cheaper.terms;
    const verdict = identityReleasePricing(layer.skuRef, [offer, { ...offer, offerId: 'off_cheap', perUse }]);
    expect(verdict).toEqual({ kind: 'priced', offerId: 'off_cheap', unitPriceMicros: 100 });
  });

  it('never lets a malformed offer make a priced release free', () => {
    const tampered = { ...offer, perUse: { ...offer.perUse!, unitPriceMicros: 1 } };
    expect(identityReleasePricing(layer.skuRef, [tampered]).kind).toBe('unverifiable');
    expect(identityReleasePricing(layer.skuRef, [{ ...offer, perUse: null }]).kind).toBe('unverifiable');
  });
});

describe('evaluateIdentityActivation', () => {
  const reviewer = release('acme/reviewer');
  const pricing = new Map([pricingFor(reviewer.offer)(reviewer.layer)]);
  const layers = [reviewer.layer];

  it('refuses a priced identity when neither a channel nor credits fund it', () => {
    const decision = evaluateIdentityActivation({ layers, pricing, prepaid: credits(0), channels: new Map() });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe('identity-activation-unfunded');
    expect(decision.refused).toEqual([
      expect.objectContaining({
        layerRef: 'persona:acme/reviewer',
        skuRef: reviewer.layer.skuRef,
        code: 'identity-activation-unfunded',
        offerId: 'off_acme/reviewer',
        unitPriceMicros: 200,
      }),
    ]);
    expect(decision.detail).toContain('no payment channel is bound');
  });

  it('activates a priced identity paid by prepaid credits', () => {
    const decision = evaluateIdentityActivation({ layers, pricing, prepaid: credits(200), channels: new Map() });
    expect(decision).toEqual({
      ok: true,
      charged: [{
        layerRef: 'persona:acme/reviewer',
        skuRef: reviewer.layer.skuRef,
        offerId: 'off_acme/reviewer',
        unitPriceMicros: 200,
        source: { kind: 'prepaid-credits' },
      }],
    });
  });

  it('activates a priced identity paid by its bound payment channel', () => {
    const decision = evaluateIdentityActivation({
      layers,
      pricing,
      prepaid: credits(0),
      channels: new Map([[reviewer.layer.skuRef, read(channel())]]),
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.charged[0]?.source).toEqual({ kind: 'payment-channel', channelId: 'ch_1' });
  });

  it('revocation stops the next activation: a closed or drained channel refuses', () => {
    const funded = evaluateIdentityActivation({
      layers, pricing, prepaid: credits(0), channels: new Map([[reviewer.layer.skuRef, read(channel())]]),
    });
    expect(funded.ok).toBe(true);
    for (const revoked of [channel({ state: 'closed' }), channel({ state: 'closing' }), channel({ state: 'failed' }),
      channel({ committedMicros: 9_900 })]) {
      const next = evaluateIdentityActivation({
        layers, pricing, prepaid: credits(0), channels: new Map([[reviewer.layer.skuRef, read(revoked)]]),
      });
      expect(next.ok).toBe(false);
      if (!next.ok) expect(next.code).toBe('identity-activation-unfunded');
    }
  });

  it('revocation stops the next activation: reversed credits (debt) refuse', () => {
    expect(evaluateIdentityActivation({ layers, pricing, prepaid: credits(5_000), channels: new Map() }).ok).toBe(true);
    const next = evaluateIdentityActivation({ layers, pricing, prepaid: credits(5_000, 1), channels: new Map() });
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.detail).toContain('debt');
  });

  it('leaves free identities and non-release layers unaffected, with no funds at all', () => {
    const free = release('acme/free');
    expect(evaluateIdentityActivation({
      layers: [free.layer],
      pricing: new Map([[free.layer.skuRef, { kind: 'free' }]]),
      prepaid: null,
      channels: new Map(),
    })).toEqual({ ok: true, charged: [] });
    expect(evaluateIdentityActivation({ layers: [], pricing: new Map(), prepaid: null, channels: new Map() }))
      .toEqual({ ok: true, charged: [] });
  });

  it('fails closed when a priced release cannot be verified or its funds cannot be read', () => {
    const unverifiable = evaluateIdentityActivation({
      layers,
      pricing: new Map([[reviewer.layer.skuRef, { kind: 'unverifiable', detail: 'offers unreachable' }]]),
      prepaid: credits(10_000),
      channels: new Map(),
    });
    expect(unverifiable.ok).toBe(false);
    if (!unverifiable.ok) expect(unverifiable.code).toBe('identity-pricing-unverifiable');

    const missingVerdict = evaluateIdentityActivation({ layers, pricing: new Map(), prepaid: credits(10_000), channels: new Map() });
    expect(missingVerdict.ok).toBe(false);

    const fundsUnreadable = evaluateIdentityActivation({
      layers, pricing, prepaid: { ok: false, detail: 'transport_error' }, channels: new Map(),
    });
    expect(fundsUnreadable.ok).toBe(false);
    if (!fundsUnreadable.ok) expect(fundsUnreadable.code).toBe('identity-funding-unverifiable');
  });

  it('shares one credit balance across stacked priced identities', () => {
    const second = release('acme/planner');
    const stacked = [reviewer.layer, second.layer];
    const bothPriced = new Map([pricingFor(reviewer.offer)(reviewer.layer), pricingFor(second.offer)(second.layer)]);
    expect(evaluateIdentityActivation({ layers: stacked, pricing: bothPriced, prepaid: credits(400), channels: new Map() }).ok)
      .toBe(true);
    const short = evaluateIdentityActivation({ layers: stacked, pricing: bothPriced, prepaid: credits(399), channels: new Map() });
    expect(short.ok).toBe(false);
    if (short.ok) return;
    expect(short.charged.map((c) => c.layerRef)).toEqual(['persona:acme/reviewer']);
    expect(short.refused.map((r) => r.layerRef)).toEqual(['persona:acme/planner']);
  });
});

describe('IdentityActivationRefusedError', () => {
  it('carries the typed code and the refused layers', () => {
    const decision = evaluateIdentityActivation({
      layers: [release('acme/reviewer').layer],
      pricing: new Map([[release('acme/reviewer').layer.skuRef, { kind: 'priced', offerId: 'o', unitPriceMicros: 200 }]]),
      prepaid: credits(0),
      channels: new Map(),
    });
    if (decision.ok) throw new Error('expected a refusal');
    const error = new IdentityActivationRefusedError(decision);
    expect(isIdentityActivationRefusedError(error)).toBe(true);
    expect(error.code).toBe('identity-activation-unfunded');
    expect(error.message.startsWith('identity-activation-unfunded:')).toBe(true);
    expect(isIdentityActivationRefusedError(new Error('other'))).toBe(false);
  });
});
