/**
 * SPEC-P-010-AGGREGATE-TEMPLATE: the template must FAIL an instrument that drops NULL rows or
 * divides by the wrong denominator, and PASS the real bench instrument. The two broken
 * aggregates below are permanent controls — never mutate a production instrument to prove this.
 */
import { describe, expect, it } from 'vitest';
import { AGGREGATE_CORRECTNESS_CASES, checkAggregateCorrectness, type QueryOutcome } from './aggregate-correctness';
import { summarize, type EvalRow } from './bm25-bakeoff';

const row = (outcome: QueryOutcome, i: number, hitRank = 1): EvalRow => ({
  method: 'evoke',
  variant: 'title',
  target: `doc-${i}`,
  rank: outcome === 'hit' ? hitRank : null,
  ms: 5,
  err: outcome === 'error',
  errmsg: outcome === 'error' ? 'timeout' : null,
});

/** SQL `avg((rank = 1)::int)` — the recall@1 incident: NULL ranks (misses AND errors) are skipped. */
const nullDroppingAvg = (rows: readonly EvalRow[]): number | null => {
  const values = rows
    .map((r): number | null => (r.rank === null ? null : r.rank === 1 ? 1 : 0))
    .filter((v): v is number => v !== null);
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
};

/** Counts misses but divides by the rows that did not error: every failed query vanishes. */
const nonErrorDenominator = (rows: readonly EvalRow[]): number => {
  const ok = rows.filter((r) => !r.err);
  return ok.filter((r) => r.rank === 1).length / ok.length;
};

const failedCases = (aggregate: (rows: readonly EvalRow[]) => number | null) =>
  checkAggregateCorrectness(aggregate, (o, i) => row(o, i)).map((f) => f.case);

describe('bench aggregate-correctness template', () => {
  it('passes the real bm25 bake-off recall@1, recall@10 and MRR@10 (positive control)', () => {
    expect(checkAggregateCorrectness<EvalRow>((rows) => summarize(rows)[0]?.recallAt1, (o, i) => row(o, i))).toEqual([]);
    expect(checkAggregateCorrectness<EvalRow>((rows) => summarize(rows)[0]?.recallAt10, (o, i) => row(o, i, 7))).toEqual([]);
    expect(checkAggregateCorrectness<EvalRow>((rows) => summarize(rows)[0]?.mrrAt10, (o, i) => row(o, i))).toEqual([]);
  });

  it('fails an AVG that silently drops NULL rows (the recall@1 incident)', () => {
    expect(failedCases(nullDroppingAvg)).toEqual([
      'null-rows-stay-in-denominator',
      'all-null-is-zero-not-missing',
      'errors-stay-in-denominator',
      'mixed-hit-miss-error',
    ]);
    const nullCase = checkAggregateCorrectness(nullDroppingAvg, (o, i) => row(o, i)).find((f) => f.case === 'null-rows-stay-in-denominator');
    // The broken instrument reports a perfect score for a run that found 1 target in 4.
    expect(nullCase).toEqual({ case: 'null-rows-stay-in-denominator', expected: 0.25, actual: 1 });
  });

  it('fails an aggregate that divides by the wrong denominator', () => {
    expect(failedCases(nonErrorDenominator)).toEqual(['errors-stay-in-denominator', 'mixed-hit-miss-error']);
  });

  it('treats a null, undefined or NaN result as a failure, never as a pass', () => {
    for (const broken of [() => null, () => undefined, () => Number.NaN]) {
      const failures = checkAggregateCorrectness(broken, (o, i) => row(o, i));
      expect(failures.map((f) => f.case)).toEqual(AGGREGATE_CORRECTNESS_CASES.map((c) => c.name));
      expect(failures.every((f) => f.actual === null)).toBe(true);
    }
  });

  it('keeps every case expected value equal to hits over ALL queries', () => {
    for (const c of AGGREGATE_CORRECTNESS_CASES) {
      expect(c.expected).toBe(c.outcomes.filter((o) => o === 'hit').length / c.outcomes.length);
    }
    const outcomes = new Set(AGGREGATE_CORRECTNESS_CASES.flatMap((c) => c.outcomes));
    expect([...outcomes].sort()).toEqual(['error', 'hit', 'miss']);
  });
});
