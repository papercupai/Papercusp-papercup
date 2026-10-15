/**
 * claim-spec-goal-field.test.ts — WI-37711.
 *
 * TWO things are pinned here.
 *
 * 1. THE `goal` FIELD ITSELF. `work_items.goal_id` (migration 785 / P-002) is stamped by
 *    `stampGoalProvenance`, but the claim-spec grammar could not READ it, so a per-goal
 *    STANDING DRAIN FLEET could not be expressed — `plan`/`tags` approximations miss exactly
 *    the rows a goal-mode agent files straight onto the queue (goal_id set, no plan).
 *
 * 2. THE SILENT-FALLTHROUGH CLASS THE FIRST HALF EXPOSED — the more valuable half.
 *    `valueFor` in claim-spec-match.ts ends in a bare `return null` after its switch, and
 *    `FilterLeaf['field']` is inferred as plain `string` (filterableFieldSchema casts to
 *    `[string, ...string[]]`), so TypeScript CANNOT flag a filterable field that has no
 *    `case`. An unhandled field therefore resolves to null and, per compareScalar, silently
 *    fails every positive predicate — a lane that admits nothing, with nothing erroring.
 *    That is the same two-evaluator divergence family as EI-18654360178824151 / WI-5781,
 *    which is why the loop below is derived from FILTERABLE_ITEM_FIELDS rather than
 *    hand-listing the fields it happens to know about today.
 */
import { describe, it, expect } from 'vitest';
import { matchesClaimSpecFilter, type ClaimSpecSubject } from './claim-spec-match';
import { FILTERABLE_ITEM_FIELDS, RANKABLE_ITEM_FIELDS } from './claim-spec';

/**
 * A subject with EVERY field set to a distinct, non-null value. Written as a typed literal
 * on purpose: adding a required field to `ClaimSpecSubject` breaks this line at COMPILE
 * time, which is the first of the two nudges an author gets.
 */
const FULL_SUBJECT: ClaimSpecSubject = {
  id: 'WI-1234',
  title: 'a title',
  summary: 'a summary',
  kind: 'bug',
  priority: 7,
  tags: ['tag-a'],
  paths: ['packages/x/y.ts'],
  plan: 'some-plan',
  planItem: ['P-001'],
  fleet: 'fleet-a',
  triageGate: 'gate',
  itemClass: 'work',
  age: 1_700_000_000_000,
  riskTier: 'high',
  redundancy: 3,
  estCost: 42,
  assignee: 'su-abc',
  severity: 'major',
  goal: 'goal-9f3',
};

/** The value each field should compare EQUAL to in FULL_SUBJECT. */
const PROBE: Record<string, string | number> = {
  id: 'WI-1234',
  title: 'a title',
  summary: 'a summary',
  kind: 'bug',
  priority: 7,
  tags: 'tag-a',
  paths: 'packages/x/y.ts',
  plan: 'some-plan',
  plan_item: 'P-001',
  fleet: 'fleet-a',
  triage_gate: 'gate',
  item_class: 'work',
  age: 1_700_000_000_000,
  risk_tier: 'high',
  redundancy: 3,
  est_cost: 42,
  assignee: 'su-abc',
  severity: 'major',
  goal: 'goal-9f3',
};

describe('claim-spec `goal` field (WI-37711)', () => {
  it('is filterable, so a per-goal drain lane can be expressed', () => {
    expect(FILTERABLE_ITEM_FIELDS).toContain('goal');
  });

  it('is NOT rankable — an opaque goal id has no meaningful order', () => {
    // Same rationale as id/title/severity: a bare sort on an opaque token is a trap, and
    // the SQL side would happily emit `ORDER BY goal_id` if this were allowed.
    expect(RANKABLE_ITEM_FIELDS).not.toContain('goal');
  });

  it('admits an item stamped with the goal, and refuses one stamped with another', () => {
    const leaf = { field: 'goal', op: '=', value: 'goal-9f3' } as const;
    expect(matchesClaimSpecFilter(FULL_SUBJECT, { ...leaf })).toBe(true);
    expect(matchesClaimSpecFilter({ ...FULL_SUBJECT, goal: 'goal-other' }, { ...leaf })).toBe(false);
  });

  it('refuses an UNSTAMPED item on the positive form — the drain-lane case that matters', () => {
    // Most rows carry no goal. A goal-scoped lane must not swallow the whole backlog.
    expect(
      matchesClaimSpecFilter({ ...FULL_SUBJECT, goal: null }, { field: 'goal', op: '=', value: 'goal-9f3' }),
    ).toBe(false);
  });

  it('ADMITS every unstamped row on the negative form — the WI-5181 hazard, pinned deliberately', () => {
    // This is not a bug being blessed; it is the documented null semantics (compareScalar
    // returns true for `!=` on an absent field, mirroring SQL's IS DISTINCT FROM). It is
    // pinned so the hazard stays VISIBLE: a lane authored as `not goal = X` inherits the
    // entire unstamped backlog, which is why the mode contract prescribes the POSITIVE form.
    expect(
      matchesClaimSpecFilter({ ...FULL_SUBJECT, goal: null }, { field: 'goal', op: '!=', value: 'goal-9f3' }),
    ).toBe(true);
  });

  it('does not treat a negative predicate as an ownership fence for another active goal', () => {
    // `goal != mine` admits a row belonging to a different goal as well as NULL rows.
    // A negative leaf is therefore suitable only inside a measured exclusion fence that
    // names the active-goal set; it is not a replacement for `goal = mine`.
    expect(
      matchesClaimSpecFilter(
        { ...FULL_SUBJECT, goal: 'goal-other' },
        { field: 'goal', op: '!=', value: 'goal-9f3' },
      ),
    ).toBe(true);
  });

  it('supports `in` so one lane can drain several goals', () => {
    expect(
      matchesClaimSpecFilter(FULL_SUBJECT, { field: 'goal', op: 'in', value: ['goal-9f3', 'goal-zzz'] }),
    ).toBe(true);
    expect(
      matchesClaimSpecFilter(FULL_SUBJECT, { field: 'goal', op: 'in', value: ['goal-aaa', 'goal-zzz'] }),
    ).toBe(false);
  });
});

describe('every filterable field is actually resolvable by the JS evaluator', () => {
  /**
   * THE RECURRENCE GUARD. Derived from the grammar, so a field added to ITEM_FIELDS without a
   * `case` in `valueFor` fails HERE — naming the field — instead of shipping a lane that
   * silently admits nothing. `goal` is only the instance that revealed the gap.
   */
  it('resolves a non-null value for each of FILTERABLE_ITEM_FIELDS', () => {
    const unresolved = FILTERABLE_ITEM_FIELDS.filter(
      (field) => !matchesClaimSpecFilter(FULL_SUBJECT, { field, op: '=', value: PROBE[field] }),
    );
    expect(
      unresolved,
      `these filterable fields did not resolve — each is almost certainly missing a "case '<field>':" ` +
        `in valueFor() (claim-spec-match.ts), which makes any lane filtering on it admit NOTHING, silently`,
    ).toEqual([]);
  });

  it('has a probe value for every filterable field (so the guard above cannot pass vacuously)', () => {
    // Without this, a new field with no PROBE entry would compare against `undefined` and the
    // loop's failure would read as a missing `case` rather than a missing probe.
    expect(FILTERABLE_ITEM_FIELDS.filter((f) => PROBE[f] === undefined)).toEqual([]);
  });
});
