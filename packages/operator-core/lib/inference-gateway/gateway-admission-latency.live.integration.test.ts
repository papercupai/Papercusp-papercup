/**
 * gateway-admission-congestion-only-2026-10-13: live acceptance through the
 * existing request-stage telemetry and test ledger, without issuing paid requests.
 * The .integration.test.ts suffix selects the maintained integration test layer.
 * Before grading, dev:pipeline_position must confirm gateway.ts and
 * provider-admission-lifecycle.ts are loaded by the gateway runtime.
 * Queue waits use the bounded per-provider samples since process start; short
 * turns use the recent timeline ring. Report the population and dates. Empty or
 * insufficient samples fail. No live assertion runs inside a release gate.
 *
 * The Claude baseline is the committed operational sample at 2026-10-14 04:33Z:
 * docs/evidence/gateway-admission-congestion-only-2026-10-13/
 * live-admission-operational-2026-10-14.json (76 requests, queueWait p50 689ms).
 * A 2x tolerance permits ordinary variation while detecting a material slowdown.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { GatewayRequestTimeline, GatewayRequestTelemetrySnapshot } from './request-stage-telemetry';

const CLAUDE_BASELINE_P50_MS = 689;
const CLAUDE_TOLERANCE = 2;
const MIN_LANE_SAMPLE = 20;
const SHORT_INPUT_TOKENS = 8192;

type Sample = Pick<GatewayRequestTimeline,
  'provider' | 'startedAt' | 'finalizedAt' | 'finalStatus' | 'cache' | 'durationsMs'>;

function p50(values: number[]): number | null {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  return ordered.length ? ordered[Math.floor(ordered.length / 2)]! : null;
}

function assess(recent: Sample[], queueDepth: number,
  providerQueueWait?: GatewayRequestTelemetrySnapshot['providerQueueWait']) {
  const lane = (provider: string) => {
    const rows = recent.filter((r) => r.provider === provider);
    const waits = rows.flatMap((r) => typeof r.durationsMs.queueWait === 'number' ? [r.durationsMs.queueWait] : []);
    const retained = providerQueueWait?.[provider as 'claude' | 'codex'];
    return { n: retained?.count ?? rows.length, measured: retained?.retained ?? waits.length,
      p50Ms: retained ? retained.p50 : p50(waits) };
  };
  const codex = lane('codex');
  const claude = lane('claude');
  const short = recent.filter((r) => {
    // The telemetry writer stores UNCACHED input separately from cache reads and
    // writes (gateway.ts#observeCodexCacheUsage); count all three for prompt size.
    const counts = [r.cache.inputTokens, r.cache.cacheReadTokens, r.cache.cacheWriteTokens];
    return r.provider === 'codex' && r.finalStatus === 200 &&
      counts.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
      counts.reduce<number>((sum, n) => sum + (n ?? 0), 0) <= SHORT_INPUT_TOKENS &&
      typeof r.durationsMs.total === 'number' && Number.isFinite(r.durationsMs.total);
  });
  const shortFastestMs = short.length ? Math.min(...short.map((r) => r.durationsMs.total!)) : null;
  const failures: string[] = [];
  if (queueDepth !== 0) failures.push('herd-present');
  if (codex.measured < MIN_LANE_SAMPLE || claude.measured < MIN_LANE_SAMPLE) failures.push('insufficient-sample');
  if (codex.p50Ms === null || codex.p50Ms >= 2000) failures.push('codex-queue');
  if (shortFastestMs === null || shortFastestMs >= 30_000) failures.push('short-codex-turn');
  if (claude.p50Ms === null || claude.p50Ms > CLAUDE_BASELINE_P50_MS * CLAUDE_TOLERANCE) failures.push('claude-regression');
  return { codex, claude, short: { n: short.length, fastestMs: shortFastestMs, inputTokensMax: SHORT_INPUT_TOKENS },
    window: { from: recent.length ? Math.min(...recent.map((r) => r.startedAt)) : null,
      to: recent.length ? Math.max(...recent.map((r) => r.finalizedAt)) : null }, failures };
}

function expectLiveSampleReady(measured: ReturnType<typeof assess>) {
  expect(measured.failures, JSON.stringify(measured)).not.toContain('herd-present');
  expect(measured.failures, JSON.stringify(measured)).not.toContain('insufficient-sample');
}

describe('live admission latency oracle controls', () => {
  function sample(provider: 'claude' | 'codex', wait = 100, total = 2000): Sample {
    return { provider, startedAt: 1000, finalizedAt: 1000 + total, finalStatus: 200,
      cache: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } as Sample['cache'],
      durationsMs: { queueWait: wait, total } };
  }
  const good = () => Array.from({ length: MIN_LANE_SAMPLE }, () => [sample('claude'), sample('codex')]).flat();
  it('accepts measured healthy lanes and a completed short turn', () => {
    expect(assess(good(), 0).failures).toEqual([]);
  });
  it('rejects an empty population and a herd', () => {
    expect(assess([], 1).failures).toEqual(expect.arrayContaining(['herd-present', 'insufficient-sample']));
  });
  it('requires the shared live precondition at the exact sample floor and without a herd', () => {
    expect(() => expectLiveSampleReady(assess(good(), 0))).not.toThrow();
    expect(() => expectLiveSampleReady(assess(good(), 1))).toThrow('herd-present');
  });
  it.each(['claude', 'codex'] as const)('rejects a sparse %s lane in the shared live precondition', (sparse) => {
    const retained = (provider: 'claude' | 'codex') => ({
      count: 400, retained: provider === sparse ? MIN_LANE_SAMPLE - 1 : 256,
      p50: 100, p95: 100, p99: 100,
    });
    const measured = assess(good(), 0, { claude: retained('claude'), codex: retained('codex') });
    expect(measured.failures).toEqual(['insufficient-sample']);
    expect(() => expectLiveSampleReady(measured)).toThrow('insufficient-sample');
  });
  it('uses sparse-provider retained waits without weakening the sample floor', () => {
    const waits = { count: 25, retained: 20, p50: 100, p95: 100, p99: 100 };
    const summary = { claude: waits, codex: waits, local: { ...waits, count: 0, retained: 0, p50: null } };
    const rows = good().filter(row => row.provider === 'codex');
    expect(assess(rows, 0, summary).failures).toEqual([]);
    expect(assess(rows, 0, { ...summary, claude: { ...waits, retained: 19 } }).failures)
      .toContain('insufficient-sample');
  });
  it('rejects slow Codex admission and a slow short turn independently', () => {
    const rows = good().map((r) => r.provider === 'codex' ? sample('codex', 2000, 30_000) : r);
    expect(assess(rows, 0).failures).toEqual(['codex-queue', 'short-codex-turn']);
  });
  it('counts cached input when deciding whether a turn is short', () => {
    const rows = good().map((r) => r.provider === 'codex'
      ? { ...r, cache: { ...r.cache, cacheReadTokens: SHORT_INPUT_TOKENS } } : r);
    expect(assess(rows, 0).failures).toEqual(['short-codex-turn']);
  });
  it('rejects a material Claude slowdown and missing latency measurements', () => {
    expect(assess(good().map((r) => r.provider === 'claude' ? sample('claude', 1379) : r), 0).failures)
      .toEqual(['claude-regression']);
    expect(assess(good().map((r) => ({ ...r, durationsMs: {} })), 0).failures)
      .toContain('insufficient-sample');
  });
});

const gateRun = Boolean(process.env.PAPERCUSP_GATE_FIRE_ID) || process.cwd().includes('papercusp-checkpoint');
const requested = Boolean(process.env.PAPERCUSP_TEST_RUN_GROUP) || process.env.PAPERCUSP_GATEWAY_ADMISSION_LIVE === '1';
describe.skipIf(gateRun || !requested)('LIVE gateway admission latency', () => {
  let measured: ReturnType<typeof assess>;
  beforeAll(async () => {
    const response = await fetch('http://127.0.0.1:8788/admin/stats', { signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    const stats = await response.json() as { queueDepth: number; processStartedAt: number;
      requestStages: { recent: Sample[]; providerQueueWait: GatewayRequestTelemetrySnapshot['providerQueueWait'] } };
    expect(Number.isFinite(stats.processStartedAt)).toBe(true);
    expect(stats.requestStages.providerQueueWait).toBeDefined();
    measured = assess(stats.requestStages.recent, stats.queueDepth, stats.requestStages.providerQueueWait);
    console.log(JSON.stringify({ kind: 'gateway-live-admission', evidencePlane: 'live',
      processStartedAt: stats.processStartedAt, sampledAt: Date.now(), queueWaitPopulation: 'latest 256 per provider since process start',
      claudeBaselineP50Ms: CLAUDE_BASELINE_P50_MS, claudeTolerance: CLAUDE_TOLERANCE, ...measured }));
    expectLiveSampleReady(measured);
  });
  it('keeps Codex queueWait p50 below 2s', () => {
    expect(measured.codex.measured).toBeGreaterThanOrEqual(MIN_LANE_SAMPLE);
    expect(measured.failures, JSON.stringify(measured)).not.toContain('codex-queue');
  });
  it('completes a short Codex turn below 30s', () => {
    expect(measured.failures, JSON.stringify(measured)).not.toContain('short-codex-turn');
  });
  it('preserves Claude queueWait p50 within twice its 689ms baseline', () => {
    expect(measured.claude.measured).toBeGreaterThanOrEqual(MIN_LANE_SAMPLE);
    expect(measured.failures, JSON.stringify(measured)).not.toContain('claude-regression');
  });
});
