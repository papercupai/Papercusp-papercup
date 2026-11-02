/**
 * spec-pool-preview.test.ts — unit table for evaluateCollapseGuard (WI-5212).
 *
 * The threshold cases below are the REAL numbers from the 2026-07-16/17 incidents, so a
 * future threshold tweak that would have let either starvation through fails loudly here.
 */
import { describe, expect, it } from 'vitest';
import {
  boundedRowEscapeIds,
  collectGuaranteedExclusions,
  evaluateCollapseGuard,
  evaluateGoalFenceGuard,
  evaluateWideningDisclosure,
  filterNodesEqual,
  hasGuaranteedPositiveGoalFence,
  isProvableSuperset,
} from './spec-pool-preview';
import type { FilterNode } from './claim-spec';
import { matchesClaimSpecFilter, type ClaimSpecSubject } from './claim-spec-match';

describe('evaluateCollapseGuard — refusal shapes', () => {
  it('REFUSES matched=0 of a nonempty pool (starvation #1: kind scope with zero rows)', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 321,
      previousMatched: null,
      previousSource: 'default',
      confirm: false,
    });
    expect(v.refuse).toBe(true);
    expect(v.errors[0]).toContain('0 of 321');
    expect(v.errors[0]).toContain('starved-fleet');
  });

  it('REFUSES an authored revision cratering 321 → 3 (near-miss #3: the NULL-poisoned plan fence)', () => {
    const v = evaluateCollapseGuard({
      matched: 3,
      pool: 321,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(true);
    expect(v.errors[0]).toContain('321 to 3');
    expect(v.errors[0]).toContain('EI-13306');
  });

  it('PASSES the healthy rev-6 fence (322 pool, 321 → 308 matched)', () => {
    const v = evaluateCollapseGuard({
      matched: 308,
      pool: 322,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
    expect(v.warning).toBeUndefined();
  });

  it('does NOT refuse an empty pool (0 of 0 = drained backlog, not a starving spec)', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 0,
      previousMatched: null,
      previousSource: 'default',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
  });

  it('does NOT refuse narrowing from the DEFAULT spec (authoring a deliberate lane) — warns instead', () => {
    const v = evaluateCollapseGuard({
      matched: 3,
      pool: 321,
      previousMatched: null,
      previousSource: 'default',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
    expect(v.warning).toContain('narrow lane');
  });

  it('does NOT refuse a revision of a small lane (previous < 20 rows has no meaningful ratio)', () => {
    const v = evaluateCollapseGuard({
      matched: 1,
      pool: 321,
      previousMatched: 10,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
    expect(v.warning).toContain('narrow lane');
  });

  it('boundary: previous=20 → threshold is max(5, ceil(1))=5; matched=4 refuses, matched=5 passes', () => {
    const base = { pool: 321, previousMatched: 20, previousSource: 'authored' as const, confirm: false };
    expect(evaluateCollapseGuard({ ...base, matched: 4 }).refuse).toBe(true);
    expect(evaluateCollapseGuard({ ...base, matched: 5 }).refuse).toBe(false);
  });

  it('confirmCollapse:true overrides BOTH refusal shapes and downgrades to a warning', () => {
    const zero = evaluateCollapseGuard({
      matched: 0,
      pool: 321,
      previousMatched: null,
      previousSource: 'default',
      confirm: true,
    });
    expect(zero.refuse).toBe(false);
    expect(zero.warning).toContain('confirmed by caller');

    const collapse = evaluateCollapseGuard({
      matched: 3,
      pool: 321,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: true,
    });
    expect(collapse.refuse).toBe(false);
    expect(collapse.warning).toContain('confirmed by caller');
  });

  it('confirmCollapse:true on a HEALTHY spec adds no warning (no cry-wolf)', () => {
    const v = evaluateCollapseGuard({
      matched: 300,
      pool: 321,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: true,
    });
    expect(v.refuse).toBe(false);
    expect(v.warning).toBeUndefined();
  });
});

describe('evaluateCollapseGuard — EI-18653814284166347 (superset blindness + no-delta refusal)', () => {
  const planLeaf: FilterNode = { field: 'plan', op: '=', value: 'p2p-release-lane' };
  const tagsLeaf: FilterNode = { field: 'tags', op: '=', value: 'p2p-release' };
  const rev6Filter: FilterNode = { all: [planLeaf] };
  const rev7SupersetFilter: FilterNode = { any: [rev6Filter, tagsLeaf] };

  it('REPRO: rev6→rev7 superset, both matching 0/1211 — the guard used to wrongly refuse this', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 1211,
      previousMatched: 0,
      previousSource: 'authored',
      confirm: false,
      filter: rev7SupersetFilter,
      previousFilter: rev6Filter,
    });
    expect(v.refuse).toBe(false);
  });

  it('defect #1 alone (no filter info supplied): matched=0, previousMatched=0 — no delta, do not refuse', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 1211,
      previousMatched: 0,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
  });

  it('still REFUSES a genuine 0-match FIRST occurrence (previousMatched>0 → real narrowing, not a no-delta case)', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 1211,
      previousMatched: 500,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(true);
  });

  it('defect #2 alone: a provable superset with a HEALTHY previousMatched still short-circuits (never refuses)', () => {
    const v = evaluateCollapseGuard({
      matched: 2,
      pool: 1211,
      previousMatched: 500,
      previousSource: 'authored',
      confirm: false,
      filter: rev7SupersetFilter,
      previousFilter: rev6Filter,
    });
    expect(v.refuse).toBe(false);
  });

  it('does NOT short-circuit an unrelated any:[...] that does not literally contain the incumbent filter', () => {
    const unrelatedAny: FilterNode = { any: [tagsLeaf, { field: 'kind', op: '=', value: 'bug' }] };
    const v = evaluateCollapseGuard({
      matched: 3,
      pool: 1211,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: false,
      filter: unrelatedAny,
      previousFilter: rev6Filter,
    });
    expect(v.refuse).toBe(true); // falls through to the ordinary revision-collapse check
  });
});

