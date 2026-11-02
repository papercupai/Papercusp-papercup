/**
 * cluster-managed-timers-sync.test.ts — EI-19454206016477347.
 *
 * The PUSH half of the fix: the primary broadcasts its own listManaged() +
 * defaultGetRegisteredSchedules() snapshot; a worker caches the latest one + reads it
 * back synchronously. Deterministic via fake timers (broadcaster) + direct
 * `process.emit('message', …)` (cache — mirrors how `cluster.fork()`'s real IPC
 * delivers a message to a worker process). Mirrors
 * sync/hyperbee/cluster-booted-handles-sync.test.ts's structure and the same
 * fake-worker-channel convention (a synthetic emit on the REAL `process` object risks
 * colliding with the test runner's own worker IPC, which uses the same event).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { managed: Array<{ name: string; category: string; intervalMs: number }> } = {
    managed: [],
  };
  return {
    state,
    listManaged: () => state.managed,
  };
});
vi.mock('@papercusp/scheduled-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/scheduled-registry')>();
  return {
    ...actual,
    listManaged: H.listManaged,
  };
});

import {
  PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE,
  startPrimaryManagedTimersBroadcaster,
  startWorkerPrimaryManagedTimersCache,
  getCachedPrimaryManagedTimers,
  _setCachedPrimaryManagedTimersForTests,
} from './cluster-managed-timers-sync';

const noSchedules = async () => [];

beforeEach(() => {
  H.state.managed = [];
  _setCachedPrimaryManagedTimersForTests(null);
});

describe('startPrimaryManagedTimersBroadcaster (PRIMARY side)', () => {
  it('publishes callback placement through the same snapshot and preserves other slices on reader failure', async () => {
    const invocation = { workspaceId: 'workspace-a', featureId: `activity-${'a'.repeat(64)}`,
      source: 'routine' as const, running: true as const, stopStatus: null, cancellable: false as const };
    const sent: unknown[] = [];
    const h = startPrimaryManagedTimersBroadcaster({ getRegisteredSchedules: noSchedules,
      getBackgroundActivities: async () => [invocation], broadcast: message => sent.push(message) });
    try { await vi.waitFor(() => expect(sent[0]).toMatchObject({ backgroundActivities: [invocation] })); }
    finally { h.stop(); }
    const failed: unknown[] = [];
    const unavailable = startPrimaryManagedTimersBroadcaster({ getRegisteredSchedules: noSchedules,
      getBackgroundActivities: async () => { throw new Error('unavailable'); }, broadcast: message => failed.push(message) });
    try { await vi.waitFor(() => expect(failed[0]).toMatchObject({ timers: [], dbosSchedules: [] }));
      expect(failed[0]).not.toHaveProperty('backgroundActivities'); }
    finally { unavailable.stop(); }
  });

  it('broadcasts immediately, then every intervalMs, with the latest listManaged() snapshot', async () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[] = [];
      H.state.managed = [{ name: 'git-sync', category: 'sync', intervalMs: 60_000 }];
      const h = startPrimaryManagedTimersBroadcaster({
        intervalMs: 5_000,
        getRegisteredSchedules: noSchedules,
        broadcast: (m) => sent.push(m),
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({
        type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE,
        timers: [{ name: 'git-sync', category: 'sync', intervalMs: 60_000 }],
        dbosSchedules: [],
        sentAt: expect.any(Number),
        pid: process.pid,
      });

      H.state.managed = [
        { name: 'git-sync', category: 'sync', intervalMs: 60_000 },
        { name: 'dbos-executor-reaper', category: 'watchdog', intervalMs: 30_000 },
      ];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent).toHaveLength(2);
      expect((sent[1] as { timers: unknown[] }).timers).toHaveLength(2); // latest snapshot, not stale
      h.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sent).toHaveLength(2); // stopped — no further broadcasts
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the registered DBOS schedules alongside the managed timers', async () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[] = [];
      const h = startPrimaryManagedTimersBroadcaster({
        now: () => 10_000,
        getRegisteredSchedules: async () => [
          { name: 'PeriodicWorkflows.attentionReconcileUnanswerable', crontab: '0 20 * * * *', mode: 'x', queueName: null },
        ],
        broadcast: (m) => sent.push(m),
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect((sent[0] as { dbosSchedules: unknown[] }).dbosSchedules).toEqual([
        { name: 'PeriodicWorkflows.attentionReconcileUnanswerable', crontab: '0 20 * * * *', mode: 'x', queueName: null },
      ]);
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports this process\'s describeProcessRole() label on every beat', async () => {
    const sent: Array<{ role?: string }> = [];
    const h = startPrimaryManagedTimersBroadcaster({
      getRegisteredSchedules: noSchedules,
      broadcast: (m) => sent.push(m),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.role).toBe('operator'); // this test process is not a bg-host
    h.stop();
  });

  it('swallows a broadcast throw (a worker mid-exit) rather than crashing the timer', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const h = startPrimaryManagedTimersBroadcaster({
        intervalMs: 1_000,
        getRegisteredSchedules: noSchedules,
        broadcast: () => {
          calls += 1;
          throw new Error('channel closed');
        },
      });
      await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
      await expect(vi.advanceTimersByTimeAsync(3_000)).resolves.not.toThrow();
      expect(calls).toBeGreaterThan(1);
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows a getRegisteredSchedules rejection — still broadcasts timers with dbosSchedules:[]', async () => {
    const sent: Array<{ timers: unknown[]; dbosSchedules: unknown[] }> = [];
    H.state.managed = [{ name: 'git-sync', category: 'sync', intervalMs: 60_000 }];
    const h = startPrimaryManagedTimersBroadcaster({
      getRegisteredSchedules: async () => {
        throw new Error('dbos not initialized');
      },
      broadcast: (m) => sent.push(m),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ dbosSchedules: [] });
    expect(sent[0].timers).toHaveLength(1); // the timers registry is unaffected
    h.stop();
  });
});

/** A fake worker-side IPC channel — see cluster-booted-handles-sync.test.ts's doc for
 *  why a synthetic `process.emit('message', …)` on the real `process` object is unsafe
 *  under the test runner. */
