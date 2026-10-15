import { describe, expect, it } from 'vitest';
import { ROUTES } from './complete-hybrid-bench';
import { ALL_ANSWERABLE } from './paired-leg-report';
import { assertComparableArms, pairCompleteArms } from './complete-hybrid-paired';
import {
  FIXTURE_ENTRIES, FIXTURE_QUERIES, ISOLATION_VIOLATIONS, fixtureBaseline, fixtureCandidate,
} from './complete-hybrid-paired.fixture';

describe('assertComparableArms', () => {
  it('accepts comparable arms and returns the isolation facts it verified', () => {
    const facts = assertComparableArms([fixtureBaseline(), fixtureCandidate()]);
    expect(facts.queries).toBe(FIXTURE_QUERIES.length);
    expect(facts.arms.map((a) => a.schema)).toEqual(['bench_memory_gemma', 'bench_memory_mdenseon']);
    expect(facts.arms.every((a) => a.scopeIsolation.leakedHits === 0 && a.scopeIsolation.positiveControlHits > 0)).toBe(true);
  });

  for (const v of ISOLATION_VIOLATIONS) {
    it(`refuses ${v.name}`, () => {
      const b = fixtureBaseline(), c = fixtureCandidate();
      expect(() => assertComparableArms([b, c])).not.toThrow(); // the corruption, not the fixture, is what refuses
      v.mutate(b, c);
      expect(() => assertComparableArms([b, c])).toThrow(v.error);
    });
  }

  it('refuses a single arm', () => {
    expect(() => assertComparableArms([fixtureBaseline()])).toThrow(/at least two arms/);
  });
});

describe('pairCompleteArms', () => {
  const result = pairCompleteArms(fixtureBaseline(), fixtureCandidate(), FIXTURE_ENTRIES, { iterations: 4000 });

  it('pairs every route', () => {
    expect(Object.keys(result.routes).sort()).toEqual([...ROUTES].sort());
    expect(result).toMatchObject({ baseline: 'gemma', candidate: 'mdenseon', corpus: 'memory' });
  });

  it('resamples source-target components, not queries, for reciprocal rank', () => {
    const all = result.routes.push.mrr[ALL_ANSWERABLE]!;
    expect(all.sourceTargets).toBe(18); // 3 classes x 6 sources; each extra query joins source 0
    expect(all.queryCount).toBe(21);
    // 17 components improve 0.5 -> 1, the empty one drops 0.5 -> 0.
    expect(all.comparison.delta.point).toBeCloseTo((17 * 0.5 - 0.5) / 18, 6);
    expect(all.comparison.delta.lower).toBeGreaterThan(0);
    expect(all.marginDecision).toBe('improvement-above-margin');
  });

  it('compares precision only where both arms returned something, and reports the exclusion', () => {
    const p = result.routes.pull.positives[ALL_ANSWERABLE]!;
    expect(p.precision.excludedQueries).toBe(1);
    expect(p.precision.queries).toBe(20);
    expect(p.precision.comparison!.delta.point).toBeCloseTo(0.5, 6);
    expect(p.nonEmpty).toMatchObject({ onlyA: 1, onlyB: 0 });
    const lexical = result.routes.pull.positives['lexical-gap']!;
    expect(lexical.precision.sourceGroups).toBe(5); // source 1 contributed only the empty query
  });

  it('scores recall@10 over the same components (the empty result is a miss)', () => {
    const r = result.routes.raw.positives[ALL_ANSWERABLE]!.recallAt10;
    expect(r.sourceGroups).toBe(18);
    expect(r.comparison!.delta.point).toBeCloseTo(-1 / 18, 6);
  });

  it('compares hard-negative admission over the negatives’ own sources', () => {
    const n = result.routes['push-calibrated'].negatives;
    expect(n.admission).toMatchObject({ sourceGroups: 3, queries: 6, excludedQueries: 0 });
    expect(n.admission.comparison!.meanA).toBeCloseTo(1, 6);
    expect(n.admission.comparison!.delta.point).toBeCloseTo(-0.5, 6);
    expect(n.rejected).toMatchObject({ onlyA: 0, onlyB: 3 });
  });

  it('is deterministic for a fixed seed', () => {
    const again = pairCompleteArms(fixtureBaseline(), fixtureCandidate(), FIXTURE_ENTRIES, { iterations: 4000 });
    expect(again).toEqual(result);
  });

  it('refuses arms that do not cover the same queries', () => {
    const c = fixtureCandidate();
    c.rows = c.rows.slice(1);
    expect(() => pairCompleteArms(fixtureBaseline(), c, FIXTURE_ENTRIES)).toThrow(/same queries/);
  });
});
