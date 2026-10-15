/**
 * cluster-lag-watchdog.test.ts — EI-1598/1608. The primary must SIGKILL a worker
 * that has stopped heart-beating (a synchronous wedge the worker-side recycler can't
 * catch), and must NOT kill a healthy beating worker or an as-yet-unseen one.
 *
 * The cluster + clock are injected, so this drives the absence logic deterministically
 * with no real fork/timers (same approach as cluster-fork.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  startClusterLagWatchdog,
  startWorkerHeartbeat,
  clusterLagWatchdogArmed,
  CLUSTER_HEARTBEAT_TYPE,
  type WatchdogClusterLike,
  type WatchdogWorkerRef,
} from './cluster-lag-watchdog';

/** A fake node:cluster primary: lets the test push 'message'/'exit' events + spy kills. */
function fakeCluster() {
  const handlers: { message?: (w: { id: number }, m: unknown) => void; exit?: (w: { id: number }, c: number, s: string | null) => void } = {};
  const kills: Array<{ id: number; signal?: string }> = [];
  const cluster: WatchdogClusterLike = {
    on(event: 'message' | 'exit', cb: never) {
      if (event === 'message') handlers.message = cb as never;
      else handlers.exit = cb as never;
    },
  };
  const workerById = (id: number): WatchdogWorkerRef => ({ id, kill: (signal) => kills.push({ id, signal }) });
  const rail = { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => false) };
  return {
    cluster,
    rail,
    kills,
    beat: (id: number) => handlers.message?.({ id }, { type: CLUSTER_HEARTBEAT_TYPE }),
    otherMessage: (id: number) => handlers.message?.({ id }, { type: 'something-else' }),
    exit: (id: number) => handlers.exit?.({ id }, 0, 'SIGKILL'),
    workerById,
  };
}

