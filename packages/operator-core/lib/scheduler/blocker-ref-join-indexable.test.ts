/**
 * WI-521425 — the recurrence guard for the blocker-ref join shape.
 *
 * WHAT WENT WRONG, so the assertions below read as consequences rather than trivia.
 * `unsatisfiedBlockerSql` (work-items.ts) matched a feature-family blocker with
 * `(bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref`. Concatenating on the CANDIDATE
 * side produces an expression no index can serve, so EXPLAIN demoted the probe to an Index
 * Scan whose only Index Cond was `workspace_id` (~510k rows) with the real selectivity left
 * as a post-scan Filter: cost 40,840 and ~592ms PER PROBE. ORed with the issue-family EXISTS
 * beside it, that also defeated PostgreSQL's hashed-subplan plan — total cost 172,851 with one
 * EXISTS, 6,462,357 with both.
 *
 * The cost was not theoretical. That fragment is ANDed into the shared claim-candidate
 * subquery as `ok_no_blocker`, so this ONE floor exceeded the 15s statement cap on its own and
 * `work_items:claimable { harness: 'papercusp' }` timed out outright — the read-only admission
 * oracle the fleet steers on. Splitting the dep-side SCALAR instead lets the base table's
 * PRIMARY KEY (harness_slug, feature_id) serve the probe: TIMEOUT@15s -> 582ms over the full
 * 72,005-row population.
 *
 * The measurement above is a point-in-time snapshot and will rot. These tests are the part
 * that does not. They are source-level on purpose: the regression is a QUERY SHAPE, which a
 * behavioural test cannot see — a reverted concat join still returns byte-identical rows, just
 * thousands of times slower, so it would pass every correctness suite in this repo while
 * re-breaking the queue. Seeded-row tests also run against tiny fixture tables where a seq
 * scan is free, which is exactly why this defect survived them the first time.
 *
 * SCOPE — this pins the JOIN SHAPE, not the blocking SEMANTICS. What is or is not a blocker
 * (family vocabularies, workspace scoping, the settled/success split) belongs to
 * blocking-floor-single-source.test.ts and claim-respects-blocking.integration.test.ts; this
 * file must not restate them, or a legitimate semantics change fails in two places at once.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Overridable so `scripts/mutation-probe.sh` can point this guard at a COPY (or a historical
 *  snapshot) instead of mutating the shared tree — the tier-2 escape the repo prescribes,
 *  because an in-tree mutation here can be swept into a commit by git-sync mid-probe. */
const WORK_ITEMS_SRC = process.env.PROBE_WORK_ITEMS_SRC
  ? resolve(process.env.PROBE_WORK_ITEMS_SRC)
  : resolve(__dirname, '..', 'work-items.ts');
const MIGRATION_1087_SRC = resolve(
  __dirname,
  '../../../..',
  'libs/papercusp/libs/db/sql/1087-align-blocker-ref-indexability.sql',
);

/** The body of `unsatisfiedBlockerSql`, sliced from its declaration to the next top-level
 *  declaration. Sliced rather than imported because the assertions are about the SQL TEXT the
 *  fragment is built from, which a compiled postgres-js fragment no longer exposes verbatim. */
function unsatisfiedBlockerSource(): string {
  const src = readFileSync(WORK_ITEMS_SRC, 'utf8');
  const start = src.indexOf('function unsatisfiedBlockerSql');
  expect(
    start,
    'unsatisfiedBlockerSql not found in work-items.ts — it was renamed or moved; re-point this guard rather than deleting it',
  ).toBeGreaterThan(-1);
  const after = src.indexOf('\nexport function ', start);
  return src.slice(start, after === -1 ? start + 4000 : after);
}

/** The feature-family inline readiness floor, sliced at its stable following declaration. */
function claimFloorsSource(): string {
  const src = readFileSync(WORK_ITEMS_SRC, 'utf8');
  // claimFloorsWhereSql ANDs the named predicates of featureClaimFloorPredicatesSql, which
  // precedes it; slice from the registry so the blocker predicate is in scope.
  const start = src.indexOf('export function featureClaimFloorPredicatesSql');
  expect(
    start,
    'featureClaimFloorPredicatesSql not found in work-items.ts — it was renamed or moved; re-point this guard rather than deleting it',
  ).toBeGreaterThan(-1);
  expect(src.indexOf('export function claimFloorsWhereSql', start)).toBeGreaterThan(start);
  const after = src.indexOf('\n/**\n * The tuple-space associative', start);
  return src.slice(start, after === -1 ? start + 30_000 : after);
}

/**
 * Migration 1087 is the runtime source for pg_get_functiondef(work_item_is_blocked).
 * Keep a source-level check here so the unit guard can compare the two predicates
 * without requiring a live Postgres container.
 */
function workItemIsBlockedMigrationSource(): string {
  const src = readFileSync(MIGRATION_1087_SRC, 'utf8');
  const start = src.indexOf('CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked');
  expect(
    start,
    'migration 1087 does not redefine work_item_is_blocked() — the maintained sidecar oracle would remain stale',
  ).toBeGreaterThan(-1);
  const after = src.indexOf('$function$;', start);
  return src.slice(start, after === -1 ? start + 12_000 : after);
}

