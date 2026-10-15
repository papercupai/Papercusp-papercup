import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_ID, registerTest, resetTestRegistry } from '@papercusp/eval-battery';
import type { ReplayBatteryResult } from '../replay/battery';
import { _resetExperimentRegistration, registerExperimentDescriptors } from './descriptors';
import { runExperiment, type ExperimentScorecardCapture, type RunExperimentDeps, type RunExperimentInput } from './run-core';
import type { ExperimentLedger, ExperimentLedgerRow } from './ledger';

function canned(): ReplayBatteryResult {
  return {
    batteryId: 'b1',
    costMeasured: true,
    outcomes: [
      {
        runId: 'b1:baseline:c1:r0',
        variantId: BASELINE_ID,
        caseId: 'c1',
        caseRef: 'synthetic:c1',
        repeat: 0,
        status: 'scored',
        d1: 5,
        d2: 5,
        d3: 5,
        composite: 5,
        divergence: null,
        runUsd: 0,
        judgeUsd: 0,
        replayed: false,
      },
      {
        runId: 'b1:cand:c1:r0',
        variantId: 'cand',
        caseId: 'c1',
        caseRef: 'synthetic:c1',
        repeat: 0,
        status: 'scored',
        d1: 8,
        d2: 7,
        d3: 6,
        composite: 7,
        divergence: null,
        runUsd: 0.005,
        judgeUsd: 0.005,
        replayed: true,
      },
    ],
    perVariant: [
      { variantId: BASELINE_ID, label: 'historical baseline', cells: 1, scored: 1, meanComposite: 5, meanTokenJaccard: null, costUsd: 0 },
      { variantId: 'cand', label: 'terser', cells: 1, scored: 1, meanComposite: 7, meanTokenJaccard: 0.4, costUsd: 0.01 },
    ],
    comparison: {
      primaryScorer: 'composite',
      baseline: { variantId: BASELINE_ID, metrics: { composite: 5 } },
      candidates: [],
      selected: 'cand',
      selectionReason: '+2.0',
    },
    totalCostUsd: 0.01,
    rubricHash: 'rh',
    budgetExhausted: false,
  };
}

function deps(over: Partial<RunExperimentDeps> = {}): RunExperimentDeps {
  return {
    runGovernedReplay: vi.fn(async () => ({ verdict: { allow: true, remainingUsd: null }, result: canned() })) as unknown as RunExperimentDeps['runGovernedReplay'],
    replayRunner: (async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true })) as unknown as RunExperimentDeps['replayRunner'],
    judge: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as unknown as RunExperimentDeps['judge'],
    now: () => 0,
    ...over,
  };
}

const input = (over: Partial<RunExperimentInput> = {}): RunExperimentInput => ({
  testId: 'replay',
  batteryId: 'b1',
  arms: [{ id: 'cand', knobs: { 'overlay.systemOverlay': 'Be terse.' } }],
  cases: [{ caseId: 'c1', context: 'context so far', intent: 'do the task' }],
  repeats: 1,
  ...over,
});

