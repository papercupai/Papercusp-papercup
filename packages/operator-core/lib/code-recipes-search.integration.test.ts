/**
 * code-recipes-search.integration.test.ts — the hybrid dedup/search over
 * `harness_shared.code_recipes` (code-recipes-2026-06-21 Phase 2, P-004 / P-011)
 * against real Postgres.
 *
 * Mirrors code-recipes-store.integration.test.ts: the module is transport-agnostic
 * (takes the `sql` handle), so we pass the org-fixture's admin (RLS-bypass) client.
 * Validates: a same-use-case query ranks the right recipe top, the structural
 * tool-set-overlap (Jaccard) signal boosts a same-tool recipe, and excludeId is
 * honored. No live embedder — the BM25 lexical leg + the
 * pre-computed-embedding cosine leg + the structural leg carry the ranking.
 *
 * Part of code-recipes-2026-06-21 Phase 2 (P-004, integration tier).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { runHybridSearch } from '@papercusp/search';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertRecipe } from './code-recipes-store';
import { codeRecipesSource, searchSimilarRecipes } from './code-recipes-search';
import { stampEmbedderMode } from './search/embedder-mode-registry';
import { EMBEDDING_FLOOR_GEMMA } from './search/prose-min-score';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { resolveProseProfileSelection } from './search/prose-vector-dims';

const { createOrgTestDb } = await import('../test/_org-test-db');

/**
 * A deterministic 768-dim unit-ish embedding seeded by a scalar so two recipes
 * sharing a seed are cosine-close and a different seed is far. (The cosine leg
 * orders by `embedding <=> qVec`; identical vectors ⇒ distance 0.)
 */
const seededEmbedding = (seed: number): number[] => Array.from({ length: 768 }, (_, i) => Math.sin(seed + i * 0.01));
const basisEmbedding = (index: number): number[] =>
  Array.from({ length: 768 }, (_, i) => (i === index ? 1 : 0));
const profiledEmbedding = (embedding: number[]) => ({
  embedding,
  embeddingMode: 'gemma' as const,
  embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!,
});

