import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listModuleDuplications,
  resetPinnedModuleStateForTest,
} from '@papercusp/module-singleton';
import {
  ALIGNED_PHASE_MIN_INTERVAL_MS,
  ALIGNED_PHASE_WARMUP_MS,
  alignedSlotDelayMs,
  configureScheduledRegistry,
  createManagedSweepStarter,
  getManaged,
  listManaged,
  managedCount,
  managedSetInterval,
  managedTickThresholdMs,
  resetScheduledRegistry,
  stopAllManaged,
  type TimerHandle,
} from './index';

/** Flush microtasks (the tick's Promise chain) + one macrotask. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface CapturedInterval {
  cb: () => void;
  ms: number;
  handle: TimerHandle;
  cleared: boolean;
}

function harness() {
  const intervals: CapturedInterval[] = [];
  const timeouts: { cb: () => void; ms: number }[] = [];
  let now = 1_000_000;
  let shed = false;
  configureScheduledRegistry({
    setIntervalImpl: (cb, ms) => {
      const handle: TimerHandle = { unref: () => undefined };
      intervals.push({ cb, ms, handle, cleared: false });
      return handle;
    },
    clearIntervalImpl: (h) => {
      const e = intervals.find((i) => i.handle === h);
      if (e) e.cleared = true;
    },
    setTimeoutImpl: (cb, ms) => {
      timeouts.push({ cb, ms });
      return { unref: () => undefined };
    },
    now: () => now,
    shouldShed: () => shed,
    log: () => undefined,
  });
  return {
    intervals,
    timeouts,
    setNow: (n: number) => {
      now = n;
    },
    setShed: (s: boolean) => {
      shed = s;
    },
    /** Synchronously invoke a captured interval cb, then flush its async chain. */
    fire: async (i = 0): Promise<void> => {
      intervals[i].cb();
      await flush();
    },
  };
}

afterEach(() => resetScheduledRegistry());