describe('evaluateGoalFenceGuard — EI-22389918023611568', () => {
  const goal: FilterNode = { field: 'goal', op: '=', value: 'goal-813959' };
  const kind: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] };

  it('REFUSES a widening replacement that drops an incumbent positive goal fence', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: { all: [goal, kind] },
      candidateFilter: kind,
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict.refuse).toBe(true);
    expect(verdict.errors[0]).toContain('DROPS the incumbent positive goal fence');
    expect(verdict.errors[0]).toContain('confirmGoalFenceDrop:true');
  });

  it('allows a replacement that retains the positive goal predicate', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goal,
      candidateFilter: { all: [goal, kind] },
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict).toEqual({ refuse: false, errors: [] });
  });

  it('does not mistake an OR arm for a guaranteed fence', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goal,
      candidateFilter: { any: [goal, kind] },
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict.refuse).toBe(true);
  });

  it('does not guard first authoring from the DEFAULT lane', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: undefined,
      candidateFilter: kind,
      previousSource: 'default',
      confirm: false,
    });
    expect(verdict).toEqual({ refuse: false, errors: [] });
  });

  it('requires a non-empty positive value for a useful goal fence', () => {
    expect(hasGuaranteedPositiveGoalFence({ field: 'goal', op: '=', value: '' })).toBe(false);
    expect(hasGuaranteedPositiveGoalFence({ field: 'goal', op: 'in', value: [] })).toBe(false);
    expect(hasGuaranteedPositiveGoalFence({ field: 'goal', op: 'in', value: ['', '  '] })).toBe(false);
    expect(hasGuaranteedPositiveGoalFence(goal)).toBe(true);
    expect(hasGuaranteedPositiveGoalFence({ not: goal })).toBe(false);
  });

  it('allows an explicitly acknowledged transition and emits the exclusion warning', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goal,
      candidateFilter: kind,
      previousSource: 'authored',
      confirm: true,
    });
    expect(verdict.refuse).toBe(false);
    expect(verdict.warning).toContain('explicitly confirmed');
    expect(verdict.warning).toContain('EXCLUSION fence');
  });
});

