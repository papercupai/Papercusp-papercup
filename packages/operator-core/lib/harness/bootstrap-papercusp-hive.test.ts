import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// The canonical invite is now COMMITTED (P-003 activation), so bakedCanonicalHiveInvite()
// returns it by default — which would route every no-`canonicalInvite` test through the
// JOIN path. Mock the constant to null so the legacy clone+create-path tests still exercise
// the per-owner fallback; the P-005/P-006 tests pass `canonicalInvite` explicitly (explicit
// wins over the constant), so they are unaffected.
vi.mock('./canonical-hive-invite', () => ({
  CANONICAL_PAPERCUSP_HIVE_INVITE: null,
}));
vi.mock('../hive-store', () => ({
  getHiveByPubkey: vi.fn(async () => ({ homeSlug: 'papercusp' })),
}));
// Team allowlist moved to its own SERVER-ONLY module (WI-38322): co-locating it with the
// invite shipped the real team GitHub logins into the client bundle. Mocked separately here,
// still to [], preserving this suite's existing behaviour.
vi.mock('./canonical-hive-team-allowlist', () => ({ CANONICAL_HIVE_TEAM_ALLOWLIST: [] }));

import {
  bootstrapPapercuspHive,
  startBootstrapPapercuspHive,
  __resetBootstrapInFlight,
  seedTargetDirs,
  defaultSetHomeWorkspace,
  dogfoodHiveDisabled,
  PAPERCUP_DOGFOOD_REPO_URL,
  GIT_SEED_RETRY_DELAYS_MS,
  type BootstrapPapercuspHiveDeps,
} from './bootstrap-papercusp-hive';

