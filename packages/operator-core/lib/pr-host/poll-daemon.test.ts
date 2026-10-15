/**
 * poll-daemon tests (PR-1 / P-042). Teeth-verified against the brief's S0 + the
 * idempotency / crash-resume properties. All I/O is faked (host + store + seams) —
 * the orchestration, gate, idempotency, and backoff are exercised with no GitHub /
 * PG / DBOS. `@papercusp/db-org` is mocked so the audit writes inside
 * tryAutoApprove/tryAutoMerge are inert.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: Object.assign(() => Promise.resolve([]), { unsafe: vi.fn().mockResolvedValue([]) }) }),
  // pr-poll-routine.ts imports these at module load; not used in these tests.
  upsertRoutine: vi.fn(),
  setRoutineActive: vi.fn(),
  deleteRoutine: vi.fn(),
}));

import {
  pollHarnessPrs,
  backoffMsFor,
  parsePollMeta,
  handlePrPoll,
  type PollStore,
  type PollDaemonDeps,
  type ReviewerSettingsRow,
  type PollChecks,
} from './poll-daemon';
import { getSystemAction } from '../harness/routines/system-actions';
import { DEFAULT_RETRY_POLICY } from './retry-policy-types';
import { STANDING_PR_BRANCH } from '../harness/git-sync/decide-standing-pr';
import type { StandingPrMergeOutcome } from '../harness/git-sync/standing-pr-merge';
import type { Pr, PrHost, PrHostResult, PrChecksState } from './types';
import { ok, err } from './types';

const VIEWER = { id: 1, login: 'operator' };
const TRUSTED_AUTHOR = 999;

function makePr(overrides: Partial<Pr> = {}): Pr {
  return {
    ref: { remote: 'github.com/owner/repo', number: 42 },
    state: 'open',
    title: 'Add a feature',
    body: null,
    head_ref: 'feat/x',
    base_ref: 'main',
    head_sha: 'a'.repeat(40),
    merge_commit_sha: null,
    author: { github_user_id: TRUSTED_AUTHOR, github_login: 'alice' },
    reviewers_requested: [],
    review_decision: 'none',
    checks_state: 'unknown',
    mergeable_state: 'mergeable',
    is_draft: false,
    url: 'https://github.com/owner/repo/pull/42',
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

interface HostOpts {
  /** PRs returned by listOpenPrs (shallow — review_decision none, checks unknown). */
  open?: Pr[];
  /** listOpenPrs error (overrides `open`). */
  listError?: ReturnType<typeof err>;
  /** getPr result per number (the enriched detail). Defaults to the shallow pr. */
  detail?: Record<number, Pr>;
  /** getPr error per number. */
  detailError?: Record<number, ReturnType<typeof err>>;
}

function makeHost(opts: HostOpts = {}) {
  const open = opts.open ?? [makePr()];
  const postReview = vi.fn(async (): Promise<PrHostResult<void>> => ok(undefined));
  const merge = vi.fn(
    async (): Promise<PrHostResult<{ merge_commit_sha: string }>> => ok({ merge_commit_sha: 'merged-sha' }),
  );
  const getPr = vi.fn(async (ref: { number: number }): Promise<PrHostResult<Pr>> => {
    if (opts.detailError?.[ref.number]) return opts.detailError[ref.number];
    const d = opts.detail?.[ref.number] ?? open.find((p) => p.ref.number === ref.number);
    return d ? ok(d) : err({ kind: 'not_found', message: 'gone' });
  });
  const listOpenPrs = vi.fn(
    async (): Promise<PrHostResult<Pr[]>> => (opts.listError ? opts.listError : ok(open)),
  );
  const host: PrHost = {
    kind: 'github',
    openPr: vi.fn(),
    getPr,
    getPrDiff: vi.fn(),
    postReview,
    merge,
    listOpenPrs,
  } as unknown as PrHost;
  return { host, postReview, merge, getPr, listOpenPrs };
}

interface StoreOpts {
  settings?: ReviewerSettingsRow | null;
  trust?: number[];
  meta?: Record<string, unknown>;
}

