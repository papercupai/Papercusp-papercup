import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearGitStatsCacheForTests,
  NotGitRepositoryError,
  readGitStats,
} from './git-stats';

let roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}

function makeRepository(): { repo: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-git-stats-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const dependency = join(root, 'dependency');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Stats Tester');
  git(repo, 'config', 'user.email', 'stats@example.test');
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src', 'answer.ts'), '/* header */\nexport const answer = 42;\n\n// note\n');
  writeFileSync(
    join(repo, 'tests', 'answer.test.ts'),
    "import { answer } from '../src/answer';\n\ntest('answer', () => {\n  expect(answer).toBe(42);\n});\n",
  );
  writeFileSync(join(repo, 'README.md'), '# Stats fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');

  git(root, 'init', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');

  mkdirSync(dependency);
  git(dependency, 'init', '-b', 'main');
  git(dependency, 'config', 'user.name', 'Dependency Tester');
  git(dependency, 'config', 'user.email', 'dependency@example.test');
  writeFileSync(join(dependency, 'dependency.txt'), 'nested repository contents\n');
  git(dependency, 'add', '.');
  git(dependency, 'commit', '-m', 'dependency root');
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'vendor/dep');
  git(repo, 'commit', '-m', 'record explicit gitlink');
  writeFileSync(join(repo, 'src', 'extra.ts'), 'export const extra = true;\n');
  git(repo, 'add', 'src/extra.ts');
  git(repo, 'commit', '-m', 'ahead of upstream');
  return { repo, remote };
}

beforeEach(() => clearGitStatsCacheForTests());
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('readGitStats', () => {
  it('separates live state from HEAD-cached history and content analysis', async () => {
    const { repo, remote } = makeRepository();
    const first = await readGitStats(repo);

    expect(first.cache.hit).toBe(false);
    expect(first.repository).toMatchObject({ branch: 'main', detached: false, clean: true });
    expect(first.push).toMatchObject({
      upstream: 'origin/main',
      remote: 'origin',
      remoteUrl: remote,
      provider: 'other',
      ahead: 2,
      behind: 0,
      status: 'ahead',
    });
    expect(first.history.commits).toBe(3);
    expect(first.contributors.top[0]).toMatchObject({
      name: 'Stats Tester',
      email: 'stats@example.test',
      commits: 3,
    });
    expect(first.footprint.submodules).toMatchObject({
      count: 1,
      entries: [{ path: 'vendor/dep', head: expect.any(String) }],
      detailsTruncated: false,
    });
    // The gitlink is explicit and is not folded into committed blob totals.
    expect(first.footprint.trackedFiles).toBe(5);
    expect(first.composition.production.codeLines).toBeGreaterThan(0);
    expect(first.composition.production.commentLines).toBeGreaterThan(0);
    expect(first.composition.testsAndFixtures.codeLines).toBeGreaterThan(0);
    expect(first.composition.languages.find((row) => row.language === 'TypeScript')).toMatchObject({
      files: 3,
      testFiles: 1,
    });
    expect(first.coverage).toMatchObject({ treeComplete: true, truncated: false });

    writeFileSync(join(repo, 'src', 'answer.ts'), 'export const answer = 99;\n');
    writeFileSync(join(repo, 'untracked.txt'), 'not committed\n');
    const second = await readGitStats(repo);

    expect(second.cache.hit).toBe(true);
    expect(second.cache.generatedAt).toBe(first.cache.generatedAt);
    expect(second.repository.clean).toBe(false);
    expect(second.repository.changes).toMatchObject({ unstaged: 1, untracked: 1 });
    // Expensive composition remains an immutable HEAD measurement.
    expect(second.composition).toEqual(first.composition);

    const refreshed = await readGitStats(repo, { refresh: true });
    expect(refreshed.cache.hit).toBe(false);
    expect(refreshed.repository.clean).toBe(false);
    expect(refreshed.composition).toEqual(first.composition);
  });

  it('identifies a directory that is not a Git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-not-git-'));
    roots.push(root);
    await expect(readGitStats(root)).rejects.toBeInstanceOf(NotGitRepositoryError);
  });

  it('disables optional index locking on the live status probe', async () => {
    const { repo } = makeRepository();
    const shimRoot = mkdtempSync(join(tmpdir(), 'papercusp-git-stats-shim-'));
    roots.push(shimRoot);
    const bin = join(shimRoot, 'bin');
    mkdirSync(bin);
    const capturePath = join(shimRoot, 'status-env.txt');
    const realGitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shim = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      "if (args.includes('status')) fs.writeFileSync(process.env.GIT_STATUS_ENV_CAPTURE, process.env.GIT_OPTIONAL_LOCKS || 'unset');",
      'const child = spawnSync(process.env.GIT_STATUS_REAL_BINARY, args, { stdio: \'inherit\' });',
      'process.exit(child.status ?? 1);',
    ].join('\n');
    writeFileSync(join(bin, 'git'), shim, { mode: 0o755 });

    const previous = {
      path: process.env.PATH,
      optionalLocks: process.env.GIT_OPTIONAL_LOCKS,
      capturePath: process.env.GIT_STATUS_ENV_CAPTURE,
      realGitPath: process.env.GIT_STATUS_REAL_BINARY,
    };
    try {
      process.env.PATH = [bin, previous.path].filter(Boolean).join(delimiter);
      process.env.GIT_OPTIONAL_LOCKS = '1';
      process.env.GIT_STATUS_ENV_CAPTURE = capturePath;
      process.env.GIT_STATUS_REAL_BINARY = realGitPath;
      await readGitStats(repo, { refresh: true });
      expect(readFileSync(capturePath, 'utf8')).toBe('0');
    } finally {
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      if (previous.optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
      else process.env.GIT_OPTIONAL_LOCKS = previous.optionalLocks;
      if (previous.capturePath === undefined) delete process.env.GIT_STATUS_ENV_CAPTURE;
      else process.env.GIT_STATUS_ENV_CAPTURE = previous.capturePath;
      if (previous.realGitPath === undefined) delete process.env.GIT_STATUS_REAL_BINARY;
      else process.env.GIT_STATUS_REAL_BINARY = previous.realGitPath;
    }
  });
});
