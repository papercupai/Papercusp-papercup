/**
 * git-sync-reconcile — boot-time add-only backfill sweep
 * (git-sync-any-hive-2026-06-12 P-004).
 *
 * The walk + joiner detection are exercised against an injected fake spine;
 * one composition test runs the REAL `seedGitSyncRoutineForMember` (db-org
 * mocked, callable fake sql, a live temp-dir clone) to prove the reconcile
 * hands the spine exactly what it needs. No PG anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { ProjectEntry } from '../../harness-registry';

const upsertRoutineMock = vi.fn(async (_sql: unknown, input: Record<string, unknown>) => ({
  id: `rt_${input.installSlug}_${input.name}`,
  ...input,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  upsertRoutine: (...a: unknown[]) => upsertRoutineMock(a[0], a[1] as Record<string, unknown>),
  setRoutineActive: vi.fn(async () => true),
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached — inject sql in tests');
  },
}));

import {
  reconcileGitSyncRoutines,
  ensureGitSyncRoutinesReconciledOnce,
  __resetGitSyncReconcileForTests,
  type ReconcileGitSyncOpts,
} from './git-sync-reconcile';
import type { seedGitSyncRoutineForMember } from './git-sync-routine';
import { gitSyncCronForKey, GIT_SYNC_SEED_ACTIVE_CREATOR } from './git-sync-eligibility';

type SeedFn = typeof seedGitSyncRoutineForMember;

// Tagged-template callable — getGitSyncRoutine awaits `sql\`SELECT …\`` and
// expects rows; [] ⇒ "no existing routine row".
const sqlFake = ((..._a: unknown[]) => Promise.resolve([])) as unknown as Sql;

const papercup: ProjectEntry = { slug: 'papercup', path: '/work/papercup' };
const creatorHome: ProjectEntry = { slug: 'shop-hive', path: '/hives/shop-hive', harness_kind: 'hive' };
const joinerHome: ProjectEntry = {
  slug: 'far-hive',
  path: '/remote-hives/far-hive',
  harness_kind: 'hive',
  remote_hive: true,
};
const member = (slug: string, hive: string, over: Partial<ProjectEntry> = {}): ProjectEntry => ({
  slug,
  path: `/clones/${slug}`,
  hive_slug: hive,
  ...over,
});

function regOf(...projects: ProjectEntry[]): ReconcileGitSyncOpts['loadRegistry'] {
  return async () => ({ projects });
}

/** Fake spine: seeds everything, records every call. */
function fakeSeed(
  outcomeFor: (slug: string) => Awaited<ReturnType<SeedFn>> = () => ({
    seeded: true,
    active: true,
    push: true,
    pushReason: 'fake',
    cron: '0 0 * * * *',
  }),
) {
  const calls: Array<{ workspaceId: string; installSlug: string; entry: ProjectEntry; joinerSide?: boolean }> = [];
  const seed: SeedFn = async (opts) => {
    calls.push({ ...opts });
    return outcomeFor(opts.installSlug);
  };
  return { seed, calls };
}

beforeEach(() => {
  upsertRoutineMock.mockClear();
  __resetGitSyncReconcileForTests();
});

