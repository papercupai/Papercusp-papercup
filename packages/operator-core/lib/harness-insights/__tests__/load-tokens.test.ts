/**
 * loadHarnessTokens — B-TOK-UI Tokens dashboard loader tests.
 *
 * The whole point of B-TOK is CACHE-INCLUSIVE accounting (the old input+output-only
 * sum under-counted ~105×, cache-read = 92.5% of tokens), so the load-bearing
 * assertion here is that EVERY query sums all four token types. Pure logic — an
 * injected runQuery dispatches by query shape, so there is no DB dependency.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadHarnessTokens, cloudDiagnosticAggregateFromUsage, exportCustomerUsageDiagnostics } from '../load-tokens';
import { createHostedPrincipal } from '../../auth/hosted-principal';
import { deliverCloudTelemetry } from '../../cloud-telemetry';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT, type CloudTelemetryConsent } from '../../telemetry-kinds';

type Row = Record<string, unknown>;

/** A runQuery mock that returns canned rows keyed off the query's shape. */
function makeRunQuery(rows: {
  totals?: Row[];
  byModel?: Row[];
  byRole?: Row[];
  byAccount?: Row[];
  byDay?: Row[];
  recentCalls?: Row[];
}) {
  const queries: string[] = [];
  const runQuery = vi.fn(async (query: string, _params: unknown[]) => {
    queries.push(query);
    if (query.includes('SELECT id, ts')) return rows.recentCalls ?? [];
    if (query.includes('day_start')) return rows.byDay ?? [];
    if (query.includes('account_id AS key')) return rows.byAccount ?? [];
    if (query.includes("NULLIF(model")) return rows.byModel ?? [];
    if (query.includes("NULLIF(role")) return rows.byRole ?? [];
    return rows.totals ?? [];
  });
  // loadHarnessTokens declares runQuery as a GENERIC fn (<T>(q, p) => Promise<T[]>);
  // a concrete vi.fn can never satisfy a generic signature, so cast at this one seam
  // (WI-4488). No test reaches for the Mock methods — `queries` carries the capture.
  return {
    runQuery: runQuery as unknown as <T = unknown>(query: string, params: unknown[]) => Promise<T[]>,
    queries,
  };
}

const baseOpts = { workspace_id: 'ws-1', harness_slug: 'papercusp' };

