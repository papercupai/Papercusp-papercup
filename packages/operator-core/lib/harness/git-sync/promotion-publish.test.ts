/**
 * pot-review-integration-mode P-020: publishPromotion — where green-checkpoint
 * publishes a promoted commit, and the standing-PR refresh that follows it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProjectEntry } from '../../harness-registry';
import type { PotIntegrationModeRead } from './pot-integration-mode';
import { githubOwnerOf, publishPromotion, type PublishPromotionDeps } from './promotion-push-target';
import type { StandingPrDeps } from './standing-pr';

const REPO = '/pots/acme';
const FORK = 'https://github.com/acme-bot/widgets.git';
const UPSTREAM = 'github.com/acme/widgets';
const SHA = 'a'.repeat(40);

function entry(over: Partial<Record<string, unknown>> = {}): ProjectEntry {
  return {
    slug: 'acme',
    path: REPO,
    self_repo: true,
    fork_remote: FORK,
    github_remote: UPSTREAM,
    ...over,
  } as unknown as ProjectEntry;
}

const PR_DEPS: StandingPrDeps = {
  listOpenPrs: vi.fn(),
  openPr: vi.fn(),
  pushHead: vi.fn(),
};

function deps(opts: {
  projects?: ProjectEntry[];
  mode?: PotIntegrationModeRead;
  pushError?: Error;
  prDeps?: StandingPrDeps | null;
} = {}) {
  const log = vi.fn();
  const pushToFork = vi.fn(async () => {
    if (opts.pushError) throw opts.pushError;
  });
  const ensureRemote = vi.fn(async () => 'unchanged');
  const publishStandingPr = vi.fn(async (_input: Record<string, unknown>, _prDeps: StandingPrDeps) => ({
    ok: true as const,
    decision: { action: 'open' as const, headSha: SHA, reason: 'opened' },
    prNumber: 7,
    prUrl: 'https://github.com/acme/widgets/pull/7',
  }));
  const d: PublishPromotionDeps = {
    loadProjects: async () => opts.projects ?? [entry()],
    readMode: async () => opts.mode ?? { mode: 'review', source: 'set' },
    canonical: (p) => p,
    ensureRemote,
    pushToFork,
    createStandingPrDeps: async () => (opts.prDeps === undefined ? PR_DEPS : opts.prDeps),
    publishStandingPr: publishStandingPr as unknown as PublishPromotionDeps['publishStandingPr'],
    log,
  };
  return { d, log, pushToFork, ensureRemote, publishStandingPr };
}

const INPUT = { repoPath: REPO, workspaceId: 'ws-1', sha: SHA, ref: 'main' };

describe('publishPromotion', () => {
  it('direct mode returns origin and touches no fork', async () => {
    const { d, pushToFork, publishStandingPr } = deps({ mode: { mode: 'direct', source: 'set' } });
    await expect(publishPromotion(INPUT, d)).resolves.toEqual({ kind: 'origin' });
    expect(pushToFork).not.toHaveBeenCalled();
    expect(publishStandingPr).not.toHaveBeenCalled();
  });

  it('an unowned checkout returns origin', async () => {
    const { d } = deps({ projects: [entry({ path: '/elsewhere' })] });
    await expect(publishPromotion(INPUT, d)).resolves.toEqual({ kind: 'origin' });
  });

  it('review mode pushes the tested sha to the fork main, then refreshes the standing PR', async () => {
    const { d, pushToFork, ensureRemote, publishStandingPr } = deps();
    const out = await publishPromotion(INPUT, d);
    expect(ensureRemote).toHaveBeenCalledWith(REPO, FORK);
    expect(pushToFork).toHaveBeenCalledWith(REPO, SHA, 'refs/heads/main');
    expect(publishStandingPr).toHaveBeenCalledTimes(1);
    expect(publishStandingPr.mock.calls[0]?.[0]).toMatchObject({
      forkRemote: FORK,
      forkOwner: 'acme-bot',
      upstreamRemote: UPSTREAM,
      upstreamOwner: 'acme',
      baseBranch: 'main',
      promotedSha: SHA,
      trigger: 'promotion',
    });
    expect(out).toMatchObject({ kind: 'fork', remoteRef: 'refs/heads/main', standingPr: { ok: true } });
  });

  it('D-056: a pot whose upstream branch is `staging` still pushes the fork main but opens the standing PR against upstream staging', async () => {
    const { d, pushToFork, publishStandingPr } = deps({ mode: { mode: 'review', source: 'set', upstreamBranch: 'staging' } });
    const out = await publishPromotion(INPUT, d);
    expect(pushToFork).toHaveBeenCalledWith(REPO, SHA, 'refs/heads/main');
    expect(publishStandingPr.mock.calls[0]?.[0]).toMatchObject({ baseBranch: 'staging', promotedSha: SHA });
    expect(out).toMatchObject({ kind: 'fork', remoteRef: 'refs/heads/main' });
  });

  it('review mode never falls back to origin when the fork push fails — it throws', async () => {
    const { d, publishStandingPr } = deps({ pushError: new Error('rejected') });
    await expect(publishPromotion(INPUT, d)).rejects.toThrow('rejected');
    expect(publishStandingPr).not.toHaveBeenCalled();
  });

  it('links source fixes only after a successful standing PR refresh, and retries bookkeeping without republishing a new PR', async () => {
    const { d, log, publishStandingPr } = deps();
    const record = vi.fn().mockRejectedValueOnce(new Error('tracker bookkeeping unavailable'))
      .mockResolvedValue({ linked: ['WI-fixed'], failed: [] });
    d.recordStandingPr = record;
    expect(await publishPromotion(INPUT, d)).toMatchObject({ kind: 'fork', standingPr: { ok: true } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('source linkage pending'));
    expect(await publishPromotion(INPUT, d)).toMatchObject({ kind: 'fork', standingPr: { ok: true } });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      sha: SHA, potHomeSlug: 'acme', prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7',
    }));
    publishStandingPr.mockRejectedValueOnce(new Error('host unavailable'));
    await publishPromotion(INPUT, d);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('an unreadable mode holds promotion (throws) instead of publishing', async () => {
    const { d, pushToFork } = deps({ mode: { mode: 'direct', source: 'error' } });
    await expect(publishPromotion(INPUT, d)).rejects.toThrow(/promotion held/);
    expect(pushToFork).not.toHaveBeenCalled();
  });

  it('review mode without a fork skips publication entirely', async () => {
    const { d, pushToFork } = deps({ projects: [entry({ fork_remote: undefined })] });
    const out = await publishPromotion(INPUT, d);
    expect(out.kind).toBe('skipped');
    expect(pushToFork).not.toHaveBeenCalled();
  });

  it('a missing PR host does not fail the promotion', async () => {
    const { d, pushToFork } = deps({ prDeps: null });
    const out = await publishPromotion(INPUT, d);
    expect(pushToFork).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: 'fork', standingPr: { ok: false, stage: 'setup' } });
  });

  it('a throwing standing-PR refresh is contained', async () => {
    const { d, publishStandingPr } = deps();
    publishStandingPr.mockRejectedValueOnce(new Error('api down'));
    const out = await publishPromotion(INPUT, d);
    expect(out).toMatchObject({ kind: 'fork', standingPr: { ok: false, error: 'api down' } });
  });
});

describe('publishPromotion with submodules (P-014 / D-017 §5)', () => {
  const SUB_SHA = 'b'.repeat(40);
  const SUB_FORK = 'https://github.com/acme-bot/lib.git';
  const SUB_UPSTREAM = 'https://github.com/acme/lib.git';
  const LINK = { path: 'libs/lib', sha: SUB_SHA, url: SUB_UPSTREAM, branch: 'main' };

  function subDeps(opts: {
    unpublished?: Array<typeof LINK>;
    findError?: string;
    forks?: Record<string, string>;
    forksSource?: 'set' | 'error';
    pushSubError?: Error;
  } = {}) {
    const base = deps();
    const order: string[] = [];
    base.pushToFork.mockImplementation(async () => {
      order.push('superproject');
    });
    const pushSubmoduleHead = vi.fn(async (_subDir: string, _fork: string, _sha: string, _branch: string) => {
      order.push('submodule');
      if (opts.pushSubError) throw opts.pushSubError;
    });
    const findUnpublishedGitlinks = vi.fn(async () =>
      opts.findError ? { ok: false as const, error: opts.findError } : { ok: true as const, unpublished: opts.unpublished ?? [LINK] },
    );
    const d: PublishPromotionDeps = {
      ...base.d,
      hasSubmodules: () => true,
      findUnpublishedGitlinks,
      readSubmoduleForks: async () => ({ source: opts.forksSource ?? 'set', forks: opts.forks ?? { 'libs/lib': SUB_FORK } }),
      pushSubmoduleHead,
    };
    return { ...base, d, order, pushSubmoduleHead, findUnpublishedGitlinks };
  }

  it('pushes each unpublished pin to its submodule fork BEFORE the superproject, then opens both PRs and links them', async () => {
    const { d, order, pushSubmoduleHead, findUnpublishedGitlinks, publishStandingPr } = subDeps();
    const out = await publishPromotion(INPUT, d);
    expect(findUnpublishedGitlinks).toHaveBeenCalledWith(REPO, SHA, 'main');
    expect(pushSubmoduleHead).toHaveBeenCalledWith(`${REPO}/libs/lib`, SUB_FORK, SUB_SHA, 'papercusp/working-copy');
    expect(order).toEqual(['submodule', 'superproject']);
    expect(publishStandingPr).toHaveBeenCalledTimes(2);
    expect(publishStandingPr.mock.calls[0]?.[0]).toMatchObject({
      forkRemote: SUB_FORK,
      forkOwner: 'acme-bot',
      upstreamRemote: SUB_UPSTREAM,
      upstreamOwner: 'acme',
      baseBranch: 'main',
      promotedSha: SUB_SHA,
    });
    // The superproject PR names the submodule PR it depends on.
    expect(publishStandingPr.mock.calls[1]?.[0]).toMatchObject({
      forkRemote: FORK,
      promotedSha: SHA,
      relatedPrs: [{ path: 'libs/lib', sha: SUB_SHA, url: 'https://github.com/acme/widgets/pull/7' }],
    });
    expect(out).toMatchObject({ kind: 'fork', submodulePrs: [{ path: 'libs/lib', sha: SUB_SHA, standingPr: { ok: true } }] });
  });

  it('D-056: judges submodule pins against the pot’s upstream branch, not the fork ref pushed', async () => {
    const { d, findUnpublishedGitlinks, publishStandingPr } = subDeps();
    d.readMode = async () => ({ mode: 'review', source: 'set', upstreamBranch: 'staging' });
    await publishPromotion(INPUT, d);
    expect(findUnpublishedGitlinks).toHaveBeenCalledWith(REPO, SHA, 'staging');
    // The submodule PR still targets the submodule's own branch; only the superproject PR moves.
    expect(publishStandingPr.mock.calls[0]?.[0]).toMatchObject({ baseBranch: 'main', promotedSha: SUB_SHA });
    expect(publishStandingPr.mock.calls[1]?.[0]).toMatchObject({ baseBranch: 'staging', promotedSha: SHA });
  });

  it('publishes no submodule PR when every pin is already on its main repository', async () => {
    const { d, pushSubmoduleHead, publishStandingPr } = subDeps({ unpublished: [] });
    const out = await publishPromotion(INPUT, d);
    expect(pushSubmoduleHead).not.toHaveBeenCalled();
    expect(publishStandingPr).toHaveBeenCalledTimes(1);
    expect(out).not.toHaveProperty('submodulePrs');
  });

  it.each([
    ['a submodule push is rejected', { pushSubError: new Error('non-fast-forward') }, /submodule_publish_failed/],
    ['the pins cannot be verified', { findError: 'fetch failed' }, /submodule_pins_unverifiable/],
    ['the pot has no fork of the submodule', { forks: {} }, /submodule_fork_missing/],
    ['the submodule forks cannot be read', { forksSource: 'error' as const }, /submodule_forks_unreadable/],
  ])('holds the promotion — the superproject is never pushed — when %s', async (_why, opts, reason) => {
    const { d, pushToFork, publishStandingPr } = subDeps(opts);
    await expect(publishPromotion(INPUT, d)).rejects.toThrow(reason);
    expect(pushToFork).not.toHaveBeenCalled();
    expect(publishStandingPr).not.toHaveBeenCalled();
  });

  it('holds the promotion for a checkout with submodules when no submodule publisher is wired', async () => {
    const { d, pushToFork } = deps();
    await expect(publishPromotion(INPUT, { ...d, hasSubmodules: () => true })).rejects.toThrow(/submodule_publish_unavailable/);
    expect(pushToFork).not.toHaveBeenCalled();
  });
});

describe('githubOwnerOf', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme'],
    ['git@github.com:acme/widgets.git', 'acme'],
    ['github.com/acme/widgets', 'acme'],
    ['https://gitlab.com/acme/widgets', null],
  ])('%s -> %s', (remote, owner) => {
    expect(githubOwnerOf(remote)).toBe(owner);
  });
});
