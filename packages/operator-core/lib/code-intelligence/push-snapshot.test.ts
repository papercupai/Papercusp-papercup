import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePushSnapshot, parsePushSnapshotStream, peekPushSnapshot, PUSH_SNAPSHOT_MAX_AGE_MS } from './push-snapshot';

const fixturePath = vi.hoisted(() => ({ current: '' }));
vi.mock('./dependency-snapshot-path', () => ({ dependencySnapshotPath: () => fixturePath.current }));

const now = Date.now();
const edge = { importer: 'app/use.ts', imported: 'lib/café.ts', importerSha256: 'b'.repeat(64) };
const symbol = { id: 'target', name: 'target', path: 'lib/café.ts', line: 2, column: 1,
  sha256: 'c'.repeat(64), signature: 'function target()', aliases: ['alias'], callers: [], sources: [] };
const raw = () => ({ schema: 'graph-dependency-snapshot-v1', generatedAt: new Date(now).toISOString(),
  index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) }, edges: [edge],
  symbols: { schema: 'code-intel-symbol-snapshot-v1', knowledge: 'syntax-bound', symbols: [symbol] } });
async function* split(text: string, size = 7) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

describe('cooperative serving snapshot loader', () => {
  it('matches fixture parsing across tiny chunks, reordered metadata and Unicode', async () => {
    const fixture = raw();
    const text = JSON.stringify({ symbols: { symbols: [symbol], knowledge: fixture.symbols.knowledge,
      schema: fixture.symbols.schema }, edges: [edge, edge], index: fixture.index,
      generatedAt: fixture.generatedAt, schema: fixture.schema });
    expect(await parsePushSnapshotStream(split(text), now)).toEqual(parsePushSnapshot(text, now));
  });

  it('rejects malformed, foreign, stale and future documents after complete validation', async () => {
    const text = JSON.stringify(raw());
    for (const value of [text.slice(0, -1), text + ' trailing', '[1,2]', ...[
      { schema: 'foreign' }, { edges: {} }, { edges: [] },
      { index: { backend: 'gitnexus', lastCommit: 'a'.repeat(40) } },
      { generatedAt: new Date(now - PUSH_SNAPSHOT_MAX_AGE_MS - 1).toISOString() },
      { generatedAt: new Date(now + 300_001).toISOString() },
      { edges: [{ ...edge, importer: '../secret.ts' }] },
    ].map(over => JSON.stringify({ ...raw(), ...over }))]) {
      expect(await parsePushSnapshotStream(split(value), now)).toBeNull();
    }
  });

  it('suppresses unqualified symbol metadata and skips invalid rows without losing valid edges', async () => {
    for (const metadata of [{ ...raw().symbols, knowledge: 'unknown' }, { ...raw().symbols, symbols: {} }]) {
      const result = await parsePushSnapshotStream(split(JSON.stringify({ ...raw(), symbols: metadata })), now);
      expect(result?.symbols?.size).toBe(0);
      expect(result?.importers.get(edge.imported)).toEqual([edge.importer]);
    }
    const text = JSON.stringify({ ...raw(), edges: [null, edge], symbols: { ...raw().symbols,
      symbols: [null, { ...symbol, line: -1 }, symbol] } });
    expect(await parsePushSnapshotStream(split(text), now)).toEqual(parsePushSnapshot(text, now));
  });

  it('keeps timers progressing through a large single input chunk and row indexing', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ ...symbol, id: `id${i}`, name: `name${i}`,
      path: `lib/target${i}.ts`, aliases: [`alias${i}`], signature: 'x'.repeat(300) }));
    const text = JSON.stringify({ ...raw(), edges: rows.map((row, i) => ({ ...edge,
      importer: `app/use${i}.ts`, imported: row.path })), symbols: { ...raw().symbols, symbols: rows } });
    let ticks = 0;
    let maxGap = 0;
    let previous = performance.now();
    const timer = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - previous);
      previous = t; ticks++; }, 1);
    try {
      const result = await parsePushSnapshotStream(Readable.from([text]), now);
      expect(result?.symbols?.size).toBe(40_000);
      expect(result?.importers.size).toBe(20_000);
      expect(ticks).toBeGreaterThan(5);
      expect(maxGap).toBeLessThan(250);
    } finally { clearInterval(timer); }
  }, 30_000);

  it('fails closed on input errors and closes the source', async () => {
    const input = Readable.from((async function* () { yield JSON.stringify(raw()).slice(0, -1);
      throw new Error('read failed'); })());
    expect(await parsePushSnapshotStream(input, now)).toBeNull();
    expect(input.destroyed).toBe(true);
  });

  it('cancels a partial load without publishing its rows', async () => {
    const controller = new AbortController();
    let closed = false;
    async function* input() {
      try {
        yield JSON.stringify(raw()).slice(0, -1);
        controller.abort();
        yield '}';
      } finally { closed = true; }
    }
    expect(await parsePushSnapshotStream(input(), now, controller.signal)).toBeNull();
    expect(closed).toBe(true);
  });

  it('serves cold reads immediately and replaces warm cache only after a complete valid load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'push-snapshot-'));
    fixturePath.current = join(dir, 'snapshot.json');
    try {
      await writeFile(fixturePath.current, JSON.stringify(raw()));
      expect(peekPushSnapshot('fixture', now)).toBeNull();
      await vi.waitFor(() => expect(peekPushSnapshot('fixture', now)?.commit).toBe('a'.repeat(40)));
      const warm = peekPushSnapshot('fixture', now);
      await writeFile(fixturePath.current, JSON.stringify(raw()).slice(0, -1));
      expect(peekPushSnapshot('fixture', now + 60_000)).toBe(warm);
      await vi.waitFor(() => expect(peekPushSnapshot('fixture', now + 60_000)).toBeNull());
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