describe('loadHarnessTokens', () => {
  it('assembles a cache-inclusive snapshot with grouped breakdowns', async () => {
    const dayStart = Date.UTC(2026, 5, 14); // 2026-06-14 00:00 UTC
    const { runQuery, queries } = makeRunQuery({
      totals: [
        {
          runs: 120,
          total_usd: 42.5,
          estimated_usd: 5,
          tokens: 3_260_000_000,
          input_tokens: 10_000_000,
          output_tokens: 5_000_000,
          cache_read_tokens: 3_015_000_000,
          cache_creation_tokens: 230_000_000,
        },
      ],
      byModel: [
        { key: 'claude-opus-4', tokens: 2_900_000_000, cost_usd: 38, runs: 60 },
        { key: 'claude-sonnet-4', tokens: 360_000_000, cost_usd: 4.5, runs: 60 },
      ],
      byRole: [{ key: 'cup', tokens: 3_000_000_000, cost_usd: 40, runs: 100 }],
      byAccount: [{ key: 'acct-claude-a', tokens: 2_500_000_000, cost_usd: 35, runs: 80 }],
      byDay: [{ day_start: dayStart, tokens: 1_000_000, cost_usd: 12 }],
    });

    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });

    // Totals pass through, cache breakdown preserved.
    expect(snap.totals.tokens).toBe(3_260_000_000);
    expect(snap.totals.costUsd).toBe(42.5);
    expect(snap.totals.estimatedUsd).toBe(5);
    expect(snap.totals.runs).toBe(120);
    expect(snap.totals.cacheReadTokens).toBe(3_015_000_000);
    expect(snap.totals.cacheCreationTokens).toBe(230_000_000);

    // Grouped rows mapped + ordered as the query returned them.
    expect(snap.byModel.map((r) => r.key)).toEqual(['claude-opus-4', 'claude-sonnet-4']);
    expect(snap.byModel[0]).toMatchObject({ tokens: 2_900_000_000, costUsd: 38, runs: 60 });
    expect(snap.byRole).toHaveLength(1);
    expect(snap.byRole[0].key).toBe('cup');
    expect(snap.byAccount).toEqual([
      { key: 'acct-claude-a', tokens: 2_500_000_000, costUsd: 35, runs: 80 },
    ]);

    // Day bucket label is the deterministic UTC 'MMM D'.
    expect(snap.byDay).toEqual([{ startMs: dayStart, label: 'Jun 14', tokens: 1_000_000, costUsd: 12 }]);

    expect(snap.accountAttributionAvailable).toBe(true);
    expect(snap.windowMs).toBe(7 * 24 * 60 * 60 * 1000);

    // THE load-bearing guard: every query is cache-inclusive (all four token
    // columns), so the dashboard can never reproduce the undercount it exposes.
    expect(queries).toHaveLength(6);
    for (const q of queries) {
      expect(q).toContain('input_tokens');
      expect(q).toContain('output_tokens');
      expect(q).toContain('cache_read_tokens');
      expect(q).toContain('cache_creation_tokens');
    }
  });

  it('coerces string-typed numerics (pg returns SUM/COUNT as strings)', async () => {
    const { runQuery } = makeRunQuery({
      totals: [{ runs: '7', total_usd: '1.25', estimated_usd: '0', tokens: '900', input_tokens: '100', output_tokens: '50', cache_read_tokens: '700', cache_creation_tokens: '50' }],
      byModel: [{ key: 'opus', tokens: '900', cost_usd: '1.25', runs: '7' }],
    });
    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });
    expect(snap.totals.tokens).toBe(900);
    expect(snap.totals.runs).toBe(7);
    expect(snap.byModel[0].tokens).toBe(900);
    expect(snap.byModel[0].runs).toBe(7);
  });

  it('honors windowMs + groupLimit (the LIMIT + window predicate)', async () => {
    const { runQuery, queries } = makeRunQuery({ totals: [{ runs: 0 }] });
    await loadHarnessTokens({ ...baseOpts, windowMs: 24 * 60 * 60 * 1000, groupLimit: 5, runQuery });
    const grouped = queries.filter((q) => q.includes('GROUP BY 1') && q.includes('LIMIT'));
    expect(grouped.length).toBeGreaterThan(0);
    for (const q of grouped) expect(q).toContain('LIMIT 5');
  });

  it('returns the empty snapshot when there are no samples', async () => {
    const { runQuery } = makeRunQuery({}); // every query returns []
    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });
    expect(snap.totals.tokens).toBe(0);
    expect(snap.totals.runs).toBe(0);
    expect(snap.byModel).toEqual([]);
    expect(snap.byRole).toEqual([]);
    expect(snap.byAccount).toEqual([]);
    expect(snap.byDay).toEqual([]);
  });

  it('keeps unavailable evidence distinct from an observed empty ledger', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('column "cache_creation_tokens" does not exist');
    });
    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });
    expect(snap.totals).toMatchObject({ tokens: 0, costUsd: 0, runs: 0 });
    expect(snap.byModel).toEqual([]);
    expect(snap.accountAttributionAvailable).toBe(false);
    expect(snap.observation).toBe('unavailable');
    const observed = await loadHarnessTokens({ ...baseOpts, ...makeRunQuery({}) });
    expect(observed.observation).toBe('observed');
  });

  it('retains nullable per-call counters and separates provider, estimate and unknown cost', async () => {
    const { runQuery, queries } = makeRunQuery({
      totals: [{ runs: 3, reported_usd: '0.2', estimated_usd: '0.1', unpriced_calls: '1' }],
      recentCalls: [
        { id: 3, ts: 300, model: 'known', input_tokens: 100, output_tokens: 20, cache_read_tokens: 50,
          cache_creation_tokens: null, cost_usd: '0.2', cost_source: 'provider' },
        { id: 2, ts: 200, model: 'known', cost_usd: '0.1', cost_source: 'estimated' },
        { id: 1, ts: 100, model: 'unknown', input_tokens: null, cost_usd: null, cost_source: null },
      ],
    });
    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });
    expect(snap.totals).toMatchObject({ reportedUsd: 0.2, estimatedUsd: 0.1, unpricedCalls: 1 });
    expect(snap.recentCalls?.map(r => [r.costSource, r.costUsd])).toEqual([
      ['provider', 0.2], ['estimated', 0.1], ['unknown', null],
    ]);
    expect(snap.recentCalls?.[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50,
      cacheCreationTokens: null });
    expect(snap.recentCalls?.[2].inputTokens).toBeNull();
    const query = queries.find(q => q.includes('SELECT id, ts'))!;
    expect(query).toContain('workspace_id = $1 AND harness_slug = $2');
    expect(query).toContain('LIMIT 20');
    expect(query).not.toMatch(/usage_provenance|account_id|session_id|tool_name/);
    const aggregate = cloudDiagnosticAggregateFromUsage(snap, '00000000-0000-4000-8000-000000000001');
    expect(aggregate).toMatchObject({ event: 'cloud_diagnostic_aggregate', properties: {
      calls: 3, provider_cost_usd: 0.2, estimated_cost_usd: 0.1, unpriced_calls: 1,
    } });
    expect(JSON.stringify(aggregate)).not.toMatch(/known|account|session|prompt|task|log|host/);
    expect(cloudDiagnosticAggregateFromUsage({ ...snap, observation: 'unavailable' },
      '00000000-0000-4000-8000-000000000001')).toBeNull();
  });
});

