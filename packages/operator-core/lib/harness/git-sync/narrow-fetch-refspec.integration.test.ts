import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGitSync, type RunGit } from './run-git-sync';

const identity = ['-c', 'user.name=git-sync test', '-c', 'user.email=test@papercusp.local',
  '-c', 'commit.gpgsign=false'];
const runGit: RunGit = async (args, cwd, options) => {
  const result = spawnSync('git', [...identity, ...args], {
    cwd, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ...options?.env },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '',
    stderr: result.stderr || String(result.error ?? '') };
};
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', [...identity, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'git-sync-narrow-refspec-'));
  roots.push(root);
  const source = join(root, 'source');
  git(root, 'init', '-q', '-b', 'main', source);
  writeFileSync(join(source, 'file.txt'), 'base\n');
  git(source, 'add', 'file.txt');
  git(source, 'commit', '-qm', 'base');
  const copy = join(root, 'copy');
  git(root, 'clone', '-q', '--single-branch', '--branch', 'main', source, copy);
  git(copy, 'checkout', '-qb', 'staging');
  writeFileSync(join(copy, 'local.txt'), 'retained local work\n');
  git(copy, 'add', 'local.txt');
  git(copy, 'commit', '-qm', 'local staging work');
  // Match the drill's divergent staging, rather than the intentional exact-tip
  // preservation path that reconciles a clean main-equivalent HEAD as main.
  expect(git(copy, 'symbolic-ref', '--short', 'HEAD')).toBe('staging');
  expect(git(copy, 'rev-parse', 'HEAD')).not.toBe(git(copy, 'rev-parse', 'origin/main'));
  expect(git(copy, 'config', '--get-all', 'remote.origin.fetch'))
    .toBe('+refs/heads/main:refs/remotes/origin/main');
  git(source, 'checkout', '-qb', 'staging');
  writeFileSync(join(source, 'file.txt'), 'upstream\n');
  git(source, 'commit', '-qam', 'upstream staging');
  return { source, copy, tip: git(source, 'rev-parse', 'HEAD') };
}

describe('EI-26241353175595351: narrow clone fetch refspec', () => {
  const config = { push: false, pushSubmodules: false, branch: 'staging' };

  it('retains the fetched staging tip for reconciliation and the next tick', async () => {
    const { copy, tip } = fixture();
    const originalFetch = git(copy, 'config', '--get-all', 'remote.origin.fetch');
    expect(originalFetch).toBe('+refs/heads/main:refs/remotes/origin/main');
    expect((await runGit(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/staging'], copy)).code).toBe(1);

    const result = await runGitSync('narrow-refspec', { repoPath: copy, config, runGit, log: () => {} });

    expect(result.status, JSON.stringify(result)).not.toBe('error');
    expect(git(copy, 'rev-parse', 'refs/remotes/origin/staging')).toBe(tip);
    expect(git(copy, 'merge-base', '--is-ancestor', tip, 'HEAD')).toBe('');
    expect(readFileSync(join(copy, 'file.txt'), 'utf8')).toBe('upstream\n');
    expect(readFileSync(join(copy, 'local.txt'), 'utf8')).toBe('retained local work\n');
    expect(git(copy, 'config', '--get-all', 'remote.origin.fetch')).toBe(originalFetch);

    const objectsBefore = git(copy, 'count-objects', '-v');
    const again = await runGitSync('narrow-refspec', { repoPath: copy, config, runGit, log: () => {} });
    expect(again.status).toBe('nothing');
    expect(git(copy, 'rev-parse', 'refs/remotes/origin/staging')).toBe(tip);
    expect(git(copy, 'count-objects', '-v')).toBe(objectsBefore);
  });

  it('preserves local work and reports a genuine conflict after the tracking ref refresh', async () => {
    const { copy, tip } = fixture();
    writeFileSync(join(copy, 'file.txt'), 'local\n');
    git(copy, 'commit', '-qam', 'local work');
    const localTip = git(copy, 'rev-parse', 'HEAD');

    const result = await runGitSync('narrow-refspec', { repoPath: copy, config, runGit, log: () => {} });

    expect(result.status, JSON.stringify(result)).toBe('conflict');
    expect(git(copy, 'rev-parse', 'refs/remotes/origin/staging')).toBe(tip);
    expect(git(copy, 'rev-parse', 'HEAD')).toBe(localTip);
    expect(readFileSync(join(copy, 'file.txt'), 'utf8')).toBe('local\n');
    expect(git(copy, 'status', '--porcelain')).toBe('');
  });
});
