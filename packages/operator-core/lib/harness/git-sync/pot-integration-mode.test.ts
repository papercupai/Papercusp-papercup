/**
 * pot-integration-mode (plan pot-review-integration-mode-2026-10-05, P-014 / P-015).
 *
 * Pins: the mode read distinguishes set/absent/malformed/error; the push resolver
 * NEVER resolves a working-copy pot (or an unreadable/malformed setting) to the
 * main repository; the pot-fork git remote is added / re-pointed / left alone;
 * and choosing working-copy mode is refused without a green-gate test command or
 * a fork (P-015).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = vi.hoisted(() => ({
  getHiveSetting: vi.fn(),
  setHiveSetting: vi.fn(),
  deleteHiveSetting: vi.fn(),
}));
vi.mock('../../hive-settings-store', () => store);

import {
  POT_INTEGRATION_SETTING_KEY,
  POT_FORK_REMOTE_NAME,
  POT_UPSTREAM_BRANCH_SETTING_KEY,
  SYNC_BACK_UPSTREAM_BRANCH,
  isValidUpstreamBranch,
  potUpstreamBranch,
  coercePotIntegrationMode,
  readPotIntegrationMode,
  resolveIntegrationPushRemote,
  ensurePotForkGitRemote,
  applyIntegrationPushTarget,
  ensureWorkingCopyIntegrationBranch,
  ensureForkIntegrationBranch,
  WORKING_COPY_INTEGRATION_BRANCH,
  setPotIntegrationMode,
  choosePotIntegrationMode,
  integrationModeGovernsHarness,
  repoHasSubmodules,
  type ApplyIntegrationPushDeps,
  type ChoosePotIntegrationModeInput,
  type IntegrationPushConfig,
  type RunGit,
} from './pot-integration-mode';

const FORK = 'https://github.com/acme-bot/widget.git';

beforeEach(() => {
  store.getHiveSetting.mockReset();
  store.setHiveSetting.mockReset();
  store.deleteHiveSetting.mockReset();
});

describe('hiveGit.integration key', () => {
  it('is orthogonal to hiveGit.mode (D-005)', () => {
    expect(POT_INTEGRATION_SETTING_KEY).toBe('hiveGit.integration');
    expect(POT_INTEGRATION_SETTING_KEY).not.toBe('hiveGit.mode');
  });
  it('coerces only an exact review to review', () => {
    expect(coercePotIntegrationMode('review')).toBe('review');
    expect(coercePotIntegrationMode('direct')).toBe('direct');
    expect(coercePotIntegrationMode('REVIEW')).toBe('direct');
    expect(coercePotIntegrationMode(undefined)).toBe('direct');
  });
});

describe('readPotIntegrationMode — D-056 upstream branch', () => {
  it('review mode reads hiveGit.upstreamBranch and carries a valid value', async () => {
    store.getHiveSetting.mockResolvedValueOnce({ value: 'review' }).mockResolvedValueOnce({ value: 'staging' });
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'review', source: 'set', upstreamBranch: 'staging' });
    expect(store.getHiveSetting).toHaveBeenLastCalledWith('ws', 'pot', POT_UPSTREAM_BRANCH_SETTING_KEY, undefined);
    expect(POT_UPSTREAM_BRANCH_SETTING_KEY).toBe('hiveGit.upstreamBranch');
  });
  it('fails CLOSED on a junk branch or a store error instead of defaulting to main', async () => {
    for (const junk of ['../main', 'refs/heads/staging', '-x', 'a b', 42]) {
      store.getHiveSetting.mockResolvedValueOnce({ value: 'review' }).mockResolvedValueOnce({ value: junk });
      expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'malformed' });
    }
    store.getHiveSetting.mockResolvedValueOnce({ value: 'review' }).mockRejectedValueOnce(new Error('pg down'));
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'error' });
    // Both fail-closed reads make the tick commit-only, never a push to the fork or main.
    expect(resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'malformed' }, forkRemote: FORK }).kind).toBe(
      'commit-only',
    );
  });
  it('absent setting ⇒ no upstreamBranch; direct mode never reads it', async () => {
    store.getHiveSetting.mockResolvedValueOnce({ value: 'review' }).mockResolvedValueOnce(null);
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'review', source: 'set' });
    store.getHiveSetting.mockReset();
    store.getHiveSetting.mockResolvedValueOnce({ value: 'direct' });
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'set' });
    expect(store.getHiveSetting).toHaveBeenCalledTimes(1);
  });
  it('isValidUpstreamBranch accepts plain branch names only', () => {
    expect(['staging', 'main', 'release/1.x', 'feat_a.b'].every(isValidUpstreamBranch)).toBe(true);
    expect(['', 'a..b', '/x', 'x/', 'refs/heads/x', '-f', 'a~1', null].some(isValidUpstreamBranch)).toBe(false);
  });
});

describe('readPotIntegrationMode', () => {
  it('reads an explicit review / direct as set', async () => {
    store.getHiveSetting.mockResolvedValueOnce({ value: 'review' });
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'review', source: 'set' });
    store.getHiveSetting.mockResolvedValueOnce({ value: 'direct' });
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'set' });
    expect(store.getHiveSetting).toHaveBeenCalledWith('ws', 'pot', 'hiveGit.integration', undefined);
  });
  it('reads no row as absent (default direct)', async () => {
    store.getHiveSetting.mockResolvedValueOnce(null);
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'absent' });
  });
  it('reads junk as malformed and a throw as error — never throws', async () => {
    store.getHiveSetting.mockResolvedValueOnce({ value: 'pr-please' });
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'malformed' });
    store.getHiveSetting.mockRejectedValueOnce(new Error('pg down'));
    expect(await readPotIntegrationMode('ws', 'pot')).toEqual({ mode: 'direct', source: 'error' });
  });
});

describe('resolveIntegrationPushRemote', () => {
  it('direct (explicit or default) leaves the existing push logic unchanged', () => {
    expect(resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'set' }, forkRemote: FORK }).kind).toBe(
      'unchanged',
    );
    expect(resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'absent' } }).kind).toBe('unchanged');
  });
  it('direct mode is commit-only when a member points at another self-repository hive upstream', () => {
    const owner = {
      slug: 'papercusp',
      self_repo: true,
      github_remote: 'https://github.com/Papercusp/papercup.git',
    };
    const member = {
      slug: 'papercusp-pr-drill-20261014-2',
      hive_slug: 'papercusp-pr-drill-20261014-2-pot',
      github_remote: 'git@github.com:papercusp/papercup.git',
    };
    expect(
      resolveIntegrationPushRemote({
        read: { mode: 'direct', source: 'absent' },
        entry: member,
        projects: [owner, member],
      }),
    ).toMatchObject({
      kind: 'commit-only',
      reason: 'direct_upstream_other_hive',
      message: expect.stringContaining("self-repository hive 'papercusp'"),
    });
  });
  it('direct mode still pushes for a member whose upstream owner is its own hive home', () => {
    const owner = {
      slug: 'shop-hive',
      self_repo: true,
      github_remote: 'https://github.com/acme/shop.git',
    };
    const member = {
      slug: 'shop-worker',
      hive_slug: 'shop-hive',
      github_remote: 'https://github.com/acme/shop.git',
    };
    expect(
      resolveIntegrationPushRemote({
        read: { mode: 'direct', source: 'set' },
        entry: member,
        projects: [owner, member],
      }),
    ).toMatchObject({ kind: 'unchanged' });
  });
  it('review with a fork pushes the fork through the pot-fork remote', () => {
    const d = resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' }, forkRemote: FORK });
    expect(d).toMatchObject({ kind: 'fork', remoteName: POT_FORK_REMOTE_NAME, url: FORK });
  });
  it('review with no fork is commit-only — never the main repository', () => {
    const d = resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' } });
    expect(d).toMatchObject({ kind: 'commit-only', reason: 'working_copy_fork_missing' });
  });
  it('an unreadable or malformed setting is commit-only, even with a fork configured', () => {
    expect(resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'error' }, forkRemote: FORK })).toMatchObject({
      kind: 'commit-only',
      reason: 'integration_mode_unknown',
    });
    expect(
      resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'malformed' }, forkRemote: FORK }),
    ).toMatchObject({ kind: 'commit-only', reason: 'integration_mode_malformed' });
  });
});

describe('ensurePotForkGitRemote', () => {
  function fakeGit(existing: string | null) {
    const calls: string[][] = [];
    const run: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'remote' && args[1] === 'get-url') {
        if (existing === null) throw new Error("error: No such remote 'pot-fork'");
        return { stdout: `${existing}\n` };
      }
      return { stdout: '' };
    };
    return { run, calls };
  }
  it('adds the remote when missing', async () => {
    const g = fakeGit(null);
    expect(await ensurePotForkGitRemote('/repo', FORK, g.run)).toBe('added');
    expect(g.calls).toContainEqual(['remote', 'add', 'pot-fork', FORK]);
  });
  it('re-points a drifted remote', async () => {
    const g = fakeGit('https://github.com/someone-else/widget.git');
    expect(await ensurePotForkGitRemote('/repo', FORK, g.run)).toBe('updated');
    expect(g.calls).toContainEqual(['remote', 'set-url', 'pot-fork', FORK]);
  });
  it('leaves a matching remote alone', async () => {
    const g = fakeGit(FORK);
    expect(await ensurePotForkGitRemote('/repo', FORK, g.run)).toBe('unchanged');
    expect(g.calls).toHaveLength(1);
  });
});

describe('applyIntegrationPushTarget (the git-sync tick rewrite)', () => {
  const baseCfg = (): IntegrationPushConfig => ({ push: true, remote: 'origin', pushSubmoduleOrigins: true });
  const forkDecision = resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' }, forkRemote: FORK });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const onBranch = () =>
    vi.fn<NonNullable<ApplyIntegrationPushDeps['ensureBranch']>>().mockResolvedValue({ kind: 'on-branch' });
  const forkHasBranch = () =>
    vi.fn<NonNullable<ApplyIntegrationPushDeps['ensureForkBranch']>>().mockResolvedValue({ kind: 'present' });

  it('leaves the config untouched for a direct pot or no decision', async () => {
    const ensure = vi.fn();
    const ensureBranch = onBranch();
    for (const decision of [
      undefined,
      resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'absent' } }),
    ]) {
      const cfg = baseCfg();
      expect(await applyIntegrationPushTarget('p', cfg, decision, '/repo', { ensureRemote: ensure, ensureBranch })).toBeNull();
      expect(cfg).toEqual(baseCfg());
    }
    expect(ensure).not.toHaveBeenCalled();
    expect(ensureBranch).not.toHaveBeenCalled();
  });

  it('D-056: a pot that sets hiveGit.upstreamBranch arms sync-back on THAT upstream branch, not main', async () => {
    const cfg = baseCfg();
    const decision = resolveIntegrationPushRemote({
      read: { mode: 'review', source: 'set', upstreamBranch: 'staging' },
      forkRemote: FORK,
    });
    expect(decision).toMatchObject({ kind: 'fork', upstreamBranch: 'staging' });
    expect(
      await applyIntegrationPushTarget('p', cfg, decision, '/repo', {
        ensureRemote: vi.fn().mockResolvedValue('added'),
        ensureBranch: onBranch(),
        ensureForkBranch: forkHasBranch(),
      }),
    ).toBeNull();
    expect(cfg.syncBack).toEqual({ upstreamRemote: 'origin', upstreamBranch: 'staging' });
    // Unset ⇒ the long-standing default, main.
    expect(potUpstreamBranch({ upstreamBranch: undefined })).toBe(SYNC_BACK_UPSTREAM_BRANCH);
  });

  it('a fork decision pushes the pot-fork remote on the staging branch and stops pushing submodule origins', async () => {
    const ensure = vi.fn().mockResolvedValue('added');
    const ensureBranch = onBranch();
    const ensureForkBranch = forkHasBranch();
    const cfg = baseCfg();
    expect(
      await applyIntegrationPushTarget('p', cfg, forkDecision, '/repo', { ensureRemote: ensure, ensureBranch, ensureForkBranch }),
    ).toBeNull();
    expect(ensure).toHaveBeenCalledWith('/repo', FORK);
    expect(ensureBranch).toHaveBeenCalledWith('/repo');
    expect(ensureForkBranch).toHaveBeenCalledWith('/repo');
    // P-016: the fork path also arms sync-back FROM the main repository's remote
    // (captured before the remote is rewritten), never from the fork itself.
    // WI-10006301 (D-011): it integrates on staging, never on the release ref.
    expect(cfg).toEqual({
      push: true,
      remote: POT_FORK_REMOTE_NAME,
      pushSubmoduleOrigins: false,
      branch: WORKING_COPY_INTEGRATION_BRANCH,
      syncBack: { upstreamRemote: 'origin', upstreamBranch: SYNC_BACK_UPSTREAM_BRANCH },
    });
    expect(cfg.syncBack?.upstreamRemote).not.toBe(POT_FORK_REMOTE_NAME);
    expect(cfg.branch).not.toBe(SYNC_BACK_UPSTREAM_BRANCH);
  });

  it('only the fork path arms sync-back — commit-only and direct decisions never do', async () => {
    const ensure = vi.fn();
    for (const decision of [
      undefined,
      resolveIntegrationPushRemote({ read: { mode: 'direct', source: 'absent' } }),
      resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' } }),
    ]) {
      const cfg = baseCfg();
      await applyIntegrationPushTarget('p', cfg, decision, '/repo', { ensureRemote: ensure, ensureBranch: onBranch() });
      expect(cfg.syncBack).toBeUndefined();
      expect(cfg.branch).toBeUndefined();
    }
  });

  it('a commit-only decision pushes nowhere and never touches the remote or the branch', async () => {
    const ensure = vi.fn();
    const ensureBranch = onBranch();
    const cfg = baseCfg();
    const decision = resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' } });
    expect(await applyIntegrationPushTarget('p', cfg, decision, '/repo', { ensureRemote: ensure, ensureBranch })).toBe(
      'working_copy_fork_missing',
    );
    expect(cfg).toEqual({ push: false, remote: 'origin', pushSubmoduleOrigins: false });
    expect(ensure).not.toHaveBeenCalled();
    expect(ensureBranch).not.toHaveBeenCalled();
  });

  it('with no checkout path it pushes nowhere rather than the main repository', async () => {
    const ensure = vi.fn();
    const cfg = baseCfg();
    expect(
      await applyIntegrationPushTarget('p', cfg, forkDecision, null, { ensureRemote: ensure, ensureBranch: onBranch() }),
    ).toBe('working_copy_no_repo_path');
    expect(cfg.push).toBe(false);
    expect(cfg.remote).toBe('origin');
    expect(ensure).not.toHaveBeenCalled();
  });

  it('if the fork remote cannot be set up it pushes nowhere — never falls back to origin', async () => {
    const ensure = vi.fn().mockRejectedValue(new Error('git remote add failed'));
    const cfg = baseCfg();
    expect(
      await applyIntegrationPushTarget('p', cfg, forkDecision, '/repo', { ensureRemote: ensure, ensureBranch: onBranch() }),
    ).toBe('working_copy_fork_remote_setup_failed');
    expect(cfg).toEqual({ push: false, remote: 'origin', pushSubmoduleOrigins: false });
  });

  it('WI-10006301: a branch layout it cannot fix safely pushes nowhere and never integrates on main', async () => {
    const ensureBranch = vi
      .fn<NonNullable<ApplyIntegrationPushDeps['ensureBranch']>>()
      .mockResolvedValue({ kind: 'conflict', message: "local 'staging' is ahead of 'main'" });
    const cfg = baseCfg();
    expect(
      await applyIntegrationPushTarget('p', cfg, forkDecision, '/repo', {
        ensureRemote: vi.fn().mockResolvedValue('unchanged'),
        ensureBranch,
      }),
    ).toBe('working_copy_branch_layout_conflict');
    expect(cfg).toEqual({ push: false, remote: 'origin', pushSubmoduleOrigins: false });
  });

  it("WI-10006301: a fork whose 'staging' cannot be created pushes nowhere", async () => {
    const cfg = baseCfg();
    expect(
      await applyIntegrationPushTarget('p', cfg, forkDecision, '/repo', {
        ensureRemote: vi.fn().mockResolvedValue('unchanged'),
        ensureBranch: onBranch(),
        ensureForkBranch: vi
          .fn<NonNullable<ApplyIntegrationPushDeps['ensureForkBranch']>>()
          .mockResolvedValue({ kind: 'failed', message: "the fork has neither 'staging' nor 'main'" }),
      }),
    ).toBe('working_copy_fork_branch_seed_failed');
    expect(cfg).toEqual({ push: false, remote: 'origin', pushSubmoduleOrigins: false });
  });

  it('a fork that could not be asked still pushes — git-sync’s own fetch reports the network error', async () => {
    const cfg = baseCfg();
    expect(
      await applyIntegrationPushTarget('p', cfg, forkDecision, '/repo', {
        ensureRemote: vi.fn().mockResolvedValue('unchanged'),
        ensureBranch: onBranch(),
        ensureForkBranch: vi
          .fn<NonNullable<ApplyIntegrationPushDeps['ensureForkBranch']>>()
          .mockResolvedValue({ kind: 'unknown', message: 'Could not resolve host: github.com' }),
      }),
    ).toBeNull();
    expect(cfg.push).toBe(true);
    expect(cfg.branch).toBe(WORKING_COPY_INTEGRATION_BRANCH);
  });
});

describe('ensureForkIntegrationBranch (WI-10006301: a fresh fork has only main)', () => {
  const MAIN = 'c'.repeat(40);
  function fakeGit(o: { tracking: boolean; listed: string; haveObject?: boolean; pushFails?: boolean; lsFails?: boolean }) {
    const calls: string[][] = [];
    const run: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        if (!o.tracking) throw new Error('exit 1');
        return { stdout: MAIN };
      }
      if (args[0] === 'ls-remote') {
        if (o.lsFails) throw new Error('Could not resolve host: github.com');
        return { stdout: o.listed };
      }
      if (args[0] === 'cat-file' && !o.haveObject) throw new Error('missing');
      if (args[0] === 'push' && o.pushFails) throw new Error('permission denied');
      return { stdout: '' };
    };
    return { run, calls };
  }
  const pushes = (calls: string[][]) => calls.filter((c) => c[0] === 'push');

  it('already fetched once: present, and the fork is not even asked', async () => {
    const g = fakeGit({ tracking: true, listed: '' });
    expect(await ensureForkIntegrationBranch('/repo', g.run)).toEqual({ kind: 'present' });
    expect(g.calls.some((c) => c[0] === 'ls-remote')).toBe(false);
  });

  it('the fork has staging: present, nothing pushed', async () => {
    const g = fakeGit({ tracking: false, listed: `${MAIN}\trefs/heads/main\n${MAIN}\trefs/heads/staging\n` });
    expect(await ensureForkIntegrationBranch('/repo', g.run)).toEqual({ kind: 'present' });
    expect(pushes(g.calls)).toEqual([]);
  });

  it("the fork has only main: creates staging at the fork's own main tip (publishes nothing new)", async () => {
    const g = fakeGit({ tracking: false, listed: `${MAIN}\trefs/heads/main\n`, haveObject: true });
    expect(await ensureForkIntegrationBranch('/repo', g.run)).toEqual({ kind: 'seeded', sha: MAIN });
    expect(pushes(g.calls)).toEqual([['push', POT_FORK_REMOTE_NAME, `${MAIN}:refs/heads/staging`]]);
    expect(g.calls.some((c) => c[0] === 'fetch')).toBe(false);
  });

  it("fetches the fork's main first when the checkout does not have that commit", async () => {
    const g = fakeGit({ tracking: false, listed: `${MAIN}\trefs/heads/main\n`, haveObject: false });
    expect(await ensureForkIntegrationBranch('/repo', g.run)).toMatchObject({ kind: 'seeded' });
    expect(g.calls).toContainEqual(['fetch', POT_FORK_REMOTE_NAME, 'refs/heads/main']);
  });

  it('a fork with neither branch, or a refused push, fails without guessing', async () => {
    expect(await ensureForkIntegrationBranch('/repo', fakeGit({ tracking: false, listed: '' }).run)).toMatchObject({ kind: 'failed' });
    expect(
      await ensureForkIntegrationBranch(
        '/repo',
        fakeGit({ tracking: false, listed: `${MAIN}\trefs/heads/main\n`, haveObject: true, pushFails: true }).run,
      ),
    ).toMatchObject({ kind: 'failed' });
  });

  it('an unreachable fork is unknown, not failed', async () => {
    const g = fakeGit({ tracking: false, listed: '', lsFails: true });
    expect(await ensureForkIntegrationBranch('/repo', g.run)).toMatchObject({ kind: 'unknown' });
    expect(pushes(g.calls)).toEqual([]);
  });
});

describe('ensureWorkingCopyIntegrationBranch (WI-10006301, D-011)', () => {
  const HEAD = 'a'.repeat(40);
  const OLD = 'b'.repeat(40);
  const ZERO = '0'.repeat(40);
  /** A fake git holding HEAD's branch, HEAD's sha, and an optional local staging ref. */
  function fakeGit(o: { current: string | null; staging: string | null; stagingIsAncestor?: boolean }) {
    const calls: string[][] = [];
    const run: RunGit = async (args) => {
      calls.push(args);
      const key = args.join(' ');
      if (key === 'symbolic-ref --quiet --short HEAD') {
        if (o.current === null) throw new Error('fatal: ref HEAD is not a symbolic ref');
        return { stdout: `${o.current}\n` };
      }
      if (key === 'rev-parse --verify HEAD^{commit}') return { stdout: `${HEAD}\n` };
      if (key === 'rev-parse --verify --quiet refs/heads/staging^{commit}') {
        if (o.staging === null) throw new Error('exit 1');
        return { stdout: `${o.staging}\n` };
      }
      if (args[0] === 'merge-base') {
        if (!o.stagingIsAncestor) throw new Error('exit 1');
        return { stdout: '' };
      }
      return { stdout: '' };
    };
    return { run, calls };
  }
  const writes = (calls: string[][]) => calls.filter((c) => c[0] === 'update-ref' || (c[0] === 'symbolic-ref' && c[1] === 'HEAD'));

  it('already on staging: nothing to do, no writes', async () => {
    const g = fakeGit({ current: 'staging', staging: HEAD });
    expect(await ensureWorkingCopyIntegrationBranch('/repo', g.run)).toEqual({ kind: 'on-branch' });
    expect(writes(g.calls)).toEqual([]);
  });

  it('on main with no staging: creates staging at HEAD (must-not-exist guard) and attaches it', async () => {
    const g = fakeGit({ current: 'main', staging: null });
    expect(await ensureWorkingCopyIntegrationBranch('/repo', g.run)).toEqual({
      kind: 'attached',
      from: 'main',
      created: true,
      fastForwarded: false,
    });
    expect(writes(g.calls)).toEqual([
      ['update-ref', 'refs/heads/staging', HEAD, ZERO],
      ['symbolic-ref', 'HEAD', 'refs/heads/staging'],
    ]);
  });

  it('staging at the same commit as HEAD: only re-points HEAD', async () => {
    const g = fakeGit({ current: 'main', staging: HEAD });
    expect(await ensureWorkingCopyIntegrationBranch('/repo', g.run)).toMatchObject({ kind: 'attached', created: false, fastForwarded: false });
    expect(writes(g.calls)).toEqual([['symbolic-ref', 'HEAD', 'refs/heads/staging']]);
  });

  it('staging behind HEAD: fast-forwards it (compare-and-swap on the old sha) and attaches', async () => {
    const g = fakeGit({ current: 'main', staging: OLD, stagingIsAncestor: true });
    expect(await ensureWorkingCopyIntegrationBranch('/repo', g.run)).toMatchObject({ kind: 'attached', fastForwarded: true });
    expect(writes(g.calls)).toEqual([
      ['update-ref', 'refs/heads/staging', HEAD, OLD],
      ['symbolic-ref', 'HEAD', 'refs/heads/staging'],
    ]);
  });

  it('a detached HEAD is attached the same way', async () => {
    const g = fakeGit({ current: null, staging: null });
    expect(await ensureWorkingCopyIntegrationBranch('/repo', g.run)).toMatchObject({ kind: 'attached', from: null, created: true });
  });

  it('staging ahead of or diverged from HEAD: conflict, and nothing is moved', async () => {
    const g = fakeGit({ current: 'main', staging: OLD, stagingIsAncestor: false });
    const r = await ensureWorkingCopyIntegrationBranch('/repo', g.run);
    expect(r.kind).toBe('conflict');
    expect(writes(g.calls)).toEqual([]);
  });
});

