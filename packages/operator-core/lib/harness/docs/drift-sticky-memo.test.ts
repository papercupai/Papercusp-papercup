/**
 * WI-10006256 — sticky-drift memo. The git-sync freshness sweep re-confirms every doc whose
 * anchors a tick touched; for a doc ALREADY drifted from its baseline that re-walk cannot
 * change the verdict (drift against a fixed baseline is monotone along history) yet cost
 * 5-11 s of git CPU per doc on the real tree. These tests pin the contract: a drifted range
 * result is reused while its evaluated head stays an ancestor of HEAD; fresh results are
 * never reused; a rewind recomputes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSubjectRefDrift, __clearDriftMemoForTests } from './drift';
import type { GitRunner } from './subject-ref';

let repo: string;
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
const logCalls = () => calls.filter((a) => a[0] === 'log');

const FN = (ret: string) => `export function alpha() {\n  return ${ret};\n}\n`;
let base = '';

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'drift-memo-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@papercusp.dev']);
  git(['config', 'user.name', 'Drift Memo Test']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/other.ts'), 'export const x = 1;\n');
  base = commitFile('src/foo.ts', FN('1'), 'c0 baseline');
  commitFile('src/foo.ts', FN('2'), 'c1 drift foo');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  __clearDriftMemoForTests();
  calls.length = 0;
});

const opts = () => ({ runGit, repoRoot: repo });

describe('sticky-drift memo (WI-10006256)', () => {
  it('evaluates the range against the resolved HEAD sha, never the moving HEAD ref', async () => {
    await checkSubjectRefDrift({ kind: 'path', globs: ['src/foo.ts'] }, base, opts());
    const ranges = logCalls().map((a) => a[1]);
    expect(ranges.length).toBe(1);
    expect(ranges[0]).toMatch(new RegExp(`^${base}\\.\\.[0-9a-f]{40}$`));
  });

  it('a drifted PATH ref is not re-walked after HEAD advances — and stays stale', async () => {
    const r1 = await checkSubjectRefDrift({ kind: 'path', globs: ['src/foo.ts'] }, base, opts());
    expect(r1.stale).toBe(true);
    expect(logCalls().length).toBe(1);

    commitFile('src/other.ts', `export const x = ${Date.now()};\n`, 'unrelated advance');
    calls.length = 0;
    const r2 = await checkSubjectRefDrift({ kind: 'path', globs: ['src/foo.ts'] }, base, opts());
    expect(r2.stale).toBe(true);
    expect(r2.changedPaths).toEqual(['src/foo.ts']);
    expect(logCalls()).toEqual([]); // the expensive walk did not run
    expect(calls.filter((a) => a[0] === 'merge-base').length).toBe(1);
  });

  it('a drifted SYMBOL ref (-L) is not re-walked either', async () => {
    const ref = { kind: 'symbol' as const, file: 'src/foo.ts', name: 'alpha' };
    expect((await checkSubjectRefDrift(ref, base, opts())).stale).toBe(true);
    calls.length = 0;
    expect((await checkSubjectRefDrift(ref, base, opts())).stale).toBe(true);
    expect(logCalls()).toEqual([]);
  });

  it('a FRESH result is never reused: a later drift is still detected', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const ref = { kind: 'path' as const, globs: ['src/foo.ts'] };
    expect((await checkSubjectRefDrift(ref, head, opts())).stale).toBe(false);

    commitFile('src/foo.ts', FN(`${Date.now()}`), 'drift after a fresh check');
    calls.length = 0;
    expect((await checkSubjectRefDrift(ref, head, opts())).stale).toBe(true);
    expect(logCalls().length).toBe(1);
  });

  it('a REWIND (memoized head no longer an ancestor of HEAD) recomputes', async () => {
    const ref = { kind: 'path' as const, globs: ['src/foo.ts'] };
    const before = git(['rev-parse', 'HEAD']);
    expect((await checkSubjectRefDrift(ref, base, opts())).stale).toBe(true);
    try {
      git(['reset', '-q', '--hard', base]);
      calls.length = 0;
      const r = await checkSubjectRefDrift(ref, base, opts());
      expect(r.stale).toBe(false); // base..base — nothing drifted on the rewound line
      expect(logCalls().length).toBe(1);
    } finally {
      git(['reset', '-q', '--hard', before]);
    }
  });

  it('a different baseline is a different key', async () => {
    const ref = { kind: 'path' as const, globs: ['src/foo.ts'] };
    expect((await checkSubjectRefDrift(ref, base, opts())).stale).toBe(true);
    const head = git(['rev-parse', 'HEAD']);
    calls.length = 0;
    expect((await checkSubjectRefDrift(ref, head, opts())).stale).toBe(false);
    expect(logCalls().length).toBe(1);
  });
});
