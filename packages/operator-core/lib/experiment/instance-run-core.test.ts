import { describe, expect, it, vi } from 'vitest';
import { BASELINE_ID } from '@papercusp/eval-battery';
import type { BeekeeperConfig, BeekeeperDeps, BeekeeperResult } from '../iq-battery/beekeeper-runner';
import type { InstanceSpec } from '../instance-spec/types';
import {
  armToInstanceVariant,
  instanceResultsToExperimentResult,
  instanceRunCore,
  type InstanceExperimentRequest,
  type InstanceVariant,
} from './instance-run-core';

const baseSpec = (): InstanceSpec => ({
  specVersion: 1,
  blueprintRef: { id: 'coding-factory' },
  repoSha: 'sha123',
  deploymentConfig: {} as InstanceSpec['deploymentConfig'],
  genome: { prompts: {}, config: {} },
});

function cannedResult(instanceId: string, meanComposite: number, status: 'scored' | 'errored' = 'scored'): BeekeeperResult {
  return {
    instanceId,
    outcomes: [
      {
        caseId: 'c1',
        caseVariant: 'v0',
        repeat: 0,
        runId: `${instanceId}-r0`,
        instanceId,
        outcome: 'completed',
        d1: meanComposite,
        d2: meanComposite,
        d3: meanComposite,
        composite: meanComposite,
        costUsd: 0.1,
        judgeUsd: 0.05,
        status,
      },
    ],
    totalCases: 1,
    passedCases: status === 'scored' ? 1 : 0,
    meanComposite,
    rubricHash: 'rh',
  };
}

const req = (over: Partial<InstanceExperimentRequest> = {}): InstanceExperimentRequest => ({
  batteryId: 'b1',
  arms: [{ id: 'cand', knobs: { 'genome.config.wake.minSleepSec': 90 } }],
  payload: { baseSpec: baseSpec(), corpus: [{ id: 'c1' }] as unknown as BeekeeperConfig['corpus'], rubric: {} as BeekeeperConfig['rubric'] },
  repeats: 1,
  ...over,
});

describe('armToInstanceVariant', () => {
  it('empty-knobs arm → the unmodified base spec, no modelOverrides', () => {
    const v = armToInstanceVariant(baseSpec(), { id: BASELINE_ID, knobs: {} }, { workspaceId: 'ws', instanceUrl: 'u' });
    expect(v.armId).toBe(BASELINE_ID);
    expect(v.bootSpec.modelOverrides).toBeUndefined();
    expect(v.bootSpec.manifest.codeSha).toBe('sha123');
  });

  it('a genome.* knob varies the genome (a genomeId appears)', () => {
    const v = armToInstanceVariant(baseSpec(), { id: 'g', knobs: { 'genome.config.wake.minSleepSec': 90 } }, { workspaceId: 'ws', instanceUrl: 'u' });
    expect(v.bootSpec.manifest.genomeId).toBeDefined();
  });

  it('a model.<role> knob becomes the boot spec spawn-time modelOverrides (NOT a genome change)', () => {
    const v = armToInstanceVariant(baseSpec(), { id: 'm', knobs: { 'model.worker': 'claude-opus-4-8' } }, { workspaceId: 'ws', instanceUrl: 'u' });
    expect(v.bootSpec.modelOverrides).toEqual({ worker: 'claude-opus-4-8' });
    // model is not a genome axis → no genomeId from a model-only arm
    expect(v.bootSpec.manifest.genomeId).toBeUndefined();
  });
});

describe('instanceResultsToExperimentResult', () => {
  it('retains measured failure spend and withholds a winner on unknown charges', () => {
    const result = cannedResult('baseline', 8);
    result.costMeasured = false;
    result.outcomes[0].judgeCostMeasured = false;
    const out = instanceResultsToExperimentResult([{ variant: { armId: BASELINE_ID, label: 'baseline', bootSpec: {} as InstanceVariant['bootSpec'] }, result }]);
    expect(out.totalCostUsd).toBeCloseTo(0.15);
    expect(out.costMeasured).toBe(false);
    expect(out.arms[0].costMeasured).toBe(false);
    expect(out.winner).toBeNull();
    expect(Object.values(out.scorecardScores!)).toEqual([null, null, null, null]);
  });

  it('maps per-arm results → mean composite + compareArms verdict', () => {
    const mk = (armId: string, mean: number): { variant: InstanceVariant; result: BeekeeperResult } => ({
      variant: { armId, label: armId, bootSpec: { manifest: { instanceId: armId } } as InstanceVariant['bootSpec'] },
      result: cannedResult(armId, mean),
    });
    const out = instanceResultsToExperimentResult([mk(BASELINE_ID, 5), mk('cand', 7)]);
    expect(out.testId).toBe('instance');
    expect(out.tier).toBe('live');
    expect(out.arms.map((a) => a.meanScore)).toEqual([5, 7]);
    expect(out.winner).toBe('cand');
    // cost = (0.1+0.05) per arm × 2 arms
    expect(out.totalCostUsd).toBeCloseTo(0.3, 5);
  });
});

describe('instanceRunCore', () => {
  it('stops before booting another arm after an unmeasured judge charge', async () => {
    const runBeekeeperBattery = vi.fn(async () => ({ ...cannedResult('unknown', 0, 'errored'), costMeasured: false }));
    const out = await instanceRunCore(req(), { workspaceId: 'ws', deps: {} as BeekeeperDeps }, { runBeekeeperBattery });
    expect(runBeekeeperBattery).toHaveBeenCalledTimes(1);
    expect(out.costMeasured).toBe(false);
    expect(out.winner).toBeNull();
  });

  it('refuses (staged) with NO spend when ctx.instance.deps is absent', async () => {
    const runBeekeeperBattery = vi.fn();
    await expect(instanceRunCore(req(), { workspaceId: 'ws' }, { runBeekeeperBattery })).rejects.toThrow(
      /STAGED until the owner arms it/,
    );
    expect(runBeekeeperBattery).not.toHaveBeenCalled();
  });

  it('delegates one battery PER ARM and normalizes (baseline auto-prepended)', async () => {
    const runBeekeeperBattery = vi.fn(async (config: BeekeeperConfig) => {
      const id = config.instanceSpec.manifest.instanceId;
      return cannedResult(id, id === BASELINE_ID ? 5 : 8);
    });
    const out = await instanceRunCore(req(), { workspaceId: 'ws', deps: {} as BeekeeperDeps }, { runBeekeeperBattery });
    // one battery per arm: baseline (auto-prepended) + cand
    expect(runBeekeeperBattery).toHaveBeenCalledTimes(2);
    expect(out.arms.map((a) => a.id)).toEqual([BASELINE_ID, 'cand']);
    expect(out.winner).toBe('cand');
  });

  it('rejects a missing baseSpec / corpus before spend', async () => {
    await expect(
      instanceRunCore(req({ payload: { baseSpec: baseSpec(), corpus: [] as unknown as BeekeeperConfig['corpus'], rubric: {} as BeekeeperConfig['rubric'] } }), { workspaceId: 'ws', deps: {} as BeekeeperDeps }, { runBeekeeperBattery: vi.fn() }),
    ).rejects.toThrow(/corpus/);
  });
});
