/**
 * GW-LIVE-QUEUEWAIT: read the running gateway's own admission and telemetry
 * writers. The maintained e2e config records this as e2e proof; release gates
 * exclude the live case. No inference request is issued by this test.
 */
import { describe, expect, it } from 'vitest';

type LiveStats = {
  processStartedAt: number;
  queueDepth: number;
  codexAimd: { effective: number; floor: number };
  requestStages: { providerQueueWait: {
    codex: { retained: number; p50: number | null };
    claude: { retained: number; p50: number | null };
  } };
};

function expectLiveAdmissionRecovered(stats: LiveStats) {
  expect(Number.isFinite(stats.processStartedAt)).toBe(true);
  expect(stats.queueDepth).toBe(0);
  const waits = stats.requestStages.providerQueueWait;
  for (const lane of [waits.codex, waits.claude]) {
    expect(lane.retained).toBeGreaterThanOrEqual(20);
    expect(lane.p50).not.toBeNull();
    expect(Number.isFinite(lane.p50)).toBe(true);
  }
  expect(waits.codex.p50).toBeLessThan(2000);
  expect(waits.claude.p50).toBeLessThanOrEqual(689 * 2);
  expect(Number.isFinite(stats.codexAimd.floor)).toBe(true);
  expect(Number.isFinite(stats.codexAimd.effective)).toBe(true);
  expect(stats.codexAimd.effective).toBeGreaterThan(stats.codexAimd.floor);
}

describe('live admission floor oracle controls', () => {
  const good = (): LiveStats => ({
    processStartedAt: 1000, queueDepth: 0,
    codexAimd: { effective: 40, floor: 12 },
    requestStages: { providerQueueWait: {
      codex: { retained: 20, p50: 100 }, claude: { retained: 20, p50: 100 },
    } },
  });
  it('accepts a recovered window and adequate healthy lanes', () => {
    expect(() => expectLiveAdmissionRecovered(good())).not.toThrow();
  });
  it.each([12, 11])('rejects a window of %s at or below its floor despite healthy latency', (effective) => {
    const stats = good();
    stats.codexAimd.effective = effective;
    expect(() => expectLiveAdmissionRecovered(stats)).toThrow();
  });
  it.each(['codex', 'claude'] as const)('rejects sparse %s measurements', (lane) => {
    const stats = good();
    stats.requestStages.providerQueueWait[lane].retained = 19;
    expect(() => expectLiveAdmissionRecovered(stats)).toThrow();
  });
  it('rejects a herd and either latency threshold regression', () => {
    expect(() => expectLiveAdmissionRecovered({ ...good(), queueDepth: 1 })).toThrow();
    const codex = good();
    codex.requestStages.providerQueueWait.codex.p50 = 2000;
    expect(() => expectLiveAdmissionRecovered(codex)).toThrow();
    const claude = good();
    claude.requestStages.providerQueueWait.claude.p50 = 1379;
    expect(() => expectLiveAdmissionRecovered(claude)).toThrow();
  });
});

const gateRun = Boolean(process.env.PAPERCUSP_GATE_FIRE_ID) || process.cwd().includes('papercusp-checkpoint');
const requested = Boolean(process.env.PAPERCUSP_TEST_RUN_GROUP) || process.env.PAPERCUSP_GATEWAY_ADMISSION_LIVE === '1';
describe.skipIf(gateRun || !requested)('LIVE gateway admission floor recovery', () => {
  it('keeps the Codex window above its floor with healthy no-herd queue waits', async () => {
    const response = await fetch('http://127.0.0.1:8788/admin/stats', { signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    const stats = await response.json() as LiveStats;
    console.log(JSON.stringify({ kind: 'gateway-live-admission-floor', evidencePlane: 'live',
      sampledAt: Date.now(), processStartedAt: stats.processStartedAt, queueDepth: stats.queueDepth,
      codexAimd: stats.codexAimd, providerQueueWait: stats.requestStages.providerQueueWait }));
    expectLiveAdmissionRecovered(stats);
  });
});
