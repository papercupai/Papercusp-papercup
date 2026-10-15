import { describe, expect, it, vi } from 'vitest';
import {
  boundLeaseRefresh,
  createGitSyncLeaseFence,
  GIT_SYNC_LEASE_REFRESH_DEADLINE_MS,
  GitSyncLeaseLostError,
  type LeaseRefreshTimers,
} from './git-sync-lease-fence';

const LIMIT = 480_000;

function fenceAt(start: number) {
  let clock = start;
  const fence = createGitSyncLeaseFence({
    slug: 'papercusp',
    acquiredAt: start,
    unconfirmedLimitMs: LIMIT,
    now: () => clock,
  });
  return {
    fence,
    advance: (ms: number) => {
      clock += ms;
      return clock;
    },
  };
}

describe('git-sync lease fence (WI-10006724)', () => {
  it('holds while refreshes keep confirming inside the limit', () => {
    const { fence, advance } = fenceAt(1_000);
    for (let i = 0; i < 20; i += 1) {
      fence.confirm(advance(60_000));
      expect(() => fence.assertHeld()).not.toThrow();
    }
    expect(fence.lost).toBeNull();
  });

  it('trips on a refused refresh and stays tripped after later confirmations', () => {
    const { fence, advance } = fenceAt(1_000);
    fence.markLost('refused', 'git-sync:papercusp: held by another owner');
    fence.confirm(advance(60_000));
    expect(() => fence.assertHeld()).toThrow(GitSyncLeaseLostError);
    expect(fence.lost?.leaseLossCause).toBe('refused');
    expect(fence.lost?.code).toBe('git_sync_lease_lost');
  });

  it('trips at the next Git command once no refresh was confirmed for the limit', () => {
    const { fence, advance } = fenceAt(1_000);
    advance(LIMIT - 1);
    expect(() => fence.assertHeld()).not.toThrow();
    advance(1);
    expect(() => fence.assertHeld()).toThrow(/lease lost \(unconfirmed\)/);
    expect(fence.lost?.leaseLossCause).toBe('unconfirmed');
  });

  it('records the last refresh attempt in an unconfirmed loss without treating it as confirmation', () => {
    const { fence, advance } = fenceAt(1_000);
    const sentAt = advance(LIMIT - 1);
    fence.recordAttempt(sentAt);
    expect(() => fence.assertHeld()).not.toThrow();
    advance(1);
    expect(() => fence.assertHeld()).toThrow(GitSyncLeaseLostError);
    expect(fence.lost?.detail).toContain(`last refresh attempt was sent at ${sentAt} ms (1 ms ago)`);
  });

  it('reports when an unconfirmed loss has no recorded refresh attempt', () => {
    const { fence, advance } = fenceAt(1_000);
    advance(LIMIT);
    expect(() => fence.assertHeld()).toThrow(GitSyncLeaseLostError);
    expect(fence.lost?.detail).toContain('no refresh attempt recorded since lease acquisition');
  });

  it('does not re-arm when a refresh succeeds only AFTER an unconfirmed gap', () => {
    // A same-owner refresh can re-grant an expired row; another fire may have
    // written inside the gap, so the late success must not count as continuity.
    const { fence, advance } = fenceAt(1_000);
    fence.confirm(advance(LIMIT + 5_000));
    expect(fence.lost?.leaseLossCause).toBe('unconfirmed');
    expect(() => fence.assertHeld()).toThrow(GitSyncLeaseLostError);
  });

  it('keeps the first loss when several are reported', () => {
    const { fence } = fenceAt(1_000);
    const first = fence.markLost('refused', 'first');
    const second = fence.markLost('unconfirmed', 'second');
    expect(second).toBe(first);
    expect(fence.lost?.detail).toBe('first');
  });

  it('ignores an out-of-order older confirmation', () => {
    const { fence, advance } = fenceAt(1_000);
    const t1 = advance(60_000);
    fence.confirm(t1);
    fence.confirm(t1 - 30_000);
    advance(LIMIT - 1);
    expect(() => fence.assertHeld()).not.toThrow();
  });
});

describe('boundLeaseRefresh (EI-25452296370086757)', () => {
  /** A manual timer seam: the test decides when the deadline elapses. */
  function manualTimers() {
    const pending = new Map<number, () => void>();
    let next = 0;
    const timers: LeaseRefreshTimers = {
      set: (cb) => {
        const id = ++next;
        pending.set(id, cb);
        return id;
      },
      clear: (handle) => {
        pending.delete(handle as number);
      },
    };
    return {
      timers,
      pendingCount: () => pending.size,
      fireAll: () => {
        for (const [id, cb] of [...pending]) {
          pending.delete(id);
          cb();
        }
      },
    };
  }

  it('the deadline sits below the 60 s heartbeat interval so the next tick can retry', () => {
    expect(GIT_SYNC_LEASE_REFRESH_DEADLINE_MS).toBeLessThan(60_000);
  });

  it('settles at the deadline when the refresh never does, and reports it', async () => {
    const t = manualTimers();
    const onDeadline = vi.fn();
    let settled = false;
    const bounded = boundLeaseRefresh(new Promise<void>(() => undefined), 1_000, onDeadline, t.timers).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    t.fireAll();
    await bounded;
    expect(settled).toBe(true);
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it('a prompt refresh settles the pass, clears the timer and never reports a deadline', async () => {
    const t = manualTimers();
    const onDeadline = vi.fn();
    await boundLeaseRefresh(Promise.resolve(), 1_000, onDeadline, t.timers);
    expect(t.pendingCount()).toBe(0);
    expect(onDeadline).not.toHaveBeenCalled();
  });

  it('a rejected refresh still settles the pass (no unhandled rejection)', async () => {
    const t = manualTimers();
    await expect(boundLeaseRefresh(Promise.reject(new Error('pool closed')), 1_000, vi.fn(), t.timers)).resolves.toBeUndefined();
    expect(t.pendingCount()).toBe(0);
  });

  it('an abandoned refresh that confirms late still moves the fence forward', async () => {
    const { fence, advance } = fenceAt(0);
    const t = manualTimers();
    let finishHung!: () => void;
    const sentAt = advance(60_000);
    const hung = new Promise<void>((resolve) => {
      finishHung = () => {
        fence.confirm(sentAt);
        resolve();
      };
    });
    const pass = boundLeaseRefresh(hung, 1_000, vi.fn(), t.timers);
    t.fireAll();
    await pass;
    // The next heartbeat's fresh refresh confirms; then the abandoned one lands late.
    fence.confirm(advance(60_000));
    finishHung();
    await hung;
    advance(LIMIT - 60_001);
    expect(() => fence.assertHeld()).not.toThrow();
  });
});