describe('isProvableSuperset / filterNodesEqual', () => {
  const leaf: FilterNode = { field: 'kind', op: '=', value: 'bug' };
  const other: FilterNode = { field: 'tags', op: '=', value: 'p2p' };

  it('filterNodesEqual: identical leaves equal; different field/op/value do not', () => {
    expect(filterNodesEqual(leaf, { ...leaf })).toBe(true);
    expect(filterNodesEqual(leaf, other)).toBe(false);
    expect(filterNodesEqual(leaf, { field: 'kind', op: '!=', value: 'bug' })).toBe(false);
    expect(filterNodesEqual({ field: 'kind', op: 'in', value: ['a', 'b'] }, { field: 'kind', op: 'in', value: ['a', 'b'] })).toBe(true);
    expect(filterNodesEqual({ field: 'kind', op: 'in', value: ['a', 'b'] }, { field: 'kind', op: 'in', value: ['a', 'c'] })).toBe(false);
  });

  it('isProvableSuperset: true when candidate is any:[X, ...] and X equals previous', () => {
    expect(isProvableSuperset({ any: [leaf, other] }, leaf)).toBe(true);
  });

  it('isProvableSuperset: false when candidate is any:[...] but none of its children equal previous', () => {
    expect(isProvableSuperset({ any: [other] }, leaf)).toBe(false);
  });

  it('isProvableSuperset: false when candidate is not an any node at all (e.g. all:[...])', () => {
    expect(isProvableSuperset({ all: [leaf, other] }, leaf)).toBe(false);
  });

  it('isProvableSuperset: recurses into a nested any', () => {
    expect(isProvableSuperset({ any: [{ any: [leaf] }, other] }, leaf)).toBe(true);
  });
});

describe('evaluateWideningDisclosure — WI-38283 (destructive widening drops an exclusion)', () => {
  const kindLeaf: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change'] };
  const p2pFence: FilterNode = { not: { field: 'title', op: 'word', value: 'p2p' } };
  const fenced: FilterNode = { all: [kindLeaf, p2pFence] };

  it('REPRO 2026-07-26: a 31 → 1185 widening that deleted the not:{title p2p} fence is reported', () => {
    const d = evaluateWideningDisclosure({
      matched: 1185,
      previousMatched: 31,
      previousSource: 'authored',
      filter: kindLeaf,
      previousFilter: fenced,
      target: { kind: 'fleet', id: 'nonp2p-drain' },
    });
    expect(d.widened).toBe(true);
    expect(d.droppedExclusions).toHaveLength(1);
    expect(d.warning).toContain('title');
    expect(d.warning).toContain('31 to 1185');
    // The undo half — retention nobody is told about is only half a fix.
    expect(d.warning).toContain('scheduler:get_claim_spec');
    expect(d.warning).toContain('history: 1');
  });

  it('names the FLEET SLUG in the undo pointer, never the fleet sentinel bee key', () => {
    const d = evaluateWideningDisclosure({
      matched: 9,
      previousMatched: 1,
      previousSource: 'authored',
      filter: kindLeaf,
      previousFilter: fenced,
      target: { kind: 'fleet', id: 'nonp2p-drain' },
    });
    expect(d.warning).toContain('fleet: "nonp2p-drain"');
    expect(d.warning).not.toContain('cupId');
  });

  it('uses cupId for a per-cup lane, and never echoes a `harness` key (the read takes workspace)', () => {
    const d = evaluateWideningDisclosure({
      matched: 9,
      previousMatched: 1,
      previousSource: 'authored',
      filter: kindLeaf,
      previousFilter: fenced,
      target: { kind: 'cup', id: 'su-abc' },
    });
    expect(d.warning).toContain('cupId: "su-abc"');
    expect(d.warning).not.toContain('harness');
  });

  it('stays SILENT when the exclusion is retained (no cry-wolf on an ordinary widening)', () => {
    const d = evaluateWideningDisclosure({
      matched: 900,
      previousMatched: 31,
      previousSource: 'authored',
      filter: { all: [{ field: 'kind', op: 'in', value: ['bug', 'change', 'task'] }, p2pFence] },
      previousFilter: fenced,
    });
    expect(d.widened).toBe(true);
    expect(d.droppedExclusions).toEqual([]);
    expect(d.warning).toBeUndefined();
  });

  it('does NOT fire on first authoring from the DEFAULT lane (no incumbent to destroy)', () => {
    const d = evaluateWideningDisclosure({
      matched: 1185,
      previousMatched: null,
      previousSource: 'default',
      filter: kindLeaf,
      previousFilter: undefined,
    });
    expect(d.droppedExclusions).toEqual([]);
    expect(d.warning).toBeUndefined();
  });

  it('THE QUIETER SHAPE: a dropped fence with NO count movement still discloses', () => {
    const d = evaluateWideningDisclosure({
      matched: 31,
      previousMatched: 31,
      previousSource: 'authored',
      filter: kindLeaf,
      previousFilter: fenced,
    });
    expect(d.widened).toBe(false);
    expect(d.droppedExclusions).toHaveLength(1);
    expect(d.warning).toContain('nothing moved yet');
  });
});