function makeStore(opts: StoreOpts = {}) {
  const metaObj: Record<string, unknown> = { ...(opts.meta ?? {}) };
  const settings: ReviewerSettingsRow | null =
    opts.settings === undefined
      ? { pr_reviewer_role_enabled: true, auto_review: true, auto_merge: true, merge_method: 'squash' }
      : opts.settings;
  const calls = {
    upsertFeaturePr: [] as Array<{ pr: Pr }>,
    refreshChecks: [] as Array<{ headSha: string; runs: unknown[] }>,
    patchMeta: [] as Array<Record<string, unknown>>,
    setNextFireAt: [] as Date[],
  };
  const store: PollStore = {
    async readSettings() {
      return settings;
    },
    async readTrust() {
      return new Set(opts.trust ?? [TRUSTED_AUTHOR]);
    },
    async readMeta() {
      return parsePollMeta(metaObj);
    },
    async patchMeta(_slug, patch) {
      calls.patchMeta.push(patch);
      Object.assign(metaObj, patch); // shallow merge — mirrors the SQL `||`.
    },
    async setNextFireAt(_slug, at) {
      calls.setNextFireAt.push(at);
    },
    async upsertFeaturePr(a) {
      calls.upsertFeaturePr.push({ pr: a.pr });
    },
    async refreshChecks(a) {
      calls.refreshChecks.push({ headSha: a.headSha, runs: a.runs });
    },
  };
  return { store, calls, metaObj };
}

function checksOf(state: PrChecksState): (remote: string, headSha: string) => Promise<PrHostResult<PollChecks>> {
  return async () => ok({ state, runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: state === 'success' ? 'success' : 'failure', details_url: null, started_at: null, completed_at: null }] });
}

/** Base deps: trusted author, green checks, a present APPROVE report, fixed clock.
 *  Gap 2 (su-pr2 handoff): the daemon now REQUIRES a present approve report to
 *  auto-approve (an absent report ⇒ defer, not proceed) — so the happy-path /
 *  idempotency tests supply an approve report by default; the deferral tests
 *  override readReport to null. */
function baseDeps(host: PrHost, store: PollStore, over: Partial<PollDaemonDeps> = {}): PollDaemonDeps {
  return {
    store,
    createHost: async () => host,
    fetchChecks: checksOf('success'),
    resolveViewer: async () => VIEWER,
    triggerReviewer: vi.fn(async () => {}),
    readReport: async () => ({ recommendation: 'approve' as const }),
    isAuthorRevoked: async () => false, // PR-5: not revoked by default; revocation tests override.
    stampMerge: vi.fn(async () => {}), // PR-5: post-merge WI→shipped stamp; spied in the stamp test.
    now: () => 1_700_000_500_000,
    random: () => 0.5,
    ...over,
  };
}

const ARGS = { installSlug: 'papercup', workspaceId: 'ws1', remote: 'github.com/owner/repo' };

describe('pollHarnessPrs — happy path (the autonomous loop)', () => {
  it('auto mode + trusted + checks green → triggers reviewer, tracks, approves AND merges', async () => {
    const { host, postReview, merge } = makeHost();
    const { store, calls } = makeStore();
    const trigger = vi.fn(async () => {});
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { triggerReviewer: trigger }));

    expect(out.status).toBe('ok');
    expect(out.triggered).toEqual([42]);
    expect(out.approved).toEqual([42]);
    expect(out.merged).toEqual([42]);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    // (a) WI↔PR row upserted; (b) check cache refreshed.
    expect(calls.upsertFeaturePr).toHaveLength(1);
    expect(calls.refreshChecks).toHaveLength(1);
    // last-seen snapshot persisted (crash-resume substrate).
    const seen = parsePollMeta(store ? (calls.patchMeta.at(-1) as Record<string, unknown>) : {});
    expect(seen.last_seen['42']).toEqual({ updated_at: 1_700_000_000_000, head_sha: 'a'.repeat(40) });
  });

  it('manual mode (auto_review off) → triggers reviewer + tracks, but never approves/merges', async () => {
    const { host, postReview, merge } = makeHost();
    const { store } = makeStore({
      settings: { pr_reviewer_role_enabled: true, auto_review: false, auto_merge: false, merge_method: 'squash' },
    });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.triggered).toEqual([42]); // reviewer still triggered for the human's report
    expect(out.approved).toEqual([]);
    expect(out.merged).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('auto-approve-only (auto_merge off) → approves but does NOT merge', async () => {
    const { host, postReview, merge } = makeHost();
    const { store } = makeStore({
      settings: { pr_reviewer_role_enabled: true, auto_review: true, auto_merge: false, merge_method: 'squash' },
    });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.approved).toEqual([42]);
    expect(out.merged).toEqual([]);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('pollHarnessPrs — autonomous merge completes WI→shipped tracking (PR-5)', () => {
  it('TEETH: an auto-merge fires stampMerge (completion_ref + WI↔PR row) with the PR + merge sha', async () => {
    const { host } = makeHost();
    const { store } = makeStore();
    const stampMerge = vi.fn(
      async (_a: { workspaceId: string; installSlug: string; remote: string; pr: Pr; mergeCommitSha: string }) => {},
    );
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { stampMerge }));
    expect(out.merged).toEqual([42]);
    expect(stampMerge).toHaveBeenCalledTimes(1);
    expect(stampMerge.mock.calls[0]![0]).toMatchObject({
      installSlug: 'papercup',
      remote: 'github.com/owner/repo',
      mergeCommitSha: 'merged-sha',
    });
    expect(stampMerge.mock.calls[0]![0].pr.ref.number).toBe(42);
  });

  it('does NOT stamp when no merge happens (auto_merge off → approve only)', async () => {
    const { host } = makeHost();
    const { store } = makeStore({
      settings: { pr_reviewer_role_enabled: true, auto_review: true, auto_merge: false, merge_method: 'squash' },
    });
    const stampMerge = vi.fn(async () => {});
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { stampMerge }));
    expect(out.merged).toEqual([]);
    expect(stampMerge).not.toHaveBeenCalled();
  });
});