describe('reconcileGitSyncRoutines — scope + walk', () => {
  it('registration-only members never seed through the real spine after reconciliation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passive-reconcile-'));
    mkdirSync(join(dir, '.git'));
    try {
      const out = await reconcileGitSyncRoutines({
        workspaceId: 'ws-1', sql: sqlFake,
        loadRegistry: regOf(creatorHome, member('passive', 'shop-hive', {
          path: dir, registrationOnly: { commitSha: 'a'.repeat(40) },
        })),
      });
      expect(out).toEqual({ seeded: [], skipped: [{ slug: 'passive', reason: 'ineligible:registration_only' }], unseeded: [] });
      expect(upsertRoutineMock).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('seeds every missing hive member and reports the slugs', async () => {
    const { seed, calls } = fakeSeed();
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws-1',
      loadRegistry: regOf(papercup, creatorHome, member('shop', 'shop-hive'), member('warehouse', 'shop-hive')),
      seedMember: seed,
    });
    expect(out).toEqual({ seeded: ['shop', 'warehouse'], skipped: [], unseeded: [] });
    expect(calls.map((c) => c.installSlug)).toEqual(['shop', 'warehouse']);
    // every call carried the workspace + the member's own registry entry
    expect(calls[0]).toMatchObject({ workspaceId: 'ws-1', entry: { slug: 'shop', hive_slug: 'shop-hive' } });
  });

  it('papercup (no hive_slug) and hive homes are never visited — non-members appear in neither list', async () => {
    const { seed, calls } = fakeSeed();
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws-1',
      loadRegistry: regOf(papercup, creatorHome, joinerHome, member('shop', 'shop-hive')),
      seedMember: seed,
    });
    expect(calls.map((c) => c.installSlug)).toEqual(['shop']);
    const mentioned = [...out.seeded, ...out.skipped.map((s) => s.slug)];
    expect(mentioned).not.toContain('papercup');
    expect(mentioned).not.toContain('shop-hive');
    expect(mentioned).not.toContain('far-hive');
  });

  it('never mutates an existing row — the spine routine_exists skip maps to already_seeded', async () => {
    const { seed } = fakeSeed((slug) =>
      slug === 'shop'
        ? { seeded: false, reason: 'routine_exists' }
        : { seeded: true, active: true, push: true, pushReason: 'fake', cron: '0 0 * * * *' },
    );
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws-1',
      loadRegistry: regOf(creatorHome, member('shop', 'shop-hive'), member('warehouse', 'shop-hive')),
      seedMember: seed,
    });
    expect(out.seeded).toEqual(['warehouse']);
    expect(out.skipped).toEqual([{ slug: 'shop', reason: 'already_seeded' }]);
  });

  it('ineligible members skip with the eligibility reason', async () => {
    const { seed } = fakeSeed(() => ({
      seeded: false,
      reason: 'ineligible',
      ineligibleReason: 'not_a_git_repo',
    }));
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws-1',
      loadRegistry: regOf(creatorHome, member('shop', 'shop-hive')),
      seedMember: seed,
    });
    expect(out.seeded).toEqual([]);
    expect(out.skipped).toEqual([{ slug: 'shop', reason: 'ineligible:not_a_git_repo' }]);
  });

  it('a spine error folds into skipped and the sweep continues to later members', async () => {
    const { seed } = fakeSeed((slug) =>
      slug === 'shop'
        ? { seeded: false, reason: 'error', message: 'pg down' }
        : { seeded: true, active: true, push: true, pushReason: 'fake', cron: '0 0 * * * *' },
    );
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws-1',
      loadRegistry: regOf(creatorHome, member('shop', 'shop-hive'), member('warehouse', 'shop-hive')),
      seedMember: seed,
    });
    expect(out.seeded).toEqual(['warehouse']);
    expect(out.skipped).toEqual([{ slug: 'shop', reason: 'error:pg down' }]);
  });

  it('joiner detection: joinerSide comes from the HOME entry remote_hive flag (missing home ⇒ creator)', async () => {
    const { seed, calls } = fakeSeed();
    await reconcileGitSyncRoutines({
      workspaceId: 'ws-1',
      loadRegistry: regOf(
        creatorHome,
        joinerHome,
        member('shop', 'shop-hive'), // creator-side
        member('far-app', 'far-hive'), // joiner-side (home carries remote_hive)
        member('orphan', 'gone-hive'), // home missing from the registry
      ),
      seedMember: seed,
    });
    expect(calls.map((c) => [c.installSlug, c.joinerSide])).toEqual([
      ['shop', false],
      ['far-app', true],
      ['orphan', false],
    ]);
  });

  it('a registry-load failure folds into result.error — never thrown', async () => {
    const { seed, calls } = fakeSeed();
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws-1',
      loadRegistry: async () => {
        throw new Error('pg exploded');
      },
      seedMember: seed,
    });
    expect(out).toEqual({ seeded: [], skipped: [], unseeded: [], error: 'pg exploded' });
    expect(calls).toEqual([]);
  });
});

