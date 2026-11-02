import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pr } from '../../pr-host/types';
import { makeLiveStandingPrMerge, type LiveStandingPrMergeResolvers } from './standing-pr-merge-live';
import type { StandingPrMergeDeps } from './standing-pr-merge';
import {
  createDefaultStandingPrMergeDeps,
  nodeInstallCommandFor,
  pickNodeInstallCommand,
  type StandingPrMergeMetaStore,
} from './standing-pr-merge-deps';

const PR = {
  ref: { number: 7 },
  head_ref: 'papercusp/standing',
  base_ref: 'main',
  head_sha: 'a'.repeat(40),
  review_decision: 'approved',
  checks_state: 'success',
} as unknown as Pr;

const store = { readMeta: async () => ({}), patchMeta: async () => undefined };

function fakeDeps(): StandingPrMergeDeps & { started: number } {
  const d = {
    started: 0,
    readTargetTip: async () => 'b'.repeat(40),
    loadLastTest: async () => null,
    loadPathAttribution: async () => ({ ok: true as const, prDiffPaths: [], admittedFixPaths: [] }),
    saveTest: async () => undefined,
    findUnpublishedGitlinks: async () => ({ ok: true as const, unpublished: [] }),
    buildMergeResult: async () => 'c'.repeat(40),
    async startTests() {
      d.started += 1;
    },
    advanceTarget: async () => ({ ok: true as const }),
  };
  return d;
}

function resolvers(over: Partial<LiveStandingPrMergeResolvers> = {}): Partial<LiveStandingPrMergeResolvers> {
  const deps = fakeDeps();
  return {
    repoDir: async () => '/repo',
    integration: async () => ({ mode: 'review', source: 'set' }) as never,
    promotedSha: async () => PR.head_sha,
    suiteCommand: async () => 'npm ci && npm test',
    runSuite: () => async () => true,
    buildDeps: () => deps,
    ...over,
  };
}

const args = { workspaceId: 'ws', installSlug: 'pot', remote: 'o/r', pr: PR, autoMerge: true, authorRevoked: false };

describe('makeLiveStandingPrMerge', () => {
  it('starts the exact-merge suite in working-copy mode with auto-merge on', async () => {
    const buildDeps = vi.fn(() => fakeDeps());
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers({ buildDeps }) });
    const out = await step(args);
    expect(out).toMatchObject({ action: 'testing', reason: 'never-tested', mergeSha: 'c'.repeat(40) });
    expect(buildDeps).toHaveBeenCalledWith(expect.objectContaining({ repoDir: '/repo', prNumber: 7 }));
  });

  it('leaves the PR for the owner outside working-copy mode', async () => {
    const step = makeLiveStandingPrMerge({
      store,
      resolvers: resolvers({ integration: async () => ({ mode: 'direct', source: 'set' }) as never }),
    });
    expect(await step(args)).toEqual({ action: 'left-for-owner' });
  });

  it('leaves the PR for the owner when auto-merge is off', async () => {
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers() });
    expect(await step({ ...args, autoMerge: false })).toEqual({ action: 'left-for-owner' });
  });

  it('refuses without a test suite instead of merging untested code', async () => {
    const buildDeps = vi.fn(() => fakeDeps());
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers({ suiteCommand: async () => null, buildDeps }) });
    expect(await step(args)).toMatchObject({ action: 'error' });
    expect(buildDeps).not.toHaveBeenCalled();
  });

  it('refuses a revoked author', async () => {
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers() });
    expect(await step({ ...args, authorRevoked: true })).toMatchObject({ action: 'refused', reason: 'author-revoked' });
  });

  // WI-10006351: a self-authored standing PR has no GitHub review; the viewer merge
  // must reach stepStandingPrMerge as the approval.
  it('passes a PR-viewer approval through to the merge step', async () => {
    const unreviewed = { ...PR, review_decision: 'none' } as Pr;
    const deps = fakeDeps();
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers({ buildDeps: () => deps }) });
    expect(await step({ ...args, pr: unreviewed })).toMatchObject({ action: 'skipped', reason: 'not-approved' });
    expect(deps.started).toBe(0);
    expect(await step({ ...args, pr: unreviewed, viewerApproved: true }))
      .toMatchObject({ action: 'testing', reason: 'never-tested', mergeSha: 'c'.repeat(40) });
    expect(deps.started).toBe(1);
  });

  it('refuses when nothing was promoted to the working copy main', async () => {
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers({ promotedSha: async () => null }) });
    expect(await step(args)).toMatchObject({ action: 'refused', reason: 'nothing-promoted' });
  });

  it('turns a resolver failure into an error outcome', async () => {
    const step = makeLiveStandingPrMerge({
      store,
      resolvers: resolvers({ repoDir: async () => { throw new Error('registry down'); } }),
    });
    expect(await step(args)).toEqual({ action: 'error', detail: 'registry down' });
  });
});

