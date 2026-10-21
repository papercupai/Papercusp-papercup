/**
 * Unit coverage for agent-usage-telemetry (rate-limit-layer-v2 D-002). The two
 * collaborators — org PG (`getOrgPg().sql`) and model pricing (`costFromTokens`)
 * — are mocked so we can assert the *shape* of what gets persisted (or that
 * nothing does) without a real database. The `sql` tagged template captures the
 * interpolated VALUES of the INSERT so we can inspect the finite-guard mapping,
 * cost-source derivation and rate-limit header parsing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above module-scope consts, so the spies must be.
const { sqlCalls, costFromTokens, sqlShouldThrow, sqlRows } = vi.hoisted(() => ({
  // Each tagged-template INSERT pushes { text, values } here.
  sqlCalls: [] as { text: string; values: unknown[] }[],
  costFromTokens: vi.fn((_model: string, _usage: unknown, _options?: unknown): { usd: number; priced: boolean; bound?: 'lower' } => ({
    usd: 0,
    priced: false,
  })),
  // Flip true to make getOrgPg().sql throw, exercising the best-effort swallow.
  sqlShouldThrow: { value: false },
  // Rows every tagged-template query resolves with (summarizeUsage reads them; INSERTs ignore them).
  sqlRows: { value: [] as unknown[] },
}));

// PRICE_TABLE_VERSION must be on the mock: a missing export THROWS on read, and the writer's
// best-effort try/catch would swallow it and skip the INSERT entirely (WI-10004517).
vi.mock('@papercusp/model-pricing', () => ({
  costFromTokens, PRICE_TABLE_VERSION: 'pt-test', USAGE_LEDGER_PRICING: { unknownTier: 'floor' },
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('@papercusp/db-org', async (orig) => {
  // `sql` is used two ways: as a tagged template (the INSERT) and as a plain
  // call `sql(TABLE)` to interpolate the table identifier. We model the latter
  // as a sentinel object that stringifies to the table name inside the captured
  // text, and the former captures the interpolated runtime values.
  function sql(strings: TemplateStringsArray | string, ...values: unknown[]): unknown {
    if (typeof strings === 'string') {
      // sql(TABLE) — identifier interpolation. Return a sentinel that renders
      // the table name when joined into the template text.
      return { __ident: strings, toString: () => strings };
    }
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? String(values[i] ?? '') : ''),
      '',
    );
    if (sqlShouldThrow.value) throw new Error('pg exploded');
    sqlCalls.push({ text, values });
    return Promise.resolve(sqlRows.value);
  }
  return { ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql }) };
});

import {
  recordUsageSample,
  recordUsageHeaders,
  recordUsageTokens,
  summarizeUsage,
  type UsageSample,
} from './agent-usage-telemetry';

// Column order of the INSERT VALUES(...) — used to read a captured value by name.
const COLS = [
  'workspace_id',
  'ts',
  'bucket_key',
  'provider',
  'model_class',
  'source',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
  'model',
  'cost_source',
  'harness_slug',
  'run_id',
  'role',
  'rl_requests_limit',
  'rl_requests_remaining',
  'rl_tokens_limit',
  'rl_tokens_remaining',
  'rl_reset_at',
  'session_id',
  // goal_id is resolved by a SQL function at INSERT time; these are its
  // bound workspace/session arguments, not persisted result columns.
  'goal_attribution_workspace_id',
  'goal_attribution_session_id',
  'tool_name',
  'turn_trigger',
  'account_id',
  'price_table_version',
  'usage_provenance',
] as const;

type Col = (typeof COLS)[number];

/** Read a persisted column from the (single) captured INSERT. The first
 *  interpolated value is the `${sql(TABLE)}` identifier sentinel, so the column
 *  values start at index 1 and line up with COLS thereafter. */
function lastInsert(): Record<Col, unknown> {
  expect(sqlCalls).toHaveLength(1);
  const cols = sqlCalls[0].values.slice(1);
  const out = {} as Record<Col, unknown>;
  COLS.forEach((c, i) => {
    out[c] = cols[i];
  });
  return out;
}

