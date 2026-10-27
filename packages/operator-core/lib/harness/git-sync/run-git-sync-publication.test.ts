import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSyncYieldError, runGitSync, type GitSyncRootCommit, type GitSyncStepRunner, type RunGit, type RunGitSyncOpts } from './run-git-sync';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'git-sync-publication-'));
  roots.push(repo);
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
    return String(result.stdout).trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@papercusp.local');
  git('config', 'user.name', 'publication test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'baseline a\n');
  writeFileSync(join(repo, 'b.txt'), 'baseline b\n');
  git('add', '-A');
  git('commit', '-m', 'baseline');
  const runGit: RunGit = async (args, cwd, options) => {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...options?.env },
    });
    return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  const opts: RunGitSyncOpts = {
    repoPath: repo, runGit, submodulePaths: [],
    config: { push: false, pushSubmoduleOrigins: false },
    contentDetectors: [], deletionGuard: false, diffSubjects: false, log: () => {},
  };
  return { repo, git, runGit, opts };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('EI-270796 root publication notifications', () => {
  it('notifies a published group while a later publication remains pending', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'agent a\n');
    writeFileSync(join(f.repo, 'b.txt'), 'agent b\n');
    const reachedLater = gate();
    const releaseLater = gate();
    const commits: GitSyncRootCommit[] = [];
    let publications = 0;
    const running = runGitSync('test', {
      ...f.opts,
      loadRoster: async () => [
        { agent: 'su-a', intent: 'a', files: ['a.txt'] },
        { agent: 'su-b', intent: 'b', files: ['b.txt'] },
      ],
      runGit: async (args, cwd, options) => {
        const publishing = args[0] === 'update-ref' && args.includes('HEAD');
        if (publishing && publications === 1) {
          reachedLater.resolve();
          await releaseLater.promise;
        }
        const result = await f.runGit(args, cwd, options);
        if (publishing && result.code === 0) publications++;
        return result;
      },
      onRootCommit: (commit) => commits.push(commit),
    });
    try {
      await reachedLater.promise;
      expect(publications).toBe(1);
      expect(commits).toEqual([{ sha: f.git('rev-parse', 'HEAD'), committedAtMs: expect.any(Number) }]);
    } finally {
      releaseLater.resolve();
      await running;
    }
    expect(commits).toHaveLength(publications);
    expect(commits.map((commit) => commit.sha)).toEqual(f.git('rev-list', '--reverse', 'HEAD~2..HEAD').split('\n'));
  });

  it('replays per-commit producer proof before the later push phase without retimestamping', async () => {
    const f = fixture();
    const outputs = new Map<string, unknown>();
    const step: GitSyncStepRunner = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      if (outputs.has(name)) return structuredClone(outputs.get(name)) as T;
      const result = await operation();
      outputs.set(name, structuredClone(result));
      return result;
    };
    const first: GitSyncRootCommit[] = [];
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    writeFileSync(join(f.repo, 'a.txt'), 'first tick\n');
    await runGitSync('test', { ...f.opts, step, onRootCommit: (commit) => first.push(commit) });
    expect(first).toHaveLength(1);
    expect(first[0]?.committedAtMs).toBe(1_000);
    now.mockReturnValue(4_000);
    writeFileSync(join(f.repo, 'later.txt'), 'later independent tick\n');
    f.git('add', '-A');
    f.git('commit', '-m', 'later tick');
    const replay: GitSyncRootCommit[] = [];
    const replayStep: GitSyncStepRunner = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      if (name === 'git-sync:push') expect(replay).toEqual(first);
      return step(name, operation);
    };
    const result = await runGitSync('test', { ...f.opts, step: replayStep, onRootCommit: (commit) => replay.push(commit) });
    expect(replay).toEqual(first);
    expect(result.localCommits).toEqual(first);
    expect(replay[0]?.sha).not.toBe(f.git('rev-parse', 'HEAD'));

    // Legacy checkpoints retain their aggregate SHA, but cannot manufacture
    // individual producer times from the clock at which they are replayed.
    const legacy = { ...outputs.get('git-sync:pointer-bump') as Record<string, unknown> };
    delete legacy.localCommits;
    delete legacy.localCommitAtMs;
    outputs.set('git-sync:pointer-bump', legacy);
    const notify = vi.fn();
    const legacyResult = await runGitSync('test', { ...f.opts, step, onRootCommit: notify });
    expect(notify).not.toHaveBeenCalled();
    expect(legacyResult.localCommitSha).toBe(first[0]?.sha);
    expect(legacyResult.localCommitAtMs).toBeUndefined();
    expect(legacyResult.localCommits).toBeUndefined();
  });

  it('retains already delivered producer proof when a later group yields', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'agent a\n');
    writeFileSync(join(f.repo, 'b.txt'), 'agent b\n');
    const commits: GitSyncRootCommit[] = [];
    let failure: unknown;
    try {
      await runGitSync('test', {
        ...f.opts,
        loadRoster: async () => [
          { agent: 'su-a', intent: 'a', files: ['a.txt'] },
          { agent: 'su-b', intent: 'b', files: ['b.txt'] },
        ],
        onRootCommit: (commit) => commits.push(commit),
        shouldYield: async () => commits.length > 0 ? 'restart requested' : null,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitSyncYieldError);
    expect(commits).toHaveLength(1);
    expect((failure as GitSyncYieldError).localCommits).toEqual(commits);
    expect((failure as GitSyncYieldError).localCommitAtMs).toBe(commits[0]?.committedAtMs);
    expect(commits[0]?.sha).toBe(f.git('rev-parse', 'HEAD'));
    expect(f.git('status', '--porcelain')).toContain('b.txt');
  });

  it.each([false, true])('announces only the root gitlink publication, with root CAS refused=%s', async (refuseRoot) => {
    const f = fixture();
    const source = fixture();
    f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', source.repo, 'child');
    f.git('commit', '-am', 'add child');
    const baseline = f.git('rev-parse', 'HEAD');
    const child = join(f.repo, 'child');
    // Child commits contribute to aggregate counts but are not root publications.
    f.git('-C', child, 'config', 'user.email', 'test@papercusp.local');
    f.git('-C', child, 'config', 'user.name', 'publication test');
    writeFileSync(join(child, 'a.txt'), 'child edit\n');
    const commits: GitSyncRootCommit[] = [];
    const result = await runGitSync('test', {
      ...f.opts, submodulePaths: ['child'],
      onRootCommit: (commit) => commits.push(commit),
      runGit: async (args, cwd, options) => refuseRoot && cwd === f.repo && args[0] === 'update-ref' && args.includes('HEAD')
        ? { code: 1, stdout: '', stderr: 'injected root CAS refusal' }
        : f.runGit(args, cwd, options),
    });
    expect(f.git('-C', child, 'show', 'HEAD:a.txt')).toBe('child edit');
    expect(result.committedCount).toBeGreaterThan(0);
    expect(commits.map((commit) => commit.sha)).not.toContain(f.git('-C', child, 'rev-parse', 'HEAD'));
    if (refuseRoot) {
      expect(commits).toEqual([]);
      expect(result.localCommitSha).toBeUndefined();
      expect(f.git('rev-parse', 'HEAD')).toBe(baseline);
    } else {
      expect(commits).toEqual([{ sha: f.git('rev-parse', 'HEAD'), committedAtMs: expect.any(Number) }]);
      expect(result.localCommits).toEqual(commits);
    }
  });

  it('does not announce commit objects whose publication CAS was refused', async () => {
    const f = fixture();
    const baseline = f.git('rev-parse', 'HEAD');
    const notify = vi.fn();
    writeFileSync(join(f.repo, 'a.txt'), 'unpublished\n');
    const result = await runGitSync('test', {
      ...f.opts, onRootCommit: notify,
      runGit: async (args, cwd, options) => args[0] === 'update-ref' && args.includes('HEAD')
        ? { code: 1, stdout: '', stderr: 'injected CAS refusal' }
        : f.runGit(args, cwd, options),
    });
    expect(result.status).toBe('error');
    expect(notify).not.toHaveBeenCalled();
    expect(f.git('rev-parse', 'HEAD')).toBe(baseline);
  });

  it('notifies the shared-index fallback before entering the push phase', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'shared-index publication\n');
    const commits: GitSyncRootCommit[] = [];
    const log = vi.fn();
    const result = await runGitSync('test', {
      ...f.opts, log,
      // Model a legacy runner that does not forward GIT_INDEX_FILE.
      runGit: (args, cwd) => f.runGit(args, cwd),
      onRootCommit: (commit) => commits.push(commit),
      step: async (name, operation) => {
        if (name === 'git-sync:push') expect(commits).toHaveLength(1);
        return operation();
      },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('through the shared index instead'));
    expect(commits).toEqual([{ sha: f.git('rev-parse', 'HEAD'), committedAtMs: expect.any(Number) }]);
    expect(result.localCommits).toEqual(commits);
  });

  it('keeps notification failure separate from successful publication', async () => {
    const f = fixture();
    const log = vi.fn();
    writeFileSync(join(f.repo, 'a.txt'), 'committed despite observer\n');
    const result = await runGitSync('test', {
      ...f.opts, log, onRootCommit: () => { throw new Error('observer unavailable'); },
    });
    expect(result.localCommitSha).toBe(f.git('rev-parse', 'HEAD'));
    expect(result.localCommits).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('root commit notification failed'));
  });
});