describe('pollHarnessPrs — S0 safety gates', () => {
  it('checks RED → never merges (even in auto mode for a trusted author)', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { fetchChecks: checksOf('failure') }));
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });

  it('checks PENDING → never merges', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { fetchChecks: checksOf('pending') }));
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });

  it('checks-fetch ERROR → fails closed, never merges (a checks-API failure must not auto-merge)', async () => {
    // If fetchChecks itself errors, checks_state stays 'unknown' (from getPr), so
    // decideAutoReview yields 'approve' (not approve_and_merge) and tryAutoMerge is
    // never reached. This is the fail-CLOSED safety leg — distinct from a reported
    // failure/pending state — that a checks-API outage can never sneak a merge past.
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const out = await pollHarnessPrs(
      ARGS,
      baseDeps(host, store, { fetchChecks: async () => err({ kind: 'server_error', message: 'checks api down' }) }),
    );
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });

  it('untrusted author → never approves or merges', async () => {
    const { host, postReview, merge } = makeHost({ open: [makePr({ author: { github_user_id: 888, github_login: 'mallory' } })] });
    const { store } = makeStore({ trust: [TRUSTED_AUTHOR] });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.triggered).toEqual([42]); // noticed + reviewer-triggered…
    expect(out.approved).toEqual([]); // …but never auto-approved
    expect(out.merged).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('self-authored PR → never auto-approves (the agent never self-approves)', async () => {
    const selfPr = makePr({ author: { github_user_id: VIEWER.id, github_login: VIEWER.login } });
    const { host, postReview, merge } = makeHost({ open: [selfPr] });
    const { store } = makeStore({ trust: [VIEWER.id] }); // even if "trusted"
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.approved).toEqual([]);
    expect(out.merged).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('draft PR → never merges', async () => {
    const { host, merge } = makeHost({ open: [makePr({ is_draft: true })] });
    const { store } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });

  it('not_mergeable → approves but never merges', async () => {
    const { host, merge } = makeHost({ detail: { 42: makePr({ mergeable_state: 'not_mergeable' }) } });
    const { store } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('pollHarnessPrs — PR-5 contributor revocation (S0)', () => {
  it('TEETH: a REVOKED author is refused the auto-flow — never approves/merges, even trusted + green', async () => {
    const { host, postReview, merge } = makeHost();
    const { store } = makeStore(); // trusted author, auto on
    const out = await pollHarnessPrs(
      ARGS,
      baseDeps(host, store, { isAuthorRevoked: async () => true }),
    );
    expect(out.revoked).toEqual([42]);
    expect(out.approved).toEqual([]);
    expect(out.merged).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('revocation overrides a green PR-2 approve report (revocation is the strongest deny)', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const out = await pollHarnessPrs(
      ARGS,
      baseDeps(host, store, {
        isAuthorRevoked: async () => true,
        readReport: async () => ({ recommendation: 'approve' }),
      }),
    );
    expect(out.revoked).toEqual([42]);
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });

  it('a non-revoked author proceeds normally (the gate is off by default)', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { isAuthorRevoked: async () => false }));
    expect(out.revoked).toEqual([]);
    expect(out.merged).toEqual([42]);
  });
});

describe('pollHarnessPrs — PR-2 first-sight race (Gap 2, su-pr2 handoff)', () => {
  it('TEETH: an ABSENT report (review in flight) DEFERS — never auto-approves before the agent reviews', async () => {
    const { host, postReview, merge } = makeHost();
    const { store } = makeStore(); // trusted author, auto on, green checks
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { readReport: async () => null }));
    expect(out.awaitingReview).toEqual([42]);
    expect(out.approved).toEqual([]);
    expect(out.merged).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('TEETH: a deferred PR is EXCLUDED from last_seen → re-processed next poll, then merges once the report lands', async () => {
    const { host, merge } = makeHost();
    const { store, calls } = makeStore();
    // Poll 1: no report yet → defer (no merge), and NOT recorded in last_seen.
    const first = await pollHarnessPrs(ARGS, baseDeps(host, store, { readReport: async () => null }));
    expect(first.awaitingReview).toEqual([42]);
    expect(merge).not.toHaveBeenCalled();
    const seenAfter1 = parsePollMeta(calls.patchMeta.at(-1) as Record<string, unknown>);
    expect(seenAfter1.last_seen['42']).toBeUndefined(); // excluded → re-checked next poll

    // Poll 2: the report has landed (approve) → the SAME store re-processes (not skipped) → merges.
    const second = await pollHarnessPrs(ARGS, baseDeps(host, store, { readReport: async () => ({ recommendation: 'approve' }) }));
    expect(second.prsProcessed).toBe(1); // re-processed (the deferred PR was not in last_seen)
    expect(second.merged).toEqual([42]);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('TEETH (staleness): the gate reads the report scoped to the CURRENT head_sha → a stale report defers, not merges', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    // A reader that only has a report for SOME OTHER commit (returns null for the PR's
    // current head_sha) — models a stale report after a force-push.
    const readReport = vi.fn(async ({ headSha }: { headSha?: string }) =>
      headSha === 'a'.repeat(40) ? null : ({ recommendation: 'approve' as const }),
    );
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { readReport }));
    // The daemon passed the PR's CURRENT head_sha to the reader (engages the staleness filter)…
    expect(readReport).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'a'.repeat(40) }));
    // …and a stale-for-that-sha report reads as absent ⇒ defer (re-review), never merge.
    expect(out.awaitingReview).toEqual([42]);
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('pollHarnessPrs — PR-2 report veto', () => {
  it('request_changes report → blocks the auto path (no approve, no merge)', async () => {
    const { host, postReview, merge } = makeHost();
    const { store } = makeStore();
    const out = await pollHarnessPrs(
      ARGS,
      baseDeps(host, store, { readReport: async () => ({ recommendation: 'request_changes' }) }),
    );
    expect(out.vetoed).toEqual([42]);
    expect(out.approved).toEqual([]);
    expect(out.merged).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('approve report → auto path proceeds to merge', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const out = await pollHarnessPrs(
      ARGS,
      baseDeps(host, store, { readReport: async () => ({ recommendation: 'approve' }) }),
    );
    expect(out.vetoed).toEqual([]);
    expect(out.merged).toEqual([42]);
    expect(merge).toHaveBeenCalledTimes(1);
  });
});

describe('pollHarnessPrs — idempotency + crash-resume', () => {
  it('re-poll of an unchanged PR is a no-op (last-seen guard) — single merge across two ticks', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const deps = baseDeps(host, store);

    const first = await pollHarnessPrs(ARGS, deps);
    expect(first.merged).toEqual([42]);
    expect(merge).toHaveBeenCalledTimes(1);

    // Second tick: same store (last_seen persisted), same PR fingerprint → skipped.
    const second = await pollHarnessPrs(ARGS, deps);
    expect(second.prsProcessed).toBe(0);
    expect(second.merged).toEqual([]);
    expect(merge).toHaveBeenCalledTimes(1); // STILL once — no double-merge.
  });

  it('restart resumes from persisted last-seen (fresh store seeded from prior metadata)', async () => {
    // First operator instance.
    const inst1 = makeStore();
    await pollHarnessPrs(ARGS, baseDeps(makeHost().host, inst1.store));
    const persisted = { ...inst1.metaObj }; // what landed in routines.metadata->'pr_poll'

    // "Restart": a brand-new store hydrated from the persisted metadata.
    const { host, merge } = makeHost();
    const inst2 = makeStore({ meta: persisted });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, inst2.store));
    expect(out.prsProcessed).toBe(0); // already handled before the restart
    expect(merge).not.toHaveBeenCalled();
  });

  it('a CHANGED PR (new head_sha) re-processes after a prior poll', async () => {
    const inst = makeStore();
    await pollHarnessPrs(ARGS, baseDeps(makeHost().host, inst.store));

    const moved = makePr({ head_sha: 'b'.repeat(40), updated_at: 1_700_000_100_000 });
    const { host, merge } = makeHost({ open: [moved], detail: { 42: moved } });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, inst.store));
    expect(out.prsProcessed).toBe(1);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('TEETH: state-level idempotency holds — re-review of an already-approved PR never re-merges, even with the last-seen guard neutered', async () => {
    // GitHub now reports the PR as approved (because we approved it last tick).
    const approved = makePr({ review_decision: 'approved' });
    const { host, merge } = makeHost({ open: [approved], detail: { 42: approved } });
    const { store } = makeStore();
    const out = await pollHarnessPrs({ ...ARGS, ignoreLastSeen: true }, baseDeps(host, store));
    expect(out.merged).toEqual([]); // decideAutoReview → already_approved → skip
    expect(merge).not.toHaveBeenCalled();
  });

  it('TEETH (RED proof): with BOTH the last-seen guard AND the host-state idempotency removed, a re-poll DOES double-fire — proving the guard is load-bearing', async () => {
    // Same PR re-returned as still-open/unapproved (host state NOT reflecting our
    // prior approval) AND ignoreLastSeen=true. This is the regression the idempotency
    // tests above would catch: it MUST merge twice here, so the guard's presence in
    // the real path is what prevents it.
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const deps = baseDeps(host, store);
    await pollHarnessPrs({ ...ARGS, ignoreLastSeen: true }, deps);
    await pollHarnessPrs({ ...ARGS, ignoreLastSeen: true }, deps);
    expect(merge).toHaveBeenCalledTimes(2);
  });
});

