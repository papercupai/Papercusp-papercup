// dev-deploy-state — the read-only release-gate snapshot (plan
// dev-admin-sidebar-2026-06-05, P-006). Exercises the real git logic against a
// throwaway integration repo + a release worktree, driven through the same env
// seams (PAPERCUSP_INTEGRATION_ROOT / _RELEASE_ROOT / _RELEASE_REF / _BRANCH)
// the live host sets, so the "N commits behind main" maths is verified end-to-end.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyCommitRefFailure,
  DEV_DEPLOY_SIDECAR_BATCH_DEADLINE_MS,
  DEV_DEPLOY_SIDECAR_RPC_TIMEOUT_MS,
  devDeployState,
  resetDevDeployStateCache,
  runDevDeployGitBatch,
  type DevDeployGitBatchDeps,
} from './dev-deploy-state';
import { getSidecarBreakerState, getSidecarFallbackStats, noteSidecarDeadlineFallback, resetSidecarFallbackStatsForTest } from './fleet/git-via-sidecar';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function commit(repo: string, file: string, msg: string): string {
  fs.writeFileSync(path.join(repo, file), msg);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

let tmp: string;
let integration: string;
let release: string;
let shaA = '';
let shaB = '';
let shaC = '';
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeploy-'));
  integration = path.join(tmp, 'papercup');
  release = path.join(tmp, 'papercup-release');
  execFileSync('git', ['init', '-q', '-b', 'main', integration]);

  // main: A → B → C (three commits, newest C).
  shaA = commit(integration, 'f', 'A');
  shaB = commit(integration, 'f', 'B');
  // `ready` pinned at B (1 commit behind main's C).
  git(integration, ['branch', 'ready', shaB]);
  shaC = commit(integration, 'f', 'C');

  // The release checkout (what :3070 runs) deployed at A — a worktree sharing
  // the object store, detached at A (2 behind main, 1 behind ready).
  git(integration, ['worktree', 'add', '-q', '--detach', release, shaA]);
});

