import { describe, expect, it } from 'vitest';
import type { LiveHealthSignalKey } from './live-health';
import type { HealthResource, HealthSeverity, HealthVerdict } from './health-analysis';
import { HEALTH_ANALYSIS_SCHEMA_VERSION } from './health-analysis';
import { CaplessAdaptiveController, type ClassAdmissionDecision } from './controller';

const START = 1_700_000_000_000;

function verdict(input: {
  state?: HealthVerdict['state'];
  severity?: HealthSeverity;
  resource?: HealthResource;
  progressLoss?: boolean;
  ignoredCapacitySignals?: readonly LiveHealthSignalKey[];
  atMs?: number;
} = {}): HealthVerdict {
  const state = input.state ?? 'healthy';
  const severity = input.severity ?? 'none';
  const actionable = state === 'degraded' && input.resource !== undefined;
  const outcomeSignal: LiveHealthSignalKey = input.progressLoss
    ? 'latency.eventLoopP95Ms'
    : input.resource === 'provider'
      ? 'provider.rateLimited'
      : input.resource === 'database'
        ? 'database.waitP95Ms'
        : 'latency.eventLoopP95Ms';
  const causeSignal: LiveHealthSignalKey =
    input.resource === 'provider'
      ? 'provider.rateLimited'
      : input.resource === 'database'
        ? 'database.waitP95Ms'
        : input.resource === 'io'
          ? 'io.psiFullPct'
          : input.resource === 'memory'
            ? 'memory.psiFullPct'
            : 'cpu.psiSomePct';
  return {
    schemaVersion: HEALTH_ANALYSIS_SCHEMA_VERSION,
    scopeId: 'simulation',
    evaluatedAtMs: input.atMs ?? START,
    state,
    severity,
    actionable,
    evidence:
      state === 'degraded'
        ? [{
            objectiveId: 'simulation-objective',
            signal: outcomeSignal,
            resource: input.resource ?? 'service',
            readingState: 'measured',
            value: 100,
            confidence: 1,
            baseline: null,
            warningBoundary: 20,
            criticalBoundary: 50,
            inflationRatio: 10,
            breached: true,
            severity,
            quality: 'actionable',
            reason: 'simulation-degradation',
          }]
        : [],
    attributions: actionable
      ? [{
          objectiveId: 'simulation-objective',
          outcomeSignal,
          causeSignal,
          resource: input.resource!,
          confidence: 1,
          correlation: 1,
          temporallyAligned: true,
          actionable: true,
          reason: 'simulation-attribution',
        }]
      : [],
    actionableResources: input.resource ? [input.resource] : [],
    ignoredCapacitySignals: input.ignoredCapacitySignals ?? [],
    reasons: [state === 'healthy' ? 'service-objectives-satisfied' : 'simulation-degradation'],
  };
}

function lane(decision: { readonly classes: readonly ClassAdmissionDecision[] }, admissionClass: string) {
  const found = decision.classes.find((item) => item.admissionClass === admissionClass);
  if (!found) throw new Error(`missing ${admissionClass} lane`);
  return found;
}

