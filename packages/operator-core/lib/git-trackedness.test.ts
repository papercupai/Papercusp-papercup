import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTracked as formatCheckIsTracked } from '../../../scripts/check-format.mjs';
import { isCommittedAtHead, isGitTrackedPath } from './git-trackedness';

/**
 * WI-10005009: git-sync rewrites .git/index on every sweep, and Git does not verify the
 * index checksum on ordinary reads. A half-written index makes `ls-files --error-unmatch`
 * answer "not tracked" for a tracked path, byte-for-byte like an untracked one. These
 * tests tear a real index and require the trackedness readers to keep answering from
 * HEAD's tree, which cannot be torn.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'trackedness-test',
  GIT_AUTHOR_EMAIL: 'trackedness-test@papercusp.invalid',
  GIT_COMMITTER_NAME: 'trackedness-test',
  GIT_COMMITTER_EMAIL: 'trackedness-test@papercusp.invalid',
};

const dirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function freshRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'git-trackedness-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  return dir;
}

/** A repo whose LAST index entry (sorted by path) is the committed subject. */
function repoWithCommittedSubject(): { dir: string; subject: string } {
  const dir = freshRepo();
  mkdirSync(path.join(dir, 'a'), { recursive: true });
  for (let i = 0; i < 60; i += 1) writeFileSync(path.join(dir, 'a', `f${String(i).padStart(2, '0')}.ts`), `x${i}\n`);
  mkdirSync(path.join(dir, 'zz'), { recursive: true });
  writeFileSync(path.join(dir, 'zz', 'subject.ts'), 'subject\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return { dir, subject: 'zz/subject.ts' };
}

function indexPath(dir: string): string {
  return path.join(dir, '.git', 'index');
}

function rawIndexSaysTracked(dir: string, rel: string): boolean {
  return spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore' }).status === 0;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('git trackedness under a torn index (WI-10005009)', () => {
  it('answers true for a committed path when the index is truncated to half its size', async () => {
    const { dir, subject } = repoWithCommittedSubject();
    expect(await isGitTrackedPath(dir, subject)).toBe(true);
    truncateSync(indexPath(dir), Math.floor(statSync(indexPath(dir)).size / 2));
    // Calibration: the raw index read really does misreport, so this is not vacuous.
    expect(rawIndexSaysTracked(dir, subject)).toBe(false);
    expect(await isGitTrackedPath(dir, subject)).toBe(true);
    expect(await isCommittedAtHead(dir, subject)).toBe(true);
    expect(formatCheckIsTracked(subject, dir)).toBe(true);
  });

  it('answers true for a committed path when the index is zero bytes', async () => {
    const { dir, subject } = repoWithCommittedSubject();
    truncateSync(indexPath(dir), 0);
    expect(rawIndexSaysTracked(dir, subject)).toBe(false);
    expect(await isGitTrackedPath(dir, subject)).toBe(true);
    expect(formatCheckIsTracked(subject, dir)).toBe(true);
  });

  it('still answers false for a genuinely untracked path, torn index or not', async () => {
    const { dir } = repoWithCommittedSubject();
    writeFileSync(path.join(dir, 'zz', 'untracked.ts'), 'new\n');
    expect(await isGitTrackedPath(dir, 'zz/untracked.ts')).toBe(false);
    expect(formatCheckIsTracked('zz/untracked.ts', dir)).toBe(false);
    truncateSync(indexPath(dir), Math.floor(statSync(indexPath(dir)).size / 2));
    // A torn index may answer 1 (false) or fail outright (unknown); either is honest.
    // What must never happen is the HEAD cross-check inventing a positive.
    expect(await isGitTrackedPath(dir, 'zz/untracked.ts')).not.toBe(true);
    expect(await isCommittedAtHead(dir, 'zz/untracked.ts')).toBe(false);
    expect(formatCheckIsTracked('zz/untracked.ts', dir)).toBe(false);
  });

  it('keeps index semantics for a staged, not yet committed path', async () => {
    const { dir } = repoWithCommittedSubject();
    writeFileSync(path.join(dir, 'zz', 'staged.ts'), 'staged\n');
    git(dir, 'add', '--', 'zz/staged.ts');
    expect(await isCommittedAtHead(dir, 'zz/staged.ts')).toBe(false);
    expect(await isGitTrackedPath(dir, 'zz/staged.ts')).toBe(true);
  });

  it('resolves a path relative to a subdirectory cwd, the shape plan-audits uses', async () => {
    const { dir } = repoWithCommittedSubject();
    expect(await isCommittedAtHead(path.join(dir, 'zz'), 'subject.ts')).toBe(true);
    expect(await isCommittedAtHead(path.join(dir, 'zz'), 'missing.ts')).toBe(false);
  });

  it('reports unknown from HEAD before the first commit and keeps the index answer', async () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, 'loose.ts'), 'loose\n');
    expect(await isCommittedAtHead(dir, 'loose.ts')).toBeUndefined();
    expect(await isGitTrackedPath(dir, 'loose.ts')).toBe(false);
  });
});
