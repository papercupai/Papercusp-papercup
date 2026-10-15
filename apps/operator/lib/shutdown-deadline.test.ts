/**
 * shutdown-deadline.test.ts — WI-2667 recurrence guard.
 *
 * Proves the invariant that the packaged Mac operator VIOLATED on 2026-07-04: a
 * shutdown whose graceful `pg.stop()` HANGS must still force-exit by the deadline
 * (never linger alive on a dead DB, so launchd can respawn it). Also proves the
 * happy path clears the deadline and exits exactly once, and that a graceful
 * REJECT still exits cleanly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runShutdownWithDeadline } from './shutdown-deadline.mts';

describe('runShutdownWithDeadline (WI-2667)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('force-exits at the deadline when the graceful stop HANGS forever (the WI-2667 bug)', async () => {
    const exit = vi.fn();
    const onForceExit = vi.fn();
    const syncCleanup = vi.fn();

    runShutdownWithDeadline({
      deadlineMs: 4000,
      syncCleanup,
      // never resolves — the pg_ctl-stalls-on-dying-postmaster hang
      gracefulStop: () => new Promise<void>(() => {}),
      exit,
      onForceExit,
    });

    // sync cleanup ran immediately; nothing has exited yet
    expect(syncCleanup).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    // before the deadline: still alive
    await vi.advanceTimersByTimeAsync(3999);
    expect(exit).not.toHaveBeenCalled();

    // at the deadline: force-exit fires exactly once with code 0
    await vi.advanceTimersByTimeAsync(1);
    expect(onForceExit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits via the graceful path and CLEARS the deadline (no double-exit) when pg.stop resolves', async () => {
    const exit = vi.fn();
    const onForceExit = vi.fn();

    runShutdownWithDeadline({
      deadlineMs: 4000,
      syncCleanup: () => {},
      gracefulStop: async () => {},
      exit,
      onForceExit,
    });

    // let the graceful microtask settle
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    // deadline was cleared: advancing well past it does NOT force-exit again
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onForceExit).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still exits cleanly when the graceful stop REJECTS (error is swallowed)', async () => {
    const exit = vi.fn();
    const onForceExit = vi.fn();

    runShutdownWithDeadline({
      deadlineMs: 4000,
      syncCleanup: () => {},
      gracefulStop: async () => {
        throw new Error('pg.stop blew up');
      },
      exit,
      onForceExit,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it('force-exits at the deadline even if the SYNCHRONOUS cleanup throws', async () => {
    const exit = vi.fn();
    const onForceExit = vi.fn();

    runShutdownWithDeadline({
      deadlineMs: 4000,
      syncCleanup: () => {
        throw new Error('unlink/lock-release exploded');
      },
      gracefulStop: () => new Promise<void>(() => {}), // hang so only the deadline can exit
      exit,
      onForceExit,
    });

    // a throw in sync cleanup must NOT strand the process — deadline still fires
    await vi.advanceTimersByTimeAsync(4000);
    expect(onForceExit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('uses the injected timer seam (no reliance on real timers)', async () => {
    const setTimer = vi.fn((_fn: () => void, _ms: number) => 'HANDLE' as unknown as ReturnType<typeof setTimeout>);
    const clearTimer = vi.fn();
    const exit = vi.fn();

    runShutdownWithDeadline({
      deadlineMs: 4000,
      syncCleanup: () => {},
      gracefulStop: async () => {},
      exit,
      setTimer,
      clearTimer,
    });

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 4000);
    await vi.advanceTimersByTimeAsync(0);
    // graceful path cleared the injected timer with the handle it was given
    expect(clearTimer).toHaveBeenCalledWith('HANDLE');
    expect(exit).toHaveBeenCalledWith(0);
  });
});
