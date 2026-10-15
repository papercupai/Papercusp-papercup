/**
 * BM25 configuration and health against real servers (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10: requirement R-4, items P-003 and P-004).
 *
 * Two servers from the same image: one preloads pg_textsearch (production), one does not.
 * Migration 1447 must apply on both; the health check must report `ok` on the first and
 * `degraded` with the preload named on the second, and the seam must fall back to the
 * legacy ranking wherever BM25 is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { bm25Health, lexicalEngine, lexicalLeg, resetBm25Availability } from './rank';
import { seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

describe('with pg_textsearch preloaded', () => {
  let db: Bm25TestDb;
  let sql: Sql;

  beforeAll(async () => {
    db = await startBm25TestDb();
    sql = db.sql;
    await seedBm25Corpus(sql);
  }, 600_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('migration 1447', () => {
    it('builds the index for every present corpus and reports absent tables', async () => {
      const out = await sql<{ corpus_index: string; outcome: string }[]>`SELECT * FROM harness_shared.bm25_ensure_indexes()`;
      const by = new Map(out.map(r => [r.corpus_index, r.outcome]));
      expect(by.get('work_items_bm25')).toBe('present');
      expect(by.get('code_recipes_bm25')).toBe('present');
      expect(by.get('harness_plans_bm25')).toBe('present');
      expect(by.get('documents_bm25')).toBe('skipped:table-missing');
    });

    it('detects the library through a GUC every role may read', async () => {
      const role = `${db.runTag}_nosu`;
      await sql.unsafe(`CREATE ROLE "${role}" LOGIN; GRANT USAGE ON SCHEMA harness_shared TO "${role}";`);
      const [r] = await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        return tx<{ loaded: boolean }[]>`SELECT harness_shared.bm25_library_preloaded() AS loaded`;
      });
      expect(r?.loaded).toBe(true);
    });

    it('reports a second BM25 index on the same expression as a duplicate', async () => {
      await sql.unsafe(`CREATE INDEX wi_twin ON harness_shared.work_items USING bm25
        ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, ''))) WITH (text_config = 'english')`);
      try {
        const out = await sql<{ outcome: string }[]>`
          SELECT outcome FROM harness_shared.bm25_ensure_indexes() WHERE corpus_index = 'work_items_bm25'`;
        expect(out.map(r => r.outcome).sort()).toEqual(['duplicate:wi_twin', 'present']);
      } finally {
        await sql.unsafe('DROP INDEX harness_shared.wi_twin');
      }
    });
  });

  describe('health check', () => {
    it('is ok while every present corpus has its index', async () => {
      resetBm25Availability();
      const health = await bm25Health(sql);
      expect(health).toMatchObject({ status: 'ok', libraryLoaded: true, extensionInstalled: true, missingIndexes: [], reason: null });
      expect(health.presentIndexes.sort()).toEqual(['code_recipes_bm25', 'harness_plans_bm25', 'work_items_bm25']);
      expect(await lexicalEngine(sql, 'work_items')).toBe('bm25');
    });

    it('falls back to the legacy ranking and reports degraded when an index is missing', async () => {
      await sql.unsafe('DROP INDEX harness_shared.code_recipes_bm25');
      try {
        resetBm25Availability();
        expect(await lexicalEngine(sql, 'code_recipes')).toBe('legacy');
        const legacy = { score: sql`1::float8`, match: sql`true` };
        const leg = await lexicalLeg(sql, { table: 'code_recipes', query: 'x', legacy });
        expect(leg.engine).toBe('legacy');
        expect(leg.score).toBe(legacy.score);
        const health = await bm25Health(sql);
        expect(health.status).toBe('degraded');
        expect(health.missingIndexes).toEqual(['code_recipes_bm25']);
        expect(health.reason).toContain('code_recipes_bm25');
      } finally {
        await sql`SELECT harness_shared.bm25_ensure_indexes()`;
        resetBm25Availability();
      }
    });
  });
});

describe('without pg_textsearch in shared_preload_libraries (R-4)', () => {
  let db: Bm25TestDb;
  let sql: Sql;

  beforeAll(async () => {
    db = await startBm25TestDb({ preload: false });
    sql = db.sql;
    await seedBm25Corpus(sql);
  }, 600_000);

  afterAll(async () => {
    await db?.close();
  });

  it('is really a server without the preload, with the extension files installed', async () => {
    const [r] = await sql<{ preload: string; available: boolean }[]>`
      SELECT current_setting('shared_preload_libraries') AS preload,
             EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_textsearch') AS available`;
    expect(r?.preload).not.toContain('pg_textsearch');
    expect(r?.available).toBe(true);
  });

  it('migration 1447 applies, builds nothing and says why', async () => {
    const out = await sql<{ corpus_index: string | null; outcome: string }[]>`SELECT * FROM harness_shared.bm25_ensure_indexes()`;
    expect(out).toEqual([{ corpus_index: null, outcome: 'skipped:library-not-preloaded' }]);
    const [{ loaded }] = await sql<{ loaded: boolean }[]>`SELECT harness_shared.bm25_library_preloaded() AS loaded`;
    expect(loaded).toBe(false);
  });

  it('the health check reports degraded and names the missing preload', async () => {
    resetBm25Availability();
    const health = await bm25Health(sql);
    expect(health.flagOn).toBe(true);
    expect(health.status).toBe('degraded');
    expect(health.libraryLoaded).toBe(false);
    expect(health.reason).toBe('pg_textsearch is not in shared_preload_libraries');
    expect(health.presentIndexes).toEqual([]);
    expect(health.missingIndexes.sort()).toEqual(['code_recipes_bm25', 'harness_plans_bm25', 'work_items_bm25']);
  });

  it('the seam ranks with the legacy fragments', async () => {
    resetBm25Availability();
    expect(await lexicalEngine(sql, 'work_items')).toBe('legacy');
  });
});