describe('startClusterLagWatchdog (EI-1598/1608) — deterministic scan via fake timers', () => {
  it('kills only the silent worker; healthy + unseen workers survive', () => {
    vi.useFakeTimers();
    try {
      const f = fakeCluster();
      const wd = startClusterLagWatchdog({
        cluster: f.cluster,
        workerById: f.workerById,
        rail: f.rail,
        scanMs: 5_000,
        silenceMs: 30_000,
        now: () => Date.now(),
        log: () => {},
      });
      f.beat(1);
      f.beat(2);
      // Worker 2 keeps beating; worker 1 goes silent. Worker 3 is never seen.
      for (let i = 0; i < 8; i++) {
        vi.advanceTimersByTime(5_000); // 40s total
        f.beat(2); // 2 stays alive every 5s
      }
      expect(f.kills.map((k) => k.id)).toEqual([1]); // only the silent one
      expect(f.kills[0].signal).toBe('SIGKILL');
      expect(wd.watchedIds()).toEqual([2]); // 1 dropped on kill, 2 still tracked, 3 never registered
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops tracking a worker on exit (no kill after it is gone)', () => {
    vi.useFakeTimers();
    try {
      const f = fakeCluster();
      const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: f.workerById, rail: f.rail, scanMs: 5_000, silenceMs: 30_000, now: () => Date.now(), log: () => {} });
      f.beat(1);
      f.exit(1); // worker 1 exits (e.g. its own crash) before going silent
      vi.advanceTimersByTime(60_000);
      expect(f.kills).toEqual([]); // never killed — it was untracked on exit
      expect(wd.watchedIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores non-heartbeat IPC messages (cluster internals)', () => {
    vi.useFakeTimers();
    try {
      const f = fakeCluster();
      const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: f.workerById, rail: f.rail, scanMs: 5_000, silenceMs: 30_000, now: () => Date.now(), log: () => {} });
      f.otherMessage(1); // not a heartbeat → not registered → not watched
      vi.advanceTimersByTime(60_000);
      expect(f.kills).toEqual([]);
      expect(wd.watchedIds()).toEqual([]);
      wd.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() halts scanning (a now-silent worker is not killed after stop)', () => {
    vi.useFakeTimers();
    try {
      const f = fakeCluster();
      const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: f.workerById, rail: f.rail, scanMs: 5_000, silenceMs: 30_000, now: () => Date.now(), log: () => {} });
      f.beat(1);
      wd.stop();
      vi.advanceTimersByTime(60_000);
      expect(f.kills).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cluster lag condition measured recovery', () => {
  const scan = async (wd: ReturnType<typeof startClusterLagWatchdog>) => {
    await vi.advanceTimersByTimeAsync(1_000);
    await wd.settled();
  };
  it('keeps a killed worker open through sibling heartbeats and exit until a replacement beats', async () => {
    vi.useFakeTimers();
    const f = fakeCluster();
    const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: f.workerById,
      rail: f.rail, host: 'fixture-host', scanMs: 1_000, silenceMs: 2_000, log: () => {} });
    try {
      f.beat(1);
      vi.setSystemTime(Date.now() + 3_000);
      await scan(wd);
      expect(f.kills).toEqual([{ id: 1, signal: 'SIGKILL' }]);
      expect(f.rail.broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: 'alarm:cluster-lag:fixture-host' }));
      f.beat(2); // a new worker cannot replace a worker whose exit is unknown
      await scan(wd);
      expect(f.rail.resolve).not.toHaveBeenCalled();
      f.exit(1);
      f.beat(2); // existing healthy sibling still cannot clear it
      await scan(wd);
      expect(f.rail.resolve).not.toHaveBeenCalled();
      f.beat(3);
      f.beat(2);
      await scan(wd);
      expect(f.rail.resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: 'alarm:cluster-lag:fixture-host' }));
    } finally { wd.stop(); vi.useRealTimers(); }
  });

  it('resolves a failed kill only after that worker resumes; diagnostic errors cannot suppress the alarm', async () => {
    vi.useFakeTimers();
    const f = fakeCluster();
    const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: () => ({ id: 1,
      kill: () => { throw new Error('kill failed'); } }), rail: f.rail,
      host: 'fixture-host', scanMs: 1_000, silenceMs: 2_000,
      log: () => { throw new Error('log failed'); } });
    try {
      f.beat(1);
      vi.setSystemTime(Date.now() + 3_000);
      await scan(wd);
      expect(f.rail.broadcast).toHaveBeenCalledTimes(1);
      expect(f.rail.resolve).not.toHaveBeenCalled();
      f.beat(1);
      await scan(wd);
      expect(f.rail.resolve).toHaveBeenCalledTimes(1);
    } finally { wd.stop(); vi.useRealTimers(); }
  });

  it('does not resolve unseen, stopped, or missing-reference readings', async () => {
    vi.useFakeTimers();
    const f = fakeCluster();
    const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: () => undefined,
      rail: f.rail, scanMs: 1_000, silenceMs: 2_000, log: () => {} });
    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.rail.resolve).not.toHaveBeenCalled();
      f.beat(1);
      // Jump the injected clock without taking an intermediate healthy scan.
      vi.setSystemTime(Date.now() + 3_000);
      await scan(wd);
      expect(f.rail.broadcast).toHaveBeenCalled();
      expect(f.rail.resolve).not.toHaveBeenCalled();
      wd.stop(); f.beat(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.rail.resolve).not.toHaveBeenCalled();
    } finally { wd.stop(); vi.useRealTimers(); }
  });

  it('retries failed condition delivery without delaying or repeating the kill', async () => {
    vi.useFakeTimers();
    const f = fakeCluster();
    f.rail.broadcast.mockRejectedValueOnce(new Error('rail failed'));
    const diagnostics: string[] = [];
    const wd = startClusterLagWatchdog({ cluster: f.cluster, workerById: f.workerById,
      rail: f.rail, scanMs: 1_000, silenceMs: 2_000, log: (line) => diagnostics.push(line) });
    try {
      f.beat(1); vi.setSystemTime(Date.now() + 3_000);
      await scan(wd);
      expect(f.kills).toHaveLength(1);
      expect(diagnostics.some((line) => line.includes('condition delivery failed'))).toBe(true);
      await scan(wd);
      expect(f.rail.broadcast).toHaveBeenCalledTimes(2);
      expect(f.kills).toHaveLength(1);
    } finally { wd.stop(); vi.useRealTimers(); }
  });
});

describe('startWorkerHeartbeat', () => {
  it('sends a heartbeat immediately and on each interval', () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[] = [];
      const h = startWorkerHeartbeat({ beatMs: 2_000, send: (m) => sent.push(m) });
      expect(sent).toEqual([{ type: CLUSTER_HEARTBEAT_TYPE }]); // immediate announce
      vi.advanceTimersByTime(6_000);
      expect(sent.length).toBe(4); // 1 immediate + 3 intervals
      h.stop();
      vi.advanceTimersByTime(10_000);
      expect(sent.length).toBe(4); // stopped — no more beats
    } finally {
      vi.useRealTimers();
    }
  });

  it('is an inert no-op when no send channel exists (single-process / not a fork)', () => {
    const h = startWorkerHeartbeat({ send: undefined });
    expect(() => h.stop()).not.toThrow();
  });

  it('swallows a send throw (channel closed mid-beat)', () => {
    vi.useFakeTimers();
    try {
      const h = startWorkerHeartbeat({ beatMs: 1_000, send: () => { throw new Error('channel closed'); } });
      expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clusterLagWatchdogArmed', () => {
  it('is default-OFF and armed only by PAPERCUSP_CLUSTER_LAG_WATCHDOG=1', () => {
    expect(clusterLagWatchdogArmed({})).toBe(false);
    expect(clusterLagWatchdogArmed({ PAPERCUSP_CLUSTER_LAG_WATCHDOG: '0' })).toBe(false);
    expect(clusterLagWatchdogArmed({ PAPERCUSP_CLUSTER_LAG_WATCHDOG: '1' })).toBe(true);
  });
});
