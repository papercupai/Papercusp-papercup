import { describe, expect, it } from 'vitest';
import type { Pr, PrHostResult } from '../../pr-host/types';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import {
  findStandingPr,
  publishStandingPr,
  standingPrBody,
  type PublishStandingPrInput,
  type StandingPrDeps,
} from './standing-pr';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function pr(over: Partial<Pr> & { number: number }): Pr {
  const { number, ...rest } = over;
  return {
    ref: { remote: 'github.com/up/repo', number },
    state: 'open',
    title: 't',
    body: null,
    head_ref: STANDING_PR_BRANCH,
    base_ref: 'main',
    head_sha: SHA_A,
    // The pot's own fork (input().forkRemote) unless a case says otherwise.
    head_repo: 'potbot/repo',
    merge_commit_sha: null,
    author: { github_user_id: 1, github_login: 'bot' },
    reviewers_requested: [],
    review_decision: 'none',
    checks_state: 'none',
    mergeable_state: 'unknown',
    is_draft: false,
    url: `https://github.com/up/repo/pull/${number}`,
    updated_at: 0,
    ...rest,
  } as Pr;
}

function input(over: Partial<PublishStandingPrInput> = {}): PublishStandingPrInput {
  return {
    integration: { mode: 'review', source: 'set' },
    forkRemote: 'https://github.com/potbot/repo.git',
    forkOwner: 'potbot',
    upstreamRemote: 'github.com/up/repo',
    upstreamOwner: 'up',
    baseBranch: 'main',
    promotedSha: SHA_B,
    trigger: 'promotion',
    potName: 'demo',
    ...over,
  };
}

function fakeDeps(opts: {
  open?: Pr[];
  listFails?: boolean;
  pushFails?: string;
  openFails?: boolean;
} = {}) {
  const calls: { list: number; push: Array<{ sha: string; branch: string }>; open: unknown[] } = {
    list: 0,
    push: [],
    open: [],
  };
  const deps: StandingPrDeps = {
    async listOpenPrs() {
      calls.list++;
      if (opts.listFails) return { ok: false, error: { kind: 'network_error', message: 'boom' } } as PrHostResult<Pr[]>;
      return { ok: true, data: opts.open ?? [] };
    },
    async openPr(args) {
      calls.open.push(args);
      if (opts.openFails) return { ok: false, error: { kind: 'unauthorized', message: 'no' } } as PrHostResult<Pr>;
      return { ok: true, data: pr({ number: 42, head_sha: SHA_B }) };
    },
    async pushHead(args) {
      calls.push.push(args);
      if (opts.pushFails) throw new Error(opts.pushFails);
    },
  };
  return { deps, calls };
}

