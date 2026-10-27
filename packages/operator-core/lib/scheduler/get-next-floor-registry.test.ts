/**
 * THE DERIVATION GUARD for ISSUE_CLAIM_FLOORS (EI-22180177490969530).
 *
 * The bug this pins is not a wrong answer — it is a SILENCE. The bucket vocabulary used to
 * be restated by hand in five places, so a floor could be ANDed into the claim bar while
 * being reported under no bucket at all: no SQL error, no type error, no failing test. A
 * reader then could not distinguish "this floor excluded 2,000 rows" from "this floor never
 * ran", because both render as the same absence. `ok_watchdog_recovery` shipped exactly that
 * way and was found only by differencing the hand-maintained lists.
 *
 * So a green run here must mean THE CHECK WORKS, not merely that it ran. Every totality
 * assertion below is paired with controls that are wrong in each direction — an instrument
 * pointed at nothing, at the wrong relation, and at data missing exactly one floor. Without
 * them, `findBucketlessFloors(...) → []` is ambiguous in precisely the way the work-item
 * exists to abolish: "I measured everything and found nothing wrong" and "I measured
 * nothing" are the same value.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_ISSUE_CLAIM_FLOORS_PASS,
  ISSUE_CLAIM_EXCLUSION_COUNT_SELECT_SQL,
  ISSUE_CLAIM_FLOORS,
  type IssueClaimFloorSpec,
  findBucketlessFloors,
  issueClaimFloorBucketGuard,
  mapIssueClaimExclusionCounts,
  mapIssueClaimExclusionSamples,
} from './get-next';
import { ISSUE_FLOOR_ATTRIBUTION, ISSUE_FLOOR_EXPLANATIONS } from '../work-items';

/** Re-emit the count SELECT list from an ARBITRARY floor set, using the same expression the
 *  production constant is built from. This is what lets a control be a genuinely emitted
 *  SELECT that is missing one floor, rather than a hand-typed approximation of one. */
function emitCountSelect(floors: readonly IssueClaimFloorSpec[]): string {
  return floors
    .map(
      (f) =>
        `count(*) FILTER (WHERE spec_match AND ${issueClaimFloorBucketGuard(f)}NOT ${f.ok})::int AS ${f.bucket}`,
    )
    .join(',\n      ');
}

const ALL_OK = ISSUE_CLAIM_FLOORS.map((f) => f.ok);

describe('the emitted exclusion breakdown is TOTAL over the floor registry', () => {
  it('every registry floor is reported by the real count SELECT list', () => {
    const bucketless = findBucketlessFloors(ISSUE_CLAIM_FLOORS, ISSUE_CLAIM_EXCLUSION_COUNT_SELECT_SQL);

    expect(
      bucketless,
      `These floors are ANDed into the claim bar but reported under NO bucket: ` +
        `${JSON.stringify(bucketless)}. Rows they exclude vanish from the breakdown, so a ` +
        `reader cannot tell "excluded thousands" from "never ran" — the exact silence this ` +
        `registry exists to make unrepresentable. Add an entry to ISSUE_CLAIM_FLOORS; the ` +
        `counts, samples and both public shapes follow from it.`,
    ).toEqual([]);
  });

  it('the claim bar and the buckets are derived from ONE list, so neither can outrun the other', () => {
    // Both constants are generated from ISSUE_CLAIM_FLOORS; this asserts the property that
    // derivation is supposed to buy, so a future hand-written copy of either is caught.
    for (const ok of ALL_OK) {
      expect(ALL_ISSUE_CLAIM_FLOORS_PASS, `${ok} is a registry floor but is not ANDed into the claim bar`)
        .toContain(ok);
    }
    expect(
      ALL_ISSUE_CLAIM_FLOORS_PASS.match(/\bok_[a-z_]+/g) ?? [],
      'the claim bar references a floor absent from the registry — it would be enforced but never reported',
    ).toEqual(ALL_OK);
  });
});

/**
 * THE POSITIVE CONTROLS — the acceptance condition for this work-item.
 *
 * A "no bucket-less floors remain" result is worthless unless the same instrument FAILS LOUD
 * when pointed somewhere useless. These pin that direction: a mis-scoped instrument must
 * report EVERY floor, never zero.
 */
describe('POSITIVE CONTROL — a mis-scoped instrument reports every floor, never a clean bill', () => {
  it('an EMPTY select list reports every floor as bucket-less, not none', () => {
    expect(
      findBucketlessFloors(ISSUE_CLAIM_FLOORS, ''),
      'measuring NOTHING returned a clean result — the guard would pass on an instrument that never ran',
    ).toEqual(ALL_OK);
  });

  it('a WRONG-RELATION select list reports every floor as bucket-less', () => {
    const wrongRelation =
      'count(*) FILTER (WHERE spec_match AND NOT ok_some_other_thing)::int AS some_other_bucket';

    expect(
      findBucketlessFloors(ISSUE_CLAIM_FLOORS, wrongRelation),
      'a well-formed SELECT over the wrong subject read as full coverage',
    ).toEqual(ALL_OK);
  });

  it('dropping exactly ONE floor names exactly that floor — the realistic drift', () => {
    // The whole failure mode in miniature: 17 of 18 buckets present is what shipping a
    // bucket-less floor actually looks like, and it must not read as "close enough".
    for (const omitted of ISSUE_CLAIM_FLOORS) {
      const partial = emitCountSelect(ISSUE_CLAIM_FLOORS.filter((f) => f.ok !== omitted.ok));

      expect(
        findBucketlessFloors(ISSUE_CLAIM_FLOORS, partial),
        `omitting ${omitted.ok} from the emitted SELECT was not detected`,
      ).toEqual([omitted.ok]);
    }
  });

  it('a floor reported under the WRONG bucket name is still bucket-less', () => {
    // Guards the `AS <bucket>` half of the predicate. If only `NOT ok_*` were checked, a
    // floor counted into someone else's column would pass while corrupting that column.
    const [first] = ISSUE_CLAIM_FLOORS;
    const renamed = ISSUE_CLAIM_EXCLUSION_COUNT_SELECT_SQL.replace(
      new RegExp(`\\bAS ${first.bucket}\\b`),
      'AS wrong_column_name',
    );

    expect(renamed, 'control did not actually rename anything').not.toEqual(
      ISSUE_CLAIM_EXCLUSION_COUNT_SELECT_SQL,
    );
    expect(findBucketlessFloors(ISSUE_CLAIM_FLOORS, renamed)).toEqual([first.ok]);
  });
});