describe('runExperiment', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('runs offline replay through the governed substrate + normalizes the result', async () => {
    const d = deps();
    const out = await runExperiment(input(), { workspaceId: 'ws' }, d);
    expect(out.ok).toBe(true);
    expect(out.result?.testId).toBe('replay');
    expect(out.result?.winner).toBe('cand');
    // baseline auto-prepended (caller gave only a candidate); synthetic case built.
    const cfg = (d.runGovernedReplay as unknown as { mock: { calls: any[][] } }).mock.calls[0]![0].config;
    expect(cfg.variants[0].variantId).toBe(BASELINE_ID);
    expect(cfg.variants[1]).toMatchObject({ variantId: 'cand', policy: { systemOverlay: 'Be terse.' } });
    expect(cfg.cases[0].kind).toBe('synthetic');
  });

  it('does NOT duplicate the baseline variant when the caller already supplies a BASELINE_ID arm (G14)', async () => {
    const d = deps();
    const out = await runExperiment(
      input({
        arms: [
          { id: BASELINE_ID, knobs: {} },
          { id: 'cand', knobs: { 'overlay.systemOverlay': 'Be terse.' } },
        ],
      }),
      { workspaceId: 'ws' },
      d,
    );
    expect(out.ok).toBe(true);
    const cfg = (d.runGovernedReplay as unknown as { mock: { calls: any[][] } }).mock.calls[0]![0].config;
    // EXACTLY ONE baseline variant — the explicit baseline arm is the anchor; the
    // auto-prepend guard (`!variants.some(...)`) must not add a second.
    const baselineVariants = cfg.variants.filter((v: { variantId: string }) => v.variantId === BASELINE_ID);
    expect(baselineVariants).toHaveLength(1);
    expect(cfg.variants.map((v: { variantId: string }) => v.variantId)).toEqual([BASELINE_ID, 'cand']);
  });

  it('surfaces a governed refusal as ok:false refused, never a spend', async () => {
    const out = await runExperiment(
      input(),
      { workspaceId: 'ws' },
      deps({ runGovernedReplay: vi.fn(async () => ({ verdict: { allow: false, reason: 'replay-dark', remainingUsd: null }, result: null })) as unknown as RunExperimentDeps['runGovernedReplay'] }),
    );
    expect(out.ok).toBe(false);
    expect(out.refused?.reason).toBe('replay-dark');
  });

  it('rejects an arm outside the replay slice before calling the substrate', async () => {
    const d = deps();
    const out = await runExperiment(input({ arms: [{ id: 'bad', knobs: { 'genome.config.wake.x': 1 } }] }), { workspaceId: 'ws' }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/outside the "replay" slice/);
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
  });

  it('rejects a safety-excluded knob before any spend', async () => {
    const d = deps();
    const out = await runExperiment(input({ arms: [{ id: 'evil', knobs: { 'budget.cap': 0 } }] }), { workspaceId: 'ws' }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/safety-excluded/);
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
  });

  it('refuses an unknown test id', async () => {
    const out = await runExperiment(input({ testId: 'nope' }), { workspaceId: 'ws' }, deps());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown test descriptor: nope/);
  });
});

