import { describe, expect, it } from 'vitest';
import type { Pr } from '../../pr-host/types';
import type { MergeTestRecord, SubmodulePinCheck } from './decide-merge-gate';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import {
  decideStandingPrMergePolicy,
  isStandingPr,
  stepStandingPrMerge,
  type AdvanceTargetResult,
  type StandingPrMergeDeps,
} from './standing-pr-merge';

const HEAD = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const TIP2 = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);

function pr(over: Partial<Pr> = {}): Pr {
  return {
    ref: { number: 7 },
    head_ref: STANDING_PR_BRANCH,
    base_ref: 'main',
    head_sha: HEAD,
    review_decision: 'approved',
    checks_state: 'success',
    ...over,
  } as Pr;
}

function fakeDeps(
  opts: {
    tip?: string;
    last?: MergeTestRecord | null;
    merge?: string | null;
    advance?: AdvanceTargetResult;
    pins?: SubmodulePinCheck | (() => Promise<SubmodulePinCheck>);
  } = {},
) {
  const calls: {
    saved: MergeTestRecord[];
    started: MergeTestRecord[];
    advanced: Array<{ sha: string; expectedTip: string }>;
    pinChecks: Array<{ head: string; tip: string }>;
  } = {
    saved: [],
    started: [],
    advanced: [],
    pinChecks: [],
  };
  const deps: StandingPrMergeDeps = {
    readTargetTip: async () => opts.tip ?? TIP,
    loadLastTest: async () => opts.last ?? null,
    loadPathAttribution: async () => ({ ok: true, prDiffPaths: [], admittedFixPaths: [] }),
    saveTest: async (_n, rec) => void calls.saved.push(rec),
    findUnpublishedGitlinks: async (head, tip) => {
      calls.pinChecks.push({ head, tip });
      if (typeof opts.pins === 'function') return opts.pins();
      return opts.pins ?? { ok: true, unpublished: [] };
    },
    buildMergeResult: async () => (opts.merge === undefined ? MERGE : opts.merge),
    startTests: async (_n, rec) => void calls.started.push(rec),
    advanceTarget: async (a) => {
      calls.advanced.push({ sha: a.sha, expectedTip: a.expectedTip });
      return opts.advance ?? { ok: true };
    },
  };
  return { deps, calls };
}

const review = { mode: 'review' as const, source: 'set' as const };

describe('decideStandingPrMergePolicy (P-021)', () => {
  it('defaults to the owner merging on GitHub', () => {
    expect(decideStandingPrMergePolicy({ integration: review, upstreamPapercuspManaged: false, autoMergeEnabled: true }))
      .toEqual({ policy: 'owner', reason: 'upstream-not-managed' });
    expect(decideStandingPrMergePolicy({ integration: review, upstreamPapercuspManaged: true, autoMergeEnabled: false }))
      .toEqual({ policy: 'owner', reason: 'auto-merge-off' });
    expect(
      decideStandingPrMergePolicy({
        integration: { mode: 'direct', source: 'absent' },
        upstreamPapercuspManaged: true,
        autoMergeEnabled: true,
      }),
    ).toEqual({ policy: 'owner', reason: 'not-review-mode' });
  });

  it('auto-merges only when <repo> is Papercusp-managed with auto-merge on', () => {
    expect(decideStandingPrMergePolicy({ integration: review, upstreamPapercuspManaged: true, autoMergeEnabled: true }))
      .toEqual({ policy: 'auto', reason: 'managed-auto-merge' });
  });

  it('recognises the standing PR by its head branch', () => {
    expect(isStandingPr({ head_ref: STANDING_PR_BRANCH })).toBe(true);
    expect(isStandingPr({ head_ref: 'feature/x' })).toBe(false);
  });
});

