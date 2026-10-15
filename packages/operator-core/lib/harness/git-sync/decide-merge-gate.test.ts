import { describe, expect, it } from 'vitest';
import { confirmMergeAdvance, decideMergeGate, type MergeTestRecord } from './decide-merge-gate';

const PR = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

const test = (over: Partial<MergeTestRecord> = {}): MergeTestRecord => ({
  mergeSha: MERGE,
  prHeadSha: PR,
  targetTipSha: TIP,
  result: 'pass',
  ...over,
});

describe('decideMergeGate: submodule commits must be published (D-017 §6)', () => {
  const unpublished = { ok: true as const, unpublished: [{ path: 'libs/core', sha: OTHER }] };

  it('refuses unpublished gitlinks before building, waiting or merging', () => {
    for (const lastTest of [null, test({ result: 'running' }), test()]) {
      const d = decideMergeGate({ prHeadSha: PR, promotedSha: PR, targetTipSha: TIP, lastTest, submodulePins: unpublished });
      expect(d).toMatchObject({ action: 'refuse', reason: 'unpublished-gitlinks' });
      expect(d.action === 'refuse' && d.detail).toContain('libs/core (dddddddddd)');
    }
  });

  it('refuses when the publication check could not answer', () => {
    const d = decideMergeGate({
      prHeadSha: PR, promotedSha: PR, targetTipSha: TIP, lastTest: test(),
      submodulePins: { ok: false, error: 'fetch failed' },
    });
    expect(d).toMatchObject({ action: 'refuse', reason: 'submodule-pins-unverifiable' });
  });

  it('keeps the promotion refusals first', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: OTHER, targetTipSha: TIP, lastTest: test(), submodulePins: unpublished });
    expect(d).toMatchObject({ action: 'refuse', reason: 'pr-head-not-promoted' });
  });

  it('merges as before when every pin is published', () => {
    const d = decideMergeGate({
      prHeadSha: PR, promotedSha: PR, targetTipSha: TIP, lastTest: test(),
      submodulePins: { ok: true, unpublished: [] },
    });
    expect(d).toMatchObject({ action: 'merge', advanceTargetTo: MERGE, expectedTargetTip: TIP });
  });
});

describe('decideMergeGate (P-024 / D-008)', () => {
  it('refuses when the working copy has nothing promoted', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: null, targetTipSha: TIP, lastTest: test() });
    expect(d).toMatchObject({ action: 'refuse', reason: 'nothing-promoted' });
  });

  it('refuses a PR head that is not the gate-promoted commit, even with a passing merge test', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: OTHER, targetTipSha: TIP, lastTest: test() });
    expect(d).toMatchObject({ action: 'refuse', reason: 'pr-head-not-promoted' });
  });

  it('builds and tests the merge result when it was never tested', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: PR, targetTipSha: TIP, lastTest: null });
    expect(d).toEqual(expect.objectContaining({ action: 'build-and-test', reason: 'never-tested', prHeadSha: PR, targetTipSha: TIP }));
  });

  it('re-tests when the target moved since the passing test', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: PR, targetTipSha: OTHER, lastTest: test() });
    expect(d).toEqual(expect.objectContaining({ action: 'build-and-test', reason: 'target-moved', targetTipSha: OTHER }));
  });

  it('re-tests when the PR head moved since the passing test', () => {
    const d = decideMergeGate({ prHeadSha: OTHER, promotedSha: OTHER, targetTipSha: TIP, lastTest: test() });
    expect(d).toEqual(expect.objectContaining({ action: 'build-and-test', reason: 'pr-head-moved', prHeadSha: OTHER }));
  });

  it('waits while the suite runs on the current merge result', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: PR, targetTipSha: TIP, lastTest: test({ result: 'running' }) });
    expect(d).toMatchObject({ action: 'wait', mergeSha: MERGE });
  });

  it('refuses when the suite failed on the current merge result', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: PR, targetTipSha: TIP, lastTest: test({ result: 'fail' }) });
    expect(d).toMatchObject({ action: 'refuse', reason: 'merge-result-failed' });
  });

  it('merges exactly the tested merge commit, leased on the tested target tip', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: PR, targetTipSha: TIP, lastTest: test() });
    expect(d).toEqual(expect.objectContaining({ action: 'merge', advanceTargetTo: MERGE, expectedTargetTip: TIP }));
  });

  it('never merges the PR head itself when a distinct merge commit was tested', () => {
    const d = decideMergeGate({ prHeadSha: PR, promotedSha: PR, targetTipSha: TIP, lastTest: test() });
    expect(d.action === 'merge' && d.advanceTargetTo).not.toBe(PR);
  });
});

describe('confirmMergeAdvance', () => {
  const merge = { action: 'merge' as const, advanceTargetTo: MERGE, expectedTargetTip: TIP, detail: '' };

  it('allows the advance when the target is still the tested tip', () => {
    expect(confirmMergeAdvance(merge, TIP)).toEqual({ ok: true });
  });

  it('refuses the advance when the target moved during the merge', () => {
    expect(confirmMergeAdvance(merge, OTHER)).toMatchObject({ ok: false, reason: 'target-moved' });
  });
});