describe('setPotIntegrationMode (P-015 guard)', () => {
  const base = { workspaceId: 'ws', potHomeSlug: 'pot' };
  it('refuses working-copy mode without a green-gate test command', async () => {
    for (const greenCmd of [null, undefined, '', '   ']) {
      const r = await setPotIntegrationMode({ ...base, mode: 'review', greenCmd, forkRemote: FORK });
      expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    }
    expect(store.setHiveSetting).not.toHaveBeenCalled();
  });
  it('refuses working-copy mode without a fork', async () => {
    const r = await setPotIntegrationMode({ ...base, mode: 'review', greenCmd: 'npm test', forkRemote: null });
    expect(r).toMatchObject({ ok: false, error: 'fork_required' });
    expect(store.setHiveSetting).not.toHaveBeenCalled();
  });
  it('the guided switch names the missing suite before unconfigured submodule forks and creates nothing', async () => {
    const createSubmoduleForks = vi.fn();
    const ensureFork = vi.fn();
    const r = await choosePotIntegrationMode({
      ...base, harnessSlug: 'member', mode: 'review', greenCmd: null,
      forkRemote: null, upstreamRemote: 'https://github.com/acme/widget.git',
      hasSubmodules: true, checkoutPath: '/repo',
    }, { createSubmoduleForks, ensureFork });
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(createSubmoduleForks).not.toHaveBeenCalled();
    expect(ensureFork).not.toHaveBeenCalled();
    expect(store.setHiveSetting).not.toHaveBeenCalled();
  });
  it('accepts working-copy mode with a test command and a fork', async () => {
    const r = await setPotIntegrationMode({ ...base, mode: 'review', greenCmd: 'npm test', forkRemote: FORK });
    expect(r).toEqual({ ok: true, mode: 'review' });
    expect(store.setHiveSetting).toHaveBeenCalledWith(
      { workspaceId: 'ws', potHomeSlug: 'pot', settingKey: 'hiveGit.integration', value: 'review' },
      undefined,
    );
  });
  it('direct needs neither; null clears the row', async () => {
    expect(await setPotIntegrationMode({ ...base, mode: 'direct', greenCmd: null, forkRemote: null })).toEqual({
      ok: true,
      mode: 'direct',
    });
    expect(await setPotIntegrationMode({ ...base, mode: null, greenCmd: null, forkRemote: null })).toEqual({
      ok: true,
      mode: null,
    });
    expect(store.deleteHiveSetting).toHaveBeenCalledWith('ws', 'pot', 'hiveGit.integration', undefined);
  });
  it('D-017: a repo with submodules needs a recorded fork for EVERY submodule (unknown list fails closed)', async () => {
    const review = { ...base, mode: 'review' as const, greenCmd: 'npm test', forkRemote: FORK, hasSubmodules: true };
    // No submodule list at all: nothing proves every submodule has a fork.
    expect(await setPotIntegrationMode(review)).toMatchObject({ ok: false, error: 'submodule_forks_required' });
    // One submodule without a fork: refused, naming it.
    const partial = await setPotIntegrationMode({
      ...review,
      submodulePaths: ['libs/a', 'libs/b'],
      submoduleForks: { 'libs/a': 'https://github.com/bot/a.git' },
    });
    expect(partial).toMatchObject({ ok: false, error: 'submodule_forks_required' });
    expect(partial.ok ? '' : partial.message).toContain('libs/b');
    expect(store.setHiveSetting).not.toHaveBeenCalled();
    // Every submodule has its fork: the working copy is allowed.
    expect(
      await setPotIntegrationMode({
        ...review,
        submodulePaths: ['libs/a', 'libs/b'],
        submoduleForks: { 'libs/a': 'https://github.com/bot/a.git', 'libs/b': 'https://github.com/bot/b.git' },
      }),
    ).toEqual({ ok: true, mode: 'review' });
    store.setHiveSetting.mockClear();
    // Straight in stays available for that repo, and an unknown answer does not block.
    expect(await setPotIntegrationMode({ ...base, mode: 'direct', greenCmd: null, forkRemote: null, hasSubmodules: true }))
      .toEqual({ ok: true, mode: 'direct' });
    expect(await setPotIntegrationMode({ ...base, mode: 'review', greenCmd: 'npm test', forkRemote: FORK, hasSubmodules: false }))
      .toEqual({ ok: true, mode: 'review' });
  });
  it('throws on an unknown mode instead of coercing', async () => {
    await expect(
      setPotIntegrationMode({ ...base, mode: 'pr' as never, greenCmd: 'npm test', forkRemote: FORK }),
    ).rejects.toThrow(/unknown mode/);
  });
});