describe('managed sweep starters', () => {
  it('preserves metadata and cadence, and replaces the previous named timer', async () => {
    const h = harness();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const start = createManagedSweepStarter({ name: 'sweep', intervalMs: 100,
      options: { category: 'watchdog', classification: 'timeout-reaper' }, onError: vi.fn() });
    expect(h.intervals).toHaveLength(0);
    start(first);
    expect(h.intervals[0].ms).toBe(100);
    start(second, 53);
    expect(h.intervals[0].cleared).toBe(true);
    expect(getManaged('sweep')).toMatchObject({ intervalMs: 53, category: 'watchdog', classification: 'timeout-reaper' });
    await h.fire(0);
    expect(first).not.toHaveBeenCalled();
    await h.fire(1);
    expect(second).toHaveBeenCalledOnce();
  });

  it('keeps the registry overlap guard held until the actual async sweep settles', async () => {
    const h = harness();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    createManagedSweepStarter({ name: 'slow', intervalMs: 100,
      options: { category: 'watchdog' }, onError: vi.fn() })(run);
    await h.fire();
    await h.fire();
    await h.fire();
    expect(run).toHaveBeenCalledOnce();
    expect(getManaged('slow')).toMatchObject({ running: true, skippedWhileRunning: 2 });
    finish();
    await flush();
    expect(getManaged('slow')).toMatchObject({ running: false, fires: 1 });
    await h.fire();
    expect(run).toHaveBeenCalledTimes(2);
    finish();
    await flush();
  });

  it('delivers rejected and synchronous failures and releases the guard for the next tick', async () => {
    const h = harness();
    const rejected = new Error('rejected sweep');
    const thrown = new Error('synchronous sweep');
    const onError = vi.fn();
    const run = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(rejected)
      .mockImplementationOnce(() => { throw thrown; }).mockResolvedValue(undefined);
    createManagedSweepStarter({ name: 'errors', intervalMs: 100,
      options: { category: 'watchdog' }, onError })(run);
    await h.fire();
    await h.fire();
    await h.fire();
    expect(onError.mock.calls).toEqual([[rejected], [thrown]]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(getManaged('errors')).toMatchObject({ running: false, fires: 3 });
  });
});

describe('managed tick hang episodes', () => {
  it.each([
    [1_000, undefined, 300_000], [120_000, undefined, 600_000],
    [120_000, 10_000, 300_000], [1_000, 420_000, 420_000],
    [120_000, 360_000, 360_000], [120_000, 0, 600_000],
    [120_000, -1, 600_000], [120_000, NaN, 600_000], [120_000, Infinity, 600_000],
  ])('uses the declared threshold for interval %s and override %s', (interval, custom, expected) => {
    expect(managedTickThresholdMs(interval, custom)).toBe(expected);
  });

  it.each([1_000, 120_000])('raises only past T on its independent watcher (%sms)', async (intervalMs) => {
    const h = harness();
    h.setNow(0);
    const open = new Map<number, { timerName: string; heldMs: number }>();
    const raises = vi.fn((e) => { open.set(e.id, e); });
    const resolves = vi.fn((e) => { open.delete(e.id); });
    configureScheduledRegistry({ onHungTick: raises, onHungTickSettled: resolves });
    let finish!: () => void;
    managedSetInterval('held', intervalMs, () => new Promise<void>((r) => { finish = r; }), {
      category: 'global-sweep', phase: 'arm',
    });
    await h.fire();
    const watcher = h.intervals[1];
    expect(watcher.ms).toBeLessThanOrEqual(Math.min(intervalMs, 60_000));
    const threshold = Math.max(5 * intervalMs, 300_000);
    for (const at of [threshold - 1, threshold]) {
      h.setNow(at);
      await h.fire(1);
      expect(open.size).toBe(0);
    }
    h.setNow(threshold + 1);
    // No further target fire is required: a held target cannot disable its watcher.
    await h.fire(1);
    expect([...open.values()]).toEqual([expect.objectContaining({ timerName: 'held', heldMs: threshold + 1 })]);
    h.setNow(threshold + watcher.ms);
    await h.fire(1);
    await h.fire(0);
    expect(raises).toHaveBeenCalledOnce();
    finish();
    await flush();
    expect(resolves).toHaveBeenCalledOnce();
    expect(open.size).toBe(0);
    expect(watcher.cleared).toBe(true);
  });

  it('honors a clamped custom threshold at the watcher deadline', async () => {
    const h = harness();
    h.setNow(0);
    const raised = vi.fn();
    configureScheduledRegistry({ onHungTick: raised });
    managedSetInterval('custom', 120_000, () => new Promise<void>(() => {}), {
      category: 'global-sweep', hungTickThresholdMs: 1,
    });
    await h.fire();
    h.setNow(300_000);
    await h.fire(1);
    expect(raised).not.toHaveBeenCalled();
    h.setNow(360_000);
    await h.fire(1);
    expect(raised).toHaveBeenCalledWith(expect.objectContaining({ thresholdMs: 300_000, heldMs: 360_000 }));
  });

  it('separates simultaneous instanced ticks and later episodes of the same timer', async () => {
    const h = harness();
    h.setNow(0);
    const open = new Set<number>();
    const raised = vi.fn((e) => { open.add(e.id); });
    const resolved = vi.fn((e) => { open.delete(e.id); });
    configureScheduledRegistry({ onHungTick: raised, onHungTickSettled: resolved });
    const finishes: (() => void)[] = [];
    const tick = () => new Promise<void>((r) => { finishes.push(r); });
    managedSetInterval('same-name', 1_000, tick, { category: 'lifecycle', instanced: true });
    managedSetInterval('same-name', 1_000, tick, { category: 'lifecycle', instanced: true });
    await h.fire(0);
    await h.fire(1);
    h.setNow(300_001);
    await h.fire(2);
    await h.fire(3);
    expect(open.size).toBe(2);
    const first = raised.mock.calls[0][0].id;
    finishes[1]();
    await flush();
    expect(open).toEqual(new Set([first]));
    finishes[0]();
    await flush();
    expect(open.size).toBe(0);
    await h.fire(0);
    h.setNow(600_002);
    await h.fire(4);
    expect(raised.mock.calls[2][0].id).not.toBe(first);
  });

  it('orders resolution after an in-flight raise without holding the target guard', async () => {
    const h = harness();
    h.setNow(0);
    const events: string[] = [];
    let deliver!: () => void;
    let finish!: () => void;
    configureScheduledRegistry({
      onHungTick: () => new Promise<void>((r) => { deliver = () => { events.push('raised'); r(); }; }),
      onHungTickSettled: () => { events.push('resolved'); },
    });
    managedSetInterval('delivery-race', 1_000, () => new Promise<void>((r) => { finish = r; }), { category: 'global-sweep' });
    await h.fire();
    h.setNow(300_001);
    await h.fire(1);
    finish();
    await flush();
    expect(getManaged('delivery-race')?.running).toBe(false);
    expect(events).toEqual([]);
    deliver();
    await flush();
    expect(events).toEqual(['raised', 'resolved']);
  });
});

describe('managedSetInterval / listManaged', () => {
  it('registers a named, listable entry with category + interval + armedAt', () => {
    const h = harness();
    h.setNow(5_000);
    managedSetInterval('system-health', 30_000, () => undefined, { category: 'global-sweep', shed: true });

    expect(managedCount()).toBe(1);
    const [e] = listManaged();
    expect(e).toMatchObject({
      name: 'system-health',
      category: 'global-sweep',
      intervalMs: 30_000,
      armedAt: 5_000,
      lastFireAt: null,
      fires: 0,
      shed: true,
    });
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0].ms).toBe(30_000);
  });

  it('keeps the default recurring backend inert under Vitest unless a test opts in', () => {
    // The deterministic harness above intentionally injects a fake backend, so it remains
    // active in Vitest. This case covers the production/default backend that must not leak a
    // process-wide callback across factory-mocked modules in an unrelated test.
    resetScheduledRegistry();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const skipped = managedSetInterval('vitest-inert', 1_000, () => undefined, { category: 'watchdog' });
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(managedCount()).toBe(0);
      skipped.stop();

      const allowed = managedSetInterval('vitest-allowed', 1_000, () => undefined, {
        category: 'watchdog',
        allowInTest: true,
      });
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      allowed.stop();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      resetScheduledRegistry();
    }
  });

  it('a fire stamps lastFireAt + increments fires + clears lastError', async () => {
    const h = harness();
    let calls = 0;
    managedSetInterval('sweep', 1000, () => {
      calls += 1;
    }, { category: 'global-sweep' });

    h.setNow(2_000);
    await h.fire();
    expect(calls).toBe(1);
    expect(getManaged('sweep')).toMatchObject({ lastFireAt: 2_000, fires: 1, lastError: null });

    h.setNow(3_000);
    await h.fire();
    expect(getManaged('sweep')).toMatchObject({ lastFireAt: 3_000, fires: 2 });
  });

  it('a throwing tick records lastError but never crashes; the next tick recovers', async () => {
    const h = harness();
    let fail = true;
    managedSetInterval('flaky', 1000, () => {
      if (fail) throw new Error('boom');
    }, { category: 'global-sweep' });

    await h.fire();
    expect(getManaged('flaky')).toMatchObject({ fires: 1, lastError: 'boom' });

    fail = false;
    await h.fire();
    expect(getManaged('flaky')).toMatchObject({ fires: 2, lastError: null });
  });

  it('re-entrancy guard: a slow tick never piles up a second concurrent run', async () => {
    const h = harness();
    let resolveFn!: () => void;
    managedSetInterval('slow', 1000, () => new Promise<void>((r) => {
      resolveFn = r;
    }), { category: 'global-sweep' });

    h.intervals[0].cb(); // start tick 1
    await Promise.resolve(); // let the chain call fn() (captures resolveFn) + set running
    expect(getManaged('slow')!.running).toBe(true);

    h.intervals[0].cb(); // tick 2 while tick 1 in flight → skipped
    await flush();
    expect(getManaged('slow')!.fires).toBe(0); // tick 1 still pending, tick 2 skipped

    resolveFn(); // finish tick 1
    await flush();
    expect(getManaged('slow')!.fires).toBe(1); // only tick 1 counted
    expect(getManaged('slow')!.running).toBe(false);
  });

  it('a wedged async tick is VISIBLE: runningSince + skippedWhileRunning + O(log n) log lines (EI-25221129396992808)', async () => {
    const h = harness();
    const logs: string[] = [];
    configureScheduledRegistry({ log: (m) => logs.push(m) });
    let resolveFn!: () => void;
    managedSetInterval('wedged', 30_000, () => new Promise<void>((r) => {
      resolveFn = r;
    }), { category: 'global-sweep' });

    h.setNow(1_000_000);
    h.intervals[0].cb(); // tick starts and never settles on its own
    await Promise.resolve();
    expect(getManaged('wedged')!.runningSince).toBe(1_000_000);
    expect(getManaged('wedged')!.skippedWhileRunning).toBe(0);

    // Ten later fires land while the first tick is still in flight.
    for (let i = 1; i <= 10; i += 1) {
      h.setNow(1_000_000 + i * 30_000);
      h.intervals[0].cb();
    }
    await flush();
    const entry = getManaged('wedged')!;
    expect(entry.running).toBe(true);
    expect(entry.fires).toBe(0); // frozen: this is the silent signature the counter exposes
    expect(entry.skippedWhileRunning).toBe(10);
    // One skip is jitter and is not reported; 2, 4 and 8 are (power-of-two backoff).
    const still = logs.filter((m) => m.includes('tick still running'));
    expect(still).toHaveLength(3);
    expect(still[0]).toContain('wedged tick still running after 60000ms (2 fire(s) skipped');
    expect(still[2]).toContain('after 240000ms (8 fire(s) skipped');

    h.setNow(1_000_000 + 330_000);
    resolveFn();
    await flush();
    const done = getManaged('wedged')!;
    expect(done.running).toBe(false);
    expect(done.runningSince).toBeNull();
    expect(done.fires).toBe(1);
    expect(done.skippedWhileRunning).toBe(10); // cumulative, survives the episode
    expect(logs.filter((m) => m.includes('long tick finished'))).toEqual([
      'wedged long tick finished after 330000ms (10 fire(s) skipped while it ran, interval 30000ms)',
    ]);

    // The episode counter resets: a single later overlap is jitter again and logs nothing new.
    logs.length = 0;
    h.intervals[0].cb();
    await Promise.resolve();
    h.intervals[0].cb();
    resolveFn();
    await flush();
    expect(logs).toEqual([]);
    expect(getManaged('wedged')!.skippedWhileRunning).toBe(11);
  });

  it('a tick that overruns by ONE interval is not reported (jitter, not a wedge)', async () => {
    const h = harness();
    const logs: string[] = [];
    configureScheduledRegistry({ log: (m) => logs.push(m) });
    let resolveFn!: () => void;
    managedSetInterval('jitter', 1000, () => new Promise<void>((r) => {
      resolveFn = r;
    }), { category: 'global-sweep' });
    h.intervals[0].cb();
    await Promise.resolve();
    h.intervals[0].cb(); // one skipped fire
    resolveFn();
    await flush();
    expect(getManaged('jitter')!.skippedWhileRunning).toBe(1);
    expect(logs).toEqual([]);
  });

  it('shed: a shed:true timer skips a cycle when shouldShed() is true; a non-shed timer does not', async () => {
    const h = harness();
    let shedCalls = 0;
    let alwaysCalls = 0;
    managedSetInterval('heavy', 1000, () => {
      shedCalls += 1;
    }, { category: 'global-sweep', shed: true });
    managedSetInterval('light', 1000, () => {
      alwaysCalls += 1;
    }, { category: 'global-sweep' });

    h.setShed(true);
    await h.fire(0); // heavy — shed
    await h.fire(1); // light — runs
    expect(shedCalls).toBe(0);
    expect(alwaysCalls).toBe(1);

    h.setShed(false);
    await h.fire(0); // heavy — now runs
    expect(shedCalls).toBe(1);
  });

  it('fireOnArm schedules an immediate setTimeout(0) tick', async () => {
    const h = harness();
    let calls = 0;
    managedSetInterval('healer', 600_000, () => {
      calls += 1;
    }, { category: 'global-sweep', fireOnArm: true });

    expect(h.timeouts).toHaveLength(1);
    expect(h.timeouts[0].ms).toBe(0);
    h.timeouts[0].cb(); // simulate the immediate fire
    await flush();
    expect(calls).toBe(1);
  });

  it('keeps a requested CLI lifetime referenced across alignment and stops both interval generations', () => {
    const timers: Array<{ unref: ReturnType<typeof vi.fn>; cleared: boolean; callback: () => void }> = [];
    const capture = (callback: () => void) => {
      const timer = { unref: vi.fn(), cleared: false, callback };
      timers.push(timer);
      return timer;
    };
    configureScheduledRegistry({
      now: () => 1_000_000,
      setIntervalImpl: capture,
      setTimeoutImpl: capture,
      clearIntervalImpl: handle => { (handle as typeof timers[number]).cleared = true; },
    });
    const background = managedSetInterval('background', 1_000, () => undefined, { category: 'lifecycle' });
    expect(timers[0].unref).toHaveBeenCalledOnce();
    background.stop();
    const lifetime = managedSetInterval('cli-lifetime', 600_000, () => undefined, {
      category: 'lifecycle', classification: 'timeout-reaper', ref: true, phase: 'aligned',
    });
    expect(timers.slice(1).every(timer => timer.unref.mock.calls.length === 0)).toBe(true);
    const rephase = timers[2];
    expect(rephase).toBeDefined();
    rephase.callback();
    expect(timers[1].cleared).toBe(true);
    expect(timers[3].unref).not.toHaveBeenCalled();
    lifetime.stop();
    expect(timers[3].cleared).toBe(true);
    expect(getManaged('cli-lifetime')).toBeUndefined();
  });

  it('stop() clears the underlying timer and deregisters from the inventory', () => {
    const h = harness();
    const handle = managedSetInterval('x', 1000, () => undefined, { category: 'watchdog' });
    expect(managedCount()).toBe(1);
    handle.stop();
    expect(managedCount()).toBe(0);
    expect(getManaged('x')).toBeUndefined();
    expect(h.intervals[0].cleared).toBe(true);
    handle.stop(); // idempotent
    expect(managedCount()).toBe(0);
  });

  it('re-registering a name stops the previous timer (no duplicate, no leak)', () => {
    const h = harness();
    managedSetInterval('dup', 1000, () => undefined, { category: 'cache' });
    managedSetInterval('dup', 2000, () => undefined, { category: 'cache' });
    expect(managedCount()).toBe(1);
    expect(getManaged('dup')!.intervalMs).toBe(2000);
    expect(h.intervals[0].cleared).toBe(true); // the first timer was cleared
    expect(h.intervals[1].cleared).toBe(false);
  });

  it('listManaged returns sorted snapshots; stopAllManaged clears everything', () => {
    harness();
    managedSetInterval('zeta', 1000, () => undefined, { category: 'global-sweep' });
    managedSetInterval('alpha', 1000, () => undefined, { category: 'lifecycle' });
    expect(listManaged().map((e) => e.name)).toEqual(['alpha', 'zeta']);
    // snapshot — mutating the returned array/objects doesn't affect the registry
    listManaged()[0].fires = 99;
    expect(getManaged('alpha')!.fires).toBe(0);
    stopAllManaged();
    expect(managedCount()).toBe(0);
  });

  it('instanced: many timers share ONE name without colliding, and aggregate in listManaged', () => {
    const h = harness();
    const a = managedSetInterval('ws-keepalive', 20_000, () => undefined, { category: 'lifecycle', instanced: true });
    managedSetInterval('ws-keepalive', 20_000, () => undefined, { category: 'lifecycle', instanced: true });
    const c = managedSetInterval('ws-keepalive', 20_000, () => undefined, { category: 'lifecycle', instanced: true });

    // 3 raw timers armed (NO collision — none stopped the prior)
    expect(h.intervals.length).toBe(3);
    expect(managedCount()).toBe(3);
    // ...but ONE aggregated inventory row carrying the live instance count
    const rows = listManaged();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'ws-keepalive', instanced: true, instances: 3 });
    expect(getManaged('ws-keepalive')).toMatchObject({ instances: 3 });

    // stopping one instance drops the count; the row stays until the last instance stops
    a.stop();
    expect(managedCount()).toBe(2);
    expect(listManaged()[0].instances).toBe(2);
    c.stop();
    expect(listManaged()[0].instances).toBe(1);
  });

  it('instanced aggregation rolls up fires + most-recent lastFire across instances', async () => {
    const h = harness();
    managedSetInterval('hb', 1000, () => undefined, { category: 'lifecycle', instanced: true });
    managedSetInterval('hb', 1000, () => undefined, { category: 'lifecycle', instanced: true });
    h.setNow(5_000);
    await h.fire(0); // instance 0 fires
    h.setNow(8_000);
    await h.fire(1); // instance 1 fires later
    const row = getManaged('hb')!;
    expect(row.instances).toBe(2);
    expect(row.fires).toBe(2); // summed
    expect(row.lastFireAt).toBe(8_000); // most-recent across instances
  });
});

