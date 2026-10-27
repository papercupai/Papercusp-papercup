import { describe, expect, it } from 'vitest';
import { fitHybridRelevance, hybridFeatures, hybridRelevance, SEMANTIC_HYBRID_MODEL } from './semantic-code-calibration';
import measuredTraining from './__fixtures__/semantic-hybrid-trained-v1.json';
import training from './__fixtures__/semantic-hybrid-training-v1.json';
import evaluation from './__fixtures__/semantic-calibration-v1.json';
import { extractSemanticFunctions } from './semantic-code';

describe('pointwise semantic hybrid calibration', () => {
  it('uses the weights frozen from the separately measured training receipt without runtime fitting', () => {
    expect(SEMANTIC_HYBRID_MODEL.weights).toEqual(measuredTraining.weights);
    expect(SEMANTIC_HYBRID_MODEL.profile).toBe(measuredTraining.profile);
    expect(SEMANTIC_HYBRID_MODEL.dimensions).toBe(measuredTraining.dimensions);
    expect(SEMANTIC_HYBRID_MODEL.dtype).toBe(measuredTraining.scorer.rerankExecution.dtype);
    expect(SEMANTIC_HYBRID_MODEL.device).toBe(measuredTraining.scorer.rerankExecution.device);
  });
  it('normalizes a query population without using paths, labels or a best-result shortcut', () => {
    const features = hybridFeatures([.8, .8, .2, .2], [.9, .9, .1, .1]);
    features.forEach((row, i) => expect(row[1]).toBeCloseTo(i < 2 ? 1 : -1, 12));
    expect(hybridFeatures([.5, .5], [.8, .8]).map(row => row[1])).toEqual([0, 0]);
    const weights = [0, 0, 2, 1] as const;
    expect(features.map(row => hybridRelevance(weights, row) >= .70)).toEqual([true, true, false, false]);
  });
  it('fits a fixed deterministic pointwise separator with multiple acceptable results', () => {
    const features = hybridFeatures([.8, .8, .2, .2], [.9, .9, .1, .1]);
    const rows = features.map((row, i) => ({ features: row, relevant: i < 2 }));
    const weights = fitHybridRelevance(rows);
    expect(fitHybridRelevance(rows)).toEqual(weights);
    expect(features.map(row => hybridRelevance(weights, row) >= .70)).toEqual([true, true, false, false]);
  });
  it('rejects unmeasured and invalid populations instead of creating calibrated-looking evidence', () => {
    expect(() => hybridFeatures([NaN], [.8])).toThrow();
    expect(() => hybridFeatures([.8], [])).toThrow();
    expect(() => hybridFeatures([.8], [1.1])).toThrow();
    expect(() => fitHybridRelevance([])).toThrow();
    expect(() => hybridRelevance([NaN, 0, 0, 0], [1, 1, 1])).toThrow();
  });
  it('keeps training sources, queries and identities disjoint from the unchanged evaluation sample', () => {
    expect(training.samples).toHaveLength(20);
    for (const sample of training.samples) {
      expect(evaluation.samples.some(row => row.query === sample.query || row.source === sample.source || row.id === sample.id)).toBe(false);
      expect(extractSemanticFunctions({ path: `src/${sample.id}.ts`, source: sample.source })).toHaveLength(1);
    }
    expect(training.preregisteredAlgorithm.cutoff).toBe(evaluation.retrievalCutoff);
    expect(training.preregisteredAlgorithm.topK).toBe(evaluation.topK);
  });
});