function normaliseSqlSource(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('WI-521425: the feature-family blocker join stays indexable', () => {
  it('does NOT concatenate the candidate side against blocker_ref', () => {
    const body = unsatisfiedBlockerSource();
    // The exact shape that caused the timeout. Whitespace-normalised so a reformat cannot
    // smuggle it back in.
    const normalised = body.replace(/\s+/g, ' ');
    expect(
      normalised,
      'the non-indexable concat join is back: `(bf.harness_slug || \'#\' || bf.feature_id) = d.blocker_ref` ' +
        'cannot use an index, which is what made work_items:claimable exceed its 15s statement cap (WI-521425). ' +
        'Match by splitting d.blocker_ref instead, so PRIMARY KEY (harness_slug, feature_id) serves the probe.',
    ).not.toMatch(/bf\.harness_slug \|\| '#' \|\| bf\.feature_id\s*\)?\s*=\s*d\.blocker_ref/);
  });

  it('matches by splitting the dep-side scalar, guarded against a ref carrying no separator', () => {
    const normalised = unsatisfiedBlockerSource().replace(/\s+/g, ' ');
    expect(normalised).toContain("bf.harness_slug = split_part(d.blocker_ref, '#', 1)");
    expect(normalised).toContain('bf.feature_id = substring(d.blocker_ref from position(');
    // Without this guard a blocker_ref with no '#' would match on harness_slug alone against an
    // empty feature_id, where the concat form it replaced could never match at all.
    expect(
      normalised,
      "the position('#' ...) > 0 guard is gone: a blocker_ref carrying no separator would now " +
        'match differently than the concat form this replaced',
    ).toContain("position('#' in d.blocker_ref) > 0");
  });
});

describe('EI-218628: every feature-family readiness oracle keeps the blocker join indexable', () => {
  it('does NOT concatenate the candidate side against blocker_ref in claimFloorsWhereSql', () => {
    const normalised = normaliseSqlSource(claimFloorsSource());
    expect(
      normalised,
      'claimFloorsWhereSql reintroduced the non-indexable feature blocker concat; match by ' +
        'splitting d.blocker_ref so the work_items primary key can serve the probe (EI-218628).',
    ).not.toMatch(/bf\.harness_slug \|\| '#' \|\| bf\.feature_id\s*\)?\s*=\s*d\.blocker_ref/);
  });

  it('uses the same guarded dep-side scalar split as unsatisfiedBlockerSql', () => {
    const normalised = normaliseSqlSource(claimFloorsSource());
    expect(normalised).toContain("position('#' in d.blocker_ref) > 0");
    expect(normalised).toContain("bf.harness_slug = split_part(d.blocker_ref, '#', 1)");
    expect(normalised).toContain('bf.feature_id = substring(d.blocker_ref from position(');
  });

  it('keeps the migration-backed work_item_is_blocked() predicate in lockstep with TypeScript', () => {
    const tsSource = normaliseSqlSource(claimFloorsSource());
    const migrationSource = normaliseSqlSource(workItemIsBlockedMigrationSource());
    const requiredShape = [
      "position('#' in d.blocker_ref) > 0",
      "bf.harness_slug = split_part(d.blocker_ref, '#', 1)",
      'bf.feature_id = substring(d.blocker_ref from position(',
    ];

    for (const fragment of requiredShape) {
      expect(tsSource, `claimFloorsWhereSql is missing ${fragment}`).toContain(fragment);
      expect(migrationSource, `migration 1087 is missing ${fragment}`).toContain(fragment);
    }

    expect(
      migrationSource,
      'migration 1087 still carries the candidate-side blocker concat that pg_get_functiondef() ' +
        'would expose after apply',
    ).not.toMatch(/bf\.harness_slug \|\| '#' \|\| bf\.feature_id\s*\)?\s*=\s*d\.blocker_ref/);
  });
});

/**
 * The rewrite is equivalent only because no harness_slug contains '#'. That is a real
 * precondition, not a rounding error, so it is asserted rather than assumed — including the
 * case where it FAILS, so the boundary is visible to whoever reads this next.
 */
describe('WI-521425: splitting on the first separator inverts the concatenation', () => {
  const splitRef = (ref: string): { slug: string; featureId: string } | null => {
    const at = ref.indexOf('#');
    if (at < 0) return null; // mirrors the position(...) > 0 guard
    return { slug: ref.slice(0, at), featureId: ref.slice(at + 1) };
  };

  it.each([
    { slug: 'papercusp', featureId: 'WI-123' },
    { slug: 'sb-devboard-hive', featureId: 'EI-21580597231511770' },
    // A feature_id carrying further separators still round-trips: only the FIRST '#' is the
    // boundary, so the remainder lands in feature_id whole.
    { slug: 'papercusp', featureId: 'WI-1#2#3' },
    { slug: 'papercusp', featureId: '' },
  ])('round-trips $slug + $featureId', ({ slug, featureId }) => {
    expect(slug).not.toContain('#'); // the precondition, restated per case
    expect(splitRef(`${slug}#${featureId}`)).toEqual({ slug, featureId });
  });

  it('a ref with no separator matches nothing, exactly as the concat form did', () => {
    // The concat form always produced a '#', so it could never equal a ref lacking one.
    expect(splitRef('WI-123-with-no-separator')).toBeNull();
  });

  it("DIVERGES if a harness_slug ever contains '#' — the documented precondition", () => {
    // Measured 2026-08-28: 0 of 217 distinct harness_slug values contain '#'. If that ever
    // stops holding, this is the case that breaks first: the concat form would still match
    // this row and the split form would not, silently under-reporting a blocker and letting a
    // blocked item read as claimable.
    const slug = 'weird#slug';
    const featureId = 'WI-9';
    expect(splitRef(`${slug}#${featureId}`)).not.toEqual({ slug, featureId });
  });
});