describe('publishStandingPr', () => {
  it('a direct pot touches nothing — no listing, no push, no PR', async () => {
    const { deps, calls } = fakeDeps();
    const res = await publishStandingPr(input({ integration: { mode: 'direct', source: 'set' } }), deps);
    expect(res).toMatchObject({ ok: true, decision: { action: 'skip', reason: 'not-working-copy' } });
    expect(calls).toEqual({ list: 0, push: [], open: [] });
  });

  it('an unreadable mode fails closed without network', async () => {
    const { deps, calls } = fakeDeps();
    const res = await publishStandingPr(input({ integration: { mode: 'direct', source: 'error' } }), deps);
    expect(res).toMatchObject({ ok: true, decision: { action: 'skip', reason: 'mode-unknown' } });
    expect(calls.list).toBe(0);
  });

  it('no standing PR yet: pushes the promoted sha to the standing branch, then opens a cross-fork PR', async () => {
    const { deps, calls } = fakeDeps({ open: [pr({ number: 7, head_ref: 'feature/x' })] });
    const res = await publishStandingPr(input(), deps);
    expect(res).toMatchObject({ ok: true, decision: { action: 'open' }, prNumber: 42 });
    expect(calls.push).toEqual([{ sha: SHA_B, branch: STANDING_PR_BRANCH }]);
    expect(calls.open).toEqual([
      expect.objectContaining({
        remote: 'github.com/up/repo',
        head_ref: STANDING_PR_BRANCH,
        base_ref: 'main',
        head_owner: 'potbot',
      }),
    ]);
  });

  it('same-owner fork opens without head_owner', async () => {
    const { deps, calls } = fakeDeps();
    await publishStandingPr(input({ forkOwner: 'up' }), deps);
    expect(calls.open[0]).not.toHaveProperty('head_owner');
  });

  it('an open standing PR on an older sha is updated by pushing only', async () => {
    const { deps, calls } = fakeDeps({ open: [pr({ number: 9, head_sha: SHA_A })] });
    const res = await publishStandingPr(input(), deps);
    expect(res).toMatchObject({ ok: true, decision: { action: 'update', fromSha: SHA_A, headSha: SHA_B }, prNumber: 9 });
    expect(calls.push).toEqual([{ sha: SHA_B, branch: STANDING_PR_BRANCH }]);
    expect(calls.open).toEqual([]);
  });

  it('an open standing PR already at the promoted sha is a noop', async () => {
    const { deps, calls } = fakeDeps({ open: [pr({ number: 9, head_sha: SHA_B })] });
    const res = await publishStandingPr(input(), deps);
    expect(res).toMatchObject({ ok: true, decision: { action: 'noop' }, prNumber: 9 });
    expect(calls.push).toEqual([]);
  });

  it('a failed listing never opens a (possibly duplicate) PR', async () => {
    const { deps, calls } = fakeDeps({ listFails: true });
    const res = await publishStandingPr(input(), deps);
    expect(res).toMatchObject({ ok: false, stage: 'list' });
    expect(calls.push).toEqual([]);
    expect(calls.open).toEqual([]);
  });

  it('a rejected push is reported (token redacted) and no PR is opened', async () => {
    const { deps, calls } = fakeDeps({ pushFails: 'rejected https://x-access-token:ghs_SECRET123@github.com/potbot/repo.git' });
    const res = await publishStandingPr(input(), deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe('push');
    expect(res.error).not.toContain('ghs_SECRET123');
    expect(calls.open).toEqual([]);
  });

  it('a failed open is reported as stage open', async () => {
    const { deps } = fakeDeps({ openFails: true });
    const res = await publishStandingPr(input(), deps);
    expect(res).toMatchObject({ ok: false, stage: 'open' });
  });
});

describe('findStandingPr', () => {
  it('matches head branch + base branch + open, lowest number first', () => {
    const prs = [
      pr({ number: 12 }),
      pr({ number: 5 }),
      pr({ number: 3, base_ref: 'develop' }),
      pr({ number: 2, head_ref: 'other' }),
      pr({ number: 1, state: 'closed' }),
    ];
    expect(findStandingPr(prs, { baseBranch: 'main' })?.ref.number).toBe(5);
    expect(findStandingPr([], { baseBranch: 'main' })).toBeNull();
  });

  // WI-10006271: every working copy pushes the same branch name, so two pots forking one main
  // repository each have an open PR with head_ref === STANDING_PR_BRANCH. Only the PR whose head
  // lives in THIS pot's fork is its standing PR.
  it('with forkRepo, matches only the PR whose head lives in that fork (case-insensitive)', () => {
    const prs = [
      pr({ number: 3, head_repo: 'otherbot/repo' }),
      pr({ number: 8, head_repo: 'PotBot/Repo' }),
      pr({ number: 11, head_repo: 'potbot/repo' }),
    ];
    expect(findStandingPr(prs, { forkRepo: 'potbot/repo' })?.ref.number).toBe(8);
    expect(findStandingPr(prs, { forkRepo: 'otherbot/repo' })?.ref.number).toBe(3);
    expect(findStandingPr(prs, { forkRepo: 'thirdbot/repo' })).toBeNull();
    // No forkRepo: the head ref alone, lowest number (the pre-fix reading, kept for unknown forks).
    expect(findStandingPr(prs)?.ref.number).toBe(3);
  });

  it('a PR with no reported head repository is excluded by default and counted with include', () => {
    const prs = [pr({ number: 4, head_repo: null }), pr({ number: 6, head_repo: undefined })];
    expect(findStandingPr(prs, { forkRepo: 'potbot/repo' })).toBeNull();
    expect(findStandingPr(prs, { forkRepo: 'potbot/repo', unknownHeadRepo: 'include' })?.ref.number).toBe(4);
  });
});

describe('publishStandingPr across forks (WI-10006271)', () => {
  it("another pot's open PR on the same branch name is not adopted: this pot opens its own", async () => {
    const theirs = pr({ number: 5, head_repo: 'otherbot/repo', head_sha: SHA_A });
    const { deps, calls } = fakeDeps({ open: [theirs] });
    const res = await publishStandingPr(input(), deps);
    expect(res).toMatchObject({ ok: true, decision: { action: 'open' }, prNumber: 42 });
    expect(calls.open).toHaveLength(1);
  });

  it("this pot's PR is found even when another pot's lower-numbered PR shares the branch name", async () => {
    const theirs = pr({ number: 5, head_repo: 'otherbot/repo', head_sha: SHA_A });
    const ours = pr({ number: 9, head_repo: 'potbot/repo', head_sha: SHA_A });
    const { deps, calls } = fakeDeps({ open: [theirs, ours] });
    const res = await publishStandingPr(input(), deps);
    expect(res).toMatchObject({ ok: true, decision: { action: 'update', fromSha: SHA_A, headSha: SHA_B }, prNumber: 9 });
    expect(calls.open).toEqual([]);
  });

  it('a PR whose head repository is unreported is never adopted as the standing PR', async () => {
    const { deps, calls } = fakeDeps({ open: [pr({ number: 5, head_repo: null })] });
    const res = await publishStandingPr(input(), deps);
    expect(res).toMatchObject({ ok: true, decision: { action: 'open' } });
    expect(calls.open).toHaveLength(1);
  });
});

describe('standingPrBody with submodule PRs (P-014 / D-017 §5)', () => {
  it('names each submodule PR and says to merge them first; omits the section when there are none', () => {
    const body = standingPrBody('Acme', 'abcdef0123456789', [
      { path: 'libs/lib', sha: '0123456789abcdef', url: 'https://github.com/acme/lib/pull/3' },
      { path: 'libs/other', sha: 'fedcba9876543210' },
    ]);
    expect(body).toMatch(/Merge these submodule pull requests first/);
    expect(body).toContain('- `libs/lib` @ `0123456789ab`: https://github.com/acme/lib/pull/3');
    expect(body).toContain('- `libs/other` @ `fedcba987654`: pull request not opened yet');
    expect(standingPrBody('Acme', 'abcdef0123456789', [])).not.toMatch(/submodule/);
  });
});

describe('standingPrBody', () => {
  it('asks for a merge commit, because sync-back recognises merged work by commit id (P-016)', () => {
    const body = standingPrBody('Acme', 'abcdef0123456789');
    expect(body).toContain('Create a merge commit');
    expect(body).toMatch(/not "Squash and merge"/);
    expect(body).toContain('abcdef012345');
  });
});
