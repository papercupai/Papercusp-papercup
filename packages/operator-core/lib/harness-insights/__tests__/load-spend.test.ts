/**
 * loadHarnessSpend tests (cross-backend-cost-capture P-006).
 *
 * Reads real per-harness spend from `agent_usage_samples` — total $cost,
 * the estimated-from-tokens subset (cost_source='estimated'), token
 * throughput, and run count, all workspace + harness scoped.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadHarnessPipelineSpend, loadHarnessSpend } from '../load-spend';

type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

function makeRunQuery(
  stubs: Array<{ match: RegExp; rows: unknown[] | (() => never) }>,
): RunQuery {
  return vi.fn(async (query: string): Promise<unknown[]> => {
    for (const s of stubs) {
      if (s.match.test(query)) {
        if (typeof s.rows === 'function') return s.rows();
        return s.rows;
      }
    }
    return [];
  }) as unknown as RunQuery;
}

describe('loadHarnessSpend', () => {
  it('zeros when no rows', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([]),
    });
    expect(out).toEqual({
      harnessTotalUsdThisWeek: 0,
      estimatedUsdThisWeek: 0,
      tokensThisWeek: 0,
      runsThisWeek: 0,
    });
  });

  it('reads total / estimated / tokens / runs from agent_usage_samples', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /agent_usage_samples/,
          rows: [{ runs: 7, total_usd: 12.5, estimated_usd: 4.5, tokens: 1_500_000 }],
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(12.5);
    expect(out.estimatedUsdThisWeek).toBe(4.5);
    expect(out.tokensThisWeek).toBe(1_500_000);
    expect(out.runsThisWeek).toBe(7);
  });

  it('coerces string aggregates (postgres bigint/numeric come back as strings)', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /agent_usage_samples/,
          rows: [{ runs: '3', total_usd: '0.030000', estimated_usd: '0', tokens: '4096' }],
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBeCloseTo(0.03, 9);
    expect(out.estimatedUsdThisWeek).toBe(0);
    expect(out.tokensThisWeek).toBe(4096);
    expect(out.runsThisWeek).toBe(3);
  });

  it('degrades to zeros when the table/columns are missing (pre-migration substrate)', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /agent_usage_samples/,
          rows: () => {
            throw new Error('column "cost_source" does not exist');
          },
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(0);
    expect(out.estimatedUsdThisWeek).toBe(0);
  });

  it('scopes the query by workspace_id + harness_slug as $1/$2 (P-041)', async () => {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const runQuery = vi.fn(async (query: string, params: unknown[]) => {
      calls.push({ query, params });
      return [{ runs: 0, total_usd: 0, estimated_usd: 0, tokens: 0 }];
    }) as unknown as RunQuery;
    await loadHarnessSpend({
      workspace_id: 'ws-alpha',
      harness_slug: 'papercup',
      runQuery,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].query).toMatch(/workspace_id\s*=\s*\$1/);
    expect(calls[0].query).toMatch(/harness_slug\s*=\s*\$2/);
    expect(calls[0].params[0]).toBe('ws-alpha');
    expect(calls[0].params[1]).toBe('papercup');
  });

  it('sums ALL FOUR token types — input+output+cache_read+cache_creation (B-TOK-2 cache-undercount fix)', async () => {
    // The mocked runQuery returns canned rows, so the fix is verified on the GENERATED
    // SQL: the token total must include the cache columns (cache-read is ~82% of all
    // tokens — the prior input+output-only sum under-counted ~5x).
    let captured = '';
    const runQuery = vi.fn(async (query: string) => {
      captured = query;
      return [{ runs: 0, total_usd: 0, estimated_usd: 0, tokens: 0 }];
    }) as unknown as RunQuery;
    await loadHarnessSpend({ workspace_id: 'ws', harness_slug: 'papercup', runQuery });
    // The tokens aggregate references all four token columns.
    expect(captured).toMatch(/input_tokens/);
    expect(captured).toMatch(/output_tokens/);
    expect(captured).toMatch(/cache_read_tokens/);
    expect(captured).toMatch(/cache_creation_tokens/);
    // …and all four are summed together into the `tokens` column (they appear, in order,
    // within the single token aggregate ending in `AS tokens`).
    expect(captured).toMatch(
      /input_tokens[\s\S]*?output_tokens[\s\S]*?cache_read_tokens[\s\S]*?cache_creation_tokens[\s\S]*?AS tokens/,
    );
  });

  it('handles null aggregates (no rows in window)', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /agent_usage_samples/,
          rows: [{ runs: 0, total_usd: null, estimated_usd: null, tokens: null }],
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(0);
    expect(out.tokensThisWeek).toBe(0);
  });
});

describe('loadHarnessPipelineSpend', () => {
  const sample = { run_id: 'worker', archived: true, sample_id: 12,
    cost_usd: '0.4', cost_source: 'provider', usage_provenance: { backend: 'codex' } };
  const read = (rows: unknown[]) => loadHarnessPipelineSpend({ workspace_id: 'ws',
    harness_slug: 'gym', runQuery: makeRunQuery([{ match: /agent_usage_samples/, rows }]) });

  it('keeps provider, estimate, source identity and provenance separately', async () => {
    const out = await read([sample, { ...sample, sample_id: 13, cost_usd: '0.2', cost_source: 'estimated' }]);
    expect(out.knownUsd).toBeCloseTo(0.6);
    expect(out).toMatchObject({ providerUsd: 0.4, estimatedUsd: 0.2, complete: true, measured: false,
      samples: [{ sampleId: '12', runId: 'worker', costSource: 'provider', provenance: sample.usage_provenance },
        { sampleId: '13', costSource: 'estimated' }] });
  });

  it('distinguishes an explicit measured zero from absent usage', async () => {
    expect(await read([{ ...sample, cost_usd: 0 }])).toMatchObject({ knownUsd: 0, complete: true, measured: true });
    expect(await read([])).toMatchObject({ knownUsd: 0, complete: false, measured: false });
    expect(await read([{ ...sample, sample_id: null, cost_usd: null, cost_source: null }]))
      .toMatchObject({ knownUsd: 0, complete: false, measured: false, missingRunIds: ['worker'], samples: [] });
  });

  it.each([null, -1, 'NaN', 'Infinity'])('retains unknown or invalid cost %s without fabricating zero', async (cost) => {
    const out = await read([sample, { ...sample, run_id: 'unpriced', sample_id: 13, cost_usd: cost }]);
    expect(out).toMatchObject({ knownUsd: 0.4, complete: false, measured: false, missingRunIds: ['unpriced'] });
    expect(out.samples[1].costUsd).toBeNull();
  });

  it('keeps orphan or unclassified samples incomplete', async () => {
    expect(await read([{ ...sample, archived: false }])).toMatchObject({ knownUsd: 0.4, complete: false, measured: false });
    expect(await read([{ ...sample, cost_source: null }])).toMatchObject({ knownUsd: 0, complete: false, measured: false });
  });

  it('propagates a query failure instead of returning a measured zero', async () => {
    const error = new Error('usage ledger unavailable');
    await expect(loadHarnessPipelineSpend({ workspace_id: 'ws', harness_slug: 'gym',
      runQuery: makeRunQuery([{ match: /agent_usage_samples/, rows: () => { throw error; } }]) })).rejects.toBe(error);
  });
});