describe('pollHarnessPrs — gating / skips', () => {
  it('no gh auth (viewer unresolved) → skipped', async () => {
    const { host, listOpenPrs } = makeHost();
    const { store } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { resolveViewer: async () => null }));
    expect(out.status).toBe('skipped');
    expect(out.reason).toBe('gh_unauth');
    expect(listOpenPrs).not.toHaveBeenCalled();
  });

  it('reviewer role disabled → skipped without listing', async () => {
    const { host, listOpenPrs } = makeHost();
    const { store } = makeStore({
      settings: { pr_reviewer_role_enabled: false, auto_review: true, auto_merge: true, merge_method: 'squash' },
    });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.status).toBe('skipped');
    expect(out.reason).toBe('role_disabled');
    expect(listOpenPrs).not.toHaveBeenCalled();
  });

  it('no settings row → skipped (role_disabled)', async () => {
    const { host } = makeHost();
    const { store } = makeStore({ settings: null });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.status).toBe('skipped');
    expect(out.reason).toBe('role_disabled');
  });

  it('getPr error on one PR skips it but keeps polling the rest', async () => {
    const pr1 = makePr({ ref: { remote: 'github.com/owner/repo', number: 1 } });
    const pr2 = makePr({ ref: { remote: 'github.com/owner/repo', number: 2 }, head_sha: 'c'.repeat(40) });
    const { host, merge } = makeHost({
      open: [pr1, pr2],
      detail: { 2: pr2 },
      detailError: { 1: err({ kind: 'server_error', message: 'boom' }) },
    });
    const { store } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.prsProcessed).toBe(2);
    expect(out.merged).toEqual([2]); // #1 skipped on getPr error, #2 merged
    expect(merge).toHaveBeenCalledTimes(1);
  });
});