describe('code_recipes hybrid search (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    // The migrated org fixture includes the profile schema at its current shape.
    // Replaying 1154 after 1327 would ALTER the personal_documents compatibility view.
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  }, 60_000);

  it('ranks the same-use-case recipe top (lexical + structural)', async () => {
    const ws = 'ws-crs-rank';
    const hive = 'alpha';
    // The target: triage stale work-items, calls work_items:list + set_state.
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'triage-stale-work-items',
      title: 'Triage stale work-items',
      description: 'list open work-items then mark stale ones blocked',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
      ...profiledEmbedding(seededEmbedding(1)),
    });
    // A decoy on a totally different topic + tool-set.
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'announce-deploy',
      title: 'Announce a deploy to the hive',
      description: 'post a coord message when a release ships',
      script: 's',
      toolsUsed: ['coord:send'],
      ...profiledEmbedding(seededEmbedding(50)),
    });
    // A weak lexical neighbor (shares "work-items" but a different action + tools).
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'count-work-items',
      title: 'Count open work-items',
      description: 'tally how many work-items are open',
      script: 's',
      toolsUsed: ['work_items:list'],
      ...profiledEmbedding(seededEmbedding(40)),
    });

    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'Triage stale work-items',
      description: 'find stale work-items and block them',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
      ...profiledEmbedding(seededEmbedding(1)),
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('triage-stale-work-items');
    expect(results[0].similarity).toBeGreaterThan(0);
    // the off-topic decoy should not outrank the work-items recipes
    const decoyRank = results.findIndex((r) => r.id === 'announce-deploy');
    const targetRank = results.findIndex((r) => r.id === 'triage-stale-work-items');
    if (decoyRank !== -1) expect(targetRank).toBeLessThan(decoyRank);
  });

  it('applies the calibrated Gemma floor to the recipe embedding leg', async () => {
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'gemma-floor-regression-zircon',
      title: 'Calibrated recipe anchor',
      description: 'A reusable script with a deliberately orthogonal vector',
      script: 's',
      toolsUsed: [],
      ...profiledEmbedding(basisEmbedding(0)),
    });

    const embedder = async () => basisEmbedding(1);
    stampEmbedderMode(embedder, 'gemma', EMBEDDER_DIM_SPECS.gemma.profileId);
    const result = await runHybridSearch([codeRecipesSource], {
      sql: db.adminSql,
      query: 'quasar zyxw',
      workspaceId: '',
      scopeFilter: null,
      limit: 20,
      mode: 'hybrid',
      embedder,
    });

    expect(result.applied).toMatchObject({
      minScore: { embeddings: EMBEDDING_FLOOR_GEMMA },
      policyRegistered: true,
    });
    expect(result.legs.semantic.floored).toBeGreaterThan(0);
    expect(result.results.some((row) => row.source_id === 'gemma-floor-regression-zircon')).toBe(false);
  });

  it('filters by exact profile even when mode and width match, while accepting current-mode legacy rows', async () => {
    const id = 'recipe-profile-identity-control';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id,
      title: 'Exact profile identity control',
      description: 'semantic-only control row',
      script: 'return 1;',
      toolsUsed: ['state:read', 'facts:list'],
      ...profiledEmbedding(basisEmbedding(0)),
    });
    const embedder = async () => basisEmbedding(0);
    stampEmbedderMode(embedder, 'gemma', EMBEDDER_DIM_SPECS.gemma.profileId);

    await db.adminSql`
      UPDATE harness_shared.code_recipes
         SET embedding_mode = 'gemma',
             embedding_profile = ${EMBEDDER_DIM_SPECS.openai.profileId}
       WHERE id = ${id}`;
    const mismatch = await runHybridSearch([codeRecipesSource], {
      sql: db.adminSql,
      query: 'semantic-only-zqxj',
      workspaceId: '',
      scopeFilter: null,
      limit: 10,
      mode: 'embeddings',
      embedder,
    });
    expect(mismatch.results.some((row) => row.source_id === id)).toBe(false);

    await db.adminSql`
      UPDATE harness_shared.code_recipes
         SET embedding_profile = NULL
       WHERE id = ${id}`;
    const legacy = await runHybridSearch([codeRecipesSource], {
      sql: db.adminSql,
      query: 'semantic-only-zqxj',
      workspaceId: '',
      scopeFilter: null,
      limit: 10,
      mode: 'embeddings',
      embedder,
    });
    expect(legacy.results.some((row) => row.source_id === id)).toBe(true);
  });

  it('keeps a recipe name discoverable when the intent query contains extra terms', async () => {
    // No embedding: this isolates lexical recall. The stored recipe shares the
    // name terms, but not every extra term in the free-form intent query.
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'lexical-anchor-zircon',
      title: 'release:verify-provenance',
      description: 'check the release ship gate',
      script: 's',
      toolsUsed: [],
      embedding: null,
    });

    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'release:verify-provenance',
      description: 'install vm preflight and relaunch',
      toolsUsed: [],
      embedding: null,
      limit: 10,
    });

    expect(results.find((row) => row.id === 'lexical-anchor-zircon')).toBeDefined();
  });

  it('the structural tool-set overlap boosts a same-tool recipe over a lexical-only match', async () => {
    const ws = 'ws-crs-struct';
    const hive = 'alpha';
    // Same exact tool-set as the query, but no lexical/embedding head-start.
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'same-tools',
      title: 'Sweep items',
      description: 'sweep things',
      script: 's',
      toolsUsed: ['plans:set-status', 'plans:add-item'],
      ...profiledEmbedding(seededEmbedding(5)),
    });
    // Lexically matches the query words but a disjoint tool-set.
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'lexical-only',
      title: 'Manage a plan and its items',
      description: 'manage plan items',
      script: 's',
      toolsUsed: ['coord:send'],
      ...profiledEmbedding(seededEmbedding(60)),
    });

    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'Manage a plan and its items',
      description: 'manage plan items',
      toolsUsed: ['plans:set-status', 'plans:add-item'],
      ...profiledEmbedding(seededEmbedding(5)),
      limit: 5,
    });

    const sameRank = results.findIndex((r) => r.id === 'same-tools');
    const lexRank = results.findIndex((r) => r.id === 'lexical-only');
    expect(sameRank).not.toBe(-1);
    // the structural twin (full Jaccard=1) outranks the disjoint-tool lexical match
    if (lexRank !== -1) expect(sameRank).toBeLessThan(lexRank);
  });

  it('honors excludeId (a re-run never matches itself)', async () => {
    const ws = 'ws-crs-exclude';
    const hive = 'alpha';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'self',
      title: 'Self recipe',
      description: 'a recipe',
      script: 's',
      toolsUsed: ['coord:send'],
      ...profiledEmbedding(seededEmbedding(7)),
    });
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'other',
      title: 'Self recipe',
      description: 'a recipe',
      script: 's',
      toolsUsed: ['coord:send'],
      ...profiledEmbedding(seededEmbedding(7)),
    });
    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'Self recipe',
      description: 'a recipe',
      toolsUsed: ['coord:send'],
      ...profiledEmbedding(seededEmbedding(7)),
      excludeId: 'self',
      limit: 5,
    });
    expect(results.find((r) => r.id === 'self')).toBeUndefined();
    expect(results.find((r) => r.id === 'other')).toBeDefined();
  });

  it('revalidates recipe status after ranking so a concurrent merge cannot be recommended', async () => {
    const id = 'merged-during-search';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id,
      title: 'Merged during checkpoint monitor search',
      description: 'inspect the current checkpoint monitor state',
      script: 'return 1;',
      toolsUsed: [],
      ...profiledEmbedding(seededEmbedding(73)),
    });

    const baseSql = db.adminSql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
    let invalidated = false;
    const racingSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(' ');
      if (!invalidated && /SELECT id, title, description, script[\s\S]*FROM harness_shared\.code_recipes/.test(query)) {
        invalidated = true;
        return (async () => {
          await db.adminSql`
            UPDATE harness_shared.code_recipes
               SET status = 'merged', merged_into = 'checkpoint-monitor-survivor'
             WHERE id = ${id}
          `;
          return baseSql(strings, ...values);
        })();
      }
      return baseSql(strings, ...values);
    }) as unknown as postgres.Sql;

    const results = await searchSimilarRecipes(racingSql, {
      title: 'Merged during checkpoint monitor search',
      description: 'inspect the current checkpoint monitor state',
      toolsUsed: [],
      ...profiledEmbedding(seededEmbedding(73)),
      limit: 10,
    });

    expect(invalidated).toBe(true);
    expect(results.find((row) => row.id === id)).toBeUndefined();
  });

  it('searches the global recipe corpus', async () => {
    const ws = 'ws-crs-hive';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'in-alpha',
      title: 'Deploy the service',
      description: 'deploy it',
      script: 's',
      toolsUsed: ['deploy:harness'],
      ...profiledEmbedding(seededEmbedding(9)),
    });
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'in-beta',
      title: 'Deploy the service',
      description: 'deploy it',
      script: 's',
      toolsUsed: ['deploy:harness'],
      ...profiledEmbedding(seededEmbedding(9)),
    });
    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'Deploy the service',
      description: 'deploy it',
      toolsUsed: ['deploy:harness'],
      ...profiledEmbedding(seededEmbedding(9)),
      limit: 5,
    });
    expect(results.find((r) => r.id === 'in-alpha')).toBeDefined();
    expect(results.find((r) => r.id === 'in-beta')).toBeDefined();
  });

  it('returns the blended fields (title/description/runCount/similarity)', async () => {
    const ws = 'ws-crs-fields';
    const hive = 'alpha';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'fielded',
      title: 'Fielded recipe title',
      description: 'a thorough description here',
      script: 's',
      toolsUsed: ['coord:send'],
      ...profiledEmbedding(seededEmbedding(11)),
    });
    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'Fielded recipe title',
      description: 'a thorough description here',
      toolsUsed: ['coord:send'],
      ...profiledEmbedding(seededEmbedding(11)),
      limit: 5,
    });
    const hit = results.find((r) => r.id === 'fielded');
    expect(hit).toBeDefined();
    expect(hit?.title).toBe('Fielded recipe title');
    expect(hit?.description).toBe('a thorough description here');
    expect(hit?.runCount).toBe(0);
    expect(hit?.similarity).toBeGreaterThan(0);
    expect(hit?.similarity).toBeLessThanOrEqual(1);
  });

  it('fails closed on entity-mismatched recipes and returns a revision-preserving runArgs continuation (P-008)', async () => {
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'authority-wi-4655',
      title: 'Read exact authority-bound item',
      description: 'load the exact work item for this lane',
      script: `return await tools.workItems.get({ id: 'WI-4655', harness: 'papercusp' });`,
      toolsUsed: ['work_items:get'],
      ...profiledEmbedding(seededEmbedding(31)),
    });
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'authority-wi-other',
      title: 'Read exact authority-bound item',
      description: 'load the exact work item for this lane',
      script: `return await tools.workItems.get({ id: 'WI-other', harness: 'papercusp' });`,
      toolsUsed: ['work_items:get'],
      ...profiledEmbedding(seededEmbedding(31)),
    });

    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'Read exact authority-bound item',
      description: 'load the exact work item for this lane',
      toolsUsed: ['work_items:get'],
      ...profiledEmbedding(seededEmbedding(31)),
      recommendationContext: { harness: 'papercusp', items: ['WI-4655'] },
      limit: 10,
    });

    expect(results.find((row) => row.id === 'authority-wi-other')).toBeUndefined();
    const matched = results.find((row) => row.id === 'authority-wi-4655');
    expect(matched).toMatchObject({
      authorityRefs: { harnesses: ['papercusp'], items: ['WI-4655'] },
      runArgs: {
        id: 'authority-wi-4655',
        authority: { version: 1, context: { harness: 'papercusp', items: ['WI-4655'] } },
      },
    });
    expect(matched?.authority.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not recommend recipes with stale coordination sender/cursor literals', async () => {
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'stale-coordination-cursor',
      title: 'Retry wake leader inbox',
      description: 'check the leader reply after a scheduler wake',
      script: `return await tools.coord.inbox({
        from: 'su-stale-leader',
        since_ts: '2026-07-10T16:05:00.000Z',
      });`,
      toolsUsed: ['coord:inbox'],
      ...profiledEmbedding(seededEmbedding(41)),
    });

    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'Retry wake leader inbox',
      description: 'check the leader reply after a scheduler wake',
      toolsUsed: ['coord:inbox'],
      ...profiledEmbedding(seededEmbedding(41)),
      recommendationContext: { harness: 'papercusp' },
      limit: 10,
    });

    expect(results.find((row) => row.id === 'stale-coordination-cursor')).toBeUndefined();
  });

  it('does not recommend recipes that write caller-scoped loop carry state', async () => {
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'stale-loop-carry',
      title: 'Persist historical fleet wake note',
      description: 'save the previous leader tick as the current loop checkpoint',
      script: `return await tools.loop.checkpoint({
        did: 'historical fleet work',
        left: 'historical next step',
        insight: 'historical conclusion',
        next: 'historical wake action',
      });`,
      toolsUsed: ['loop:checkpoint'],
      ...profiledEmbedding(seededEmbedding(51)),
    });

    const results = await searchSimilarRecipes(db.adminSql, {
      title: 'Persist historical fleet wake note',
      description: 'save the previous leader tick as the current loop checkpoint',
      toolsUsed: ['loop:checkpoint'],
      ...profiledEmbedding(seededEmbedding(51)),
      recommendationContext: { fleet: 'current-fleet', harness: 'papercusp' },
      limit: 10,
    });

    expect(results.find((row) => row.id === 'stale-loop-carry')).toBeUndefined();
  });
});
