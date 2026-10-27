import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCloneIndex } from './clone-index';
import { assertBaselineShrinks, familyCounts, findNewClones, parseCloneBaseline, ratchetFamilies,
  seedCloneBaseline, shrinkCloneBaseline } from './clone-ratchet';

const source = `export function calculate(input: number[]) {
  let total = 0;
  const values = input.filter(value => value > 0);
  for (const value of values) {
    total += value * 2;
    if (total > 100) { total -= 3; } else { total += 5; }
  }
  const output = values.map(value => value + total);
  return output.reduce((sum, value) => sum + value, 0) + total;
}`;
const seed = { ref: 'fixture', sourceDigest: 'a'.repeat(64), files: 2 };
const makeIndex = (paths: string[]) => buildCloneIndex(paths.map(path => ({ path, source })));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('warning-only clone ratchet', () => {
  it('reports a planted exact copy in changed paths, including within one file', () => {
    const before = makeIndex(['a.ts']);
    const baseline = seedCloneBaseline(before, seed);
    const after = makeIndex(['a.ts', 'copy.ts']);
    expect(findNewClones(ratchetFamilies(after), baseline, ['copy.ts']).map(w => w.kind)).toEqual(['exact', 'renamed']);
    after.update({ path: 'a.ts', source: `${source}\n${source.replace('calculate', 'second')}` });
    after.remove('copy.ts');
    expect(findNewClones(ratchetFamilies(after), baseline, ['a.ts']).find(w => w.kind === 'exact')?.members).toHaveLength(2);
    after.update({ path: 'a.ts', source: `${source} ${source.replace('calculate', 'second')}`.replaceAll('\n', ' ') });
    expect(findNewClones(ratchetFamilies(after), baseline, ['a.ts']).find(w => w.kind === 'exact')?.members).toHaveLength(2);
  });

  it('finds renamed copies without calling a structural edit exact', () => {
    const index = makeIndex(['a.ts']);
    const baseline = seedCloneBaseline(index, seed);
    index.update({ path: 'renamed.ts', source: source.replaceAll('total', 'result').replaceAll('100', '200') });
    expect(findNewClones(ratchetFamilies(index), baseline, ['renamed.ts']).map(w => w.kind)).toEqual(['renamed']);
    index.update({ path: 'renamed.ts', source: source.replace('return output.reduce', 'throw output.reduce') });
    expect(findNewClones(ratchetFamilies(index), baseline, ['renamed.ts'])).toEqual([]);
  });

  it('leaves unchanged accepted families and unrelated changed paths quiet', () => {
    const index = makeIndex(['a.ts', 'b.ts']);
    const baseline = seedCloneBaseline(index, seed);
    expect(Object.keys(baseline.families)).toHaveLength(2);
    expect(findNewClones(ratchetFamilies(index), baseline, ['a.ts'])).toEqual([]);
    index.update({ path: 'copy.ts', source });
    expect(findNewClones(ratchetFamilies(index), baseline, ['unrelated.ts'])).toEqual([]);
    expect(findNewClones(ratchetFamilies(index), baseline, ['copy.ts'])).toHaveLength(2);
  });

  it('keeps rename-only and pre-existing unaccepted families quiet using the base', () => {
    const index = makeIndex(['a.ts', 'b.ts']);
    const previous = familyCounts(ratchetFamilies(index));
    const empty = seedCloneBaseline(makeIndex(['a.ts']), seed);
    index.remove('b.ts'); index.update({ path: 'moved.ts', source });
    expect(findNewClones(ratchetFamilies(index), empty, ['moved.ts'], previous)).toEqual([]);
    index.update({ path: 'new.ts', source });
    expect(findNewClones(ratchetFamilies(index), empty, ['new.ts'], previous)).toHaveLength(2);
  });

  it('can shrink counts and remove families, but cannot grow or re-add removed debt', () => {
    const index = makeIndex(['a.ts', 'b.ts', 'c.ts']);
    const original = seedCloneBaseline(index, seed);
    index.remove('c.ts');
    const smaller = shrinkCloneBaseline(original, ratchetFamilies(index));
    expect(Object.values(smaller.families)).toEqual([2, 2]);
    expect(() => assertBaselineShrinks(original, smaller)).not.toThrow();
    expect(() => assertBaselineShrinks(smaller, original)).toThrow('growth refused');
    index.remove('b.ts');
    const removed = shrinkCloneBaseline(smaller, ratchetFamilies(index));
    expect(removed.families).toEqual({});
    expect(() => assertBaselineShrinks(removed, smaller)).toThrow('growth refused');
    index.update({ path: 'c.ts', source });
    expect(shrinkCloneBaseline(removed, ratchetFamilies(index)).families).toEqual({});
  });

  it('refuses malformed or incompatible baseline data and metadata replacement', () => {
    const baseline = seedCloneBaseline(makeIndex(['a.ts', 'b.ts']), seed);
    expect(parseCloneBaseline(baseline, 80)).toBe(baseline);
    expect(() => parseCloneBaseline({ ...baseline, minMass: 1 }, 80)).toThrow('Incompatible');
    expect(() => parseCloneBaseline({ ...baseline, families: { fake: 2 } }, 80)).toThrow('Invalid');
    expect(() => assertBaselineShrinks(baseline, { ...baseline, seed: { ...seed, ref: 'other' } })).toThrow('metadata');
  });

  it('does not warn for tests, vendor, retired or a structurally different body', () => {
    const index = makeIndex(['a.ts', 'tests/a.test.ts', 'templates/a.ts', '_retired/a.ts']);
    index.update({ path: 'other.ts', source: 'export function other() { return null; }' });
    expect(ratchetFamilies(index)).toEqual([]);
  });
});

