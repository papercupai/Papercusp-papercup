/**
 * swarm-self-heal.test.ts — WI-752 / FED-2: the per-harness substrate swarm
 * must RE-PEER itself without an operator restart.
 *
 * Pre-WI-752, `joinHarnessSwarm` joined its topic ONCE and never re-ran
 * `discovery.refresh()`. So when an established peer connection died, or the
 * topic's DHT announce aged out, nothing re-announced + re-looked-up the topic
 * and the peer was never rediscovered — federation stayed dead until an operator
 * restart (the WI-559/WI-752 "federation sat dead ~7h" symptom; the swarm-chaos
 * test only converges because the TEST drives refresh itself).
 *
 * These are fast unit tests over the injected-swarm seam (no network, no PG, no
 * real timers): a fake swarm whose `join()` returns a `discovery.refresh` spy +
 * `vi` fake timers. They pin:
 *   1. the FAST cadence inside the post-join window,
 *   2. the SLOW keepalive after the window lapses (no DHT hammering),
 *   3. a peer-socket `close` RE-ARMS the fast window (snappy reconnect),
 *   4. `close()` stops the loop (no leaked timer),
 *   5. `refreshMs: 0` DISABLES the loop (byte-identical pre-WI-752 join).
 *
 * Mirrors directory-swarm.test.ts's refresh-loop tests — the substrate now runs
 * the SAME two-speed self-heal the hive-directory gossip already had.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Corestore from 'corestore';
import {
  joinHarnessSwarm,
  type HyperswarmLike,
  type SwarmHandle,
  DEFAULT_SUBSTRATE_REFRESH_MS,
} from './swarm';
import type { SwarmGuard } from './swarm-guard';

const TOPIC = Buffer.alloc(32, 7);

/** Allow-all guard — these tests exercise the re-peer loop, not the DoS gate. */
const ALLOW_GUARD: SwarmGuard = {
  firewall: () => false,
  isBannedKey: () => false,
  isBannedIp: () => false,
  banKey: () => {},
  banIp: () => {},
  recordConnection: async () => ({ allow: true }),
};

/** A corestore stub — the connection handler only calls `.replicate(socket)`. */
const STORE = { replicate: () => {} } as unknown as Corestore;

/** A fake peer socket whose `once('close', …)` callback the test can fire. */
function makeFakeSocket(): { socket: unknown; fireClose: () => void } {
  let closeCb: (() => void) | null = null;
  const socket = {
    on: () => {},
    once: (ev: string, fn: () => void) => {
      if (ev === 'close') closeCb = fn;
    },
  };
  return { socket, fireClose: () => closeCb?.() };
}

/** A fake swarm capturing `discovery.refresh()` calls + the connection handler. */
function makeFakeSwarm() {
  const refreshed: Array<object | undefined> = [];
  /** Date.now() at each refresh (fake-timer clock), for cadence assertions. */
  const refreshedAt: number[] = [];
  let connHandler: ((socket: unknown, info?: unknown) => void) | null = null;
  const swarm: HyperswarmLike = {
    join: () => ({
      flushed: async () => {},
      refresh: (o?: object) => {
        refreshed.push(o);
        refreshedAt.push(Date.now());
      },
    }),
    leave: () => {},
    on: (_ev: 'connection', listener: (socket: unknown, info?: unknown) => void) => {
      connHandler = listener;
    },
    off: () => {},
    connections: [],
  };
  return {
    swarm,
    refreshed,
    refreshedAt,
    /** Simulate the shared swarm emitting a peer connection. */
    emitConnection: (socket: unknown) => connHandler?.(socket),
  };
}

const handles: SwarmHandle[] = [];
afterEach(async () => {
  while (handles.length) {
    try {
      await handles.pop()!.close();
    } catch {
      /* best-effort */
    }
  }
  vi.useRealTimers();
});