describe('choosePotIntegrationMode (P-014: choosing working-copy mode creates the fork)', () => {
  const UPSTREAM = 'https://github.com/acme/widget.git';
  const input = (over: Partial<ChoosePotIntegrationModeInput> = {}): ChoosePotIntegrationModeInput => ({
    workspaceId: 'ws',
    potHomeSlug: 'pot',
    harnessSlug: 'widget',
    mode: 'review',
    greenCmd: 'npm test',
    forkRemote: null,
    upstreamRemote: UPSTREAM,
    ...over,
  });
  const deps = (forkFullName = 'acme-bot/widget', created = true) => ({
    ensureFork: vi.fn().mockResolvedValue({ forkOwner: forkFullName.split('/')[0], forkFullName, created }),
    setForkRemote: vi
      .fn()
      .mockImplementation(async (slug: string, url: string) => ({ ok: true, slug, forkRemote: url, cleared: false })),
    setMode: vi.fn().mockImplementation(async (i: { mode: string | null }) => ({ ok: true, mode: i.mode })),
    // P-019 seams: a pot that is not yet a working copy, and no standing PR.
    readMode: vi.fn().mockResolvedValue({ mode: 'direct', source: 'absent' }),
    findOpenStandingPr: vi.fn().mockResolvedValue({ ok: true, pr: null }),
  });

  it('creates the fork, records it as fork_remote, then sets the mode with that fork', async () => {
    const d = deps();
    const r = await choosePotIntegrationMode(input(), d);
    expect(r).toEqual({ ok: true, mode: 'review', fork: { url: FORK, created: true } });
    expect(d.ensureFork).toHaveBeenCalledWith({ upstreamOwner: 'acme', upstreamRepo: 'widget' });
    expect(d.setForkRemote).toHaveBeenCalledWith('widget', FORK, 'ws');
    expect(d.setMode).toHaveBeenCalledWith(expect.objectContaining({ mode: 'review', forkRemote: FORK }));
  });

  it('D-017: a repo with submodules gets a fork of every submodule, recorded before the mode is set', async () => {
    const forks = { 'libs/a': 'https://github.com/acme-bot/a.git' };
    const d = {
      ...deps(),
      createSubmoduleForks: vi.fn().mockResolvedValue({ ok: true, forks, created: ['libs/a'] }),
      recordSubmoduleForks: vi.fn().mockResolvedValue(undefined),
    };
    const r = await choosePotIntegrationMode(input({ hasSubmodules: true, checkoutPath: '/pot' }), d);
    expect(r).toEqual({ ok: true, mode: 'review', fork: { url: FORK, created: true } });
    expect(d.recordSubmoduleForks).toHaveBeenCalledWith('ws', 'pot', forks);
    expect(d.setMode).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'review', forkRemote: FORK, submodulePaths: ['libs/a'], submoduleForks: forks }),
    );
    expect(d.recordSubmoduleForks.mock.invocationCallOrder[0]).toBeLessThan(d.setMode.mock.invocationCallOrder[0]!);
  });

  it('D-017: a submodule that cannot be forked is refused BEFORE the superproject fork is created', async () => {
    const d = {
      ...deps(),
      createSubmoduleForks: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'submodule_not_github', message: "submodule 'libs/x' is not on GitHub" }),
      recordSubmoduleForks: vi.fn(),
    };
    const r = await choosePotIntegrationMode(input({ hasSubmodules: true, checkoutPath: '/pot' }), d);
    expect(r).toMatchObject({ ok: false, error: 'submodule_not_github' });
    expect(d.ensureFork).not.toHaveBeenCalled();
    expect(d.setForkRemote).not.toHaveBeenCalled();
    expect(d.recordSubmoduleForks).not.toHaveBeenCalled();
    expect(d.setMode).not.toHaveBeenCalled();
  });

  it('D-017: no test command means no fork of anything (submodules included)', async () => {
    const d = { ...deps(), createSubmoduleForks: vi.fn(), recordSubmoduleForks: vi.fn() };
    d.setMode.mockResolvedValue({ ok: false, error: 'green_cmd_required', message: 'needs tests' });
    const r = await choosePotIntegrationMode(input({ hasSubmodules: true, checkoutPath: '/pot', greenCmd: null }), d);
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(d.createSubmoduleForks).not.toHaveBeenCalled();
    expect(d.ensureFork).not.toHaveBeenCalled();
  });

  it('a fork already recorded is reused: no fork is created', async () => {
    const d = deps();
    const r = await choosePotIntegrationMode(input({ forkRemote: FORK }), d);
    expect(r).toEqual({ ok: true, mode: 'review', fork: null });
    expect(d.ensureFork).not.toHaveBeenCalled();
    expect(d.setForkRemote).not.toHaveBeenCalled();
    expect(d.setMode).toHaveBeenCalledWith(expect.objectContaining({ forkRemote: FORK }));
  });

  it('direct mode never touches forks', async () => {
    const d = deps();
    expect(await choosePotIntegrationMode(input({ mode: 'direct' }), d)).toEqual({ ok: true, mode: 'direct', fork: null });
    expect(d.ensureFork).not.toHaveBeenCalled();
  });

  it('without a green-gate test command it refuses BEFORE creating any fork', async () => {
    const d = deps();
    d.setMode.mockResolvedValue({ ok: false, error: 'green_cmd_required', message: 'x' });
    const r = await choosePotIntegrationMode(input({ greenCmd: '  ' }), d);
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(d.ensureFork).not.toHaveBeenCalled();
    expect(d.setForkRemote).not.toHaveBeenCalled();
  });

  it('refuses when the signed-in account owns the main repository (the "fork" would BE the main repository)', async () => {
    const d = deps('ACME/widget', false);
    const r = await choosePotIntegrationMode(input(), d);
    expect(r).toMatchObject({ ok: false, error: 'fork_is_main_repository' });
    expect(d.setForkRemote).not.toHaveBeenCalled();
    expect(d.setMode).not.toHaveBeenCalled();
  });

  it('a fork-creation failure is reported and nothing is recorded', async () => {
    const d = deps();
    d.ensureFork.mockRejectedValue(new Error('no gh token'));
    const r = await choosePotIntegrationMode(input(), d);
    expect(r).toMatchObject({ ok: false, error: 'fork_create_failed' });
    expect((r as { message: string }).message).toContain('no gh token');
    expect(d.setForkRemote).not.toHaveBeenCalled();
    expect(d.setMode).not.toHaveBeenCalled();
  });

  it('a pot whose main repository is not on GitHub is refused', async () => {
    for (const upstreamRemote of [null, undefined, '', 'https://gitlab.com/acme/widget.git']) {
      const d = deps();
      const r = await choosePotIntegrationMode(input({ upstreamRemote }), d);
      expect(r).toMatchObject({ ok: false, error: 'upstream_remote_required' });
      expect(d.ensureFork).not.toHaveBeenCalled();
    }
  });

  it('a failure to record the fork leaves the mode unset', async () => {
    const d = deps();
    d.setForkRemote.mockResolvedValue({ ok: false, error: 'harness_not_found', message: 'no such harness' });
    const r = await choosePotIntegrationMode(input(), d);
    expect(r).toMatchObject({ ok: false, error: 'fork_record_failed', message: 'no such harness' });
    expect(d.setMode).not.toHaveBeenCalled();
  });

  it('the recorded fork is what the push resolver pushes to', async () => {
    const d = deps();
    const r = await choosePotIntegrationMode(input(), d);
    const url = r.ok && r.fork ? r.fork.url : undefined;
    expect(resolveIntegrationPushRemote({ read: { mode: 'review', source: 'set' }, forkRemote: url })).toMatchObject({
      kind: 'fork',
      remoteName: POT_FORK_REMOTE_NAME,
      url: FORK,
    });
  });
});

