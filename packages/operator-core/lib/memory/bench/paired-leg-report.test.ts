/**
 * Tests for the paired leg comparison (D-002's verdict shape).
 *
 * The bar these tests hold is not "the arithmetic runs" — it is that the
 * module cannot produce the two WRONG-BUT-PLAUSIBLE reports D-002 was written
 * to prevent: reporting an underpowered null as equivalence, and quoting the
 * identifier-dominated pooled number when the classes disagree.
 */
import { describe, it, expect } from 'vitest';
import {
  compareLegs,
  compareSourceGroupedLegs,
  planSourcePower,
  classesDisagree,
  ALL_ANSWERABLE,
  DECISION_RELEVANT_DELTA_MRR,
  type PerQueryRow,
} from './paired-leg-report';

/** Build per-query rows: `rr[i]` is the reciprocal rank of query i. */
function rows(cls: string, rr: number[], prefix = 'q'): PerQueryRow[] {
  return rr.map((r, i) => ({
    id: `${prefix}-${i}`,
    class: cls,
    firstRelevantRank: r === 0 ? 0 : Math.round(1 / r),
    reciprocalRank: r,
    top1Score: 0.5,
  }));
}

describe('independent source-target comparisons', () => {
  const entries = ['a', 'b', 'c'].map((key) => ({ key, metadata: { cluster: key } }));
  const queries = ['lexical-gap', 'exact-identifier', 'session-start-intent'].flatMap((cls) =>
    ['a', 'b', 'c'].map((group) => ({ id: `${cls}-${group}`, class: cls, group, expected: [group] })));
  const outcomes = queries.map((q) => ({ ...q, firstRelevantRank: 1, reciprocalRank: 1, top1Score: 0.5 }));
  it('resamples sources rather than repeated questions, and keeps positive classes separate', () => {
    const repeated = [...queries, { ...queries[0], id: 'repeat-a' }];
    const a = [...outcomes, { ...outcomes[0], id: 'repeat-a' }];
    const b = a.map((r) => ({ ...r, reciprocalRank: r.group === 'a' ? 0 : 1 }));
    const cmp = compareSourceGroupedLegs('a', a, 'b', b, entries, repeated);
    expect(cmp.byClass['lexical-gap'].sourceTargets).toBe(3);
    expect(cmp.byClass['lexical-gap'].queryCount).toBe(4);
    expect(cmp.byClass['lexical-gap'].comparison.delta.point).toBeCloseTo(-1 / 3);
    expect(cmp.byClass['exact-identifier'].sourceTargets).toBe(3);
    expect(cmp.decisionMargin).toBe(0.03);
  });
  it('unions co-relevant sources and refuses to resolve power from one source', () => {
    const joined = queries.map((q) => ({ ...q, expected: ['a', 'b', 'c'] }));
    const cmp = compareSourceGroupedLegs('a', outcomes, 'b', outcomes, entries, joined);
    expect(cmp.byClass.ALL_ANSWERABLE.sourceTargets).toBe(1);
    expect(cmp.byClass.ALL_ANSWERABLE.marginResolved).toBe(false);
  });
  it('rejects omitted, duplicate and misclassified outcomes before bootstrapping', () => {
    expect(() => compareSourceGroupedLegs('a', outcomes, 'b', outcomes.slice(1), entries, queries)).toThrow('incomplete');
    expect(() => compareSourceGroupedLegs('a', outcomes, 'b', [outcomes[0], ...outcomes.slice(0, -1)], entries, queries)).toThrow('duplicate');
    expect(() => compareSourceGroupedLegs('a', outcomes, 'b', outcomes.map((r) => ({ ...r, class: 'hard-negative' })), entries, queries)).toThrow('identity');
  });
  it('resolves the frozen margin only with an interval on one side or entirely within it', () => {
    const better = outcomes.map((r) => ({ ...r, reciprocalRank: 0.5 }));
    expect(compareSourceGroupedLegs('a', better, 'b', outcomes, entries, queries).byClass.ALL_ANSWERABLE.marginDecision).toBe('improvement-above-margin');
    expect(compareSourceGroupedLegs('a', outcomes, 'b', better, entries, queries).byClass.ALL_ANSWERABLE.marginDecision).toBe('loss-above-margin');
    expect(compareSourceGroupedLegs('a', outcomes, 'b', outcomes, entries, queries).byClass.ALL_ANSWERABLE.marginDecision).toBe('inside-margin');
  });
  it('keeps conditional source-power projections separate from observed acceptance', () => {
    const b = outcomes.map((r) => ({ ...r, reciprocalRank: r.group === 'a' ? 0.5 : 1 }));
    const cmp = compareSourceGroupedLegs('a', outcomes, 'b', b, entries, queries);
    const before = structuredClone(cmp), plan = planSourcePower(cmp, 30).ALL_ANSWERABLE;
    expect(cmp).toEqual(before);
    expect(plan.sourceComponents).toBe(3); expect(plan.status).toBe('conditional-variance-projection');
    expect(plan.observedMarginDecision).toBe(cmp.byClass.ALL_ANSWERABLE.marginDecision);
    expect(plan.projectedComponentsForEffect03VsZero).toBeGreaterThan(30);
    expect(plan.projectedMde80AtSourceUpperBound).toBeCloseTo(plan.observedMde80 * Math.sqrt(3 / 30));
    expect(plan.acceptanceEstablishedByProjection).toBe(false);
    const doubled = planSourcePower(cmp, 60).ALL_ANSWERABLE;
    expect(doubled.projectedComponentsForEffect03VsZero).toBe(plan.projectedComponentsForEffect03VsZero);
    expect(doubled.projectedMde80AtSourceUpperBound).toBeLessThan(plan.projectedMde80AtSourceUpperBound!);
  });
  it('does not turn two identical observations or one connected source into extrapolated power', () => {
    const equal = planSourcePower(compareSourceGroupedLegs('a', outcomes, 'b', outcomes, entries, queries), 30).ALL_ANSWERABLE;
    expect(equal.status).toBe('zero-observed-variance-no-extrapolation');
    expect(equal.projectedComponentsForEffect03VsZero).toBeNull();
    expect(equal.projectedComponentsForObservedMarginDistance).toBeNull();
    const joined = queries.map((q) => ({ ...q, expected: ['a', 'b', 'c'] }));
    expect(planSourcePower(compareSourceGroupedLegs('a', outcomes, 'b', outcomes, entries, joined), 30).ALL_ANSWERABLE.status).toBe('insufficient-components');
  });
  it('refuses query-count populations, altered margins and invalid MDEs', () => {
    const cmp = compareSourceGroupedLegs('a', outcomes, 'b', outcomes, entries, queries);
    for (const n of [0, -1, 1.5, NaN, Infinity, 2]) expect(() => planSourcePower(cmp, n)).toThrow('source power');
    expect(() => planSourcePower({ ...cmp, decisionMargin: 0.04 }, 30)).toThrow('contract');
    cmp.byClass.ALL_ANSWERABLE.comparison.mde80 = NaN;
    expect(() => planSourcePower(cmp, 30)).toThrow('comparison');
  });
});