beforeEach(() => {
  sqlCalls.length = 0;
  sqlShouldThrow.value = false;
  sqlRows.value = [];
  costFromTokens.mockReset();
  costFromTokens.mockReturnValue({ usd: 0, priced: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordUsageTokens (jsonl skip guard)', () => {
  it('returns without writing when inputTokens, outputTokens, and costUsd are all undefined', async () => {
    await recordUsageTokens('b', 'anthropic', 'opus', { cacheReadTokens: 10 });
    expect(sqlCalls).toHaveLength(0);
  });

  it("writes a source:'jsonl' sample when any of the three is present", async () => {
    await recordUsageTokens('bucket', 'anthropic', 'opus', { outputTokens: 5 });
    const row = lastInsert();
    expect(row.source).toBe('jsonl');
    expect(row.bucket_key).toBe('bucket');
    expect(row.output_tokens).toBe(5);
  });

  it('writes when only costUsd is present (zero tokens still a real call)', async () => {
    costFromTokens.mockReturnValue({ usd: 0, priced: false });
    await recordUsageTokens('b', 'anthropic', 'opus', { costUsd: 0.42 });
    const row = lastInsert();
    expect(row.cost_usd).toBe(0.42);
    expect(row.cost_source).toBe('provider');
  });
});

describe('recordUsageHeaders (rate-limit header parsing)', () => {
  it('falls back to anthropic-ratelimit-input-tokens-* when the non-input variants are absent', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'anthropic-ratelimit-input-tokens-limit': '1000',
      'anthropic-ratelimit-input-tokens-remaining': '250',
    });
    const row = lastInsert();
    expect(row.rl_tokens_limit).toBe(1000);
    expect(row.rl_tokens_remaining).toBe(250);
  });

  it('prefers the non-input variants over the input-* fallback when both present', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'anthropic-ratelimit-tokens-limit': '9000',
      'anthropic-ratelimit-input-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '8000',
      'anthropic-ratelimit-input-tokens-remaining': '250',
    });
    const row = lastInsert();
    expect(row.rl_tokens_limit).toBe(9000);
    expect(row.rl_tokens_remaining).toBe(8000);
  });

  it('normalizes mixed-case header keys (lowercases before lookup)', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'Anthropic-RateLimit-Tokens-Limit': '777',
      'ANTHROPIC-RATELIMIT-REQUESTS-LIMIT': '40',
    });
    const row = lastInsert();
    expect(row.rl_tokens_limit).toBe(777);
    expect(row.rl_requests_limit).toBe(40);
  });

  it('parses a valid ISO reset header into an epoch-ms number', async () => {
    const iso = '2026-06-15T12:00:00.000Z';
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'anthropic-ratelimit-tokens-limit': '100',
      'anthropic-ratelimit-tokens-reset': iso,
    });
    const row = lastInsert();
    expect(row.rl_reset_at).toBe(Date.parse(iso));
    expect(typeof row.rl_reset_at).toBe('number');
  });

  it('sets rlResetAt null for an unparseable reset header while still persisting other usage', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      'anthropic-ratelimit-tokens-limit': '100',
      'anthropic-ratelimit-tokens-reset': 'not-a-date',
    });
    const row = lastInsert();
    // Date.parse → NaN → undefined sample field → n() persists null.
    expect(row.rl_reset_at).toBeNull();
    expect(row.rl_tokens_limit).toBe(100);
  });

  it('skips a wholly-empty sample (no rl limits AND no tokens AND no costUsd)', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {
      // remaining without a limit is not enough to trip the guard
      'anthropic-ratelimit-tokens-remaining': '5',
    });
    expect(sqlCalls).toHaveLength(0);
  });

  it('persists when only the caller-supplied tokens are present (no headers at all)', async () => {
    await recordUsageHeaders('b', 'anthropic', 'opus', {}, { inputTokens: 12 });
    const row = lastInsert();
    expect(row.source).toBe('headers');
    expect(row.input_tokens).toBe(12);
  });

  it('EI-7625: persists caller attribution (role/runId/sessionId/toolName/model) on a header sample', async () => {
    await recordUsageHeaders(
      'b',
      'anthropic',
      'haiku',
      {},
      {
        inputTokens: 12,
        model: 'claude-haiku-4-5',
        role: 'memory-extraction',
        runId: 'run-9',
        sessionId: 'sess-1',
        toolName: 'memory:remember',
      },
    );
    const row = lastInsert();
    expect(row.source).toBe('headers');
    expect(row.role).toBe('memory-extraction');
    expect(row.run_id).toBe('run-9');
    expect(row.session_id).toBe('sess-1');
    expect(row.tool_name).toBe('memory:remember');
    expect(row.model).toBe('claude-haiku-4-5');
  });

  // WI-2144763. Every `source:'headers'` row carried harness_slug NULL — 18,228 rows /
  // ~$755, a flat 0.00% — rendering as '(unattributed)'. The column, this INSERT and the
  // orchestrator sink ALL already carried it; the only missing link was that
  // `StatelessUsageAttribution` had no harnessSlug field for a caller to populate. These
  // two cases pin the seam from BOTH sides, because a fix that only ever writes a slug is
  // as wrong as one that never does: a caller that genuinely does not know the harness
  // (workspace-global work) must still record an honest NULL rather than a guess.
  it('WI-2144763: persists harnessSlug on a header sample when the caller knows it', async () => {
    await recordUsageHeaders(
      'b',
      'anthropic',
      'haiku',
      {},
      { inputTokens: 12, role: 'scout', harnessSlug: 'papercusp-public-site-pot' },
    );
    const row = lastInsert();
    expect(row.source).toBe('headers');
    expect(row.role).toBe('scout');
    expect(row.harness_slug).toBe('papercusp-public-site-pot');
  });

  it('WI-2144763: writes harness_slug NULL (never undefined) when the caller does not know the harness', async () => {
    await recordUsageHeaders('b', 'anthropic', 'haiku', {}, { inputTokens: 12, role: 'llm-testing' });
    const row = lastInsert();
    expect(row.source).toBe('headers');
    expect(row.harness_slug).toBeNull();
  });
});

