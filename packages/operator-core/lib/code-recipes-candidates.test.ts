/**
 * code-recipes-candidates.test.ts — pure-logic unit tests for the Phase-3 graduation
 * scorer's D-007 name-collision damp (recipes-reuse-activation-2026-06-22 P-001 / Part A).
 *
 * No PG and no populated tool registry needed: the tool-name → recipe-id slug lookup is
 * pure, so the collision FIX is asserted directly here. The reuse FLOOR is covered
 * end-to-end (against real run-logs) in code-recipes-candidates.integration.test.ts.
 *
 * Regression guard for the original bug: the redundancy check compared a recipe id (a
 * kebab slug) against the RAW `ns:verb` tool names, which can never be equal — so the
 * "don't regenerate an existing tool" damp never fired. The slug set fixes it.
 */
import { describe, expect, it } from 'vitest';
import { slugifyToolName, existingToolSlugSet, recipePromotionScore } from './code-recipes-candidates';
import { compareDemandRank } from './demand-score';

it('OUTCOME-P-003', () => {
  const corpus = [
    { id: 'b', runCount: 12, distinctAgents: 5, successRate: 1, toolCount: 3, redundant: false },
    { id: 'a', runCount: 12, distinctAgents: 5, successRate: 1, toolCount: 3, redundant: false },
    { id: 'solo', runCount: 3, distinctAgents: 1, successRate: 1, toolCount: 2, redundant: false },
    { id: 'trivial', runCount: 100, distinctAgents: 8, successRate: 1, toolCount: 1, redundant: true },
  ];
  const replay = (rows: typeof corpus) => rows.map(row => ({ ...row, score: recipePromotionScore(row) })).sort(compareDemandRank);
  const first = replay(corpus);
  expect(replay([...corpus].reverse())).toEqual(first);
  expect(first.map(row => row.id)).toEqual(['a', 'b', 'solo', 'trivial']);
  expect(first.map(row => row.score)).toEqual([.9527440092751795, .9527440092751795, .4966021492181718, 0]);
});

// Frozen against the pre-extraction four-leg recipe formula (including its FP order).
it('R3-CONTRACT', () => {
  const golden = [
    { runCount: 0, distinctAgents: 0, successRate: 0, toolCount: 3, score: .2 },
    { runCount: 1, distinctAgents: 1, successRate: 1, toolCount: 3, score: .5283010746090859 },
    { runCount: 3, distinctAgents: 1, successRate: 1, toolCount: 2, score: .4966021492181718 },
    { runCount: 12, distinctAgents: 5, successRate: 1, toolCount: 3, score: .9527440092751795 },
    { runCount: 20, distinctAgents: 5, successRate: .5, toolCount: 3, score: .8999999999999999 },
    { runCount: 100, distinctAgents: 8, successRate: .8, toolCount: 4, score: .96 },
  ];
  for (const row of golden) {
    expect(recipePromotionScore({ ...row, redundant: false })).toBe(row.score);
    expect(recipePromotionScore({ ...row, redundant: true }, 1)).toBe(0);
  }
  const hot = { runCount: 12, distinctAgents: 5, successRate: 1, toolCount: 3, redundant: false };
  expect(recipePromotionScore(hot, .6)).toBe(.8939533410626496);
  expect(recipePromotionScore(hot, null)).toBe(.9527440092751795);
  expect(recipePromotionScore(hot, 2)).toBe(recipePromotionScore(hot, 1));
  expect(recipePromotionScore(hot, -1)).toBe(recipePromotionScore(hot, 0));
  // No SQL day/call floor or SQL weights have entered recipe policy.
  expect(recipePromotionScore({ ...hot, runCount: 3, distinctAgents: 1 })).toBeGreaterThan(.45);
  expect(golden.map((row, id) => ({ id, score: recipePromotionScore({ ...row, redundant: false }) }))
    .sort((a, b) => b.score - a.score).map(row => row.id)).toEqual([5, 3, 4, 1, 2, 0]);
});

describe('slugifyToolName', () => {
  it('kebab-cases a ns:verb tool name into the recipe-id (recipeSlug) shape', () => {
    expect(slugifyToolName('plans:set-status')).toBe('plans-set-status');
    expect(slugifyToolName('work_items:set_state')).toBe('work-items-set-state');
    expect(slugifyToolName('coord:send')).toBe('coord-send');
  });
});

describe('existingToolSlugSet — the D-007 name-collision lookup', () => {
  it('indexes the raw name AND its kebab slug, and a recipe id collides via the SLUG (not the raw ns:verb)', () => {
    const { names, slugs } = existingToolSlugSet(['plans:set-status', 'work_items:list', null, undefined, '']);

    // raw names preserved
    expect(names.has('plans:set-status')).toBe(true);

    // THE FIX: a recipe id (a kebab slug) collides via the SLUG set. The original bug
    // was that only the raw `ns:verb` name set existed, which a slug id never matched.
    expect(slugs.has('plans-set-status')).toBe(true);
    expect(slugs.has('work-items-list')).toBe(true);

    // the raw colon'd form is NOT a recipe-id shape, so a recipe id never equals it
    expect(names.has('plans-set-status')).toBe(false);

    // null/empty/undefined skipped
    expect(slugs.size).toBe(2);
  });

  it('a non-colliding recipe id is absent from both sets (the damp does not over-fire)', () => {
    const { names, slugs } = existingToolSlugSet(['plans:set-status', 'work_items:list']);
    const recipeId = 'triage-and-block-stale';
    expect(names.has(recipeId) || slugs.has(recipeId)).toBe(false);
  });

  it('the collision predicate (names.has(id) || slugs.has(id)) fires for a colliding id', () => {
    const { names, slugs } = existingToolSlugSet(['deploy:harness']);
    const collides = (id: string) => names.has(id) || slugs.has(id);
    expect(collides('deploy-harness')).toBe(true); // recipe id maps onto deploy:harness
    expect(collides('deploy-and-announce')).toBe(false); // distinct recipe — no collision
  });
});
