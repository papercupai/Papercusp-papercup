import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

// Exercise the shipped dependency patch, not a second implementation of its cache.
const patch = readFileSync(new URL('../../../patches/tsx+4.21.0.patch', import.meta.url), 'utf8');
const variants = [
  { name: 'ESM', file: 'index-7AaEi15b.mjs', className: 'wn', instance: 'ie' },
  { name: 'CJS', file: 'index-gckBtVBf.cjs', className: 'dr', instance: 'se' },
];

type Variant = (typeof variants)[number];
type RuntimeCache = Map<string, unknown> & { expireDiskCache(): Promise<void> };

function cacheSource(variant: Variant, side: '+' | '-' = '+') {
  const header = 'diff --git a/node_modules/tsx/dist/' + variant.file + ' ';
  const start = patch.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = patch.indexOf('\ndiff --git ', start + header.length);
  const block = patch.slice(start, end < 0 ? undefined : end);
  const source = block.split('\n')
    .filter(line => line.startsWith(side) && !line.startsWith(side.repeat(3)))
    .map(line => line.slice(1)).join('\n');
  const classStart = source.indexOf('class ' + variant.className + ' extends Map');
  const classEnd = source.indexOf('var ' + variant.instance + '=', classStart);
  expect(classStart).toBeGreaterThanOrEqual(0);
  expect(classEnd).toBeGreaterThan(classStart);
  return source.slice(classStart, classEnd);
}

function fixture(variant: Variant, { entries = [], side = '+', deferDeletes = false }: {
  entries?: Array<[string, string]>; side?: '+' | '-'; deferDeletes?: boolean;
} = {}) {
  const files = new Map<string, string>(entries);
  const reads: string[] = [];
  const unlinked: string[] = [];
  const writes: Array<[string, string]> = [];
  const scheduled: Array<() => void> = [];
  const release: Array<() => void> = [];
  const counts = { mkdir: 0, enumerations: 0, scanned: 0, active: 0, maxActive: 0, unref: 0 };
  const fs = {
    mkdirSync() { counts.mkdir += 1; },
    readdirSync() { counts.enumerations += 1; return [...files.keys()]; },
    readFileSync(file: string, _encoding: string) {
      const name = path.basename(file);
      reads.push(name);
      const content = files.get(name);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    promises: {
      async writeFile(file: string, content: string) {
        writes.push([path.basename(file), content]);
        files.set(path.basename(file), content);
      },
      unlink(file: string) {
        const name = path.basename(file);
        unlinked.push(name);
        counts.active += 1;
        counts.maxActive = Math.max(counts.maxActive, counts.active);
        const finish = () => { counts.active -= 1; files.delete(name); };
        if (deferDeletes && unlinked.length <= 64) {
          return new Promise<void>(resolve => release.push(() => { finish(); resolve(); }));
        }
        finish();
        return Promise.resolve();
      },
      async opendir() {
        counts.enumerations += 1;
        return {
          async *[Symbol.asyncIterator]() {
            for (const name of [...files.keys()]) {
              counts.scanned += 1;
              yield { name };
            }
          },
        };
      },
      async access() { throw new Error('ENOENT'); },
    },
  };
  const readJson = (file: string) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
  };
  const context = {
    f: (value: unknown) => value,
    U: fs, j: fs, X: path, Xt: { tmpdir: () => '/tmp' }, Gt: { tmpdir: () => '/tmp' },
    Kt: '/cache', zt: { tmpdir: '/cache' }, Ge: readJson,
    ze: variant.name === 'ESM' ? () => 100 : () => {},
    He: () => 100, qe: () => {},
    setImmediate(callback: () => void) {
      scheduled.push(callback);
      return { unref() { counts.unref += 1; } };
    },
  };
  const Cache = vm.runInNewContext(cacheSource(variant, side) + '; ' + variant.className, context) as new () => RuntimeCache;
  return { cache: new Cache(), files, reads, unlinked, writes, scheduled, release, counts };
}

it('parses all three shipped postimages with the maintained patch-package installer', () => {
  const { parsePatchFile } = createRequire(import.meta.url)('patch-package/dist/patch/parse.js');
  const effects = parsePatchFile(patch) as Array<{ type: string; path: string }>;
  expect(effects.map(effect => [effect.type, effect.path])).toEqual([
    ['patch', 'node_modules/tsx/dist/cli.mjs'],
    ['patch', 'node_modules/tsx/dist/index-7AaEi15b.mjs'],
    ['patch', 'node_modules/tsx/dist/index-gckBtVBf.cjs'],
  ]);
});

