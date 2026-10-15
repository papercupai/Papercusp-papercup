/**
 * Unit tests for `defaultMarkDispatched` — the improvement-implement dispatch bookkeeping
 * (claim as improvement-runner, then bump payload.implementAttempts).
 *
 * WI-10006515 site G: read-items no longer labels an own-node row stranded at origin='remote'
 * as remote, so such a row becomes auto-eligible. The engineer_issues view's trigger still
 * no-ops the claim until the row's origin is healed. defaultMarkDispatched therefore heals
 * and retries ONCE, and only on the failed-claim path. A true peer row is never healed (the
 * heal's identity check refuses it), so its claim stays refused and nothing is fired.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../issues-engineer')>()),
  claimIssue: vi.fn(),
  healOwnNodeIssueOrigin: vi.fn(),
  mergeIssuePayload: vi.fn(async () => null),
}));

import { defaultMarkDispatched } from './improvement-actions';
import {
  claimIssue,
  healOwnNodeIssueOrigin,
  mergeIssuePayload,
  type EngineerIssue,
} from '../../issues-engineer';
import { mockResolvedOnceTyped, mockResolvedTyped } from '../../testing/typed-mock';
import type { ScoredItem } from '../improvements/digest';

const candidate = (id: string, attempts?: number): ScoredItem =>
  ({ id, title: id, attempts } as unknown as ScoredItem);

/** A complete EngineerIssue: what claimIssue returns when the claim matched a row. */
function claimedRow(id: string): EngineerIssue {
  const at = '2026-10-06T00:00:00.000Z';
  return {
    id,
    title: id,
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'wip',
    assignee: 'improvement-runner',
    assignedBy: null,
    assignedAt: at,
    payload: null,
    parent: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: 'su-test',
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    completionAuthority: null,
    featureOrder: null,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    goalId: null,
  };
}

beforeEach(() => {
  vi.mocked(claimIssue).mockReset();
  vi.mocked(healOwnNodeIssueOrigin).mockReset();
  vi.mocked(mergeIssuePayload).mockReset().mockResolvedValue(null);
});

describe('defaultMarkDispatched (WI-10006515 own-node heal-and-retry)', () => {
  it('a claim that takes on the first try never calls the heal', async () => {
    mockResolvedTyped(vi.mocked(claimIssue), claimedRow('EI-1'));

    await expect(defaultMarkDispatched(candidate('EI-1', 2))).resolves.toBe(true);

    expect(claimIssue).toHaveBeenCalledTimes(1);
    expect(healOwnNodeIssueOrigin).not.toHaveBeenCalled();
    expect(mergeIssuePayload).toHaveBeenCalledWith(
      'EI-1',
      expect.objectContaining({ implementAttempts: 3 }),
    );
  });

  it('an own-node row stranded at origin=remote is healed, re-claimed once, and stamped', async () => {
    mockResolvedOnceTyped(vi.mocked(claimIssue), null); // the view trigger no-ops the stranded row
    mockResolvedOnceTyped(vi.mocked(claimIssue), claimedRow('EI-OWN')); // after the heal the claim takes
    vi.mocked(healOwnNodeIssueOrigin).mockResolvedValue(true);

    await expect(defaultMarkDispatched(candidate('EI-OWN'))).resolves.toBe(true);

    expect(healOwnNodeIssueOrigin).toHaveBeenCalledTimes(1);
    expect(healOwnNodeIssueOrigin).toHaveBeenCalledWith('EI-OWN');
    expect(claimIssue).toHaveBeenCalledTimes(2);
    expect(mergeIssuePayload).toHaveBeenCalledWith(
      'EI-OWN',
      expect.objectContaining({ implementAttempts: 1 }),
    );
  });

  it('a true peer row (heal refuses) stays unclaimed: no retry, no payload stamp, returns false', async () => {
    mockResolvedTyped(vi.mocked(claimIssue), null);
    vi.mocked(healOwnNodeIssueOrigin).mockResolvedValue(false);

    await expect(defaultMarkDispatched(candidate('EI-PEER'))).resolves.toBe(false);

    expect(healOwnNodeIssueOrigin).toHaveBeenCalledTimes(1);
    expect(claimIssue).toHaveBeenCalledTimes(1);
    expect(mergeIssuePayload).not.toHaveBeenCalled();
  });

  it('a heal that succeeds but a retry that still no-ops returns false and stamps nothing', async () => {
    mockResolvedTyped(vi.mocked(claimIssue), null);
    vi.mocked(healOwnNodeIssueOrigin).mockResolvedValue(true);

    await expect(defaultMarkDispatched(candidate('EI-RACE'))).resolves.toBe(false);

    expect(claimIssue).toHaveBeenCalledTimes(2);
    expect(healOwnNodeIssueOrigin).toHaveBeenCalledTimes(1);
    expect(mergeIssuePayload).not.toHaveBeenCalled();
  });
});