afterAll(() => {
  try {
    git(integration, ['worktree', 'remove', '--force', release]);
  } catch {
    /* best effort */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeAll(() => {
  for (const k of [
    'PAPERCUSP_INTEGRATION_ROOT',
    'PAPERCUSP_RELEASE_ROOT',
    'PAPERCUSP_RELEASE_REF',
    'PAPERCUSP_INTEGRATION_BRANCH',
    'PAPERCUSP_DEPLOY_STATE_TTL_MS',
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.PAPERCUSP_INTEGRATION_ROOT = integration;
  process.env.PAPERCUSP_RELEASE_ROOT = release;
  process.env.PAPERCUSP_RELEASE_REF = 'ready';
  process.env.PAPERCUSP_INTEGRATION_BRANCH = 'main';
  // These tests mutate refs/env then re-read, so disable the snapshot cache;
  // the caching behaviour itself is covered by its own describe block below.
  process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '0';
});

afterEach(() => {
  resetDevDeployStateCache();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// EI-18788901632987174: commitRef's catch-all used to collapse "the ref does
// not exist" and "the git call itself failed" into the same bare `null` —
// two states that demand OPPOSITE caller responses (final vs
// retry-or-escalate). classifyCommitRefFailure is the pure function that now
// makes the distinction; these messages are git's REAL stderr text (verified
// live: `git log -1 <ref>^{commit}` for an absent ref vs a nonexistent repo
// path vs a plain non-repo directory).
describe('classifyCommitRefFailure (EI-18788901632987174)', () => {
  it('an ABSENT ref classifies as not-applicable (final — retrying resolves nothing)', () => {
    const message =
      "Command failed: git -C /repo log -1 --format=%H nonexistent-ref^{commit}\n" +
      "fatal: ambiguous argument 'nonexistent-ref^{commit}': unknown revision or path not in the working tree.\n" +
      "Use '--' to separate paths from revisions, like this:\n" +
      "'git <command> [<revision>...] -- [<file>...]'\n";
    const got = classifyCommitRefFailure('nonexistent-ref', '/repo', message);
    expect(got.code).toBe('not-applicable');
    expect(got.detail).toContain('nonexistent-ref');
  });

  it('a BROKEN git invocation (missing repo dir) classifies as resolver-failed (retry-or-escalate)', () => {
    const message =
      "Command failed: git -C /tmp/does-not-exist-dir-xyz log -1 --format=%H main^{commit}\n" +
      "fatal: cannot change to '/tmp/does-not-exist-dir-xyz': No such file or directory\n";
    const got = classifyCommitRefFailure('main', '/tmp/does-not-exist-dir-xyz', message);
    expect(got.code).toBe('resolver-failed');
  });

  it('a BROKEN git invocation (not a git repository) classifies as resolver-failed, DIFFERENT from an absent ref', () => {
    const message =
      'fatal: not a git repository (or any parent up to mount point /)\n' +
      'Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n';
    const got = classifyCommitRefFailure('main', '/tmp/not-a-repo', message);
    expect(got.code).toBe('resolver-failed');
    expect(got.code).not.toBe(
      classifyCommitRefFailure('nonexistent-ref', '/repo', 'unknown revision or path not in the working tree').code,
    );
  });
});

describe('devDeployState', () => {
  it('resolves main / ready / deployed refs from the env-seamed checkouts', async () => {
    const st = await devDeployState();
    expect(st.errors).toEqual([]);
    expect(st.integrationBranch).toBe('main');
    expect(st.releaseRef).toBe('ready');
    expect(st.stagingHead?.sha).toBe(shaC);
    expect(st.greenPin?.sha).toBe(shaB);
    expect(st.deployed?.sha).toBe(shaA);
  });

  it('can keep a pure diagnostic read on local git even when the host sidecar flag is enabled', async () => {
    const oldSidecar = process.env.PAPERCUSP_SPAWNER_SIDECAR;
    const oldSocket = process.env.PAPERCUSP_SPAWNER_IPC_SOCKET;
    const socket = path.join(os.tmpdir(), `devdeploy-no-sidecar-${process.pid}-${Date.now()}.sock`);
    process.env.PAPERCUSP_SPAWNER_SIDECAR = '1';
    process.env.PAPERCUSP_SPAWNER_IPC_SOCKET = socket;
    resetDevDeployStateCache();
    try {
      const st = await devDeployState({ useSpawnerSidecar: false });
      expect(st.stagingHead?.sha).toBe(shaC);
      expect(fs.existsSync(socket)).toBe(false);
    } finally {
      if (oldSidecar === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR = oldSidecar;
      if (oldSocket === undefined) delete process.env.PAPERCUSP_SPAWNER_IPC_SOCKET;
      else process.env.PAPERCUSP_SPAWNER_IPC_SOCKET = oldSocket;
      resetDevDeployStateCache();
    }
  });

  it('routes verified read-only batches through the bounded sidecar and parses its frames', async () => {
    const commands = [{ repo: integration, args: ['log', '-1', '--format=%H%n%ct%n%s', 'main^{commit}'] }];
    const viaSidecar: NonNullable<DevDeployGitBatchDeps['viaSidecar']> = async (command, args, options) => {
      expect(command).toBe('sh');
      expect(options.timeoutMs).toBe(DEV_DEPLOY_SIDECAR_BATCH_DEADLINE_MS);
      expect(options.rpcTimeoutMs).toBe(DEV_DEPLOY_SIDECAR_RPC_TIMEOUT_MS);
      expect(options.signal).toBeUndefined();
      const nonce = args[3]!;
      return { code: 0, stdout: `sidecar-head\n\u0000${nonce} o0 0\u0000\u0000${nonce} e0 0\u0000`, stderr: '' };
    };
    const localBatch = vi.fn(async () => []);

    const result = await runDevDeployGitBatch(commands, true, {
      sidecarEnabled: () => true,
      viaSidecar,
      localBatch,
    });

    expect(result).toEqual([{ code: 0, stdout: 'sidecar-head\n', stderr: '' }]);
    expect(localBatch).not.toHaveBeenCalled();
  });

  it('keeps the diagnostic RPC alive through the production ten-second child teardown', () => {
    expect(DEV_DEPLOY_SIDECAR_RPC_TIMEOUT_MS).toBeGreaterThan(
      DEV_DEPLOY_SIDECAR_BATCH_DEADLINE_MS + 10_000,
    );
    expect(DEV_DEPLOY_SIDECAR_RPC_TIMEOUT_MS).toBeLessThan(35_000);
  });

  it('counts a sidecar batch deadline miss without tripping the breaker, then falls back locally', async () => {
    const commands = [{ repo: integration, args: ['log', '-1', '--format=%H%n%ct%n%s', 'main^{commit}'] }];
    const viaSidecar: NonNullable<DevDeployGitBatchDeps['viaSidecar']> = vi.fn(async () => ({
      code: -1,
      stdout: '',
      stderr: `sh timed out after ${DEV_DEPLOY_SIDECAR_BATCH_DEADLINE_MS}ms — killed by the spawner sidecar guard`,
    }));
    const localResult = [{ code: 0, stdout: 'local-head', stderr: '' }];
    const localBatch = vi.fn(async () => localResult);
    const noteDeadlineFallback = vi.fn();
    const noteFallback = vi.fn();

    const result = await runDevDeployGitBatch(commands, true, {
      sidecarEnabled: () => true,
      viaSidecar,
      localBatch,
      noteDeadlineFallback,
      noteFallback,
    });

    expect(result).toEqual(localResult);
    expect(localBatch).toHaveBeenCalledTimes(1);
    expect(noteDeadlineFallback).toHaveBeenCalledWith('dev-deploy', expect.any(Error));
    expect(noteFallback).not.toHaveBeenCalled();
  });

  it('keeps non-matching batches local even when the caller enables the sidecar', async () => {
    const commands = [{ repo: integration, args: ['log', '-1', '--output=/tmp/unsafe', 'HEAD'] }];
    const viaSidecar: NonNullable<DevDeployGitBatchDeps['viaSidecar']> = vi.fn();
    const localResult = [{ code: 0, stdout: 'local-only', stderr: '' }];
    const localBatch = vi.fn(async () => localResult);

    expect(await runDevDeployGitBatch(commands, true, {
      sidecarEnabled: () => true,
      viaSidecar,
      localBatch,
    })).toEqual(localResult);
    expect(viaSidecar).not.toHaveBeenCalled();
    expect(localBatch).toHaveBeenCalledTimes(1);
  });

  it('computes the "behind" distances correctly', async () => {
    const st = await devDeployState();
    // main = A→B→C. deployed=A → 2 behind main (B, C). ready=B → 1 behind main (C).
    expect(st.deployedBehindStaging).toBe(2);
    expect(st.greenPinBehindStaging).toBe(1);
    // deployed=A is 1 behind ready=B → there's a green commit deployable but undeployed.
    expect(st.deployedBehindGreenPin).toBe(1);
    // ready (B) is NOT at main HEAD (C) → there's a staging buffer.
    expect(st.greenPinAtStagingHead).toBe(false);
  });

  it('carries commit subjects + a short sha for display', async () => {
    const st = await devDeployState();
    expect(st.stagingHead?.subject).toBe('C');
    expect(st.deployed?.subject).toBe('A');
    expect(st.deployed?.shortSha).toBe(shaA.slice(0, 8));
    expect(typeof st.deployed?.committedAtMs).toBe('number');
  });

  it('reports greenPinAtStagingHead=true once ready fast-forwards to main HEAD', async () => {
    git(integration, ['branch', '-f', 'ready', shaC]);
    try {
      const st = await devDeployState();
      expect(st.greenPin?.sha).toBe(shaC);
      expect(st.greenPinBehindStaging).toBe(0);
      expect(st.greenPinAtStagingHead).toBe(true);
    } finally {
      git(integration, ['branch', '-f', 'ready', shaB]); // restore for other tests
    }
  });

  it('deployedAtMs reflects a checkout INSIDE the linked worktree, not the worktree-creation mtime (WI-1623)', async () => {
    // The release checkout is `git worktree add`-ed once in beforeAll (creation
    // time long past); the worktree-root `.git` pointer FILE's mtime never
    // changes again. A real deploy runs `git checkout <sha>` inside that
    // worktree — assert deployedAtMs tracks THAT, not the pointer file.
    const gitFile = path.join(release, '.git');
    const gitFileMtimeBefore = fs.statSync(gitFile).mtimeMs;

    resetDevDeployStateCache();
    const before = await devDeployState();
    // Sanity: deployed currently resolves to A (the worktree-creation checkout).
    expect(before.deployed?.sha).toBe(shaA);

    // Simulate a deploy: checkout a different commit inside the worktree.
    // Bump the mtime clock forward so a coarse filesystem timestamp
    // resolution can't make this a no-op assertion.
    await new Promise((r) => setTimeout(r, 1100));
    git(release, ['checkout', '-q', '--detach', shaB]);

    resetDevDeployStateCache();
    const after = await devDeployState();
    expect(after.deployed?.sha).toBe(shaB);
    expect(after.deployedAtMs).not.toBeNull();
    // The bug: deployedAtMs used to equal the STATIC pointer file's mtime,
    // which the checkout above never touches.
    expect(after.deployedAtMs).toBeGreaterThan(gitFileMtimeBefore);
    // And it must be close to "now" (the checkout we just ran), not the
    // worktree's original creation time from beforeAll.
    expect(Date.now() - (after.deployedAtMs as number)).toBeLessThan(15_000);
  });

  it('populates errors[] (not throws) when a ref is missing, still returning a snapshot', async () => {
    const prev = process.env.PAPERCUSP_RELEASE_REF;
    process.env.PAPERCUSP_RELEASE_REF = 'no-such-ref';
    try {
      const st = await devDeployState();
      expect(st.greenPin).toBeNull();
      expect(st.errors.some((e) => e.includes('no-such-ref'))).toBe(true);
      // main + deployed still resolve — the snapshot is partial, not absent.
      expect(st.stagingHead?.sha).toBe(shaC);
    } finally {
      process.env.PAPERCUSP_RELEASE_REF = prev;
    }
  });

  it('EI-18788901632987174: an absent ref and a broken git invocation produce DIFFERENTLY-worded errors[] entries, end to end', async () => {
    // Absent ref (real repo, bad ref name) — classifies not-applicable.
    const prevRef = process.env.PAPERCUSP_RELEASE_REF;
    process.env.PAPERCUSP_RELEASE_REF = 'no-such-ref';
    let absentRefError: string | undefined;
    try {
      const st = await devDeployState();
      absentRefError = st.errors.find((e) => e.includes('no-such-ref'));
    } finally {
      process.env.PAPERCUSP_RELEASE_REF = prevRef;
    }
    expect(absentRefError).toBeDefined();

    // Broken invocation (the repo path itself doesn't exist) — classifies
    // resolver-failed. Same shape of failure (commitRef → errors[]), different
    // ROOT CAUSE — this is the exact pair the bug's recurrence guard asks for.
    const prevRoot = process.env.PAPERCUSP_RELEASE_ROOT;
    process.env.PAPERCUSP_RELEASE_ROOT = path.join(tmp, 'no-such-release-checkout-dir');
    let brokenInvocationError: string | undefined;
    try {
      const st = await devDeployState();
      expect(st.deployed).toBeNull();
      brokenInvocationError = st.errors.find((e) => e.includes('git failed resolving'));
    } finally {
      process.env.PAPERCUSP_RELEASE_ROOT = prevRoot;
    }
    expect(brokenInvocationError).toBeDefined();

    // The two must not read the same way — a caller (or a human) must be able
    // to tell "give up" from "try again" from the text alone.
    expect(absentRefError).not.toBe(brokenInvocationError);
    expect(absentRefError).not.toContain('git failed resolving');
  });

  // EI-19341938682536275: dev:why used to count the strand from LOCAL HEAD only, so an
  // origin push freeze read identically to the normal pre-gate buffer ("99 commits …
  // normal"). These pin the new local→origin leg end-to-end against a real remote.
  describe('originHead / stagingAheadOfOrigin (EI-19341938682536275)', () => {
    it('is null, with no errors[], when the repo has no `origin` remote at all', async () => {
      // The shared `integration` fixture (beforeAll above) never configures a remote —
      // this is the common no-remote state (packaged install, a fresh local-only checkout)
      // and must degrade quietly, never as a resolver fault.
      const st = await devDeployState();
      expect(st.originHead).toBeNull();
      expect(st.stagingAheadOfOrigin).toBeNull();
      expect(st.errors).toEqual([]);
    });

    it('resolves originHead + reports 0 unpushed once origin is caught up, then N once local advances past it', async () => {
      const bare = path.join(tmp, 'origin-bare.git');
      execFileSync('git', ['init', '-q', '--bare', bare]);
      git(integration, ['remote', 'add', 'origin', bare]);
      try {
        git(integration, ['push', '-q', 'origin', `main:main`]);
        const caughtUp = await devDeployState();
        expect(caughtUp.originHead?.sha).toBe(shaC);
        expect(caughtUp.stagingAheadOfOrigin).toBe(0);

        // Local advances with a commit that never reaches origin — the exact WI-6996
        // shape (a push that stops working while local keeps committing).
        const shaD = commit(integration, 'f', 'D');
        const behind = await devDeployState();
        expect(behind.originHead?.sha).toBe(shaC); // origin's remote-tracking ref: unmoved
        expect(behind.stagingHead?.sha).toBe(shaD);
        expect(behind.stagingAheadOfOrigin).toBe(1); // never "normal" — see why-chain.test.ts

        // Catches back up once pushed.
        git(integration, ['push', '-q', 'origin', `main:main`]);
        const caughtUpAgain = await devDeployState();
        expect(caughtUpAgain.stagingAheadOfOrigin).toBe(0);
      } finally {
        git(integration, ['remote', 'remove', 'origin']);
        // Restore `main` to shaC so it doesn't leak the extra commit into later tests.
        git(integration, ['reset', '-q', '--hard', shaC]);
      }
    });
  });
});

describe('sidecar deadline fallback accounting', () => {
  it('keeps deadline misses visible without adding a shared breaker failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetSidecarFallbackStatsForTest();
    try {
      noteSidecarDeadlineFallback('dev-deploy', new Error('deadline exceeded'), 1_000);
      expect(getSidecarFallbackStats()).toMatchObject({
        total: 1,
        bySubsystem: { 'dev-deploy': { count: 1, lastReason: 'deadline exceeded' } },
      });
      expect(getSidecarBreakerState(1_000)).toMatchObject({ state: 'closed', consecutiveFailures: 0, trips: 0 });
    } finally {
      warn.mockRestore();
      resetSidecarFallbackStatsForTest();
    }
  });
});

describe('devDeployState caching (P-015 — collapse the git fan-out under the poll storm)', () => {
  afterEach(() => {
    process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '0';
    resetDevDeployStateCache();
  });

  it('single-flights a concurrent burst into one shared snapshot', async () => {
    process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '5000';
    resetDevDeployStateCache();
    const [a, b, c] = await Promise.all([devDeployState(), devDeployState(), devDeployState()]);
    // Same in-flight promise → identical object: only ONE git fan-out ran.
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.stagingHead?.sha).toBe(shaC);
  });

  it('serves repeat reads from cache within the TTL, then recomputes after reset', async () => {
    process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '5000';
    resetDevDeployStateCache();
    const first = await devDeployState();
    const cached = await devDeployState();
    expect(cached).toBe(first); // within TTL → cache hit, no recompute

    resetDevDeployStateCache();
    const fresh = await devDeployState();
    expect(fresh).not.toBe(first); // new compute → new object
    expect(fresh.stagingHead?.sha).toBe(first.stagingHead?.sha); // same underlying data
  });

  it('TTL=0 disables the cache (every call recomputes)', async () => {
    process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS = '0';
    resetDevDeployStateCache();
    const a = await devDeployState();
    const b = await devDeployState();
    expect(a).not.toBe(b);
    expect(a.deployed?.sha).toBe(b.deployed?.sha);
  });

  it('the DEFAULT TTL (no env override) is a positive caching window that de-amplifies the poll storm (P-009)', async () => {
    // Guards the storm-de-amplification lever: with no PAPERCUSP_DEPLOY_STATE_TTL_MS
    // set, the built-in default must be a real >0 window so rapid repeat reads from
    // the poll-storm-amplified hot paths (system-health, sync-resolver dev.deployState)
    // skip the git fan-out. A regression to 0 (or an accidental disable) would let the
    // git spawn cost — ≈59% of on-loop work under the Jul-10 saturation — flood back.
    delete process.env.PAPERCUSP_DEPLOY_STATE_TTL_MS;
    resetDevDeployStateCache();
    const first = await devDeployState();
    const cached = await devDeployState();
    expect(cached).toBe(first); // same object → default TTL window served it from cache
    expect(first.stagingHead?.sha).toBe(shaC);
  });
});
