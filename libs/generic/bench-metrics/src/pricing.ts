/**
 * The PUBLISHED price table + the pure `priceRun` cost function. Cost is a
 * DERIVED quantity: raw tokens are ground truth (stored on every run-result
 * row), and `cost_usd` = `priceRun(tokens, model_id, table)`. One table is
 * applied identically to every arm — never provider-reported $ for one arm and
 * computed for another (that would confound the cost/accuracy comparison). The
 * `version` is stored on each row so any third party can recompute the same $
 * from the published tokens.
 *
 * Prices are list prices per MILLION tokens (Anthropic public pricing, as of the
 * `version` date — verify against platform.claude.com/pricing before any
 * external publication; correcting a price = bump the version, re-derive cost
 * from stored tokens, no re-run). Cache prices follow the documented multipliers
 * (prompt-caching: cache read ≈ 0.1× input; cache write 5-minute TTL ≈ 1.25×
 * input) rather than separately-quoted numbers, so they stay consistent if a
 * base input price is corrected.
 */

/** Per-million-token list prices for one model. */
export interface ModelPrice {
  /** $ per 1M input (uncached) tokens. */
  inputPerMtok: number;
  /** $ per 1M output tokens. */
  outputPerMtok: number;
  /** $ per 1M cache-READ tokens (≈ 0.1× input). */
  cacheReadPerMtok: number;
  /** $ per 1M cache-WRITE tokens, 5-minute TTL (≈ 1.25× input). */
  cacheWritePerMtok: number;
}

import { MODEL_PRICES, PRICE_TABLE_VERSION as MODEL_PRICING_VERSION, normalizeModelId } from '@papercusp/model-pricing';

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
/** A dated snapshot suffix (`-20251101`, `-2026-09`, `-2026-09-23`) — the only extension that inherits a price. */
const DATED_SUFFIX_RE = /^-(?:\d{8}|\d{4}-\d{2}(?:-\d{2})?)$/;

/** Build a ModelPrice from base input/output, deriving cache prices by multiplier. */
function price(inputPerMtok: number, outputPerMtok: number): ModelPrice {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: round4(inputPerMtok * CACHE_READ_MULT),
    cacheWritePerMtok: round4(inputPerMtok * CACHE_WRITE_5M_MULT),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** A versioned price table: model id (or alias prefix) → ModelPrice. */
export interface PriceTable {
  version: string;
  prices: Record<string, ModelPrice>;
  /**
   * How an id that is not a key resolves. `prefix` (default; V1): the longest key that prefixes the id, so a
   * newer model whose id extends an older key (`claude-opus-5-5` vs `claude-opus-5`) silently takes the older
   * price. `snapshot`: the normalized id (vendor prefix, `:effort` and `[1m]` removed) must equal a key, or be
   * a DATED snapshot of one; anything else is unknown and {@link priceRun} refuses it.
   */
  match?: 'prefix' | 'snapshot';
}

/**
 * price-table-v1 — Anthropic list prices per 1M tokens (model catalog cached
 * 2026-06-04). The 4.x Opus tier is $5 in / $25 out (NOT the legacy $15/$75).
 */
export const PRICE_TABLE_V1: PriceTable = {
  version: 'price-table-v1',
  prices: {
    'claude-opus-5': price(5, 25),
    'claude-opus-4-8': price(5, 25),
    'claude-opus-4-7': price(5, 25),
    'claude-opus-4-6': price(5, 25),
    'claude-sonnet-4-6': price(3, 15),
    'claude-haiku-4-5': price(1, 5),
    'claude-fable-5': price(10, 50),
  },
};

/**
 * price-table-v2 — DERIVED from `@papercusp/model-pricing` (the platform's single price source) rather than
 * hand-maintained, so a model added there is priced here with no second edit. Its version embeds the
 * model-pricing table version, so a stored row still names the exact prices it was costed under. Matching is
 * `snapshot` (see {@link PriceTable.match}). Cache prices use model-pricing's explicit value when it quotes
 * one, else the documented multipliers. Long-context surcharges are NOT applied (as in V1).
 *
 * V1 stays the default for now: changing the default re-prices every emitted row, and the frozen-protocol
 * emitter that consumes it belongs to the benchmark-modernization plan.
 */
export const PRICE_TABLE_V2: PriceTable = {
  version: `price-table-v2+${MODEL_PRICING_VERSION}`,
  match: 'snapshot',
  prices: Object.fromEntries(
    Object.entries(MODEL_PRICES).map(([id, p]) => [
      id,
      {
        inputPerMtok: p.in,
        outputPerMtok: p.out,
        cacheReadPerMtok: p.cacheRead ?? round4(p.in * CACHE_READ_MULT),
        cacheWritePerMtok: p.cacheWrite ?? round4(p.in * CACHE_WRITE_5M_MULT),
      },
    ]),
  ),
};

/** Every published table by version, so a stored `price_table_version` can be re-priced exactly. */
export function priceTableForVersion(version: string): PriceTable | null {
  for (const t of [PRICE_TABLE_V1, PRICE_TABLE_V2]) if (t.version === version) return t;
  return null;
}

export const DEFAULT_PRICE_TABLE = PRICE_TABLE_V1;

/** The raw token counts that drive cost. cacheRead/cacheWrite are optional. */
export interface RunTokens {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
}

/**
 * Resolve a model id to its ModelPrice. Exact match first; then the longest
 * registered key that is a prefix of `modelId` (so `claude-opus-4-8[1m]` and
 * `claude-opus-4-8` both resolve to the Opus 4.8 row). Returns null if unknown.
 */
export function resolveModelPrice(modelId: string, table: PriceTable = DEFAULT_PRICE_TABLE): ModelPrice | null {
  if (Object.hasOwn(table.prices, modelId)) return table.prices[modelId];
  if (table.match === 'snapshot') {
    const norm = normalizeModelId(modelId);
    if (Object.hasOwn(table.prices, norm)) return table.prices[norm];
    const dated = Object.keys(table.prices)
      .filter((key) => norm.startsWith(key) && DATED_SUFFIX_RE.test(norm.slice(key.length)))
      .sort((a, b) => b.length - a.length)[0];
    return dated ? table.prices[dated] : null;
  }
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, p] of Object.entries(table.prices)) {
    if (modelId.startsWith(key) && (best === null || key.length > best.key.length)) {
      best = { key, price: p };
    }
  }
  return best?.price ?? null;
}

/**
 * Cost in USD for one run's token usage under a price table. Pure. THROWS on an
 * unknown model (better a loud failure than a silently-zero cost that corrupts
 * the cost/accuracy comparison) — register the model in the table first.
 *
 * `tokensIn` is the UNCACHED input; cache-read and cache-write tokens are billed
 * at their own rates and are NOT double-counted in tokensIn (matches the
 * provider's usage accounting: input_tokens excludes cache_read/cache_creation).
 */
export function priceRun(tokens: RunTokens, modelId: string, table: PriceTable = DEFAULT_PRICE_TABLE): number {
  const p = resolveModelPrice(modelId, table);
  if (p === null) {
    throw new Error(`priceRun: no price for model "${modelId}" in table "${table.version}"; register it before scoring`);
  }
  const cacheRead = tokens.tokensCacheRead ?? 0;
  const cacheWrite = tokens.tokensCacheWrite ?? 0;
  const usd =
    (tokens.tokensIn * p.inputPerMtok +
      tokens.tokensOut * p.outputPerMtok +
      cacheRead * p.cacheReadPerMtok +
      cacheWrite * p.cacheWritePerMtok) /
    1_000_000;
  return usd;
}