describe('evaluateWideningDisclosure — finite exclusion containment (EI-27691326243743909)', () => {
  const first = 'WI-10006055';
  const second = 'EI-27667223632942599';
  const membership = (ids: string[]): FilterNode => ({ field: 'id', op: 'in', value: ids });
  const exclusion = (node: FilterNode): FilterNode => ({ not: node });

  const cases: [string, FilterNode, FilterNode | undefined, boolean][] = [
    ['expanded forbidden set', membership([first]), exclusion(membership([first, second])), false],
    ['reordered equal set with duplicates', membership([first, second]), exclusion(membership([second, first, first])), false],
    ['equality strengthened to membership', { field: 'id', op: '=', value: first }, exclusion(membership([first, second])), false],
    ['singleton membership retained as equality', membership([first]), exclusion({ field: 'id', op: '=', value: first }), false],
    ['numeric membership strengthened', { field: 'priority', op: '=', value: 1 }, exclusion({ field: 'priority', op: 'in', value: [1, 2] }), false],
    ['weaker forbidden set', membership([first, second]), exclusion(membership([first])), true],
    ['deleted exclusion', membership([first]), undefined, true],
    ['same values on a different field', membership([first]), exclusion({ field: 'plan', op: 'in', value: [first] }), true],
    ['exclusion bypassed by another OR arm', membership([first]), { any: [exclusion(membership([first, second])), { field: 'kind', op: '=', value: 'bug' }] }, true],
    ['unsupported compound equivalence', { any: [{ field: 'id', op: '=', value: first }, { field: 'id', op: '=', value: second }] }, exclusion(membership([first, second])), true],
    ['unsupported changed glob', { field: 'title', op: 'glob', value: '*p2p*' }, exclusion({ field: 'title', op: 'glob', value: '*' }), true],
    ['unchanged unsupported glob', { field: 'title', op: 'glob', value: '*p2p*' }, exclusion({ field: 'title', op: 'glob', value: '*p2p*' }), false],
    ['numeric string coercion is not set containment', { field: 'priority', op: '=', value: '01' }, exclusion({ field: 'priority', op: 'in', value: ['01', '02'] }), true],
  ];

  it.each(cases)('%s', (_name, previous, candidate, dropped) => {
    const disclosure = evaluateWideningDisclosure({
      matched: 3,
      previousMatched: 3,
      previousSource: 'authored',
      previousFilter: exclusion(previous),
      filter: candidate,
    });
    expect(disclosure.widened).toBe(false);
    expect(disclosure.droppedExclusions.map(({ node }) => node)).toEqual(dropped ? [previous] : []);
    if (dropped) expect(disclosure.warning).toContain('DROPS 1 exclusion');
    else expect(disclosure.warning).toBeUndefined();
  });

  it('the reported custody-fence expansion still rejects the original forbidden item', () => {
    const subject = { id: first } as ClaimSpecSubject;
    const previous = exclusion(membership([first]));
    const candidate = exclusion(membership([first, second, 'WI-6554700010044749']));
    expect(matchesClaimSpecFilter(subject, previous)).toBe(false);
    expect(matchesClaimSpecFilter(subject, candidate)).toBe(false);
    expect(evaluateWideningDisclosure({
      matched: 2, previousMatched: 5, previousSource: 'authored', previousFilter: previous, filter: candidate,
    }).droppedExclusions).toEqual([]);
  });

  it('numeric string equality and membership can admit different rows', () => {
    const subject = { priority: 1 } as ClaimSpecSubject;
    const previous = exclusion({ field: 'priority', op: '=', value: '01' });
    const candidate = exclusion({ field: 'priority', op: 'in', value: ['01', '02'] });
    expect(matchesClaimSpecFilter(subject, previous)).toBe(false);
    expect(matchesClaimSpecFilter(subject, candidate)).toBe(true);
  });
});