describe('joinHarnessSwarm self-heal re-peer loop (WI-752 / FED-2)', () => {
  it('drives discovery.refresh() on the FAST cadence inside the post-join window', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 1000,
      slowRefreshMs: 10_000,
    });
    handles.push(handle);

    expect(f.refreshed).toHaveLength(0); // nothing before the first tick
    await vi.advanceTimersByTimeAsync(220);
    expect(f.refreshed.length).toBeGreaterThanOrEqual(3); // 50ms cadence → ~4 ticks
    // Re-announce + re-lookup is requested (the proven reconnect driver).
    expect(f.refreshed[0]).toEqual({ client: true, server: true });
  });

  it('backs off to the SLOW keepalive once the fast window lapses', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 1000,
    });
    handles.push(handle);

    await vi.advanceTimersByTimeAsync(200); // burn the fast window
    const afterFast = f.refreshed.length;
    expect(afterFast).toBeGreaterThanOrEqual(3);

    // DEAD ZONE: window lapsed, slow keepalive not yet due → no new refreshes.
    await vi.advanceTimersByTimeAsync(700);
    expect(f.refreshed.length).toBe(afterFast);

    // Slow keepalive fires (≥1000ms since the last refresh).
    await vi.advanceTimersByTimeAsync(400);
    expect(f.refreshed.length).toBe(afterFast + 1);
  });

  it('re-arms the FAST window when a peer socket closes (snappy reconnect)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 100_000, // slow keepalive far away — isolate the re-arm
    });
    handles.push(handle);

    // Connect a peer, then let the fast window lapse into the dead zone.
    const { socket, fireClose } = makeFakeSocket();
    f.emitConnection(socket);
    await vi.advanceTimersByTimeAsync(300);
    const beforeDrop = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(300); // still dead (window lapsed, slow far off)
    expect(f.refreshed.length).toBe(beforeDrop);

    // The peer drops → fast window RE-ARMS → fast refreshes resume immediately.
    fireClose();
    await vi.advanceTimersByTimeAsync(160);
    expect(f.refreshed.length).toBeGreaterThanOrEqual(beforeDrop + 3);
  });

  it('close() stops the loop (no leaked timer)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(f.refreshed.length).toBeGreaterThan(0);

    await handle.close();
    const n = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.refreshed.length).toBe(n); // no refresh after close
  });

  it('refreshMs: 0 disables the loop entirely (pre-WI-752 join)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 0,
    });
    handles.push(handle);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.refreshed).toHaveLength(0);
  });

  it('exports a sane default fast cadence', () => {
    expect(DEFAULT_SUBSTRATE_REFRESH_MS).toBeGreaterThan(0);
    expect(DEFAULT_SUBSTRATE_REFRESH_MS).toBeLessThanOrEqual(5000);
  });

  describe('WI-1534 anti-entropy: hasStalledLogs re-arms the FAST cadence', () => {
    it('stays on the FAST cadence past the fast window when hasStalledLogs() is true', async () => {
      vi.useFakeTimers();
      const f = makeFakeSwarm();
      const handle = await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC,
        swarm: f.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 100_000, // slow keepalive far away — isolate the stall trigger
        hasStalledLogs: () => true,
      });
      handles.push(handle);

      await vi.advanceTimersByTimeAsync(200); // burn the fast window
      const afterFastWindow = f.refreshed.length;
      expect(afterFastWindow).toBeGreaterThanOrEqual(3);

      // Quiescent hive: no connection churn to naturally re-arm the fast
      // window, and the slow keepalive is far off — WITHOUT hasStalledLogs
      // this would now be a dead zone (see the sibling test above). A
      // stalled admitted log keeps it on the fast cadence instead (for the
      // stall's own fast window — the stall was seen at the first tick).
      await vi.advanceTimersByTimeAsync(160);
      expect(f.refreshed.length).toBeGreaterThanOrEqual(afterFastWindow + 2);
    });

    // WI-10005270: a permanently peerless admitted log (an offline machine)
    // used to hold every topic on the 2.5 s cadence FOREVER — 47 topics drove
    // 5.35 DHT announce queries/s on bg-host. The stall now gets ONE fast
    // window, then an exponential backoff to stalledMaxRefreshMs.
    it('backs a persistent stall off exponentially to stalledMaxRefreshMs after its own fast window', async () => {
      vi.useFakeTimers();
      const f = makeFakeSwarm();
      let stalled = false;
      const handle = await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC,
        swarm: f.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 100_000,
        stalledMaxRefreshMs: 400,
        hasStalledLogs: () => stalled,
      });
      handles.push(handle);

      await vi.advanceTimersByTimeAsync(200); // burn the join's fast window
      stalled = true;
      const atStall = f.refreshed.length;
      await vi.advanceTimersByTimeAsync(200); // the stall's own fast window
      expect(f.refreshed.length).toBeGreaterThanOrEqual(atStall + 3);

      const base = f.refreshedAt.length - 1; // last fast refresh = the ladder's origin
      await vi.advanceTimersByTimeAsync(3_000);
      const times = f.refreshedAt.slice(base);
      const gaps = times.slice(1).map((t, i) => t - times[i]!);
      expect(gaps.length).toBeGreaterThanOrEqual(6);
      // Starts at refreshMs, never speeds up, doubles, and settles on the cap.
      expect(gaps[0]).toBe(50);
      for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]!);
      expect(gaps.slice(0, 4)).toEqual([50, 100, 200, 400]);
      expect(Math.max(...gaps)).toBe(400);
      expect(gaps.slice(-3)).toEqual([400, 400, 400]);
    });

    it('a stall that clears and recurs gets prompt retries again (the backoff resets)', async () => {
      vi.useFakeTimers();
      const f = makeFakeSwarm();
      let stalled = false;
      const handle = await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC,
        swarm: f.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 100_000,
        stalledMaxRefreshMs: 400,
        hasStalledLogs: () => stalled,
      });
      handles.push(handle);

      await vi.advanceTimersByTimeAsync(200);
      stalled = true;
      await vi.advanceTimersByTimeAsync(1_500); // grace + backoff up to the cap
      stalled = false;
      await vi.advanceTimersByTimeAsync(100); // replication resumed — stall clears
      stalled = true; // a NEW stall
      const atNewStall = f.refreshed.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(f.refreshed.length).toBeGreaterThanOrEqual(atNewStall + 3);
    });

    it('falls back to the dead-zone/slow-keepalive behavior once hasStalledLogs() clears', async () => {
      vi.useFakeTimers();
      const f = makeFakeSwarm();
      let stalled = true;
      const handle = await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC,
        swarm: f.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 100_000,
        hasStalledLogs: () => stalled,
      });
      handles.push(handle);

      await vi.advanceTimersByTimeAsync(200); // burn the fast window
      // The remote log catches up (replication resumed) — stall clears.
      stalled = false;
      const afterClear = f.refreshed.length;
      await vi.advanceTimersByTimeAsync(300); // dead zone: window lapsed, slow far off, no stall
      expect(f.refreshed.length).toBe(afterClear);
    });

    it('a throwing hasStalledLogs() is treated as "not stalled" (never breaks the loop)', async () => {
      vi.useFakeTimers();
      const f = makeFakeSwarm();
      const handle = await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC,
        swarm: f.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 50,
        fastWindowMs: 200,
        slowRefreshMs: 1000,
        hasStalledLogs: () => {
          throw new Error('boom');
        },
      });
      handles.push(handle);

      await vi.advanceTimersByTimeAsync(200);
      const afterFast = f.refreshed.length;
      expect(afterFast).toBeGreaterThanOrEqual(3);
      // Dead zone still applies (a throwing predicate never force-fast-tracks).
      await vi.advanceTimersByTimeAsync(700);
      expect(f.refreshed.length).toBe(afterFast);
      // Slow keepalive still fires normally.
      await vi.advanceTimersByTimeAsync(400);
      expect(f.refreshed.length).toBe(afterFast + 1);
    });
  });
});