/**
 * P-011 (stop-discarded-dedup-and-audit-server-polling-2026-07-26): the D-004 push-don't-poll
 * `classification` a call site declares must actually reach the INVENTORY — that is the whole
 * point of the field. `lint:timer-classification` enforces that new call sites DECLARE one;
 * nothing below it proved the declared value is stored, defaulted, or aggregated correctly.
 */
describe('timer classification (P-011 / D-004)', () => {
  it('records a declared classification on the entry and surfaces it in the inventory', () => {
    harness();
    managedSetInterval('system-health', 30_000, () => undefined, {
      category: 'global-sweep',
      classification: 'violation',
    });

    expect(listManaged()[0].classification).toBe('violation');
    expect(getManaged('system-health')?.classification).toBe('violation');
  });

  it('defaults to null when the call site omits one (a site the shrink-only lint BASELINE still grandfathers)', () => {
    harness();
    managedSetInterval('legacy-sweep', 1000, () => undefined, { category: 'global-sweep' });

    // null, NOT undefined: the inventory column is always present, so a grandfathered
    // site reads as "not yet classified" rather than as a missing field.
    expect(getManaged('legacy-sweep')?.classification).toBeNull();
  });

  it.each(['must-sample', 'timeout-reaper', 'violation'] as const)(
    'round-trips the %s verdict unchanged',
    (verdict) => {
      harness();
      managedSetInterval(`t-${verdict}`, 1000, () => undefined, {
        category: 'global-sweep',
        classification: verdict,
      });
      expect(getManaged(`t-${verdict}`)?.classification).toBe(verdict);
    },
  );

  it('instanced aggregation adopts a later instance classification when the first declared none', () => {
    harness();
    // Per-connection timers are armed from one call site, but an UNCLASSIFIED arm must not
    // mask a classified sibling — otherwise the inventory row reports "unclassified" for a
    // timer that was in fact classified, and the audit under-counts.
    managedSetInterval('ws-keepalive', 20_000, () => undefined, { category: 'lifecycle', instanced: true });
    managedSetInterval('ws-keepalive', 20_000, () => undefined, {
      category: 'lifecycle',
      instanced: true,
      classification: 'must-sample',
    });

    const row = getManaged('ws-keepalive')!;
    expect(row.instances).toBe(2);
    expect(row.classification).toBe('must-sample');
  });

  it('instanced aggregation is FIRST-WINS: a later differing classification does not overwrite one already set', () => {
    harness();
    managedSetInterval('mixed', 20_000, () => undefined, {
      category: 'lifecycle',
      instanced: true,
      classification: 'must-sample',
    });
    managedSetInterval('mixed', 20_000, () => undefined, {
      category: 'lifecycle',
      instanced: true,
      classification: 'violation',
    });

    // Pinning the documented intent of the `g.classification == null` guard in listManaged():
    // instances of ONE name are the same call site, so a disagreement is a code bug, not a
    // state to merge. First-wins keeps the row stable rather than order-dependent-looking;
    // if divergent classifications per name ever become legitimate, THIS test is the one to
    // revisit deliberately.
    expect(getManaged('mixed')?.classification).toBe('must-sample');
  });
});