describe('runExperiment tier default + escalation discipline (P-040/P-041)', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('P-040: naming a live testId without tier:"live" refuses (offline is the default front door)', async () => {
    const d = deps();
    const out = await runExperiment(input({ testId: 'gym' }), { workspaceId: 'ws' }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/default front door|runs at the live tier/);
    // never reached the substrate
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
  });

  it('P-040: replay with the default tier (offline) runs normally', async () => {
    const out = await runExperiment(input(), { workspaceId: 'ws' }, deps());
    expect(out.ok).toBe(true);
    expect(out.result?.tier).toBe('offline');
  });

  it('P-041: a live tier with NO escalation justification is refused before any spend', async () => {
    const governorPreflight = vi.fn(async () => ({ allow: true, remainingUsd: null }));
    const out = await runExperiment(input({ testId: 'gym', tier: 'live' }), { workspaceId: 'ws' }, deps({ governorPreflight }));
    expect(out.ok).toBe(false);
    expect(out.refused?.reason).toMatch(/positive offline signal|couldn.t-isolate/i);
    expect(governorPreflight).not.toHaveBeenCalled(); // escalation gate is upstream of the governor
  });

  it('P-041: a live tier WITH a couldn’t-isolate trigger passes the escalation gate, then hits the governor', async () => {
    const governorPreflight = vi.fn(async () => ({ allow: false, reason: 'unbudgeted' as const, remainingUsd: 0 }));
    const out = await runExperiment(
      input({ testId: 'gym', tier: 'live', escalation: { couldntIsolate: 'the overlay only bites under real multi-agent contention' } }),
      { workspaceId: 'ws' },
      deps({ governorPreflight }),
    );
    expect(governorPreflight).toHaveBeenCalledWith({ workspaceId: 'ws', loopId: 'experiment:gym' });
    expect(out.ok).toBe(false);
    expect(out.refused?.reason).toBe('unbudgeted');
  });

  it('P-041: whole-instance requires a cost-exception ack even with a signal', async () => {
    const governorPreflight = vi.fn(async () => ({ allow: true, remainingUsd: null }));
    const out = await runExperiment(
      // a genome arm — within the instance ['genome','model'] slice (an overlay arm would
      // fail the slice check upstream of the escalation gate).
      input({ testId: 'instance', tier: 'live', arms: [{ id: 'cand', knobs: { 'genome.config.wake.minSleepSec': 90 } }], escalation: { offlineSignalRunId: 'run_1' } }),
      { workspaceId: 'ws' },
      deps({ governorPreflight }),
    );
    expect(out.ok).toBe(false);
    expect(out.refused?.reason).toMatch(/gated cost-exception/i);
    expect(governorPreflight).not.toHaveBeenCalled();
  });

  it('P-063: a fully-justified + budgeted live run reaches the descriptor (gym staged-refuses without abDeps)', async () => {
    const governorPreflight = vi.fn(async () => ({ allow: true, remainingUsd: null }));
    const out = await runExperiment(
      input({ testId: 'gym', tier: 'live', payload: { tasks: [], deriveOpts: {} }, escalation: { couldntIsolate: 'needs the real coding pipeline to manifest' } }),
      { workspaceId: 'ws' },
      deps({ governorPreflight }),
    );
    // routed past tier + escalation + governor → descriptor.run, which refuses (no live abDeps).
    expect(governorPreflight).toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/STAGED/);
  });

  it('P-063: a live run delegates to the descriptor + writes the ledger when the runner returns a result', async () => {
    // Register a fake LIVE descriptor that returns a canned normalized result — proving
    // run-core routes a justified+budgeted live run through descriptor.run + the ledger.
    registerExperimentDescriptors();
    registerTest({
      id: 'fakelive',
      summary: 'fake live test',
      kind: 'component',
      fidelityTier: 'live',
      costClass: 'high',
      knobSlice: ['overlay'],
      metrics: { signals: [], rubricDimensions: [] },
      async run() {
        return {
          testId: 'fakelive',
          tier: 'live',
          baselineId: BASELINE_ID,
          arms: [{ id: BASELINE_ID, label: 'baseline', meanScore: 5, cells: 1, scored: 1, costUsd: 0.2 }],
          comparison: null,
          winner: null,
          totalCostUsd: 0.2,
          budgetExhausted: false,
        };
      },
    });
    const rows: ExperimentLedgerRow[] = [];
    const ledger: ExperimentLedger = { record: async (r) => void rows.push(r) };
    const governorPreflight = vi.fn(async () => ({ allow: true, remainingUsd: 10 }));
    const out = await runExperiment(
      input({ testId: 'fakelive', tier: 'live', escalation: { offlineSignalRunId: 'run_offline_1' }, arms: [{ id: 'cand', knobs: { 'overlay.role': 'x' } }] }),
      { workspaceId: 'ws' },
      deps({ governorPreflight, ledger }),
    );
    expect(out.ok).toBe(true);
    expect(out.result?.testId).toBe('fakelive');
    expect(out.result?.tier).toBe('live');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ testId: 'fakelive', tier: 'live', totalCostUsd: 0.2 });
  });
});

