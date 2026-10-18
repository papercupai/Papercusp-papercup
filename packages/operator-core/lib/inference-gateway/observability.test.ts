/** Tests for the gateway rate-observability read-model (P-014). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { projectHeadroom, fetchGatewayHeadroom, fetchGatewayOwnerExecution, gatewayWholesaleThrottled, isWholesaleThrottled, readmitGatewayAccounts } from './observability';
import type { GatewayStats } from './gateway';

const baseStats = (over: Partial<GatewayStats> = {}): GatewayStats => ({
  accountId: 'acct-main',
  upstreamBase: 'https://api.anthropic.com',
  totalRequests: 12,
  inFlight: 2,
  queueDepth: 5,
  healthyAccounts: 1,
  admission: { running: 2, queued: 5, maxConcurrent: 24, byPriority: [{ priority: 100, count: 1 }, { priority: 0, count: 4 }] },
  // codexAdmission is a REQUIRED GatewayStats field — set it concretely (it previously came only from the
  // `...over` spread, so `baseStats().codexAdmission` was silently undefined and tripped the assignability check).
  codexAdmission: { running: 0, queued: 0, maxConcurrent: 4, byPriority: [] },
  upstream429: 0,
  queued429: 1,
  shed429: 0,
  shedAllThrottled: 0,
  bareBurstRotateSuppressed: 0,
  maxQueued: 256,
  concurrencyCap: 24,
  aimd: { effective: 24, cap: 24, floor: 4, pressure: 0, cleanStreak: 0, decreases: 0, increases: 0, hardFailures: 0 },
  opusToSonnetDowngrades: 0,
  effortClamps: { retries: 0, rewrites: 0, learned: [] },
  proactiveEgressProbe: { enabled: false, intervalMs: 0, lastTickAt: 0, circuitOpens: 0, failStreakByAccount: {} },
  failovers: 0,
  upstreamErrors: 0,
  egressCircuitOpens: 0,
  egressFailsByAccount: {},
  egressAttemptsByAccount: {},
  egressFailRateByAccount: {},
  selfHealReclaims: 0,
  slotReconcileMismatch: 0,
  inFlightTracked: 0,
  oldestHeldSlotAgeMs: 0,
  stallsRecorded: 0,
  codex: { requests: 0, upstream429: 0, failovers: 0, errors: 0 },
  beeFacing503: { egressExhausted: 0, tokenStall: 0 },
  pausedUntil: 0,
  pausedActuallyEnforced: false,
  billing: {
    byAccount: {},
    metered: { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, usageKnown: 0, outputKnown: 0 },
  },
  cache: {
    read: 0, create: 0, input: 0, hits: 0, misses: 0, failoverMisses: 0, hitRate: null, byAccount: {},
    knownTokenTotals: { read: 0, create: 0, input: 0 },
    tokenRateBasis: { read: 0, inputTotal: 0 },
    coverage: { requests: 0, readKnown: 0, writeKnown: 0, uncachedInputKnown: 0, inputTotalKnown: 0, tokenRateRequests: 0 },
    affinity: { hits: 0, cold: 0, nokey: 0, yields: 0, enabled: true, ttlMs: 0 },
  },
  ...over,
});

test('owner execution keeps absent and mismatched telemetry unknown', async () => {
  for (const body of [{ owner: 'su-a', now: 100 }, { owner: 'su-b', now: 100, stageTelemetry: { active: 0 } },
    { owner: 'su-a', now: 100, stageTelemetry: { active: -1 } }]) {
    const result = await fetchGatewayOwnerExecution('su-a', {
      fetchImpl: (async () => new Response(JSON.stringify(body))) as typeof fetch });
    assert.equal(result.active, null);
    assert.equal(result.activeRequests, null);
    assert.equal(result.activeRequestsComplete, null);
  }
  assert.deepEqual(await fetchGatewayOwnerExecution('su-a', {
    fetchImpl: (async () => new Response(JSON.stringify({ owner: 'su-a', now: 100, stageTelemetry: { active: 2 } }))) as typeof fetch,
  }), {
    active: 2,
    observedAt: 100,
    processInstanceId: null,
    activeRequests: null,
    activeRequestsComplete: null,
  });
});

test('owner execution strictly retains a complete bounded provider-stage population and process generation', async () => {
  const snapshot = {
    requestId: 41,
    startedAt: 1_000,
    provider: 'claude',
    providerQueuedAt: 1_100,
    providerAdmittedAt: null,
    attempts: 0,
    upstreamCalls: 0,
    upstreamCallsDropped: 0,
  };
  const result = await fetchGatewayOwnerExecution('su-a', {
    fetchImpl: (async () => new Response(JSON.stringify({
      owner: 'su-a', now: 2_000, process: { instanceId: 'gateway-generation-a' },
      stageTelemetry: { active: 1, activeRequests: [snapshot], activeRequestsComplete: true },
    }))) as typeof fetch,
  });
  assert.deepEqual(result, {
    active: 1,
    observedAt: 2_000,
    processInstanceId: 'gateway-generation-a',
    activeRequests: [snapshot],
    activeRequestsComplete: true,
  });
});

test('owner execution refuses overflow and malformed active snapshots as unknown stage evidence', async () => {
  const overflow = await fetchGatewayOwnerExecution('su-a', {
    fetchImpl: (async () => new Response(JSON.stringify({
      owner: 'su-a', now: 2_000, process: { instanceId: 'gateway-generation-a' },
      stageTelemetry: {
        active: 33,
        activeRequests: Array.from({ length: 32 }, (_, requestId) => ({
          requestId, startedAt: 1_000, provider: 'claude', providerQueuedAt: 1_100,
          providerAdmittedAt: null, attempts: 0, upstreamCalls: 0, upstreamCallsDropped: 0,
        })),
        activeRequestsComplete: false,
      },
    }))) as typeof fetch,
  });
  assert.equal(overflow.active, 33);
  assert.equal(overflow.activeRequests, overflow.activeRequests);
  assert.equal(overflow.activeRequestsComplete, false);

  const malformed = await fetchGatewayOwnerExecution('su-a', {
    fetchImpl: (async () => new Response(JSON.stringify({
      owner: 'su-a', now: 2_000, process: { instanceId: 'gateway-generation-a' },
      stageTelemetry: {
        active: 1,
        activeRequests: [{ requestId: 1, startedAt: 1_000, provider: 'claude', providerQueuedAt: 'bad',
          providerAdmittedAt: null, attempts: 0, upstreamCalls: 0, upstreamCallsDropped: 0 }],
        activeRequestsComplete: true,
      },
    }))) as typeof fetch,
  });
  assert.equal(malformed.active, 1);
  assert.equal(malformed.activeRequests, null);
  assert.equal(malformed.activeRequestsComplete, null);
});

test('projectHeadroom — maps the unified window + queue into the read-model', () => {
  const now = 1_000_000;
  const stats = baseStats({
    processStartedAt: now - 12_345,
    processUptimeMs: 12_345,
    unified: { window: '5h', utilization: 0.83, resetAt: now + 3600_000, rejected: false },
  });
  const h = projectHeadroom(stats, now);
  assert.equal(h.reachable, true);
  assert.equal(h.accountId, 'acct-main');
  assert.equal(h.processStartedAt, now - 12_345);
  assert.equal(h.processUptimeMs, 12_345);
  assert.equal(h.window, '5h');
  assert.equal(h.utilizationPct, 83);
  assert.equal(h.rejected, false);
  assert.equal(h.resetInSec, 3600);
  assert.equal(h.paused, false);
  assert.equal(h.queueDepth, 5);
  assert.equal(h.admissionWindow, 24);
  assert.equal(h.healthyAccounts, 1);
  assert.deepEqual(h.byPriority, [{ priority: 100, count: 1 }, { priority: 0, count: 4 }]);
});

test('projectHeadroom — Codex scope uses Codex admission and health, not Claude readings', () => {
  const stats = baseStats({
    // This is the measured failure shape: stale Claude state says there is no healthy account.
    healthyAccounts: 0,
    admission: { running: 24, queued: 40, maxConcurrent: 24, byPriority: [{ priority: 0, count: 40 }] },
    codexHealthyAccounts: 1,
    codexAdmission: {
      running: 1,
      queued: 2,
      maxConcurrent: 4,
      byPriority: [{ priority: 0, count: 2 }],
      byTier: [{ tier: 3, minShare: 4, inFlight: 1, queued: 2 }],
      tier1Reserve: 1,
    },
    unified: { window: '7d', utilization: 1, resetAt: 9_999_999, rejected: true },
    pausedUntil: 9_999_999,
  });

  const h = projectHeadroom(stats, 1_000_000, { provider: 'codex' });
  assert.equal(h.provider, 'codex');
  assert.equal(h.accountId, undefined, 'the Claude active account must not be labeled as Codex');
  assert.equal(h.healthyAccounts, 1);
  assert.equal(h.inFlight, 1);
  assert.equal(h.queueDepth, 2);
  assert.equal(h.admissionWindow, 4, 'the Codex live window must not inherit Claude concurrency');
  assert.deepEqual(h.byPriority, [{ priority: 0, count: 2 }]);
  assert.deepEqual(h.priorityTiers, {
    healthyAccounts: 1,
    tier1Reserve: 1,
    tiers: [{ tier: 3, minShare: 4, inFlight: 1, queued: 2 }],
  });
  assert.equal(h.rejected, undefined, 'Claude unified rejection must not reject a Codex scope');
  assert.equal(h.paused, undefined, 'Claude pause must not pause a Codex scope');
});

test('projectHeadroom — derives process uptime from processStartedAt for mixed-version stats readers', () => {
  const now = 1_000_000;
  const h = projectHeadroom(baseStats({ processStartedAt: now - 5_000 }), now);
  assert.equal(h.processStartedAt, now - 5_000);
  assert.equal(h.processUptimeMs, 5_000);
});

test('projectHeadroom — paused/rejected window reflected', () => {
  const now = 1_000_000;
  const h = projectHeadroom(
    baseStats({ pausedUntil: now + 600_000, unified: { window: '5h', utilization: 1.01, resetAt: now + 600_000, rejected: true } }),
    now,
  );
  assert.equal(h.paused, true);
  assert.equal(h.rejected, true);
  assert.equal(h.utilizationPct, 101);
  assert.equal(h.resetInSec, 600);
});

test('projectHeadroom — surfaces the bound account smoothing pace (P-005)', () => {
  const now = 1_000_000;
  const h = projectHeadroom(
    baseStats({
      accountId: 'acct-main',
      smoothing: {
        engaged: true,
        byAccount: {
          'acct-main': { smoothRpm: true, rpm: 60, rpmFactor: 0.5, effRpm: 30, paceDelayMs: 0, effectivePaceMs: 2000 },
          'acct-other': { smoothRpm: true, rpm: 60, rpmFactor: 1, effRpm: 60, paceDelayMs: 0, effectivePaceMs: 1000 },
        },
      },
    }),
    now,
  );
  assert.equal(h.smoothingEngaged, true);
  assert.equal(h.smoothRpm, true);
  assert.equal(h.effectivePaceMs, 2000, 'the BOUND account (acct-main) pace, not another account');
  assert.equal(h.effRpm, 30);
});

test('projectHeadroom — smoothing absent (fresh gateway) leaves smoothing fields undefined', () => {
  const h = projectHeadroom(baseStats(), 1_000_000);
  assert.equal(h.smoothingEngaged, undefined);
  assert.equal(h.effectivePaceMs, undefined);
});

test('projectHeadroom — no unified window yet (fresh gateway) leaves window fields undefined', () => {
  const h = projectHeadroom(baseStats(), 1_000_000);
  assert.equal(h.reachable, true);
  assert.equal(h.window, undefined);
  assert.equal(h.utilizationPct, undefined);
  assert.equal(h.totalRequests, 12);
});

test('fetchGatewayHeadroom — gateway down returns reachable:false (never throws)', async () => {
  const h = await fetchGatewayHeadroom({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(h.reachable, false);
  assert.match(h.error ?? '', /ECONNREFUSED/);
});

test('fetchGatewayHeadroom — reads + projects a live /stats payload', async () => {
  const now = Date.now();
  const stats = baseStats({ unified: { window: '5h', utilization: 0.5, resetAt: now + 1_000_000, rejected: false } });
  const h = await fetchGatewayHeadroom({
    fetchImpl: async () => new Response(JSON.stringify(stats), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(h.reachable, true);
  assert.equal(h.utilizationPct, 50);
  assert.equal(h.accountId, 'acct-main');
});

test('fetchGatewayHeadroom — non-200 from gateway → reachable:false with status', async () => {
  const h = await fetchGatewayHeadroom({
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  assert.equal(h.reachable, false);
  assert.match(h.error ?? '', /503/);
});

// gatewayWholesaleThrottled — the capacity_shed corroboration (P-006/H13). True only
// when the gateway is REACHABLE and the bound account is paused OR its window rejected.
const statsResponse = (stats: GatewayStats) =>
  async () => new Response(JSON.stringify(stats), { status: 200, headers: { 'content-type': 'application/json' } });

test('gatewayWholesaleThrottled — true when the bound account is PAUSED', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({ fetchImpl: statsResponse(baseStats({ pausedUntil: now + 60_000 })) });
  assert.equal(throttled, true);
});

test('gatewayWholesaleThrottled — true when the unified window is REJECTED (hard limit)', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: statsResponse(baseStats({ unified: { window: '5h', utilization: 1.02, resetAt: now + 60_000, rejected: true } })),
  });
  assert.equal(throttled, true);
});

test('gatewayWholesaleThrottled — false when headline window is rejected but priority tiers can still admit', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: statsResponse(
      baseStats({
        unified: { window: '5h', utilization: 1.02, resetAt: now + 60_000, rejected: true },
        priorityTiers: {
          healthyAccounts: 1,
          tier1Reserve: 1,
          tiers: [
            { tier: 1, minShare: 24, inFlight: 1, queued: 0 },
            { tier: 3, minShare: 19, inFlight: 0, queued: 0 },
          ],
        },
      }),
    ),
  });
  assert.equal(throttled, false);
});

test('gatewayWholesaleThrottled — true when priority tiers report no healthy account capacity', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: statsResponse(
      baseStats({
        unified: { window: '5h', utilization: 1.02, resetAt: now + 60_000, rejected: true },
        priorityTiers: {
          healthyAccounts: 0,
          tier1Reserve: 1,
          tiers: [{ tier: 3, minShare: 19, inFlight: 19, queued: 0 }],
        },
      }),
    ),
  });
  assert.equal(throttled, true);
});

test('gatewayWholesaleThrottled — false when the gateway is healthy (not paused, not rejected)', async () => {
  const now = Date.now();
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: statsResponse(baseStats({ unified: { window: '5h', utilization: 0.4, resetAt: now + 60_000, rejected: false } })),
  });
  assert.equal(throttled, false);
});

test('gatewayWholesaleThrottled — false (conservative) when the gateway is UNREACHABLE', async () => {
  const throttled = await gatewayWholesaleThrottled({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(throttled, false);
});

test('gatewayWholesaleThrottled — default path (no injected fetchImpl) is a NO-OP under the test runner (gate-safe, never hits the live :8788 gateway)', async () => {
  // The guard that keeps every no-turn spawn-classification test (durable-spawn / launch-blueprint)
  // deterministic on a box with a live, possibly-throttled gateway — without it the classifier reads
  // the real gateway and the test flaps the deploy gate.
  const throttled = await gatewayWholesaleThrottled();
  assert.equal(throttled, false);
});

// isWholesaleThrottled (WI-3186) — the pure predicate gatewayWholesaleThrottled delegates to,
// factored out so a caller that already has a projected headroom (e.g. the desktop
// setup-status probe re-using a headroom read for its own purposes) doesn't need a second
// /stats round-trip to get the same decision.
test('isWholesaleThrottled — mirrors gatewayWholesaleThrottled on an already-projected headroom', () => {
  const now = Date.now();
  assert.equal(isWholesaleThrottled(projectHeadroom(baseStats({ pausedUntil: now + 60_000 }), now)), true);
  assert.equal(
    isWholesaleThrottled(
      projectHeadroom(baseStats({ unified: { window: '5h', utilization: 0.4, resetAt: now + 60_000, rejected: false } }), now),
    ),
    false,
  );
  assert.equal(isWholesaleThrottled({ reachable: false }), false, 'unreachable is conservative-false');
});

// readmitGatewayAccounts — the accounts:reset-rate → live-gateway poke (EI-8797 residual: the store
// reset alone leaves the gateway's in-memory pause map stale, so /stats keeps healthyAccounts=0).

test('readmitGatewayAccounts — POSTs /admin/readmit per id and reports the gateway fresh healthyAccounts', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    const id = decodeURIComponent(String(url).match(/account=([^&]+)/)?.[1] ?? '');
    return new Response(JSON.stringify({ ok: true, readmitted: [id], healthyAccounts: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const r = await readmitGatewayAccounts(['aviynw7'], { port: 4321, fetchImpl });
  assert.equal(r.reachable, true);
  assert.deepEqual(r.readmitted, ['aviynw7']);
  assert.equal(r.healthyAccounts, 1, 'reports the gateway-side count so the caller can VERIFY the split-brain cleared');
  assert.deepEqual(calls, ['POST http://127.0.0.1:4321/admin/readmit?account=aviynw7']);
});

test('readmitGatewayAccounts — best-effort: gateway down → reachable:false, never throws (the store reset must still succeed)', async () => {
  const r = await readmitGatewayAccounts(['x'], {
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch,
  });
  assert.equal(r.reachable, false);
  assert.match(r.error ?? '', /ECONNREFUSED/);
});

test('readmitGatewayAccounts — deploy-skew (pre-readmit binary → 404) → reachable:false with status', async () => {
  const r = await readmitGatewayAccounts(['x'], {
    fetchImpl: (async () => new Response('not found', { status: 404 })) as typeof fetch,
  });
  assert.equal(r.reachable, false);
  assert.match(r.error ?? '', /404/);
});