beforeEach(() => __resetBootstrapInFlight());
import { join } from 'node:path';
import { PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';
import { workspacesRoot, isKnownWorkspace } from '../workspace-registry';

// WI-3232: the seed CORESTORE must restore to the SAME dir boot opens it, else the
// OFFLINE self-admit pot appears with EMPTY content (boot reads an empty corestore).
// Regression guard for the clones/-vs-papercusp-workspace/ mismatch (env-name confusion:
// seedTargetDirs used PAPERCUSP_WORKSPACE_ROOT, boot's workspacesRoot() reads the PLURAL).
describe('seedTargetDirs (WI-3232 corestore-dir parity)', () => {
  it("restores the corestore to boot's dir: <workspacesRoot>/<ws>/.papercusp/<slug>/hyperbee", () => {
    const { targetStoreDir } = seedTargetDirs();
    expect(targetStoreDir).toBe(
      join(workspacesRoot(), PAPERCUSP_WORKSPACE_ID, '.papercusp', PAPERCUSP_HIVE_SLUG, 'hyperbee'),
    );
    // Never the old clones/ dir boot never reads — that made the offline pot content-empty.
    expect(targetStoreDir).not.toContain(`${join(workspacesRoot(), 'clones')}`);
  });

  it('keeps the git checkout (targetRepoDir) under clones — a real code checkout', () => {
    expect(seedTargetDirs().targetRepoDir).toContain(join('clones', PAPERCUSP_HIVE_SLUG));
  });
});

/** Build a deps object whose seams are all spies, overridable per-case. */
function spyDeps(over: Partial<BootstrapPapercuspHiveDeps> = {}) {
  const deps = {
    detectRoot: vi.fn(() => null as string | null),
    loadRegistry: vi.fn(async () => ({ projects: [] as Array<{ slug: string }> })),
    clone: vi.fn(async () => ({
      path: '/clones/papercusp',
      parsed: { owner: 'Papercusp', repo: 'papercup', cloneUrl: 'https://github.com/Papercusp/papercup.git' },
    })),
    ensureHive: vi.fn(async (_opts?: { pathOverride?: string }) => ({
      state: 'newly-created' as const,
      slug: PAPERCUSP_HIVE_SLUG,
    })),
    setHomeWorkspace: vi.fn(),
    ensureWorkspaceListed: vi.fn(),
    bootActiveWorkspace: vi.fn(async () => ({ attempted: 1, booted: 1, alreadyBooted: 0, failed: 0 })),
    initSubmodules: vi.fn(),
    recordProgress: vi.fn(),
    adoptShare: vi.fn(async () => null),
    goShare: vi.fn(async () => undefined),
    shareExisting: vi.fn(async () => undefined),
    submodulesNeedUpdate: vi.fn(async () => false),
    ...over,
  };
  return deps as unknown as BootstrapPapercuspHiveDeps & typeof deps;
}

describe('bootstrapPapercuspHive — clone-on-first-boot dogfood hive', () => {
  it('no-ops + homes when the papercusp hive already exists with complete submodules (idempotent)', async () => {
    const deps = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.ensureHive).not.toHaveBeenCalled();
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.submodulesNeedUpdate).toHaveBeenCalledWith('/clones/papercusp');
    expect(deps.initSubmodules).not.toHaveBeenCalled();
    expect(deps.shareExisting).toHaveBeenCalledOnce();
  });

  it('existing hive with uninitialized submodules resumes the submodule phase', async () => {
    const events: string[] = [];
    const deps = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
      submodulesNeedUpdate: vi.fn(async () => true),
      recordProgress: vi.fn((step, status, extra) =>
        events.push(`${step}:${status}${extra?.percent != null ? `@${extra.percent}` : ''}`),
      ),
      initSubmodules: vi.fn((_root, opts) => {
        opts?.onProgress?.(3, 27);
        opts?.onDone?.(true);
      }),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.ensureHive).not.toHaveBeenCalled();
    expect(deps.initSubmodules).toHaveBeenCalledWith('/clones/papercusp', expect.any(Object));
    expect(events).toContain('clone:done');
    expect(events).toContain('submodules:running@0');
    expect(events).toContain('submodules:running@11');
    expect(events).toContain('submodules:done');
  });

  it('uses a LOCAL checkout in place — never clones (dev box)', async () => {
    const deps = spyDeps({ detectRoot: vi.fn(() => '/home/dev/papercup') });
    const res = await bootstrapPapercuspHive(deps);
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.ensureHive).toHaveBeenCalledWith({ pathOverride: '/home/dev/papercup' });
    expect(deps.initSubmodules).not.toHaveBeenCalled(); // not a fresh clone
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.adoptShare).toHaveBeenCalledOnce();
    expect(deps.goShare).toHaveBeenCalledWith(null);
    expect(res.state).toBe('newly-created');
  });

  it('CLONES the dogfood repo on a packaged install, then creates + homes + inits submodules', async () => {
    const deps = spyDeps();
    const res = await bootstrapPapercuspHive(deps);
    expect(deps.clone).toHaveBeenCalledWith(
      PAPERCUP_DOGFOOD_REPO_URL,
      expect.objectContaining({ destName: PAPERCUSP_HIVE_SLUG }),
    );
    expect(deps.ensureHive).toHaveBeenCalledWith({ pathOverride: '/clones/papercusp' });
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.initSubmodules).toHaveBeenCalledWith('/clones/papercusp', expect.any(Object));
    expect(res.state).toBe('cloned-and-created');
    expect(res.path).toBe('/clones/papercusp');
  });

  // WI-1423: fresh .deb test-rig frames (Hetzner brief-3/4) auto-wired into the
  // PRODUCTION papercusp hive at boot with no way to opt out. This is the hard,
  // synchronous, flag-independent kill-switch — see dogfoodHiveDisabled() for the
  // full rationale (it closes the gap the ingest-retrigger flag check alone can't,
  // since it must work even before the flag store is reachable).
  describe('WI-1423 dogfoodHiveDisabled() test-frame kill-switch', () => {
    it('unset ⇒ false (dogfood bootstrap proceeds normally)', () => {
      expect(dogfoodHiveDisabled({})).toBe(false);
    });

    it('PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 ⇒ true', () => {
      expect(dogfoodHiveDisabled({ PAPERCUSP_DISABLE_DOGFOOD_HIVE: '1' })).toBe(true);
    });

    it('any other value (e.g. "true", "0") ⇒ false — only the literal "1" disables', () => {
      expect(dogfoodHiveDisabled({ PAPERCUSP_DISABLE_DOGFOOD_HIVE: 'true' })).toBe(false);
      expect(dogfoodHiveDisabled({ PAPERCUSP_DISABLE_DOGFOOD_HIVE: '0' })).toBe(false);
    });

    it('bootstrapPapercuspHive short-circuits BEFORE any network/registry call when disabled', async () => {
      const prev = process.env.PAPERCUSP_DISABLE_DOGFOOD_HIVE;
      process.env.PAPERCUSP_DISABLE_DOGFOOD_HIVE = '1';
      try {
        const deps = spyDeps();
        const res = await bootstrapPapercuspHive(deps);
        expect(res).toEqual({
          state: 'skipped',
          slug: null,
          reason: 'dogfood hive disabled (PAPERCUSP_DISABLE_DOGFOOD_HIVE=1)',
        });
        expect(deps.loadRegistry).not.toHaveBeenCalled();
        expect(deps.clone).not.toHaveBeenCalled();
        expect(deps.ensureHive).not.toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env.PAPERCUSP_DISABLE_DOGFOOD_HIVE;
        else process.env.PAPERCUSP_DISABLE_DOGFOOD_HIVE = prev;
      }
    });
  });

  it('P-005 latch: already joined the canonical hive (hives row keyed on the baked pubkey) → already-present, NO re-join', async () => {
    const joinCanonical = vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp' }));
    const findJoinedCanonical = vi.fn(async () => ({ slug: 'papercusp' }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical,
      joinCanonical,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(res.slug).toBe('papercusp');
    // The expensive ~25s confirm+join is skipped once we've already joined.
    expect(joinCanonical).not.toHaveBeenCalled();
    expect(findJoinedCanonical).toHaveBeenCalledWith('CANON_PUB');
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.clone).not.toHaveBeenCalled();
  });

  it('P-005 repair: an incomplete remote view does not trip the canonical latch', async () => {
    const loadRegistry = vi.fn(async () => ({
      projects: [
        {
          slug: PAPERCUSP_HIVE_SLUG,
          path: '/remote-hives/papercusp',
          remote_hive: true,
          hive_pubkey: 'CANON_PUB',
          // owner_device_pubkey is intentionally absent: this is the pre-fix view.
        },
      ],
    }));
    const joinCanonical = vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp' }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      loadRegistry,
      joinCanonical,
    });

    const res = await bootstrapPapercuspHive(deps);

    expect(res.state).toBe('cloned-and-created');
    expect(joinCanonical).toHaveBeenCalledOnce();
    expect(loadRegistry).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID, { fresh: true });
  });

  it('P-006: bootstrap dispatches to the JOIN path on a baked invite (joined → cloned-and-created)', async () => {
    const joinCanonical = vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' }));
    const findJoinedCanonical = vi.fn(async () => null);
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical,
      joinCanonical,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created');
    expect(res.slug).toBe('papercusp-view');
    expect(joinCanonical).toHaveBeenCalledOnce();
    expect(deps.clone).not.toHaveBeenCalled(); // JOIN path, never the per-owner clone+create
    expect(deps.ensureHive).not.toHaveBeenCalled();
  });

  it('P-007: restore-before-join runs the seed restore BEFORE joinCanonical', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const restoreSeed = vi.fn(async () => {
      order.push('restore');
      return { ran: true, outcomes: [{ kind: 'corestore', ok: true }], deferred: ['git'] };
    });
    const joinCanonical = vi.fn(async () => {
      order.push('join');
      return { state: 'joined' as const, slug: 'papercusp-view' };
    });
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      restoreSeed,
      joinCanonical,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created');
    expect(restoreSeed).toHaveBeenCalledOnce();
    expect(joinCanonical).toHaveBeenCalledOnce();
    expect(order).toEqual(['restore', 'join']); // restore STRICTLY before the (unchanged) join
    // The boot log summarizes what restored vs deferred (diagnostic, like clone logging).
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/seed restore: restored=\[corestore\] deferred=\[git\]/));
    warn.mockRestore();
  });

  it('P-007: a restore failure is non-fatal — the join still runs (cold path)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const joinCanonical = vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' }));
    const restoreSeed = vi.fn(async () => {
      throw new Error('seed dir corrupt');
    });
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      restoreSeed,
      joinCanonical,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created'); // restore threw, join still succeeded
    expect(joinCanonical).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/seed restore failed \(non-fatal; cold path\)/));
    warn.mockRestore();
  });

  it('P-010: post-admission git-restore runs AFTER a successful join when the pre-join restore deferred git', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const restoreSeed = vi.fn(async () => {
      order.push('restore');
      return { ran: true, outcomes: [{ kind: 'corestore', ok: true }], deferred: ['git'] };
    });
    const joinCanonical = vi.fn(async () => {
      order.push('join');
      return { state: 'joined' as const, slug: 'papercusp-view' };
    });
    const restoreDeferredGitSeed = vi.fn(async () => {
      order.push('post-admission');
      return { ran: true, restored: ['git'], stillDeferred: [] };
    });
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      restoreSeed,
      joinCanonical,
      restoreDeferredGitSeed,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created');
    expect(restoreDeferredGitSeed).toHaveBeenCalledOnce();
    // Strict order: pre-position, THEN join (admission delivers the key), THEN restore git.
    expect(order).toEqual(['restore', 'join', 'post-admission']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/post-admission seed restore: restored=\[git\]/));
    warn.mockRestore();
  });

  it('P-010: post-admission restore is SKIPPED when nothing was deferred', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restoreSeed = vi.fn(async () => ({
      ran: true,
      outcomes: [
        { kind: 'corestore', ok: true },
        { kind: 'git', ok: true },
      ],
      deferred: [],
    }));
    const restoreDeferredGitSeed = vi.fn(async () => ({ ran: true, restored: ['git'], stillDeferred: [] }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      restoreSeed,
      joinCanonical: vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' })),
      restoreDeferredGitSeed,
    });
    await bootstrapPapercuspHive(deps);
    expect(restoreDeferredGitSeed).not.toHaveBeenCalled(); // an unencrypted seed restored git pre-join
    warn.mockRestore();
  });

  it('P-010: post-admission restore is SKIPPED when the join did NOT succeed and no seed ran', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restoreSeed = vi.fn(async () => ({ ran: false, outcomes: [], deferred: [] }));
    const restoreDeferredGitSeed = vi.fn(async () => ({ ran: true, restored: ['git'], stillDeferred: [] }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      restoreSeed,
      joinCanonical: vi.fn(async () => ({ state: 'skipped' as const, slug: null, reason: 'owner offline' })),
      restoreDeferredGitSeed,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(restoreDeferredGitSeed).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('P-010: a post-admission restore failure is non-fatal — the join result still stands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restoreSeed = vi.fn(async () => ({
      ran: true,
      outcomes: [{ kind: 'corestore', ok: true }],
      deferred: ['git'],
    }));
    const restoreDeferredGitSeed = vi.fn(async () => {
      throw new Error('epoch key unwrap blew up');
    });
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      restoreSeed,
      joinCanonical: vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' })),
      restoreDeferredGitSeed,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created'); // post-admission restore threw; join result unaffected
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/post-admission git seed restore failed \(non-fatal; cold clone\)/),
    );
    warn.mockRestore();
  });

  it('WI-3070: schedules a background retry when the first post-admission attempt still reports stillDeferred=[git]', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restoreSeed = vi.fn(async () => ({
      ran: true,
      outcomes: [{ kind: 'corestore', ok: true }],
      deferred: ['git'],
    }));
    const restoreDeferredGitSeed = vi.fn(async () => ({ ran: true, restored: [], stillDeferred: ['git'] }));
    const scheduleGitSeedRetry = vi.fn();
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      restoreSeed,
      joinCanonical: vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' })),
      restoreDeferredGitSeed,
      scheduleGitSeedRetry,
    });
    await bootstrapPapercuspHive(deps);
    expect(scheduleGitSeedRetry).toHaveBeenCalledOnce();
    // The scheduled retry closure re-invokes the SAME restoreDeferredGitSeed seam (bound to
    // the same `record`) — proving the retry can actually make forward progress, not just a
    // no-op closure.
    const [, retryFn] = scheduleGitSeedRetry.mock.calls[0] as [unknown, () => Promise<unknown>];
    expect(restoreDeferredGitSeed).toHaveBeenCalledOnce();
    await retryFn();
    expect(restoreDeferredGitSeed).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('WI-3070: does NOT schedule a retry when the first post-admission attempt already restored git', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restoreSeed = vi.fn(async () => ({
      ran: true,
      outcomes: [{ kind: 'corestore', ok: true }],
      deferred: ['git'],
    }));
    const restoreDeferredGitSeed = vi.fn(async () => ({ ran: true, restored: ['git'], stillDeferred: [] }));
    const scheduleGitSeedRetry = vi.fn();
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      restoreSeed,
      joinCanonical: vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' })),
      restoreDeferredGitSeed,
      scheduleGitSeedRetry,
    });
    await bootstrapPapercuspHive(deps);
    expect(scheduleGitSeedRetry).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('WI-3070: the REAL default retry succeeds on a later attempt once the epoch key has landed, then stops', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let call = 0;
      const restoreDeferredGitSeed = vi.fn(async () => {
        call += 1;
        if (call === 1) return { ran: true, restored: [], stillDeferred: ['git'] };
        if (call === 2) return { ran: true, restored: ['git'], stillDeferred: [] };
        throw new Error('must not be called again once restored');
      });
      const restoreSeed = vi.fn(async () => ({
        ran: true,
        outcomes: [{ kind: 'corestore', ok: true }],
        deferred: ['git'],
      }));
      const deps = spyDeps({
        canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
        findJoinedCanonical: vi.fn(async () => null),
        restoreSeed,
        joinCanonical: vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' })),
        restoreDeferredGitSeed,
        // scheduleGitSeedRetry intentionally NOT overridden — exercises the real default.
      });
      await bootstrapPapercuspHive(deps);
      expect(restoreDeferredGitSeed).toHaveBeenCalledTimes(1); // only the immediate attempt so far

      await vi.advanceTimersByTimeAsync(GIT_SEED_RETRY_DELAYS_MS[0]!);
      expect(restoreDeferredGitSeed).toHaveBeenCalledTimes(2); // the first background retry succeeded

      // Advancing past every remaining delay must NOT produce a 3rd call (already stopped).
      const rest = GIT_SEED_RETRY_DELAYS_MS.slice(1).reduce((a, b) => a + b, 0);
      await vi.advanceTimersByTimeAsync(rest);
      expect(restoreDeferredGitSeed).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('WI-3070: the REAL default retry gives up after exhausting every bounded attempt (never hangs forever)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const restoreDeferredGitSeed = vi.fn(async () => ({ ran: true, restored: [], stillDeferred: ['git'] }));
      const restoreSeed = vi.fn(async () => ({
        ran: true,
        outcomes: [{ kind: 'corestore', ok: true }],
        deferred: ['git'],
      }));
      const deps = spyDeps({
        canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
        findJoinedCanonical: vi.fn(async () => null),
        restoreSeed,
        joinCanonical: vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' })),
        restoreDeferredGitSeed,
      });
      await bootstrapPapercuspHive(deps);
      expect(restoreDeferredGitSeed).toHaveBeenCalledTimes(1);

      const total = GIT_SEED_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
      await vi.advanceTimersByTimeAsync(total);
      // 1 immediate attempt + one retry per scheduled delay, never more.
      expect(restoreDeferredGitSeed).toHaveBeenCalledTimes(1 + GIT_SEED_RETRY_DELAYS_MS.length);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gave up after retries/));

      // No further attempts even after MORE time passes — the loop has genuinely ended.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(restoreDeferredGitSeed).toHaveBeenCalledTimes(1 + GIT_SEED_RETRY_DELAYS_MS.length);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('P-006: a join SKIP propagates as skipped (next-boot retry) — never falls through to clone+create', async () => {
    const joinCanonical = vi.fn(async () => ({
      state: 'skipped' as const,
      slug: null,
      reason: 'canonical hive not announcing yet (owner offline)',
    }));
    const findJoinedCanonical = vi.fn(async () => null);
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical,
      joinCanonical,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/not announcing yet/);
    expect(joinCanonical).toHaveBeenCalledOnce();
    expect(deps.ensureHive).not.toHaveBeenCalled();
  });

  it('WI-3232: when canonical join skips offline but a bundled seed restored, self-admits locally', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const joinCanonical = vi.fn(async () => ({
      state: 'skipped' as const,
      slug: null,
      reason: 'canonical hive not announcing yet (owner offline)',
    }));
    const restoreSeed = vi.fn(async () => ({
      ran: true,
      outcomes: [{ kind: 'corestore', ok: true }],
      deferred: ['git'],
    }));
    const restoreDeferredGitSeed = vi.fn(async () => ({ ran: true, restored: ['git'], stillDeferred: [] }));
    const selfAdmitCanonical = vi.fn(async () => ({
      state: 'admitted' as const,
      slug: PAPERCUSP_HIVE_SLUG,
      path: '/clones/papercusp',
    }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      joinCanonical,
      restoreSeed,
      restoreDeferredGitSeed,
      selfAdmitCanonical,
    });

    const res = await bootstrapPapercuspHive(deps);

    expect(res).toMatchObject({ state: 'cloned-and-created', slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' });
    expect(restoreSeed).toHaveBeenCalledOnce();
    expect(restoreDeferredGitSeed).toHaveBeenCalledOnce();
    expect(selfAdmitCanonical).toHaveBeenCalledWith(
      { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      expect.any(Function),
    );
    expect(deps.ensureHive).not.toHaveBeenCalled();
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    // WI-3288: self-admit must also LIST the workspace, not just home it.
    expect(deps.ensureWorkspaceListed).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('WI-3288: offline self-admit LISTS papercusp-workspace (not just homes it) so /api/workspaces is not empty', async () => {
    // The bug: self-admit registered the pot (harness_registry + hives) and set registry.current
    // via setHome, but never added papercusp-workspace to registry.json workspaces[] → current
    // pointed at an UNLISTED workspace → /api/workspaces returned {workspaces:[]} → the dogfood
    // pot was invisible in the UI despite being fully restored on disk. The fix calls the
    // workspace-lister (ensurePapercuspWorkspace) in the self-admit success path.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      joinCanonical: vi.fn(async () => ({ state: 'skipped' as const, slug: null, reason: 'owner offline' })),
      restoreSeed: vi.fn(async () => ({ ran: true, outcomes: [{ kind: 'corestore', ok: true }], deferred: ['git'] })),
      restoreDeferredGitSeed: vi.fn(async () => ({ ran: true, restored: ['git'], stillDeferred: [] })),
      selfAdmitCanonical: vi.fn(async () => ({
        state: 'admitted' as const,
        slug: PAPERCUSP_HIVE_SLUG,
        path: '/clones/papercusp',
      })),
    });

    const res = await bootstrapPapercuspHive(deps);

    expect(res).toMatchObject({ state: 'cloned-and-created', slug: PAPERCUSP_HIVE_SLUG });
    expect(deps.ensureWorkspaceListed).toHaveBeenCalled(); // the regression guard for WI-3288
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    warn.mockRestore();
  });

  it('WI-3232 regression: NEVER self-admits over an owner self_repo checkout (git-sync-freeze guard)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The exact fleet-wide-freeze race (2026-07-06): step-1's CACHED registry read misses the
    // papercusp entry (so we fall through to the offline self-admit branch), but the branch's
    // FRESH read sees the owner's self_repo checkout. Self-admitting here would merge
    // remote_hive:true onto that entry → git-sync marks it "ineligible (remote_hive_view)" and
    // STOPS committing the whole shared tree. The guard must bail and home the checkout instead.
    const loadRegistry = vi.fn(async (_ws: string, opts?: { fresh?: boolean }) =>
      opts?.fresh
        ? { projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/home/dev/papercusp', self_repo: true }] }
        : { projects: [] as Array<{ slug: string }> },
    );
    const joinCanonical = vi.fn(async () => ({
      state: 'skipped' as const,
      slug: null,
      reason: 'canonical hive not announcing yet (owner offline)',
    }));
    const restoreSeed = vi.fn(async () => ({
      ran: true,
      outcomes: [{ kind: 'corestore', ok: true }],
      deferred: ['git'],
    }));
    const restoreDeferredGitSeed = vi.fn(async () => ({ ran: true, restored: ['git'], stillDeferred: [] }));
    const selfAdmitCanonical = vi.fn(async () => ({ state: 'admitted' as const, slug: PAPERCUSP_HIVE_SLUG }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      loadRegistry,
      joinCanonical,
      restoreSeed,
      restoreDeferredGitSeed,
      selfAdmitCanonical,
    });

    const res = await bootstrapPapercuspHive(deps);

    expect(res).toMatchObject({ state: 'already-present', slug: PAPERCUSP_HIVE_SLUG, path: '/home/dev/papercusp' });
    expect(loadRegistry).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID, { fresh: true });
    expect(selfAdmitCanonical).not.toHaveBeenCalled(); // never clobbers the self_repo owner entry
    expect(restoreDeferredGitSeed).not.toHaveBeenCalled(); // guard returns before the git restore
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    warn.mockRestore();
  });

  it('WI-5165: a peer process\'s SELF-ADMITTED entry (self_repo + remote_hive) does NOT trip the owner-checkout guard — re-admit proceeds so THIS process boots the substrate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The packaged-install race (0.0.12 clean-VM repro): a request-only env sidecar won the
    // self-admit race and registered {self_repo:true, remote_hive:true} (EI-8793 stamps
    // self_repo on the canonical clone) but was FORBIDDEN from booting the substrate; the
    // main operator's fresh read then saw self_repo, took the guard, and nobody ever booted —
    // the restored 855MB corestore never merged and the pot shipped as an empty shell. The
    // guard must only protect the owner dev checkout: self_repo WITHOUT remote_hive.
    const loadRegistry = vi.fn(async (_ws: string, opts?: { fresh?: boolean }) =>
      opts?.fresh
        ? {
            projects: [
              {
                slug: PAPERCUSP_HIVE_SLUG,
                path: '/installs/clones/papercusp',
                self_repo: true,
                remote_hive: true,
              },
            ],
          }
        : { projects: [] as Array<{ slug: string }> },
    );
    const selfAdmitCanonical = vi.fn(async () => ({
      state: 'admitted' as const,
      slug: PAPERCUSP_HIVE_SLUG,
      path: '/installs/clones/papercusp',
    }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      loadRegistry,
      joinCanonical: vi.fn(async () => ({ state: 'skipped' as const, slug: null, reason: 'owner offline' })),
      restoreSeed: vi.fn(async () => ({ ran: true, outcomes: [{ kind: 'corestore', ok: true }], deferred: ['git'] })),
      restoreDeferredGitSeed: vi.fn(async () => ({ ran: true, restored: ['git'], stillDeferred: [] })),
      selfAdmitCanonical,
    });

    const res = await bootstrapPapercuspHive(deps);

    expect(res).toMatchObject({ state: 'cloned-and-created', slug: PAPERCUSP_HIVE_SLUG });
    expect(selfAdmitCanonical).toHaveBeenCalledOnce(); // idempotent re-admit — NOT skipped
    expect(deps.bootActiveWorkspace).toHaveBeenCalledOnce(); // the substrate boots in THIS process
    warn.mockRestore();
  });

  it('WI-5165: step-1 already-present on a remote_hive entry RE-RUNS the startup boot-all ("present" ≠ "booted")', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Same race, later pass: the entry pre-exists (a peer self-admitted), so step-1
    // short-circuits — but this process's startup boot-all ran BEFORE the registration
    // existed, so nothing has opened the restored corestore. already-present must
    // best-effort re-run the (idempotent) boot-all for the remote_hive shape.
    const deps = spyDeps({
      loadRegistry: vi.fn(async () => ({
        projects: [
          { slug: PAPERCUSP_HIVE_SLUG, path: '/installs/clones/papercusp', self_repo: true, remote_hive: true },
        ],
      })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.bootActiveWorkspace).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('WI-5165: step-1 already-present on an OWNER checkout (no remote_hive) leaves the substrate to the startup boot-all', async () => {
    const deps = spyDeps({
      loadRegistry: vi.fn(async () => ({
        projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/home/dev/papercusp', self_repo: true }],
      })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.bootActiveWorkspace).not.toHaveBeenCalled();
  });

  it('WI-3232: git seed still deferred offline STILL self-admits (data-only) + schedules a code back-fill retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const joinCanonical = vi.fn(async () => ({
      state: 'skipped' as const,
      slug: null,
      reason: 'canonical hive not announcing yet (owner offline)',
    }));
    const restoreSeed = vi.fn(async () => ({
      ran: true,
      outcomes: [{ kind: 'corestore', ok: true }],
      deferred: ['git'],
    }));
    // The offline reality bf97d hit: the encrypted git (code) half cannot decrypt yet — but the
    // pot's DATA is in the already-restored corestore, so the pot must still appear.
    const restoreDeferredGitSeed = vi.fn(async () => ({ ran: true, restored: [], stillDeferred: ['git'] }));
    const scheduleGitSeedRetry = vi.fn();
    const selfAdmitCanonical = vi.fn(async () => ({
      state: 'admitted' as const,
      slug: PAPERCUSP_HIVE_SLUG,
      path: '/clones/papercusp',
    }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      joinCanonical,
      restoreSeed,
      restoreDeferredGitSeed,
      scheduleGitSeedRetry,
      selfAdmitCanonical,
    });

    const res = await bootstrapPapercuspHive(deps);

    // Pot APPEARS offline (self-admit ran) even though the git/code half stayed deferred.
    expect(res).toMatchObject({ state: 'cloned-and-created', slug: PAPERCUSP_HIVE_SLUG });
    expect(selfAdmitCanonical).toHaveBeenCalledOnce();
    // The git restore now runs in the BACKGROUND after self-admit (WI-6554700010011908), so
    // its still-deferred hand-off to the bounded retry lands a microtask after the return.
    await vi.waitFor(() => expect(scheduleGitSeedRetry).toHaveBeenCalledOnce()); // code checkout back-fills in the background
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.bootActiveWorkspace).toHaveBeenCalledOnce(); // pot booted LIVE via the full startup boot-all (WI-3232 first-boot ordering fix, replaces the no-op single rekeyHarness)
    warn.mockRestore();
  });

  it('WI-6554700010011908: a git restore that NEVER finishes does not hold back the offline self-admit (P-521 J8)', async () => {
    // Measured on the D-238 candidate: serve.log went silent right after
    // `seed restore: restored=[corestore] deferred=[git]` because self-admit awaited the
    // multi-GB git decrypt + clone, and the pot never appeared inside J8's window.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const restoreDeferredGitSeed = vi.fn(() => {
      order.push('git-restore-started');
      return new Promise<{ ran: boolean; restored: string[]; stillDeferred: string[] }>(() => {});
    });
    const selfAdmitCanonical = vi.fn(async () => {
      order.push('self-admit');
      return { state: 'admitted' as const, slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' };
    });
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      joinCanonical: vi.fn(async () => ({ state: 'skipped' as const, slug: null, reason: 'join awaiting GitHub sign-in' })),
      restoreSeed: vi.fn(async () => ({ ran: true, outcomes: [{ kind: 'corestore', ok: true }], deferred: ['git'] })),
      restoreDeferredGitSeed,
      scheduleGitSeedRetry: vi.fn(),
      selfAdmitCanonical,
    });

    const outcome = await Promise.race([
      bootstrapPapercuspHive(deps),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
    ]);

    expect(outcome).not.toBe('hung');
    expect(outcome).toMatchObject({ state: 'cloned-and-created', slug: PAPERCUSP_HIVE_SLUG });
    expect(deps.bootActiveWorkspace).toHaveBeenCalledOnce();
    // The code half still starts — after the pot is admitted, never before it.
    expect(restoreDeferredGitSeed).toHaveBeenCalledOnce();
    expect(order).toEqual(['self-admit', 'git-restore-started']);
    warn.mockRestore();
  });

  it('no-ops on auth_required (gh not signed in) — leaves home untouched so the next boot retries', async () => {
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'auth_required' as const, message: 'Authentication failed' })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/auth_required/);
    expect(deps.ensureHive).not.toHaveBeenCalled();
    expect(deps.setHomeWorkspace).not.toHaveBeenCalled();
  });

  it('adopts an existing clone dir (dest_exists) instead of refusing', async () => {
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'dest_exists' as const, message: 'already exists' })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created');
    const arg = (deps.ensureHive as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      pathOverride?: string;
    };
    expect(arg.pathOverride).toMatch(/\/clones\/papercusp$/);
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
  });

  it('propagates an ensureHive skip without homing', async () => {
    const deps = spyDeps({
      detectRoot: vi.fn(() => '/repo'),
      ensureHive: vi.fn(async () => ({ state: 'skipped' as const, slug: null, reason: 'create_failed' })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(res.reason).toBe('create_failed');
    expect(deps.setHomeWorkspace).not.toHaveBeenCalled();
  });

  it('records the clone + submodules progress sequence for a fresh clone', async () => {
    const events: string[] = [];
    const deps = spyDeps({
      recordProgress: vi.fn((step, status, extra) =>
        events.push(`${step}:${status}${extra?.percent != null ? `@${extra.percent}` : ''}`),
      ),
      // Drive the submodule callbacks synchronously so we can assert recording.
      initSubmodules: vi.fn((_root, opts) => {
        opts?.onProgress?.(1, 4);
        opts?.onDone?.(true);
      }),
    });
    await bootstrapPapercuspHive(deps);
    expect(events).toContain('clone:running@0');
    expect(events).toContain('clone:done');
    expect(events).toContain('submodules:running@0');
    expect(events).toContain('submodules:running@25'); // 1/4 submodules
    expect(events).toContain('submodules:done');
  });

  it('records clone:done + submodules:skipped for a LOCAL checkout (no download)', async () => {
    const events: string[] = [];
    const deps = spyDeps({
      detectRoot: vi.fn(() => '/home/dev/papercup'),
      recordProgress: vi.fn((step, status) => events.push(`${step}:${status}`)),
    });
    await bootstrapPapercuspHive(deps);
    expect(events).toContain('clone:done');
    expect(events).toContain('submodules:skipped');
    expect(deps.initSubmodules).not.toHaveBeenCalled();
  });

  it('records clone:error and skips the submodule phase on a real clone failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: string[] = [];
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'not_found' as const, message: 'nope' })),
      recordProgress: vi.fn((step, status) => events.push(`${step}:${status}`)),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(events).toContain('clone:error');
    expect(events).not.toContain('submodules:running');
    // The real failure (code + message) is logged for diagnosis (EI / Mac-VM debugging).
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/clone failed: not_found/));
    warn.mockRestore();
  });

  it('records clone:error with detail network_timeout + releases (skipped) on a transient connect timeout (EI-3548)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows: Array<{ step: string; status: string; extra?: { detail?: string } }> = [];
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'network_timeout' as const, message: 'Connection timed out' })),
      recordProgress: vi.fn((step, status, extra) => rows.push({ step, status, extra })),
    });
    const res = await bootstrapPapercuspHive(deps);
    warn.mockRestore();
    // Skipped state → startBootstrap releases the single-flight latch so a retry re-runs.
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/network_timeout/);
    // The error row carries the network_timeout detail the UI keys off to auto-retry.
    const err = rows.find((r) => r.step === 'clone' && r.status === 'error');
    expect(err?.extra?.detail).toBe('network_timeout');
    expect(rows.some((r) => r.step === 'submodules')).toBe(false);
  });

  it('EI-3548: a throwing best-effort share (already-present path) does NOT fail setup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
      shareExisting: vi.fn(async () => {
        throw new Error('Connect Timeout Error (api.github.com:443)');
      }),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/shareExisting failed \(non-fatal\)/));
    warn.mockRestore();
  });

  it('EI-3548: a throwing adoptShare/goShare (create path) does NOT fail the clone+create', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = spyDeps({
      adoptShare: vi.fn(async () => {
        throw new Error('Connect Timeout Error (api.github.com:443)');
      }),
      goShare: vi.fn(async () => {
        throw new Error('Connect Timeout Error (api.github.com:443)');
      }),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created');
    expect(deps.ensureHive).toHaveBeenCalledOnce();
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/adoptShare failed/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/goShare failed \(non-fatal\)/));
    warn.mockRestore();
  });

  it('parks clone at 0% running (NOT error) with the sign-in prompt on auth_required', async () => {
    const rows: Array<{ step: string; status: string; extra?: { percent?: number; detail?: string } }> = [];
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'auth_required' as const, message: 'Authentication failed' })),
      recordProgress: vi.fn((step, status, extra) => rows.push({ step, status, extra })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/auth_required/);
    // NOT an error — a 0% running clone row carrying the sign-in prompt.
    expect(rows.some((r) => r.step === 'clone' && r.status === 'error')).toBe(false);
    const pending = rows.find(
      (r) => r.step === 'clone' && r.status === 'running' && /sign in to github/i.test(r.extra?.detail ?? ''),
    );
    expect(pending).toBeDefined();
    expect(pending!.extra?.percent).toBe(0);
    expect(rows.some((r) => r.step === 'submodules')).toBe(false);
  });

  it('pins the clone to PAPERCUP_DOGFOOD_REPO_REF (release pin) and is shallow by default', async () => {
    const prev = process.env.PAPERCUP_DOGFOOD_REPO_REF;
    process.env.PAPERCUP_DOGFOOD_REPO_REF = 'desktop-v0.0.2';
    try {
      const deps = spyDeps();
      await bootstrapPapercuspHive(deps);
      expect(deps.clone).toHaveBeenCalledWith(
        PAPERCUP_DOGFOOD_REPO_URL,
        expect.objectContaining({ ref: 'desktop-v0.0.2', shallow: true }),
      );
    } finally {
      if (prev === undefined) delete process.env.PAPERCUP_DOGFOOD_REPO_REF;
      else process.env.PAPERCUP_DOGFOOD_REPO_REF = prev;
    }
  });

  it('omits ref when no pin is baked (dev) — default branch, still shallow', async () => {
    const prev = process.env.PAPERCUP_DOGFOOD_REPO_REF;
    delete process.env.PAPERCUP_DOGFOOD_REPO_REF;
    try {
      const deps = spyDeps();
      await bootstrapPapercuspHive(deps);
      const opts = (deps.clone as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
        ref?: string;
        shallow?: boolean;
      };
      expect(opts.ref).toBeUndefined();
      expect(opts.shallow).toBe(true);
    } finally {
      if (prev !== undefined) process.env.PAPERCUP_DOGFOOD_REPO_REF = prev;
    }
  });
});

