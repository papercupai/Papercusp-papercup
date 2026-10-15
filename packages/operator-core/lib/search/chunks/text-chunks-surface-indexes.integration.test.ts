/** WI-10005483 / D-048: execute the 1469→1470 chain and the real shared ANN builder. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { chunkAwareVectorLegSql, sharedChunkStore, withIterativeScan, type ChunkSurface } from '@papercusp/search';

const SURFACES = ['work_items', 'plans', 'operator_turns'] as const;
const SEEDED_SURFACES = [...SURFACES, 'report'] as const;
const DIMS = 768;
const QUERY = `[1,${Array(DIMS - 1).fill(0).join(',')}]`;
const vector = (angle: number) => `[${Math.cos(angle)},${Math.sin(angle)},${Array(DIMS - 2).fill(0).join(',')}]`;
const migration = (file: string) => {
  const armed = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql', file);
  return readFileSync(existsSync(armed) ? armed : `${armed}.DRAFT`, 'utf8');
};
const MIGRATION = migration('1469-text-chunks-surface-hnsw.sql');
const CORRECTION = migration('1470-drop-unused-report-chunk-hnsw.sql');
const indexName = (surface: string) => `text_chunks_${surface}_embedding_hnsw_idx`;

describe('migration1469→1470 shared-surface HNSW indexes', () => {
  let db: MigratedTestDb;
  let sql: postgres.Sql;

  const surface = (name: string): ChunkSurface => ({
    surface: name,
    parent: { table: 'harness_shared.parents', key: ['id'] },
    textSql: 'p.body',
    splitter: { kind: 'window', size: 1500, overlap: 250 },
    maxChunks: 4,
    chunkMargin: 0,
    parentVector: { column: 'embedding', profileColumn: 'embedding_profile', modeColumn: 'embedding_mode' },
    store: sharedChunkStore({ table: 'harness_shared.text_chunks' }),
  });

  const leg = (tx: postgres.Sql, name: string) => chunkAwareVectorLegSql(tx as never, {
    surface: surface(name), qVec: QUERY, limit: 5,
    mode: 'retrieve', scan: 'ann',
    parentFilter: tx`p.eligible` as never,
    spaceFilter: ({ profileColumn, modeColumn }) => tx`${tx(profileColumn!)} = 'profile_ok'
      AND ${tx(modeColumn!)} = 'gemma'` as never,
  });

  const plan = (name: string) => sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL plan_cache_mode = force_generic_plan');
    await tx.unsafe('SET LOCAL enable_seqscan = off');
    await tx.unsafe('SET LOCAL enable_sort = off');
    const rows = await tx`EXPLAIN ${leg(tx as never, name) as never}`;
    return rows.map(r => String(r['QUERY PLAN'])).join('\n');
  });

  beforeAll(async () => {
    db = await createFreshTestDb({ prefix: 'chunksurface1470' });
    sql = postgres(db.url, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;
      CREATE SCHEMA harness_shared;
      CREATE TABLE harness_shared.parents (
        id text PRIMARY KEY, body text, eligible boolean, embedding vector(${DIMS}),
        embedding_profile text, embedding_mode text);
      CREATE INDEX parents_embedding_hnsw_idx ON harness_shared.parents
        USING hnsw (embedding vector_cosine_ops);
      CREATE TABLE harness_shared.text_chunks (
        surface text NOT NULL, parent_key text[] NOT NULL, chunk_idx int NOT NULL,
        anchor text, embedding vector(${DIMS}), embedding_profile text, embedding_mode text,
        PRIMARY KEY (surface, parent_key, chunk_idx));
      CREATE INDEX text_chunks_embedding_hnsw_idx ON harness_shared.text_chunks
        USING hnsw (embedding vector_cosine_ops);
      CREATE INDEX text_chunks_consult_questions_embedding_hnsw_idx ON harness_shared.text_chunks
        USING hnsw (embedding vector_cosine_ops) WHERE surface = 'consult_questions';`);
    const parents = Array.from({ length: 80 }, (_, i) => ({
      id: String(i + 1), body: `parent${i + 1}`, eligible: (i + 1) % 2 === 0,
      embedding: vector(1.5 + i / 1000), embedding_profile: 'profile_ok', embedding_mode: 'gemma',
    }));
    await sql`INSERT INTO harness_shared.parents ${sql(parents)}`;
    const chunks = [...SEEDED_SURFACES, 'consult_questions', 'other'].flatMap((name, j) =>
      Array.from({ length: 80 }, (_, i) => ({
        surface: name, parent_key: [String(i + 1)], chunk_idx: 0, anchor: `${name}-${i + 1}`,
        // A missing surface/profile predicate changes the answer, not just its plan.
        embedding: vector(name === 'other' || i >= 60 ? .0001 : .01 + i / 200 + j / 10000),
        embedding_profile: i >= 60 ? 'profile_wrong' : 'profile_ok', embedding_mode: 'gemma',
      })));
    await sql`INSERT INTO harness_shared.text_chunks ${sql(chunks)}`;
    await sql.unsafe('ANALYZE harness_shared.parents; ANALYZE harness_shared.text_chunks');
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.drop();
  });

  it('keeps three generic ANN surface indexes, removes the unused report index, and replays the chain safely', async () => {
    for (const name of SURFACES) {
      const before = await plan(name);
      expect(before).toContain('Index Scan using text_chunks_embedding_hnsw_idx');
      expect(before).not.toContain(indexName(name));
    }
    await sql.begin(async tx => { await tx.unsafe(MIGRATION); });
    // Prove the correction removes an existing index, rather than vacuously
    // succeeding because the fixture never created it.
    expect((await sql`SELECT to_regclass('harness_shared.text_chunks_report_embedding_hnsw_idx') AS name`)[0].name)
      .toBe('harness_shared.text_chunks_report_embedding_hnsw_idx');
    await sql.begin(async tx => { await tx.unsafe(CORRECTION); });
    await sql.begin(async tx => { await tx.unsafe(MIGRATION); await tx.unsafe(CORRECTION); });
    const rows = await sql<{ name: string; valid: boolean; ready: boolean; predicate: string }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'harness_shared.text_chunks'::regclass`;
    for (const name of SURFACES) {
      expect(rows.find(r => r.name === indexName(name))).toEqual({
        name: indexName(name), valid: true, ready: true, predicate: `(surface = '${name}'::text)`,
      });
      expect(await plan(name)).toContain(`Index Scan using ${indexName(name)}`);
    }
    expect(rows.find(r => r.name === 'text_chunks_embedding_hnsw_idx')).toMatchObject({ valid: true, ready: true });
    expect(rows.find(r => r.name === indexName('consult_questions'))).toMatchObject({ valid: true, ready: true });
    expect(rows.find(r => r.name === indexName('report'))).toBeUndefined();
  }, 120_000);

  it.each(SURFACES)('%s keeps eligible parents, the correct vector profile and best chunk anchors', async name => {
    const rows = await withIterativeScan(sql as never,
      tx => leg(tx as never, name) as never, { efSearch: 1000 }) as unknown as
      Array<{ id: string; matched_anchor: string; distance: number }>;
    expect(rows.map(r => r.id)).toEqual(['2', '4', '6', '8', '10']);
    expect(rows.map(r => r.matched_anchor)).toEqual(['2', '4', '6', '8', '10'].map(id => `${name}-${id}`));
    rows.forEach((r, i) => expect(Number(r.distance)).toBeCloseTo(1 - Math.cos(.01 + (2 * i + 1) / 200 + SURFACES.indexOf(name) / 10000), 5));
  });

  it('keeps exact report chunk ranking and filters after retiring its unused ANN index', async () => {
    const rows = await sql<{ id: string; distance: number }[]>`
      SELECT p.id, MIN(c.embedding <=> ${QUERY}::vector) AS distance
      FROM harness_shared.text_chunks c
      JOIN harness_shared.parents p ON p.id = c.parent_key[1]
      WHERE c.surface = 'report' AND p.eligible
        AND c.embedding_profile = 'profile_ok' AND c.embedding_mode = 'gemma'
      GROUP BY p.id ORDER BY distance LIMIT 5`;
    expect(rows.map(r => r.id)).toEqual(['2', '4', '6', '8', '10']);
    rows.forEach((r, i) => expect(Number(r.distance)).toBeCloseTo(
      1 - Math.cos(.01 + (2 * i + 1) / 200 + SEEDED_SURFACES.indexOf('report') / 10000), 5));
    expect((await sql`SELECT to_regclass('harness_shared.text_chunks_report_embedding_hnsw_idx') AS name`)[0].name)
      .toBeNull();
  });
});
