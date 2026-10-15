/**
 * WI-10007606: runGitSync's cooperative yield to a waiting exclusive (dev:restart's
 * git-sync restart barrier). One papercusp pass held the shared barrier for 11+ minutes
 * under load while dev:restart's drain is capped at 120s, so bg-host could not be
 * restarted at all. These tests pin the yield contract:
 *   - the probe runs at completed batch/preparation/private-index boundaries, never
 *     while a git command is in flight or during shared-index publication;
 *   - a yield stops the walk (no further submodule or superproject git work) and throws
 *     GitSyncYieldError carrying where it stopped;
 *   - a crash-replay of the checkpointed submodule phase yields again rather than
 *     treating the partial walk as a complete phase;
 *   - a throwing probe fails OPEN (the pass completes).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitSync, GitSyncYieldError, type RunGit, type GitSyncStepRunner } from './run-git-sync';

const SUBMODULES = ['libs/s0', 'libs/s1', 'libs/s2', 'libs/s3', 'libs/s4', 'libs/s5', 'libs/s6', 'libs/s7', 'libs/s8'];

function stripConfigFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') {
      i++;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

/** A hermetic git fake that records every call and how many are in flight. */
function recordingGit() {
  const calls: Array<{ cwd: string; command: string }> = [];
  const state = { inFlight: 0 };
  const run: RunGit = async (args, cwd) => {
    state.inFlight++;
    try {
      const command = stripConfigFlags(args).join(' ');
      calls.push({ cwd, command });
      // Let sibling batch members genuinely overlap so an in-flight probe would be visible.
      await new Promise((resolve) => setImmediate(resolve));
      if (command.startsWith('symbolic-ref')) return { code: 0, stdout: 'main', stderr: '' };
      if (command.startsWith('rev-parse HEAD')) return { code: 0, stdout: 'abc123', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    } finally {
      state.inFlight--;
    }
  };
  return { run, calls, state };
}

const SUPERPROJECT_WRITES = /^(add|commit|write-tree|read-tree|update-index)\b/;

describe('WI-10007606 runGitSync cooperative yield', () => {
  it('yields at the next submodule-batch boundary and runs no further git work', async () => {
    const git = recordingGit();
    const probesWithGitInFlight: number[] = [];
    let probes = 0;
    const shouldYield = async (): Promise<string | null> => {
      probes++;
      probesWithGitInFlight.push(git.state.inFlight);
      // Batches are 4 wide: 0-3, 4-7, 8. Yield before the THIRD batch.
      return probes === 3 ? 'exclusive git-sync drain requested by su-test' : null;
    };

    const err = await runGitSync('test', {
      repoPath: '/fake',
      runGit: git.run,
      submodulePaths: SUBMODULES,
      config: { push: false, pushSubmoduleOrigins: false },
      shouldYield,
      log: () => {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSyncYieldError);
    const y = err as GitSyncYieldError;
    expect(y.name).toBe('GitSyncYieldError');
    expect(y.boundary).toBe('submodule-batch');
    expect(y.submodulesSynced).toBe(8);
    expect(y.submodulesTotal).toBe(9);
    expect(y.reason).toBe('exclusive git-sync drain requested by su-test');

    // The probe never ran while a git command was executing.
    expect(probesWithGitInFlight).toEqual([0, 0, 0]);
    // The yielded batch never started, and the superproject was never staged/committed.
    expect(git.calls.some((c) => c.cwd === '/fake/libs/s8')).toBe(false);
    expect(git.calls.filter((c) => c.cwd === '/fake' && SUPERPROJECT_WRITES.test(c.command))).toEqual([]);
  });

  it('yields before the pointer-bump phase once every submodule has synced', async () => {
    const git = recordingGit();
    let probes = 0;
    const err = await runGitSync('test', {
      repoPath: '/fake',
      runGit: git.run,
      submodulePaths: ['libs/a', 'libs/b'],
      config: { push: false, pushSubmoduleOrigins: false },
      // Probe 1 = the only batch boundary; probe 2 = before pointer-bump.
      shouldYield: async () => (++probes === 2 ? 'restart waiting' : null),
      log: () => {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSyncYieldError);
    expect((err as GitSyncYieldError).boundary).toBe('before-pointer-bump');
    expect((err as GitSyncYieldError).submodulesSynced).toBe(2);
    expect(git.calls.some((c) => c.cwd === '/fake/libs/b')).toBe(true);
    expect(git.calls.filter((c) => c.cwd === '/fake' && SUPERPROJECT_WRITES.test(c.command))).toEqual([]);
  });

  it('a crash-replay of the checkpointed submodule phase yields again instead of bumping pointers', async () => {
    const recorded = new Map<string, unknown>();
    const recordingStep: GitSyncStepRunner = async (name, fn) => {
      const out = await fn();
      recorded.set(name, JSON.parse(JSON.stringify(out)));
      return out;
    };
    const first = recordingGit();
    const firstErr = await runGitSync('test', {
      repoPath: '/fake',
      runGit: first.run,
      submodulePaths: SUBMODULES,
      config: { push: false, pushSubmoduleOrigins: false },
      step: recordingStep,
      shouldYield: async () => 'restart waiting',
      log: () => {},
    }).catch((e: unknown) => e);
    expect(firstErr).toBeInstanceOf(GitSyncYieldError);
    expect(recorded.has('git-sync:submodules')).toBe(true);

    // DBOS recovery replays a recorded step's output WITHOUT calling its body, and the
    // live probe may now say "nobody is waiting". The partial walk must still not be
    // treated as a complete phase.
    const replayStep: GitSyncStepRunner = async <T,>(name: string, fn: () => Promise<T>): Promise<T> =>
      recorded.has(name) ? (recorded.get(name) as T) : fn();
    const replay = recordingGit();
    const replayErr = await runGitSync('test', {
      repoPath: '/fake',
      runGit: replay.run,
      submodulePaths: SUBMODULES,
      config: { push: false, pushSubmoduleOrigins: false },
      step: replayStep,
      shouldYield: async () => null,
      log: () => {},
    }).catch((e: unknown) => e);
    expect(replayErr).toBeInstanceOf(GitSyncYieldError);
    expect((replayErr as GitSyncYieldError).submodulesSynced).toBe(0);
    expect(replay.calls.filter((c) => c.cwd === '/fake' && SUPERPROJECT_WRITES.test(c.command))).toEqual([]);
  });

  it('a throwing probe fails open: the pass completes and the failure is logged', async () => {
    const git = recordingGit();
    const logs: string[] = [];
    const out = await runGitSync('test', {
      repoPath: '/fake',
      runGit: git.run,
      submodulePaths: ['libs/a'],
      config: { push: false, pushSubmoduleOrigins: false },
      shouldYield: async () => {
        throw new Error('pg down');
      },
      log: (m) => logs.push(m),
    });
    // Resolved (no GitSyncYieldError) and walked both the submodule and the superproject.
    expect(out.status).toBeTypeOf('string');
    expect(git.calls.some((c) => c.cwd === '/fake/libs/a')).toBe(true);
    expect(git.calls.some((c) => c.cwd === '/fake' && c.command.startsWith('status'))).toBe(true);
    expect(logs.join('\n')).toContain('shouldYield probe failed (pg down)');
  });

  it.each([
    ['protected-path preflight', 'before-superproject-stage'],
    ['private catch-all stage', 'before-superproject-publish'],
    ['private post-stage guard', 'before-superproject-publish'],
    ['private attributed stage', 'before-superproject-publish'],
  ])('EI-258149: yields when a drain first arrives during %s, then commits on the next pass', async (arrival, boundary) => {
    const repo = mkdtempSync(join(tmpdir(), 'git-sync-late-drain-'));
    const git = (...args: string[]): string => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
      if (result.status !== 0) throw new Error(String(result.stderr));
      return String(result.stdout).trim();
    };
    try {
      git('init', '-b', 'main');
      git('config', 'user.email', 'test@papercusp.local');
      git('config', 'user.name', 'late drain test');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'protected.txt'), 'original held file\n');
      writeFileSync(join(repo, 'ordinary.txt'), 'original ordinary file\n');
      git('add', '-A');
      git('commit', '-m', 'baseline');
      const baseline = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'protected.txt'), 'live held edit\n');
      writeFileSync(join(repo, 'ordinary.txt'), 'pending ordinary edit\n');
      writeFileSync(join(repo, 'new.txt'), 'pending new file\n');
      let waiting = false;
      let inFlight = 0;
      const probesInFlight: number[] = [];
      const privateIndexes = new Set<string>();
      const runGit: RunGit = async (args, cwd, options) => {
        inFlight++;
        try {
          if (options?.env?.GIT_INDEX_FILE) privateIndexes.add(options.env.GIT_INDEX_FILE);
          const result = spawnSync('git', args, {
            cwd, encoding: 'utf8', timeout: 30_000,
            env: { ...process.env, ...options?.env },
          });
          if (result.status === 0 || result.status === 1) {
            if (arrival === 'protected-path preflight' && args[0] === 'check-ignore' && args.includes('protected.txt')) waiting = true;
            if ((arrival === 'private catch-all stage' || arrival === 'private attributed stage') && args[0] === 'add' && options?.env?.GIT_INDEX_FILE) waiting = true;
            if (arrival === 'private post-stage guard' && args[0] === 'ls-files' && args.includes('--stage') && options?.env?.GIT_INDEX_FILE) waiting = true;
          }
          return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
        } finally {
          inFlight--;
        }
      };
      const opts = {
        repoPath: repo, runGit, submodulePaths: [], excludePaths: ['protected.txt'],
        config: { push: false, pushSubmoduleOrigins: false },
        contentDetectors: [], deletionGuard: false, diffSubjects: false, log: () => {},
        ...(arrival === 'private attributed stage' ? {
          loadRoster: async () => [{ agent: 'su-test', intent: 'pending ordinary edit', files: ['ordinary.txt', 'new.txt'] }],
        } : {}),
      };
      const error = await runGitSync('test', {
        ...opts,
        shouldYield: async () => {
          probesInFlight.push(inFlight);
          return waiting ? 'late exclusive drain' : null;
        },
      }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(GitSyncYieldError);
      expect((error as GitSyncYieldError).boundary).toBe(boundary);
      expect(waiting).toBe(true);
      expect(probesInFlight.every((n) => n === 0)).toBe(true);
      expect(git('rev-parse', 'HEAD')).toBe(baseline);
      expect(git('show', 'HEAD:protected.txt')).toBe('original held file');
      expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('pending new file\n');
      if (arrival.startsWith('private')) expect(privateIndexes.size).toBeGreaterThan(0);
      expect(readdirSync(join(repo, '.git')).filter((name) => name.startsWith('papercusp-git-sync-'))).toEqual([]);

      // The action's existing anti-starvation rule omits shouldYield on the next
      // pass. The still-waiting drain must not prevent the pending commit.
      const resumed = await runGitSync('test', opts);
      expect(resumed.committedCount).toBe(1);
      expect(git('show', 'HEAD:ordinary.txt')).toBe('pending ordinary edit');
      expect(git('show', 'HEAD:new.txt')).toBe('pending new file');
      expect(git('show', 'HEAD:protected.txt')).toBe('original held file');
      expect(readFileSync(join(repo, 'protected.txt'), 'utf8')).toBe('live held edit\n');
      expect(git('rev-list', '--count', `${baseline}..HEAD`)).toBe('1');
      expect(readdirSync(join(repo, '.git')).filter((name) => name.startsWith('papercusp-git-sync-'))).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