describe('pollHarnessPrs — error backoff (P-042c/d/e)', () => {
  it('5xx on listOpenPrs → error status + exponential backoff + next_fire_at pushed out', async () => {
    const { host } = makeHost({ listError: err({ kind: 'server_error', message: '503' }) });
    const { store, calls } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.status).toBe('error');
    expect(out.error?.kind).toBe('server_error');
    expect(out.backoffMs).toBeGreaterThan(0);
    expect(calls.setNextFireAt).toHaveLength(1);
    // consecutive_errors incremented from 0 → 1.
    expect(calls.patchMeta.at(-1)).toMatchObject({ consecutive_errors: 1, last_status: 'error' });
  });

  it('429 with retry_after honors the rate-limit reset window', async () => {
    const { host } = makeHost({ listError: err({ kind: 'rate_limited', message: 'slow down', retry_after_ms: 90_000 }) });
    const { store } = makeStore();
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.status).toBe('error');
    expect(out.backoffMs).toBe(90_000);
  });

  it('terminal error (forbidden) backs off to the 5-min cap', async () => {
    const { host } = makeHost({ listError: err({ kind: 'forbidden', message: 'nope' }) });
    const { store, calls } = makeStore({ meta: { consecutive_errors: 3 } });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.status).toBe('error');
    expect(out.backoffMs).toBe(DEFAULT_RETRY_POLICY.max_backoff_ms);
    expect(calls.patchMeta.at(-1)).toMatchObject({ consecutive_errors: 4 });
  });

  it('a clean tick after errors resets consecutive_errors to 0', async () => {
    const { host } = makeHost();
    const { store, calls } = makeStore({ meta: { consecutive_errors: 5 } });
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store));
    expect(out.status).toBe('ok');
    expect(calls.patchMeta.at(-1)).toMatchObject({ consecutive_errors: 0, last_status: 'ok' });
  });
});

