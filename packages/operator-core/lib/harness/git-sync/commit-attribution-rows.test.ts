/**
 * WI-6554700010018199 guard: git_sync_commit_attribution rows carry the repo the commit was
 * actually made in (a submodule path, not 'superproject') and the commit's own timestamp.
 * Real git repositories in a temp dir — the derivation under test IS the git behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitLocal } from '../docs/git-runner';
import { buildCommitAttributionRows, resolveAttributionRepo, SUPERPROJECT_REPO } from './commit-attribution-rows';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('git', ['-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: { ...GIT_ENV, ...env },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitFile(cwd: string, file: string, message: string, committerDate: string): string {
  writeFileSync(join(cwd, file), `${file} ${committerDate}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-q', '-m', message], { GIT_COMMITTER_DATE: committerDate, GIT_AUTHOR_DATE: committerDate });
  return git(cwd, ['rev-parse', 'HEAD']);
}

// The trailer shape run-git-sync writes: one Papercusp-Work-Item line, comma-separated.
const TRAILERS = 'agent edit\n\nPapercusp-Agent: su-test\nPapercusp-Work-Item: WI-1, WI-2';

let base = '';
let top = '';
let midDir = '';
let innerDir = '';

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'commit-attr-rows-')));
  // Origins for the two submodules.
  const innerOrigin = join(base, 'inner-origin');
  const midOrigin = join(base, 'mid-origin');
  for (const dir of [innerOrigin, midOrigin]) {
    git(base, ['init', '-q', dir]);
    commitFile(dir, 'README.md', 'init', '2026-01-01T00:00:00Z');
  }
  // top/ ⊃ libs/mid (submodule) ⊃ inner (nested submodule).
  top = join(base, 'top');
  git(base, ['init', '-q', top]);
  commitFile(top, 'top.txt', 'init', '2026-01-01T00:00:00Z');
  git(top, ['submodule', 'add', '-q', midOrigin, 'libs/mid']);
  git(top, ['commit', '-q', '-m', 'add mid']);
  midDir = join(top, 'libs', 'mid');
  git(midDir, ['submodule', 'add', '-q', innerOrigin, 'inner']);
  git(midDir, ['commit', '-q', '-m', 'add inner']);
  innerDir = join(midDir, 'inner');
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('resolveAttributionRepo', () => {
  it("labels the top-level repository 'superproject'", async () => {
    expect(await resolveAttributionRepo(top, runGitLocal)).toBe(SUPERPROJECT_REPO);
  });

  it('labels a submodule with its path relative to the top-level superproject', async () => {
    expect(await resolveAttributionRepo(midDir, runGitLocal)).toBe('libs/mid');
  });

  it('walks nested submodules to the outermost superproject', async () => {
    expect(await resolveAttributionRepo(innerDir, runGitLocal)).toBe('libs/mid/inner');
  });

  it('returns null outside any git repository', async () => {
    expect(await resolveAttributionRepo(base, runGitLocal)).toBeNull();
  });
});

describe('buildCommitAttributionRows', () => {
  it('records a submodule commit under its submodule repo, with the commit time, one row per file × work-item', async () => {
    const sha = commitFile(midDir, 'sub-change.ts', TRAILERS, '2026-10-17T10:23:00Z');
    const rows = await buildCommitAttributionRows({
      workspaceId: 'ws',
      harnessSlug: 'top/libs/mid',
      repoRoot: midDir,
      runGit: runGitLocal,
      recordedShas: async () => new Set(),
    });
    const mine = rows.filter((r) => r.commitSha === sha);
    expect(mine).toHaveLength(2);
    for (const r of mine) {
      expect(r.repo).toBe('libs/mid');
      expect(r.file).toBe('sub-change.ts');
      expect(r.agentId).toBe('su-test');
      expect(r.harnessSlug).toBe('top/libs/mid');
      expect(new Date(r.committedAt ?? '').toISOString()).toBe('2026-10-17T10:23:00.000Z');
    }
    expect(mine.map((r) => r.workItemId).sort()).toEqual(['WI-1', 'WI-2']);
    // Commits without Papercusp trailers ('init', 'add inner') produce no rows.
    expect(rows.every((r) => r.commitSha === sha)).toBe(true);
  });

  it("records a superproject commit as 'superproject'", async () => {
    const sha = commitFile(top, 'top-change.ts', 'edit\n\nPapercusp-Agent: su-top', '2026-10-18T08:00:00Z');
    const rows = await buildCommitAttributionRows({
      workspaceId: 'ws',
      harnessSlug: 'top',
      repoRoot: top,
      runGit: runGitLocal,
      recordedShas: async () => new Set(),
    });
    expect(rows).toEqual([
      expect.objectContaining({ commitSha: sha, repo: SUPERPROJECT_REPO, file: 'top-change.ts', agentId: 'su-top' }),
    ]);
    expect(rows[0]?.workItemId).toBeUndefined();
  });

  it('skips commits that are already recorded', async () => {
    const sha = commitFile(innerDir, 'inner-change.ts', TRAILERS, '2026-10-19T00:00:00Z');
    const asked: string[][] = [];
    const rows = await buildCommitAttributionRows({
      workspaceId: 'ws',
      harnessSlug: 'top/libs/mid/inner',
      repoRoot: innerDir,
      runGit: runGitLocal,
      recordedShas: async (shas) => {
        asked.push(shas);
        return new Set([sha]);
      },
    });
    expect(asked[0]).toContain(sha);
    expect(rows).toEqual([]);
  });
});