describe('collectGuaranteedExclusions — conjunctive position only', () => {
  const excl: FilterNode = { not: { field: 'title', op: 'word', value: 'p2p' } };

  it('collects a root not:', () => {
    expect(collectGuaranteedExclusions(excl)).toHaveLength(1);
  });

  it('collects a not: nested through all chains', () => {
    expect(
      collectGuaranteedExclusions({ all: [{ field: 'kind', op: '=', value: 'bug' }, { all: [excl] }] }),
    ).toHaveLength(1);
  });

  it('does NOT collect a not: inside an any arm — a sibling arm can admit the same rows', () => {
    expect(collectGuaranteedExclusions({ any: [excl, { field: 'kind', op: '=', value: 'bug' }] })).toEqual([]);
  });

  it('a bare leaf guarantees no exclusion', () => {
    expect(collectGuaranteedExclusions({ field: 'kind', op: '=', value: 'bug' })).toEqual([]);
  });

  it('undefined filter is empty, not a crash', () => {
    expect(collectGuaranteedExclusions(undefined)).toEqual([]);
  });
});

describe('evaluateGoalFenceGuard — fence-preserving row escape (WI-10005683)', () => {
  const goal: FilterNode = { field: 'goal', op: '=', value: 'goal-60d3a8' };
  const kind: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] };
  const idLeaf: FilterNode = { field: 'id', op: '=', value: 'WI-10005683' };

  it('ALLOWS the fence-preserving widen shape and discloses the rows it admits', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goal,
      candidateFilter: { any: [goal, idLeaf] },
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict.refuse).toBe(false);
    expect(verdict.errors).toEqual([]);
    expect(verdict.warning).toContain('RETAINS the incumbent positive goal fence');
    expect(verdict.warning).toContain('WI-10005683');
    // The escape must NOT be routed through the fence-DROP acknowledgement: that flag
    // asserts the fence was dropped, which is false for this shape.
    expect(verdict.warning).toContain('without confirmGoalFenceDrop:true');
  });

  it('CALIBRATION: still REFUSES a class widen, so the carve-out is id-bounded not any-permissive', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goal,
      candidateFilter: { any: [goal, kind] },
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict.refuse).toBe(true);
    expect(verdict.errors[0]).toContain('DROPS the incumbent positive goal fence');
  });

  it('does NOT loosen hasGuaranteedPositiveGoalFence — an id arm is still not a goal fence', () => {
    // Load-bearing: evaluateGoalFenceGuard reuses this same predicate for the INCUMBENT
    // check, where treating an id leaf as a fence would call an id-only lane goal-scoped.
    expect(hasGuaranteedPositiveGoalFence({ any: [goal, idLeaf] })).toBe(false);
    expect(hasGuaranteedPositiveGoalFence(idLeaf)).toBe(false);
  });

  it('boundedRowEscapeIds: needs a surviving fence AND every other arm id-bounded', () => {
    expect(boundedRowEscapeIds({ any: [goal, idLeaf] })).toEqual(['WI-10005683']);
    expect(
      boundedRowEscapeIds({ any: [goal, { field: 'id', op: 'in', value: ['WI-1', 'WI-2'] }] }),
    ).toEqual(['WI-1', 'WI-2']);
    // No surviving fence: that is a fence DROP, not an escape.
    expect(boundedRowEscapeIds({ any: [idLeaf] })).toBeNull();
    // A single class arm disqualifies the whole node.
    expect(boundedRowEscapeIds({ any: [goal, idLeaf, kind] })).toBeNull();
    // Vacuous id selectors name no row, so they are not an escape.
    expect(boundedRowEscapeIds({ any: [goal, { field: 'id', op: '=', value: '   ' }] })).toBeNull();
    expect(boundedRowEscapeIds({ any: [goal, { field: 'id', op: 'in', value: [] }] })).toBeNull();
    // Not an `any` node at all.
    expect(boundedRowEscapeIds(goal)).toBeNull();
    expect(boundedRowEscapeIds(undefined)).toBeNull();
  });
});