function fixture(paths = ['a.ts']) {
  const root = mkdtempSync(resolve(tmpdir(), 'clone-ratchet-')); temporary.push(root);
  mkdirSync(resolve(root, 'scripts'));
  for (const path of paths) writeFileSync(resolve(root, path), source);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  const commit = () => { git('add', '.'); git('-c', 'user.name=Clone Fixture', '-c', 'user.email=clone@example.invalid', 'commit', '--quiet', '-m', 'fixture'); };
  commit();
  const lint = (...args: string[]) => spawnSync(process.execPath,
    [resolve(repo, 'node_modules/tsx/dist/cli.mjs'), resolve(repo, 'scripts/check-new-clones.mts'), '--root', root, ...args],
    { encoding: 'utf8', timeout: 30_000 });
  const seeded = lint('--seed', '--json');
  expect(seeded.status, seeded.stderr).toBe(0);
  expect(JSON.parse(seeded.stdout).status).toBe('seeded');
  commit();
  return { root, lint, commit, git };
}

describe('real lint:new-clones CLI', () => {
  it('warns for an untracked planted copy, exits zero, accepts files-from, and never edits baseline', () => {
    const { root, lint } = fixture();
    const baselinePath = resolve(root, 'scripts/new-clones-baseline.json');
    const before = readFileSync(baselinePath, 'utf8');
    writeFileSync(resolve(root, 'copy.ts'), source);
    writeFileSync(resolve(root, 'changed.txt'), 'copy.ts\n');
    const result = lint('--files-from', resolve(root, 'changed.txt'), '--json');
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.mode).toBe('warn-only');
    expect(report.warnings.find((warning: { kind: string }) => warning.kind === 'exact').members
      .map((member: { path: string }) => member.path)).toEqual(['a.ts', 'copy.ts']);
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
    expect(lint('--changed-paths', 'copy.ts').stderr).toContain('WARNING exact');
    expect(JSON.parse(lint('--files=copy.ts,a.ts', '--json').stdout).warnings).toHaveLength(2);
    writeFileSync(resolve(root, 'changed.json'), JSON.stringify(['copy.ts', 'a.ts']));
    expect(JSON.parse(lint(`--files-from=${resolve(root, 'changed.json')}`, '--json').stdout).warnings).toHaveLength(2);
  }, 30_000);

  it('keeps a rename-only change quiet, and warns if baseline growth is attempted', () => {
    const { root, lint, commit, git } = fixture();
    writeFileSync(resolve(root, 'b.ts'), source);
    // This family was introduced after seeding. Even unaccepted old debt is quiet on a move.
    commit();
    git('mv', 'b.ts', 'moved.ts');
    expect(JSON.parse(lint('--files', 'moved.ts', '--json').stdout).warnings).toEqual([]);
    const baselinePath = resolve(root, 'scripts/new-clones-baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.families = familyCounts(ratchetFamilies(makeIndex(['a.ts', 'moved.ts'])));
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const result = lint('--changed-paths', 'moved.ts');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('baseline growth refused');
  }, 30_000);

  it('cannot reseed and reports unavailable evidence without blocking', () => {
    const { root, lint } = fixture();
    expect(lint('--seed').stderr).toContain('already exists');
    rmSync(resolve(root, 'scripts/new-clones-baseline.json'));
    const result = lint('--changed-paths', 'a.ts');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('NOT CHECKED (warn-only)');
  }, 30_000);

  it('persists a smaller baseline and refuses to restore removed debt on the next commit', () => {
    const { root, lint, commit, git } = fixture(['a.ts', 'b.ts']);
    const oldBase = git('rev-parse', 'HEAD').trim();
    rmSync(resolve(root, 'b.ts'));
    const before = readFileSync(resolve(root, 'scripts/new-clones-baseline.json'), 'utf8');
    const result = lint('--shrink', '--changed-paths', 'b.ts', '--json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).warnings).toEqual([]);
    const after = JSON.parse(readFileSync(resolve(root, 'scripts/new-clones-baseline.json'), 'utf8'));
    expect(after.families).toEqual({});
    commit();
    writeFileSync(resolve(root, 'scripts/new-clones-baseline.json'), before);
    expect(lint('--changed-paths', 'b.ts').stderr).toContain('baseline growth refused');
    commit();
    expect(lint('--base', oldBase, '--changed-paths', 'b.ts').stderr).toContain('baseline growth refused');
  }, 30_000);

  it('registers the advisory in affected guards with changed paths and the same base', () => {
    const registry = readFileSync(resolve(repo, 'scripts/affected-tests.mjs'), 'utf8');
    expect(registry).toMatch(/script: "lint:new-clones",\s+forwardChangedPaths: true,\s+forwardBase: true/);
    expect(JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')).scripts['lint:new-clones']).toBe('tsx scripts/check-new-clones.mts');
    expect(JSON.parse(readFileSync(resolve(repo, 'packages/operator-core/package.json'), 'utf8')).scripts['lint:new-clones']).toContain('../../scripts/check-new-clones.mts');
  });
});