describe('customer-local aggregate export', () => {
  const end = Date.parse('2026-10-14T12:00:00Z');
  const epoch = new Date(end - 1000).toISOString();
  const principal = createHostedPrincipal({ workspaceId: 'control', selectedWorkspaceId: 'ws-1',
    userId: 'user-1', activeOrganizationId: 'org-1', sessionId: 'session-1', sessionVersion: 1,
    permissions: ['workspace:operate', 'members:manage'] });
  const consent: CloudTelemetryConsent = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT, diagnostics: { enabled: true, since: epoch } };
  const input = { operation_id: '00000000-0000-4000-8000-000000000001', window_ms: 86400000 };
  function setup() {
    const { runQuery, queries } = makeRunQuery({ totals: [{ runs: 1, input_tokens: 10 }] });
    const authorize = vi.fn(async () => ({ ok: true as const, principal, monitoringConsent: consent }));
    const send = vi.fn(async () => {});
    return { queries, send, authorize, opts: { workspaceId: 'ws-1', harnessSlug: 'papercusp', organizationId: 'org-1',
      controlPlaneWorkspaceId: 'control', authorize, runQuery, now: () => end,
      runtime: { environment: 'staging' as const, release: 'abcdef12' },
      deliver: (event: unknown, context: Parameters<typeof deliverCloudTelemetry>[1], readConsent: () => Promise<unknown>) =>
        deliverCloudTelemetry(event, context, { readConsent, send }) } };
  }
  it('bounds the ledger to the opt-in epoch and final delivery to fresh authenticated consent', async () => {
    const f = setup();
    expect(await exportCustomerUsageDiagnostics(input, f.opts)).toEqual({ delivered: true });
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ event: 'cloud_diagnostic_aggregate',
      properties: expect.objectContaining({ period_start: epoch, period_end: new Date(end).toISOString(), source: 'customer-runtime' }) }));
    for (const query of f.queries) expect(query).toContain('ts >= $3 AND ts <= $4');
  });
  it.each(['revoked', 'reconsented', 'session', 'tenant', 'permission', 'administrator-demotion', 'unavailable'])(
    'refuses %s changes at the final boundary', async kind => {
      const f = setup();
      f.authorize.mockResolvedValueOnce({ ok: true, principal, monitoringConsent: consent });
      f.authorize.mockResolvedValue({ ok: true, principal: kind === 'session' ? createHostedPrincipal({ ...principal, sessionVersion: 2 }) :
        kind === 'tenant' ? createHostedPrincipal({ ...principal, activeOrganizationId: 'other' }) :
        kind === 'permission' ? createHostedPrincipal({ ...principal, permissions: ['workspace:view'] }) : principal,
        ...(kind === 'administrator-demotion' ? {
          principal: createHostedPrincipal({ ...principal, permissions: ['workspace:view', 'workspace:operate'] }),
        } : {}),
        monitoringConsent: kind === 'revoked' ? DEFAULT_CLOUD_TELEMETRY_CONSENT :
          kind === 'reconsented' ? { ...consent, diagnostics: { enabled: true, since: new Date(end - 500).toISOString() } } :
          kind === 'unavailable' ? null as never : consent });
      expect((await exportCustomerUsageDiagnostics(input, f.opts)).delivered).toBe(false);
      expect(f.send).not.toHaveBeenCalled();
    });
  it('does not read or send on default opt-out or client-supplied scope, usage, consent or destination', async () => {
    for (const extra of [{ workspaceId: 'other' }, { calls: 100 }, { consent }, { destination: 'https://other.invalid' }]) {
      const f = setup();
      expect(await exportCustomerUsageDiagnostics({ ...input, ...extra }, f.opts)).toEqual({ delivered: false, code: 'invalid_export_request' });
      expect(f.authorize).not.toHaveBeenCalled(); expect(f.queries).toEqual([]);
    }
    const f = setup(); f.authorize.mockResolvedValue({ ok: true, principal, monitoringConsent: DEFAULT_CLOUD_TELEMETRY_CONSENT });
    expect(await exportCustomerUsageDiagnostics(input, f.opts)).toEqual({ delivered: false, code: 'consent_disabled' });
    expect(f.queries).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  });
  it('refuses incomplete token evidence rather than exporting zero for missing counters', async () => {
    const f = setup();
    const incomplete = makeRunQuery({ totals: [{ runs: 1, unknown_token_calls: 1 }] });
    expect(await exportCustomerUsageDiagnostics(input, { ...f.opts, ...incomplete })).toEqual({ delivered: false, code: 'local_usage_unavailable' });
    expect(f.send).not.toHaveBeenCalled();
  });
});