function fakeWorkerChannel() {
  let listener: ((message: unknown) => void) | undefined;
  return {
    on: (_event: 'message', cb: (message: unknown) => void) => {
      listener = cb;
    },
    off: (_event: 'message', cb: (message: unknown) => void) => {
      if (listener === cb) listener = undefined;
    },
    deliver: (message: unknown) => listener?.(message),
    hasListener: () => listener !== undefined,
  };
}

describe('startWorkerPrimaryManagedTimersCache + getCachedPrimaryManagedTimers (WORKER side)', () => {
  it('validates and redacts callback placement before serving a primary snapshot', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerPrimaryManagedTimersCache({ now: () => 1000, on: ch.on, off: ch.off });
    const invocation = { workspaceId: 'workspace-a', featureId: `activity-${'a'.repeat(64)}`,
      source: 'event', running: true, stopStatus: 'draining', cancellable: false };
    try {
      ch.deliver({ type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE, pid: 12345, role: 'bg-host', timers: [],
        backgroundActivities: [{ ...invocation, args: 'private' }, { ...invocation, featureId: 'invalid' }] });
      expect(getCachedPrimaryManagedTimers()?.backgroundActivities).toEqual([invocation]);
      expect(JSON.stringify(getCachedPrimaryManagedTimers())).not.toContain('private');
    } finally { cache.stop(); }
  });

  it('caches the latest snapshot message + its receipt time', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerPrimaryManagedTimersCache({ now: () => 1_000, on: ch.on, off: ch.off });
    expect(getCachedPrimaryManagedTimers()).toBeNull();
    ch.deliver({
      type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE,
      pid: 12345,
      role: 'bg-host',
      timers: [{ name: 'git-sync' }],
      dbosSchedules: [{ name: 'x', crontab: '* * * * * *', mode: 'y', queueName: null }],
      sentAt: 999,
    });
    expect(getCachedPrimaryManagedTimers()).toEqual({
      pid: 12345,
      role: 'bg-host',
      timers: [{ name: 'git-sync' }],
      dbosSchedules: [{ name: 'x', crontab: '* * * * * *', mode: 'y', queueName: null }],
      sentAt: 999,
      receivedAt: 1_000,
    });
    cache.stop();
  });

  it('tolerates a missing dbosSchedules slice (an older primary build) — degrades to []', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerPrimaryManagedTimersCache({ now: () => 1_000, on: ch.on, off: ch.off });
    ch.deliver({
      type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE,
      pid: 1,
      role: 'operator',
      timers: [],
    });
    expect(getCachedPrimaryManagedTimers()).toMatchObject({ dbosSchedules: [] });
    cache.stop();
  });

  it('ignores non-matching / malformed messages (cluster internals, other IPC types)', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerPrimaryManagedTimersCache({ now: () => 1_000, on: ch.on, off: ch.off });
    ch.deliver({ type: 'something-else' });
    ch.deliver({ type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE }); // missing pid/role/timers
    ch.deliver({ type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE, pid: 1, role: 'operator' }); // missing timers
    ch.deliver({ type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE, pid: '1', role: 'operator', timers: [] }); // pid wrong type
    ch.deliver(null);
    expect(getCachedPrimaryManagedTimers()).toBeNull();
    cache.stop();
  });

  it('a later snapshot overwrites an earlier cached one', () => {
    let now = 1_000;
    const ch = fakeWorkerChannel();
    const cache = startWorkerPrimaryManagedTimersCache({ now: () => now, on: ch.on, off: ch.off });
    ch.deliver({
      type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE,
      pid: 1,
      role: 'operator',
      timers: [{ name: 'a' }],
      sentAt: 500,
    });
    now = 2_000;
    ch.deliver({
      type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE,
      pid: 1,
      role: 'operator',
      timers: [],
      sentAt: 1_500,
    });
    expect(getCachedPrimaryManagedTimers()).toEqual({
      pid: 1,
      role: 'operator',
      timers: [],
      dbosSchedules: [],
      sentAt: 1_500,
      receivedAt: 2_000,
    });
    cache.stop();
  });

  it('stop() removes the listener (a post-stop message is no longer cached)', () => {
    const ch = fakeWorkerChannel();
    const cache = startWorkerPrimaryManagedTimersCache({ now: () => 1_000, on: ch.on, off: ch.off });
    cache.stop();
    expect(ch.hasListener()).toBe(false);
    ch.deliver({ type: PRIMARY_MANAGED_TIMERS_SNAPSHOT_TYPE, pid: 1, role: 'operator', timers: [] });
    expect(getCachedPrimaryManagedTimers()).toBeNull();
  });

  it('defaults to real process.on/off when none injected (smoke: does not throw)', () => {
    const cache = startWorkerPrimaryManagedTimersCache();
    expect(() => cache.stop()).not.toThrow();
  });
});