describe('recordUsageSample (best-effort persistence + cost honesty)', () => {
  it('swallows a thrown getOrgPg/sql error (resolves without throwing into the agent path)', async () => {
    sqlShouldThrow.value = true;
    await expect(
      recordUsageSample({
        bucketKey: 'b',
        provider: 'anthropic',
        modelClass: 'opus',
        source: 'jsonl',
        inputTokens: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("derives costSource 'provider' when costUsd present and costSource omitted", async () => {
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      costUsd: 1.5,
    });
    const row = lastInsert();
    expect(row.cost_usd).toBe(1.5);
    expect(row.cost_source).toBe('provider');
    expect(costFromTokens).not.toHaveBeenCalled();
  });

  it('persists session_id / tool_name / turn_trigger / account_id attribution, null-safe when absent', async () => {
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      costUsd: 1,
      sessionId: 'sess-1',
      toolName: 'gateway:set-aimd',
      turnTrigger: 'coord-wake',
      accountId: 'acct-claude-a',
    });
    const row = lastInsert();
    expect(row.session_id).toBe('sess-1');
    expect(row.tool_name).toBe('gateway:set-aimd');
    expect(row.turn_trigger).toBe('coord-wake');
    expect(row.account_id).toBe('acct-claude-a');

    sqlCalls.length = 0;
    await recordUsageSample({ bucketKey: 'b', provider: 'anthropic', modelClass: 'opus', source: 'headers', inputTokens: 5 });
    const bare = lastInsert();
    expect(bare.session_id).toBeNull();
    expect(bare.tool_name).toBeNull();
    expect(bare.turn_trigger).toBeNull();
    expect(bare.account_id).toBeNull();
  });

  it('keeps an explicitly-supplied costSource (does not override)', async () => {
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      costUsd: 2,
      costSource: 'estimated',
    });
    expect(lastInsert().cost_source).toBe('estimated');
  });

  it('persists null cost_source when neither cost present nor model priceable', async () => {
    costFromTokens.mockReturnValue({ usd: 0, priced: false });
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: 100,
      model: 'mystery-model',
    });
    const row = lastInsert();
    expect(row.cost_usd).toBeNull();
    expect(row.cost_source).toBeNull();
    expect(costFromTokens).toHaveBeenCalledWith('mystery-model', expect.any(Object), { unknownTier: 'floor' });
  });

  it("derives 'estimated' only when costUsd null but a known model prices via costFromTokens", async () => {
    costFromTokens.mockReturnValue({ usd: 0.0123, priced: true });
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: 1000,
      outputTokens: 500,
      model: 'claude-opus-4',
    });
    const row = lastInsert();
    expect(row.cost_usd).toBe(0.0123);
    expect(row.cost_source).toBe('estimated');
    // WI-10004517 / D-018: an estimate records the price table it was derived from, so the
    // repricer can find it when the table changes.
    expect(row.price_table_version).toBe('pt-test');
    // The estimate prices exactly the four stored counters — the shape the repricer rebuilds.
    expect(costFromTokens).toHaveBeenCalledWith('claude-opus-4', {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: undefined, cacheCreationTokens: undefined,
    }, { unknownTier: 'floor' });
    // An exact estimate carries no bound, so no provenance is written.
    expect(row.usage_provenance).toBeNull();
  });

  it('records a floor-priced aggregate as a lower bound (D-020)', async () => {
    // An aggregate of a long-context model has no request size: the library prices its floor.
    costFromTokens.mockReturnValue({ usd: 11.472932, priced: true, bound: 'lower' });
    await recordUsageSample({
      bucketKey: 'b', provider: 'openai', modelClass: 'gpt', source: 'headers',
      inputTokens: 366_710, outputTokens: 9_444, cacheReadTokens: 7_333_632, model: 'gpt-6-astra',
    });
    const row = lastInsert();
    expect(row.cost_usd).toBe(11.472932);
    expect(row.cost_source).toBe('estimated');
    expect(row.price_table_version).toBe('pt-test');
    expect(JSON.parse(String(row.usage_provenance))).toEqual({ costBound: 'lower' });
  });

  it('stamps the price table version on an unpriced row so a later table can price it', async () => {
    costFromTokens.mockReturnValue({ usd: 0, priced: false });
    await recordUsageSample({
      bucketKey: 'b', provider: 'openai', modelClass: 'gpt', source: 'jsonl',
      inputTokens: 10, model: 'not-yet-priced',
    });
    const row = lastInsert();
    expect(row.cost_usd).toBeNull();
    expect(row.price_table_version).toBe('pt-test');
  });

  it('does NOT estimate when costUsd is already provider-reported, even with a model set', async () => {
    costFromTokens.mockReturnValue({ usd: 99, priced: true });
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      costUsd: 0.5,
      model: 'claude-opus-4',
    });
    const row = lastInsert();
    expect(row.cost_usd).toBe(0.5);
    expect(row.cost_source).toBe('provider');
    // Provider cost is an observation, not a derivation: no table version, never repriced.
    expect(row.price_table_version).toBeNull();
    expect(costFromTokens).not.toHaveBeenCalled();
  });
});

