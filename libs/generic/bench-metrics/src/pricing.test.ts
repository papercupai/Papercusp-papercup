import { describe, it, expect } from 'vitest';
import { MODEL_PRICES, PRICE_TABLE_VERSION as MODEL_PRICING_VERSION } from '@papercusp/model-pricing';
import { priceRun, resolveModelPrice, priceTableForVersion, PRICE_TABLE_V1, PRICE_TABLE_V2 } from './pricing';

describe('PRICE_TABLE_V2 — derived from @papercusp/model-pricing, snapshot matching', () => {
  it('prices every model-pricing id at its own list price, under a version naming the source table', () => {
    expect(PRICE_TABLE_V2.version).toBe(`price-table-v2+${MODEL_PRICING_VERSION}`);
    expect(Object.keys(PRICE_TABLE_V2.prices).sort()).toEqual(Object.keys(MODEL_PRICES).sort());
    for (const [id, p] of Object.entries(MODEL_PRICES)) {
      expect(resolveModelPrice(id, PRICE_TABLE_V2)).toMatchObject({ inputPerMtok: p.in, outputPerMtok: p.out });
    }
  });

  it('does NOT let a newer model inherit an older prefix price (the V1 defect it replaces)', () => {
    // V1 prefix-matches claude-opus-5-5 onto its claude-opus-5 row; V2 must use claude-opus-5-5's own price.
    expect(resolveModelPrice('claude-opus-5-5', PRICE_TABLE_V1)).toEqual(PRICE_TABLE_V1.prices['claude-opus-5']);
    const own = MODEL_PRICES['claude-opus-5-5'];
    expect(resolveModelPrice('claude-opus-5-5', PRICE_TABLE_V2)).toMatchObject({ inputPerMtok: own.in, outputPerMtok: own.out });
    // An unregistered extension is unknown (priceRun refuses it) rather than priced as its prefix.
    expect(resolveModelPrice('claude-opus-5-9', PRICE_TABLE_V2)).toBeNull();
    expect(() => priceRun({ tokensIn: 1, tokensOut: 1 }, 'claude-opus-5-9', PRICE_TABLE_V2)).toThrow(/no price/);
  });

  it('normalizes vendor prefix, effort and [1m] markers, and accepts a dated snapshot of a registered id', () => {
    const base = resolveModelPrice('claude-opus-5', PRICE_TABLE_V2);
    expect(base).not.toBeNull();
    for (const id of ['anthropic/claude-opus-5', 'claude-opus-5[1m]', 'claude-opus-5:xhigh', 'claude-opus-5-20261001']) {
      expect(resolveModelPrice(id, PRICE_TABLE_V2)).toEqual(base);
    }
  });

  it('looks up every published table by its stored version', () => {
    expect(priceTableForVersion(PRICE_TABLE_V1.version)).toBe(PRICE_TABLE_V1);
    expect(priceTableForVersion(PRICE_TABLE_V2.version)).toBe(PRICE_TABLE_V2);
    expect(priceTableForVersion('price-table-v0')).toBeNull();
  });
});

describe('resolveModelPrice', () => {
  it('returns the Opus 4.8 row at $5/$25 with derived cache prices', () => {
    const p = resolveModelPrice('claude-opus-4-8');
    expect(p).toEqual({ inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25 });
  });

  it('resolves a suffixed id by longest-prefix match', () => {
    expect(resolveModelPrice('claude-opus-4-8[1m]')).toEqual(resolveModelPrice('claude-opus-4-8'));
  });

  it('returns null for an unknown model', () => {
    expect(resolveModelPrice('gpt-mystery')).toBeNull();
  });
});

describe('priceRun', () => {
  it('prices input and output at table rates', () => {
    expect(priceRun({ tokensIn: 1_000_000, tokensOut: 0 }, 'claude-opus-4-8')).toBeCloseTo(5, 10);
    expect(priceRun({ tokensIn: 0, tokensOut: 1_000_000 }, 'claude-opus-4-8')).toBeCloseTo(25, 10);
  });

  it('prices cache read and write separately (0.1x / 1.25x input)', () => {
    expect(priceRun({ tokensIn: 0, tokensOut: 0, tokensCacheRead: 1_000_000 }, 'claude-opus-4-8')).toBeCloseTo(0.5, 10);
    expect(priceRun({ tokensIn: 0, tokensOut: 0, tokensCacheWrite: 1_000_000 }, 'claude-opus-4-8')).toBeCloseTo(6.25, 10);
  });

  it('resolves suffixed model ids', () => {
    expect(priceRun({ tokensIn: 1_000_000, tokensOut: 0 }, 'claude-opus-4-8[1m]')).toBeCloseTo(5, 10);
  });

  it('throws loudly on an unknown model rather than silently zeroing cost', () => {
    expect(() => priceRun({ tokensIn: 1000, tokensOut: 100 }, 'unknown-model')).toThrow(/no price for model/);
  });

  it('table version is pinned', () => {
    expect(PRICE_TABLE_V1.version).toBe('price-table-v1');
  });
});