describe('dual module instance shares ONE inventory (EI-19451658870832332)', () => {
  // `vi.resetModules()` drops the module registry, so the dynamic import below RE-EVALUATES
  // index.ts and hands back a genuinely SEPARATE module instance. That is the production
  // hazard reproduced in-process: the host entry runs under tsx (CJS preflight + ESM loader),
  // importers reach this package through both bare-specifier and relative paths, and
  // node_modules/@papercusp/* are symlinks — any of which yields two module records.
  //
  // Falsifiable by construction: with the state held in module scope (as it was before
  // EI-19451658870832332) the re-evaluated instance starts with an EMPTY Map, so every
  // expectation below fails. It measured live as dbos-executor-reaper reaping every 2 minutes
  // inside bg-host while absent from that same process's own /api/internal/managed-timers.

  it('CONTROL: vi.resetModules() really does re-evaluate — module-scoped state comes back EMPTY', async () => {
    // Calibration, not a feature test. If this ever fails, resetModules() has stopped
    // producing a second instance and EVERY assertion in this describe block below is
    // passing vacuously — fix this before trusting them.
    const control = await import('./module-scoped-control.fixture');
    control.marks.push('first-instance');
    expect(control.marks).toEqual(['first-instance']);

    vi.resetModules();
    const controlAgain = await import('./module-scoped-control.fixture');

    expect(controlAgain.marks).toEqual([]);
    expect(controlAgain.marks).not.toBe(control.marks);
  });

  it('a timer armed in the FIRST instance is visible to a second, freshly-evaluated instance', async () => {
    harness();
    managedSetInterval('dual-instance-probe', 1000, () => undefined, { category: 'watchdog' });
    expect(listManaged().map((e) => e.name)).toContain('dual-instance-probe');

    vi.resetModules();
    const second = await import('./index');

    expect(second.listManaged().map((e) => e.name)).toContain('dual-instance-probe');
    expect(second.managedCount()).toBe(managedCount());
    expect(second.getManaged('dual-instance-probe')?.intervalMs).toBe(1000);
  });

  it('is symmetric — a timer armed in the SECOND instance is visible to the first', async () => {
    harness();
    vi.resetModules();
    const second = await import('./index');

    second.managedSetInterval('armed-in-second', 2000, () => undefined, { category: 'cache' });

    expect(listManaged().map((e) => e.name)).toContain('armed-in-second');
    expect(getManaged('armed-in-second')?.category).toBe('cache');
  });

  it('shares the CONFIGURED seams, so the second instance cannot silently run unshedded', async () => {
    // The second-order half of the same bug: `configureScheduledRegistry` writes to the same
    // state, so a hidden instance must not fall back to default seams (real setInterval, no
    // host tick-load-shed). Asserted via the fake setIntervalImpl installed by harness() on
    // the FIRST instance — an unshared config would arm a REAL timer and capture nothing.
    const h = harness();
    const before = h.intervals.length;

    vi.resetModules();
    const second = await import('./index');
    second.managedSetInterval('seam-probe', 3000, () => undefined, { category: 'watchdog' });

    expect(h.intervals.length).toBe(before + 1);
    expect(h.intervals[before].ms).toBe(3000);
  });

  // --- recurrence guard (EI-19463700807328229) -------------------------------
  // Pinning fixed the split but HID it: once both records share one state
  // object, nothing distinguishes one record from two. These assert the module
  // now reports its own duplication, so a re-split is caught by the inventory
  // instead of costing another multi-session investigation.

  /**
   * Start these assertions from a realm with NO pinned state.
   *
   * Earlier tests in this file re-evaluate the module on purpose, and the
   * evaluation count is cumulative across the whole suite by design — so each
   * count assertion below has to establish its own baseline or it measures the
   * suite's history instead of its own case.
   *
   * `resetPinnedModuleStateForTest` is the primitive's own test seam. Reaching
   * past it to `delete globalThis[Symbol.for(...)]` (as this file did while the
   * pin was hand-rolled here) would silently stop resetting anything the day the
   * key moved — which is exactly what happened when this module adopted
   * `@papercusp/module-singleton`: the deletes kept succeeding, cleared nothing,
   * and the counts read cumulative.
   */
  const freshRealm = () => {
    vi.resetModules();
    resetPinnedModuleStateForTest();
  };

  it('reports exactly one module evaluation, and no warning, when healthy', async () => {
    // Fresh realm for this assertion: earlier tests in this file deliberately
    // re-evaluate the module, so the count is cumulative across the suite.
    freshRealm();

    const fresh = await import('./index');

    expect(fresh.moduleEvaluationCount()).toBe(1);
    expect(fresh.moduleDuplicationWarning()).toBeNull();
  });

  it('counts a SECOND module record and warns — the recurrence signal', async () => {
    freshRealm();

    const first = await import('./index');
    expect(first.moduleEvaluationCount()).toBe(1);

    vi.resetModules();
    const second = await import('./index');

    // Both module records agree, because the counter lives in the pinned state.
    expect(second.moduleEvaluationCount()).toBe(2);
    expect(first.moduleEvaluationCount()).toBe(2);

    const warning = second.moduleDuplicationWarning();
    expect(warning).toContain('SPLIT MODULE SINGLETON');
    expect(warning).toContain('2x');
    // Must say the inventory is still trustworthy — the fix holds; it is the
    // PACKAGING that regressed. Reading this as "the timer list is wrong" would
    // send the next reader down the wrong path.
    expect(warning).toMatch(/packaging fault/i);
  });

  it('keeps the counter in the pinned state, so it cannot itself split', async () => {
    freshRealm();

    await import('./index');
    vi.resetModules();
    await import('./index');
    vi.resetModules();
    const third = await import('./index');

    // A module-scoped counter would read 1 here (fresh record); the pinned one reads 3.
    expect(third.moduleEvaluationCount()).toBe(3);
  });

  it('surfaces a split in the REALM-WIDE duplication report, not only its own accessor', async () => {
    // The point of pinning through @papercusp/module-singleton rather than
    // hand-rolling it here (EI-19463700807328229).
    //
    // While the pin was local, `moduleEvaluationCount()` on THIS module was the
    // only way to learn it had split: `listModuleDuplications()` — the central
    // report a host health check reads — knew nothing about it. That is the
    // original bug's own shape recreated one level up: the surface responsible
    // for reporting duplication would have been blind to the single module known
    // to duplicate in production, and would have answered a confident, empty
    // "no duplications".
    freshRealm();
    await import('./index');

    // Baseline: one evaluation is not a duplication, so the report stays empty.
    expect(listModuleDuplications().map((d) => d.key)).not.toContain(
      '@papercusp/scheduled-registry.state',
    );

    vi.resetModules();
    await import('./index');

    const reported = listModuleDuplications().find(
      (d) => d.key === '@papercusp/scheduled-registry.state',
    );
    expect(reported).toBeDefined();
    expect(reported?.evaluations).toBe(2);
  });
});

