/**
 * The bench test template for AGGREGATE CORRECTNESS (P-010, SPEC-P-010-AGGREGATE-TEMPLATE,
 * plan verification-system-improvements-2026-10-10).
 *
 * A bench instrument reduces per-query rows to a rate (recall@k, MRR, hit rate). The two ways
 * that reduction goes silently wrong both produce a HEALTHY-looking number from a broken run:
 *
 *  1. NULL rows dropped from the denominator. SQL `avg((rank = 1)::int)` skips rows whose rank
 *     is NULL (a miss), so it averages the hits over the hits — the WI-10008233 recall@1 trial
 *     reported a near-perfect score that way. An all-miss run yields NULL, not 0.
 *  2. The wrong denominator. Dividing by the non-error rows (or by the rows that returned
 *     anything) turns every failed query into a query that never happened.
 *
 * Usage, in the instrument's own `*.test.ts`:
 *
 *   expect(checkAggregateCorrectness<EvalRow>(   // name the row type: TS cannot infer it here
 *     (rows) => summarize(rows)[0]?.recallAt1 ?? null,
 *     (outcome) => ({ ...base, rank: outcome === 'hit' ? 1 : null, err: outcome === 'error' }),
 *   )).toEqual([]);
 *
 * `build` maps an abstract outcome to the instrument's own row shape; the template supplies the
 * cases and the expected value, which is always hits / ALL queries.
 */

export type QueryOutcome = 'hit' | 'miss' | 'error';

export interface AggregateCorrectnessCase {
  name: string;
  outcomes: readonly QueryOutcome[];
  /** hits / every query. The only denominator a per-query rate may use. */
  expected: number;
}

export const AGGREGATE_CORRECTNESS_CASES: readonly AggregateCorrectnessCase[] = [
  { name: 'all-hits', outcomes: ['hit', 'hit', 'hit', 'hit'], expected: 1 },
  { name: 'null-rows-stay-in-denominator', outcomes: ['hit', 'miss', 'miss', 'miss'], expected: 0.25 },
  { name: 'all-null-is-zero-not-missing', outcomes: ['miss', 'miss'], expected: 0 },
  { name: 'errors-stay-in-denominator', outcomes: ['hit', 'error'], expected: 0.5 },
  { name: 'mixed-hit-miss-error', outcomes: ['hit', 'hit', 'miss', 'error'], expected: 0.5 },
];

export interface AggregateCorrectnessFailure {
  case: string;
  expected: number;
  /** null when the aggregate returned null/undefined/NaN — itself a failure: an empty rate is 0. */
  actual: number | null;
}

/** Run every template case through `aggregate`; returns the cases it got wrong (empty = correct). */
export function checkAggregateCorrectness<Row>(
  aggregate: (rows: readonly Row[]) => number | null | undefined,
  build: (outcome: QueryOutcome, index: number) => Row,
  options: { tolerance?: number } = {},
): AggregateCorrectnessFailure[] {
  const tolerance = options.tolerance ?? 1e-9;
  const failures: AggregateCorrectnessFailure[] = [];
  for (const c of AGGREGATE_CORRECTNESS_CASES) {
    const value = aggregate(c.outcomes.map((outcome, i) => build(outcome, i)));
    const actual = typeof value === 'number' && Number.isFinite(value) ? value : null;
    if (actual === null || Math.abs(actual - c.expected) > tolerance) {
      failures.push({ case: c.name, expected: c.expected, actual });
    }
  }
  return failures;
}
