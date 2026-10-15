/**
 * pui-chat-first-ux-2026-09-28 P-009: the durable client lease that ends an
 * attached PUI engine once no client is watching it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _armSuClientLeaseTimersForTest,
  _resetSuClientLeaseForTest,
  _sweepSuClientLeasesForTest,
  detachSuClientLease,
  grantSuClientLease,
  suClientLeaseConfig,
  superviseSuClientLease,
  trackSuClientStream,
  type SuClientLeaseStore,
} from './su-session-client-lease';

/** An in-memory lease table with a controllable clock, mirroring the SQL. */
function memoryStore() {
  let now = 0;
  const rows = new Map<number, { leaseUntil: number | null; detachedAt: number | null }>();
  const row = (id: number) => {
    let current = rows.get(id);
    if (!current) { current = { leaseUntil: null, detachedAt: null }; rows.set(id, current); }
    return current;
  };
  const calls = { grant: [] as number[], renew: [] as number[][] };
  const store: SuClientLeaseStore = {
    async grant(id, ttlMs) { calls.grant.push(id); Object.assign(row(id), { leaseUntil: now + ttlMs, detachedAt: null }); },
    async renew(ids, ttlMs) {
      calls.renew.push([...ids]);
      for (const id of ids) row(id).leaseUntil = Math.max(row(id).leaseUntil ?? now, now + ttlMs);
    },
    async detach(id) { row(id).detachedAt = now; return true; },
    async expired(ids) {
      return ids.filter((id) => {
        const r = rows.get(id);
        return r && r.detachedAt === null && r.leaseUntil !== null && r.leaseUntil < now;
      });
    },
  };
  return { store, calls, advance: (ms: number) => { now += ms; }, row };
}

