import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  distAtomicWritesPlugin,
  emittedByteLength,
  isHashedAssetPath,
  shouldSkipRewrite,
} from './dist-atomic-writes';

describe('isHashedAssetPath', () => {
  it('matches vite content-hashed asset names under assets/', () => {
    expect(isHashedAssetPath('assets/chunk-ChpBd9eV.js')).toBe(true);
    expect(isHashedAssetPath('assets/index-rh4S1XDb.js')).toBe(true);
    expect(isHashedAssetPath('assets/zh-CN-LNUGB5OW-DRnpNCTK.js')).toBe(true);
    expect(isHashedAssetPath('assets/z80-B8w_N1kM.js')).toBe(true);
    expect(isHashedAssetPath('assets/index-Bv2mPq9x.css')).toBe(true);
    expect(isHashedAssetPath('assets/chunk-ChpBd9eV.js.map')).toBe(true);
  });
  it('rejects html, non-hashed names, and files outside assets/', () => {
    expect(isHashedAssetPath('index.html')).toBe(false);
    expect(isHashedAssetPath('assets/short-x.js')).toBe(false); // hash too short
    expect(isHashedAssetPath('wordmark.svg')).toBe(false);
    expect(isHashedAssetPath('chunk-ChpBd9eV.js')).toBe(false); // not under assets/
  });
  it('honors a custom assetsDir', () => {
    expect(isHashedAssetPath('static/chunk-ChpBd9eV.js', 'static')).toBe(true);
    expect(isHashedAssetPath('assets/chunk-ChpBd9eV.js', 'static')).toBe(false);
  });
});

describe('shouldSkipRewrite', () => {
  it('skips only when the file exists with the identical byte length', () => {
    expect(shouldSkipRewrite(100, 100)).toBe(true);
    expect(shouldSkipRewrite(null, 100)).toBe(false); // new file — write it
    expect(shouldSkipRewrite(99, 100)).toBe(false); // truncated leftover — rewrite
  });
});

describe('emittedByteLength', () => {
  it('measures chunks, string assets, and binary assets in bytes', () => {
    expect(emittedByteLength({ type: 'chunk', code: 'abc' })).toBe(3);
    expect(emittedByteLength({ type: 'asset', source: 'abcd' })).toBe(4);
    expect(emittedByteLength({ type: 'asset', source: new Uint8Array(7) })).toBe(7);
    expect(emittedByteLength({ type: 'chunk', code: 'é' })).toBe(2); // utf8 bytes, not chars
  });
});

describe('distAtomicWritesPlugin', () => {
  it('preserves the complete in-memory output without writing HTML or touching retained asset mtimes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daw-memory-'));
    try {
      mkdirSync(join(dir, 'assets'));
      const file = join(dir, 'assets/chunk-ChpBd9eV.js');
      writeFileSync(file, 'same-bytes');
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(file, old, old);
      const before = statSync(file).mtimeMs;
      const plugin = distAtomicWritesPlugin();
      (plugin.configResolved as (c: unknown) => void)({ root: dir, build: { outDir: '.', write: false } });
      const bundle = {
        'index.html': { fileName: 'index.html', type: 'asset', source: '<html>candidate</html>' },
        'assets/chunk-ChpBd9eV.js': { fileName: 'assets/chunk-ChpBd9eV.js', type: 'chunk', code: 'same-bytes' },
      };
      (plugin.generateBundle as { handler: (o: unknown, b: unknown) => void }).handler({}, bundle);
      (plugin.writeBundle as () => void)();
      expect(Object.keys(bundle)).toHaveLength(2);
      expect(statSync(file).mtimeMs).toBe(before);
      expect(() => readFileSync(join(dir, 'index.html'))).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  function makePlugin(outDir: string) {
    const plugin = distAtomicWritesPlugin();
    (plugin.configResolved as (c: unknown) => void)({
      root: outDir,
      build: { outDir: '.', assetsDir: 'assets' },
    });
    return plugin;
  }

  it('drops identical existing hashed assets from the bundle and bumps their mtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daw-'));
    const assets = join(dir, 'assets');
    mkdirSync(assets, { recursive: true });
    const existing = join(assets, 'chunk-ChpBd9eV.js');
    writeFileSync(existing, 'same-bytes');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(existing, old, old);
    const beforeMtime = statSync(existing).mtimeMs;

    const plugin = makePlugin(dir);
    const bundle: Record<string, { fileName: string; type: string; code?: string; source?: string }> = {
      'assets/chunk-ChpBd9eV.js': {
        fileName: 'assets/chunk-ChpBd9eV.js',
        type: 'chunk',
        code: 'same-bytes',
      },
      'assets/new-Ab12Cd34.js': { fileName: 'assets/new-Ab12Cd34.js', type: 'chunk', code: 'new' },
      'assets/grew-Ef56Gh78.js': {
        fileName: 'assets/grew-Ef56Gh78.js',
        type: 'chunk',
        code: 'now-longer-content',
      },
    };
    writeFileSync(join(assets, 'grew-Ef56Gh78.js'), 'short'); // size mismatch → rewrite
    (plugin.generateBundle as { handler: (o: unknown, b: unknown) => void }).handler({}, bundle);

    expect(Object.keys(bundle).sort()).toEqual(['assets/grew-Ef56Gh78.js', 'assets/new-Ab12Cd34.js']);
    expect(statSync(existing).mtimeMs).toBeGreaterThan(beforeMtime); // prune-TTL keep-alive
    expect(readFileSync(existing, 'utf8')).toBe('same-bytes'); // never rewritten
  });

  it('stashes html out of the bundle and writes it atomically in writeBundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daw-'));
    const plugin = makePlugin(dir);
    const bundle: Record<string, { fileName: string; type: string; source?: string }> = {
      'index.html': { fileName: 'index.html', type: 'asset', source: '<html>new</html>' },
    };
    (plugin.generateBundle as { handler: (o: unknown, b: unknown) => void }).handler({}, bundle);
    expect(Object.keys(bundle)).toEqual([]); // vite will not write it non-atomically
    expect(() => readFileSync(join(dir, 'index.html'))).toThrow(); // not yet written

    (plugin.writeBundle as () => void)();
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<html>new</html>');
    // no temp debris left behind
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
