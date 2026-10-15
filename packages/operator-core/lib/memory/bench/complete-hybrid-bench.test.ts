import { describe, expect, it } from 'vitest';
import { MEMORY_VECTOR_STORAGE_PROFILES } from '@papercusp/memory';
import { pushSearchFloors } from '../push-search-floors';
import {
  BENCH_SCOPE, BENCH_SECOND_SCOPE, LEAK_PREFIX, ROUTES,
  armBinding, armStorageMode, routeOptions, scoreRoute, summarizeRoute,
} from './complete-hybrid-bench';

const embed = async () => [];

describe('complete-hybrid-bench arm binding', () => {
  it('binds incumbents through their PRODUCTION profile with no candidate override', () => {
    for (const model of ['gemma', 'harrier'] as const) {
      const { resolved, candidateStorage } = armBinding(model, 'bench_memory_1', embed);
      expect(resolved.mode).toBe(model);
      expect(candidateStorage).toBeUndefined();
      expect(MEMORY_VECTOR_STORAGE_PROFILES[model].acceptedProfileIds as readonly string[]).toContain(resolved.profile.profileId);
    }
  });

  it('binds mDenseOn only via a schema-scoped candidate override on the 768-d layout, never the gemma profile', () => {
    const { resolved, candidateStorage } = armBinding('mdenseon', 'bench_memory_9', embed);
    expect(armStorageMode('mdenseon')).toBe('gemma');
    expect(resolved.profile.profileId).toMatch(/^mdenseon-/);
    expect(resolved.dims).toBe(MEMORY_VECTOR_STORAGE_PROFILES.gemma.dimensions);
    expect(candidateStorage).toEqual({ schema: 'bench_memory_9', acceptedProfileIds: { gemma: [resolved.profile.profileId] } });
  });
});

describe('complete-hybrid-bench routes', () => {
  it('pull uses memory:search defaults on the single bench scope (entity-boosted mem0 search)', () => {
    expect(routeOptions('pull', 0.5)).toEqual({ scope: BENCH_SCOPE, limit: 10 });
  });

  it('push replays the shipped injection floors over multiple scopes; push-calibrated swaps only the cosine floor', () => {
    const push = routeOptions('push', 0.31);
    expect(push).toMatchObject({ ...pushSearchFloors(), scope: [BENCH_SCOPE, BENCH_SECOND_SCOPE] });
    const calibrated = routeOptions('push-calibrated', 0.31);
    expect(calibrated).toEqual({ ...push, minScore: 0.31 });
    expect(routeOptions('raw', 0.31)).toEqual({ scope: BENCH_SCOPE, limit: 10, minScore: 0, fusionMode: 'floored-union' });
    expect(ROUTES).toEqual(['pull', 'push', 'push-calibrated', 'raw']);
  });
});

describe('complete-hybrid-bench scoring', () => {
  it('scores positives by rank/precision and flags leak-scope keys', () => {
    const row = scoreRoute(['a'], ['x', 'a', `${LEAK_PREFIX}a`]);
    expect(row.reciprocalRank).toBe(0.5);
    expect(row.precision).toBeCloseTo(1 / 3);
    expect(row.admittedNegative).toBeNull();
    expect(row.leakedKeys).toEqual([`${LEAK_PREFIX}a`]);
  });

  it('treats a no-target query as a negative: any hit is a false admission; empty is a rejection', () => {
    expect(scoreRoute([], ['x']).admittedNegative).toBe(true);
    expect(scoreRoute([], []).admittedNegative).toBe(false);
    expect(scoreRoute(['a'], []).precision).toBeNull();
  });

  it('summarizes MRR/recall over positives, precision over non-empty positives, admission over negatives', () => {
    const s = summarizeRoute([scoreRoute(['a'], ['a']), scoreRoute(['b'], []), scoreRoute([], ['z']), scoreRoute([], [])]);
    expect(s).toMatchObject({ queries: 4, positives: 2, negatives: 2, mrr: 0.5, recallAt10: 0.5,
      precision: 1, emptyPositive: 1, negativeAdmission: 0.5, leakedHits: 0 });
  });
});