// WI-10006355: the merge result runs the pot's own suite (the gate's rule), verbatim.
describe('makeLiveStandingPrMerge suite command', () => {
  it('takes the suite from the pot resolver and runs exactly that command', async () => {
    const suiteCommand = vi.fn(async () => 'npm test');
    const runSuite = vi.fn(() => async () => true);
    const step = makeLiveStandingPrMerge({ store, resolvers: resolvers({ suiteCommand, runSuite }) });
    await step(args);
    expect(suiteCommand).toHaveBeenCalledWith('pot', 'ws');
    expect(runSuite).toHaveBeenCalledWith('npm test');
  });
});

describe('pickNodeInstallCommand', () => {
  it('uses npm ci only with a lockfile, npm install for unlocked dependencies, else nothing', () => {
    expect(pickNodeInstallCommand({ hasPackageJson: true, hasLockfile: true, dependencyCount: 0 })).toBe('npm ci');
    expect(pickNodeInstallCommand({ hasPackageJson: true, hasLockfile: false, dependencyCount: 2 }))
      .toBe('npm install --no-audit --no-fund');
    expect(pickNodeInstallCommand({ hasPackageJson: true, hasLockfile: false, dependencyCount: 0 })).toBeNull();
    expect(pickNodeInstallCommand({ hasPackageJson: false, hasLockfile: true, dependencyCount: 3 })).toBeNull();
  });
});

describe('nodeInstallCommandFor', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'node-install-'));
    dirs.push(dir);
    await Promise.all(Object.entries(files).map(([name, body]) => writeFile(join(dir, name), body)));
    return dir;
  }

  it('installs nothing for a lockfile-less package with no dependencies (the pilot shape)', async () => {
    expect(await nodeInstallCommandFor(await repo({ 'package.json': '{"scripts":{"test":"node --test"}}' }))).toBeNull();
  });

  it('reads the lockfile and dependency fields from the checkout', async () => {
    expect(await nodeInstallCommandFor(await repo({ 'package.json': '{"devDependencies":{"x":"1"}}' })))
      .toBe('npm install --no-audit --no-fund');
    expect(await nodeInstallCommandFor(await repo({ 'package.json': '{}', 'package-lock.json': '{}' }))).toBe('npm ci');
    expect(await nodeInstallCommandFor(await repo({ 'README.md': 'no node here' }))).toBeNull();
  });
});

describe('WI-10006418: the merge-test record has somewhere to live, and a dropped write is loud', () => {
  const tested = { mergeSha: 'c'.repeat(40), prHeadSha: 'a'.repeat(40), targetTipSha: 'b'.repeat(40), result: 'pass' as const };
  const depsOn = (s: StandingPrMergeMetaStore) =>
    createDefaultStandingPrMergeDeps({ repoDir: '/repo', installSlug: 'pot', prNumber: 7, store: s, runSuite: async () => true });

  it('saving fails when the store drops the write without an error (a pot with no pr-poll row)', async () => {
    const dropping: StandingPrMergeMetaStore = { readMeta: async () => ({}), patchMeta: async () => undefined };
    await expect(depsOn(dropping).saveTest(7, tested)).rejects.toThrow(/PR #7 on pot was not saved/);
  });

  it('a store that keeps the write saves the record, and the next merge reads it back', async () => {
    let meta: Record<string, unknown> = {};
    const keeping: StandingPrMergeMetaStore = {
      readMeta: async () => meta,
      patchMeta: async (_slug, patch) => {
        meta = { ...meta, ...patch };
      },
    };
    const deps = depsOn(keeping);
    await deps.saveTest(7, tested);
    expect(await deps.loadLastTest(7)).toEqual(tested);
  });

  it('asks the store to create its row before the merge step builds its deps', async () => {
    const calls: string[] = [];
    const ensuring: StandingPrMergeMetaStore = {
      ...store,
      ensureRecordRow: async (slug, ws) => {
        calls.push(`ensure ${ws}/${slug}`);
      },
    };
    const step = makeLiveStandingPrMerge({
      store: ensuring,
      resolvers: resolvers({ buildDeps: () => (calls.push('build'), fakeDeps()) }),
    });
    await step(args);
    expect(calls).toEqual(['ensure ws/pot', 'build']);
  });

  it('reports an error instead of re-testing forever when the row cannot be created', async () => {
    let built = 0;
    const failing: StandingPrMergeMetaStore = {
      ...store,
      ensureRecordRow: async () => {
        throw new Error("Could not create the row that stores pot's merge tests (no_remote).");
      },
    };
    const step = makeLiveStandingPrMerge({
      store: failing,
      resolvers: resolvers({ buildDeps: () => (built++, fakeDeps()) }),
    });
    expect(await step(args)).toEqual({
      action: 'error',
      detail: "Could not create the row that stores pot's merge tests (no_remote).",
    });
    expect(built).toBe(0);
  });
});