describe('the Vitest inertness guard distinguishes REAL timers from FAKE ones (WI-40841)', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetScheduledRegistry();
  });

  // The guard added for EI-21209553211440005 keeps the DEFAULT backend inert under Vitest so a
  // wall-clock callback cannot fire into another test's factory mocks. Its condition ("no
  // injected setIntervalImpl") also catches `vi.useFakeTimers()`, which is a perfectly
  // deterministic seam — and that silently red-pinned every fake-timer test over a
  // managedSetInterval call site (116 non-test sites; ~34 test files red from 03:00Z).
  //
  // `defaultSetIntervalImpl` resolves `setInterval` at CALL time, so under fake timers the
  // default backend is ALREADY driven by the fake clock. Arming is therefore safe: the callback
  // belongs to the clock and is torn down with it, so it cannot outlive the test.
  it('ARMS and FIRES under vi.useFakeTimers() with no injected backend', async () => {
    resetScheduledRegistry(); // default (production) backend in play — nothing injected
    vi.useFakeTimers();

    const tick = vi.fn();
    const handle = managedSetInterval('wi-40841-fake-clock', 1_000, tick, {
      category: 'watchdog',
    });

    // The inert path returns a no-op handle and registers nothing at all.
    expect(managedCount()).toBe(1);
    expect(getManaged('wi-40841-fake-clock')).toBeDefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  // The control for the ORIGINAL defect (EI-21209553211440005): with genuinely REAL timers the
  // default backend must still be inert, or that unhandled-rejection class returns. If this ever
  // fails, the fix above has been over-applied.
  // WI-10002781: a CHILD process a test spawns inherits VITEST=true through its env, but it is
  // not a Vitest worker: no test files, no factory mocks, and it needs its production intervals
  // (a perf peer's merge poll). When the guard keyed on the env var alone, those children ran
  // with every managed interval inert and substrate-compaction.integration.test.ts hung to its
  // 600s timeout. Simulate that child in-process: env var present, worker-state global absent.
  it('ARMS the default backend in a spawned child that inherited VITEST but is not a worker', () => {
    resetScheduledRegistry();
    expect(process.env.VITEST, 'precondition: the inherited env var is present').toBeTruthy();
    const g = globalThis as { __vitest_worker__?: unknown };
    expect(g.__vitest_worker__, 'precondition: this test runs inside a real worker').toBeDefined();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const savedWorkerState = g.__vitest_worker__;
    let handle: { stop(): void } | undefined;
    try {
      // Only the managedSetInterval call runs without the worker global; it is restored before
      // any assertion, since Vitest's own APIs read it.
      delete g.__vitest_worker__;
      try {
        handle = managedSetInterval('wi-10002781-spawned-child', 60_000, () => undefined, {
          category: 'watchdog',
        });
      } finally {
        g.__vitest_worker__ = savedWorkerState;
      }
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(managedCount()).toBe(1);
      expect(getManaged('wi-10002781-spawned-child')).toBeDefined();
    } finally {
      handle?.stop();
      setIntervalSpy.mockRestore();
      resetScheduledRegistry();
    }
  });

  it('still keeps the default backend inert when timers are REAL', () => {
    resetScheduledRegistry();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const skipped = managedSetInterval('wi-40841-real-clock', 1_000, () => undefined, {
        category: 'watchdog',
      });
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(managedCount()).toBe(0);
      skipped.stop();
    } finally {
      setIntervalSpy.mockRestore();
      resetScheduledRegistry();
    }
  });
});

