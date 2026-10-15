/**
 * WI-10004517 / agent-economy-flywheel D-018: the repricer re-derives a stored estimate from the
 * row's columns. Expected dollar amounts use explicit sheet-rate arithmetic rather than the
 * pricing helper under test, so a shared pricing defect cannot agree with its own oracle.
 */
import { describe, expect, it } from 'vitest';
import { costFromTokens, type CostOptions, type TokenUsage } from '@papercusp/model-pricing';
import { priceStoredUsageSample, storedSampleTokenUsage, type StoredUsageSample } from './reprice-usage-samples';

const row = (over: Partial<StoredUsageSample>): StoredUsageSample => ({
  source: 'interactive', provider: 'anthropic', model: 'claude-opus-4-8',
  input_tokens: '1200', output_tokens: '300', cache_read_tokens: '50000', cache_creation_tokens: '2000',
  cache_creation_5m_tokens: '1500', cache_creation_1h_tokens: '500', grain: 'request', ...over,
});

describe('run-aggregate writers (jsonl = usage-sample-pg.ts, headers = agent-usage-telemetry.ts)', () => {
  it.each(['jsonl', 'headers'])('%s re-prices exactly as the writer\'s four-counter call', (source) => {
    const stored = row({ source, provider: 'openai', model: 'gpt-5.5', cache_creation_5m_tokens: null, cache_creation_1h_tokens: null });
    // (1200*2.5 + 300*20 + 50000*0.25 + 2000*2.5) / 1M.
    expect(priceStoredUsageSample(stored)).toEqual({ costUsd: 0.0265, costSource: 'estimated', costBound: null });
  });

  it('a NULL counter is priced as zero, as the writer passes undefined', () => {
    const stored = row({ source: 'jsonl', provider: 'openai', model: 'gpt-5.5', cache_creation_tokens: null, cache_read_tokens: null });
    expect(priceStoredUsageSample(stored).costUsd).toBe(0.009);
  });

  it('a run aggregate of a long-context model prices at its standard-tier floor (D-020)', () => {
    const stored = row({ source: 'jsonl', provider: 'openai', model: 'gpt-6-sol', grain: null });
    const usage = storedSampleTokenUsage(stored)!;
    expect(usage.requestInputTokens).toBeUndefined();
    expect(costFromTokens('gpt-6-sol', usage).priced).toBe(false);
    expect(priceStoredUsageSample(stored)).toEqual({ costUsd: 0.0204, costSource: 'estimated', costBound: 'lower' });
  });
});

