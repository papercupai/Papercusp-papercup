import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_ID, listTests, resetTestRegistry, type JudgeLlmCall } from '@papercusp/eval-battery';
import type { ReplayBatteryConfig, ReplayBatteryResult } from '../replay/battery';
import type { ReplayCase, ReplayRunner } from '../replay/types';
import {
  _resetExperimentRegistration,
  armToReplayVariant,
  gymDescriptor,
  hiveDescriptor,
  instanceDescriptor,
  registerExperimentDescriptors,
  replayDescriptor,
} from './descriptors';
import type { ExperimentRequest, ExperimentRunCtx } from './types';

const historicalCase: ReplayCase = {
  kind: 'synthetic',
  caseId: 'c1',
  context: 'conversation so far …',
  intent: 'do the task',
};

function cannedResult(): ReplayBatteryResult {
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
      { variantId: 'cand', label: 'terser policy', cells: 1, scored: 1, meanComposite: 7, meanTokenJaccard: 0.4, costUsd: 0.01 },
    ],
    comparison: {
      primaryScorer: 'composite',
      baseline: { variantId: BASELINE_ID, metrics: { composite: 5 } },
      candidates: [],
      selected: 'cand',
      selectionReason: 'composite +2.0 ≥ minDelta',
    },
    totalCostUsd: 0.01,
    rubricHash: 'rh',
    budgetExhausted: false,
  };
}

const fakeCtx = (): ExperimentRunCtx => ({
  workspaceId: 'ws',
  now: () => 0,
  llmCall: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as unknown as JudgeLlmCall,
  replayRunner: (async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true })) as unknown as ReplayRunner,
});

describe('descriptor metadata + catalog', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('registers the four Subjects with complete catalog metadata in id order', () => {
    registerExperimentDescriptors();
    const entries = listTests();
    expect(entries.map((e) => e.id)).toEqual(['gym', 'hive', 'instance', 'replay']);
    const replay = entries.find((e) => e.id === 'replay')!;
    expect(replay).toMatchObject({ kind: 'replay', fidelityTier: 'offline', costClass: 'free' });
    expect(replay.knobSlice).toEqual(['overlay.systemOverlay', 'overlay.systemReplace', 'model']);
    expect(replay.metrics.rubricRef).toBe('experiment-replay-quality');
    expect(entries.find((e) => e.id === 'gym')!.metrics.rubricRef).toBe('experiment-component-quality');
    expect(entries.find((e) => e.id === 'hive')!.metrics.rubricRef).toBe('experiment-hive-quality');
    expect(listTests().find((e) => e.id === 'instance')!.knobSlice).toEqual(['genome', 'model']);
    expect(listTests().find((e) => e.id === 'instance')!.metrics.rubricRef).toBe('experiment-instance-quality');
  });

  it('registerExperimentDescriptors is idempotent (no duplicate-id throw)', () => {
    registerExperimentDescriptors();
    expect(() => registerExperimentDescriptors()).not.toThrow();
    expect(listTests()).toHaveLength(4);
  });
});