describe('reconcileGitSyncRoutines — P-014 blind-spot detection', () => {
  const orphan: ProjectEntry = { slug: 'orphan-repo', path: '/repos/orphan' };
  const eligibleSet =
    (slugs: string[]) =>
    (p: ProjectEntry) =>
      slugs.includes(p.slug)
        ? ({ eligible: true } as const)
        : ({ eligible: false, reason: 'not_a_git_repo' } as const);
  const routineFor = (withRoutine: string[]) =>
    (async (_sql: unknown, slug: string) =>
      withRoutine.includes(slug) ? ({ id: 'rt', installSlug: slug } as never) : null) as ReconcileGitSyncOpts['getRoutine'];

  it('flags an eligible NON-member checkout that has no routine row (the blind spot)', async () => {
    const { seed } = fakeSeed();
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws',
      loadRegistry: regOf(papercup, member('shop', 'shop-hive'), orphan),
      seedMember: seed,
      sql: sqlFake,
      eligibility: eligibleSet(['papercup', 'orphan-repo']),
      getRoutine: routineFor(['papercup']), // papercup carries its hand-tuned row
    });
    // shop is a member (member loop); papercup has a routine (excluded);
    // orphan-repo is eligible + non-member + no routine ⇒ surfaced.
    expect(out.unseeded).toEqual(['orphan-repo']);
    expect(out.seeded).toEqual(['shop']);
  });

  it('EI-1623: a link-join (joined_via_link, no hive_slug) is BACKFILLED joiner-side, not flagged as a blind spot', async () => {
    // The failed-join-seed case: a bare invite-LINK clone whose best-effort
    // join-time git-sync seed failed → it carries `joined_via_link` (+ coords)
    // but has NO routine row. The reconcile must self-heal it, not leave it
    // silently un-synced (only alarming as `unseeded`).
    const linkJoin: ProjectEntry = {
      slug: 'linked-clone',
      path: '/clones/linked-clone',
      github_remote: 'https://github.com/owner/repo',
      github_repository_id: 7,
      joined_via_link: true,
    };
    const { seed, calls } = fakeSeed(() => ({
      seeded: true,
      active: true,
      push: false,
      pushReason: 'joiner_side',
      cron: '0 0 * * * *',
    }));
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws',
      loadRegistry: regOf(papercup, linkJoin),
      seedMember: seed,
      sql: sqlFake,
      eligibility: eligibleSet(['papercup', 'linked-clone']),
      getRoutine: routineFor(['papercup']), // papercup has its row; the link-join has NONE
    });
    // The member loop BACKFILLED the link-join (a failed join-time seed self-heals)…
    expect(out.seeded).toEqual(['linked-clone']);
    // …seeded JOINER-side (push:false), never creator-side, with the per-install
    // salted cron (D-004 — the same slug exists on N peer boxes)…
    const call = calls.find((c) => c.installSlug === 'linked-clone')!;
    expect(call.joinerSide).toBe(true);
    expect((call as { cronKey?: string }).cronKey).toBe('linked-clone:ws');
    // …and it is NOT surfaced as an unseeded blind spot (it's a member now).
    expect(out.unseeded).toEqual([]);
  });

  it('EI-8793: a release-install canonical clone (remote_hive + self_repo) is BACKFILLED joiner-side, not skipped as a view', async () => {
    // The 0.0.3 Mac release install: defaultSelfAdmitCanonical registered the
    // seeded checkout as { harness_kind:'hive', remote_hive:true } with NO
    // hive_slug / joined_via_link — the sweep never visited it, eligibility
    // called it a view, and agent edits stranded uncommitted forever. Now the
    // entry carries `self_repo` and the sweep must backfill it joiner-side, so
    // existing installs heal at their next boot.
    const releaseClone: ProjectEntry = {
      slug: 'papercusp',
      path: '/clones/papercusp',
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    };
    const { seed, calls } = fakeSeed(() => ({
      seeded: true,
      active: true,
      push: false,
      pushReason: 'joiner_side',
      cron: '0 0 * * * *',
    }));
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws',
      loadRegistry: regOf(papercup, joinerHome, releaseClone),
      seedMember: seed,
      sql: sqlFake,
      eligibility: eligibleSet(['papercup', 'papercusp']),
      getRoutine: routineFor(['papercup']),
    });
    // The member loop backfilled the release clone — and ONLY it (the repo-less
    // remote_hive view `far-hive` stays untouched, no self_repo)…
    expect(out.seeded).toEqual(['papercusp']);
    expect(calls.map((c) => c.installSlug)).toEqual(['papercusp']);
    // …seeded JOINER-side (this box is a peer, never the origin pusher), with
    // the per-install salted cron (the same slug exists on every install)…
    const call = calls.find((c) => c.installSlug === 'papercusp')!;
    expect(call.joinerSide).toBe(true);
    expect((call as { cronKey?: string }).cronKey).toBe('papercusp:ws');
    // …and it is NOT flagged as an unseeded blind spot (it's a member now).
    expect(out.unseeded).toEqual([]);
  });

  it('a repo WITH a routine (papercup) is never flagged', async () => {
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws',
      loadRegistry: regOf(papercup),
      sql: sqlFake,
      eligibility: eligibleSet(['papercup']),
      getRoutine: routineFor(['papercup']),
    });
    expect(out.unseeded).toEqual([]);
  });

  it('ineligible homes / remote_hive views never appear (members handled by the loop)', async () => {
    const { seed } = fakeSeed();
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws',
      loadRegistry: regOf(creatorHome, joinerHome, member('shop', 'shop-hive')),
      seedMember: seed,
      sql: sqlFake,
      eligibility: eligibleSet([]), // homes/views ineligible; the member is skipped anyway
      getRoutine: routineFor([]),
    });
    expect(out.unseeded).toEqual([]);
  });

  it('detection no-ops when no sql/reader is resolvable (unit walks stay clean)', async () => {
    // db-org getOrgPg is mocked to throw; with neither sql nor getRoutine
    // injected, detection skips — no false alarm, no fs/PG touch.
    const { seed } = fakeSeed();
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws',
      loadRegistry: regOf(orphan),
      seedMember: seed,
    });
    expect(out.unseeded).toEqual([]);
  });
});

