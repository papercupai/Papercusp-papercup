import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildCloneIndex, classifyClonePath, CLONE_MIN_MASS, cloneBlobSha, CloneIndex, cloneMemberSymbol, extractCloneFile, refreshCloneIndex } from './clone-index';

const fixtureDir = fileURLToPath(new URL('./__fixtures__/clone-corpus-20261021/', import.meta.url));
const root = resolve(fixtureDir, '../../../../../..');
const json = (name: string) => JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8'));
const body = 'const total = input.reduce((sum, value) => sum + value, 0); if (total > 10) { return total * 2; } return total - 1;';
const source = `export function calculate(input: number[]) { ${body} }`;
const renamed = 'export function tally(values: number[]) { const result = values.reduce((count, entry) => count + entry, 0); if (result > 20) { return result * 4; } return result - 2; }';
const lowFloor = { minMass: 10 };
const label = (fn: { path: string; line: number; name: string; mass: number }) => `${fn.path}:${fn.line} ${fn.name} m=${fn.mass}`;
const canonical = (groups: string[][]) => groups.map(group => [...group].sort()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));

describe('incremental TS/TSX clone index', () => {
  it('separates exact, renamed and non-identical structure; ignores comments and formatting', () => {
    const index = buildCloneIndex([
      { path: 'src/a.ts', source },
      { path: 'src/b.ts', source: source.replace('const total', '/* comment */ const   total') },
      { path: 'src/c.ts', source: renamed },
      { path: 'src/near.ts', source: source.replace('return total * 2;', 'return total * 2 + 1;') },
    ], lowFloor);
    const a = index.getFile('src/a.ts')!.functions.find(fn => fn.name === 'calculate')!;
    expect(index.lookup('exact', a.exact).map(fn => fn.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(index.lookup('renamed', a.renamed).map(fn => fn.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(index.getFile('src/near.ts')!.functions[0].renamed).not.toBe(a.renamed);
    expect(index.families('renamed')).toHaveLength(1);
    expect(a.signature).toBe('export function calculate(input: number[])');
  });

  it('retains the default80-node floor and supports configurable mass', () => {
    expect(CLONE_MIN_MASS).toBe(80);
    expect(extractCloneFile({ path: 'a.ts', source }).functions).toHaveLength(0);
    expect(extractCloneFile({ path: 'a.ts', source }, 10).functions.length).toBeGreaterThan(0);
    expect(() => new CloneIndex({ minMass: 0 })).toThrow('positive integer');
  });

  it('preserves complete exact and renamed families when a census omits the optional near index', () => {
    const full = new CloneIndex(lowFloor), census = new CloneIndex({ ...lowFloor, includeNear: false });
    const inputs = [{ path: 'a.ts', source }, { path: 'b.ts', source }, { path: 'c.ts', source: renamed }];
    for (const input of inputs) { full.update(input); census.update(input); }
    expect(census.getFiles()).toEqual(full.getFiles());
    expect(census.version).toBe(full.version);
    for (const kind of ['exact', 'renamed'] as const) expect(census.families(kind)).toEqual(full.families(kind));
    for (const index of [full, census]) {
      index.remove('b.ts'); index.update({ path: 'c.ts', source }); index.unavailable('a.ts');
    }
    expect(census.getFiles()).toEqual(full.getFiles());
    for (const kind of ['exact', 'renamed'] as const) expect(census.families(kind)).toEqual(full.families(kind));
  });

  it('finds inserted, removed and reordered near copies through the selected engine at the default floor', () => {
    const statements = ['let total = input;', 'if (input < 0) { total = -input; }',
      ...Array.from({ length: 20 }, (_, i) => `total += input * ${i + 1};`), 'return total;'];
    const wrap = (body: string[]) => `export function calculate(input: number) { ${body.join('\n')} }`;
    const base = wrap(statements);
    const variants = [
      { path: 'added.ts', source: wrap([...statements.slice(0, -1), 'total += 42;', 'return total;']) },
      { path: 'removed.ts', source: wrap(statements.filter((_, i) => i !== 5)) },
      { path: 'reordered.ts', source: wrap([statements[0], statements[2], statements[1], ...statements.slice(3)]) },
    ];
    const index = buildCloneIndex([{ path: 'base.ts', source: base }, ...variants,
      { path: 'renamed.ts', source: base.replaceAll('total', 'sum') },
      { path: 'exact.ts', source: base },
      { path: 'negative.ts', source: `function render() { ${'if (document.body) { throw new Error("bad"); }'.repeat(20)} }` },
    ]);
    const target = index.getFile('base.ts')!.functions[0];
    expect(target.mass).toBeGreaterThanOrEqual(CLONE_MIN_MASS);
    const near = index.near(target);
    expect(near.map(hit => hit.member.path).sort()).toEqual(['added.ts', 'removed.ts', 'reordered.ts']);
    expect(near.every(hit => hit.score >= 0.8 && hit.score < 1)).toBe(true);
    expect(index.lookup('exact', target.exact).map(fn => fn.path)).toEqual(['base.ts', 'exact.ts']);
    expect(index.lookup('renamed', target.renamed).map(fn => fn.path)).toEqual(['base.ts', 'exact.ts', 'renamed.ts']);
    const snippet = extractCloneFile({ path: 'snippet.ts', source: base }).functions[0];
    expect(index.near(snippet)).toEqual(near);
    expect(index.near(JSON.parse(JSON.stringify(target)))).toEqual([]);
    expect(Object.keys(target)).not.toContain('tree');
  });

  it('prunes near LSH memberships on changed blobs, syntax errors, unavailability and deletion', async () => {
    const base = `function f(input: number) { let total = input; ${'total += input * 2;'.repeat(24)} return total; }`;
    const changed = base.replace('return total;', 'total += 42; return total;');
    const index = buildCloneIndex([{ path: 'base.ts', source: base }, { path: 'copy.ts', source: changed }]);
    const target = index.getFile('base.ts')!.functions[0];
    const version = index.version;
    expect(index.near(target).map(hit => hit.member.path)).toEqual(['copy.ts']);
    expect(index.update({ path: 'copy.ts', source: changed }).changed).toBe(false);
    expect(index.version).toBe(version);
    for (const operation of [
      () => index.update({ path: 'copy.ts', source: 'function f( {' }),
      () => index.update({ path: 'copy.ts', source: 'const tiny = () => 1;' }),
      () => index.unavailable('copy.ts'),
      () => index.remove('copy.ts'),
    ]) {
      operation(); expect(index.near(target)).toEqual([]);
      index.update({ path: 'copy.ts', source: changed });
      expect(index.near(target)).toHaveLength(1);
    }
    await refreshCloneIndex(index, { changedPaths: ['copy.ts'], readSource: async () => null });
    expect(index.near(target)).toEqual([]);
    index.update({ path: 'copy.ts', source: changed });
    index.update({ path: 'base.ts', source: changed });
    expect(index.near(target)).toEqual([]); // stale caller-owned target
  });

  it('filters classified near copies and deduplicates candidates that share several bands', () => {
    const base = `function f(input: number) { let total = input; ${'total += input * 2;'.repeat(24)} return total; }`;
    const changed = base.replace('return total;', 'total += 42; return total;');
    const paths = ['src/copy.ts', 'src/copy.test.ts', 'templates/copy.ts', '_retired/copy.ts'];
    const index = buildCloneIndex([{ path: 'src/base.ts', source: base }, ...paths.map(path => ({ path, source: changed }))]);
    const target = index.getFile('src/base.ts')!.functions[0];
    expect(index.near(target).map(hit => hit.member.path)).toEqual(['src/copy.ts']);
    expect(index.near(target, { includeTests: true }).map(hit => hit.member.path)).toEqual(['src/copy.test.ts', 'src/copy.ts']);
    expect(index.near(target, { includeClassified: true })).toHaveLength(paths.length);
    const reverse = buildCloneIndex(index.getFiles().slice().reverse().map(file => ({
      path: file.path, source: file.path === 'src/base.ts' ? base : changed,
    })));
    expect(reverse.near(reverse.getFile('src/base.ts')!.functions[0])).toEqual(index.near(target));
  });

  it('classifies test/vendor/retired members while excluding them from ordinary families', () => {
    const paths = ['src/a.ts', 'src/b.ts', 'tests/a.spec.ts', 'templates/a.ts', 'libs/a/template-kit/a.ts', '_retired/a.ts', 'apps/operator/app/a.ts'];
    const index = buildCloneIndex(paths.map(path => ({ path, source })), lowFloor);
    expect(index.families()[0].members.map(fn => fn.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(index.families('renamed', { includeClassified: true })[0].members).toHaveLength(paths.length);
    expect(classifyClonePath('src/__tests__/a.ts').test).toBe(true);
    index.update({ path: 'src/__tests__/rig.ts', source });
    expect(index.families('renamed', { includeTests: true })[0].members.map(fn => fn.path))
      .toEqual(['src/__tests__/rig.ts', 'src/a.ts', 'src/b.ts', 'tests/a.spec.ts']);
    expect(classifyClonePath('node_modules/vendor/a.ts').vendored).toBe(true);
    expect(index.getFile('_retired/a.ts')!.functions[0].classification.retired).toBe(true);
    for (const path of ['a.d.ts', 'src/x.gen.ts', 'dist/a.ts', 'src/a.js']) {
      expect(extractCloneFile({ path, source }, 10).status).toBe('excluded');
    }
  });

  it('atomically removes stale memberships on change, syntax errors, deletion and missing reads', async () => {
    const index = buildCloneIndex([{ path: 'a.ts', source }, { path: 'b.ts', source }], lowFloor);
    const a = index.getFile('a.ts')!.functions[0], version = index.version;
    expect(index.update({ path: 'a.ts', source }).changed).toBe(false);
    expect(index.version).toBe(version);
    expect(() => index.update({ path: 'a.ts', source, blobSha: '0'.repeat(40) })).toThrow('identity mismatch');
    expect(index.version).toBe(version);
    index.update({ path: 'b.ts', source: 'export const tiny = () => 1;' });
    expect(index.families()).toHaveLength(0);
    expect(index.lookup('exact', a.exact)).toHaveLength(1);
    index.update({ path: 'b.ts', source });
    expect(index.families()).toHaveLength(1);
    index.update({ path: 'b.ts', source: 'export function broken( {' });
    expect(index.getFile('b.ts')!.status).toBe('syntax-error');
    expect(index.getFile('b.ts')!.diagnostics.length).toBeGreaterThan(0);
    expect(index.lookup('exact', a.exact)).toHaveLength(1);
    await refreshCloneIndex(index, { changedPaths: ['a.ts'], readSource: async () => null });
    expect(index.getFile('a.ts')!.status).toBe('unavailable');
    expect(index.lookup('exact', a.exact)).toHaveLength(0);
    expect(index.remove('b.ts')).toBe(true);
    expect(index.remove('b.ts')).toBe(false);
    index.update({ path: 'a.ts', source });
    await refreshCloneIndex(index, { changedPaths: ['a.ts'], readSource: async () => { throw new Error('read denied'); } });
    expect(index.getFile('a.ts')!.status).toBe('unavailable');
    expect(index.getFile('a.ts')!.diagnostics[0].message).toContain('read denied');
    expect(index.lookup('exact', a.exact)).toHaveLength(0);
  });

  it('keeps family identity stable across member path changes and updates only changed push blobs', async () => {
    const index = buildCloneIndex([{ path: 'a.ts', source }, { path: 'b.ts', source }], lowFloor);
    const id = index.families()[0].id;
    const hash = createHash('sha256').update(source).digest('hex');
    const readSource = vi.fn(async (_path: string) => source);
    const result = await refreshCloneIndex(index, {
      snapshot: { hashes: new Map([['a.ts', hash], ['b.ts', hash], ['c.ts', hash]]) },
      workingSet: { files: [{ path: 'd.tsx', reason: 'edited', hits: 1 }] },
      deletedPaths: ['b.ts'], readSource,
    });
    expect(result).toEqual({ updated: ['c.ts', 'd.tsx'], unchanged: ['a.ts'], unavailable: [], removed: ['b.ts'] });
    expect(readSource.mock.calls.map(call => call[0])).toEqual(['c.ts', 'd.tsx']);
    expect(index.families()[0].id).toBe(id);
    expect(index.getFile('a.ts')!.blobSha).toBe(cloneBlobSha(source));
  });

  it('extracts nested, generic, async, private, constructor, getter and JSX block bodies with locations', () => {
    const text = `class Example {
  constructor() { const input = [1,2]; ${body} }
  get value() { const input = [1,2]; ${body} }
  async #method<T>(input: number[]) { ${body} }
}
const render = (input: number[]) => { const child = <div title="x" />; ${body} };
const expression = (x: number) => x + 1;
const regular = function(input: number[]) { ${body} };
function outer(input: number[]) { function inner(input: number[]) { ${body} } return inner(input); }`;
    const file = extractCloneFile({ path: 'syntax.tsx', source: text }, 10);
    expect(file.status).toBe('indexed');
    const names = file.functions.map(fn => fn.name);
    expect(names).toEqual(['<anon>', 'value', '<anon>', 'render', 'regular', 'outer', 'inner']);
    // Anonymous members carry their enclosing symbol, so filing never names `<anon>`.
    expect(file.functions.map(cloneMemberSymbol)).toEqual(['Example.constructor', 'value', 'Example.#method',
      'render', 'regular', 'outer', 'inner']);
    expect(names).not.toContain('expression');
    expect(file.functions.find(fn => fn.name === 'render')!.line).toBe(6);
    expect(file.functions.every(fn => fn.column >= 1 && fn.end > fn.start)).toBe(true);
    expect(() => extractCloneFile({ path: '../outside.ts', source }, 10)).toThrow('repository-relative');
  });

  it('finds the frozen ten-copy governor family at the default floor with exact original labels', () => {
    const fixture = json('governor-sources.json');
    const rows = fixture.members;
    const index = buildCloneIndex(rows.map((row: { path: string; source: string; gitBlobSha1: string }) => ({
      path: row.path, source: row.source, blobSha: row.gitBlobSha1,
    })));
    expect(index.families()).toHaveLength(1);
    expect(index.families()[0].members.map(label).sort()).toEqual(rows.map((row: { label: string }) => row.label).sort());
    expect(index.families()[0].members).toHaveLength(10);
  });
});

/** Read immutable blobs in batches from the same submodule repositories as the
 * approved manifest. No checkout writes, network, current-tree substitution or
 * archived-probe execution; the NEW index alone parses the frozen source bytes.
 */
function historicalSources(): { path: string; source: string; blobSha: string }[] {
  const manifest = json('candidate-manifest-v3.json');
  const pins = [...manifest.submodules].sort((a, b) => b.path.length - a.path.length);
  const repositories = new Map<string, { path: string; sha256: string; gitBlobSha1: string; bytes: number }[]>();
  for (const file of manifest.files) {
    const pin = pins.find(pin => file.path.startsWith(pin.path + '/'));
    const repository = pin?.path ?? '';
    const rows = repositories.get(repository) ?? [];
    rows.push(file); repositories.set(repository, rows);
  }
  const result = [];
  for (const [repository, rows] of repositories) {
    const output = execFileSync('git', ['-C', resolve(root, repository), 'cat-file', '--batch'], {
      input: rows.map(row => row.gitBlobSha1).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024,
    });
    let offset = 0;
    for (const row of rows) {
      const end = output.indexOf(10, offset);
      const header = output.subarray(offset, end).toString('utf8').split(' ');
      expect(header[0], row.path).toBe(row.gitBlobSha1);
      expect(header[1], row.path).toBe('blob');
      const bytes = Number(header[2]);
      expect(bytes, row.path).toBe(row.bytes);
      const buffer = output.subarray(end + 1, end + 1 + bytes);
      expect(createHash('sha256').update(buffer).digest('hex'), row.path).toBe(row.sha256);
      result.push({ path: row.path, source: buffer.toString('utf8'), blobSha: row.gitBlobSha1 });
      offset = end + 1 + bytes + 1;
    }
    expect(offset).toBe(output.length);
  }
  return result;
}

describe('D012 historical reconstruction through the new clone index', () => {
  it('reproduces every327 raw family and the 164 filtered families/404 members minus the 3 env-sidecars families', { timeout: 120000 }, () => {
    const inputs = historicalSources();
    expect(inputs).toHaveLength(10339);
    const index = buildCloneIndex(inputs);
    const raw = index.families('renamed', { includeClassified: true, crossFile: false });
    expect(canonical(raw.map(family => family.members.map(label)))).toEqual(canonical(json('original-output.json').allType2));
    const filtered = index.families('renamed', { includeTests: true });
    // code-cleanup-campaigns-2026-10-26 P-002 deliberately departs from the archived probe:
    // papercusp-desktop/src-tauri/env-sidecars/** is a generated per-environment copy of
    // libs/papercusp/packages/harness/paths.ts, so it is now classified vendored. Exactly the
    // three paths.ts families (packageRoot, harnessRootCandidates, consider) lose a member.
    const original: string[][] = json('original-filtered-family-labels.json').families;
    const expected = original.map(f => f.filter(l => !/(?:^|\/)env-sidecars\//.test(l))).filter(f => f.length >= 2);
    expect(original.length - expected.length).toBe(3);
    expect(canonical(filtered.map(family => family.members.map(label)))).toEqual(canonical(expected));
    expect(filtered).toHaveLength(161);
    expect(filtered.reduce((n, family) => n + family.members.length, 0)).toBe(398);
    // D012 preserves this difference rather than claiming original-input identity.
    expect(index.getFiles().reduce((n, file) => n + file.functions.length, 0)).toBe(36183);
    expect(json('original-output.json').functionsAtOrAboveMinMass).toBe(36185);
  });
});