describe('n() finite-guard on persisted INSERT values', () => {
  it('maps NaN / Infinity / undefined token fields to null (never 0 or a fabricated number)', async () => {
    const sample: UsageSample = {
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
      // cacheReadTokens left undefined
      cacheCreationTokens: Number.NEGATIVE_INFINITY,
      costUsd: 0.1, // keeps the row writable (skip guard is on the callers, not here)
    };
    await recordUsageSample(sample);
    const row = lastInsert();
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.cache_read_tokens).toBeNull();
    expect(row.cache_creation_tokens).toBeNull();
    // a finite value is preserved as-is, proving null is not a blanket default
    expect(row.cost_usd).toBe(0.1);
  });

  it('preserves finite zero tokens (0 is a real count, not the same as absent)', async () => {
    await recordUsageSample({
      bucketKey: 'b',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    const row = lastInsert();
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
  });
});

// cloud-monitoring-byoc-privacy-2026-10-13 R-4 / D-004: a bucket with no observed
// rate-limit ceiling is UNKNOWN usage, never 0% (or 100%) — absence is not a measurement.
describe('summarizeUsage (usagePct honesty)', () => {
  const bucket = (over: Record<string, unknown>) => ({
    bucket_key: 'k',
    provider: 'anthropic',
    model_class: 'opus',
    calls: '2',
    input_tokens: '10',
    output_tokens: '5',
    cache_read_tokens: null,
    cache_creation_tokens: null,
    cost_usd: 0.5,
    rl_tokens_limit: null,
    rl_tokens_remaining: null,
    rl_reset_at: null,
    ...over,
  });

  it('reports usagePct null (not 0) when no ceiling was observed, while still totalling usage', async () => {
    sqlRows.value = [bucket({ bucket_key: 'subscription' })];
    const s = await summarizeUsage();
    expect(s.buckets).toHaveLength(1);
    expect(s.buckets[0].usagePct).toBeNull();
    expect(s.buckets[0].rlResetAt).toBeNull();
    expect(s.calls).toBe(2);
    expect(s.inputTokens).toBe(10);
    expect(s.spendUsd).toBe(0.5);
  });

  it('reports usagePct null for a zero limit or a missing remaining count (no fabricated ratio)', async () => {
    sqlRows.value = [
      bucket({ bucket_key: 'zero-limit', rl_tokens_limit: '0', rl_tokens_remaining: '0' }),
      bucket({ bucket_key: 'no-remaining', rl_tokens_limit: '1000', rl_tokens_remaining: null }),
    ];
    const s = await summarizeUsage();
    expect(s.buckets.map((b) => b.usagePct)).toEqual([null, null]);
  });

  it('computes usagePct from the observed ceiling when one exists', async () => {
    sqlRows.value = [bucket({ bucket_key: 'api', rl_tokens_limit: '1000', rl_tokens_remaining: '250', rl_reset_at: '1792540000000' })];
    const s = await summarizeUsage();
    expect(s.buckets[0].usagePct).toBe(75);
    expect(s.buckets[0].rlResetAt).toBe(1792540000000);
  });
});
