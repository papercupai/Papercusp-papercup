/**
 * worktree-coverage-watchdog.test.ts — WI-3612 (EI-8820 follow-up).
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('../alarm-attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../alarm-attention')>()),
  resolveAlarm: vi.fn(async () => true),
}));
import {
  findUncoveredDirtyWorktrees,
  parseWorktreeListPorcelain,
  listWorktreesWithDirtyState,
  checkWorktreeCoverage,
  isNotARepoError,
  KNOWN_UNCOVERED_WORKTREE_PATTERNS,
  normalizeCheckoutPath,
  resolveGitSyncCoverage,
  findUncoveredDirtyCheckouts,
  listSiblingCheckoutsWithDirtyState,
  checkGitSyncCoverage,
  matchTriagedScopeOut,
  TRIAGED_CHECKOUT_SCOPE_OUTS,
  runWatchdogGit,
  type WatchdogGitSeams,
  type WorktreeInfo,
  type CheckoutInfo,
  type TriagedCheckoutScopeOut,
} from './worktree-coverage-watchdog';

// WI-10005446 wiring guard. The sidecar reports itself enabled for this whole file. Its
// default answer (undefined) falls through to the local spawn, so tests that never
// configure it behave as before.
const sidecarGit = vi.hoisted(() => vi.fn());
vi.mock('../fleet/git-via-sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fleet/git-via-sidecar')>()),
  gitSidecarEnabled: () => true,
  runGitViaSpawnerSidecar: sidecarGit,
}));

const CANONICAL = '/home/dev/papercupai-workspace/papercusp';

function wt(path: string, dirty: boolean, dirtyFileCount = dirty ? 1 : 0): WorktreeInfo {
  return { path, dirty, dirtyFileCount };
}

describe('findUncoveredDirtyWorktrees (pure classifier)', () => {
  it('never flags a clean worktree, regardless of path', () => {
    expect(
      findUncoveredDirtyWorktrees([wt('/some/random/stray-worktree', false)], CANONICAL),
    ).toEqual([]);
  });

  it('never flags the canonical tree itself, even if dirty (it IS git-sync\'s own target)', () => {
    expect(findUncoveredDirtyWorktrees([wt(CANONICAL, true, 5)], CANONICAL)).toEqual([]);
  });

  it('does not flag a dirty -release / -checkpoint sibling tree (reset every run by design)', () => {
    const worktrees = [
      wt('/home/dev/papercupai-workspace/papercup-release', true, 12),
      wt('/home/dev/papercupai-workspace/papercup-checkpoint', true, 3),
      wt('/home/dev/papercupai-workspace/papercusp-checkpoint', true, 7),
    ];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual([]);
  });

  it('does not flag a dirty D-006 env-tree (env-tree-prepare.ts — force-recreatable, never committed)', () => {
    const worktrees = [
      wt('/home/dev/.papercusp-workspaces/papercusp-workspace/.papercusp/env-trees/staging', true, 3730),
    ];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual([]);
  });

  it('does not flag a dirty migration/synthesis isolation worktree', () => {
    const worktrees = [wt('/home/dev/papercupai-workspace/papercusp/.papercusp/worktrees/migrate-xyz', true, 2)];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual([]);
  });

  it('does not flag a dirty verification-harness release-local pinned source snapshot', () => {
    const worktrees = [wt(
      '/home/dev/.local/state/verification-harness/release-local/wi-123-run-20261012/source',
      true,
      1,
    )];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual([]);
  });

  it('does not flag a dirty workspace-host release-cut pinned source checkout', () => {
    const worktrees = [wt('/home/dev/.papercusp/wh-release-r64/source', true, 1)];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual([]);
  });

  it('still flags an ordinary dirty checkout under a similarly named release-local directory', () => {
    const ordinary = wt(
      '/home/dev/.local/state/verification-harness/release-local/wi-123/worktree',
      true,
      1,
    );
    expect(findUncoveredDirtyWorktrees([ordinary], CANONICAL)).toEqual([ordinary]);
  });

  it('FLAGS a dirty worktree matching none of the known patterns — the WI-3449 class', () => {
    const worktrees = [wt('/home/dev/some-random-clone-of-papercusp', true, 4)];
    expect(findUncoveredDirtyWorktrees(worktrees, CANONICAL)).toEqual(worktrees);
  });

  it('only flags the uncovered entries out of a mixed set', () => {
    const covered = wt('/home/dev/papercupai-workspace/papercup-release', true, 1);
    const clean = wt('/home/dev/stray', false);
    const stray = wt('/home/dev/stray-worktree-with-edits', true, 2);
    expect(findUncoveredDirtyWorktrees([covered, clean, stray], CANONICAL)).toEqual([stray]);
  });

  it('KNOWN_UNCOVERED_WORKTREE_PATTERNS is non-empty and every entry is a RegExp', () => {
    expect(KNOWN_UNCOVERED_WORKTREE_PATTERNS.length).toBeGreaterThan(0);
    for (const p of KNOWN_UNCOVERED_WORKTREE_PATTERNS) expect(p).toBeInstanceOf(RegExp);
  });
});

describe('parseWorktreeListPorcelain', () => {
  it('extracts every worktree path from real --porcelain output', () => {
    const out = [
      'worktree /home/dev/papercupai-workspace/papercusp',
      'HEAD 1c3be69157abcdef',
      'branch refs/heads/staging',
      '',
      'worktree /home/dev/papercupai-workspace/papercup-release',
      'HEAD 466b932774abcdef',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(out)).toEqual([
      '/home/dev/papercupai-workspace/papercusp',
      '/home/dev/papercupai-workspace/papercup-release',
    ]);
  });

  it('returns an empty array for empty/garbage input', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([]);
    expect(parseWorktreeListPorcelain('HEAD abc\nbranch refs/heads/x\n')).toEqual([]);
  });
});

describe('listWorktreesWithDirtyState (git-injected)', () => {
  it('reports dirty=true with the right count for a worktree with status lines', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') {
        return 'worktree /a\n\nworktree /b\n\n';
      }
      if (cwd === '/a') return ' M file1.ts\n?? file2.ts\n';
      return ''; // /b clean
    });
    const result = await listWorktreesWithDirtyState('/a', { runGit });
    expect(result).toEqual([
      { path: '/a', dirty: true, dirtyFileCount: 2 },
      { path: '/b', dirty: false, dirtyFileCount: 0 },
    ]);
  });

  it('skips (does not throw for) a worktree whose status check fails', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return 'worktree /a\n\nworktree /gone\n\n';
      if (cwd === '/gone') throw new Error('no such directory');
      return '';
    });
    const result = await listWorktreesWithDirtyState('/a', { runGit });
    expect(result).toEqual([{ path: '/a', dirty: false, dirtyFileCount: 0 }]);
  });
});

describe('checkWorktreeCoverage (end-to-end pass)', () => {
  it('never throws even when the underlying git call rejects', async () => {
    const runGit = vi.fn(async () => { throw new Error('git not found'); });
    const log = vi.fn();
    const result = await checkWorktreeCoverage('/a', { runGit, log });
    expect(result).toEqual({ uncovered: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pass failed'));
  });

  it('returns the uncovered set and logs a finding when a stray dirty worktree exists', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return 'worktree /a\n\nworktree /stray\n\n';
      if (cwd === '/stray') return ' M x.ts\n';
      return '';
    });
    const log = vi.fn();
    const result = await checkWorktreeCoverage('/a', { runGit, log });
    expect(result.uncovered).toEqual([{ path: '/stray', dirty: true, dirtyFileCount: 1 }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/stray'));
  });

  it('logs nothing when every dirty worktree is covered/excluded', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return 'worktree /a\n\n';
      return ' M x.ts\n'; // canonical itself, dirty — never flagged
    });
    const log = vi.fn();
    const result = await checkWorktreeCoverage('/a', { runGit, log });
    expect(result.uncovered).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  // EI-9922: on a PACKAGED install there is no git checkout, so `git worktree list`
  // fatals with "not a git repository" every boot + hourly sweep. That is the expected
  // no-op state, not a fault — the watchdog must go QUIET on it (it was one of the ~15+
  // 'fatal: not a git repository' boot-log lines that buried real boot errors).
  it('EI-9922: goes QUIET (logs nothing) when git reports "not a git repository" (packaged install)', async () => {
    const runGit = vi.fn(async () => {
      throw new Error(
        'fatal: not a git repository (or any of the parent directories): .git',
      );
    });
    const log = vi.fn();
    const result = await checkWorktreeCoverage('/some/packaged/install', { runGit, log });
    expect(result).toEqual({ uncovered: [] });
    expect(log).not.toHaveBeenCalled();
  });

  it('EI-9922: still logs a tagged "pass failed" for a NON-not-a-repo git error (a real fault)', async () => {
    const runGit = vi.fn(async () => { throw new Error('git: could not read Username'); });
    const log = vi.fn();
    await checkWorktreeCoverage('/a', { runGit, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pass failed'));
  });
});

describe('isNotARepoError (EI-9922 not-a-repo classifier)', () => {
  it('is true for the git "not a git repository" fatal (any phrasing)', () => {
    expect(isNotARepoError(new Error('fatal: not a git repository (or any of the parent directories): .git'))).toBe(true);
    expect(isNotARepoError(new Error('fatal: not a git repository (or any parent up to mount point /)'))).toBe(true);
    expect(isNotARepoError('fatal: NOT A GIT REPOSITORY')).toBe(true);
  });

  it('is false for any other git error', () => {
    expect(isNotARepoError(new Error('git not found'))).toBe(false);
    expect(isNotARepoError(new Error('could not read Username for https://github.com'))).toBe(false);
    expect(isNotARepoError(undefined)).toBe(false);
  });
});

// ===========================================================================
// Sibling-CLONE coverage — WI-38857 / EI-20443492691207801
// ===========================================================================

const WS_ROOT = '/home/dev/papercupai-workspace';
const SIDESTAGE = `${WS_ROOT}/sidestage`;

function co(path: string, dirtyFileCount: number, lastCommitEpochSec: number | null = 1_700_000_000): CheckoutInfo {
  return { path, dirty: dirtyFileCount > 0, dirtyFileCount, lastCommitEpochSec };
}

describe('normalizeCheckoutPath', () => {
  it('makes a trailing slash irrelevant, so a covered tree is never read as uncovered', () => {
    expect(normalizeCheckoutPath(`${SIDESTAGE}/`)).toBe(SIDESTAGE);
    expect(normalizeCheckoutPath(`${SIDESTAGE}///`)).toBe(SIDESTAGE);
    expect(normalizeCheckoutPath(`  ${SIDESTAGE}  `)).toBe(SIDESTAGE);
  });

  it('does not eat a lone root slash', () => {
    expect(normalizeCheckoutPath('/')).toBe('/');
  });
});

describe('resolveGitSyncCoverage (pure)', () => {
  const projects = [
    { slug: 'papercusp', path: `${WS_ROOT}/papercusp` },
    { slug: 'sidestage-mobile', path: `${WS_ROOT}/sidestage-mobile` },
    { slug: 'gone', path: `${WS_ROOT}/deleted-long-ago` },
  ];
  const existing = new Set([`${WS_ROOT}/papercusp`, `${WS_ROOT}/sidestage-mobile`]);

  it('covers exactly the paths an ACTIVE routine resolves to through the registry', () => {
    const { coveredPaths } = resolveGitSyncCoverage(['papercusp', 'sidestage-mobile'], projects, existing);
    expect(coveredPaths.sort()).toEqual([`${WS_ROOT}/papercusp`, `${WS_ROOT}/sidestage-mobile`]);
  });

  it('reports an active routine whose registry path is gone as STALE coverage (the inverse failure)', () => {
    const { coveredPaths, staleCoverage } = resolveGitSyncCoverage(['gone'], projects, existing);
    expect(coveredPaths).toEqual([]);
    expect(staleCoverage).toEqual([{ installSlug: 'gone', path: `${WS_ROOT}/deleted-long-ago` }]);
  });

  it('a routine slug with no registry entry covers nothing and is not miscounted as stale', () => {
    const { coveredPaths, staleCoverage } = resolveGitSyncCoverage(['no-such-slug'], projects, existing);
    expect(coveredPaths).toEqual([]);
    expect(staleCoverage).toEqual([]);
  });

  it('an INACTIVE routine confers no coverage (callers pass active slugs only)', () => {
    expect(resolveGitSyncCoverage([], projects, existing).coveredPaths).toEqual([]);
  });
});

describe('findUncoveredDirtyCheckouts (pure classifier)', () => {
  const covered = [`${WS_ROOT}/papercusp`, `${WS_ROOT}/sidestage-mobile`];

  it('FLAGS the real incident: a dirty sibling clone no git-sync routine covers', () => {
    const out = findUncoveredDirtyCheckouts([co(SIDESTAGE, 54)], { canonicalPath: CANONICAL, coveredPaths: covered });
    expect(out.map((c) => c.path)).toEqual([SIDESTAGE]);
  });

  it('stays silent on a covered checkout even when it is dirty (the hive tree mid-sweep)', () => {
    const out = findUncoveredDirtyCheckouts([co(`${WS_ROOT}/sidestage-mobile`, 9)], {
      canonicalPath: CANONICAL,
      coveredPaths: covered,
    });
    expect(out).toEqual([]);
  });

  it('never flags a clean checkout, covered or not', () => {
    const out = findUncoveredDirtyCheckouts([co(`${WS_ROOT}/some-idle-clone`, 0)], {
      canonicalPath: CANONICAL,
      coveredPaths: covered,
    });
    expect(out).toEqual([]);
  });

  it('never flags the canonical tree itself', () => {
    const out = findUncoveredDirtyCheckouts([co(CANONICAL, 3)], { canonicalPath: CANONICAL, coveredPaths: [] });
    expect(out).toEqual([]);
  });

  it('does not double-report a LINKED worktree the other pass already judges', () => {
    const linked = `${WS_ROOT}/papercusp-staging`;
    const out = findUncoveredDirtyCheckouts([co(linked, 4)], {
      canonicalPath: CANONICAL,
      coveredPaths: [],
      linkedWorktreePaths: [linked],
    });
    expect(out).toEqual([]);
  });

  it('honours the documented exclusions, including -relcut- release-cut trees', () => {
    const out = findUncoveredDirtyCheckouts(
      [
        co(`${WS_ROOT}/papercup-release`, 12),
        co(`${WS_ROOT}/papercusp-checkpoint`, 1),
        co(`${WS_ROOT}/papercusp-relcut-0016`, 1),
        co(`${WS_ROOT}/papercusp-relcut-0017-stable`, 1),
      ],
      { canonicalPath: CANONICAL, coveredPaths: [] },
    );
    expect(out).toEqual([]);
  });

  it('flags a LONG-stale tree just the same — staleness is not part of the verdict', () => {
    // The ~70-day-dirty trees are the cases an age floor would have hidden; nothing will
    // ever commit them either. (This once used the real papercup-improvement-runner and
    // papercusp-desktop paths as the illustration; both have since been triaged under
    // WI-38888 and carry per-checkout scope-outs, so a generic stale path is used here —
    // the property being asserted is age-independence, not those particular names.)
    const out = findUncoveredDirtyCheckouts(
      [co(`${WS_ROOT}/long-stale-clone`, 22, 1_600_000_000), co(`${WS_ROOT}/fresh-clone`, 2, null)],
      { canonicalPath: CANONICAL, coveredPaths: [] },
    );
    expect(out.map((c) => c.path).sort()).toEqual([`${WS_ROOT}/fresh-clone`, `${WS_ROOT}/long-stale-clone`]);
  });
});

describe('listSiblingCheckoutsWithDirtyState', () => {
  const runGit = (topLevels: Record<string, string>, status: Record<string, string>) =>
    vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'rev-parse') {
        const t = topLevels[cwd];
        if (!t) throw new Error('fatal: not a git repository');
        return `${t}\n`;
      }
      if (args[0] === 'status') return status[cwd] ?? '';
      if (args[0] === 'log') return '1700000000\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

  it('dedupes a SYMLINKED sibling so papercup->papercusp is not scanned twice', async () => {
    const real = `${WS_ROOT}/papercusp`;
    const out = await listSiblingCheckoutsWithDirtyState(WS_ROOT, {
      listChildDirs: async () => [`${WS_ROOT}/papercup`, real],
      realpath: async () => real,
      runGit: runGit({ [real]: real }, { [real]: ' M a.ts\n' }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe(real);
  });

  it('skips a directory that is not a checkout ROOT (a subdir of one)', async () => {
    const out = await listSiblingCheckoutsWithDirtyState(WS_ROOT, {
      listChildDirs: async () => [`${WS_ROOT}/papercusp-subdir`],
      realpath: async (p) => p,
      // rev-parse reports the PARENT as toplevel — this dir is inside a checkout, not one.
      runGit: runGit({ [`${WS_ROOT}/papercusp-subdir`]: `${WS_ROOT}/papercusp` }, {}),
    });
    expect(out).toEqual([]);
  });

  it('skips a non-git directory without failing the sweep', async () => {
    const out = await listSiblingCheckoutsWithDirtyState(WS_ROOT, {
      listChildDirs: async () => [`${WS_ROOT}/not-a-repo`, SIDESTAGE],
      realpath: async (p) => p,
      runGit: runGit({ [SIDESTAGE]: SIDESTAGE }, { [SIDESTAGE]: ' M x.ts\n M y.ts\n' }),
    });
    expect(out.map((c) => c.path)).toEqual([SIDESTAGE]);
    expect(out[0]?.dirtyFileCount).toBe(2);
  });
});

describe('checkGitSyncCoverage', () => {
  const baseDeps = {
    listChildDirs: async () => [SIDESTAGE],
    realpath: async (p: string) => p,
    pathExists: async () => true,
    runGit: vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'rev-parse') return `${cwd}\n`;
      if (args[0] === 'status') return ' M a.ts\n';
      if (args[0] === 'log') return '1700000000\n';
      if (args[0] === 'worktree') return `worktree ${CANONICAL}\n`;
      throw new Error('unexpected');
    }),
  };

  it('reports the uncovered sibling and logs it', async () => {
    const log = vi.fn();
    const res = await checkGitSyncCoverage(CANONICAL, {
      ...baseDeps,
      log,
      loadActiveGitSyncSlugs: async () => ['papercusp'],
      loadRegistryProjects: async () => [{ slug: 'papercusp', path: CANONICAL }],
    });
    expect(res.coverageResolved).toBe(true);
    expect(res.uncovered.map((c) => c.path)).toEqual([SIDESTAGE]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NO active git-sync routine'));
  });

  it('reports NOTHING and says so when the coverage set cannot be loaded', async () => {
    // The load-bearing safety property: without the authoritative signal every dirty
    // sibling looks uncovered, so guessing would emit confident false positives.
    const log = vi.fn();
    const res = await checkGitSyncCoverage(CANONICAL, {
      ...baseDeps,
      log,
      loadActiveGitSyncSlugs: async () => {
        throw new Error('PG down');
      },
      loadRegistryProjects: async () => [],
    });
    expect(res.coverageResolved).toBe(false);
    expect(res.uncovered).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NOT MEASURED'));
  });

  it('goes quiet when the sibling IS covered', async () => {
    const log = vi.fn();
    const res = await checkGitSyncCoverage(CANONICAL, {
      ...baseDeps,
      log,
      loadActiveGitSyncSlugs: async () => ['sidestage'],
      loadRegistryProjects: async () => [{ slug: 'sidestage', path: SIDESTAGE }],
    });
    expect(res.uncovered).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('never throws — a detector must not be able to crash the host it watches', async () => {
    const res = await checkGitSyncCoverage(CANONICAL, {
      log: vi.fn(),
      listChildDirs: async () => {
        throw new Error('readdir exploded');
      },
      loadActiveGitSyncSlugs: async () => [],
      loadRegistryProjects: async () => [],
      pathExists: async () => true,
    });
    expect(res.uncovered).toEqual([]);
    expect(res.coverageResolved).toBe(false);
  });
});

describe('triaged per-checkout scope-outs (WI-38888)', () => {
  const scoped: TriagedCheckoutScopeOut[] = [
    {
      pattern: /\/triaged-clone$/,
      reason: 'test fixture: dirty content verified superseded upstream',
      triagedAt: '2026-08-15',
      workItem: 'WI-38888',
      dirtyFileCountAtTriage: 3,
    },
  ];

  it('suppresses a triaged checkout while its dirty set is UNCHANGED', () => {
    const out = findUncoveredDirtyCheckouts([co(`${WS_ROOT}/triaged-clone`, 3)], {
      canonicalPath: CANONICAL,
      coveredPaths: [],
      scopeOuts: scoped,
    });
    expect(out).toEqual([]);
  });

  // The property the whole mechanism exists for: an exclusion that cannot expire is a
  // permanent blind spot, so the verdict is bound to the dirty set it was reached against.
  it('RE-ARMS when the dirty set drifts — new content the recorded verdict never saw', () => {
    const out = findUncoveredDirtyCheckouts([co(`${WS_ROOT}/triaged-clone`, 4)], {
      canonicalPath: CANONICAL,
      coveredPaths: [],
      scopeOuts: scoped,
    });
    expect(out.map((c) => c.path)).toEqual([`${WS_ROOT}/triaged-clone`]);
  });

  it('re-arms on a SHRINKING dirty set too (content changed, not just grew)', () => {
    const out = findUncoveredDirtyCheckouts([co(`${WS_ROOT}/triaged-clone`, 1)], {
      canonicalPath: CANONICAL,
      coveredPaths: [],
      scopeOuts: scoped,
    });
    expect(out).toHaveLength(1);
  });

  it('matchTriagedScopeOut reports the drift verdict, and null for an untriaged path', () => {
    expect(matchTriagedScopeOut(`${WS_ROOT}/triaged-clone`, 3, scoped)?.drifted).toBe(false);
    expect(matchTriagedScopeOut(`${WS_ROOT}/triaged-clone`, 9, scoped)?.drifted).toBe(true);
    expect(matchTriagedScopeOut(`${WS_ROOT}/never-triaged`, 3, scoped)).toBeNull();
  });

  it('tolerates a trailing slash (readdir/worktree-list disagree about it)', () => {
    expect(matchTriagedScopeOut(`${WS_ROOT}/triaged-clone/`, 3, scoped)?.entry.workItem).toBe('WI-38888');
  });

  // A scope-out without a stated reason is the rot this mechanism is meant to prevent:
  // the next reader cannot tell a considered exclusion from a silenced alarm.
  it('every REAL registry entry carries a reason, a date, a work-item and a triage count', () => {
    expect(TRIAGED_CHECKOUT_SCOPE_OUTS.length).toBeGreaterThan(0);
    for (const entry of TRIAGED_CHECKOUT_SCOPE_OUTS) {
      expect(entry.reason.length, `${entry.pattern} needs a substantive reason`).toBeGreaterThan(80);
      expect(entry.triagedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.workItem).toMatch(/^(WI|EI|F)-\d+$/);
      expect(entry.dirtyFileCountAtTriage).toBeGreaterThan(0);
    }
  });

  // The Storewolf pair carries UNCOMMITTED SOURCE on the owner's personal remote and is an
  // open owner-gated question. Scoping it out would silence the one alarm still pointing at
  // real unbacked work — the exact opposite of what this mechanism is for.
  it('does NOT scope out the storewolf checkouts (open owner wall — must keep alarming)', () => {
    for (const name of ['Storewolf-Libs', 'storewolf-central-server']) {
      expect(matchTriagedScopeOut(`${WS_ROOT}/${name}`, 26), `${name} must still alarm`).toBeNull();
    }
  });

  // Control: proves the real registry's patterns are anchored, not substring-happy.
  it('real patterns do not match an unrelated sibling that merely shares a prefix', () => {
    expect(matchTriagedScopeOut(`${WS_ROOT}/papercusp-registry-experiments`, 2)).toBeNull();
    expect(matchTriagedScopeOut(`${WS_ROOT}/templates-mirror-backup`, 1)).toBeNull();
  });
});

// WI-10005446: the default runner must run git in the spawner sidecar, not fork the big host.
describe('runWatchdogGit (sidecar routing)', () => {
  const ARGS = ['status', '--porcelain'];
  const CWD = '/repo';

  function seams(over: WatchdogGitSeams = {}) {
    const local = vi.fn(async () => 'local-out');
    const onFallback = vi.fn();
    return { local, onFallback, sidecarEnabled: () => true, ...over };
  }

  it('runs git in the sidecar and never forks locally when the sidecar answers', async () => {
    const viaSidecar = vi.fn(async () => ({ code: 0, stdout: ' M a.ts\n', stderr: '' }));
    const s = seams({ viaSidecar });
    await expect(runWatchdogGit(ARGS, CWD, s)).resolves.toBe(' M a.ts\n');
    expect(viaSidecar).toHaveBeenCalledWith(
      ARGS,
      CWD,
      30_000,
      expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
    );
    expect(s.local).not.toHaveBeenCalled();
    expect(s.onFallback).not.toHaveBeenCalled();
  });

  it('falls back to a local spawn when the sidecar is unreachable', async () => {
    const s = seams({ viaSidecar: vi.fn(async () => { throw new Error('circuit open'); }) });
    await expect(runWatchdogGit(ARGS, CWD, s)).resolves.toBe('local-out');
    expect(s.local).toHaveBeenCalledWith(
      ARGS,
      CWD,
      expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
    );
    expect(s.onFallback).toHaveBeenCalledTimes(1);
  });

  it("treats the sidecar's own infrastructure fault as a fallback, not as git's answer", async () => {
    const viaSidecar = vi.fn(async () => ({ code: -1, stdout: '', stderr: 'spawner sidecar could not spawn' }));
    const s = seams({ viaSidecar });
    await expect(runWatchdogGit(ARGS, CWD, s)).resolves.toBe('local-out');
    expect(s.onFallback).toHaveBeenCalledTimes(1);
  });

  it('rejects on a real non-zero git exit, like the local path, without re-running it locally', async () => {
    const viaSidecar = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository\n' }));
    const s = seams({ viaSidecar });
    await expect(runWatchdogGit(ARGS, CWD, s)).rejects.toThrow('fatal: not a git repository');
    expect(s.local).not.toHaveBeenCalled();
  });

  it('spawns locally when the sidecar is not enabled for this process', async () => {
    const viaSidecar = vi.fn();
    const s = seams({ viaSidecar, sidecarEnabled: () => false });
    await expect(runWatchdogGit(ARGS, CWD, s)).resolves.toBe('local-out');
    expect(viaSidecar).not.toHaveBeenCalled();
    expect(s.local).toHaveBeenCalledWith(
      ARGS,
      CWD,
      expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
    );
  });

  it('WIRING: the sibling-checkout pass sends its git calls to the sidecar when no runner is injected', async () => {
    // If defaultRunGit regressed to a raw local spawn, real git would run in the non-existent
    // /ws/a, the checkout would be skipped, and `out` would be [].
    sidecarGit.mockReset();
    sidecarGit.mockImplementation(async (args: string[], cwd: string) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${cwd}\n`, stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: ' M x.ts\n', stderr: '' };
      return { code: 0, stdout: '1790000000\n', stderr: '' };
    });
    try {
      const out = await listSiblingCheckoutsWithDirtyState('/ws', {
        listChildDirs: async () => ['/ws/a'],
        realpath: async (p: string) => p,
      });
      expect(out).toEqual([{ path: '/ws/a', dirty: true, dirtyFileCount: 1, lastCommitEpochSec: 1790000000 }]);
      expect(sidecarGit.mock.calls.map((c) => (c[0] as string[])[0])).toEqual(['rev-parse', 'status', 'log']);
    } finally {
      sidecarGit.mockReset();
    }
  });
});