describe('compareLegs', () => {
  it('reports a real degradation as candidate-worse with a CI excluding zero', () => {
    const base = rows('lexical-gap', Array.from({ length: 80 }, (_, i) => (i % 4 === 0 ? 1 : 0.5)));
    // Candidate is uniformly half a rank worse on every query.
    const cand = base.map((r) => ({ ...r, reciprocalRank: r.reciprocalRank - 0.2, firstRelevantRank: 2 }));
    const cmp = compareLegs('gemma@768', base, 'gemma@384', cand);
    const all = cmp.byClass[ALL_ANSWERABLE];
    expect(all.verdict).toBe('candidate-worse');
    expect(all.deltaMrr.delta.point).toBeCloseTo(-0.2, 6);
    expect(all.deltaMrr.delta.upper).toBeLessThan(0);
    expect(all.statement).toMatch(/WORSE/);
  });

  /**
   * The failure mode D-002 §4 exists to prevent. A tiny sample with a huge
   * spread produces delta ≈ 0 — which reads exactly like "the widths are
   * equivalent" unless the report says otherwise. It must come back
   * UNDERPOWERED, and the statement must refuse the equivalence wording.
   */
  it('calls a WIDE null underpowered rather than "no difference"', () => {
    const base = rows('lexical-gap', [1, 0, 1, 0, 0.5, 0, 1, 0]);
    const cand = rows('lexical-gap', [0, 1, 0, 1, 0, 0.5, 0, 1]);
    const cmp = compareLegs('a', base, 'b', cand);
    const all = cmp.byClass[ALL_ANSWERABLE];
    expect(all.verdict).toBe('underpowered');
    expect(all.deltaMrr.halfWidth).toBeGreaterThan(DECISION_RELEVANT_DELTA_MRR);
    expect(all.statement).toMatch(/UNDERPOWERED/);
    expect(all.statement).not.toMatch(/equivalent/i);
  });

  /**
   * The complementary case: a null that IS informative because the interval is
   * tight. Even here the wording must stay "no decision-relevant difference
   * detected at this power" and explicitly disclaim equivalence.
   */
  it('calls a TIGHT null "no decision-relevant difference" and still disclaims equivalence', () => {
    // 200 queries, identical legs apart from negligible alternating jitter.
    const rr = Array.from({ length: 200 }, (_, i) => 0.5 + (i % 5) * 0.02);
    const base = rows('exact-identifier', rr);
    const cand = base.map((r, i) => ({ ...r, reciprocalRank: r.reciprocalRank + (i % 2 === 0 ? 0.001 : -0.001) }));
    const cmp = compareLegs('a', base, 'b', cand);
    const all = cmp.byClass[ALL_ANSWERABLE];
    expect(all.verdict).toBe('no-detected-difference');
    expect(all.deltaMrr.halfWidth).toBeLessThanOrEqual(DECISION_RELEVANT_DELTA_MRR);
    expect(all.statement).toMatch(/NOT a finding of equivalence/);
    expect(all.statement).toMatch(/80%-power MDE/);
  });

  it('EXCLUDES hard negatives — pooling them would dilute every delta toward zero', () => {
    const answerable = rows('lexical-gap', [1, 1, 1, 1]);
    const negatives = rows('hard-negative', [0, 0, 0, 0, 0, 0, 0, 0], 'hn');
    const base = [...answerable, ...negatives];
    const cand = [
      ...answerable.map((r) => ({ ...r, reciprocalRank: 0.5, firstRelevantRank: 2 })),
      ...negatives,
    ];
    const cmp = compareLegs('a', base, 'b', cand);
    // n counts only the 4 answerable queries, and the delta is the full -0.5 —
    // not the -0.167 that pooling the 8 zero-RR negatives would have produced.
    expect(cmp.byClass[ALL_ANSWERABLE].n).toBe(4);
    expect(cmp.byClass[ALL_ANSWERABLE].deltaMrr.delta.point).toBeCloseTo(-0.5, 6);
    expect(cmp.byClass['hard-negative']).toBeUndefined();
  });

  it('reports each class separately as well as pooled', () => {
    const base = [...rows('lexical-gap', [1, 1, 0.5], 'lg'), ...rows('exact-identifier', [0.5, 0.5], 'ei')];
    const cand = [...rows('lexical-gap', [0.5, 0.5, 0.25], 'lg'), ...rows('exact-identifier', [0.5, 0.5], 'ei')];
    const cmp = compareLegs('a', base, 'b', cand);
    expect(Object.keys(cmp.byClass).sort()).toEqual([ALL_ANSWERABLE, 'exact-identifier', 'lexical-gap']);
    expect(cmp.byClass['exact-identifier'].deltaMrr.delta.point).toBeCloseTo(0, 10);
    expect(cmp.byClass['lexical-gap'].deltaMrr.delta.point).toBeLessThan(0);
  });

  it('runs McNemar on hit@1, ignoring queries where the legs agree', () => {
    // 6 queries: 3 concordant hits, 3 where only the baseline hit.
    const base = rows('exact-identifier', [1, 1, 1, 1, 1, 1]);
    const cand = rows('exact-identifier', [1, 1, 1, 0.5, 0.5, 0.5]);
    const m = compareLegs('a', base, 'b', cand).byClass[ALL_ANSWERABLE].hitAt1;
    expect(m).toMatchObject({ onlyA: 3, onlyB: 0, concordant: 3 });
    expect(m.p).toBeCloseTo(0.25, 10); // 2·P(X≤0 | n=3,½) = 2/8
  });

  /**
   * Aligning by position instead of id would pair unrelated queries and still
   * emit a confident interval. The join must fail loudly instead.
   */
  it('throws when a query is missing from the candidate rather than mis-pairing', () => {
    const base = rows('lexical-gap', [1, 1, 1]);
    const cand = rows('lexical-gap', [1, 1]);
    expect(() => compareLegs('a', base, 'b', cand)).toThrow(/missing from b/);
  });

  it('pairs by ID even when the candidate rows arrive in a different order', () => {
    const base = rows('lexical-gap', [1, 0.5, 0.25]);
    const cand = [...rows('lexical-gap', [1, 0.5, 0.25])].reverse();
    const cmp = compareLegs('a', base, 'b', cand);
    // Correct pairing ⇒ exactly zero delta. A positional join would pair
    // q-0's 1.0 against q-2's 0.25 and report a spurious difference.
    expect(cmp.byClass[ALL_ANSWERABLE].deltaMrr.delta.point).toBeCloseTo(0, 10);
  });

  it('is deterministic given a seed', () => {
    const base = rows('lexical-gap', [1, 0.5, 0.33, 0.25, 1, 0.5]);
    const cand = rows('lexical-gap', [0.5, 0.5, 1, 0.25, 0.33, 1]);
    expect(compareLegs('a', base, 'b', cand, { seed: 42 })).toEqual(
      compareLegs('a', base, 'b', cand, { seed: 42 }),
    );
  });
});

