/**
 * pot-review-integration-mode P-020 (D-006/D-007): end-to-end with REAL git.
 *
 * A working-copy (review-mode) pot's green-gate promotion must land on the
 * pot's own fork and reach the main repository only as the standing PR. The
 * unit tests (promotion-publish.test.ts) stub every git seam; this test runs
 * the real ones — `ensurePotForkGitRemote` and the default `pushToFork` — against
 * two bare repositories standing in for GitHub:
 *
 *   upstream.git — the main repository (the checkout's `origin`)
 *   fork.git     — the pot's working copy (reached through `pot-fork`)
 *
 * The registry stores GitHub URLs; a per-checkout `url.<path>.insteadOf` rule
 * maps them onto the bare repositories, so the code under test sees exactly the
 * URLs it would see in production while git writes to local disk.
 *
 * Only the registry read, the mode read and the PR host's HTTP calls are faked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectEntry } from '../../harness-registry';
import type { OpenPrArgs, Pr } from '../../pr-host/types';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import { POT_FORK_REMOTE_NAME, type PotIntegrationModeRead } from './pot-integration-mode';
import {
  createDefaultPublishPromotionDeps,
  createDefaultSendStandingPrNowDeps,
  publishPromotion,
  sendStandingPrNow,
  type PublishPromotionDeps,
  type SendStandingPrNowDeps,
} from './promotion-push-target';
import type { StandingPrDeps } from './standing-pr';

const FORK_URL = 'https://github.com/acme-bot/widgets.git';
const UPSTREAM_URL = 'https://github.com/acme/widgets.git';
/**
 * "owner/repo" the host reports as an open standing PR's head repository. Publishing adopts
 * only a PR whose head is THIS pot's fork (WI-10006271), so every fixture of "the existing
 * standing PR" must carry it — without it the PR is correctly skipped and a duplicate opened.
 */
const FORK_REPO = 'acme-bot/widgets';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      // Keep the operator's own hooks (e.g. the pre-push main guard) out of the fixture.
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

