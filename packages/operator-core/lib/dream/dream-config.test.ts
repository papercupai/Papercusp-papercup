import { describe, expect, it } from 'vitest';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';
import {
  DEFAULT_DREAM_CYCLE_CONFIG,
  DEFAULT_DREAM_PASS_CONFIG,
  DEFAULT_DREAM_REVIEW_CONFIG,
  DEFAULT_DREAM_SAMPLER_CONFIG,
  DREAM_FRAGMENT_KINDS,
  dreamReviewOutcome,
  dreamRunOutcome,
  resolveDreamPassConfig,
  resolveDreamCycleConfig,
  resolveDreamReviewConfig,
  resolveDreamSamplerConfig,
} from './dream-config';

describe('scientific outcomes from immutable Dream history', () => {
  it.each([
    ['counterfactual-unknown', 'unverified', 'insufficient evidence'],
    ['source-unavailable', 'unverified', 'insufficient evidence'],
    ['rerank-unavailable', 'unavailable', 'review unavailable'],
    ['review-unavailable', 'unavailable', 'review unavailable'],
  ])('keeps %s separate from rejection', (reason, outcome, label) => {
    const run = { status: 'rejected', review: { verdict: 'unverified', reason } };
    expect(dreamReviewOutcome(run.review)).toBe(outcome);
    expect(dreamRunOutcome(run.status, run.review)).toBe(label);
    expect(run.status).toBe('rejected');
  });
  it('preserves substantive rejection, missing review and execution failure', () => {
    expect(dreamReviewOutcome({ verdict: 'reject', reason: 'one-unit-only' })).toBe('rejected');
    expect(dreamReviewOutcome({ verdict: 'reject', reason: 'duplicate' })).toBe('duplicate');
    expect(dreamReviewOutcome(null)).toBe('not-reviewed');
    expect(dreamRunOutcome('error', { verdict: 'accept' })).toBe('error');
  });
});

describe('resolveDreamCycleConfig', () => {
  it('ships bounded manual-first cycle defaults without enabling automatic dreaming', () => {
    expect(DEFAULT_DREAM_CYCLE_CONFIG).toEqual({
      maxDreamsPerCycle: 3,
      maxCostUsd: 1,
      rolling24hCostUsd: 5,
      timeoutMs: 10 * 60_000,
      autoIdleRatioFloor: 0.5,
    });
  });

  it('merges overrides without mutating the defaults', () => {
    expect(resolveDreamCycleConfig({ maxDreamsPerCycle: 1, maxCostUsd: 0.25 })).toMatchObject({
      maxDreamsPerCycle: 1,
      maxCostUsd: 0.25,
    });
    expect(DEFAULT_DREAM_CYCLE_CONFIG.maxDreamsPerCycle).toBe(3);
  });

  it.each([
    [{ maxDreamsPerCycle: 0 }, 'maxDreamsPerCycle'],
    [{ maxDreamsPerCycle: 4 }, 'maxDreamsPerCycle'],
    [{ maxCostUsd: -0.01 }, 'maxCostUsd'],
    [{ maxCostUsd: Number.POSITIVE_INFINITY }, 'maxCostUsd'],
    [{ maxCostUsd: Number.NaN }, 'maxCostUsd'],
    [{ rolling24hCostUsd: -1 }, 'rolling24hCostUsd'],
    [{ rolling24hCostUsd: Number.POSITIVE_INFINITY }, 'rolling24hCostUsd'],
    [{ rolling24hCostUsd: Number.NaN }, 'rolling24hCostUsd'],
    [{ timeoutMs: 1.5 }, 'timeoutMs'],
    [{ autoIdleRatioFloor: 1.1 }, 'autoIdleRatioFloor'],
  ] as const)('rejects invalid cycle config %o', (override, message) => {
    expect(() => resolveDreamCycleConfig(override)).toThrow(message);
  });

  it('accepts explicitly configured monetary caps above defaults and preserves zero as a stop', () => {
    expect(resolveDreamCycleConfig({ maxCostUsd: 10, rolling24hCostUsd: 200 })).toMatchObject({
      maxCostUsd: 10,
      rolling24hCostUsd: 200,
      maxDreamsPerCycle: 3,
    });
    expect(resolveDreamCycleConfig({ maxCostUsd: 0, rolling24hCostUsd: 0 })).toMatchObject({
      maxCostUsd: 0,
      rolling24hCostUsd: 0,
    });
    expect(resolveDreamCycleConfig()).toEqual(DEFAULT_DREAM_CYCLE_CONFIG);
  });
});

