/**
 * code-recipes-candidates.integration.test.ts — the DETERMINISTIC Phase-3
 * graduation signal layer (code-recipes-2026-06-21 Phase 3, P-013 / D-017) against
 * real Postgres.
 *
 * Mirrors code-recipes-search.integration.test.ts: the module is transport-agnostic
 * (takes the `sql` handle), so we pass the org-fixture's admin (RLS-bypass) client.
 * Seeds recipes with varying run_count / distinct-agent reuse / tool-count + a
 * near-duplicate pair, then asserts:
 *   (a) the hot multi-tool broadly-reused recipe ranks top of promoteCandidates;
 *   (b) a 1-tool recipe is EXCLUDED as redundant (never a promote candidate);
 *   (c) the near-duplicate pair appears as a mergeCluster.
 *
 * No live embedder — the BM25 lexical leg + the structural tool-set leg carry the
 * merge-cluster similarity (identical text + tools ⇒ full Jaccard ⇒ ≥ 0.8).
 *
 * Part of code-recipes-2026-06-21 Phase 3 (P-013, integration tier).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import type postgres from 'postgres';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { upsertRecipe, recordRecipeRun } from './code-recipes-store';
import { recipeCandidates } from './code-recipes-candidates';
import { PROSE_VECTOR_DIMS, resolveProseProfileSelection } from './search/prose-vector-dims';

const { createOrgTestDb } = await import('../test/_org-test-db');

const seededEmbedding = (seed: number): number[] =>
  Array.from({ length: PROSE_VECTOR_DIMS }, (_, i) => Math.sin(seed + i * 0.01));
const profiledEmbedding = (embedding: number[]) => ({
  embedding,
  embeddingMode: 'gemma' as const,
  embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!,
});

/** Record N runs for a recipe across the given distinct agent owners (round-robin). */
async function seedRuns(
  sql: postgres.Sql,
  recipeId: string,
  workspaceId: string,
  potSlug: string,
  opts: { runs: number; agents: string[]; successes?: number },
): Promise<void> {
  const successes = opts.successes ?? opts.runs;
  for (let i = 0; i < opts.runs; i++) {
    await recordRecipeRun(sql, {
      recipeId,
      workspaceId,
      potSlug,
      agentOwner: opts.agents[i % opts.agents.length],
      agentRole: 'cup',
      success: i < successes,
    });
  }
}