/** The sha a bare repository's branch points at, or null when the branch does not exist. */
function branchSha(bare: string, branch: string): string | null {
  try {
    return git(bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  } catch {
    return null;
  }
}

/** Whether a repository holds an object at all (on any ref or none). */
function hasObject(repo: string, sha: string): boolean {
  try {
    git(repo, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  root: string;
  upstream: string;
  fork: string;
  checkout: string;
  baseSha: string;
  promotedSha: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'working-copy-standing-pr-'));
  const upstream = join(root, 'upstream.git');
  const fork = join(root, 'fork.git');
  const checkout = join(root, 'checkout');

  git(root, 'init', '--bare', '--initial-branch=main', upstream);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--initial-branch=main');
  writeFileSync(join(seed, 'README.md'), 'widgets\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'push', upstream, 'main:refs/heads/main');
  const baseSha = git(seed, 'rev-parse', 'HEAD');

  // The working copy starts as a fork of the main repository.
  git(root, 'clone', '--bare', upstream, fork);

  // The pot's integration checkout: origin = the main repository.
  git(root, 'clone', upstream, checkout);
  git(checkout, 'config', `url.${fork}.insteadOf`, FORK_URL);
  git(checkout, 'config', `url.${upstream}.insteadOf`, UPSTREAM_URL);
  writeFileSync(join(checkout, 'feature.txt'), 'tested work\n');
  git(checkout, 'add', 'feature.txt');
  git(checkout, 'commit', '-m', 'tested candidate');
  const promotedSha = git(checkout, 'rev-parse', 'HEAD');

  return { root, upstream, fork, checkout, baseSha, promotedSha };
}

function registryEntry(fx: Fixture, over: Partial<Record<string, unknown>> = {}): ProjectEntry {
  return {
    slug: 'widgets',
    path: fx.checkout,
    self_repo: true,
    fork_remote: FORK_URL,
    github_remote: UPSTREAM_URL,
    ...over,
  } as unknown as ProjectEntry;
}

/** A PR host that records calls; its pushHead is a real non-force push through `pot-fork`. */
function fakePrHost(checkout: string, openPrs: Pr[] = []) {
  const opened: OpenPrArgs[] = [];
  const listed: string[] = [];
  const deps: StandingPrDeps = {
    listOpenPrs: async ({ remote }) => {
      listed.push(remote);
      return { ok: true, data: openPrs };
    },
    openPr: async (args) => {
      opened.push(args);
      return {
        ok: true,
        data: {
          ref: { remote: args.remote, number: 42 },
          state: 'open',
          title: args.title,
          body: args.body,
          head_ref: args.head_ref,
          base_ref: args.base_ref,
          head_sha: '',
          url: 'https://github.com/acme/widgets/pull/42',
        } as unknown as Pr,
      };
    },
    pushHead: async ({ sha, branch }) => {
      git(checkout, 'push', POT_FORK_REMOTE_NAME, `${sha}:refs/heads/${branch}`);
    },
  };
  return { deps, opened, listed };
}

async function realDeps(
  fx: Fixture,
  opts: { mode: PotIntegrationModeRead | Error; entry?: ProjectEntry; prHost?: StandingPrDeps | null },
): Promise<{ deps: PublishPromotionDeps; logs: string[] }> {
  const logs: string[] = [];
  const base = await createDefaultPublishPromotionDeps((line) => logs.push(line));
  const deps: PublishPromotionDeps = {
    ...base,
    // Faked: the registry and the federated settings read (both need Postgres).
    loadProjects: async () => [opts.entry ?? registryEntry(fx)],
    readMode: async () => {
      if (opts.mode instanceof Error) throw opts.mode;
      return opts.mode;
    },
    // Faked: GitHub's HTTP API. The branch push inside it is still real git.
    createStandingPrDeps: async () => (opts.prHost === undefined ? fakePrHost(fx.checkout).deps : opts.prHost),
  };
  return { deps, logs };
}

/** realDeps plus the real `git ls-remote pot-fork <ref>` reader the on-demand send uses. */
async function realSendDeps(
  fx: Fixture,
  opts: { mode: PotIntegrationModeRead | Error; prHost?: StandingPrDeps | null },
): Promise<SendStandingPrNowDeps> {
  const { deps } = await realDeps(fx, opts);
  const { readForkHead } = await createDefaultSendStandingPrNowDeps(() => {});
  return { ...deps, readForkHead };
}

describe('on-demand "send what is green now" with real git (P-020)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('sends the working copy main that already passed the gate, and pushes no code of its own', async () => {
    const first = fakePrHost(fx.checkout);
    const publish = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: first.deps });
    await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      publish.deps,
    );
    // A local commit that never passed the gate must NOT ride along on an on-demand send.
    writeFileSync(join(fx.checkout, 'feature.txt'), 'untested\n');
    git(fx.checkout, 'commit', '-am', 'untested local work');
    const untestedSha = git(fx.checkout, 'rev-parse', 'HEAD');

    const existing = {
      ref: { remote: UPSTREAM_URL, number: 42 },
      state: 'open',
      title: 'standing',
      body: null,
      head_ref: STANDING_PR_BRANCH,
      head_repo: FORK_REPO,
      base_ref: 'main',
      head_sha: fx.promotedSha,
      url: 'https://github.com/acme/widgets/pull/42',
    } as unknown as Pr;
    const host = fakePrHost(fx.checkout, [existing]);
    const outcome = await sendStandingPrNow(
      { repoPath: fx.checkout, workspaceId: 'ws-test', ref: 'main' },
      await realSendDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: host.deps }),
    );

    expect(outcome).toMatchObject({ kind: 'sent', potHomeSlug: 'widgets', sha: fx.promotedSha });
    if (outcome.kind === 'sent') expect(outcome.standingPr).toMatchObject({ ok: true, prNumber: 42 });
    expect(host.opened).toHaveLength(0);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(fx.promotedSha);
    expect(branchSha(fx.fork, 'main')).toBe(fx.promotedSha);
    expect(hasObject(fx.fork, untestedSha)).toBe(false);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
  });

  it('a working copy with no main yet: nothing has passed the gate, so nothing is sent', async () => {
    git(fx.fork, 'symbolic-ref', 'HEAD', 'refs/heads/standby');
    git(fx.fork, 'update-ref', '-d', 'refs/heads/main');
    const host = fakePrHost(fx.checkout);
    const outcome = await sendStandingPrNow(
      { repoPath: fx.checkout, workspaceId: 'ws-test', ref: 'main' },
      await realSendDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: host.deps }),
    );

    expect(outcome.kind).toBe('nothing-green');
    expect(host.listed).toHaveLength(0);
    expect(host.opened).toHaveLength(0);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBeNull();
  });

  it('direct mode: there is no standing PR to send', async () => {
    const host = fakePrHost(fx.checkout);
    const outcome = await sendStandingPrNow(
      { repoPath: fx.checkout, workspaceId: 'ws-test', ref: 'main' },
      await realSendDeps(fx, { mode: { mode: 'direct', source: 'set' }, prHost: host.deps }),
    );

    expect(outcome.kind).toBe('not-review');
    expect(host.listed).toHaveLength(0);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBeNull();
  });
});

