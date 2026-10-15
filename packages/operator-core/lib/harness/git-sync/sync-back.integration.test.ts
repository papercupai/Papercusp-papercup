/**
 * P-016 sync-back against REAL git repositories: an "upstream" main repo (origin),
 * a working-copy clone on `staging`, upstream advancing (including a merged PR whose
 * commits came from the copy), and a genuine content conflict.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideSyncBack, runSyncBack, syncBackConflictTitle, type SyncBackRunGit } from './sync-back';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8' }).trim();
const runGit: SyncBackRunGit = async (args, cwd) => {
  const r = spawnSync('git', [...ID, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { upstream: string; copy: string } {
  const root = mkdtempSync(join(tmpdir(), 'sync-back-'));
  dirs.push(root);
  const upstream = join(root, 'upstream');
  execFileSync('git', ['init', '-q', '-b', 'main', upstream]);
  writeFileSync(join(upstream, 'a.txt'), 'base\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-qm', 'base');
  const copy = join(root, 'copy');
  execFileSync('git', ['clone', '-q', upstream, copy]);
  git(copy, 'checkout', '-qb', 'staging');
  return { upstream, copy };
}

const opts = { upstreamRemote: 'origin', upstreamBranch: 'main', integrationBranch: 'staging', identityArgs: ID };

describe('runSyncBack (real git)', () => {
  it('merges an advanced upstream main — including a merged PR of our own work — into staging', async () => {
    const { upstream, copy } = setup();
    // The copy's work, merged upstream as a PR with a merge commit (D-007 merge method).
    writeFileSync(join(copy, 'ours.txt'), 'pot work\n');
    git(copy, 'add', '.');
    git(copy, 'commit', '-qm', 'pot work');
    git(upstream, 'fetch', '-q', copy, 'staging:pr-head');
    git(upstream, 'merge', '-q', '--no-ff', '-m', 'Merge PR', 'pr-head');
    // Someone else's change lands upstream too.
    writeFileSync(join(upstream, 'theirs.txt'), 'upstream work\n');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-qm', 'upstream work');
    const upstreamTip = git(upstream, 'rev-parse', 'HEAD');

    const result = await runSyncBack(runGit, copy, opts);

    expect(result).toMatchObject({ status: 'merged', upstreamSha: upstreamTip });
    expect(readFileSync(join(copy, 'theirs.txt'), 'utf8')).toBe('upstream work\n');
    // Next PR shows only new work: nothing on staging is missing from upstream.
    // Our work was fully merged upstream, so sync-back fast-forwards: zero commits ahead.
    expect(git(copy, 'rev-list', '--count', `${upstreamTip}..HEAD`)).toBe('0');
    expect(git(copy, 'diff', upstreamTip, 'HEAD', '--stat')).toBe('');
  });

  it('is a no-op when upstream main is already contained', async () => {
    const { copy } = setup();
    const before = git(copy, 'rev-parse', 'HEAD');
    const result = await runSyncBack(runGit, copy, opts);
    expect(result.status).toBe('up-to-date');
    expect(git(copy, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('aborts a conflicting sync-back to a clean tree and reports the conflicted paths', async () => {
    const { upstream, copy } = setup();
    writeFileSync(join(copy, 'a.txt'), 'copy edit\n');
    git(copy, 'commit', '-qam', 'copy edit');
    writeFileSync(join(upstream, 'a.txt'), 'upstream edit\n');
    git(upstream, 'commit', '-qam', 'upstream edit');
    const before = git(copy, 'rev-parse', 'HEAD');

    const result = await runSyncBack(runGit, copy, opts);

    expect(result).toMatchObject({ status: 'conflict', conflictedFiles: ['a.txt'] });
    expect(git(copy, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(copy, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(copy, 'a.txt'), 'utf8')).toBe('copy edit\n');
  });

  it('skips when the working copy is not on its integration branch', async () => {
    const { copy } = setup();
    git(copy, 'checkout', '-qb', 'feature');
    const result = await runSyncBack(runGit, copy, opts);
    expect(result.status).toBe('skipped');
  });
});

describe('decideSyncBack', () => {
  const base = { currentBranch: 'staging', integrationBranch: 'staging', upstreamSha: 'abc', upstreamIsAncestorOfHead: false };
  it('merges only when upstream is not contained', () => {
    expect(decideSyncBack(base)).toEqual({ action: 'merge', upstreamSha: 'abc' });
    expect(decideSyncBack({ ...base, upstreamIsAncestorOfHead: true })).toEqual({ action: 'up-to-date', upstreamSha: 'abc' });
    expect(decideSyncBack({ ...base, upstreamSha: null }).action).toBe('skip');
    expect(decideSyncBack({ ...base, currentBranch: 'main' }).action).toBe('skip');
  });
  it('titles conflicts stably per upstream sha', () => {
    expect(syncBackConflictTitle('origin', 'main', '0123456789abcdef')).toBe(
      'Sync-back conflict: merge origin/main @ 0123456789ab into the working copy',
    );
  });
});