describe('reconcileGitSyncRoutines — composes the REAL spine', () => {
  let cloneDir: string;
  beforeEach(() => {
    cloneDir = mkdtempSync(join(tmpdir(), 'git-sync-reconcile-'));
    mkdirSync(join(cloneDir, '.git'));
  });
  afterEach(() => {
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it('a creator-side member with a live clone seeds through upsertRoutine (jittered cron, ACTIVE, no-upstream ⇒ push:false)', async () => {
    const out = await reconcileGitSyncRoutines({
      workspaceId: 'ws-live',
      loadRegistry: regOf(
        creatorHome,
        member('shop', 'shop-hive', { path: cloneDir, github_default_branch: 'develop' }),
      ),
      sql: sqlFake,
      // no seedMember seam — the real seedGitSyncRoutineForMember runs
    });
    expect(out).toEqual({ seeded: ['shop'], skipped: [], unseeded: [] });
    expect(upsertRoutineMock).toHaveBeenCalledTimes(1);
    expect(upsertRoutineMock.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws-live',
      installSlug: 'shop',
      active: GIT_SYNC_SEED_ACTIVE_CREATOR,
      triggerConfig: {
        cron: gitSyncCronForKey('shop'),
        push: false, // no github_remote ⇒ fetch-less repo never pushes (B-02 rule 1)
        branch: 'develop',
      },
    });
  });

  it('the hand-tuned papercup row is untouched even on the real-spine path', async () => {
    await reconcileGitSyncRoutines({
      workspaceId: 'ws-live',
      loadRegistry: regOf(papercup, creatorHome),
      sql: sqlFake,
    });
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });
});

describe('ensureGitSyncRoutinesReconciledOnce (P-004 boot trigger)', () => {
  it('sweeps each workspace once per process — repeat calls no-op', async () => {
    const loads: string[] = [];
    const { seed } = fakeSeed();
    const seams = {
      loadRegistry: async (ws?: string) => {
        loads.push(ws ?? '');
        return { projects: [creatorHome, member('shop', 'shop-hive')] };
      },
      seedMember: seed,
    };
    expect(ensureGitSyncRoutinesReconciledOnce(['ws-a', 'ws-b'], seams)).toBeUndefined();
    expect(ensureGitSyncRoutinesReconciledOnce(['ws-a', 'ws-b'], seams)).toBeUndefined();
    await vi.waitFor(() => expect(loads).toEqual(['ws-a', 'ws-b']));
    ensureGitSyncRoutinesReconciledOnce(['ws-a', 'ws-b'], seams);
    await new Promise((r) => setTimeout(r, 5));
    expect(loads).toEqual(['ws-a', 'ws-b']); // still just the first pass
  });

  it('a sweep failure is logged, never thrown — boot cannot wedge', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      ensureGitSyncRoutinesReconciledOnce(['ws-bad'], {
        loadRegistry: async () => {
          throw new Error('registry exploded');
        },
      });
      await vi.waitFor(() =>
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('registry exploded')),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('quiet at steady state: nothing seeded + nothing failed logs nothing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { seed, calls } = fakeSeed(() => ({ seeded: false, reason: 'routine_exists' }));
      ensureGitSyncRoutinesReconciledOnce(['ws-a'], {
        loadRegistry: regOf(creatorHome, member('shop', 'shop-hive')),
        seedMember: seed,
      });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('logs the seeded slugs when the sweep added rows', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { seed, calls } = fakeSeed();
      ensureGitSyncRoutinesReconciledOnce(['ws-a'], {
        loadRegistry: regOf(creatorHome, member('shop', 'shop-hive')),
        seedMember: seed,
      });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await vi.waitFor(() =>
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('seeded=[shop]')),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('P-014: logs an eligible-but-unseeded repo as a blind-spot alarm', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      ensureGitSyncRoutinesReconciledOnce(['ws-a'], {
        loadRegistry: regOf({ slug: 'orphan-repo', path: '/repos/orphan' }),
        sql: sqlFake,
        eligibility: () => ({ eligible: true }),
        getRoutine: (async () => null) as ReconcileGitSyncOpts['getRoutine'],
      });
      await vi.waitFor(() =>
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('UNSEEDED=[orphan-repo]')),
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