describe('runExperiment ledger write (P-050)', () => {
  it.each([false, true])('records unknown-cost arms but emits no scorecard (unknown=%s)', async (unknown) => {
    resetTestRegistry();
    _resetExperimentRegistration();
    registerExperimentDescriptors();
    registerTest({
      id: 'chargefixture', summary: 'fake governed cost boundary', kind: 'component', fidelityTier: 'live', costClass: 'high', knobSlice: ['overlay'],
      metrics: { signals: [], rubricDimensions: ['d1'], rubricRef: 'cost-fixture-quality' },
      async run() { return {
        testId: 'chargefixture', tier: 'live', baselineId: BASELINE_ID,
        arms: [{ id: BASELINE_ID, label: 'baseline', meanScore: 8, cells: 1, scored: 1, costUsd: 0.04, costMeasured: !unknown }],
        comparison: null, winner: null, totalCostUsd: 0.04, costMeasured: !unknown, budgetExhausted: false, scorecardScores: { d1: 8 },
      }; },
    });
    const rows: ExperimentLedgerRow[] = [];
    const captureScorecard = vi.fn(async () => undefined);
    const out = await runExperiment(input({ testId: 'chargefixture', tier: 'live', escalation: { offlineSignalRunId: 'fixture-offline' }, arms: [{ id: 'cand', knobs: { 'overlay.role': 'x' } }] }), { workspaceId: 'ws' }, deps({ governorPreflight: async () => ({ allow: true, remainingUsd: 1 }), ledger: { record: async (row) => { rows.push(row); } }, captureScorecard }));
    expect(out.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].arms[0].costMeasured).toBe(!unknown);
    expect(captureScorecard).toHaveBeenCalledTimes(unknown ? 0 : 1);
  });

  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('records the run-level summary row on success', async () => {
    const rows: ExperimentLedgerRow[] = [];
    const ledger: ExperimentLedger = { record: async (r) => void rows.push(r) };
    const out = await runExperiment(input(), { workspaceId: 'ws' }, deps({ ledger }));
    expect(out.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: 'ws', batteryId: 'b1', testId: 'replay', tier: 'offline', winner: 'cand' });
    expect(rows[0]!.arms.map((a) => a.id)).toEqual([BASELINE_ID, 'cand']);
  });

  it('emits a rubric-graded scorecard observation alongside a real result', async () => {
    const captured: ExperimentScorecardCapture[] = [];
    const captureScorecard: RunExperimentDeps['captureScorecard'] = async (scorecard) => {
      captured.push(scorecard);
    };
    const out = await runExperiment(input(), { workspaceId: 'ws' }, deps({ captureScorecard }));
    expect(out.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const scorecard = captured[0]!;
    expect(scorecard).toMatchObject({
      workspaceId: 'ws',
      batteryId: 'b1',
      testId: 'replay',
      tier: 'offline',
      rubricRef: 'experiment-replay-quality',
      ratings: {
        d1: { rating: 'healthy' },
        d2: { rating: 'healthy' },
        d3: { rating: 'degraded' },
      },
    });
    expect(scorecard.ratings.d1?.evidence).toContain('mean judge score 8.00/10');
  });

  it('does not fail the experiment when scorecard capture fails', async () => {
    const captureScorecard: RunExperimentDeps['captureScorecard'] = async () => {
      throw new Error('observation store down');
    };
    const out = await runExperiment(input(), { workspaceId: 'ws' }, deps({ captureScorecard }));
    expect(out.ok).toBe(true);
    expect(out.result?.winner).toBe('cand');
  });

  it('a ledger write failure never fails the run (best-effort)', async () => {
    const ledger: ExperimentLedger = { record: async () => { throw new Error('pg down'); } };
    const out = await runExperiment(input(), { workspaceId: 'ws' }, deps({ ledger }));
    expect(out.ok).toBe(true);
    expect(out.result?.winner).toBe('cand');
  });
});

describe('runExperiment dryRun (P-064)', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('returns the battery plan without calling the substrate (no spend)', async () => {
    const d = deps();
    const out = await runExperiment(
      input({
        dryRun: true,
        arms: [{ id: 'opus', knobs: { 'model.agent': 'claude-opus-4-8' } }],
        cases: [
          { caseId: 'c1', context: 'x', intent: 'y' },
          { caseId: 'c2', context: 'x', intent: 'y' },
        ],
        repeats: 3,
      }),
      { workspaceId: 'ws' },
      d,
    );
    expect(out.ok).toBe(true);
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
    expect(out.result).toBeUndefined();
    // baseline auto-prepended → 2 variants × 2 cases × 3 repeats = 12 cells.
    expect(out.plan?.totalCells).toBe(12);
    expect(out.plan?.arms.map((a) => a.id)).toEqual([BASELINE_ID, 'opus']);
    expect(out.plan?.arms.find((a) => a.id === 'opus')?.model).toBe('claude-opus-4-8');
  });

  it('still rejects an out-of-slice arm on a dryRun (validation before expansion)', async () => {
    const d = deps();
    const out = await runExperiment(
      input({ dryRun: true, arms: [{ id: 'bad', knobs: { 'genome.config.wake.x': 1 } }] }),
      { workspaceId: 'ws' },
      d,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/outside the "replay" slice/);
    expect(d.runGovernedReplay).not.toHaveBeenCalled();
  });
});
