import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_HEALTH_SCHEMA_VERSION,
  LIVE_HEALTH_SIGNAL_KEYS,
  LIVE_HEALTH_SIGNAL_SPECS,
  emptyLiveHealthObservations,
  emptyLiveHealthSignals,
  liveHealthWindow,
  measuredLiveHealthReading,
  staleLiveHealthReading,
  type LiveHealthReading,
  type LiveHealthSignalKey,
  type LiveHealthSnapshot,
  type LiveHealthWriter,
} from './live-health';
import {
  DEFAULT_SERVICE_OBJECTIVES,
  NON_CAUSAL_CAPACITY_SIGNALS,
  RollingHealthyBaselineStore,
  RollingHealthAnalyzer,
  healthObjectiveConditionKey,
  liveHealthFrameFromSnapshot,
  type HealthAnalysisFrame,
  type HealthConditionContext,
} from './health-analysis';

const START = 1_700_000_000_000;
const STEP = 5_000;

function conditionHarness() {
  const open = new Map<string, number>();
  const opened: string[] = [], resolved: string[] = [];
  const context: HealthConditionContext = { workspaceId: 'fixture',
    readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
    rail: { broadcast: async event => {
      expect(event.oneShot).toBe(true);
      if (!open.has(event.conditionKey!)) opened.push(event.conditionKey!);
      open.set(event.conditionKey!, open.get(event.conditionKey!) ?? START + 4 * STEP);
      return true;
    }, resolve: async event => {
      if (!open.delete(event.conditionKey)) return false;
      resolved.push(event.conditionKey); return true;
    } } };
  return { open, opened, resolved, context };
}

