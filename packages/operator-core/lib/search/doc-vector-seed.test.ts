/**
 * doc-vector-seed — on-disk format, exact float round-trip, and the
 * embedding-space gate (WI-10004455, plan ship-precomputed-doc-vectors-2026-10-01
 * R-2/R-3). The live-SQL behaviour is in doc-vector-seed.integration.test.ts.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOC_VECTOR_SEED_FORMAT,
  DOC_VECTOR_SEED_VECTORS,
  DOC_VECTOR_SEED_VERSION,
  readDocVectorSeed,
  seedSpaceMismatch,
  seedVectorLiteral,
  writeDocVectorSeed,
  type DocVectorSeed,
  type DocVectorSeedManifest,
} from './doc-vector-seed';
import { PROSE_VECTOR_DIMS, resolveCurrentProseProfileSelection } from './prose-vector-dims';

const gemma = resolveCurrentProseProfileSelection('gemma');
const openai = resolveCurrentProseProfileSelection('openai');

function seed(rows: number, dims = PROSE_VECTOR_DIMS, over: Partial<DocVectorSeedManifest> = {}): DocVectorSeed {
  const vectors = new Float32Array(rows * dims);
  // Values a decimal formatter could easily get wrong: thirds, tiny and large magnitudes.
  for (let i = 0; i < vectors.length; i += 1) vectors[i] = ((i % 13) - 6) / 3 + (i % 5) * 1e-7 - (i % 7) * 1e3;
  return {
    manifest: {
      format: DOC_VECTOR_SEED_FORMAT,
      version: DOC_VECTOR_SEED_VERSION,
      mode: 'gemma',
      profileId: gemma!.profileId,
      dims,
      dtype: 'f32le',
      sourceKeys: ['papercusp-engineering'],
      rows: Array.from({ length: rows }, (_, i) => ['papercusp-engineering', `page-${i}`, `a-${i}`, `sha-${i}`]),
      createdAt: '2026-10-01T00:00:00.000Z',
      ...over,
    },
    vectors,
  };
}

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'doc-vector-seed-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('doc vector seed format', () => {
  it('the current gemma prose profile resolves (the seed space every test below uses)', () => {
    expect(gemma).not.toBeNull();
  });

  it('round-trips manifest and every float bit-for-bit', async () => {
    const dir = await tmp();
    const s = seed(5);
    await writeDocVectorSeed(dir, s);
    const back = await readDocVectorSeed(dir);
    expect(back.manifest).toEqual(s.manifest);
    expect(Array.from(back.vectors)).toEqual(Array.from(s.vectors));
  });

  it('refuses a vectors file whose size does not match rows × dims', async () => {
    const dir = await tmp();
    await writeDocVectorSeed(dir, seed(3));
    await writeFile(path.join(dir, DOC_VECTOR_SEED_VECTORS), Buffer.alloc(8));
    await expect(readDocVectorSeed(dir)).rejects.toThrow(/expected/);
  });

  it('refuses an unknown format version', async () => {
    const dir = await tmp();
    await writeDocVectorSeed(dir, seed(1, 4, { version: 2 as unknown as 1 }));
    await expect(readDocVectorSeed(dir)).rejects.toThrow(/version 2/);
  });

  it('refuses to write vectors that do not match the row count', async () => {
    const dir = await tmp();
    const s = seed(2);
    await expect(writeDocVectorSeed(dir, { ...s, vectors: s.vectors.subarray(1) })).rejects.toThrow(/floats/);
  });
});

describe('seedVectorLiteral', () => {
  it('emits a pgvector literal whose values parse back to the identical float32', () => {
    const s = seed(2);
    const lit = seedVectorLiteral(s.vectors, 1, PROSE_VECTOR_DIMS);
    expect(lit.startsWith('[') && lit.endsWith(']')).toBe(true);
    const parsed = Float32Array.from(lit.slice(1, -1).split(',').map(Number));
    expect(Array.from(parsed)).toEqual(Array.from(s.vectors.subarray(PROSE_VECTOR_DIMS, 2 * PROSE_VECTOR_DIMS)));
  });
});

describe('seedSpaceMismatch (R-3: never write another space)', () => {
  it('accepts a seed in the active space', () => {
    expect(seedSpaceMismatch(seed(1).manifest, { mode: 'gemma', selection: gemma! })).toBeNull();
  });

  it('rejects a seed from a different profile', () => {
    const m = seed(1, PROSE_VECTOR_DIMS, { profileId: 'not-a-real-profile' }).manifest;
    expect(seedSpaceMismatch(m, { mode: 'gemma', selection: gemma! })).toMatch(/seed space/);
  });

  it('rejects a gemma seed when the active embedder is another mode', () => {
    if (!openai || openai.profileId === gemma!.profileId) return;
    expect(seedSpaceMismatch(seed(1).manifest, { mode: 'openai', selection: openai })).toMatch(/seed space/);
  });

  it('rejects a seed whose width is not the prose storage width', () => {
    expect(seedSpaceMismatch(seed(1, 384).manifest, { mode: 'gemma', selection: gemma! })).toMatch(/dims/);
  });
});