describe('startBootstrapPapercuspHive (single-flight)', () => {
  it('shares ONE run + the SAME progressId across concurrent triggers', async () => {
    let cloneCount = 0;
    const deps = spyDeps({
      clone: vi.fn(async () => {
        cloneCount += 1;
        return { path: '/clones/papercusp', parsed: { owner: 'Papercusp', repo: 'papercup', cloneUrl: 'x' } };
      }),
      initSubmodules: vi.fn(),
    });
    const a = startBootstrapPapercuspHive(deps);
    const b = startBootstrapPapercuspHive(deps);
    expect(a.progressId).toBe(b.progressId);
    expect(a.done).toBe(b.done); // same promise — not two clones
    await a.done;
    expect(cloneCount).toBe(1);
  });

  it('releases the latch on a skipped result so a later trigger retries', async () => {
    const failing = spyDeps({ clone: vi.fn(async () => ({ code: 'auth_required' as const, message: 'x' })) });
    const first = await startBootstrapPapercuspHive(failing).done;
    expect(first.state).toBe('skipped'); // gh not signed in yet

    // After gh auth, a second trigger actually clones (latch was released).
    const ok = spyDeps({ initSubmodules: vi.fn() });
    const second = await startBootstrapPapercuspHive(ok).done;
    expect(second.state).toBe('cloned-and-created');
    expect(ok.clone).toHaveBeenCalledTimes(1);
  });

  it('releases the latch when the background submodule phase fails so Retry can run again', async () => {
    const failing = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
      submodulesNeedUpdate: vi.fn(async () => true),
      initSubmodules: vi.fn((_root, opts) => {
        opts?.onDone?.(false);
      }),
    });
    const first = await startBootstrapPapercuspHive(failing).done;
    expect(first.state).toBe('already-present');
    expect(failing.initSubmodules).toHaveBeenCalledTimes(1);

    const retry = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
      submodulesNeedUpdate: vi.fn(async () => true),
      initSubmodules: vi.fn((_root, opts) => {
        opts?.onDone?.(true);
      }),
    });
    const second = await startBootstrapPapercuspHive(retry).done;
    expect(second.state).toBe('already-present');
    expect(retry.initSubmodules).toHaveBeenCalledTimes(1);
  });

  // P-539: a skip before the invite topic is joined (directory wiring stalled) can never be
  // re-triggered by the directory ingest — the canonical pot announces only on that topic —
  // so the process retries it itself instead of waiting for the next app start.
  type JoinFn = NonNullable<NonNullable<Parameters<typeof bootstrapPapercuspHive>[0]>['joinCanonical']>;
  const joinDeps = (joinCanonical: JoinFn) =>
    spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical: vi.fn(async () => null),
      joinCanonical,
      retryDelaysMs: [1_000, 2_000],
    });
  const stalled = {
    state: 'skipped' as const,
    slug: null,
    reason: 'hive directory wiring stalled: hive directory wiring timed out after 30000ms',
    retryable: true,
  };

  it('P-539: a retryable skip re-runs the join in-process on the backoff until it joins', async () => {
    vi.useFakeTimers();
    try {
      const joinCanonical = vi
        .fn<JoinFn>()
        .mockResolvedValueOnce(stalled)
        .mockResolvedValue({ state: 'joined' as const, slug: PAPERCUSP_HIVE_SLUG });
      const deps = joinDeps(joinCanonical);
      const first = await startBootstrapPapercuspHive(deps).done;
      expect(first).toMatchObject({ state: 'skipped', retryable: true });
      expect(joinCanonical).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(joinCanonical).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(joinCanonical).toHaveBeenCalledTimes(2);

      // Joined: the success is cached and no further retry is scheduled.
      const after = await startBootstrapPapercuspHive(deps).done;
      expect(after.state).toBe('cloned-and-created');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(joinCanonical).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('P-539: a non-retryable skip schedules nothing (the wizard or the ingest re-trigger owns it)', async () => {
    vi.useFakeTimers();
    try {
      const joinCanonical = vi.fn(async () => ({
        state: 'skipped' as const,
        slug: null,
        reason: 'canonical hive not announcing yet (owner offline)',
      }));
      const res = await startBootstrapPapercuspHive(joinDeps(joinCanonical)).done;
      expect(res.state).toBe('skipped');
      expect(res.retryable).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(joinCanonical).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('P-539: in-process retries are bounded by the backoff schedule, then give up loudly', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const joinCanonical = vi.fn(async () => stalled);
      await startBootstrapPapercuspHive(joinDeps(joinCanonical)).done;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // The first run plus one retry per scheduled delay, then nothing more.
      expect(joinCanonical).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('still not reachable after 2 in-process retries'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('defaultSetHomeWorkspace (registers before making current)', () => {
  // The packaged-Linux "Starting onboarding… forever" bug (2026-07-07): setting
  // registry.current to an UNLISTED id makes isKnownWorkspace(current) false. The
  // operator injects `current` as `__PAPERCUSP_WS__`, so the webview stamps
  // `x-papercusp-workspace: <current>` on EVERY /api fetch → the workspace-context
  // middleware 400s `unknown_workspace` → the whole /api surface dead-ends and
  // onboarding hangs. defaultSetHomeWorkspace must REGISTER the workspace (so it is
  // KNOWN) before/when it makes it current.
  const realRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pcusp-setHome-'));
    process.env.PAPERCUSP_WORKSPACES_ROOT = tmp;
    // Fresh-install shape: only `default` listed, current=default.
    writeFileSync(
      join(tmp, 'registry.json'),
      JSON.stringify({ current: 'default', workspaces: [{ id: 'default', name: 'Default', createdAt: 1 }] }),
    );
  });
  afterEach(() => {
    if (realRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
    else process.env.PAPERCUSP_WORKSPACES_ROOT = realRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('adds the workspace to workspaces[] AND sets current — so isKnownWorkspace(current) is true', () => {
    defaultSetHomeWorkspace(PAPERCUSP_WORKSPACE_ID);

    const reg = JSON.parse(readFileSync(join(tmp, 'registry.json'), 'utf8'));
    expect(reg.current).toBe(PAPERCUSP_WORKSPACE_ID);
    // The regression guard: current must be a LISTED workspace, never dangling.
    expect(reg.workspaces.map((w: { id: string }) => w.id)).toContain(PAPERCUSP_WORKSPACE_ID);
    expect(isKnownWorkspace(PAPERCUSP_WORKSPACE_ID)).toBe(true);
    // …and its data dir is provisioned (the switch() guard needs it).
    expect(existsSync(join(tmp, PAPERCUSP_WORKSPACE_ID))).toBe(true);
    // Pre-existing entries survive.
    expect(reg.workspaces.map((w: { id: string }) => w.id)).toContain('default');
  });

  it('is idempotent — a second call does not duplicate the entry', () => {
    defaultSetHomeWorkspace(PAPERCUSP_WORKSPACE_ID);
    defaultSetHomeWorkspace(PAPERCUSP_WORKSPACE_ID);
    const reg = JSON.parse(readFileSync(join(tmp, 'registry.json'), 'utf8'));
    expect(reg.workspaces.filter((w: { id: string }) => w.id === PAPERCUSP_WORKSPACE_ID)).toHaveLength(1);
  });
});
