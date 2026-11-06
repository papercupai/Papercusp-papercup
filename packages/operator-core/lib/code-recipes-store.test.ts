/**
 * code-recipes-store.test.ts — pure-logic unit tests for the store's reuse-surface filter
 * (recipes-reuse-activation-2026-06-22 P-004). The PG CRUD is covered by
 * code-recipes-store.integration.test.ts; this pins `isLowValueRecipe` — the predicate
 * that keeps ≤1-tool / auto-titled throwaways out of the code:run `similarRecipes` nudge
 * and the default `recipes:list` — with no PG.
 */
import { describe, expect, it } from 'vitest';
import { isLowValueRecipe, recipeRunChoice } from './code-recipes-store';

it('keeps system/hook choice separate from verified agent choice and unknown attribution', () => {
  expect(recipeRunChoice({ source: 'event-reaction', ownerId: 'agent-trigger' })).toBe('system');
  expect(recipeRunChoice({ source: 'omp-hook-session', ownerId: 'system:sweep' })).toBe('system');
  expect(recipeRunChoice({ source: 'omp-hook-session', ownerId: 'hook:collector' })).toBe('hook');
  expect(recipeRunChoice({ source: 'omp-hook-session', ownerId: 'agent-session' })).toBe('agent');
  expect(recipeRunChoice({ source: 'static-client', ownerId: 'remembered-agent-name' })).toBe('unknown');
  expect(recipeRunChoice({})).toBe('unknown');
});

describe('isLowValueRecipe', () => {
  it('flags ≤1-tool recipes (thin wrappers over the primitive)', () => {
    expect(isLowValueRecipe({ toolsUsed: [], title: 'No tools' })).toBe(true);
    expect(isLowValueRecipe({ toolsUsed: ['plans:list'], title: 'Just list plans' })).toBe(true);
    expect(isLowValueRecipe({ toolsUsed: null, title: 'Null tools' })).toBe(true);
    expect(isLowValueRecipe({ toolsUsed: undefined, title: 'Undefined tools' })).toBe(true);
  });

  it('flags auto-derived fallback titles ("recipe: <tools>") even on multi-tool scripts', () => {
    expect(
      isLowValueRecipe({
        toolsUsed: ['plans:add-item', 'plans:set-status'],
        title: 'recipe: plans:add-item + plans:set-status',
      }),
    ).toBe(true);
    // case-insensitive on the auto-title marker
    expect(isLowValueRecipe({ toolsUsed: ['a', 'b'], title: 'Recipe: Capitalized Variant' })).toBe(true);
  });

  it('KEEPS a genuine multi-tool recipe with an authored title', () => {
    expect(
      isLowValueRecipe({
        toolsUsed: ['work_items:list', 'work_items:set_state'],
        title: 'Triage and block stale items',
      }),
    ).toBe(false);
    // "recipe" only triggers as the leading auto-title marker, not anywhere in the title
    expect(isLowValueRecipe({ toolsUsed: ['a', 'b'], title: 'Author the release recipe plan' })).toBe(false);
  });
});