describe.each(variants)('tsx $name shared transform cache', variant => {
  it('bounds a miss to eight reads without enumerating or creating the shared directory', () => {
    const entries = Array.from({ length: 4096 }, (_, i) => ['100-other' + i, '{}'] as [string, string]);
    const f = fixture(variant, { entries });
    expect(f.cache.get('missing')).toBeUndefined();
    expect(f.reads).toEqual(Array.from({ length: 8 }, (_, age) => (100 - age) + '-missing'));
    expect(f.counts.enumerations).toBe(0);
    expect(f.counts.mkdir).toBe(0);
    expect(f.scheduled).toHaveLength(0);
  });

  it('discovers a different process writing after construction and memoizes the disk hit', () => {
    const f = fixture(variant);
    f.files.set('100-late', '{"code":"late writer"}');
    const value = f.cache.get('late');
    expect(value).toEqual({ code: 'late writer' });
    expect(f.cache.get('late')).toBe(value);
    expect(f.reads).toEqual(['100-late']);
    expect(f.counts.enumerations).toBe(0);
  });

  it('reads the inclusive retention bucket and never unlinks failed or racing reads', () => {
    const f = fixture(variant, { entries: [
      ['100-key', '{partial write'],
      ['93-key', '{"code":"retained"}'],
      ['92-expired', '{"code":"expired"}'],
    ] });
    expect(f.cache.get('key')).toEqual({ code: 'retained' });
    expect(f.reads).toHaveLength(8);
    expect(f.cache.get('expired')).toBeUndefined();
    expect(f.reads).toHaveLength(16);
    expect(f.unlinked).toEqual([]);
    expect(f.files.get('100-key')).toBe('{partial write');
  });

  it('creates the directory once on writes and schedules unreferenced maintenance', () => {
    const f = fixture(variant);
    const value = { code: 'compiled' };
    expect(f.cache.set('first', value)).toBe(f.cache);
    f.cache.set('second', { code: 'second' });
    expect(f.cache.get('first')).toBe(value);
    expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([
      ['100-first', '{"code":"compiled"}'],
      ['100-second', '{"code":"second"}'],
    ]);
    expect(f.counts.mkdir).toBe(1);
    expect(f.scheduled).toHaveLength(1);
    expect(f.counts.unref).toBe(1);
    expect(f.counts.enumerations).toBe(0);
  });

  it('awaits each cleanup batch before scanning and deleting more entries', async () => {
    const entries = Array.from({ length: 65 }, (_, i) => ['92-expired' + i, '{}'] as [string, string]);
    const f = fixture(variant, { entries, deferDeletes: true });
    const completion = f.cache.expireDiskCache();
    await nextTurn();
    expect(f.counts.scanned).toBe(64);
    expect(f.unlinked).toHaveLength(64);
    expect(f.counts.maxActive).toBe(64);
    f.release.forEach(release => release());
    await completion;
    expect(f.counts.scanned).toBe(65);
    expect(f.unlinked).toHaveLength(65);
    expect(f.counts.active).toBe(0);
    expect(f.counts.maxActive).toBe(64);
  });

  it('expires only safely parsed old cache filenames and preserves fresh or unrelated entries', async () => {
    const f = fixture(variant, { entries: [
      ['92-old', '{}'], ['93-retained', '{}'], ['101-future', '{}'],
      ['notes', 'keep'], ['NaN-key', 'keep'], ['0-key-extra', 'keep'],
      ['9007199254740992-key', 'keep'], ['92-', 'keep'],
    ] });
    await f.cache.expireDiskCache();
    expect(f.unlinked).toEqual(['92-old']);
    expect(f.files.has('93-retained')).toBe(true);
    expect(f.files.has('notes')).toBe(true);
    expect(f.files.has('9007199254740992-key')).toBe(true);
  });

  it('distinguishes the original eager index from the bounded late-writer behavior', () => {
    const original = fixture(variant, { side: '-' });
    original.files.set('100-late', '{"code":"late"}');
    expect(original.counts.enumerations).toBe(1);
    expect(original.cache.get('late')).toBeUndefined();
    const repaired = fixture(variant);
    repaired.files.set('100-late', '{"code":"late"}');
    expect(repaired.counts.enumerations).toBe(0);
    expect(repaired.cache.get('late')).toEqual({ code: 'late' });
  });
});