/**
 * SPEC-P-023-pilot: the PR opened after the first merge lists only commits made after that
 * merge. A PR's commit list is what GitHub computes: commits reachable from the head that
 * are not reachable from the base (`git rev-list base..head`). The first standing PR is
 * merged at its EXACT tested sha (P-024), so upstream main then CONTAINS that commit and
 * the next promotion's range is only the new work. The squash control shows the property is
 * not vacuous: a merge that rewrites the sha leaves the old commit in the next PR.
 */
describe('the PR after a merge lists only new work (SPEC-P-023-pilot, real git)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  /** The commits GitHub would list on the standing PR: upstream main..fork standing branch. */
  function standingPrCommits(): string[] {
    git(fx.checkout, 'fetch', '--quiet', fx.upstream, '+refs/heads/main:refs/remotes/pr-base/main');
    git(fx.checkout, 'fetch', '--quiet', fx.fork, `+refs/heads/${STANDING_PR_BRANCH}:refs/remotes/pr-head/standing`);
    const out = git(fx.checkout, 'rev-list', 'refs/remotes/pr-base/main..refs/remotes/pr-head/standing');
    return out ? out.split('\n') : [];
  }

  async function promote(sha: string, open: Pr[]): Promise<void> {
    const host = fakePrHost(fx.checkout, open);
    const run = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: host.deps });
    const outcome = await publishPromotion({ repoPath: fx.checkout, workspaceId: 'ws-test', sha, ref: 'main' }, run.deps);
    expect(outcome.kind).toBe('fork');
  }

  function secondCandidate(): string {
    writeFileSync(join(fx.checkout, 'feature.txt'), 'work made after the first merge\n');
    git(fx.checkout, 'commit', '-am', 'second tested candidate');
    return git(fx.checkout, 'rev-parse', 'HEAD');
  }

  it('an exact-sha merge leaves the next standing PR with only the commits made after it', async () => {
    await promote(fx.promotedSha, []);
    expect(standingPrCommits()).toEqual([fx.promotedSha]);

    // The PR-viewer merge lands exactly the tested sha on the main repository (P-024).
    git(fx.checkout, 'push', '--quiet', fx.upstream, `${fx.promotedSha}:refs/heads/main`);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.promotedSha);
    expect(standingPrCommits()).toEqual([]);

    const nextSha = secondCandidate();
    await promote(nextSha, []);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(nextSha);
    const listed = standingPrCommits();
    expect(listed).toEqual([nextSha]);
    expect(listed).not.toContain(fx.promotedSha);
  });

  it('control: a merge that rewrites the sha (squash) would leave the merged commit in the next PR', async () => {
    await promote(fx.promotedSha, []);
    // Same tree as the tested commit, different sha: what a squash merge produces.
    const tree = git(fx.checkout, 'rev-parse', `${fx.promotedSha}^{tree}`);
    const squashSha = git(fx.checkout, 'commit-tree', tree, '-p', fx.baseSha, '-m', 'squash of the standing PR');
    git(fx.checkout, 'push', '--quiet', fx.upstream, `${squashSha}:refs/heads/main`);

    const nextSha = secondCandidate();
    await promote(nextSha, []);
    expect(standingPrCommits()).toEqual([nextSha, fx.promotedSha]);
  });
});

