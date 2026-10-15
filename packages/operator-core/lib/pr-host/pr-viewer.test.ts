import { describe, expect, it, vi } from 'vitest';
import { actOnPr, prToRow, readPrViewerDetails, type PrViewerDeps } from './pr-viewer';
import { ok, type Pr, type PrDetailsData, type PrHost } from './types';
import { STANDING_PR_BRANCH } from '../harness/git-sync/decide-standing-pr';
const head = 'a'.repeat(40), target = 'b'.repeat(40), merge = 'c'.repeat(40);
function setup(overrides: Partial<PrDetailsData> = {}) {
  const pr: Pr = { ref: { remote: 'github.com/a/b', number: 7 }, title: 'Combined pot work', body: '', state: 'open',
    head_ref: STANDING_PR_BRANCH, base_ref: 'main', head_sha: head, merge_commit_sha: null,
    author: { github_user_id: 1, github_login: 'avi' }, reviewers_requested: [], review_decision: 'approved',
    checks_state: 'success', mergeable_state: 'mergeable', is_draft: false, url: 'https://github.com/a/b/pull/7', updated_at: 1 };
  const data: PrDetailsData = { pr, targetSha: target, commits: [], files: [], diff: '', diffTruncated: false, checks: [], ...overrides };
  const deps: PrViewerDeps = { host: { getPrDetails: vi.fn(async () => ok(data)), getPr: vi.fn(async () => ok(data.pr)), closePr: vi.fn(async () => ok(undefined)) } as unknown as PrHost,
    remote: pr.ref.remote, permissions: { review: true, close: true, sendGreen: true },
    enrich: vi.fn(async () => {}), mergeEvidence: vi.fn(async () => ({ record: { mergeSha: merge, prHeadSha: head, targetTipSha: target, result: 'pass' as const }, promotedSha: head })),
    merge: vi.fn(async () => ({ action: 'testing', detail: 'Running exact merge suite' })), sendGreen: vi.fn(async () => ({ action: 'sent' })) };
  return { pr, data, deps };
}
describe('PR viewer evidence', () => {
  it('maps the real neutral host fields and retains the actual merge state', () => {
    const { pr } = setup();
    expect(prToRow(pr)).toMatchObject({ number: 7, remote: pr.ref.remote, author_login: 'avi', html_url: pr.url, state: 'open' });
  });
  it('exposes the exact tested commit independently of PR-head checks', async () => {
    const { deps } = setup();
    const d = await readPrViewerDetails(7, deps);
    expect(d.mergeTest?.mergeSha).toBe(merge);
    expect(d.mergeTestStatus).toBe('pass');
    expect(d.mergeBlocker).toBeNull();
    expect(deps.enrich).toHaveBeenCalledWith(d.row, head);
  });
  it.each(['target', 'head', 'promoted'])('labels a passing result stale when %s moves', async (kind) => {
    const { deps, data } = setup();
    if (kind === 'target') data.targetSha = 'd'.repeat(40);
    if (kind === 'head') data.pr.head_sha = 'd'.repeat(40);
    if (kind === 'promoted') vi.mocked(deps.mergeEvidence).mockResolvedValue({ record: { mergeSha: merge, prHeadSha: head, targetTipSha: target, result: 'pass' }, promotedSha: 'd'.repeat(40) });
    const d = await readPrViewerDetails(7, deps);
    expect(d.mergeTestStatus).toBe('stale');
    expect(d.mergeBlocker).toBeTruthy();
    expect(d.row.state).toBe('open');
  });
  it('preserves historical tested evidence after a merged PR target advances', async () => {
    const { deps, data } = setup(); data.pr.state = 'merged'; data.targetSha = 'd'.repeat(40);
    expect((await readPrViewerDetails(7, deps)).mergeTestStatus).toBe('pass');
  });
  it('surfaces conflicts and evidence failures instead of certifying success', async () => {
    const { deps, data } = setup(); data.pr.mergeable_state = 'not_mergeable';
    expect((await readPrViewerDetails(7, deps)).mergeBlocker).toContain('conflicts');
    vi.mocked(deps.mergeEvidence).mockRejectedValue(new Error('db failure'));
    expect((await readPrViewerDetails(7, deps)).mergeTestStatus).toBe('unavailable');
  });
});
describe('PR viewer actions', () => {
  it.each(['merge', 'close', 'send-green'] as const)('denies %s before any host write', async action => {
    const { deps } = setup(); deps.permissions = { review: false, close: false, sendGreen: false };
    await expect(actOnPr(7, action, deps)).rejects.toThrow(/permission|owner/);
    expect(deps.host.getPr).not.toHaveBeenCalled(); expect(deps.merge).not.toHaveBeenCalled(); expect(deps.sendGreen).not.toHaveBeenCalled();
  });
  it('reads current PR state and delegates merge to the existing exact gate', async () => {
    const { deps, data } = setup();
    expect(await actOnPr(7, 'merge', deps)).toEqual({ action: 'testing', detail: 'Running exact merge suite' });
    expect(deps.merge).toHaveBeenCalledWith(data.pr);
    data.pr.state = 'closed';
    await expect(actOnPr(7, 'merge', deps)).rejects.toThrow('no longer open');
    expect(deps.merge).toHaveBeenCalledTimes(1);
  });
  it('closes the authoritative PR ref and uses the green-only producer', async () => {
    const { deps, pr } = setup();
    expect((await actOnPr(7, 'close', deps)).action).toBe('closed');
    expect(deps.host.closePr).toHaveBeenCalledWith(pr.ref);
    expect((await actOnPr(null, 'send-green', deps)).action).toBe('sent');
    expect(deps.sendGreen).toHaveBeenCalledTimes(1);
  });
});