describe('resolveDreamSamplerConfig', () => {
  it('ships the manual-cycle sampler defaults from the REM design', () => {
    expect(DREAM_FRAGMENT_KINDS).toEqual(['observation', 'work_item', 'memory', 'stat']);
    expect(DEFAULT_DREAM_SAMPLER_CONFIG).toMatchObject({
      recentWindowMs: 48 * 60 * 60 * 1_000,
      remoteMinAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxTextChars: 1_200,
      randomPartnerRate: 0.15,
    });
  });

  it('merges an override without mutating the defaults', () => {
    const resolved = resolveDreamSamplerConfig({ maxFragmentsPerKind: 8 });

    expect(resolved.maxFragmentsPerKind).toBe(8);
    expect(DEFAULT_DREAM_SAMPLER_CONFIG.maxFragmentsPerKind).toBe(64);
  });

  it.each([
    [{ recentWindowMs: 0 }, 'recentWindowMs'],
    [{ remoteMinAgeMs: 1 }, 'remoteMinAgeMs'],
    [{ maxTextChars: 1.5 }, 'maxTextChars'],
    [{ randomPartnerRate: 1.1 }, 'randomPartnerRate'],
    [{ minSimilarity: 0.9, maxSimilarity: 0.8 }, 'minSimilarity'],
  ] as const)('rejects invalid config %o', (override, message) => {
    expect(() => resolveDreamSamplerConfig(override)).toThrow(message);
  });
});

describe('resolveDreamPassConfig', () => {
  it('uses the bounded defaults on the canonical learning model', () => {
    // Owner-directed [owner 2026-09-30, directive #1111]: the dreamer moved off
    // the REM design's cheap Haiku model onto the canonical learning spec.
    expect(DEFAULT_DREAM_PASS_CONFIG).toEqual({
      model: LEARNING_MODEL_SPEC,
      maxInsightChars: 600,
      maxOutputTokens: 1_024,
      timeoutMs: 60_000,
    });
  });

  it('trims a model override without mutating the defaults', () => {
    expect(resolveDreamPassConfig({ model: ' custom-model ' }).model).toBe('custom-model');
    expect(DEFAULT_DREAM_PASS_CONFIG.model).toBe(LEARNING_MODEL_SPEC);
  });

  it.each([
    [{ model: '   ' }, 'model'],
    [{ maxInsightChars: 0 }, 'maxInsightChars'],
    [{ maxOutputTokens: 1.5 }, 'maxOutputTokens'],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, 'timeoutMs'],
  ] as const)('rejects invalid pass config %o', (override, message) => {
    expect(() => resolveDreamPassConfig(override)).toThrow(message);
  });
});

describe('resolveDreamReviewConfig', () => {
  it('uses the canonical learning model with a stricter review rubric', () => {
    expect(DEFAULT_DREAM_REVIEW_CONFIG).toEqual({
      model: LEARNING_MODEL_SPEC,
      duplicateSimilarityThreshold: 0.85,
      minTotalScore: 5,
      maxNoteChars: 600,
      maxOutputTokens: 1_024,
      timeoutMs: 180_000,
    });
    // Owner-directed [owner 2026-09-30, directive #1111]: dreamer and reviewer
    // now share the canonical learning model; the review stays stricter by
    // threshold and prompt, not by model.
    expect(DEFAULT_DREAM_REVIEW_CONFIG.model).toBe(DEFAULT_DREAM_PASS_CONFIG.model);
  });

  it('trims overrides without mutating the defaults', () => {
    expect(resolveDreamReviewConfig({ model: ' reviewer-model ', minTotalScore: 6 })).toMatchObject({
      model: 'reviewer-model',
      minTotalScore: 6,
    });
    expect(DEFAULT_DREAM_REVIEW_CONFIG.minTotalScore).toBe(5);
  });

  it.each([
    [{ model: '   ' }, 'model'],
    [{ duplicateSimilarityThreshold: 0 }, 'duplicateSimilarityThreshold'],
    [{ duplicateSimilarityThreshold: 1.1 }, 'duplicateSimilarityThreshold'],
    [{ minTotalScore: 7 }, 'minTotalScore'],
    [{ maxNoteChars: 0 }, 'maxNoteChars'],
    [{ maxOutputTokens: 1.5 }, 'maxOutputTokens'],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, 'timeoutMs'],
  ] as const)('rejects invalid review config %o', (override, message) => {
    expect(() => resolveDreamReviewConfig(override)).toThrow(message);
  });
});