describe('CaplessAdaptiveController', () => {
  it('probes upward without a configured or derived ceiling', () => {
    const controller = new CaplessAdaptiveController({ healthySamplesPerIncrease: 1 });
    let decision = controller.step({ verdict: verdict(), classes: [{ admissionClass: 'agent', demand: { cpuWeight: 1 } }] });
    for (let index = 1; index < 2_000; index += 1) {
      decision = controller.step({
        verdict: verdict({ atMs: START + index }),
        classes: [{ admissionClass: 'agent', demand: { cpuWeight: 1 } }],
      });
    }
    expect(lane(decision, 'agent').desiredWindow).toBe(2_001);
    expect(lane(decision, 'agent').effectiveWindow).toBe(2_001);
  });

  it('converges around a simulated capacity with bounded AIMD oscillation', () => {
    const controller = new CaplessAdaptiveController({
      healthySamplesPerIncrease: 1,
      initialWindow: 1,
      contractionCooldownMs: 0,
      severePauseMinimumShare: 1,
    });
    const capacity = 12;
    let effective = 1;
    const tail: number[] = [];
    for (let tick = 0; tick < 240; tick += 1) {
      const unhealthy = effective > capacity;
      const decision = controller.step({
        atMs: START + tick * 1_000,
        verdict: unhealthy
          ? verdict({ state: 'degraded', severity: 'warning', resource: 'cpu', atMs: START + tick * 1_000 })
          : verdict({ atMs: START + tick * 1_000 }),
        classes: [{ admissionClass: 'agent', demand: { cpuWeight: 1 } }],
      });
      effective = lane(decision, 'agent').effectiveWindow;
      if (tick >= 140) tail.push(effective);
    }
    expect(Math.max(...tail)).toBe(capacity + 1);
    expect(Math.min(...tail)).toBeGreaterThanOrEqual(9);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThanOrEqual(4);
  });

  it('does not throttle on utilization or occupancy alone', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 20, healthySamplesPerIncrease: 1 });
    const decision = controller.step({
      verdict: verdict({
        ignoredCapacitySignals: ['cpu.hostUtilizationPct', 'memory.hostUsedBytes', 'memory.swapUsedBytes'],
      }),
      classes: [{ admissionClass: 'agent', demand: { cpuWeight: 1, memoryBytes: 1_000 } }],
    });
    expect(lane(decision, 'agent')).toMatchObject({ desiredWindow: 21, effectiveWindow: 21, feedback: [] });
  });

  it('contracts only causally responsible classes and does so proportionally', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 100, contractionCooldownMs: 0 });
    const decision = controller.step({
      verdict: verdict({ state: 'degraded', severity: 'critical', resource: 'provider' }),
      classes: [
        { admissionClass: 'inference', demand: { providerRequests: 9 } },
        { admissionClass: 'embedding', demand: { providerRequests: 1 } },
        { admissionClass: 'database', demand: { databaseConnections: 20 } },
        { admissionClass: 'control', demand: { providerRequests: 100 } },
      ],
    });
    expect(lane(decision, 'inference').desiredWindow).toBe(55);
    expect(lane(decision, 'embedding').desiredWindow).toBe(95);
    expect(lane(decision, 'database').desiredWindow).toBe(100);
    expect(lane(decision, 'control')).toMatchObject({ desiredWindow: 100, protected: true, paused: false });
  });

  it('weights per-start resource demand by live in-flight occupancy', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 110, contractionCooldownMs: 0 });
    const decision = controller.step({
      verdict: verdict({ state: 'degraded', severity: 'critical', resource: 'cpu' }),
      classes: [
        { admissionClass: 'agent', inFlight: 100, demand: { cpuWeight: 1 } },
        { admissionClass: 'build', inFlight: 1, demand: { cpuWeight: 10 } },
        { admissionClass: 'background', inFlight: 0, demand: { cpuWeight: 1_000 } },
      ],
    });
    expect(lane(decision, 'agent').desiredWindow).toBe(60);
    expect(lane(decision, 'build').desiredWindow).toBe(105);
    expect(lane(decision, 'background').desiredWindow).toBe(110);
  });

  it('contracts only classes with explicit custom I/O demand when I/O is attributed', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 100, contractionCooldownMs: 0 });
    const decision = controller.step({
      verdict: verdict({ state: 'degraded', severity: 'critical', resource: 'io' }),
      classes: [
        { admissionClass: 'background-read', demand: { custom: { 'resource:io': 9 } } },
        { admissionClass: 'background-write', demand: { custom: { io: 1 } } },
        { admissionClass: 'service', demand: { cpuWeight: 1 } },
      ],
    });
    expect(lane(decision, 'background-read').desiredWindow).toBe(55);
    expect(lane(decision, 'background-write').desiredWindow).toBe(95);
    expect(lane(decision, 'service').desiredWindow).toBe(100);
    expect(lane(decision, 'background-read').feedback[0]).toMatchObject({
      resource: 'io',
      attributableShare: 0.9,
    });
  });

  it('temporarily pauses the responsible class on severe progress loss while preserving control', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 40, severePauseMs: 2_000 });
    const degraded = controller.step({
      atMs: START,
      verdict: verdict({ state: 'degraded', severity: 'critical', resource: 'cpu', progressLoss: true }),
      classes: [
        { admissionClass: 'agent', demand: { cpuWeight: 9 } },
        { admissionClass: 'background', demand: { cpuWeight: 1 } },
        { admissionClass: 'control', demand: { cpuWeight: 100 } },
      ],
    });
    expect(lane(degraded, 'agent')).toMatchObject({ paused: true, effectiveWindow: 0 });
    expect(lane(degraded, 'background').paused).toBe(false);
    expect(lane(degraded, 'control')).toMatchObject({ protected: true, paused: false, effectiveWindow: 40 });

    const recovered = controller.step({
      atMs: START + 2_001,
      verdict: verdict({ atMs: START + 2_001 }),
      classes: [{ admissionClass: 'agent', demand: { cpuWeight: 9 } }],
    });
    expect(lane(recovered, 'agent').paused).toBe(false);
    expect(lane(recovered, 'agent').effectiveWindow).toBeGreaterThan(0);
  });

  it('expires contraction evidence and probes past the pre-contraction window after recovery', () => {
    const controller = new CaplessAdaptiveController({
      initialWindow: 16,
      healthySamplesPerIncrease: 1,
      contractionTtlMs: 4_000,
    });
    const degraded = controller.step({
      atMs: START,
      verdict: verdict({ state: 'degraded', severity: 'critical', resource: 'provider' }),
      classes: [{ admissionClass: 'inference', demand: { providerRequests: 1 } }],
    });
    expect(lane(degraded, 'inference')).toMatchObject({ desiredWindow: 8 });
    expect(lane(degraded, 'inference').feedback).toHaveLength(1);

    let recovered = degraded;
    for (let tick = 1; tick <= 10; tick += 1) {
      recovered = controller.step({
        atMs: START + tick * 1_000,
        verdict: verdict({ atMs: START + tick * 1_000 }),
        classes: [{ admissionClass: 'inference', demand: { providerRequests: 1 } }],
      });
    }
    expect(lane(recovered, 'inference').feedback).toHaveLength(0);
    expect(lane(recovered, 'inference').desiredWindow).toBe(18);
  });

  it('honours a caller-supplied per-class floor on a cold start and through contraction (WI-10006946)', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 1, contractionCooldownMs: 0 });
    const cold = controller.step({
      verdict: verdict(),
      classes: [
        { admissionClass: 'critical-lane', inFlight: 0, demand: { databaseConnections: 1 }, minimumWindow: 8 },
        { admissionClass: 'ordinary', inFlight: 0, demand: { databaseConnections: 1 } },
      ],
    });
    expect(lane(cold, 'critical-lane')).toMatchObject({ desiredWindow: 8, availableStarts: 8 });
    expect(lane(cold, 'ordinary')).toMatchObject({ desiredWindow: 1, availableStarts: 1 });

    const contracted = controller.step({
      verdict: verdict({ state: 'degraded', severity: 'critical', resource: 'database', atMs: START + 1 }),
      classes: [
        { admissionClass: 'critical-lane', inFlight: 6, demand: { databaseConnections: 1 }, minimumWindow: 8 },
      ],
      atMs: START + 1,
    });
    // Critical feedback would halve 8 -> 4; the floor stops it at 8.
    expect(lane(contracted, 'critical-lane').desiredWindow).toBe(8);
    expect(lane(contracted, 'critical-lane').feedback[0]?.desiredWindowAfter).toBe(8);

    // Dropping the floor restores ordinary contraction for the same feedback.
    const unfloored = controller.step({
      verdict: verdict({ state: 'degraded', severity: 'critical', resource: 'database', atMs: START + 2 }),
      classes: [{ admissionClass: 'critical-lane', inFlight: 6, demand: { databaseConnections: 1 } }],
      atMs: START + 2,
    });
    expect(lane(unfloored, 'critical-lane').desiredWindow).toBe(4);
  });

  it('holds the current window when degradation is not actionably attributed', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 24 });
    const decision = controller.step({
      verdict: verdict({ state: 'degraded', severity: 'critical' }),
      classes: [{ admissionClass: 'agent', demand: { cpuWeight: 1 } }],
    });
    expect(lane(decision, 'agent')).toMatchObject({ desiredWindow: 24, effectiveWindow: 24, feedback: [] });
  });
});