describe('replay descriptor.run', () => {
  it('maps arms→variants (empty arm = baseline), delegates, and normalizes the result', async () => {
    const runReplayBattery = vi.fn(async (_c: ReplayBatteryConfig) => cannedResult());
    const desc = replayDescriptor({ runReplayBattery });
    const request: ExperimentRequest = {
      batteryId: 'b1',
      arms: [
        { id: BASELINE_ID, knobs: {} },
        { id: 'cand', label: 'terser policy', knobs: { 'overlay.systemOverlay': 'Be terse.' } },
      ],
      repeats: 1,
      payload: { cases: [historicalCase] },
    };

    const out = await desc.run(request, fakeCtx());

    // delegated config: the baseline arm became the historical-baseline variant, the
    // candidate carried its overlay into policy.systemOverlay.
    const cfg = runReplayBattery.mock.calls[0]![0];
    expect(cfg.variants[0]!.variantId).toBe(BASELINE_ID);
    expect(cfg.variants[1]).toMatchObject({ variantId: 'cand', policy: { systemOverlay: 'Be terse.' } });
    expect(cfg.cases).toHaveLength(1);

    // normalized result
    expect(out.testId).toBe('replay');
    expect(out.tier).toBe('offline');
    expect(out.winner).toBe('cand');
    expect(out.arms.map((a) => a.meanScore)).toEqual([5, 7]);
    expect(out.totalCostUsd).toBe(0.01);
    expect(out.scorecardScores).toEqual({ d1: 8, d2: 7, d3: 6 });
  });

  it('maps a model knob to the variant policy.model (model-per-arm, P-063)', async () => {
    const runReplayBattery = vi.fn(async (_c: ReplayBatteryConfig) => cannedResult());
    const desc = replayDescriptor({ runReplayBattery });
    await desc.run(
      {
        batteryId: 'b1',
        arms: [{ id: 'opus', knobs: { 'model.agent': 'claude-opus-4-8' } }],
        repeats: 1,
        payload: { cases: [historicalCase] },
      },
      fakeCtx(),
    );
    const cfg = runReplayBattery.mock.calls[0]![0];
    expect(cfg.variants.find((v) => v.variantId === 'opus')?.policy.model).toBe('claude-opus-4-8');
  });

  it('rejects an arm whose knob is outside the replay slice', async () => {
    const desc = replayDescriptor({ runReplayBattery: vi.fn(async () => cannedResult()) });
    const request: ExperimentRequest = {
      batteryId: 'b1',
      arms: [{ id: 'bad', knobs: { 'genome.config.wake.minSleepSec': 30 } }],
      repeats: 1,
      payload: { cases: [historicalCase] },
    };
    await expect(desc.run(request, fakeCtx())).rejects.toThrow(/outside its slice: genome.config.wake.minSleepSec/);
  });

  it('rejects a safety-excluded knob even within a payload', async () => {
    const desc = replayDescriptor({ runReplayBattery: vi.fn(async () => cannedResult()) });
    const request: ExperimentRequest = {
      batteryId: 'b1',
      arms: [{ id: 'evil', knobs: { 'budget.cap': 0 } }],
      repeats: 1,
      payload: { cases: [historicalCase] },
    };
    await expect(desc.run(request, fakeCtx())).rejects.toThrow(/safety-excluded/);
  });
});

describe('armToReplayVariant — arm→ReplayVariant mapping (G6/G15)', () => {
  // G6a: systemReplace flows to policy.systemReplace (the WHOLE-prompt swap), and is
  // distinct from systemOverlay (the append) — only systemOverlay was tested before.
  it('maps overlay.systemReplace to policy.systemReplace (not systemOverlay)', () => {
    const v = armToReplayVariant({ id: 'replace', knobs: { 'overlay.systemReplace': 'You are X.' } });
    expect(v.policy.systemReplace).toBe('You are X.');
    expect(v.policy.systemOverlay).toBeUndefined();
  });

  it('keeps systemReplace and systemOverlay independent when both are set', () => {
    const v = armToReplayVariant({
      id: 'both',
      knobs: { 'overlay.systemReplace': 'You are X.', 'overlay.systemOverlay': 'Be terse.' },
    });
    expect(v.policy.systemReplace).toBe('You are X.');
    expect(v.policy.systemOverlay).toBe('Be terse.');
  });

  // G6b: PIN the iteration-order-dependent SILENT pick. Replay has one agent, so the
  // FIRST model.<role> knob (by Object.values insertion order) becomes the continuation
  // model — model.b is silently dropped. See report: this is a latent correctness trap.
  it('PINS the silent first-model pick when an arm gives multiple model.<role> knobs', () => {
    const v = armToReplayVariant({ id: 'multi', knobs: { 'model.a': 'm1', 'model.b': 'm2' } });
    // Insertion order → 'm1' wins; 'm2' is silently discarded (no error, no warning).
    expect(v.policy.model).toBe('m1');
  });

  // G15: an empty-knobs arm returns REPLAY_BASELINE_VARIANT regardless of its authored
  // id — the author's id is LOST (replaced by BASELINE_ID). PIN this.
  it('PINS empty-knobs arm → BASELINE_ID variant, dropping the authored id', () => {
    const v = armToReplayVariant({ id: 'control', knobs: {} });
    expect(v.variantId).toBe(BASELINE_ID);
    expect(v.variantId).not.toBe('control'); // authored id is discarded
  });

  // G15 follow-on: two distinct empty-knobs arms COLLIDE on the same variantId — both
  // become BASELINE_ID. FLAG: a battery with two no-op arms would lose one to dedup.
  it('FLAGS that two empty-knobs arms collide on the same variantId (BASELINE_ID)', () => {
    const a = armToReplayVariant({ id: 'control-a', knobs: {} });
    const b = armToReplayVariant({ id: 'control-b', knobs: {} });
    expect(a.variantId).toBe(BASELINE_ID);
    expect(b.variantId).toBe(BASELINE_ID);
    expect(a.variantId).toBe(b.variantId); // collision — distinct authored arms, one id
  });

  it('preserves the authored id + label for a non-empty arm', () => {
    const v = armToReplayVariant({ id: 'cand', label: 'terser', knobs: { 'overlay.systemOverlay': 'Be terse.' } });
    expect(v.variantId).toBe('cand');
    expect(v.label).toBe('terser');
  });
});

