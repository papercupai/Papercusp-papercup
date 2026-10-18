/**
 * run — unit coverage for runScoutCycleTick, the SHARED scout autonomous-tick
 * orchestration both the routine action and the deterministic blueprint step run.
 * The structural self-gates live inside runScoutTick (mocked here); what's tested
 * is run.ts's own orchestration: the single-runner gate, the workspace-ceiling
 * gate (incl. its governor mirror on a held cycle), and the fired/no-op mirror.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BuildScoutTickDepsOptions, ScoutTickDeps } from './scheduler';

const sched = vi.hoisted(() => ({
  DEFAULT_SCOUT_CYCLE_TIMEOUT_MS: 20 * 60_000,
  runScoutTick: vi.fn(),
  buildScoutTickDeps: vi.fn((_opts: BuildScoutTickDepsOptions) => ({}) as ScoutTickDeps),
}));
vi.mock('./scheduler', () => sched);

import { runScoutCycleTick, parseScoutCycleConfig, productionDepsBuilder, type ScoutCycleDeps } from './run';

const baseInput = {
  workspaceId: 'ws',
  installSlug: 'h',
  admissionQueueScope: { kind: 'harness' as const, harnessSlug: 'h' },
  payloadTemplate: null,
};
const runCycle = vi.fn();
const recordTick = vi.fn();
const buildDeps = vi.fn(() => ({ recordTick })); // fake tick deps — the mocked runScoutTick ignores them

function mkDeps(over: Record<string, unknown> = {}): ScoutCycleDeps {
  return { runCycle, buildDeps, ...over } as unknown as ScoutCycleDeps;
}

beforeEach(() => {
  sched.runScoutTick.mockReset().mockResolvedValue({ fired: true, costUsd: 1.5, cycleId: 'c1' });
  sched.buildScoutTickDeps.mockClear();
  runCycle.mockReset();
  buildDeps.mockClear();
  recordTick.mockReset();
});

describe('parseScoutCycleConfig', () => {
  it('returns {} for a null / non-object / array payload', () => {
    expect(parseScoutCycleConfig(null)).toEqual({});
    expect(parseScoutCycleConfig('nope' as never)).toEqual({});
    expect(parseScoutCycleConfig([] as never)).toEqual({});
  });

  it('extracts the cadence + budget objects, dropping unknown / bad-shape keys', () => {
    expect(
      parseScoutCycleConfig({
        cadence: { x: 1 },
        budget: { maxCostUsd: 2 },
        cycleTimeoutMs: 1_500_000,
        junk: 5,
      } as never),
    ).toEqual({
      cadence: { x: 1 },
      budget: { maxCostUsd: 2 },
      cycleTimeoutMs: 1_500_000,
    });
    expect(parseScoutCycleConfig({ cadence: 'bad', budget: 7, cycleTimeoutMs: 0 } as never)).toEqual({}); // bad shapes → dropped
  });

  it('unwraps blueprint-run nested payloads and honors explicit cycle timeouts', () => {
    expect(
      parseScoutCycleConfig({
        blueprintId: 'scout',
        cycleTimeoutMs: 120_000,
        payload: {
          cadence: { minIntervalSec: 3600 },
          budget: { maxCostUsd: 3 },
          cycleTimeoutMs: 120_000,
        },
      } as never),
    ).toEqual({
      cadence: { minIntervalSec: 3600 },
      budget: { maxCostUsd: 3 },
      cycleTimeoutMs: 120_000,
    });
  });
});

describe('productionDepsBuilder', () => {
  it('unwraps blueprint-run nested payloads before resolving the scout model block', async () => {
    productionDepsBuilder(
      {
        workspaceId: 'ws',
        installSlug: 'h',
        admissionQueueScope: { kind: 'harness', harnessSlug: 'h' },
        payloadTemplate: {
          blueprintId: 'scout',
          payload: { scout: { models: { ideator: 'chatgpt:5.5' } } },
        },
      },
      runCycle,
    );

    const built = sched.buildScoutTickDeps.mock.calls[0][0];
    await built.runCycle({ budget: { maxCostUsd: 1, maxIdeators: 1, maxCriticsPerIdea: 2 }, cycleId: 'cyc-1' });

    expect(runCycle.mock.calls[0][0].scoutConfig.models.ideator).toBe('chatgpt:5.5');
  });

  it('forwards scheduler phase diagnostics into the production cycle runner', async () => {
    productionDepsBuilder(
      {
        workspaceId: 'ws',
        installSlug: 'h',
        admissionQueueScope: { kind: 'harness', harnessSlug: 'h' },
        payloadTemplate: null,
      },
      runCycle,
    );

    const onPhase = vi.fn();
    const built = sched.buildScoutTickDeps.mock.calls[0][0];
    await built.runCycle({
      budget: { maxCostUsd: 1, maxIdeators: 1, maxCriticsPerIdea: 2 },
      cycleId: 'cyc-1',
      onPhase,
    });

    expect(runCycle.mock.calls[0][0].onPhase).toBe(onPhase);
  });

  it('forwards the scheduler deadline into the production cycle runner', async () => {
    productionDepsBuilder(
      {
        workspaceId: 'ws',
        installSlug: 'h',
        admissionQueueScope: { kind: 'harness', harnessSlug: 'h' },
        payloadTemplate: null,
      },
      runCycle,
    );

    const deadlineMs = Date.now() + 20 * 60_000;
    const built = sched.buildScoutTickDeps.mock.calls[0][0];
    await built.runCycle({
      budget: { maxCostUsd: 1, maxIdeators: 1, maxCriticsPerIdea: 2 },
      cycleId: 'cyc-1',
      deadlineMs,
    });

    expect(runCycle.mock.calls[0][0].deadlineMs).toBe(deadlineMs);
  });
});

describe('runScoutCycleTick — gates + governor mirror', () => {
  it('hiveRunnerGate refusal short-circuits as not-hive-runner and records a gated tick', async () => {
    const recordGovernor = vi.fn();
    const res = await runScoutCycleTick(
      baseInput,
      mkDeps({ recordGovernor, hiveRunnerGate: async () => ({ run: false, reason: 'standby' }) }),
    );
    expect(res).toEqual({ fired: false, reason: 'not-hive-runner' });
    expect(sched.runScoutTick).not.toHaveBeenCalled();
    expect(recordGovernor).not.toHaveBeenCalled();
    expect(recordTick).toHaveBeenCalledWith({
      status: 'gated',
      gate: 'not-hive-runner',
      detail: { reason: 'standby', budgetProvenance: {
        schemaVersion: 1, supplied: null, resolved: { maxCostUsd: 1, maxIdeators: 6, maxCriticsPerIdea: 2 },
      } },
    });
  });

  it('workspaceCeilingGate refusal records a gated tick and mirrors the per-cycle cap (fired:null)', async () => {
    const recordGovernor = vi.fn();
    const res = await runScoutCycleTick(
      baseInput,
      mkDeps({
        recordGovernor,
        workspaceCeilingGate: async () => ({
          allow: false,
          totalScoutSpentUsd: 9,
          ceilingUsd: 8,
          remainingUsd: 0,
          scoutLoopCount: 3,
        }),
      }),
    );
    expect(res).toEqual({ fired: false, reason: 'workspace-ceiling' });
    expect(sched.runScoutTick).not.toHaveBeenCalled();
    expect(recordTick).toHaveBeenCalledWith({
      status: 'gated',
      gate: 'workspace-ceiling',
      detail: {
        reason: 'workspace-ceiling',
        totalScoutSpentUsd: 9,
        ceilingUsd: 8,
        scoutLoopCount: 3,
        budgetProvenance: {
          schemaVersion: 1, supplied: null, resolved: { maxCostUsd: 1, maxIdeators: 6, maxCriticsPerIdea: 2 },
        },
      },
    });
    expect(recordGovernor).toHaveBeenCalledTimes(1);
    expect(recordGovernor.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws', harnessSlug: 'h', fired: null });
  });

  it('potGate refusal short-circuits BEFORE every other gate (learning-pot-scope-gate D-001)', async () => {
    const recordGovernor = vi.fn();
    const hiveRunnerGate = vi.fn(async () => ({ run: true }));
    const workspaceCeilingGate = vi.fn(async () => ({ allow: true }) as never);
    const res = await runScoutCycleTick(
      baseInput,
      mkDeps({
        recordGovernor,
        hiveRunnerGate,
        workspaceCeilingGate,
        potGate: async () => ({ enabled: false }),
      }),
    );
    expect(res).toEqual({ fired: false, reason: 'pot-disabled' });
    expect(sched.runScoutTick).not.toHaveBeenCalled();
    // It is the OUTERMOST switch: no other gate is even consulted.
    expect(hiveRunnerGate).not.toHaveBeenCalled();
    expect(workspaceCeilingGate).not.toHaveBeenCalled();
    // And unlike the ceiling refusal, it does NOT mirror a per-cycle cap — a
    // switched-off pot has no live sub-budget, and writing one would make it
    // look like an active learner in the governor ledger.
    expect(recordGovernor).not.toHaveBeenCalled();
    expect(recordTick).toHaveBeenCalledWith({
      status: 'gated',
      gate: 'pot-disabled',
      detail: { reason: 'pot-disabled', budgetProvenance: {
        schemaVersion: 1, supplied: null, resolved: { maxCostUsd: 1, maxIdeators: 6, maxCriticsPerIdea: 2 },
      } },
    });
  });

  it('potGate allowing changes nothing, and an unwired potGate is the pre-gate path (R-5)', async () => {
    sched.runScoutTick.mockResolvedValue({ fired: true, costUsd: 1, cycleId: 'cyc-pot' });
    const allowed = await runScoutCycleTick(baseInput, mkDeps({ potGate: async () => ({ enabled: true }) }));
    expect(allowed).toMatchObject({ fired: true });

    sched.runScoutTick.mockResolvedValue({ fired: true, costUsd: 1, cycleId: 'cyc-nopot' });
    const unwired = await runScoutCycleTick(baseInput, mkDeps({}));
    expect(unwired).toMatchObject({ fired: true });
  });

  it('runs the tick when both gates allow and mirrors a FIRED cycle (costUsd + cycleId) to the governor', async () => {
    sched.runScoutTick.mockResolvedValue({ fired: true, costUsd: 2.25, cycleId: 'cyc-9' });
    const recordGovernor = vi.fn();
    const res = await runScoutCycleTick(
      baseInput,
      mkDeps({
        recordGovernor,
        hiveRunnerGate: async () => ({ run: true }),
        workspaceCeilingGate: async () => ({ allow: true }),
      }),
    );
    expect(res).toMatchObject({ fired: true, costUsd: 2.25 });
    expect(sched.runScoutTick).toHaveBeenCalledTimes(1);
    expect(recordGovernor.mock.calls[0][0]).toMatchObject({ fired: { costUsd: 2.25, cycleId: 'cyc-9' } });
  });

  // WI-10007380 / P-003 (R-4, R-6): a DEEP throttle no longer curbs the cycle — it
  // skips paid generation outright and records why on the tick.
  it('skips paid generation under deep queue pressure and records the reason and pressure on the tick', async () => {
    const pressure = {
      source: 'p005-queue-health' as const,
      level: 'deep' as const,
      pending: 41,
      latencySampleSize: 0,
      p95Ms: null,
      maxIdeators: 1,
      reasons: ['pending 41 exceeds two promoter batches (40)'],
    };
    const admissionPressureGate = vi.fn(async () => pressure);
    const recordGovernor = vi.fn();
    const res = await runScoutCycleTick(
      { ...baseInput, payloadTemplate: { budget: { maxCostUsd: 2, maxIdeators: 6 } } },
      mkDeps({ admissionPressureGate, recordGovernor }),
    );
    expect(res).toEqual({ fired: false, reason: 'generation-preflight' });
    expect(sched.runScoutTick).not.toHaveBeenCalled();
    expect(recordGovernor.mock.calls[0][0]).toMatchObject({ fired: null });
    expect(recordTick).toHaveBeenCalledWith({
      status: 'gated',
      gate: 'generation-preflight',
      detail: {
        reason: 'admission-throttle-deep',
        pending: 41,
        p95Ms: null,
        throttleReasons: pressure.reasons,
        admissionThrottle: pressure,
        budgetProvenance: {
          schemaVersion: 1, supplied: { maxCostUsd: 2, maxIdeators: 6 },
          resolved: { maxCostUsd: 2, maxIdeators: 6, maxCriticsPerIdea: 2 },
        },
      },
    });
  });

  // WI-10007380 / P-003 (R-5, R-6): dedup saturation that outlasted the novelty
  // widening skips paid generation; a probe cycle runs after enough skips.
  it('skips paid generation while dedup saturation outlasts the widening budget, then probes', async () => {
    const saturated = Array.from({ length: 5 }, () => ({
      status: 'ran' as const,
      ideasGenerated: 10,
      ideasDeduped: 9,
      ideasRouted: 0,
    }));
    const skipped = await runScoutCycleTick(
      baseInput,
      mkDeps({ generationPreflightTicks: async () => saturated }),
    );
    expect(skipped).toEqual({ fired: false, reason: 'generation-preflight' });
    expect(sched.runScoutTick).not.toHaveBeenCalled();
    expect(recordTick).toHaveBeenCalledWith({
      status: 'gated',
      gate: 'generation-preflight',
      detail: { reason: 'dedup-saturated', consecutiveSaturated: 5, lastRatio: 0.9, skipStreak: 5, probeIn: 5,
        budgetProvenance: {
          schemaVersion: 1, supplied: null, resolved: { maxCostUsd: 1, maxIdeators: 6, maxCriticsPerIdea: 2 },
        },
      },
    });

    const priorSkips = Array.from({ length: 5 }, () => ({
      status: 'gated' as const,
      gate: 'generation-preflight',
      detail: { reason: 'dedup-saturated' },
    }));
    await runScoutCycleTick(
      baseInput,
      mkDeps({ generationPreflightTicks: async () => [...priorSkips, ...saturated] }),
    );
    expect(sched.runScoutTick).toHaveBeenCalledTimes(1);
  });

  it.each(['pot-disabled', 'not-hive-runner', 'workspace-ceiling', 'generation-preflight'] as const)(
    'preserves the supplied one-ideator zero-spend cap when %s refuses before the scheduler', async gate => {
      const budget = { maxCostUsd: 0, maxIdeators: 1 };
      const refusal = {
        'pot-disabled': { potGate: async () => ({ enabled: false }) },
        'not-hive-runner': { hiveRunnerGate: async () => ({ run: false }) },
        'workspace-ceiling': { workspaceCeilingGate: async () => ({ allow: false }) },
        'generation-preflight': { admissionPressureGate: async () => ({ level: 'deep', reasons: [] }) },
      }[gate]!;
      const result = await runScoutCycleTick(
        { ...baseInput, payloadTemplate: { budget } }, mkDeps(refusal),
      );
      expect(result).toEqual({ fired: false, reason: gate });
      expect(sched.runScoutTick).not.toHaveBeenCalled();
      expect(runCycle).not.toHaveBeenCalled();
      expect(recordTick).toHaveBeenCalledTimes(1);
      expect(recordTick.mock.calls[0][0]).toMatchObject({ status: 'gated', gate, detail: {
        budgetProvenance: { schemaVersion: 1, supplied: budget,
          resolved: { maxCostUsd: 0, maxIdeators: 1, maxCriticsPerIdea: 2 } },
      } });
      expect(recordTick.mock.calls[0][0].detail).not.toHaveProperty('ideators');
    },
  );

  it('records the layered pot budget on an early refusal without inventing a caller default', async () => {
    await runScoutCycleTick(
      { ...baseInput, payloadTemplate: { budget: { maxCostUsd: 2, maxIdeators: 6 } } },
      mkDeps({ resolveConfigDelta: async () => ({ budget: { maxCostUsd: 0.05, maxIdeators: 1 } }),
        potGate: async () => ({ enabled: false }) }),
    );
    expect(recordTick.mock.calls[0][0].detail.budgetProvenance).toEqual({ schemaVersion: 1,
      supplied: { maxCostUsd: 0.05, maxIdeators: 1 },
      resolved: { maxCostUsd: 0.05, maxIdeators: 1, maxCriticsPerIdea: 2 } });
    expect(sched.runScoutTick).not.toHaveBeenCalled();
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('curbs ideator admission under elevated queue pressure and records the exact pressure on the tick', async () => {
    sched.runScoutTick.mockImplementationOnce(async (deps, opts) => {
      await deps.recordTick?.({ status: 'ran', detail: { cycleId: 'c-pressure' } });
      return { fired: true, costUsd: 0.2, cycleId: 'c-pressure', budget: opts.budget } as never;
    });
    const pressure = {
      source: 'p005-queue-health' as const,
      level: 'elevated' as const,
      pending: 21,
      latencySampleSize: 0,
      p95Ms: null,
      maxIdeators: 1,
      reasons: ['pending 21 exceeds one promoter batch (20)'],
    };
    const admissionPressureGate = vi.fn(async () => pressure);
    await runScoutCycleTick(
      { ...baseInput, payloadTemplate: { budget: { maxCostUsd: 2, maxIdeators: 6 } } },
      mkDeps({ admissionPressureGate }),
    );
    expect(admissionPressureGate).toHaveBeenCalledWith({ workspaceId: 'ws', harnessSlug: 'h' });
    expect(sched.runScoutTick.mock.calls[0][1]?.budget).toMatchObject({ maxCostUsd: 2, maxIdeators: 1 });
    expect(recordTick).toHaveBeenCalledWith({
      status: 'ran',
      detail: { cycleId: 'c-pressure', admissionThrottle: pressure },
    });
  });

  it('aggregates queue pressure across the workspace without treating the tick sentinel as a harness slug', async () => {
    const admissionPressureGate = vi.fn(async () => ({
      source: 'p005-queue-health' as const,
      level: 'normal' as const,
      pending: 17,
      latencySampleSize: 0,
      p95Ms: null,
      maxIdeators: null,
      reasons: ['normal workspace queue'],
    }));
    await runScoutCycleTick(
      {
        ...baseInput,
        installSlug: 'ws',
        admissionQueueScope: { kind: 'workspace' },
      },
      mkDeps({ admissionPressureGate }),
    );
    expect(admissionPressureGate).toHaveBeenCalledWith({ workspaceId: 'ws' });
  });

  it('restores the configured ideator budget when the queue drains', async () => {
    await runScoutCycleTick(
      { ...baseInput, payloadTemplate: { budget: { maxIdeators: 5 } } },
      mkDeps({
        admissionPressureGate: async () => ({
          source: 'p005-queue-health',
          level: 'normal',
          pending: 0,
          latencySampleSize: 0,
          p95Ms: null,
          maxIdeators: null,
          reasons: ['drained'],
        }),
      }),
    );
    expect(sched.runScoutTick.mock.calls[0][1]?.budget).toEqual({ maxIdeators: 5 });
  });

  it('passes a configured cycle timeout through to runScoutTick', async () => {
    await runScoutCycleTick({ ...baseInput, payloadTemplate: { cycleTimeoutMs: 1_500_000 } }, mkDeps());
    expect(sched.runScoutTick.mock.calls[0][1]).toMatchObject({ cycleTimeoutMs: 1_500_000 });
  });

  it('mirrors a NO-OP (un-fired) tick as fired:null', async () => {
    sched.runScoutTick.mockResolvedValue({ fired: false, reason: 'cadence' });
    const recordGovernor = vi.fn();
    await runScoutCycleTick(baseInput, mkDeps({ recordGovernor }));
    expect(recordGovernor.mock.calls[0][0]).toMatchObject({ fired: null });
  });

  it('is hermetic with no governor wired — runs the tick, no governor IO', async () => {
    const res = await runScoutCycleTick(baseInput, mkDeps());
    expect(res).toMatchObject({ fired: true });
    expect(sched.runScoutTick).toHaveBeenCalledTimes(1);
  });
});