describe('classesDisagree', () => {
  it('flags opposite-signed class verdicts (pooled number uninterpretable)', () => {
    // lexical-gap strongly worse, exact-identifier strongly better.
    const base = [
      ...rows('lexical-gap', Array(60).fill(1), 'lg'),
      ...rows('exact-identifier', Array(60).fill(0.2), 'ei'),
    ];
    const cand = [
      ...rows('lexical-gap', Array(60).fill(0.2), 'lg'),
      ...rows('exact-identifier', Array(60).fill(1), 'ei'),
    ];
    const cmp = compareLegs('a', base, 'b', cand);
    expect(cmp.byClass['lexical-gap'].verdict).toBe('candidate-worse');
    expect(cmp.byClass['exact-identifier'].verdict).toBe('candidate-better');
    expect(classesDisagree(cmp)).toBe(true);
  });

  it('does not flag agreement, and ignores the pooled pseudo-class', () => {
    const base = [
      ...rows('lexical-gap', Array(60).fill(1), 'lg'),
      ...rows('exact-identifier', Array(60).fill(1), 'ei'),
    ];
    const cand = [
      ...rows('lexical-gap', Array(60).fill(0.2), 'lg'),
      ...rows('exact-identifier', Array(60).fill(0.2), 'ei'),
    ];
    const cmp = compareLegs('a', base, 'b', cand);
    expect(classesDisagree(cmp)).toBe(false);
  });
});