describe('staged live-tier descriptors', () => {
  it('gym is mapped + wired but STAGED without live abDeps (no spend)', async () => {
    const request: ExperimentRequest = { batteryId: 'b1', arms: [], repeats: 1, payload: { tasks: [], deriveOpts: {} } };
    await expect(gymDescriptor().run(request, fakeCtx())).rejects.toThrow(/STAGED until the owner arms it/);
  });

  it('instance + hive are bound but STAGED without live deps (no spend), pointing at their ctx dep slot (P-063)', async () => {
    const request: ExperimentRequest = { batteryId: 'b1', arms: [], repeats: 1, payload: {} };
    await expect(instanceDescriptor().run(request, fakeCtx())).rejects.toThrow(/STAGED until the owner arms it/);
    await expect(instanceDescriptor().run(request, fakeCtx())).rejects.toThrow(/ctx\.instance\.deps/);
    await expect(hiveDescriptor().run(request, fakeCtx())).rejects.toThrow(/STAGED until the owner arms it/);
    await expect(hiveDescriptor().run(request, fakeCtx())).rejects.toThrow(/ctx\.hive\.ports/);
  });

  it('instance/hive validate the genome+model slice before delegating (P-063)', async () => {
    // an out-of-slice knob (overlay.* is not in their ['genome','model'] slice) → slice error
    const badSlice: ExperimentRequest = { batteryId: 'b1', arms: [{ id: 'bad', knobs: { 'overlay.queen': 'x' } }], repeats: 1, payload: {} };
    await expect(instanceDescriptor().run(badSlice, fakeCtx())).rejects.toThrow(/outside its slice/);

    // a safety-excluded knob → safety error (defense in depth)
    const evil: ExperimentRequest = { batteryId: 'b1', arms: [{ id: 'evil', knobs: { 'budget.cap': 0 } }], repeats: 1, payload: {} };
    await expect(hiveDescriptor().run(evil, fakeCtx())).rejects.toThrow(/safety-excluded/);

    // a VALID genome+model arm passes the slice gate → delegates to the run-core, which
    // refuses (staged) because fakeCtx supplies no live deps — proving the genome.* + model.<role>
    // axes are accepted and the binding is reached.
    const good: ExperimentRequest = {
      batteryId: 'b1',
      arms: [{ id: 'g', knobs: { 'genome.config.wake.minSleepSec': 90, 'model.queen': 'claude-opus-4-8' } }],
      repeats: 1,
      payload: {},
    };
    await expect(instanceDescriptor().run(good, fakeCtx())).rejects.toThrow(/STAGED until the owner arms it/);
  });
});