describe('stepStandingPrMerge (P-021 + P-024 exact-merge gate)', () => {
  const base = { policy: 'auto' as const, promotedSha: HEAD, authorRevoked: false };

  it('leaves the PR alone under the owner policy', async () => {
    const { deps, calls } = fakeDeps();
    expect(await stepStandingPrMerge({ ...base, pr: pr(), policy: 'owner' }, deps)).toEqual({ action: 'left-for-owner' });
    expect(calls.advanced).toEqual([]);
  });

  it('refuses a revoked author before any other gate', async () => {
    const { deps, calls } = fakeDeps();
    const out = await stepStandingPrMerge({ ...base, pr: pr(), authorRevoked: true }, deps);
    expect(out).toMatchObject({ action: 'refused', reason: 'author-revoked' });
    expect(calls.saved).toEqual([]);
  });

  it('applies the pr-host bar: approved and checks green', async () => {
    const { deps } = fakeDeps();
    expect(await stepStandingPrMerge({ ...base, pr: pr({ review_decision: 'changes_requested' }) }, deps))
      .toMatchObject({ action: 'skipped', reason: 'not-approved' });
    expect(await stepStandingPrMerge({ ...base, pr: pr({ checks_state: 'failure' } as Partial<Pr>) }, deps))
      .toMatchObject({ action: 'skipped', reason: 'checks-failing' });
  });

  // WI-10006351: the pot's own GitHub account authors the standing PR and GitHub
  // refuses self-approval, so a viewer reviewer's merge click must be the approval.
  it('treats a PR-viewer merge as the approval when GitHub has no review', async () => {
    const { deps, calls } = fakeDeps();
    const out = await stepStandingPrMerge({ ...base, pr: pr({ review_decision: 'none' }), viewerApproved: true }, deps);
    expect(out).toMatchObject({ action: 'testing', reason: 'never-tested', mergeSha: MERGE });
    expect(calls.started.map((r) => r.mergeSha)).toEqual([MERGE]);
  });

  it('still needs an approval without a viewer merge (the poller path)', async () => {
    const { deps, calls } = fakeDeps();
    expect(await stepStandingPrMerge({ ...base, pr: pr({ review_decision: 'none' }) }, deps))
      .toEqual({ action: 'skipped', reason: 'not-approved', detail: 'Review decision is none.' });
    expect(await stepStandingPrMerge({ ...base, pr: pr({ review_decision: 'none' }), viewerApproved: false }, deps))
      .toMatchObject({ action: 'skipped', reason: 'not-approved' });
    expect(calls.started).toEqual([]);
  });

  it('lets a GitHub changes-requested review block even a viewer merge', async () => {
    const { deps, calls } = fakeDeps();
    const out = await stepStandingPrMerge(
      { ...base, pr: pr({ review_decision: 'changes_requested' }), viewerApproved: true },
      deps,
    );
    expect(out).toMatchObject({ action: 'skipped', reason: 'not-approved' });
    expect(calls.started).toEqual([]);
    expect(calls.advanced).toEqual([]);
  });

  it('builds the exact merge result and starts the suite on it when never tested', async () => {
    const { deps, calls } = fakeDeps();
    const out = await stepStandingPrMerge({ ...base, pr: pr() }, deps);
    expect(out).toMatchObject({ action: 'testing', reason: 'never-tested', mergeSha: MERGE });
    expect(calls.saved).toEqual([{ mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'running' }]);
    expect(calls.started.map((r) => r.mergeSha)).toEqual([MERGE]);
    expect(calls.advanced).toEqual([]);
  });

  it('refuses a PR whose head is not the promoted commit', async () => {
    const { deps, calls } = fakeDeps();
    const out = await stepStandingPrMerge({ ...base, pr: pr(), promotedSha: 'e'.repeat(40) }, deps);
    expect(out).toMatchObject({ action: 'refused', reason: 'pr-head-not-promoted' });
    expect(calls.saved).toEqual([]);
  });

  it('refuses a merge conflict without recording a test', async () => {
    const { deps, calls } = fakeDeps({ merge: null });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'refused', reason: 'merge-conflict' });
    expect(calls.started).toEqual([]);
  });

  it('waits while the suite runs on the merge result', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'running' as const };
    const { deps, calls } = fakeDeps({ last });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'waiting', mergeSha: MERGE });
    expect(calls.advanced).toEqual([]);
  });

  it('advances the target to exactly the tested sha under a lease on the tested tip', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const { deps, calls } = fakeDeps({ last });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'merged', mergeSha: MERGE });
    expect(calls.advanced).toEqual([{ sha: MERGE, expectedTip: TIP }]);
  });

  it('re-tests instead of merging when the target moved after the test', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const { deps, calls } = fakeDeps({ last, tip: TIP2 });
    const out = await stepStandingPrMerge({ ...base, pr: pr() }, deps);
    expect(out).toMatchObject({ action: 'testing', reason: 'target-moved' });
    expect(calls.saved[0]).toMatchObject({ targetTipSha: TIP2, result: 'running' });
    expect(calls.advanced).toEqual([]);
  });

  it('reports target-moved when the target moves during the push itself', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const { deps } = fakeDeps({ last, advance: { ok: false, tipAtPush: TIP2, error: 'non-fast-forward' } });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'retest', reason: 'target-moved' });
  });

  it('never merges a result whose suite failed', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'fail' as const };
    const { deps, calls } = fakeDeps({ last });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'refused', reason: 'merge-result-failed' });
    expect(calls.advanced).toEqual([]);
  });
});

// slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 D-017 §6: a superproject PR
// must not land gitlinks its submodules' main repositories cannot resolve.
describe('stepStandingPrMerge: submodule commits must be published first (D-017 §6)', () => {
  const base = { policy: 'auto' as const, promotedSha: HEAD, authorRevoked: false };
  const pending = { ok: true as const, unpublished: [{ path: 'libs/core', sha: 'f'.repeat(40) }] };

  it('checks the promoted PR head against the CURRENT target tip', async () => {
    const { deps, calls } = fakeDeps({ tip: TIP2 });
    await stepStandingPrMerge({ ...base, pr: pr() }, deps);
    expect(calls.pinChecks).toEqual([{ head: HEAD, tip: TIP2 }]);
  });

  it('refuses before building or testing while a submodule commit is unpublished', async () => {
    const { deps, calls } = fakeDeps({ pins: pending });
    const out = await stepStandingPrMerge({ ...base, pr: pr() }, deps);
    expect(out).toMatchObject({ action: 'refused', reason: 'unpublished-gitlinks' });
    expect(out.action === 'refused' && out.detail).toContain('libs/core (ffffffffff)');
    expect(calls.saved).toEqual([]);
    expect(calls.started).toEqual([]);
  });

  it('refuses even a passed merge test while a submodule commit is unpublished', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const { deps, calls } = fakeDeps({ last, pins: pending });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'refused', reason: 'unpublished-gitlinks' });
    expect(calls.advanced).toEqual([]);
  });

  it('refuses when the check cannot answer, and when it throws', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const failed = fakeDeps({ last, pins: { ok: false, error: 'could not fetch libs/core' } });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, failed.deps))
      .toMatchObject({ action: 'refused', reason: 'submodule-pins-unverifiable' });
    const threw = fakeDeps({ last, pins: () => Promise.reject(new Error('network down')) });
    const out = await stepStandingPrMerge({ ...base, pr: pr() }, threw.deps);
    expect(out).toMatchObject({ action: 'refused', reason: 'submodule-pins-unverifiable' });
    expect(out.action === 'refused' && out.detail).toContain('network down');
    expect(failed.calls.advanced).toEqual([]);
    expect(threw.calls.advanced).toEqual([]);
  });

  it('merges once every submodule commit is published', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const { deps, calls } = fakeDeps({ last, pins: { ok: true, unpublished: [] } });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'merged', mergeSha: MERGE });
    expect(calls.advanced).toEqual([{ sha: MERGE, expectedTip: TIP }]);
  });

  it('skips the check for a head that is not promoted (it is refused anyway)', async () => {
    const { deps, calls } = fakeDeps({ pins: pending });
    const out = await stepStandingPrMerge({ ...base, pr: pr(), promotedSha: 'e'.repeat(40) }, deps);
    expect(out).toMatchObject({ action: 'refused', reason: 'pr-head-not-promoted' });
    expect(calls.pinChecks).toEqual([]);
  });
});