describe('original resource health objective condition lifecycle', () => {
  const key = healthObjectiveConditionKey('fixture', 'operator:fixture', 'operator-event-loop-latency',
    'latency.eventLoopP95Ms', 'operator:fixture');
  it('opens before returning, survives a new analyzer, resolves measured recovery and reopens', async () => {
    const h = conditionHarness();
    const analyzer = primedAnalyzer();
    expect((await analyzer.evaluate(frame(4, { 'latency.eventLoopP95Ms': 300 }), h.context)).state).toBe('degraded');
    expect(h.opened).toContain(key);
    await analyzer.evaluate(frame(4, { 'latency.eventLoopP95Ms': 300 }), h.context);
    expect(h.opened.filter(value => value === key)).toHaveLength(1);
    await new RollingHealthAnalyzer().evaluate(frame(5), h.context);
    expect(h.open.has(key)).toBe(true); // no known numeric baseline after restart
    await primedAnalyzer().evaluate(frame(5), h.context);
    expect(h.resolved).toContain(key);
    await analyzer.evaluate(frame(6, { 'latency.eventLoopP95Ms': 300 }), h.context);
    expect(h.opened.filter(value => value === key)).toHaveLength(2);
  });
  it('independently resolves a recovered objective while another stays breached', async () => {
    const h = conditionHarness(), analyzer = primedAnalyzer();
    await analyzer.evaluate(frame(4, { 'latency.eventLoopP95Ms': 300, 'provider.rateLimited': true }), h.context);
    expect(h.open.size).toBe(2);
    await analyzer.evaluate(frame(5, { 'provider.rateLimited': true }), h.context);
    expect(h.open.size).toBe(1); expect(h.resolved).toContain(key);
  });
  it.each(['missing', 'stale', 'old', 'future', 'low-confidence', 'bad-value', 'bad-unit', 'bad-clock'])(
    'preserves an episode through %s evidence', async kind => {
      const h = conditionHarness(), analyzer = primedAnalyzer();
      await analyzer.evaluate(frame(4, { 'latency.eventLoopP95Ms': 300 }), h.context);
      const valid = frame(5), signal = 'latency.eventLoopP95Ms';
      const measured = valid.signals[signal]!;
      const signals = { ...valid.signals };
      if (kind === 'missing') delete signals[signal];
      else signals[signal] = (kind === 'stale' ? staleLiveHealthReading(signal, measured, valid.atMs) :
        { ...measured, ...(kind === 'old' ? { observedAtMs: START, lastMeasuredAtMs: START } : {}),
          ...(kind === 'future' ? { observedAtMs: valid.atMs + 1 } : {}),
          ...(kind === 'low-confidence' ? { confidence: 0.1 } : {}),
          ...(kind === 'bad-value' ? { value: Number.NaN } : {}),
          ...(kind === 'bad-unit' ? { unit: 'boolean' } : {}),
          ...(kind === 'bad-clock' ? { collectedAtMs: Number.NaN } : {}) }) as LiveHealthReading;
      await analyzer.evaluate({ ...valid, signals }, h.context);
      expect(h.open.has(key)).toBe(true); expect(h.resolved).not.toContain(key);
    });
  it('preserves foreign scopes, newer episodes and failed reads', async () => {
    const h = conditionHarness(), analyzer = primedAnalyzer();
    await analyzer.evaluate(frame(4, { 'latency.eventLoopP95Ms': 300 }), h.context);
    await analyzer.evaluate(frame(5, {}, 'foreign'), h.context);
    await analyzer.evaluate(frame(5), { ...h.context, workspaceId: 'foreign' });
    await analyzer.evaluate(frame(5), { ...h.context, readOpenConditions: async () => { throw new Error('unreadable'); } });
    h.open.set(key, START + 8 * STEP);
    await analyzer.evaluate(frame(5), h.context);
    expect(h.open.has(key)).toBe(true); expect(h.resolved).not.toContain(key);
  });
  it('keeps the verdict and other objective delivery when broadcast or resolution fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = conditionHarness(), analyzer = primedAnalyzer();
    const send = h.context.rail!.broadcast!;
    const broadcast = vi.fn(async (event: Parameters<typeof send>[0]) => {
      if (event.conditionKey === key) throw new Error('transport'); return send(event);
    });
    expect((await analyzer.evaluate(frame(4, { 'latency.eventLoopP95Ms': 300, 'provider.rateLimited': true }),
      { ...h.context, rail: { ...h.context.rail, broadcast } })).state).toBe('degraded');
    expect(h.open.size).toBe(1); expect(broadcast).toHaveBeenCalledTimes(2);
    await analyzer.evaluate(frame(5), { ...h.context, rail: { resolve: async () => { throw new Error('transport'); } } });
    expect(h.open.size).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[resource-health] condition resolution failed'));
    warn.mockRestore();
  });
});

function reading(key: LiveHealthSignalKey, value: number | boolean, atMs: number, confidence = 1): LiveHealthReading {
  const spec = LIVE_HEALTH_SIGNAL_SPECS[key];
  return measuredLiveHealthReading({
    key,
    value,
    writerId: `${spec.writerKind}:fixture`,
    observedAtMs: atMs,
    window: liveHealthWindow(spec.windowKind, atMs - (spec.windowKind === 'instant' ? 0 : STEP), atMs),
    confidence,
  });
}

const HEALTHY_VALUES: Partial<Record<LiveHealthSignalKey, number | boolean>> = {
  'progress.heartbeatLagMs': 5,
  'cpu.hostUtilizationPct': 35,
  'cpu.processUtilizationPct': 20,
  'cpu.psiSomePct': 0.1,
  'io.psiSomePct': 0.1,
  'io.psiFullPct': 0,
  'io.processReadBytesPerSec': 0,
  'io.processWriteBytesPerSec': 0,
  'latency.eventLoopP95Ms': 8,
  'memory.hostUsedBytes': 8 * 1024 ** 3,
  'memory.workingSetBytes': 512 * 1024 ** 2,
  'memory.workingSetGrowthBytesPerSec': 0,
  'memory.psiSomePct': 0.1,
  'memory.psiFullPct': 0,
  'memory.gcPauseP95Ms': 2,
  'memory.majorFaultsPerSec': 0,
  'memory.swapUsedBytes': 0,
  'memory.swapInBytesPerSec': 0,
  'memory.swapOutBytesPerSec': 0,
  'database.waitP95Ms': 5,
  'database.activeConnections': 4,
  'service.waitP95Ms': 5,
  'provider.waitP95Ms': 20,
  'provider.rateLimited': false,
  'queue.writerLatencyP95Ms': 5,
  'queue.writerFailureRate': 0,
  'queue.oldestAgeMs': 0,
  'queue.arrivalRate': 1,
  'governor.admissionLatencyP95Ms': 3,
  'governor.decisionLatencyP95Ms': 2,
  'governor.persistLatencyP95Ms': 3,
};