describe('backoffMsFor', () => {
  it('caps wait at max_backoff', () => {
    expect(backoffMsFor({ kind: 'wait', delay_ms: 10 * 60_000, reason: 'exponential_backoff_5xx' })).toBe(
      DEFAULT_RETRY_POLICY.max_backoff_ms,
    );
  });
  it('honors a sub-cap wait verbatim', () => {
    expect(backoffMsFor({ kind: 'wait', delay_ms: 4_000, reason: 'transient_network' })).toBe(4_000);
  });
  it('give_up / alert_user back off to the cap', () => {
    expect(backoffMsFor({ kind: 'give_up', reason: 'terminal_error' })).toBe(DEFAULT_RETRY_POLICY.max_backoff_ms);
    expect(backoffMsFor({ kind: 'alert_user', reason: 'oauth_refresh_failed_user_action_needed' })).toBe(
      DEFAULT_RETRY_POLICY.max_backoff_ms,
    );
  });
});

describe('system-action registration', () => {
  it('importing the module registers the `pr-poll` handler with the routines engine', () => {
    // The bottom-of-module `registerSystemAction('pr-poll', handlePrPoll)` is what
    // lets the engine dispatch a `system:pr-poll` routine inline (the git-sync seam).
    expect(getSystemAction('pr-poll')).toBe(handlePrPoll);
  });
});

describe('parsePollMeta', () => {
  it('parses a well-formed metadata blob', () => {
    const m = parsePollMeta({ last_seen: { '7': { updated_at: 123, head_sha: 'deadbeef' } }, consecutive_errors: 2 });
    expect(m.last_seen['7']).toEqual({ updated_at: 123, head_sha: 'deadbeef' });
    expect(m.consecutive_errors).toBe(2);
  });
  it('drops malformed last_seen entries + defaults counters', () => {
    const m = parsePollMeta({ last_seen: { '7': { updated_at: 'nope' }, '8': 5 } });
    expect(m.last_seen).toEqual({});
    expect(m.consecutive_errors).toBe(0);
  });
  it('tolerates null / non-object', () => {
    expect(parsePollMeta(null)).toEqual({ last_seen: {}, consecutive_errors: 0 });
    expect(parsePollMeta(undefined)).toEqual({ last_seen: {}, consecutive_errors: 0 });
  });
});