describe('working-copy promotion with real git (P-020)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('review mode: the promoted commit lands on the fork, never on the main repository, and opens the standing PR', async () => {
    const host = fakePrHost(fx.checkout);
    const { deps, logs } = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: host.deps });

    const outcome = await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      deps,
    );

    expect(outcome.kind).toBe('fork');
    if (outcome.kind !== 'fork') return;
    expect(outcome.remoteRef).toBe('refs/heads/main');
    expect(outcome.potHomeSlug).toBe('widgets');

    // The working copy's main carries the tested commit…
    expect(branchSha(fx.fork, 'main')).toBe(fx.promotedSha);
    // …and the main repository never received it.
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
    expect(hasObject(fx.upstream, fx.promotedSha)).toBe(false);
    expect(hasObject(fx.fork, fx.promotedSha)).toBe(true);

    // The checkout's pot-fork remote stores the registry URL (insteadOf maps it at transport time).
    expect(git(fx.checkout, 'config', '--get', `remote.${POT_FORK_REMOTE_NAME}.url`)).toBe(FORK_URL);

    // The standing PR: the fork's standing branch at the tested commit, opened against upstream main.
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(fx.promotedSha);
    expect(host.listed).toEqual([UPSTREAM_URL]);
    expect(host.opened).toHaveLength(1);
    expect(host.opened[0]).toMatchObject({
      remote: UPSTREAM_URL,
      head_ref: STANDING_PR_BRANCH,
      head_owner: 'acme-bot',
      base_ref: 'main',
    });
    expect(outcome.standingPr).toMatchObject({ ok: true, prNumber: 42 });
    expect(logs.some((l) => l.includes('the main repository receives it only through the standing PR'))).toBe(true);
  });

  it('review mode: the PR carries the PROMOTED commit even when the checkout has moved past it (open and update)', async () => {
    // git-sync keeps committing while the gate runs, so by promotion time the checkout's
    // HEAD is routinely a newer, untested commit. Only the promoted sha may reach the PR.
    writeFileSync(join(fx.checkout, 'feature.txt'), 'untested after promotion\n');
    git(fx.checkout, 'commit', '-am', 'untested work committed after the gate cut its candidate');
    const untestedSha = git(fx.checkout, 'rev-parse', 'HEAD');
    expect(untestedSha).not.toBe(fx.promotedSha);

    const first = fakePrHost(fx.checkout);
    const firstRun = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: first.deps });
    await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      firstRun.deps,
    );
    expect(first.opened).toHaveLength(1);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(fx.promotedSha);
    expect(hasObject(fx.fork, untestedSha)).toBe(false);

    // Update path: the gate promotes the next commit, while HEAD has again moved past it.
    writeFileSync(join(fx.checkout, 'feature.txt'), 'second tested candidate\n');
    git(fx.checkout, 'commit', '-am', 'second tested candidate');
    const nextSha = git(fx.checkout, 'rev-parse', 'HEAD');
    writeFileSync(join(fx.checkout, 'feature.txt'), 'untested again\n');
    git(fx.checkout, 'commit', '-am', 'more untested work');
    const untestedAgainSha = git(fx.checkout, 'rev-parse', 'HEAD');

    const existing = {
      ref: { remote: UPSTREAM_URL, number: 42 },
      state: 'open',
      title: 'standing',
      body: null,
      head_ref: STANDING_PR_BRANCH,
      head_repo: FORK_REPO,
      base_ref: 'main',
      head_sha: fx.promotedSha,
      url: 'https://github.com/acme/widgets/pull/42',
    } as unknown as Pr;
    const second = fakePrHost(fx.checkout, [existing]);
    const secondRun = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: second.deps });
    await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: nextSha, ref: 'main' },
      secondRun.deps,
    );
    expect(second.opened).toHaveLength(0);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(nextSha);
    expect(hasObject(fx.fork, untestedAgainSha)).toBe(false);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
  });

  it('review mode: a second promotion moves the existing standing PR instead of opening another', async () => {
    const first = fakePrHost(fx.checkout);
    const firstRun = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: first.deps });
    await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      firstRun.deps,
    );

    writeFileSync(join(fx.checkout, 'feature.txt'), 'more tested work\n');
    git(fx.checkout, 'commit', '-am', 'second tested candidate');
    const nextSha = git(fx.checkout, 'rev-parse', 'HEAD');

    const existing = {
      ref: { remote: UPSTREAM_URL, number: 42 },
      state: 'open',
      title: 'standing',
      body: null,
      head_ref: STANDING_PR_BRANCH,
      head_repo: FORK_REPO,
      base_ref: 'main',
      head_sha: fx.promotedSha,
      url: 'https://github.com/acme/widgets/pull/42',
    } as unknown as Pr;
    const second = fakePrHost(fx.checkout, [existing]);
    const secondRun = await realDeps(fx, { mode: { mode: 'review', source: 'set' }, prHost: second.deps });
    const outcome = await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: nextSha, ref: 'main' },
      secondRun.deps,
    );

    expect(outcome.kind).toBe('fork');
    expect(branchSha(fx.fork, 'main')).toBe(nextSha);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBe(nextSha);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
    expect(second.opened).toHaveLength(0);
    if (outcome.kind === 'fork') expect(outcome.standingPr).toMatchObject({ ok: true, prNumber: 42 });
  });

  it('direct mode: publishes nothing itself and hands the push back to the caller (origin)', async () => {
    const host = fakePrHost(fx.checkout);
    const { deps } = await realDeps(fx, { mode: { mode: 'direct', source: 'absent' }, prHost: host.deps });

    const outcome = await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      deps,
    );

    expect(outcome).toEqual({ kind: 'origin' });
    expect(branchSha(fx.fork, 'main')).toBe(fx.baseSha);
    expect(branchSha(fx.fork, STANDING_PR_BRANCH)).toBeNull();
    expect(host.opened).toHaveLength(0);
  });

  it('review mode without a fork: published nowhere — never falls back to the main repository', async () => {
    const { deps } = await realDeps(fx, {
      mode: { mode: 'review', source: 'set' },
      entry: registryEntry(fx, { fork_remote: undefined }),
    });

    const outcome = await publishPromotion(
      { repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' },
      deps,
    );

    expect(outcome.kind).toBe('skipped');
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
    expect(branchSha(fx.fork, 'main')).toBe(fx.baseSha);
  });

  it('an unreadable mode holds promotion: it throws and pushes nothing anywhere', async () => {
    const { deps } = await realDeps(fx, { mode: { mode: 'direct', source: 'error' } });

    await expect(
      publishPromotion({ repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' }, deps),
    ).rejects.toThrow(/promotion held/);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
    expect(branchSha(fx.fork, 'main')).toBe(fx.baseSha);
  });

  it('a rejected fork push throws, so local main is never advanced past an unpublished commit', async () => {
    // Diverge the fork's main so a non-fast-forward push is rejected.
    const other = join(fx.root, 'other');
    git(fx.root, 'clone', fx.fork, other);
    writeFileSync(join(other, 'conflict.txt'), 'someone else\n');
    git(other, 'add', 'conflict.txt');
    git(other, 'commit', '-m', 'diverging commit on the working copy');
    git(other, 'push', 'origin', 'main');
    const divergedSha = git(other, 'rev-parse', 'HEAD');

    const { deps } = await realDeps(fx, { mode: { mode: 'review', source: 'set' } });
    await expect(
      publishPromotion({ repoPath: fx.checkout, workspaceId: 'ws-test', sha: fx.promotedSha, ref: 'main' }, deps),
    ).rejects.toThrow(/push to the working copy failed/);
    expect(branchSha(fx.fork, 'main')).toBe(divergedSha);
    expect(branchSha(fx.upstream, 'main')).toBe(fx.baseSha);
  });
});
