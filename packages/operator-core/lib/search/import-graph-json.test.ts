import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importGraph, resolveRelative, runtimeCallSites } from './import-graph';

describe('runtime import graph JSON assets', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'import-graph-json-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('resolves an imported JSON asset and keeps its contents out of the module walk', () => {
    const entry = join(root, 'entry.mjs');
    const asset = join(root, 'policy.json');
    writeFileSync(entry, "import policy from './policy.json' with { type: 'json' };\n");
    writeFileSync(asset, JSON.stringify({ text: "import './missing.ts'" }));
    expect(resolveRelative(entry, './policy.json')).toBe(asset);
    const graph = importGraph(entry);
    expect([...graph.modules]).toContain(asset);
    expect(graph.unresolved).toEqual([]);
  });

  it('reports a missing JSON asset as unresolved', () => {
    const entry = join(root, 'entry.mjs');
    writeFileSync(entry, "import policy from './missing.json' with { type: 'json' };\n");
    expect(importGraph(entry).unresolved).toEqual([{ from: entry, specifier: './missing.json' }]);
  });

  it('rejects malformed JSON rather than attesting a complete runtime graph', () => {
    const entry = join(root, 'entry.mjs');
    writeFileSync(entry, "import policy from './policy.json' with { type: 'json' };\n");
    writeFileSync(join(root, 'policy.json'), '{');
    expect(() => importGraph(entry)).toThrow(SyntaxError);
  });
});

describe('runtime call attribution through module exports', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'import-graph-calls-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const calls = () => [...runtimeCallSites(join(root, 'entry.ts'), ['runHybridSearch']).get('runHybridSearch')!];
  const write = (file: string, source: string) => writeFileSync(join(root, file), source);

  it('loads a multi-export module without attributing its unused search function', () => {
    write('entry.ts', "import { read } from './mixed'; export const handler = () => read();");
    write('mixed.ts', "import { runHybridSearch } from '@papercusp/search';\nexport function read() { return 1; }\nexport function search() { return runHybridSearch([], {}); }");
    expect([...importGraph(join(root, 'entry.ts')).modules]).toContain(join(root, 'mixed.ts'));
    expect(calls()).toEqual([]);
    write('entry.ts', "import { search as lookup } from './mixed'; export const handler = () => lookup();");
    expect(calls()).toEqual([join(root, 'mixed.ts')]);
  });

  it('follows aliased re-exports and local callback helpers, excluding type references and strings', () => {
    write('entry.ts', "import { lookup } from './barrel'; export default { handler: () => lookup() };");
    write('barrel.ts', "export { search as lookup } from './mixed';");
    write('mixed.ts', "import { runHybridSearch as hybrid } from '@papercusp/search';\nfunction execute() { return hybrid([], {}); }\nexport const search = () => Promise.resolve().then(execute);\nexport function unused() { return runFullTextSearch([], {}); }");
    expect(calls()).toEqual([join(root, 'mixed.ts')]);
    write('entry.ts', "import type { search } from './mixed'; export const text = 'runHybridSearch([], {})';");
    expect(calls()).toEqual([]);
  });

  it('keeps import-time calls visible even when only an unrelated export is referenced', () => {
    write('entry.ts', "import { read } from './mixed'; export const handler = () => read();");
    write('mixed.ts', "import { runHybridSearch } from '@papercusp/search';\nexport function read() { return 1; }\nconst ready = runHybridSearch([], {});");
    expect(calls()).toEqual([join(root, 'mixed.ts')]);
  });

  it('follows local export aliases, star re-exports and namespace imports conservatively', () => {
    write('entry.ts', "import * as mixed from './barrel'; export const handler = () => mixed.lookup();");
    write('barrel.ts', "export * from './mixed';");
    write('mixed.ts', "import { runHybridSearch } from '@papercusp/search';\nconst lookup = () => runHybridSearch([], {}); export { lookup };");
    expect(calls()).toEqual([join(root, 'mixed.ts')]);
  });

  it('terminates a cyclic export chain without inventing an engine call', () => {
    write('entry.ts', "import { read } from './a'; export const handler = () => read();");
    write('a.ts', "export { read } from './b';");
    write('b.ts', "export { read } from './a';");
    expect(calls()).toEqual([]);
  });

  it('follows anonymous default functions and namespace re-exports', () => {
    write('entry.ts', "import { searches } from './barrel'; export const handler = () => searches.default();");
    write('barrel.ts', "export * as searches from './mixed';");
    write('mixed.ts', "import { runHybridSearch } from '@papercusp/search'; export default function () { return runHybridSearch([], {}); }");
    expect(calls()).toEqual([join(root, 'mixed.ts')]);
    write('entry.ts', "import lookup from './mixed'; export const handler = () => lookup();");
    expect(calls()).toEqual([join(root, 'mixed.ts')]);
  });
});