// P-021 / P-024 (plan pot-review-integration-mode-2026-10-05, D-008): the standing PR from a
// working-copy pot lands ONLY by advancing <repo>'s base to the exact merge sha the pot suite
// passed on. The GitHub merge button (tryAutoMerge → host.merge) would build its own untested
// merge commit, so the standing PR must never reach it.
describe('pollHarnessPrs — standing PR exact-merge gate (P-021/P-024, D-008)', () => {
  const standing = () => makePr({ head_ref: STANDING_PR_BRANCH });

  it('TEETH: no standingPrMerge dep wired → the standing PR is approved but NEVER merged (no GitHub merge)', async () => {
    const { host, merge } = makeHost({ open: [standing()] });
    const { store } = makeStore();
    const stampMerge = vi.fn(async () => {});
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { stampMerge }));
    expect(out.approved).toEqual([42]);
    expect(merge).not.toHaveBeenCalled();
    expect(out.merged).toEqual([]);
    expect(stampMerge).not.toHaveBeenCalled();
  });

  it('TEETH: dep returns merged → counted + stamped with the TESTED merge sha, host.merge never called', async () => {
    const { host, merge } = makeHost({ open: [standing()] });
    const { store } = makeStore();
    const stampMerge = vi.fn(async () => {});
    const standingPrMerge = vi.fn(
      async (): Promise<StandingPrMergeOutcome> => ({ action: 'merged', mergeSha: 'b'.repeat(40), detail: 'ff' }),
    );
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { stampMerge, standingPrMerge }));
    expect(standingPrMerge).toHaveBeenCalledTimes(1);
    const arg = (standingPrMerge.mock.calls[0] as unknown as [{ pr: Pr; installSlug: string }])[0];
    expect(arg.pr.ref.number).toBe(42);
    expect(arg.pr.review_decision).toBe('approved');
    expect(arg.installSlug).toBe('papercup');
    expect(merge).not.toHaveBeenCalled();
    expect(out.merged).toEqual([42]);
    expect(stampMerge).toHaveBeenCalledTimes(1);
    const stamped = (stampMerge.mock.calls[0] as unknown as [{ mergeCommitSha: string }])[0];
    expect(stamped).toMatchObject({ mergeCommitSha: 'b'.repeat(40) });
  });

  it.each([
    ['testing', { action: 'testing', reason: 'never-tested', mergeSha: 'c'.repeat(40), detail: 'started' }],
    ['waiting', { action: 'waiting', mergeSha: 'c'.repeat(40), detail: 'suite running' }],
    ['retest', { action: 'retest', reason: 'target-moved', detail: 'target moved' }],
  ] as const)('dep returns %s → not merged, and the PR is left OUT of last_seen so the next poll re-checks it', async (_l, outcome) => {
    const { host, merge } = makeHost({ open: [standing()] });
    const { store, calls } = makeStore();
    const standingPrMerge = vi.fn(async (): Promise<StandingPrMergeOutcome> => outcome as StandingPrMergeOutcome);
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { standingPrMerge }));
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
    const seen = parsePollMeta(calls.patchMeta.at(-1) as Record<string, unknown>);
    expect(seen.last_seen['42']).toBeUndefined();
  });

  it('dep returns refused → not merged and recorded in last_seen (an unchanged PR is not re-driven)', async () => {
    const { host, merge } = makeHost({ open: [standing()] });
    const { store, calls } = makeStore();
    const standingPrMerge = vi.fn(
      async (): Promise<StandingPrMergeOutcome> => ({ action: 'refused', reason: 'pr-head-not-promoted', detail: 'x' }),
    );
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { standingPrMerge }));
    expect(out.merged).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
    const seen = parsePollMeta(calls.patchMeta.at(-1) as Record<string, unknown>);
    expect(seen.last_seen['42']).toBeDefined();
  });

  it('a non-standing PR is unaffected: still merged through tryAutoMerge, the standing dep is never called', async () => {
    const { host, merge } = makeHost();
    const { store } = makeStore();
    const standingPrMerge = vi.fn(async (): Promise<StandingPrMergeOutcome> => ({ action: 'left-for-owner' }));
    const out = await pollHarnessPrs(ARGS, baseDeps(host, store, { standingPrMerge }));
    expect(merge).toHaveBeenCalledTimes(1);
    expect(out.merged).toEqual([42]);
    expect(standingPrMerge).not.toHaveBeenCalled();
  });
});
