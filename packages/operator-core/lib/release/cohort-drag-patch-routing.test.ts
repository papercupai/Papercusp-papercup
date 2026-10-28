/**
 * P-003 / bar R-3 (change-provenance-and-admission-throughput-2026-10-27): a cohort-drag test
 * refused by a whole-blob admission gets a patch-commit proposal EXACTLY when its repair-head
 * blob equals its blob in the parent of the commit that last changed it on the integration
 * branch — and confirming that proposal replays only that commit's change to that one file.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isCohortTestPath, routeCohortDragTests } from './cohort-drag-patch-routing';
import { buildCommittedPatchSource } from './hunk-exact-admission';

const TEMP: string[] = [];
afterEach(() => {
  for (const d of TEMP.splice(0)) rmSync(d, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'cohort-drag-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));
const GIT_ENV = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000, killSignal: 'SIGKILL' }).trim();
}
function sweep(root: string, edits: Record<string, string | null>, msg: string): string {
  for (const [rel, content] of Object.entries(edits)) {
    if (content === null) rmSync(join(root, rel));
    else {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}
/** A fresh repo on `staging`; the base commit is the repair head. */
function repo(): { root: string; repairHead: string } {
  const root = mkdtempSync(join(tmpdir(), 'cohort-drag-'));
  TEMP.push(root);
  git(root, ['init', '-q', '-b', 'staging']);
  const repairHead = sweep(root, {
    'src/a.ts': 'export const a = 1;\n',
    'src/a.test.ts': "import { a } from './a';\nit('a', () => expect(a).toBe(1));\n",
    'src/b.test.ts': "import { a } from './a';\nit('b', () => expect(a).toBe(1));\n",
    'src/other.ts': 'export const other = 1;\n',
  }, 'base');
  return { root, repairHead };
}
const blob = (root: string, rev: string, path: string) => git(root, ['rev-parse', `${rev}:${path}`]);

