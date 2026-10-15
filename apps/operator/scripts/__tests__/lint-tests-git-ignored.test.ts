import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listGitIgnoredPaths, walkAll } from '../lint-tests';

// WI-10005450: lint:tests walked untracked, gitignored files in the shared tree. A registry
// glob naming an untracked test under the gitignored /scratchpad passed there, while every
// clean checkout (the green-checkpoint gate) failed STALE_GLOB + EMPTY_SECTION. The walk must
// see what a clean checkout sees, plus untracked files git does NOT ignore (new tests not yet
// committed, which lint:tests exists to catch).
describe('lint-tests walk skips git-ignored paths', () => {
  let root: string;

  const write = (rel: string) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '// test\n');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lint-tests-git-ignored-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '/scratchpad\n*.local.test.ts\n');
    write('pkg/lib/tracked.test.ts');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
    write('pkg/lib/new-uncommitted.test.ts');
    write('scratchpad/aggregate.test.mjs');
    write('pkg/lib/mine.local.test.ts');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists ignored directories and files relative to the root', () => {
    const ignored = listGitIgnoredPaths(root);
    expect([...ignored.dirs]).toEqual(['scratchpad']);
    expect([...ignored.files]).toEqual(['pkg/lib/mine.local.test.ts']);
  });

  it('walks tracked and untracked-unignored tests, but not ignored ones', async () => {
    const found = (await walkAll(root, undefined, '', listGitIgnoredPaths(root))).sort();
    expect(found).toEqual(['pkg/lib/new-uncommitted.test.ts', 'pkg/lib/tracked.test.ts']);
  });

  it('control: without an ignore set the walk does reach the ignored tests', async () => {
    const found = (await walkAll(root, undefined, '', null)).sort();
    expect(found).toEqual([
      'pkg/lib/mine.local.test.ts',
      'pkg/lib/new-uncommitted.test.ts',
      'pkg/lib/tracked.test.ts',
      'scratchpad/aggregate.test.mjs',
    ]);
  });

  it('falls back to an empty ignore set outside a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'lint-tests-no-git-'));
    try {
      const ignored = listGitIgnoredPaths(plain);
      expect(ignored.dirs.size + ignored.files.size).toBe(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
