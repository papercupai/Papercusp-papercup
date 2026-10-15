import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitRefContains, refContainsArgv, type GitStdoutRead } from './git-ref-contains';

/**
 * Real git, real history: the defect this module exists for lives in git's own walk, so a
 * fake runner cannot reproduce it. The fixture is the shape the release gate produces under
 * freeze-and-converge — ordinary commits, then a run of repair-queue admission commits that
 * all carry the deterministic 2000-01-01 date (ADMISSION_GIT_DATE) — long enough to exceed
 * git's SLOP of 5.
 */
let repo: string;
let target: string; // an ordinary commit the admission tip contains
let side: string; // a commit on a branch the admission tip does NOT contain
let admitTip: string;

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commit(message: string, date: string): string {
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(['rev-parse', 'HEAD']);
}
const read: GitStdoutRead = async (args) => {
  try {
    return git(args);
  } catch {
    return null; // the stdout-only runner contract: any non-zero exit is a failed read
  }
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'git-ref-contains-'));
  git(['init', '-q', '-b', 'main']);
  for (let i = 1; i <= 30; i++) {
    const sha = commit(`c${i}`, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`);
    if (i === 10) target = sha;
  }
  git(['checkout', '-q', '-b', 'side', `${target}~3`]);
  side = commit('side work', '2026-02-01T00:00:00Z');
  git(['checkout', '-q', 'main']);
  for (let k = 1; k <= 70; k++) admitTip = commit(`admit ${k}`, '2000-01-01T00:00:00Z');
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('gitRefContains', () => {
  it('calibration: the fixture reproduces the date-ordered rev-list miscount', () => {
    // Without this, a git that stopped miscounting would turn every case below vacuous.
    expect(git(['merge-base', '--is-ancestor', target, admitTip])).toBe('');
    expect(Number(git(['rev-list', '--count', `${admitTip}..${target}`]))).toBeGreaterThan(0);
  });

  it('reports a commit contained when the ref heads a long run of 2000-01-01 admission commits', async () => {
    await expect(gitRefContains(read, admitTip, target)).resolves.toBe(true);
  });

  it('reports a commit NOT contained when it is not an ancestor', async () => {
    await expect(gitRefContains(read, admitTip, side)).resolves.toBe(false);
  });

  it('accepts an abbreviated sha and a symbolic ref on either side', async () => {
    await expect(gitRefContains(read, 'main', target.slice(0, 10))).resolves.toBe(true);
    await expect(gitRefContains(read, 'main', 'side')).resolves.toBe(false);
    await expect(gitRefContains(read, admitTip, admitTip)).resolves.toBe(true);
  });

  it('keeps a failed read UNKNOWN, never "not contained"', async () => {
    await expect(gitRefContains(read, admitTip, 'f'.repeat(40))).resolves.toBeNull();
    await expect(gitRefContains(read, 'no-such-ref', target)).resolves.toBeNull();
  });

  it('asks git the merge-base question in the shape test fakes key on', () => {
    expect(refContainsArgv('origin/main', 'abc1234567')).toEqual(['merge-base', 'abc1234567', 'origin/main']);
  });
});