describe('routeCohortDragTests', () => {
  it('proposes the last commit for a test changed once since the repair head (safe)', () => {
    const { root, repairHead } = repo();
    const fix = sweep(root, { 'src/a.test.ts': "import { a } from './a';\nit('a', () => expect(a).toBe(2));\n" }, 'fix a.test');
    const r = routeCohortDragTests({ root, repairHead, integrationRef: 'staging', paths: ['src/a.test.ts'] });
    expect(r).toEqual({
      ok: true,
      routed: [{ path: 'src/a.test.ts', patchCommit: fix, parent: repairHead, preFixBlob: blob(root, repairHead, 'src/a.test.ts') }],
      unrouted: [],
    });
  });

  it('refuses a test changed twice since the repair head (unsafe: repair-head blob differs from the pre-fix blob)', () => {
    const { root, repairHead } = repo();
    sweep(root, { 'src/b.test.ts': '// first agent\n' }, 'first edit');
    const second = sweep(root, { 'src/b.test.ts': '// second agent\n' }, 'second edit');
    const r = routeCohortDragTests({ root, repairHead, integrationRef: 'staging', paths: ['src/b.test.ts'] });
    if (!r.ok) throw new Error(r.detail);
    expect(r.routed).toEqual([]);
    expect(r.unrouted).toEqual([{
      path: 'src/b.test.ts',
      reason: 'repair-head-differs',
      patchCommit: second,
      repairHeadBlob: blob(root, repairHead, 'src/b.test.ts'),
      preFixBlob: blob(root, `${second}^`, 'src/b.test.ts'),
    }]);
  });

  it('classifies a safe and an unsafe refused file in one pass, keeping input order', () => {
    const { root, repairHead } = repo();
    sweep(root, { 'src/b.test.ts': '// one\n' }, 'b once');
    const aFix = sweep(root, { 'src/a.test.ts': '// a fixed\n' }, 'a once');
    sweep(root, { 'src/b.test.ts': '// two\n' }, 'b twice');
    const r = routeCohortDragTests({ root, repairHead, integrationRef: 'staging', paths: ['src/b.test.ts', 'src/a.test.ts', 'src/a.ts'] });
    if (!r.ok) throw new Error(r.detail);
    expect(r.routed.map((x) => [x.path, x.patchCommit])).toEqual([['src/a.test.ts', aFix]]);
    expect(r.unrouted.map((x) => [x.path, x.reason])).toEqual([['src/b.test.ts', 'repair-head-differs'], ['src/a.ts', 'not-a-test']]);
  });

  it('confirming the proposal replays only that commit\'s change to that file, even when the commit touched other files', () => {
    const { root, repairHead } = repo();
    const fix = sweep(root, {
      'src/a.test.ts': '// fixed test\n',
      'src/other.ts': 'export const other = 2; // a peer change in the same sweep\n',
    }, 'sweep: fix plus unrelated edit');
    const r = routeCohortDragTests({ root, repairHead, integrationRef: 'staging', paths: ['src/a.test.ts'] });
    if (!r.ok) throw new Error(r.detail);
    expect(r.routed).toHaveLength(1);
    const proposal = r.routed[0]!;
    const built = buildCommittedPatchSource({
      root, repairHead, integrationRef: 'staging', patchCommit: proposal.patchCommit, paths: [proposal.path], reason: 'R-3 routing fixture',
    });
    if (!built.ok) throw new Error(built.detail);
    expect(proposal.patchCommit).toBe(fix);
    expect(git(root, ['diff', '--name-only', repairHead, built.sourceCommit]).split('\n')).toEqual(['src/a.test.ts']);
    expect(blob(root, built.sourceCommit, 'src/a.test.ts')).toBe(blob(root, fix, 'src/a.test.ts'));
    expect(blob(root, built.sourceCommit, 'src/other.ts')).toBe(blob(root, repairHead, 'src/other.ts'));
  });

  it('routes a test added after the repair head (absent at both repair head and pre-fix parent)', () => {
    const { root, repairHead } = repo();
    const add = sweep(root, { 'src/new.test.ts': "import { a } from './a';\n" }, 'add test');
    const r = routeCohortDragTests({ root, repairHead, integrationRef: 'staging', paths: ['src/new.test.ts'] });
    expect(r).toEqual({ ok: true, routed: [{ path: 'src/new.test.ts', patchCommit: add, parent: repairHead, preFixBlob: null }], unrouted: [] });
  });

  it('refuses when the last change is a merge commit (the replay route needs a single parent)', () => {
    const { root, repairHead } = repo();
    git(root, ['checkout', '-q', '-b', 'side']);
    const side = sweep(root, { 'src/other.ts': '// side\n' }, 'side');
    git(root, ['checkout', '-q', 'staging']);
    sweep(root, { 'src/a.ts': 'export const a = 3;\n' }, 'main');
    // An evil merge: the merge commit itself changes the test.
    git(root, ['merge', '-q', '--no-ff', '--no-commit', side]);
    writeFileSync(join(root, 'src/a.test.ts'), '// changed in the merge\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'merge side']);
    const merge = git(root, ['rev-parse', 'HEAD']);
    const r = routeCohortDragTests({ root, repairHead, integrationRef: 'staging', paths: ['src/a.test.ts'] });
    if (!r.ok) throw new Error(r.detail);
    expect(r.routed).toEqual([]);
    expect(r.unrouted).toEqual([{ path: 'src/a.test.ts', reason: 'merge-or-root-commit', patchCommit: merge }]);
  });

  it('reads the LOCAL integration ref, not HEAD, and reports a test with no commit there', () => {
    const { root, repairHead } = repo();
    git(root, ['checkout', '-q', '-b', 'elsewhere']);
    sweep(root, { 'src/a.test.ts': '// only on elsewhere\n', 'src/ghost.test.ts': '// ghost\n' }, 'elsewhere');
    const r = routeCohortDragTests({ root, repairHead, integrationRef: 'staging', paths: ['src/a.test.ts', 'src/ghost.test.ts'] });
    if (!r.ok) throw new Error(r.detail);
    // On staging the last change to a.test.ts is the base commit, which has no parent.
    expect(r.unrouted.map((x) => [x.path, x.reason])).toEqual([
      ['src/a.test.ts', 'merge-or-root-commit'],
      ['src/ghost.test.ts', 'no-commit-on-integration'],
    ]);
  });

  it('fails closed on a git error instead of proposing', () => {
    const { root } = repo();
    const r = routeCohortDragTests({ root, repairHead: 'deadbeef'.repeat(5), integrationRef: 'staging', paths: ['src/a.test.ts'] });
    expect(r).toMatchObject({ ok: false, code: 'git-failed', step: 'resolve repair head' });
  });

  it('uses the whole-blob cohort check\'s test-file rule', () => {
    expect(['a.test.ts', 'a.spec.tsx', 'a.test.mjs', 'a.ts', 'a.test.json'].map(isCohortTestPath)).toEqual([true, true, true, false, false]);
  });
});