describe('su-session client lease', () => {
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    mem = memoryStore();
    _resetSuClientLeaseForTest(mem.store);
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetSuClientLeaseForTest();
  });

  it('an open stream grants a lease and renews it until the stream closes', async () => {
    vi.useFakeTimers();
    const { ttlMs, renewMs } = suClientLeaseConfig();
    const release = trackSuClientStream(41);
    expect(mem.calls.grant).toEqual([41]);

    await vi.advanceTimersByTimeAsync(renewMs);
    expect(mem.calls.renew).toEqual([[41]]);

    release();
    release(); // idempotent: a double close must not drop another stream's count
    await vi.advanceTimersByTimeAsync(renewMs * 3);
    expect(mem.calls.renew).toHaveLength(1);
    expect(ttlMs).toBeGreaterThan(renewMs);
  });

  it('keeps renewing while ANY stream for the session is still open', async () => {
    vi.useFakeTimers();
    const { renewMs } = suClientLeaseConfig();
    const first = trackSuClientStream(7);
    const second = trackSuClientStream(7);
    first();
    await vi.advanceTimersByTimeAsync(renewMs);
    expect(mem.calls.renew).toEqual([[7]]);
    second();
  });

  it('ends a supervised engine exactly once when its lease lapses', async () => {
    const onExpired = vi.fn();
    superviseSuClientLease(9, onExpired);
    await grantSuClientLease(9, 1_000);

    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();

    mem.advance(1_001);
    await _sweepSuClientLeasesForTest();
    await _sweepSuClientLeasesForTest();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('a detached session outlives its lease; attaching again re-arms it', async () => {
    const onExpired = vi.fn();
    superviseSuClientLease(11, onExpired);
    await grantSuClientLease(11, 1_000);
    await detachSuClientLease(11);

    mem.advance(5_000);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();

    const release = trackSuClientStream(11); // a client attaches: the detach is cleared
    release();
    mem.advance(suClientLeaseConfig().ttlMs + 1);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  // WI-10006906: in the real-PTY run a resumed pui attached (its grant landed),
  // then the process stalled ~3.5s and the sweep read the fresh lease as lapsed
  // while this same process was serving that client's stream, ending the engine
  // it should have reattached to. The renewer was frozen by the same stall, so
  // the sweep must not contradict it.
  it('a lapsed lease whose stream THIS process still serves is renewed, not ended', async () => {
    const onExpired = vi.fn();
    superviseSuClientLease(15, onExpired);
    const release = trackSuClientStream(15);
    // No renew timer fires (real timers, nothing advanced): the stalled renewer.
    mem.advance(suClientLeaseConfig().ttlMs + 1);
    expect(await mem.store.expired([15])).toEqual([15]); // control: it does read as lapsed

    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();
    expect(mem.calls.renew).toEqual([[15]]);
    expect(await mem.store.expired([15])).toEqual([]); // the sweep healed the lease

    // The client really leaves: its stream closes and the next lapse ends it.
    release();
    mem.advance(suClientLeaseConfig().ttlMs + 1);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  // WI-10006906 follow-up: the sweep's renew is fire-and-forget. Awaited, it held
  // the reaper's re-entrancy guard for >1s in the real-PTY suite (a 1196ms tick
  // against a 500ms interval), where before the fix a tick was one read.
  it('a slow sweep renew neither holds the sweep nor is re-issued while it is in flight', async () => {
    const renewCalls: number[][] = [];
    let finishRenew: () => void = () => undefined;
    _resetSuClientLeaseForTest({
      ...mem.store,
      renew: (ids) => {
        renewCalls.push([...ids]);
        return new Promise<void>((resolve) => { finishRenew = resolve; });
      },
    });
    const onExpired = vi.fn();
    superviseSuClientLease(15, onExpired);
    trackSuClientStream(15);
    mem.advance(suClientLeaseConfig().ttlMs + 1);

    await _sweepSuClientLeasesForTest(); // resolves although its renew has not
    await _sweepSuClientLeasesForTest(); // a later tick while that renew is in flight
    expect(renewCalls).toEqual([[15]]);
    expect(onExpired).not.toHaveBeenCalled();

    finishRenew();
    await new Promise((resolve) => setImmediate(resolve));
    // No longer in flight, and this store's renew healed nothing: renew again.
    await _sweepSuClientLeasesForTest();
    expect(renewCalls).toEqual([[15], [15]]);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('a session with no lease granted yet is never ended', async () => {
    const onExpired = vi.fn();
    superviseSuClientLease(13, onExpired);
    mem.advance(10_000_000);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('an unreadable lease keeps the engine: a lease read failure is not evidence', async () => {
    const onExpired = vi.fn();
    _resetSuClientLeaseForTest({ ...mem.store, expired: async () => { throw new Error('db down'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    superviseSuClientLease(15, onExpired);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('inside a Vitest worker the sweep only runs on its own once armed for the test', async () => {
    process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS = '600'; // sweep every 100ms
    try {
      const unarmed = vi.fn();
      superviseSuClientLease(23, unarmed);
      await grantSuClientLease(23, 1);
      mem.advance(2);
      await new Promise((resolve) => setTimeout(resolve, 350));
      // The default timer backend is inert here: nothing sweeps on its own.
      expect(unarmed).not.toHaveBeenCalled();

      _armSuClientLeaseTimersForTest(true); // replaces the inert handle
      await vi.waitFor(() => expect(unarmed).toHaveBeenCalledTimes(1), { timeout: 2_000, interval: 50 });
    } finally {
      _armSuClientLeaseTimersForTest(false);
      delete process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS;
    }
  });

  it('an engine whose close never settles does not stop later sweeps', async () => {
    const hung = vi.fn(() => new Promise<void>(() => undefined));
    const later = vi.fn();
    superviseSuClientLease(19, hung);
    await grantSuClientLease(19, 1);
    mem.advance(2);
    await _sweepSuClientLeasesForTest();
    expect(hung).toHaveBeenCalledTimes(1);
    superviseSuClientLease(21, later);
    await grantSuClientLease(21, 1);
    mem.advance(2);
    await _sweepSuClientLeasesForTest();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('releasing a stale supervision never removes a newer one for the same session', async () => {
    const stale = vi.fn();
    const current = vi.fn();
    const releaseStale = superviseSuClientLease(17, stale);
    superviseSuClientLease(17, current); // a resumed engine re-registers
    releaseStale();
    await grantSuClientLease(17, 1);
    mem.advance(2);
    await _sweepSuClientLeasesForTest();
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('the TTL override keeps renew and sweep strictly inside the lease', () => {
    const previous = process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS;
    process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS = '3000';
    try {
      const config = suClientLeaseConfig();
      expect(config.ttlMs).toBe(3_000);
      expect(config.renewMs).toBeLessThan(config.ttlMs);
      expect(config.sweepMs).toBeLessThan(config.ttlMs);
      expect(config.initialMs).toBeGreaterThanOrEqual(config.ttlMs);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS;
      else process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS = previous;
    }
  });
});