describe('recipeCandidates deterministic signals (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    // The migrated org fixture includes the profile schema at its current shape.
    // Replaying 1154 after 1327 would ALTER the personal_documents compatibility view.
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  }, 60_000);

  it('ranks the hot multi-tool broadly-reused recipe top, excludes the 1-tool wrapper, surfaces the merge cluster', async () => {
    const ws = 'ws-cand-main';
    const hive = 'alpha';

    // ── HOT multi-tool, broadly-reused recipe — should rank TOP of promote. ──────
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'triage-and-block-stale',
      title: 'Triage and block stale work-items',
      description: 'list open work-items, then mark the stale ones blocked',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state', 'work_items:comment'],
      ...profiledEmbedding(seededEmbedding(1)),
    });
    await seedRuns(db.adminSql, 'triage-and-block-stale', ws, hive, {
      runs: 12,
      agents: ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e'], // 5 distinct
    });

    // ── A 1-tool wrapper — TRIVIAL, must be EXCLUDED as redundant. ───────────────
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'just-list-plans',
      title: 'List the plans',
      description: 'just call plans list',
      script: 's',
      toolsUsed: ['plans:list'],
      ...profiledEmbedding(seededEmbedding(20)),
    });
    await seedRuns(db.adminSql, 'just-list-plans', ws, hive, {
      runs: 30, // hot, but a 1-tool wrapper → still excluded
      agents: ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f'],
    });

    // ── A solo, low-reuse multi-tool recipe — present but should rank below hot. ──
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'deploy-and-announce',
      title: 'Deploy and announce',
      description: 'deploy the harness then post to coord',
      script: 's',
      toolsUsed: ['deploy:harness', 'coord:send'],
      ...profiledEmbedding(seededEmbedding(40)),
    });
    await seedRuns(db.adminSql, 'deploy-and-announce', ws, hive, {
      runs: 3,
      agents: ['agent-a'], // 1 distinct
    });

    // ── A near-duplicate PAIR (identical text + tools) — the MERGE cluster. ──────
    for (const id of ['summarize-feedback-a', 'summarize-feedback-b']) {
      await upsertRecipe(db.adminSql, {
      potSlug: null,
        id,
        title: 'Summarize the feedback queue',
        description: 'read the feedback queue and produce a digest',
        script: 's',
        toolsUsed: ['feedback:list', 'feedback:digest'],
        ...profiledEmbedding(seededEmbedding(7)),
      });
      await seedRuns(db.adminSql, id, ws, hive, {
        runs: 4,
        agents: ['agent-a', 'agent-b', 'agent-c'], // 3 distinct each
      });
    }

    const { promoteCandidates, mergeClusters, signals } = await recipeCandidates(db.adminSql, {});

    // (a) the hot, broadly-reused, multi-tool recipe ranks top of promote candidates
    expect(promoteCandidates.length).toBeGreaterThan(0);
    expect(promoteCandidates[0].id).toBe('triage-and-block-stale');
    expect(promoteCandidates[0].distinctAgents).toBe(5);
    expect(promoteCandidates[0].runCount).toBe(12);
    expect(promoteCandidates[0].successRate).toBe(1);
    expect(promoteCandidates[0].promotionScore).toBeGreaterThan(0);
    expect(promoteCandidates[0].promotionScore).toBeLessThanOrEqual(1);
    // scores are sorted descending
    for (let i = 1; i < promoteCandidates.length; i++) {
      expect(promoteCandidates[i - 1].promotionScore).toBeGreaterThanOrEqual(promoteCandidates[i].promotionScore);
    }

    // (b) the 1-tool wrapper is EXCLUDED as redundant — never a promote candidate
    expect(promoteCandidates.find((c) => c.id === 'just-list-plans')).toBeUndefined();
    const wrapperSignal = signals.find((s) => s.id === 'just-list-plans');
    expect(wrapperSignal?.redundant).toBe(true);
    expect(wrapperSignal?.redundancyReason).toMatch(/trivial/);
    expect(wrapperSignal?.promotionScore).toBe(0);

    // (c) the near-duplicate pair appears as a single merge cluster
    const cluster = mergeClusters.find(
      (m) => m.recipeIds.includes('summarize-feedback-a') && m.recipeIds.includes('summarize-feedback-b'),
    );
    expect(cluster).toBeDefined();
    expect(cluster!.recipeIds).toEqual(['summarize-feedback-a', 'summarize-feedback-b']);
  });

  it('honors minRunCount — recipes below the floor are not considered', async () => {
    const ws = 'ws-cand-floor';
    const hive = 'alpha';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'rarely-run',
      title: 'Rarely run multi-tool recipe',
      description: 'a multi-tool recipe run only once',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
      ...profiledEmbedding(seededEmbedding(3)),
    });
    await seedRuns(db.adminSql, 'rarely-run', ws, hive, { runs: 1, agents: ['agent-a'] });

    const { signals } = await recipeCandidates(db.adminSql, { minRunCount: 5 });
    expect(signals.find((s) => s.id === 'rarely-run')).toBeUndefined();
  });

  it('uses the global recipe corpus across hives', async () => {
    const ws = 'ws-cand-hive';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'alpha-only',
      title: 'Alpha multi-tool recipe',
      description: 'two-tool recipe in alpha',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
      ...profiledEmbedding(seededEmbedding(15)),
    });
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'beta-only',
      title: 'Beta multi-tool recipe',
      description: 'two-tool recipe in beta',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
      ...profiledEmbedding(seededEmbedding(16)),
    });
    await seedRuns(db.adminSql, 'alpha-only', ws, 'alpha', { runs: 4, agents: ['a', 'b'] });
    await seedRuns(db.adminSql, 'beta-only', ws, 'beta', { runs: 4, agents: ['a', 'b'] });

    const { signals } = await recipeCandidates(db.adminSql, {});
    expect(signals.find((s) => s.id === 'alpha-only')).toBeDefined();
    expect(signals.find((s) => s.id === 'beta-only')).toBeDefined();
  });

  it('a low-success multi-tool recipe scores below a high-success one of equal usage', async () => {
    const ws = 'ws-cand-success';
    const hive = 'alpha';
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'stable-recipe',
      title: 'Stable two-tool recipe',
      description: 'reliable',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
      ...profiledEmbedding(seededEmbedding(31)),
    });
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'flaky-recipe',
      title: 'Flaky two-tool recipe',
      description: 'unreliable',
      script: 's',
      toolsUsed: ['plans:set-status', 'plans:add-item'],
      ...profiledEmbedding(seededEmbedding(32)),
    });
    // Equal run_count + distinct agents; differ ONLY on success-rate.
    await seedRuns(db.adminSql, 'stable-recipe', ws, hive, { runs: 8, agents: ['a', 'b', 'c'], successes: 8 });
    await seedRuns(db.adminSql, 'flaky-recipe', ws, hive, { runs: 8, agents: ['a', 'b', 'c'], successes: 2 });

    const { signals } = await recipeCandidates(db.adminSql, {});
    const stable = signals.find((s) => s.id === 'stable-recipe');
    const flaky = signals.find((s) => s.id === 'flaky-recipe');
    expect(stable).toBeDefined();
    expect(flaky).toBeDefined();
    expect(stable!.promotionScore).toBeGreaterThan(flaky!.promotionScore);
  });

  it('reuse FLOOR — a single-run/single-agent multi-tool recipe is SCORED but NOT a promote candidate', async () => {
    const ws = 'ws-cand-floor-reuse';
    const hive = 'alpha';
    // 3 tools run ONCE by ONE agent: success(0.20)+cohesion(0.20) alone push the score
    // over PROMOTE_THRESHOLD (≈0.528 > 0.45), but with zero reuse breadth it must NOT
    // promote — the reuse floor (≥2 distinct agents OR ≥3 runs) is what holds it back.
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'one-off-three-tool',
      title: 'One-off three-tool recipe',
      description: 'three tools, run once by one agent',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state', 'work_items:comment'],
      ...profiledEmbedding(seededEmbedding(77)),
    });
    await seedRuns(db.adminSql, 'one-off-three-tool', ws, hive, { runs: 1, agents: ['solo'] });

    // minRunCount:1 so the recipe is CONSIDERED at all (the default floor of 2 would
    // filter a single-run recipe before scoring; here we isolate the REUSE-breadth floor).
    const { signals, promoteCandidates } = await recipeCandidates(db.adminSql, { minRunCount: 1 });
    const sig = signals.find((s) => s.id === 'one-off-three-tool');
    expect(sig).toBeDefined();
    expect(sig!.distinctAgents).toBe(1);
    expect(sig!.runCount).toBe(1);
    expect(sig!.redundant).toBe(false); // 3 tools ⇒ not trivial, id collides with no tool
    // its weighted score clears the threshold on success+cohesion alone …
    expect(sig!.promotionScore).toBeGreaterThan(0.45);
    // … yet the reuse FLOOR keeps it OUT of the promote list.
    expect(promoteCandidates.find((c) => c.id === 'one-off-three-tool')).toBeUndefined();
  });
});