describe('interactive transcript rows (ingest-claude-transcripts.ts NULL-column flags)', () => {
  it('a request row passes its request size and both write tiers', () => {
    expect(storedSampleTokenUsage(row({}))).toEqual({
      inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50000, cacheCreationTokens: 2000,
      cacheCreation5mTokens: 1500, cacheCreation1hTokens: 500, requestInputTokens: 53200,
    } satisfies TokenUsage);
    // (1200*5 + 300*25 + 50000*0.5 + 1500*6.25 + 500*10) / 1M.
    expect(priceStoredUsageSample(row({}))).toEqual({ costUsd: 0.052875, costSource: 'estimated', costBound: null });
  });

  it('applies the long-context tier from the request size', () => {
    const big = row({ provider: 'openai', model: 'gpt-6-sol', input_tokens: '300000', cache_creation_5m_tokens: null, cache_creation_1h_tokens: null });
    const small = row({ provider: 'openai', model: 'gpt-6-sol', input_tokens: '1000', cache_creation_5m_tokens: null, cache_creation_1h_tokens: null });
    const bigUsd = priceStoredUsageSample(big).costUsd!;
    // Above 272K: input/cache rates double, output is 1.5x.
    expect(bigUsd).toBe(1.2345);
    expect(storedSampleTokenUsage(big)!.requestInputTokens).toBe(352000);
    expect(storedSampleTokenUsage(small)!.requestInputTokens).toBe(53000);
    expect(priceStoredUsageSample(small).costSource).toBe('estimated');
    expect(priceStoredUsageSample(small).costUsd).toBe(0.02);
  });

  it('a file-model-delta row carries no request size, so a long-context model prices at its floor', () => {
    const stored = row({ provider: 'openai', model: 'gpt-6-sol', grain: 'file-model-delta', cache_creation_5m_tokens: null, cache_creation_1h_tokens: null });
    const usage = storedSampleTokenUsage(stored)!;
    expect(usage.requestInputTokens).toBeUndefined();
    expect(priceStoredUsageSample(stored)).toEqual({ costUsd: 0.0204, costSource: 'estimated', costBound: 'lower' });
  });

  it('NULL input means the uncached input was never decomposed: unpriced', () => {
    expect(priceStoredUsageSample(row({ input_tokens: null }))).toEqual({ costUsd: null, costSource: null, costBound: null });
  });

  it('NULL cache writes means the source did not report them: unpriced', () => {
    expect(storedSampleTokenUsage(row({ cache_creation_tokens: null }))!.cacheCreationUnreported).toBe(true);
    expect(priceStoredUsageSample(row({ cache_creation_tokens: null })).costUsd).toBeNull();
  });

  it('an Anthropic row with writes but no TTL split prices at the 5-minute floor, marked as a lower bound', () => {
    // WI-10004517: before the TTL split existed these rows were stored at exactly this floor
    // (measured on 558 live opus-4-7/4-8/sonnet-4-6 rows). Re-deriving them to NULL wiped that.
    const tierless = row({ cache_creation_5m_tokens: null, cache_creation_1h_tokens: null });
    expect(costFromTokens('claude-opus-4-8', storedSampleTokenUsage(tierless)!).priced).toBe(false);
    // Unsplit writes use 2000*6.25/1M; known one-hour writes use 2000*10/1M.
    expect(priceStoredUsageSample(tierless)).toEqual({ costUsd: 0.051, costSource: 'estimated', costBound: 'lower' });
    expect(priceStoredUsageSample(row({ cache_creation_5m_tokens: '0', cache_creation_1h_tokens: '2000' })))
      .toEqual({ costUsd: 0.0585, costSource: 'estimated', costBound: null });
    // A model that is not priced at all stays NULL: the floor needs a price too.
    expect(priceStoredUsageSample(row({ model: 'probe', cache_creation_5m_tokens: null, cache_creation_1h_tokens: null })))
      .toEqual({ costUsd: null, costSource: null, costBound: null });
    const openai = row({ provider: 'openai', model: 'gpt-5.5', cache_creation_5m_tokens: null, cache_creation_1h_tokens: null });
    expect(storedSampleTokenUsage(openai)!.cacheCreationTierUnknown).toBeUndefined();
    expect(priceStoredUsageSample(openai).costSource).toBe('estimated');
  });

  it('an aggregate of a long-context model prices at its standard-tier floor, marked as a lower bound', () => {
    // D-020: live row 120573 (gpt-6-astra, 2026-09-17) was stored at $11.472932 before the model
    // gained a long-context tier on 2026-09-23. Under refuse-mode pricing the repricer nulled it.
    const astra = row({
      provider: 'openai', model: 'gpt-6-astra', input_tokens: '366710', output_tokens: '9444',
      cache_read_tokens: '7333632', cache_creation_tokens: '0', cache_creation_5m_tokens: null,
      cache_creation_1h_tokens: null, grain: null,
    });
    expect(costFromTokens('gpt-6-astra', storedSampleTokenUsage(astra)!).priced).toBe(false);
    const priced = priceStoredUsageSample(astra);
    expect(priced.costBound).toBe('lower');
    expect(priced.costUsd).toBeCloseTo(11.472932, 9);
    // A request-grain row has a size, so it prices exactly with no bound.
    const request = priceStoredUsageSample({ ...astra, grain: 'request' });
    expect(request.costBound).toBeNull();
    expect(request.costUsd).toBeCloseTo(22.709764, 9);
    // The jsonl/headers writers' aggregates take the same floor.
    expect(priceStoredUsageSample({ ...astra, source: 'jsonl' }).costBound).toBe('lower');
  });

  it('an Anthropic row with zero writes needs no TTL split', () => {
    const stored = row({ cache_creation_tokens: '0', cache_creation_5m_tokens: null, cache_creation_1h_tokens: null });
    expect(priceStoredUsageSample(stored).costSource).toBe('estimated');
  });
});

describe('rows the repricer cannot price', () => {
  it('no model, an unknown model, or an unknown writer stays unpriced', () => {
    expect(priceStoredUsageSample(row({ model: null }))).toEqual({ costUsd: null, costSource: null, costBound: null });
    expect(priceStoredUsageSample(row({ model: 'probe' }))).toEqual({ costUsd: null, costSource: null, costBound: null });
    expect(storedSampleTokenUsage(row({ source: 'something-new' }))).toBeNull();
  });
});

describe('price injection (how the integration test stands in for a changed table)', () => {
  it('uses the injected pricing function', () => {
    const doubled = (model: string, usage: TokenUsage, options?: CostOptions) => {
      const est = costFromTokens(model, usage, options);
      return { ...est, usd: est.usd * 2 };
    };
    expect(priceStoredUsageSample(row({}), doubled).costUsd).toBeCloseTo(0.10575, 15);
  });
});
