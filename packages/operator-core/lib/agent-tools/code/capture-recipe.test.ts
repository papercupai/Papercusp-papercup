/**
 * capture-recipe.test.ts — the PURE code:run → recipe capture helpers
 * (code-recipes-2026-06-21 Phase 1, P-003): slug derivation, the always-derive
 * fallback title/description (so a recipe is ALWAYS saveable), and tools_used
 * extraction via the parse-check ref resolver mapped to canonical ns:verb.
 *
 * The PG/embedder side of captureRecipe is exercised through the store
 * integration test + the run.test.ts capture-trigger test; this file pins the
 * deterministic derivation logic with no PG.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureParseCheckReady } from '@papercusp/tooldef';
import {
  recipeSlug,
  recipeId,
  deriveTitleDescription,
  extractToolsUsed,
  selectRecipeCaptureTarget,
} from './capture-recipe';

// extractToolsUsed → checkScript uses a lazy-loaded TS compiler (kept out of the
// eager client bundle) — warm it once before the suite.
beforeAll(async () => { await ensureParseCheckReady(); });

const mkTool = (name: string) => ({ expose: { mcp: { name } } }) as never;
const TOOLS = [
  mkTool('work_items:list'),
  mkTool('work_items:get'),
  mkTool('coord:wake-queue'),
  mkTool('plans:set-status'),
];

describe('recipeSlug', () => {
  it('kebab-cases a title into a stable slug', () => {
    expect(recipeSlug('Triage Stale Work-Items!')).toBe('triage-stale-work-items');
    expect(recipeSlug('  leading/trailing  ')).toBe('leading-trailing');
  });
});

describe('recipeId — explicit title is the stable dedup key; auto-derived gets a content-hash suffix (P-003)', () => {
  it('uses the bare slug when the agent GAVE a title (the intended explicit dedup key)', () => {
    const id = recipeId('Triage Stale Items', 'desc', 'return 1;', { title: 'Triage Stale Items' });
    expect(id).toBe('triage-stale-items');
    // re-deriving with the same explicit title is stable (upserts in place)
    expect(recipeId('Triage Stale Items', 'desc', 'return 2;', { title: 'Triage Stale Items' })).toBe(
      'triage-stale-items',
    );
  });

  it('suffixes a content-hash when the title was AUTO-DERIVED (no given.title)', () => {
    const id = recipeId('recipe: a + b', 'd', 'return 1;', {});
    expect(id).toMatch(/^recipe-a-b-[0-9a-f]{8}$/);
  });

  it('two DIFFERENT auto-derived scripts with the SAME fallback title get DISTINCT ids (no clobber)', () => {
    const idA = recipeId('recipe: a + b', 'd', 'return 1;', {});
    const idB = recipeId('recipe: a + b', 'd', 'return 2;', {});
    expect(idA).not.toBe(idB); // different script ⇒ different hash suffix
    // same script ⇒ same id (deterministic)
    expect(recipeId('recipe: a + b', 'd', 'return 1;', {})).toBe(idA);
  });
});

describe('extractToolsUsed', () => {
  it('maps dotted refs back to canonical ns:verb (sorted, de-duped)', () => {
    const used = extractToolsUsed(
      `const o = await tools.work_items.list({});
       for (const w of o.items) await tools.work_items.get({ id: w.id });
       await tools.coord.wakeQueue();`,
      TOOLS,
    );
    expect(used).toEqual(['coord:wake-queue', 'work_items:get', 'work_items:list']);
  });

  it('maps a bracket ref with a kebab-case verb back to its canonical tool name', () => {
    const used = extractToolsUsed(
      `await tools.capability["git-evidence"]({ path: 'packages/operator-core' });`,
      [...TOOLS, mkTool('capability:git-evidence')],
    );
    expect(used).toEqual(['capability:git-evidence']);
  });

  it('resolves the tools.call() escape-hatch full name', () => {
    const used = extractToolsUsed(`await tools.call('plans:set-status', { id: 'P-1' });`, TOOLS);
    expect(used).toEqual(['plans:set-status']);
  });

  it('respects the allow-list (a ref outside it is not counted)', () => {
    const used = extractToolsUsed(
      `await tools.work_items.list({}); await tools.plans.setStatus({});`,
      TOOLS,
      new Set(['work_items:list']),
    );
    expect(used).toEqual(['work_items:list']);
  });

  it('returns [] for a tool-free script', () => {
    expect(extractToolsUsed('return 1 + 1;', TOOLS)).toEqual([]);
  });
});

describe('deriveTitleDescription — always produces a saveable title + description', () => {
  it('uses agent-supplied title/description when given', () => {
    const r = deriveTitleDescription('return 1;', ['coord:send'], {
      title: 'My recipe',
      description: 'does a thing',
    });
    expect(r.title).toBe('My recipe');
    expect(r.description).toBe('does a thing');
  });

  it('falls back to the first // comment for the title', () => {
    const r = deriveTitleDescription(
      `// triage stale items\nawait tools.work_items.list({});`,
      ['work_items:list'],
      {},
    );
    expect(r.title).toBe('triage stale items');
    expect(r.description).toBe('auto-captured recipe: calls work_items:list');
  });

  it('falls back to the tool-set for the title when there is no comment', () => {
    const r = deriveTitleDescription(
      `await tools.work_items.list({}); await tools.coord.wakeQueue();`,
      ['coord:wake-queue', 'work_items:list'],
      {},
    );
    expect(r.title).toBe('recipe: coord:wake-queue + work_items:list');
    expect(r.description).toBe('auto-captured recipe: calls coord:wake-queue, work_items:list');
  });

  it('degrades to "untitled recipe" / "no tools" for a tool-free, comment-free script', () => {
    const r = deriveTitleDescription('return 1;', [], {});
    expect(r.title).toBe('untitled recipe');
    expect(r.description).toBe('auto-captured recipe: calls no tools');
    expect(recipeSlug(r.title)).toBe('untitled-recipe'); // still produces a valid slug
  });
});

describe('selectRecipeCaptureTarget (P-014)', () => {
  it('prefers an exact structural-fingerprint match over stronger advisory candidates', () => {
    expect(selectRecipeCaptureTarget({
      proposedId: 'new-candidate',
      exactRecipeId: 'exact-candidate',
      similarRecipes: [{ id: 'near-candidate', similarity: 0.99 }],
    })).toEqual({
      id: 'exact-candidate',
      disposition: 'exact-fingerprint-reuse',
      matchedSimilarity: null,
    });
  });

  it('reuses the strongest deterministic near match at the existing 0.8 threshold', () => {
    expect(selectRecipeCaptureTarget({
      proposedId: 'new-candidate',
      similarRecipes: [
        { id: 'z-candidate', similarity: 0.8 },
        { id: 'a-candidate', similarity: 0.8 },
        { id: 'below', similarity: 0.799 },
      ],
    })).toEqual({
      id: 'a-candidate',
      disposition: 'near-similarity-reuse',
      matchedSimilarity: 0.8,
    });
  });

  it('creates the proposed candidate when no exact or qualifying near match exists', () => {
    expect(selectRecipeCaptureTarget({
      proposedId: 'new-candidate',
      similarRecipes: [{ id: 'below', similarity: 0.79 }],
    })).toEqual({
      id: 'new-candidate',
      disposition: 'created',
      matchedSimilarity: null,
    });
  });
});
