/**
 * doc-vector-seed against live SQL (WI-10004455, plan
 * ship-precomputed-doc-vectors-2026-10-01):
 *   R-1 — a matching seed leaves no NULL doc_sections rows for its pages, so
 *         embed-backfill has nothing to embed for them;
 *   R-2 — the release-cut flow (apply previous seed → embed remainder →
 *         export) re-embeds only changed sections and exports every vector
 *         bit-for-bit;
 *   R-3 — a seed from another embedding space writes nothing.
 * Every row lives under a per-run source_key and is deleted afterwards.
 */
import { mkdtemp, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import {
  applyDocVectorSeed,
  applyShippedDocVectorSeed,
  countUnembeddedDocSections,
  DOC_VECTOR_SEED_VECTORS,
  exportDocVectorSeed,
  writeDocVectorSeed,
  type ActiveProseSpace,
  type DocVectorSeed,
} from './doc-vector-seed';
import { PROSE_VECTOR_DIMS, resolveCurrentProseProfileSelection } from './prose-vector-dims';

const SOURCE_KEY = `test:doc-vector-seed:${process.pid}:${Date.now()}`;
const DIMS = PROSE_VECTOR_DIMS;
const gemmaSelection = resolveCurrentProseProfileSelection('gemma');
const GEMMA: ActiveProseSpace = { mode: 'gemma', selection: gemmaSelection! };

/** A deterministic, row-distinct vector with values that are not short decimals. */
function vectorFor(seedNo: number): Float32Array {
  const v = new Float32Array(DIMS);
  for (let d = 0; d < DIMS; d += 1) v[d] = Math.fround(Math.sin(seedNo * 31 + d) / 3);
  return v;
}
const literal = (v: Float32Array): string => `[${Array.from(v).join(',')}]`;

interface Row {
  slug: string;
  anchor: string;
  pageSha: string;
}
const ROWS: Row[] = [
  { slug: 'a', anchor: 'intro', pageSha: 'sha-a1' },
  { slug: 'a', anchor: 'usage', pageSha: 'sha-a1' },
  { slug: 'b', anchor: 'intro', pageSha: 'sha-b1' },
  { slug: 'c', anchor: 'intro', pageSha: 'sha-c1' },
];

function seedOf(rows: Array<Row & { vec: Float32Array }>, over: Partial<DocVectorSeed['manifest']> = {}): DocVectorSeed {
  const vectors = new Float32Array(rows.length * DIMS);
  rows.forEach((r, i) => vectors.set(r.vec, i * DIMS));
  return {
    manifest: {
      format: 'papercusp-doc-vector-seed',
      version: 1,
      mode: 'gemma',
      profileId: GEMMA.selection.profileId,
      dims: DIMS,
      dtype: 'f32le',
      sourceKeys: [SOURCE_KEY],
      rows: rows.map((r) => [SOURCE_KEY, r.slug, r.anchor, r.pageSha]),
      createdAt: '2026-10-01T00:00:00.000Z',
      ...over,
    },
    vectors,
  };
}

describe('doc vector seed (live SQL)', () => {
  let sql: postgres.Sql;
  const dirs: string[] = [];

  const insertNullRows = async (rows: Row[]) => {
    await sql.unsafe(
      `INSERT INTO harness_shared.doc_sections (source_key, slug, anchor, title, url, content, page_sha)
       SELECT $1, slug, anchor, slug || ' › ' || anchor, '/docs/' || slug, 'body of ' || slug, page_sha
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(slug, anchor, page_sha)`,
      [SOURCE_KEY, rows.map((r) => r.slug), rows.map((r) => r.anchor), rows.map((r) => r.pageSha)],
    );
  };
  const stored = () =>
    sql.unsafe<Array<{ slug: string; anchor: string; vec: string | null; mode: string | null; profile: string | null }>>(
      `SELECT slug, anchor, embedding::text AS vec, embedding_mode AS mode, embedding_profile AS profile
         FROM harness_shared.doc_sections WHERE source_key = $1 ORDER BY slug, anchor`,
      [SOURCE_KEY],
    );
  // pgvector prints the shortest float4 decimal; fround recovers the stored float32.
  const vecOf = (text: string | null): number[] | null =>
    text === null ? null : text.slice(1, -1).split(',').map((s) => Math.fround(Number(s)));

  beforeAll(async () => {
    expect(gemmaSelection).not.toBeNull();
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'doc-vector-seed.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
  }, 60_000);
  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM harness_shared.doc_sections WHERE source_key = $1`, [SOURCE_KEY]);
  });
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  afterAll(async () => {
    await sql?.unsafe(`DELETE FROM harness_shared.doc_sections WHERE source_key = $1`, [SOURCE_KEY]);
    await sql?.end({ timeout: 5 });
  });

  it('R-1: fills exactly the NULL rows whose page_sha matches, bit-for-bit, with the sweep labels', async () => {
    await insertNullRows(ROWS);
    // Row b already holds a vector (embedded earlier) — the seed must not overwrite it.
    const kept = vectorFor(99);
    await sql.unsafe(
      `UPDATE harness_shared.doc_sections SET embedding = $2::vector, embedding_mode = 'gemma'
        WHERE source_key = $1 AND slug = 'b'`,
      [SOURCE_KEY, literal(kept)],
    );
    const seed = seedOf([
      { ...ROWS[0], vec: vectorFor(0) },
      { ...ROWS[1], vec: vectorFor(1) },
      { ...ROWS[2], vec: vectorFor(2) },
      // c changed since the seed was cut: different page_sha ⇒ must stay NULL.
      { ...ROWS[3], pageSha: 'sha-c0', vec: vectorFor(3) },
    ]);

    const r = await applyDocVectorSeed(sql, seed, GEMMA);
    expect(r).toEqual({ applied: 2, seedRows: 4 });

    const rows = await stored();
    const by = (slug: string, anchor: string) => rows.find((x) => x.slug === slug && x.anchor === anchor)!;
    expect(vecOf(by('a', 'intro').vec)).toEqual(Array.from(vectorFor(0)));
    expect(vecOf(by('a', 'usage').vec)).toEqual(Array.from(vectorFor(1)));
    expect(by('a', 'intro')).toMatchObject({ mode: 'gemma', profile: GEMMA.selection.profileId });
    expect(vecOf(by('b', 'intro').vec)).toEqual(Array.from(kept));
    expect(by('c', 'intro').vec).toBeNull();
    expect(await countUnembeddedDocSections(sql, [SOURCE_KEY])).toBe(1);
  });

  it('R-3: a seed from another embedding space writes nothing', async () => {
    await insertNullRows(ROWS);
    const foreign = seedOf(
      ROWS.map((r, i) => ({ ...r, vec: vectorFor(i) })),
      { profileId: 'some-other-profile', mode: 'openai' },
    );
    const r = await applyDocVectorSeed(sql, foreign, GEMMA);
    expect(r).toMatchObject({ skipped: 'space-mismatch' });
    expect((await stored()).every((x) => x.vec === null)).toBe(true);
  });

  it('R-2: cut flow re-embeds only changed sections and the export round-trips every vector', async () => {
    // Previous release: every row embedded and exported.
    await insertNullRows(ROWS);
    const previous = seedOf(ROWS.map((r, i) => ({ ...r, vec: vectorFor(i) })));
    expect(await applyDocVectorSeed(sql, previous, GEMMA)).toEqual({ applied: 4, seedRows: 4 });
    const prevExport = await exportDocVectorSeed(sql, GEMMA, [SOURCE_KEY]);
    expect(prevExport.uncovered).toBe(0);
    expect(prevExport.seed.manifest.rows).toEqual(previous.manifest.rows);
    expect(Array.from(prevExport.seed.vectors)).toEqual(Array.from(previous.vectors));

    // Next release: page c changed. A fresh build DB re-syncs NULL rows.
    await sql.unsafe(`DELETE FROM harness_shared.doc_sections WHERE source_key = $1`, [SOURCE_KEY]);
    const next = ROWS.map((r) => (r.slug === 'c' ? { ...r, pageSha: 'sha-c2' } : r));
    await insertNullRows(next);
    expect(await applyDocVectorSeed(sql, prevExport.seed, GEMMA)).toEqual({ applied: 3, seedRows: 4 });
    // Only the changed section is left for the embedder.
    expect(await countUnembeddedDocSections(sql, [SOURCE_KEY])).toBe(1);
    const partial = await exportDocVectorSeed(sql, GEMMA, [SOURCE_KEY]);
    expect(partial.uncovered).toBe(1);

    // The backfill embeds c (simulated with the sweep's labels), then the cut exports.
    const cNew = vectorFor(42);
    await sql.unsafe(
      `UPDATE harness_shared.doc_sections SET embedding = $2::vector, embedding_mode = 'gemma', embedding_profile = $3
        WHERE source_key = $1 AND slug = 'c'`,
      [SOURCE_KEY, literal(cNew), GEMMA.selection.profileId],
    );
    const final = await exportDocVectorSeed(sql, GEMMA, [SOURCE_KEY]);
    expect(final.uncovered).toBe(0);
    expect(final.seed.manifest.rows.find((k) => k[1] === 'c')).toEqual([SOURCE_KEY, 'c', 'intro', 'sha-c2']);
    const cIndex = final.seed.manifest.rows.findIndex((k) => k[1] === 'c');
    expect(Array.from(final.seed.vectors.subarray(cIndex * DIMS, (cIndex + 1) * DIMS))).toEqual(Array.from(cNew));
  });

  it('export leaves out rows embedded in another space and counts them as uncovered', async () => {
    await insertNullRows(ROWS.slice(0, 2));
    await sql.unsafe(
      `UPDATE harness_shared.doc_sections SET embedding = $2::vector, embedding_mode = 'openai', embedding_profile = 'some-other-profile'
        WHERE source_key = $1 AND anchor = 'intro'`,
      [SOURCE_KEY, literal(vectorFor(7))],
    );
    const out = await exportDocVectorSeed(sql, GEMMA, [SOURCE_KEY]);
    expect(out.seed.manifest.rows).toEqual([]);
    expect(out.uncovered).toBe(2);
  });

  it('boot step: reads the shipped seed from disk and fills; skips cleanly with nothing to fill', async () => {
    await insertNullRows(ROWS);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'doc-vector-seed-it-'));
    dirs.push(dir);
    await writeDocVectorSeed(dir, seedOf(ROWS.map((r, i) => ({ ...r, vec: vectorFor(i) }))));
    const lines: string[] = [];
    const deps = {
      seedDir: () => dir,
      resolveSpace: async () => GEMMA,
      sourceKeys: [SOURCE_KEY],
      log: (l: string) => lines.push(l),
    };
    expect(await applyShippedDocVectorSeed(sql, deps)).toEqual({ applied: 4, seedRows: 4 });
    expect(lines.join('\n')).toMatch(/filled 4\/4/);
    expect(await countUnembeddedDocSections(sql, [SOURCE_KEY])).toBe(0);
    // Second boot: nothing NULL, so the seed is not even read.
    expect(await applyShippedDocVectorSeed(sql, { ...deps, seedDir: () => path.join(dir, 'missing') })).toEqual({
      skipped: 'nothing-to-fill',
    });
    expect(await applyShippedDocVectorSeed(sql, { ...deps, seedDir: () => null })).toEqual({ skipped: 'no-seed' });
    expect(await applyShippedDocVectorSeed(sql, { ...deps, resolveSpace: async () => null })).toEqual({
      skipped: 'nothing-to-fill',
    });
  });

  it('boot step: a truncated, unknown-format, or missing seed is refused before any row is written', async () => {
    await insertNullRows(ROWS);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'doc-vector-seed-it-'));
    dirs.push(dir);
    const good = seedOf(ROWS.map((r, i) => ({ ...r, vec: vectorFor(i) })));
    const lines: string[] = [];
    const deps = { resolveSpace: async () => GEMMA, sourceKeys: [SOURCE_KEY], log: (l: string) => lines.push(l) };
    const noRowWritten = async () => {
      expect((await stored()).every((x) => x.vec === null && x.mode === null)).toBe(true);
      expect(await countUnembeddedDocSections(sql, [SOURCE_KEY])).toBe(ROWS.length);
    };

    // Truncated vectors file: one float short of rows × dims.
    await writeDocVectorSeed(dir, good);
    await truncate(path.join(dir, DOC_VECTOR_SEED_VECTORS), ROWS.length * DIMS * 4 - 4);
    const truncated = await applyShippedDocVectorSeed(sql, { ...deps, seedDir: () => dir });
    expect(truncated).toMatchObject({ skipped: 'invalid-seed' });
    expect('detail' in truncated && truncated.detail).toMatch(/vectors\.f32 is \d+ bytes, expected \d+/);
    await noRowWritten();

    // Unknown format version.
    await writeDocVectorSeed(dir, { ...good, manifest: { ...good.manifest, version: 99 as 1 } });
    expect(await applyShippedDocVectorSeed(sql, { ...deps, seedDir: () => dir })).toMatchObject({
      skipped: 'invalid-seed',
    });
    await noRowWritten();

    // Seed directory named by the build but absent on disk.
    expect(await applyShippedDocVectorSeed(sql, { ...deps, seedDir: () => path.join(dir, 'absent') })).toMatchObject({
      skipped: 'invalid-seed',
    });
    await noRowWritten();
    expect(lines.filter((l) => l.includes('seed refused'))).toHaveLength(3);
  });

  it('boot step: a disabled embedder skips the seed and leaves rows for the sweep', async () => {
    await insertNullRows(ROWS.slice(0, 1));
    const r = await applyShippedDocVectorSeed(sql, {
      seedDir: () => '/nonexistent-seed-dir',
      resolveSpace: async () => null,
      sourceKeys: [SOURCE_KEY],
    });
    expect(r).toEqual({ skipped: 'embedder-disabled' });
    expect(await countUnembeddedDocSections(sql, [SOURCE_KEY])).toBe(1);
  });
});
