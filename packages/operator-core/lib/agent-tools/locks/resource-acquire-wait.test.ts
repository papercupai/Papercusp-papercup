/**
 * resource-acquire-wait — unit coverage for the shared exclusive-acquisition
 * seam. The live integration suite covers drain/NOTIFY behavior; this suite
 * keeps the retry contract hermetic and proves a transient workspace timeout
 * cannot escape before guardResource gets its exclusive result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./su-lock-store', () => ({
  // The tx pool is an opaque handle here: every store call is itself mocked, so the
  // suite never touches it. Defaulting the stub in the factory (as
  // coordination/audience-host.test.ts does) keeps it out of a per-test
  // `.mockReturnValue(… as never)`, which check-mock-cast-escape.mjs ratchets.
  // vi.clearAllMocks() clears calls, not factory implementations, so this survives beforeEach.
  getTxPool: vi.fn(() => ({}) as never),
  pokeResource: vi.fn(),
  readResourceLockStatus: vi.fn(),
  readResourceQueue: vi.fn(),
  releaseAllResourcesForOwner: vi.fn(),
  tryAcquireResource: vi.fn(),
  tryReleaseResource: vi.fn(),
}));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(),
}));
vi.mock('./workspace-listener', () => ({
  subscribeWorkspace: vi.fn(),
}));

import {
  readResourceLockStatus,
  releaseAllResourcesForOwner,
  tryAcquireResource,
  tryReleaseResource,
  type ResourceAcquireResult,
  type ResourceHolder,
} from './su-lock-store';
import { mockResolvedOnceTyped, mockResolvedTyped } from '../../testing/typed-mock';
import { inWorkspaceTxn } from './in-workspace-txn';
import { subscribeWorkspace } from './workspace-listener';
import { acquireResourceExclusiveQueued, acquireResourceExclusiveWithWait } from './resource-acquire-wait';

const txnM = vi.mocked(inWorkspaceTxn);
const subscribeM = vi.mocked(subscribeWorkspace);
const acquireM = vi.mocked(tryAcquireResource);
const statusM = vi.mocked(readResourceLockStatus);
const releaseM = vi.mocked(tryReleaseResource);

const held: Extract<ResourceAcquireResult, { ok: true }> = {
  ok: true,
  lock_id: 'exclusive-retry',
  mode: 'exclusive',
  status: 'held',
  expires_ts: new Date('2026-09-06T16:00:00.000Z'),
  shared_holders: [],
  fence_seq: 9,
};

const contention = () =>
  Object.assign(new Error('workspace lock timed out'), {
    name: 'WorkspaceContendedError',
    pgCode: '57014',
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  statusM.mockReset();
  acquireM.mockReset();
  mockResolvedTyped(acquireM, held);
  txnM.mockReset();
  txnM.mockImplementation(async (_domain, _owner, fn) => fn({} as never));
  subscribeM.mockReset();
  subscribeM.mockResolvedValue(vi.fn(async () => undefined));
});

afterEach(() => vi.useRealTimers());

describe('acquireResourceExclusiveWithWait contention retry', () => {
  it('retries a transient initial workspace timeout before returning the held exclusive', async () => {
    txnM.mockRejectedValueOnce(contention());

    const pending = acquireResourceExclusiveWithWait({
      coordinationDomain: 'workspace-domain',
      owner: 'fresh-owner',
      ownerLabel: 'fresh',
      resource: 'dev-server',
      reason: 'restart',
      ttlSec: 60,
      // Match dev:restart's drain-capable guard shape: the initial acquire
      // uses the caller's budget for its advisory transaction.
      maxWaitSec: 45,
    });

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      status: 'held',
      lock_id: 'exclusive-retry',
      waited_sec: 0,
      fence_seq: 9,
    });

    expect(txnM).toHaveBeenCalledTimes(2);
    expect(txnM.mock.calls[0]?.[3]).toEqual({
      minLockTimeoutMs: 45_000,
      minStatementTimeoutMs: 45_000,
    });
    expect(txnM.mock.calls[1]?.[3]).toEqual({
      minLockTimeoutMs: 45_000,
      minStatementTimeoutMs: 45_000,
    });
    expect(acquireM).toHaveBeenCalledTimes(1);
    expect(subscribeM).toHaveBeenCalledTimes(1);
  });
});

// WI-10004638: a throw from inside the drain loop used to escape with our exclusive still
// queued. The caller never learned its lock_id, so it lived to its TTL and (under writer
// preference) refused every new shared acquire on the resource — measured as two
// dev:restart git-sync barriers that stalled every pot's git-sync for ~3 min each.
describe('acquireResourceExclusiveWithWait mid-drain failure', () => {
  const sharedFire: ResourceHolder = {
    resource: 'git-sync',
    owner: 'git-sync-fire',
    owner_label: null,
    mode: 'shared',
    status: 'held',
    lock_id: 'shared-fire',
    reason: 'git-sync fire',
    acquired_ts: new Date('2026-10-01T06:00:00.000Z'),
    expires_ts: new Date('2026-10-01T06:10:00.000Z'),
    fence_seq: 0,
  };
  const queued: Extract<ResourceAcquireResult, { ok: true }> = {
    ...held,
    lock_id: 'queued-exclusive',
    status: 'draining',
    shared_holders: [sharedFire],
    fence_seq: 0,
  };
  const passThrough: typeof inWorkspaceTxn = async (_domain, _owner, fn) => fn({} as never);
  const drain = () =>
    acquireResourceExclusiveWithWait({
      coordinationDomain: 'workspace-domain',
      owner: 'barrier-owner',
      ownerLabel: 'barrier',
      resource: 'git-sync',
      reason: 'restart',
      ttlSec: 180,
      maxWaitSec: 120,
    });

  beforeEach(() => {
    acquireM.mockReset();
    mockResolvedTyped(acquireM, queued);
    releaseM.mockReset();
    mockResolvedTyped(releaseM, { released: 1, releasedModes: ['exclusive'], releasedExclusiveResources: ['git-sync'], exclusiveResources: ['git-sync'], expired: [], waiters: {} });
  });

  it('skips one nudge on a transient poke timeout instead of abandoning the drain', async () => {
    // acquire passes, the first poke loses to contention, the second poke passes.
    txnM.mockImplementationOnce(passThrough).mockRejectedValueOnce(contention());
    mockResolvedOnceTyped(statusM, { status: 'draining' }); // recheck right after queuing
    mockResolvedOnceTyped(statusM, { status: 'draining' }); // tick 1 (its poke failed)
    mockResolvedOnceTyped(statusM, { status: 'held', fence_seq: 11 }); // tick 2

    const pending = drain();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ ok: true, status: 'held', lock_id: 'queued-exclusive', fence_seq: 11 });
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('releases the queued exclusive before rethrowing a non-transient failure', async () => {
    mockResolvedOnceTyped(statusM, { status: 'draining' });
    statusM.mockRejectedValueOnce(new Error('connection reset'));

    const pending = drain();
    const settled = expect(pending).rejects.toThrow('connection reset');
    await vi.runAllTimersAsync();
    await settled;

    expect(releaseM).toHaveBeenCalledTimes(1);
    expect(releaseM.mock.calls[0]?.[1]).toEqual({
      coordinationDomain: 'workspace-domain',
      owner: 'barrier-owner',
      lockId: 'queued-exclusive',
    });
  });

  it('still rethrows the original failure when the release itself fails', async () => {
    mockResolvedOnceTyped(statusM, { status: 'draining' });
    statusM.mockRejectedValueOnce(new Error('connection reset'));
    releaseM.mockReset();
    releaseM.mockRejectedValue(new Error('release lost'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const pending = drain();
    const settled = expect(pending).rejects.toThrow('connection reset');
    await vi.runAllTimersAsync();
    await settled;

    expect(releaseM).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('queued-exclusive'), expect.any(Error));
    warn.mockRestore();
  });
});

// The P-008 staging bridge made ONE git-sync:<slug> attempt per hourly gate tick and lost it
// four times to a git-sync fire mid-run. The queued variant must keep a stable FIFO ticket
// across polls and must never leave that ticket (or a late cascade grant) behind on a give-up.
describe('acquireResourceExclusiveQueued', () => {
  const releaseAllM = vi.mocked(releaseAllResourcesForOwner);
  const gitSyncFire: ResourceHolder = {
    resource: 'git-sync:papercusp',
    owner: 'system:git-sync:1650535:fire',
    owner_label: 'git-sync:papercusp',
    mode: 'exclusive',
    status: 'held',
    lock_id: 'git-sync-fire',
    reason: 'auto-commit papercusp',
    acquired_ts: new Date('2026-10-01T07:56:02.000Z'),
    expires_ts: new Date('2026-10-01T08:06:02.000Z'),
    fence_seq: 40,
  };
  const queuedBehindFire: Extract<ResourceAcquireResult, { ok: false }> = {
    ok: false,
    reason: 'held_exclusive',
    holders: [gitSyncFire],
    queue_ticket: 'ticket-1',
    queue_position: 1,
  };
  const queue = (maxQueueSec: number, beforeAcquire?: () => Promise<void>) =>
    acquireResourceExclusiveQueued({
      coordinationDomain: 'workspace-domain',
      owner: 'system:green-checkpoint:staging-absorption:1:attempt',
      ownerLabel: 'green-checkpoint:papercusp',
      resource: 'git-sync:papercusp',
      reason: 'absorb promoted frozen lineage',
      ttlSec: 120,
      maxQueueSec,
      pollMs: 2_000,
      ...(beforeAcquire ? { beforeAcquire } : {}),
    });

  beforeEach(() => {
    acquireM.mockReset();
    releaseAllM.mockReset();
    mockResolvedTyped(releaseAllM, { released: 0, releasedExclusiveResources: [], exclusiveResources: [], waiters: {} });
  });

  it('keeps one owner queued across polls until the cascade grants it, then leaves the lease held', async () => {
    mockResolvedOnceTyped(acquireM, queuedBehindFire);
    mockResolvedOnceTyped(acquireM, queuedBehindFire);
    mockResolvedOnceTyped(acquireM, { ...held, lock_id: 'bridge-lease', fence_seq: 41 });
    const beforeAcquire = vi.fn(async () => undefined);

    const pending = queue(300, beforeAcquire);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      status: 'held',
      lock_id: 'bridge-lease',
      fence_seq: 41,
      waited_sec: 4,
    });

    expect(acquireM).toHaveBeenCalledTimes(3);
    for (const [, params] of acquireM.mock.calls) {
      expect(params).toMatchObject({
        owner: 'system:green-checkpoint:staging-absorption:1:attempt',
        mode: 'exclusive',
        queueOnConflict: true,
      });
    }
    expect(beforeAcquire).toHaveBeenCalledTimes(3);
    expect(releaseAllM).not.toHaveBeenCalled();
  });

  it('gives up at the deadline and clears the ticket plus any lease granted after the last poll', async () => {
    mockResolvedTyped(acquireM, queuedBehindFire);

    const pending = queue(5);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: 'queue_timeout',
      holders: [gitSyncFire],
      queue_position: 1,
      waited_sec: 5,
    });

    // polls at 0s, 2s, 4s and the clipped 5s deadline
    expect(acquireM).toHaveBeenCalledTimes(4);
    expect(releaseAllM).toHaveBeenCalledTimes(1);
    expect(releaseAllM.mock.calls[0]?.slice(1)).toEqual([
      'workspace-domain',
      'system:green-checkpoint:staging-absorption:1:attempt',
    ]);
  });

  it('returns a non-queueable refusal at once and still clears the owner', async () => {
    mockResolvedOnceTyped(acquireM, { ok: false, reason: 'unknown_resource', holders: [] });

    const pending = queue(300);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'unknown_resource', waited_sec: 0 });
    expect(acquireM).toHaveBeenCalledTimes(1);
    expect(releaseAllM).toHaveBeenCalledTimes(1);
  });

  it('clears the queued ticket before rethrowing a non-transient failure mid-wait', async () => {
    mockResolvedOnceTyped(acquireM, queuedBehindFire);
    acquireM.mockRejectedValueOnce(new Error('connection reset'));

    const pending = queue(300);
    const settled = expect(pending).rejects.toThrow('connection reset');
    await vi.runAllTimersAsync();
    await settled;
    expect(releaseAllM).toHaveBeenCalledTimes(1);
  });
});