describe('choosePotIntegrationMode (P-019: leaving a working copy waits for its open PR)', () => {
  const PR = { number: 7, url: 'https://github.com/acme/widget/pull/7' };
  const input = (over: Partial<ChoosePotIntegrationModeInput> = {}): ChoosePotIntegrationModeInput => ({
    workspaceId: 'ws',
    potHomeSlug: 'pot',
    harnessSlug: 'widget',
    mode: 'direct',
    greenCmd: 'npm test',
    forkRemote: FORK,
    upstreamRemote: 'git@github.com:acme/widget.git',
    ...over,
  });
  const deps = (
    current: { mode: 'direct' | 'review'; source: 'set' | 'absent' | 'error' } = { mode: 'review', source: 'set' },
    lookup: unknown = { ok: true, pr: PR },
  ) => ({
    ensureFork: vi.fn(),
    setForkRemote: vi.fn(),
    setMode: vi.fn().mockImplementation(async (i: { mode: string | null }) => ({ ok: true, mode: i.mode })),
    readMode: vi.fn().mockResolvedValue(current),
    findOpenStandingPr: vi.fn().mockResolvedValue(lookup),
  });

  it.each([['direct' as const], [null]])(
    'a working copy with an open standing PR: switching to %s is refused, naming the PR, and nothing is stored',
    async (mode) => {
      const d = deps();
      const r = await choosePotIntegrationMode(input({ mode }), d);
      expect(r).toMatchObject({ ok: false, error: 'standing_pr_open' });
      expect(!r.ok && r.message).toContain('#7');
      expect(!r.ok && r.message).toContain(PR.url);
      expect(d.setMode).not.toHaveBeenCalled();
      // the lookup is asked about the MAIN repository, normalised from the registry remote, and
      // restricted to PRs from THIS pot's fork (WI-10006271: the branch name alone is shared)
      expect(d.findOpenStandingPr).toHaveBeenCalledWith('github.com/acme/widget', 'acme-bot/widget');
      expect(d.readMode).toHaveBeenCalledWith('ws', 'pot');
    },
  );

  it('no recorded fork: the lookup is unfiltered, so any standing-branch PR still holds the switch', async () => {
    const d = deps();
    const r = await choosePotIntegrationMode(input({ forkRemote: null }), d);
    expect(r).toMatchObject({ ok: false, error: 'standing_pr_open' });
    expect(d.findOpenStandingPr).toHaveBeenCalledWith('github.com/acme/widget', undefined);
  });

  it('once the PR is merged or closed (none open), the switch to straight in goes through', async () => {
    const d = deps({ mode: 'review', source: 'set' }, { ok: true, pr: null });
    expect(await choosePotIntegrationMode(input(), d)).toEqual({ ok: true, mode: 'direct', fork: null });
    expect(d.setMode).toHaveBeenCalledWith(expect.objectContaining({ mode: 'direct' }));
  });

  it('fails CLOSED: when the PR cannot be checked, the pot stays in its working copy', async () => {
    const d = deps({ mode: 'review', source: 'set' }, { ok: false, error: 'rate limited' });
    const r = await choosePotIntegrationMode(input(), d);
    expect(r).toMatchObject({ ok: false, error: 'standing_pr_unknown' });
    expect(!r.ok && r.message).toContain('rate limited');
    expect(d.setMode).not.toHaveBeenCalled();
  });

  it('an unreadable current mode is treated as a possible working copy (the PR is still checked)', async () => {
    const d = deps({ mode: 'direct', source: 'error' });
    expect(await choosePotIntegrationMode(input(), d)).toMatchObject({ ok: false, error: 'standing_pr_open' });
    expect(d.findOpenStandingPr).toHaveBeenCalledTimes(1);
  });

  it('a pot that is already straight in is never held up by a PR lookup', async () => {
    const d = deps({ mode: 'direct', source: 'set' });
    expect(await choosePotIntegrationMode(input(), d)).toEqual({ ok: true, mode: 'direct', fork: null });
    expect(d.findOpenStandingPr).not.toHaveBeenCalled();
  });

  it('switching INTO a working copy never consults the PR lookup', async () => {
    const d = deps();
    expect(await choosePotIntegrationMode(input({ mode: 'review' }), d)).toEqual({ ok: true, mode: 'review', fork: null });
    expect(d.readMode).not.toHaveBeenCalled();
    expect(d.findOpenStandingPr).not.toHaveBeenCalled();
  });

  it('no main repository on GitHub ⇒ no standing PR can exist, so the switch goes through', async () => {
    const d = deps();
    expect(await choosePotIntegrationMode(input({ upstreamRemote: null }), d)).toMatchObject({ ok: true, mode: 'direct' });
    expect(d.findOpenStandingPr).not.toHaveBeenCalled();
  });
});