// WI-6554700010029716: the per-id explainer (work_items:observe, explainIssueClaimFloors,
// diagnoseClaimNextMiss attribution) once read a hand-written floor list that dropped
// ok_admission_recovery, so self-select skipped queued/held recovery rows while the explainer
// called them admissible. Its list is now ISSUE_FLOOR_ATTRIBUTION; this pins it to the claim bar.
describe('per-id attribution covers every floor the claim bar enforces', () => {
  const attributed = new Set<string>(ISSUE_FLOOR_ATTRIBUTION.map(([, column]) => column));

  it('every ISSUE_CLAIM_FLOORS column has an explainIssueClaimFloors label', () => {
    expect(ALL_OK.filter((ok) => !attributed.has(ok))).toEqual([]);
  });

  it('labels are unique and each one carries an explanation', () => {
    const labels = ISSUE_FLOOR_ATTRIBUTION.map(([label]) => label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.filter((label) => !(label in ISSUE_FLOOR_EXPLANATIONS))).toEqual([]);
  });

  it('POSITIVE CONTROL: the pre-fix list (without ok_admission_recovery) is named as uncovered', () => {
    const preFix = new Set([...attributed].filter((column) => column !== 'ok_admission_recovery'));
    expect(ALL_OK.filter((ok) => !preFix.has(ok))).toEqual(['ok_admission_recovery']);
  });
});

describe('the registry itself is well-formed', () => {
  it('ok column, bucket alias and public field are each unique', () => {
    for (const key of ['ok', 'bucket', 'field'] as const) {
      const values = ISSUE_CLAIM_FLOORS.map((f) => f[key]);
      const duplicated = values.filter((v, i) => values.indexOf(v) !== i);

      expect(duplicated, `duplicate ${key} in ISSUE_CLAIM_FLOORS: ${JSON.stringify(duplicated)}`).toEqual([]);
    }
  });

  it('names follow the shape each position requires', () => {
    for (const f of ISSUE_CLAIM_FLOORS) {
      expect(f.ok, `${f.ok} must name the ok_* boolean the candidate subquery decorates`).toMatch(
        /^ok_[a-z0-9_]+$/,
      );
      expect(f.bucket, `${f.bucket} is a SQL column alias — snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(f.field, `${f.field} is a public result key — camelCase`).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it('exactly one floor is self-guarded, and it is the taken floor', () => {
    // Every other bucket is measured over the UNTAKEN subset; ok_untaken must not re-guard
    // on itself or its own bucket would always be 0 — a floor reporting silence again.
    // Read through the declared interface: `as const` narrows each entry to a literal type
    // that simply has no `selfGuarded` property unless it was written, which is a fact about
    // the literal, not about the contract being asserted here.
    const floors: readonly IssueClaimFloorSpec[] = ISSUE_CLAIM_FLOORS;
    const selfGuarded = floors.filter((f) => f.selfGuarded);

    expect(selfGuarded.map((f) => f.ok)).toEqual(['ok_untaken']);
    for (const f of floors) {
      expect(issueClaimFloorBucketGuard(f)).toBe(f.selfGuarded ? '' : 'ok_untaken AND ');
    }
  });
});

describe('the public shapes carry one always-present key per floor', () => {
  it('an ABSENT row yields a measured zero for every floor, not a missing key', () => {
    const counts = mapIssueClaimExclusionCounts(undefined) as Record<string, number>;
    const samples = mapIssueClaimExclusionSamples(undefined) as Record<string, string[]>;
    const fields = ISSUE_CLAIM_FLOORS.map((f) => f.field);

    expect(Object.keys(counts).sort()).toEqual([...fields].sort());
    expect(Object.keys(samples).sort()).toEqual([...fields].sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(Object.values(samples).every((a) => Array.isArray(a) && a.length === 0)).toBe(true);
  });

  it('each raw bucket column lands on its own public field', () => {
    const [first] = ISSUE_CLAIM_FLOORS;
    const counts = mapIssueClaimExclusionCounts({ [first.bucket]: 7 } as never) as Record<string, number>;
    const samples = mapIssueClaimExclusionSamples({ [first.bucket]: ['EI-1'] } as never) as Record<
      string,
      string[]
    >;

    expect(counts[first.field]).toBe(7);
    expect(samples[first.field]).toEqual(['EI-1']);
    // Everything else stays a measured empty — a stray value must not smear across buckets.
    expect(Object.values(counts).filter((n) => n !== 0)).toEqual([7]);
    expect(Object.values(samples).filter((a) => a.length > 0)).toEqual([['EI-1']]);
  });
});
