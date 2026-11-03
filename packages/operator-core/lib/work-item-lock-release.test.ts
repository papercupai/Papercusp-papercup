import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

const ensureBootstrap = vi.fn();
const getTxPool = vi.fn();
const readQueue = vi.fn();
const tryRelease = vi.fn();
const inWorkspaceTxn = vi.fn();

vi.mock('./agent-tools/locks/su-lock-store', () => ({
  ensureBootstrap: (...args: unknown[]) => ensureBootstrap(...args),
  getTxPool: (...args: unknown[]) => getTxPool(...args),
  readQueue: (...args: unknown[]) => readQueue(...args),
  tryRelease: (...args: unknown[]) => tryRelease(...args),
}));
vi.mock('./agent-tools/locks/in-workspace-txn', () => ({
  inWorkspaceTxn: (...args: unknown[]) => inWorkspaceTxn(...args),
}));

import { normalizeReclaimPaths, releaseReclaimedWorkItemLocks } from './work-item-lock-release';

beforeEach(() => {
  vi.clearAllMocks();
  ensureBootstrap.mockResolvedValue(undefined);
  getTxPool.mockReturnValue({});
  readQueue.mockResolvedValue({ active_locks: [], waiting: [] });
  tryRelease.mockResolvedValue({ released: [], heldBefore: 0 });
  inWorkspaceTxn.mockImplementation(async (_domain: unknown, _owner: unknown, callback: (tx: unknown) => unknown) => callback({}));
});

describe('normalizeReclaimPaths', () => {
  it('deduplicates and trims declared paths', () => {
    expect(normalizeReclaimPaths([' target.ts ', 'target.ts', '', 'other.ts'])).toEqual(['target.ts', 'other.ts']);
  });
});

describe('releaseReclaimedWorkItemLocks', () => {
  it('releases only declared paths, grouped by domain and lock id', async () => {
    readQueue.mockResolvedValue({
      active_locks: [
        { coordination_domain: '/repo/staging', lock_id: 'lock-a', owner: 'holder', path: 'target.ts' },
        { coordination_domain: '/repo/staging', lock_id: 'lock-a', owner: 'holder', path: 'unrelated.ts' },
        { coordination_domain: '/repo/staging', lock_id: 'lock-a', owner: 'holder', path: 'second-target.ts' },
        { coordination_domain: '/repo/staging', lock_id: 'lock-b', owner: 'holder', path: 'second-target.ts' },
        { coordination_domain: '/repo/other', lock_id: 'lock-c', owner: 'holder', path: 'target.ts' },
        { coordination_domain: '/repo/staging', lock_id: 'lock-peer', owner: 'other', path: 'target.ts' },
      ],
      waiting: [],
    });
    tryRelease
      .mockResolvedValueOnce({ released: ['target.ts', 'second-target.ts'], heldBefore: 3 })
      .mockResolvedValueOnce({ released: ['second-target.ts'], heldBefore: 1 })
      .mockResolvedValueOnce({ released: ['target.ts'], heldBefore: 1 });

    const result = await releaseReclaimedWorkItemLocks({
      ownerId: 'holder',
      paths: ['target.ts', 'second-target.ts'],
    });

    expect(readQueue).toHaveBeenCalledWith({}, { coordinationDomain: null, owner: 'holder' });
    expect(tryRelease).toHaveBeenCalledTimes(3);
    expect(tryRelease).toHaveBeenNthCalledWith(1, {}, {
      coordinationDomain: '/repo/staging',
      owner: 'holder',
      lockId: 'lock-a',
      paths: ['target.ts', 'second-target.ts'],
    });
    expect(tryRelease).toHaveBeenNthCalledWith(2, {}, {
      coordinationDomain: '/repo/staging',
      owner: 'holder',
      lockId: 'lock-b',
      paths: ['second-target.ts'],
    });
    expect(tryRelease).toHaveBeenNthCalledWith(3, {}, {
      coordinationDomain: '/repo/other',
      owner: 'holder',
      lockId: 'lock-c',
      paths: ['target.ts'],
    });
    expect(result).toMatchObject({ failures: 0, skipped: null });
    expect(result.releases.map((r) => r.paths)).toEqual([
      ['target.ts', 'second-target.ts'],
      ['second-target.ts'],
      ['target.ts'],
    ]);
  });

  it('does not query or release when the item has no declared paths or goal', async () => {
    const result = await releaseReclaimedWorkItemLocks({ ownerId: 'holder', paths: [] });
    expect(result).toEqual({ releases: [], failures: 0, skipped: 'no-paths' });
    expect(readQueue).not.toHaveBeenCalled();
    expect(tryRelease).not.toHaveBeenCalled();
  });

  it('releases goal-associated locks even when the item has no declared paths', async () => {
    readQueue.mockResolvedValue({
      active_locks: [
        { coordination_domain: '/repo/staging', lock_id: 'lock-item', owner: 'holder', path: 'actual.ts', goal_ref: 'WI-item' },
        { coordination_domain: '/repo/staging', lock_id: 'lock-other', owner: 'holder', path: 'other.ts', goal_ref: 'WI-other' },
        { coordination_domain: '/repo/staging', lock_id: 'lock-legacy', owner: 'holder', path: 'legacy.ts', goal_ref: null },
      ],
      waiting: [],
    });
    tryRelease.mockResolvedValue({ released: ['actual.ts'], heldBefore: 1 });

    const result = await releaseReclaimedWorkItemLocks({ ownerId: 'holder', paths: [], goalRef: 'WI-item' });

    expect(readQueue).toHaveBeenCalledWith({}, { coordinationDomain: null, owner: 'holder' });
    expect(tryRelease).toHaveBeenCalledTimes(1);
    expect(tryRelease).toHaveBeenCalledWith({}, {
      coordinationDomain: '/repo/staging',
      owner: 'holder',
      lockId: 'lock-item',
      paths: ['actual.ts'],
    });
    expect(result).toMatchObject({ failures: 0, skipped: null });
    expect(result.releases).toEqual([
      expect.objectContaining({ lockId: 'lock-item', paths: ['actual.ts'], released: ['actual.ts'] }),
    ]);
  });

  it('fails open when the lock read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readQueue.mockRejectedValue(new Error('side db unavailable'));
    const result = await releaseReclaimedWorkItemLocks({ ownerId: 'holder', paths: ['target.ts'] });
    expect(result).toMatchObject({ releases: [], failures: 1, skipped: null });
    expect(readQueue).toHaveBeenCalledTimes(1);
    expect(tryRelease).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('side db unavailable'));
  });

  it('retries a transient statement timeout before reporting a lock-read failure', async () => {
    let calls = 0;
    readQueue.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('canceling statement due to statement timeout') as Error & { code: string };
        error.code = '57014';
        throw error;
      }
      return { active_locks: [], waiting: [] };
    });

    vi.useFakeTimers();
    try {
      const resultPromise = releaseReclaimedWorkItemLocks({ ownerId: 'holder', paths: ['target.ts'] });
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(calls).toBe(2);
      expect(result).toMatchObject({ releases: [], failures: 0, skipped: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