describe('integrationModeGovernsHarness (WI-10006333)', () => {
  const fork = 'https://github.com/papercupai/pilot.git';
  const home = { slug: 'pilot-pot', self_repo: true };
  const member = { slug: 'pilot', hive_slug: 'pilot-pot', fork_remote: fork };

  it("does not govern a repo pot's home once a member holds the working copy", () => {
    expect(integrationModeGovernsHarness(home, [home, member])).toBe(false);
  });

  it('governs every member, with or without a fork (fail-closed)', () => {
    expect(integrationModeGovernsHarness(member, [home, member])).toBe(true);
    const forkless = { slug: 'pilot', hive_slug: 'pilot-pot' };
    expect(integrationModeGovernsHarness(forkless, [home, forkless])).toBe(true);
  });

  it('keeps a self-hosted home governed when no member holds a fork', () => {
    // Its home IS the subject repo: a missing fork must never push to it.
    const memberWithoutFork = { slug: 'side', hive_slug: 'pilot-pot' };
    expect(integrationModeGovernsHarness(home, [home, memberWithoutFork])).toBe(true);
    expect(integrationModeGovernsHarness(home, [home])).toBe(true);
  });

  it("ignores another pot's forked members", () => {
    const foreign = { slug: 'other', hive_slug: 'other-pot', fork_remote: fork };
    expect(integrationModeGovernsHarness(home, [home, foreign])).toBe(true);
  });

  it('governs a home that carries its own fork', () => {
    expect(integrationModeGovernsHarness({ ...home, fork_remote: fork }, [home, member])).toBe(true);
  });
});

describe('repoHasSubmodules (WI-10006107)', () => {
  it('reads .gitmodules in the checkout; an unknown path is undefined, not false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pot-submodules-'));
    try {
      expect(repoHasSubmodules(dir)).toBe(false);
      writeFileSync(join(dir, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/acme/lib.git\n');
      expect(repoHasSubmodules(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(repoHasSubmodules(null)).toBeUndefined();
    expect(repoHasSubmodules(undefined)).toBeUndefined();
  });
});