function frame(
  index: number,
  overrides: Partial<Record<LiveHealthSignalKey, number | boolean | LiveHealthReading>> = {},
  scopeId = 'operator:fixture',
): HealthAnalysisFrame {
  const atMs = START + index * STEP;
  const values = { ...HEALTHY_VALUES, ...overrides };
  const signals = Object.fromEntries(
    Object.entries(values).map(([rawKey, value]) => {
      const key = rawKey as LiveHealthSignalKey;
      return [key, typeof value === 'object' ? value : reading(key, value, atMs)];
    }),
  );
  return { scopeId, atMs, signals };
}

function primedAnalyzer(): RollingHealthAnalyzer {
  const analyzer = new RollingHealthAnalyzer();
  for (let index = 0; index < 4; index++) analyzer.primeHealthy(frame(index));
  return analyzer;
}

describe('resource-governor rolling health analysis', () => {
  it('has no service objective or causal rule hidden behind raw capacity signals', () => {
    const objectiveSignals = new Set<LiveHealthSignalKey>(
      DEFAULT_SERVICE_OBJECTIVES.map((objective) => objective.signal),
    );
    for (const signal of NON_CAUSAL_CAPACITY_SIGNALS) expect(objectiveSignals.has(signal)).toBe(false);
    expect(NON_CAUSAL_CAPACITY_SIGNALS).toEqual(
      expect.arrayContaining(['io.processReadBytesPerSec', 'io.processWriteBytesPerSec']),
    );
    expect(new Set(LIVE_HEALTH_SIGNAL_KEYS).size).toBe(LIVE_HEALTH_SIGNAL_KEYS.length);
  });

  it('fails closed instead of borrowing an unrelated writer from the compact snapshot', () => {
    const atMs = START;
    const writer: LiveHealthWriter = {
      id: 'provider:other',
      kind: 'provider',
      instanceId: 'provider:other:instance',
      pid: null,
      platform: 'linux',
      startedAtMs: atMs - STEP,
    };
    const providerWait = measuredLiveHealthReading({
      key: 'provider.waitP95Ms',
      value: 900,
      writerId: writer.id,
      observedAtMs: atMs,
      window: liveHealthWindow('rolling', atMs - STEP, atMs),
    });
    const observations = emptyLiveHealthObservations();
    observations['provider.waitP95Ms'][writer.id] = providerWait;
    const signals = emptyLiveHealthSignals(atMs);
    signals['provider.waitP95Ms'] = providerWait;
    const snapshot: LiveHealthSnapshot = {
      schemaVersion: LIVE_HEALTH_SCHEMA_VERSION,
      sequence: 1,
      sampledAtMs: atMs,
      monitorStartedAtMs: atMs - STEP,
      cadenceMs: STEP,
      profile: {
        platform: 'linux',
        arch: 'x64',
        release: 'fixture',
        effectiveCores: 8,
        physicalCores: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        embeddedPg: true,
        hostRole: 'test',
        source: '@papercusp/resource-profile',
      },
      writers: { [writer.id]: writer },
      observations,
      signals,
    };

    const scoped = liveHealthFrameFromSnapshot(snapshot, {
      scopeId: 'provider:wanted',
      writerIds: new Set(['provider:wanted']),
    });
    expect(scoped.signals['provider.waitP95Ms']).toBeUndefined();
    expect(
      liveHealthFrameFromSnapshot(snapshot, {
        scopeId: 'diagnostic-compact-view',
        writerIds: new Set(['provider:wanted']),
        fallbackToCompactSignals: true,
      }).signals['provider.waitP95Ms'],
    ).toBe(providerWait);
  });

  it('distinguishes healthy saturation from collapse without a utilization ceiling', () => {
    const healthyAnalyzer = primedAnalyzer();
    const saturated = healthyAnalyzer.evaluate(
      frame(4, {
        'cpu.hostUtilizationPct': 99.9,
        'cpu.processUtilizationPct': 780,
        'memory.hostUsedBytes': 120 * 1024 ** 3,
        'memory.workingSetBytes': 32 * 1024 ** 3,
        'memory.swapUsedBytes': 48 * 1024 ** 3,
        'io.processReadBytesPerSec': 64 * 1024 ** 2,
        'io.processWriteBytesPerSec': 32 * 1024 ** 2,
        'queue.oldestAgeMs': 3_600_000,
      }),
    );
    expect(saturated).toMatchObject({ state: 'healthy', actionable: false, severity: 'none' });
    expect(saturated.ignoredCapacitySignals).toEqual(
      expect.arrayContaining([
        'cpu.hostUtilizationPct',
        'memory.hostUsedBytes',
        'memory.swapUsedBytes',
        'io.processReadBytesPerSec',
        'io.processWriteBytesPerSec',
        'queue.oldestAgeMs',
      ]),
    );

    const collapseAnalyzer = primedAnalyzer();
    const collapsed = collapseAnalyzer.evaluate(
      frame(4, {
        'cpu.hostUtilizationPct': 99.9,
        'cpu.psiSomePct': 22,
        'progress.heartbeatLagMs': 900,
        'latency.eventLoopP95Ms': 180,
      }),
    );
    expect(collapsed).toMatchObject({ state: 'degraded', actionable: true, severity: 'critical' });
    expect(collapsed.actionableResources).toContain('cpu');
    expect(collapsed.attributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          causeSignal: 'cpu.psiSomePct',
          outcomeSignal: 'latency.eventLoopP95Ms',
          resource: 'cpu',
          actionable: true,
        }),
      ]),
    );
  });

  it('distinguishes ordinary swap residency from active swap thrash', () => {
    const analyzer = primedAnalyzer();
    const ordinarySwap = analyzer.evaluate(
      frame(4, {
        'memory.swapUsedBytes': 64 * 1024 ** 3,
        'memory.swapInBytesPerSec': 0,
        'memory.swapOutBytesPerSec': 0,
      }),
    );
    expect(ordinarySwap).toMatchObject({ state: 'healthy', actionable: false });

    const thrash = analyzer.evaluate(
      frame(5, {
        'memory.swapUsedBytes': 64 * 1024 ** 3,
        'memory.swapInBytesPerSec': 32 * 1024 ** 2,
        'memory.swapOutBytesPerSec': 48 * 1024 ** 2,
        'memory.psiFullPct': 18,
        'memory.majorFaultsPerSec': 120,
        'latency.eventLoopP95Ms': 160,
      }),
    );
    expect(thrash).toMatchObject({ state: 'degraded', actionable: true });
    expect(thrash.actionableResources).toEqual(['memory']);
    expect(thrash.attributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ causeSignal: 'memory.swapInBytesPerSec', resource: 'memory', actionable: true }),
        expect.objectContaining({ causeSignal: 'memory.psiFullPct', resource: 'memory', actionable: true }),
      ]),
    );
  });

  it('attributes full I/O pressure only when service progress degrades', () => {
    const pressureOnly = primedAnalyzer().evaluate(frame(4, { 'io.psiFullPct': 12 }));
    expect(pressureOnly).toMatchObject({ state: 'healthy', actionable: false, severity: 'none' });

    const stalled = primedAnalyzer().evaluate(
      frame(4, {
        'io.psiFullPct': 12,
        'progress.heartbeatLagMs': 900,
        'latency.eventLoopP95Ms': 180,
      }),
    );
    expect(stalled).toMatchObject({ state: 'degraded', actionable: true, severity: 'critical' });
    expect(stalled.actionableResources).toContain('io');
    expect(stalled.attributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          causeSignal: 'io.psiFullPct',
          outcomeSignal: 'latency.eventLoopP95Ms',
          resource: 'io',
          actionable: true,
        }),
      ]),
    );
  });

  it('does not attribute an unrelated outcome regression to coincident raw host load', () => {
    const analyzer = primedAnalyzer();
    const verdict = analyzer.evaluate(
      frame(4, {
        'cpu.hostUtilizationPct': 100,
        'cpu.processUtilizationPct': 900,
        'cpu.psiSomePct': 0.1,
        'latency.eventLoopP95Ms': 180,
      }),
    );
    expect(verdict).toMatchObject({ state: 'degraded', actionable: false });
    expect(verdict.attributions).toHaveLength(0);
    expect(verdict.reasons).toContain('service-degradation-not-actionably-attributed');
  });

  it('keeps low-confidence and stale degradation evidence non-actionable', () => {
    const analyzer = primedAnalyzer();
    const lowConfidence = analyzer.evaluate(
      frame(4, {
        'cpu.psiSomePct': reading('cpu.psiSomePct', 20, START + 4 * STEP),
        'latency.eventLoopP95Ms': reading('latency.eventLoopP95Ms', 180, START + 4 * STEP, 0.2),
      }),
    );
    expect(lowConfidence).toMatchObject({ state: 'degraded', actionable: false });
    expect(lowConfidence.evidence.find((item) => item.signal === 'latency.eventLoopP95Ms')).toMatchObject({
      quality: 'low-confidence',
      breached: true,
    });

    const observedAtMs = START + 4 * STEP;
    const measured = reading('latency.eventLoopP95Ms', 180, observedAtMs);
    const stale = staleLiveHealthReading('latency.eventLoopP95Ms', measured, observedAtMs + 60_000);
    const staleVerdict = analyzer.evaluate({
      scopeId: 'operator:fixture',
      atMs: observedAtMs + 60_000,
      signals: {
        'cpu.psiSomePct': reading('cpu.psiSomePct', 20, observedAtMs + 60_000),
        'latency.eventLoopP95Ms': stale,
      },
    });
    expect(staleVerdict).toMatchObject({ state: 'unknown', actionable: false });
    expect(staleVerdict.evidence.find((item) => item.signal === 'latency.eventLoopP95Ms')).toMatchObject({
      quality: 'stale',
      breached: false,
    });
  });

  it('rolls bounded healthy history and refuses to learn a degraded frame as normal', () => {
    const baseline = new RollingHealthyBaselineStore({ maxSamples: 4, minimumSamples: 3 });
    const analyzer = new RollingHealthAnalyzer({ baseline });
    for (let index = 0; index < 4; index++) {
      analyzer.primeHealthy(frame(index, { 'latency.eventLoopP95Ms': 8 + index }));
    }
    expect(baseline.get('operator:fixture', 'latency.eventLoopP95Ms', START + 4 * STEP)).toMatchObject({
      ready: true,
      sampleCount: 4,
      median: 9.5,
    });

    analyzer.evaluate(
      frame(4, {
        'cpu.psiSomePct': 20,
        'latency.eventLoopP95Ms': 200,
      }),
    );
    expect(baseline.get('operator:fixture', 'latency.eventLoopP95Ms', START + 5 * STEP)).toMatchObject({
      sampleCount: 4,
      median: 9.5,
    });
  });
});
