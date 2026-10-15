/**
 * WI-10006256 — multi-path drift. A multi-pathspec `git log <base>..HEAD -- p1 p2` cannot
 * use git's changed-path Bloom filters, so on the real ~34k-commit range it cost 6-14 s per
 * doc. checkSubjectRefDrift now answers a multi-path group with an endpoint `git diff`
 * first, and only falls back to one single-pathspec `git log` per path when nothing
 * differs. These tests pin the verdicts (including touched-then-reverted, which an
 * endpoint diff alone would miss) and the shape of the git calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSubjectRefDrift, __clearDriftMemoForTests } from './drift';
import type { GitRunner } from './subject-ref';

let repo = '';
const calls: string[][] = [];

const runGit: GitRunner = (args, cwd) => {
  calls.push(args);
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return Promise.resolve({ code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') });
  }
};

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 }).trim();
}
function commitFile(path: string, body: string, msg: string): string {
  writeFileSync(join(repo, path), body);
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']);
}
/** Pathspec count of a `git log` call (everything after `--`). */
const pathspecCount = (args: string[]) => args.length - args.indexOf('--') - 1;
const logCalls = () => calls.filter((a) => a[0] === 'log');
const diffCalls = () => calls.filter((a) => a[0] === 'diff');

const ref = { kind: 'path' as const, globs: ['src/a.ts', 'src/b.ts'] };
let base = '';

beforeEach(() => {
  __clearDriftMemoForTests();
  calls.length = 0;
  repo = mkdtempSync(join(tmpdir(), 'drift-multipath-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@papercusp.dev']);
  git(['config', 'user.name', 'Drift Multipath Test']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  base = commitFile('src/b.ts', 'export const b = 1;\n', 'c0 baseline');
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

const opts = () => ({ runGit, repoRoot: repo });

describe('multi-path drift (WI-10006256)', () => {
  it('reports drift from an endpoint diff without any multi-pathspec history walk', async () => {
    commitFile('src/a.ts', 'export const a = 2;\n', 'c1 change a');
    commitFile('src/unrelated.ts', 'export const u = 1;\n', 'c2 unrelated');
    calls.length = 0;
    const r = await checkSubjectRefDrift(ref, base, opts());
    expect(r.stale).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.changedPaths).toEqual(['src/a.ts']);
    expect(diffCalls()).toHaveLength(1);
    expect(logCalls()).toHaveLength(0);
  });

  it('still reports a touched-then-reverted path as drift, via single-pathspec log walks', async () => {
    commitFile('src/b.ts', 'export const b = 2;\n', 'c1 change b');
    commitFile('src/b.ts', 'export const b = 1;\n', 'c2 revert b');
    calls.length = 0;
    const r = await checkSubjectRefDrift(ref, base, opts());
    expect(r.stale).toBe(true);
    expect(r.changedPaths).toEqual(['src/b.ts']);
    expect(diffCalls()).toHaveLength(1);
    expect(logCalls().length).toBeGreaterThan(0);
    for (const c of logCalls()) expect(pathspecCount(c)).toBe(1);
  });

  it('reports fresh (no error) when no anchored path changed', async () => {
    commitFile('src/unrelated.ts', 'export const u = 1;\n', 'c1 unrelated');
    calls.length = 0;
    const r = await checkSubjectRefDrift(ref, base, opts());
    expect(r.stale).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.changedPaths).toEqual([]);
    for (const c of logCalls()) expect(pathspecCount(c)).toBe(1);
  });

  it('surfaces a git error for an unknown baseline instead of reporting fresh', async () => {
    const r = await checkSubjectRefDrift(ref, '0123456789abcdef0123456789abcdef01234567', opts());
    expect(r.stale).toBe(false);
    expect(r.error).toMatch(/git-error/);
  });
});
