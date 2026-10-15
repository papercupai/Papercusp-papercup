import { describe, expect, it, vi } from 'vitest';
import { BASELINE_ID } from '@papercusp/eval-battery';
import type { AbConfig, AbDeps, AbResult } from '../gym/ab-runner';
import { abResultToExperimentResult, armToAbVariant, gymRunCore, type GymExperimentRequest } from './gym-run-core';

const fakeAbResult = (): AbResult => ({
  outcomes: [
    { variantId: BASELINE_ID, taskId: 't1', repeat: 0, runId: 'r0', harnessSlug: 'h', outcome: 'done', d1: 6, d2: 6, d3: 6, composite: 6, pipelineUsd: 0.1, judgeUsd: 0.1, status: 'scored' },
    { variantId: 'cand', taskId: 't1', repeat: 0, runId: 'r1', harnessSlug: 'h', outcome: 'done', d1: 8, d2: 8, d3: 8, composite: 8, pipelineUsd: 0.1, judgeUsd: 0.1, status: 'scored' },
  ],
  perTaskVariance: [],
  cost: { totalUsd: 0.4, meanRunUsd: 0.2, perVariant: { [BASELINE_ID]: 0.2, cand: 0.2 } },
  comparison: [],
  rubricHash: 'rh',
});

const req = (over: Partial<GymExperimentRequest> = {}): GymExperimentRequest => ({
  batteryId: 'b1',
  arms: [{ id: 'cand', knobs: { 'overlay.worker': 'be terse', 'model.validator': 'claude-haiku-4-5-20251001' } }],
  payload: {
    tasks: [{ taskId: 't1', pool: 'p', repoUrl: 'u', repoCommit: 'c', spec: 's', intent: 'i', projectContext: 'pc' }],
    deriveOpts: {} as never,
  },
  repeats: 1,
  ...over,
});

describe('armToAbVariant', () => {
  it('maps overlay.<role> → promptOverrides and model.<role> → models', () => {
    const v = armToAbVariant({ id: 'cand', knobs: { 'overlay.worker': 'be terse', 'model.validator': 'claude-haiku-4-5-20251001' } });
    expect(v.variantId).toBe('cand');
    expect(v.overlay.promptOverrides).toEqual({ worker: 'be terse' });
    expect(v.overlay.models).toEqual({ validator: 'claude-haiku-4-5-20251001' });
  });
});

describe('abResultToExperimentResult', () => {
  it('withholds winner and scorecard for an unmeasured charge even when scores favor the candidate', () => {
    const result = fakeAbResult();
    result.cost.costMeasured = false;
    result.outcomes[1].judgeCostMeasured = false;
    const out = abResultToExperimentResult(result, [{ variantId: BASELINE_ID, label: 'baseline', overlay: { promptOverrides: {} } }, { variantId: 'cand', label: 'cand', overlay: { promptOverrides: {} } }]);
    expect(out.costMeasured).toBe(false);
    expect(out.arms[1].costMeasured).toBe(false);
    expect(out.winner).toBeNull();
    expect(out.comparison).toBeNull();
    expect(Object.values(out.scorecardScores!)).toEqual([null, null, null]);
  });

  it('computes per-variant means + the compareArms winner', () => {
    const out = abResultToExperimentResult(fakeAbResult(), [
      { variantId: BASELINE_ID, label: 'baseline', overlay: { promptOverrides: {} } },
      { variantId: 'cand', label: 'cand', overlay: { promptOverrides: {} } },
    ]);
    expect(out.testId).toBe('gym');
    expect(out.tier).toBe('live');
    expect(out.arms.map((a) => a.meanScore)).toEqual([6, 8]);
    expect(out.winner).toBe('cand');
    expect(out.totalCostUsd).toBe(0.4);
  });
});

describe('gymRunCore', () => {
  it('STAGED without live abDeps — refuses with a clear message (no spend)', async () => {
    await expect(gymRunCore(req(), { workspaceId: 'ws' })).rejects.toThrow(/STAGED until the owner arms it/);
  });

  it('with abDeps: maps arms→variants + tasks→config and delegates to runAbEvaluation', async () => {
    const runAbEvaluation = vi.fn(async (_c: AbConfig) => fakeAbResult());
    const out = await gymRunCore(req(), { workspaceId: 'ws', abDeps: {} as AbDeps }, { runAbEvaluation });
    const cfg = runAbEvaluation.mock.calls[0]![0];
    expect(cfg.variants[0]!.variantId).toBe(BASELINE_ID); // baseline auto-prepended
    expect(cfg.variants[1]).toMatchObject({ variantId: 'cand', overlay: { promptOverrides: { worker: 'be terse' } } });
    expect(cfg.tasks).toHaveLength(1);
    expect(cfg.workspaceId).toBe('ws');
    expect(out.winner).toBe('cand');
  });
});
