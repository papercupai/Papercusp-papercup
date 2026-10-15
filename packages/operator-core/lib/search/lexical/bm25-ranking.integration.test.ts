/**
 * BM25 ranking properties against a real pg_textsearch server (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10: requirements R-1, R-11, R-12; items P-005
 * and P-007).
 *
 * R-1/R-11/R-12 are judged on our real corpora by the bake-off bench
 * (lib/search/bench/bm25-bakeoff-cli.ts; decisions D-002 and D-005). This suite is their
 * recurrence guard on a seeded corpus: real BM25 puts a rare term ahead of a common one,
 * meets a known-item MRR floor, and keeps those properties through every call-site shape
 * P-005 introduced (a filtered scan, prepared reuse, the plan source, websearch syntax, a
 * materialized CTE).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { SearchSourceParams } from '@papercusp/search';
import { bm25Leg, lexicalEngine, lexicalLeg, resetBm25Availability } from './rank';
import { bm25Corpus } from './corpora';
import { createPlanSearchSource } from '../../agent-tools/search/knowledge-sources';
import { TOPICS, rankWorkItemIds, seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

let db: Bm25TestDb;
let sql: Sql;
const rankIds = (query: string, ws?: string) => rankWorkItemIds(sql, query, ws);

beforeAll(async () => {
  db = await startBm25TestDb();
  sql = db.sql;
  await seedBm25Corpus(sql);
  resetBm25Availability();
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('lexical seam on BM25', () => {
  it('chooses BM25 when the corpus index exists', async () => {
    resetBm25Availability();
    expect(await lexicalEngine(sql, 'work_items')).toBe('bm25');
  });

  it('ranks the item holding a rare term first, ahead of items matching only a common term', async () => {
    expect((await rankIds('routine quokka'))[0]).toBe(1);
  });

  it('drops the zero-distance rows a filtered index scan returns', async () => {
    // Item 1 (quokka) is in workspace w1; workspace w0 has no quokka at all.
    expect(await rankIds('quokka', 'w0')).toEqual([]);
    expect(await rankIds('quokka', 'w1')).toEqual([1]);
  });

  it('scores higher-is-better and survives prepared (generic-plan) reuse', async () => {
    const leg = bm25Leg(sql, bm25Corpus('work_items'), 'pangolin');
    for (let i = 0; i < 7; i++) {
      const [top] = await sql<{ id: number; score: number }[]>`
        SELECT id, ${leg.score} AS score FROM harness_shared.work_items WHERE ${leg.match} ORDER BY ${leg.order} LIMIT 1`;
      expect(top?.id).toBe(4);
      expect(top?.score).toBeGreaterThan(0);
    }
  });

  it('meets a known-item MRR@10 floor over the topic items', async () => {
    let mrr = 0;
    for (const [i, topic] of TOPICS.entries()) {
      const rank = (await rankIds(`the ${topic} item`)).indexOf(i + 1);
      mrr += rank < 0 ? 0 : 1 / (rank + 1);
    }
    expect(mrr / TOPICS.length).toBeGreaterThanOrEqual(0.9);
  });

  it('accepts operator characters in user input', async () => {
    expect((await rankIds('quokka & (routine'))[0]).toBe(1);
  });
});

describe('plan knowledge source on BM25 (P-005)', () => {
  const lexical = (query: string) => createPlanSearchSource().lexical({
    sql, query, workspaceId: 'ws1', scopeFilter: null, limit: 10,
  } as unknown as SearchSourceParams);

  it('ranks with BM25: any-term match, both-term plan first, fences kept', async () => {
    resetBm25Availability();
    const listing = await lexical('kangaroo quarterly');
    const keys = listing.map(h => h.key);
    // The legacy AND query matches only kangaroo-plan; quarterly-plan holds one of the
    // two terms, so only BM25's any-term match admits it.
    expect(keys).toEqual(['plan:h:kangaroo-plan', 'plan:h:quarterly-plan']);
    expect(listing[0]!.score).toBeGreaterThan(listing[1]!.score);
    expect(listing[1]!.score).toBeGreaterThan(0);
  });

  it('highlights a row that matches only some of the query terms', async () => {
    const listing = await lexical('kangaroo quarterly');
    const partial = listing.find(h => h.key === 'plan:h:quarterly-plan');
    expect(String(partial?.row.highlight)).toContain('<mark>quarterly</mark>');
  });

  it('recovers a long plan fragment from the bounded exact list when BM25 ranks it below the top 10', async () => {
    resetBm25Availability();
    const query = 'search engine plan';
    const ws = `plan-fusion-${process.pid}-${Date.now()}`;
    const target = 'fragment-target';
    const longBody = `${'background context '.repeat(4_000)}\n## Exact procedure\n${query}\n${'closing notes '.repeat(4_000)}`;
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, template_slug, title, content, status)
      VALUES (${ws}, 'pot-a', ${target}, NULL, 'Fragment target', ${longBody}, 'active')`;
    for (let i = 0; i < 18; i += 1) {
      const terms = i % 3 === 0 ? 'search engine' : i % 3 === 1 ? 'search plan' : 'engine plan';
      const slug = `bm25-decoy-${i}`;
      await sql`INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, template_slug, title, content, status)
        VALUES (${ws}, 'pot-a', ${slug}, NULL, ${`Decoy ${i}`}, ${`${terms} `.repeat(40)}, 'active')`;
    }
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, template_slug, title, content, status)
      VALUES (${ws}, 'pot-b', 'wrong-harness', NULL, 'Wrong harness', ${longBody}, 'active'),
             (${`${ws}-foreign`}, 'pot-a', 'wrong-workspace', NULL, 'Wrong workspace', ${longBody}, 'active')`;
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, template_slug, title, content, status, archived, superseded_by)
      VALUES (${ws}, 'pot-a', 'template-plan', 'plan-template', 'Template plan', ${longBody}, 'active', false, NULL),
             (${ws}, 'pot-a', 'archived-plan', NULL, 'Archived plan', ${longBody}, 'active', true, NULL),
             (${ws}, 'pot-a', 'superseded-plan', NULL, 'Superseded plan', ${longBody}, 'active', false, 'replacement-plan'),
             (${ws}, 'pot-a', 'excluded-plan', NULL, 'Excluded plan', ${longBody}, 'active', false, NULL)`;

    const leg = await lexicalLeg(sql, {
      table: 'harness_plans', alias: 'p', query,
      legacy: {
        score: sql`ts_rank_cd(p._search, plainto_tsquery('english', ${query}))`,
        match: sql`p._search @@ plainto_tsquery('english', ${query})`,
      },
    });
    expect(leg.engine).toBe('bm25');
    const bm25Only = await sql<{ plan_slug: string }[]>`
      SELECT p.plan_slug FROM harness_shared.harness_plans p
       WHERE p.workspace_id = ${ws} AND p.harness_slug = 'pot-a' AND p.template_slug IS NULL
         AND p.archived = false AND p.status IS DISTINCT FROM 'superseded'
         AND p.superseded_by IS NULL AND p.plan_slug <> 'excluded-plan' AND ${leg.match}
       ORDER BY ${leg.order}, p.plan_slug LIMIT 50`;
    expect(bm25Only.findIndex(row => row.plan_slug === target)).toBeGreaterThan(9);

    const excludedRef = 'plan:pot-a:excluded-plan';
    const results = await createPlanSearchSource({
      harnessSlugs: ['pot-a'], automatic: true, excludedRefs: new Set([excludedRef]),
    }).lexical!({
      sql, query, workspaceId: ws, scopeFilter: null, limit: 10,
    } as unknown as SearchSourceParams);
    expect(results.slice(0, 2).map(row => row.key)).toContain(`plan:pot-a:${target}`);
    const keys = results.map(row => row.key);
    for (const key of [
      'plan:pot-b:wrong-harness', 'plan:pot-a:wrong-workspace',
      'plan:pot-a:template-plan', 'plan:pot-a:archived-plan',
      'plan:pot-a:superseded-plan', excludedRef,
    ]) expect(keys).not.toContain(key);
  });
});

describe('websearch operator syntax under BM25 (plan D-007)', () => {
  async function websearchIds(query: string, querySyntax?: 'websearch'): Promise<number[]> {
    const tsv = sql`to_tsvector('english', coalesce(w.title, '') || ' ' || coalesce(w.summary, ''))`;
    const leg = await lexicalLeg(sql, {
      table: 'work_items', query, alias: 'w', ...(querySyntax ? { querySyntax } : {}),
      legacy: { score: sql`0::float8`, match: sql`${tsv} @@ websearch_to_tsquery('english', ${query})` },
    });
    const rows = await sql<{ id: number }[]>`
      SELECT w.id FROM harness_shared.work_items w WHERE ${leg.match} ORDER BY ${leg.order}, w.id LIMIT 10`;
    return rows.map(r => r.id);
  }

  it('without the websearch request, BM25 reads -quokka as a positive term', async () => {
    expect((await websearchIds('routine -quokka'))[0]).toBe(1);
  });

  it('with it, a negated term excludes its rows and BM25 still orders the rest', async () => {
    const ids = await websearchIds('routine -quokka', 'websearch');
    expect(ids).toHaveLength(10);
    expect(ids).not.toContain(1);
  });

  it('honours a quoted phrase: the reversed phrase matches nothing', async () => {
    expect(await websearchIds('"summary routine"')).toHaveLength(10);
    expect(await websearchIds('"summary routine"', 'websearch')).toEqual([]);
    expect(await websearchIds('"routine summary" pangolin', 'websearch')).toEqual([4]);
  });

  it('keeps BM25 any-term matching for a plain query', async () => {
    expect((await websearchIds('quokka marmoset', 'websearch')).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('BM25 leg over a materialized CTE (personal-vault/store.ts shape, P-005)', () => {
  // searchPersonalDocuments filters documents into a CTE that three later CTEs read, so
  // Postgres materializes it and the BM25 operator scores rows outside any index scan.
  it('ranks the CTE rows exactly as a direct scan of the indexed table does', async () => {
    resetBm25Availability();
    const leg = await lexicalLeg(sql, {
      table: 'work_items', query: 'routine quokka',
      legacy: { score: sql`0::float8`, match: sql`false` },
    });
    expect(leg.engine).toBe('bm25');
    const rows = await sql<{ id: number; lexical_rank: string }[]>`
      WITH filtered AS MATERIALIZED (SELECT * FROM harness_shared.work_items WHERE ws = 'w1')
      SELECT id, row_number() OVER (ORDER BY ${leg.order}, id) AS lexical_rank
        FROM filtered WHERE ${leg.match} ORDER BY ${leg.order}, id LIMIT 10`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(r => r.id)).toEqual(await rankIds('routine quokka', 'w1'));
    expect(rows.map(r => Number(r.lexical_rank))).toEqual(rows.map((_, i) => i + 1));
  });
});