describe('restart-resilient aligned phase (WI-10005289)', () => {
  const HOUR = 60 * 60_000;
  const MIN = 60_000;

  /** An arm time exactly `before` ms ahead of `name`'s slot (computed, never wall-clock). */
  function armBeforeSlot(name: string, intervalMs: number, before: number): { arm: number; slot: number } {
    const t0 = 1_790_914_874_000;
    const slot = t0 + alignedSlotDelayMs(name, intervalMs, t0);
    return { arm: slot - before, slot };
  }

  /**
   * Drive one timer across a sequence of host lifetimes (each a fresh registry, as after a
   * restart), running every scheduled callback that falls inside its lifetime. Returns the
   * instants the timer actually fired.
   */
  async function simulateRestarts(
    name: string,
    intervalMs: number,
    uptimesMin: number[],
    phase: 'aligned' | 'arm',
  ): Promise<number[]> {
    const firedAt: number[] = [];
    let arm = 1_790_900_000_000;
    for (const uptime of uptimesMin) {
      resetScheduledRegistry();
      const h = harness();
      let now = arm;
      h.setNow(now);
      managedSetInterval(name, intervalMs, () => {
        firedAt.push(now);
      }, { category: 'watchdog', phase });
      const death = arm + uptime * MIN;
      // Event loop for this lifetime: pending one-shots, then any live interval.
      const pending: { at: number; run: () => void }[] = h.timeouts.map((t) => ({ at: arm + t.ms, run: t.cb }));
      const intervalAnchor = new Map<number, number>([[0, arm]]);
      for (;;) {
        for (let i = 0; i < h.intervals.length; i += 1) {
          if (!intervalAnchor.has(i)) intervalAnchor.set(i, now);
        }
        const candidates = [
          ...pending.map((p, i) => ({ at: p.at, run: () => { pending.splice(i, 1); p.run(); } })),
          ...h.intervals
            .map((iv, i) => ({ iv, i }))
            .filter(({ iv }) => !iv.cleared)
            .map(({ iv, i }) => {
              const anchor = intervalAnchor.get(i)!;
              return { at: anchor + iv.ms, run: () => { intervalAnchor.set(i, anchor + iv.ms); iv.cb(); } };
            }),
        ].sort((a, b) => a.at - b.at);
        const next = candidates[0];
        if (!next || next.at >= death) break;
        now = next.at;
        h.setNow(now);
        next.run();
        await flush();
      }
      arm = death;
    }
    return firedAt;
  }

  it('alignedSlotDelayMs puts every arm time on the same slot for one name', () => {
    const offsets = new Set<number>();
    for (const t of [0, 1_234_567, 7_777_777_777, 1_790_914_874_000, 1_790_914_874_001]) {
      const d = alignedSlotDelayMs('wedged-identity-activation-watchdog', HOUR, t);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(HOUR);
      offsets.add((t + d) % HOUR);
    }
    expect(offsets.size).toBe(1);
    const distinct = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => alignedSlotDelayMs(n, HOUR, 0)));
    expect(distinct.size, 'different names must not herd onto one instant').toBeGreaterThan(1);
  });

  // The defect: measured bg-host uptimes on 2026-10-02 were all under an hour but one, so an
  // hourly arm-phase timer never fired. The control proves the simulation reproduces that.
  const MEASURED_UPTIMES_MIN = [44, 2, 22, 5, 30, 3, 25, 13, 12, 13, 8, 11, 10, 1, 15, 21, 32, 51];

  it('CONTROL: arm phase never fires an hourly timer when every uptime is under an hour', async () => {
    const fired = await simulateRestarts('hourly-sweep', HOUR, MEASURED_UPTIMES_MIN, 'arm');
    expect(fired).toEqual([]);
  });

  it('aligned phase fires an hourly timer on its slot despite restarts every few minutes', async () => {
    const total = MEASURED_UPTIMES_MIN.reduce((a, b) => a + b, 0); // ~5.3h of wall clock
    const fired = await simulateRestarts('hourly-sweep', HOUR, MEASURED_UPTIMES_MIN, 'aligned');
    // Every fire is ON the slot, and at most one slot per hour of wall clock is lost (to the
    // downtime-free model's warm-up window); the rest fire.
    const slotOffset = (0 + alignedSlotDelayMs('hourly-sweep', HOUR, 0)) % HOUR;
    for (const t of fired) expect(t % HOUR).toBe(slotOffset);
    expect(fired.length).toBeGreaterThanOrEqual(Math.floor(total / 60) - 1);
    expect(new Set(fired).size).toBe(fired.length);
  });

  it('re-phases onto the slot: arm interval cleared, a slot-anchored one armed, one fire', async () => {
    const h = harness();
    const { arm, slot } = armBeforeSlot('hourly', HOUR, 30 * MIN);
    h.setNow(arm);
    let calls = 0;
    const handle = managedSetInterval('hourly', HOUR, () => {
      calls += 1;
    }, { category: 'watchdog' });

    // The arm-phase interval is armed at once, exactly as before (the first fire is never later).
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0].ms).toBe(HOUR);
    expect(h.timeouts).toHaveLength(1);
    expect(h.timeouts[0].ms).toBe(30 * MIN);

    h.setNow(slot);
    h.timeouts[0].cb();
    await flush();
    expect(calls).toBe(1);
    expect(h.intervals[0].cleared).toBe(true);
    expect(h.intervals).toHaveLength(2);
    expect(h.intervals[1].ms).toBe(HOUR);
    expect(getManaged('hourly')).toMatchObject({ fires: 1, lastFireAt: slot });

    handle.stop();
    expect(h.intervals[1].cleared, 'stop() must clear the slot-anchored interval').toBe(true);
  });

  it('a stop() before the slot makes the pending re-phase a no-op', async () => {
    const h = harness();
    const { arm } = armBeforeSlot('hourly', HOUR, 30 * MIN);
    h.setNow(arm);
    let calls = 0;
    managedSetInterval('hourly', HOUR, () => {
      calls += 1;
    }, { category: 'watchdog' }).stop();
    h.timeouts[0].cb();
    await flush();
    expect(calls).toBe(0);
    expect(h.intervals).toHaveLength(1);
    expect(managedCount()).toBe(0);
  });

  it('skips a slot inside the warm-up window after arm, or right before the arm-phase fire', () => {
    const near = armBeforeSlot('hourly', HOUR, ALIGNED_PHASE_WARMUP_MS - 1);
    let h = harness();
    h.setNow(near.arm);
    managedSetInterval('hourly', HOUR, () => undefined, { category: 'watchdog' });
    expect(h.timeouts, 'a slot in the startup ramp is not taken').toHaveLength(0);

    resetScheduledRegistry();
    const late = armBeforeSlot('hourly', HOUR, HOUR - ALIGNED_PHASE_WARMUP_MS + 1);
    h = harness();
    h.setNow(late.arm);
    managedSetInterval('hourly', HOUR, () => undefined, { category: 'watchdog' });
    expect(h.timeouts, 'the arm-phase fire already covers a slot this late').toHaveLength(0);
  });

  it('stays arm-phase for short intervals, instanced timers and an explicit phase:"arm"', () => {
    const h = harness();
    const short = armBeforeSlot('short', ALIGNED_PHASE_MIN_INTERVAL_MS - 1, 5 * MIN);
    h.setNow(short.arm);
    managedSetInterval('short', ALIGNED_PHASE_MIN_INTERVAL_MS - 1, () => undefined, { category: 'watchdog' });
    managedSetInterval('per-socket', HOUR, () => undefined, { category: 'lifecycle', instanced: true });
    managedSetInterval('opted-out', HOUR, () => undefined, { category: 'watchdog', phase: 'arm' });
    expect(h.timeouts).toHaveLength(0);
    expect(h.intervals).toHaveLength(3);
  });

  it('keeps a consumer fake-timer test on the deterministic armedAt + n·interval schedule', async () => {
    resetScheduledRegistry();
    vi.useFakeTimers();
    try {
      let calls = 0;
      managedSetInterval('consumer-hourly', HOUR, () => {
        calls += 1;
      }, { category: 'watchdog' });
      await vi.advanceTimersByTimeAsync(HOUR - 1);
      expect(calls, 'no aligned fire leaks into a default-seam Vitest run').toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(1);
    } finally {
      resetScheduledRegistry();
      vi.useRealTimers();
    }
  });
});
