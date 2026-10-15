import { describe, expect, it } from 'vitest';
import {
  IN_FLIGHT_WARN_MS,
  NOOP_TICK_LEGS,
  SLOW_TICK_MS,
  createTickLegTracker,
  formatLegs,
  watchTick,
} from './tick-legs';

/** A controllable clock + one-shot timer queue, so the test owns time exactly. */
function harness() {
  let now = 1_000_000;
  const timers: Array<{ at: number; cb: () => void; cleared: boolean }> = [];
  const logs: string[] = [];
  return {
    logs,
    timers,
    now: () => now,
    log: (m: string) => logs.push(m),
    setTimer: (cb: () => void, ms: number) => {
      const t = { at: now + ms, cb, cleared: false };
      timers.push(t);
      return { clear: () => { t.cleared = true; } };
    },
    /** Advance the clock, firing any due, uncleared timers in order (including re-armed ones). */
    advanceTo(at: number) {
      for (;;) {
        const due = timers
          .filter((t) => !t.cleared && t.at <= at)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.cleared = true;
        due.cb();
      }
      now = at;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createTickLegTracker', () => {
  it('reports unsettled legs longest-first and settled legs slowest-first', async () => {
    const h = harness();
    const legs = createTickLegTracker(h.now);
    const hung = deferred();
    const quick = deferred<number>();
    void legs.leg('hung', () => hung.promise);
    h.advanceTo(1_000_500);
    const q = legs.leg('quick', () => quick.promise);
    h.advanceTo(1_002_000);
    quick.resolve(7);
    expect(await q).toBe(7); // value passes through unchanged
    expect(legs.pending()).toEqual([{ label: 'hung', ms: 2_000 }]);
    expect(legs.slowest(5)).toEqual([{ label: 'quick', ms: 1_500 }]);
  });

  it('passes a rejection through unchanged and still records the leg as settled', async () => {
    const h = harness();
    const legs = createTickLegTracker(h.now);
    const boom = new Error('collector boom');
    await expect(legs.leg('bad', async () => { throw boom; })).rejects.toBe(boom);
    // A synchronous throw from `work` is also a rejection, not an escape.
    await expect(legs.leg('sync-bad', () => { throw boom; })).rejects.toBe(boom);
    expect(legs.pending()).toEqual([]);
    expect(legs.slowest(5).map((l) => l.label).sort()).toEqual(['bad', 'sync-bad']);
  });

  it('accepts a synchronous return value', async () => {
    const legs = createTickLegTracker();
    expect(await legs.leg('sync', () => 42)).toBe(42);
    expect(await NOOP_TICK_LEGS.leg('sync', () => 'x')).toBe('x');
  });

  it('formats an empty set explicitly rather than as a blank', () => {
    expect(formatLegs([])).toBe('(none)');
    expect(formatLegs([{ label: 'a', ms: 3 }])).toBe('a=3ms');
  });
});

describe('watchTick (EI-25221129396992808)', () => {
  it('names the unsettled leg while a tick is wedged, with doubling backoff, then the slow-tick summary', async () => {
    const h = harness();
    const hung = deferred();
    const tick = watchTick(
      'ws-1',
      async (legs) => {
        await Promise.all([
          legs.leg('fast-collector', async () => undefined),
          legs.leg('hung-collector', () => hung.promise),
        ]);
        return 'snapshot';
      },
      { now: h.now, log: h.log, setTimer: h.setTimer },
    );
    await flush();

    // 7 minutes in. The gap between warnings doubles (60s, 120s, 240s), so they land at 60s, 180s and 420s.
    h.advanceTo(1_000_000 + 7 * 60_000);
    const warns = h.logs.filter((m) => m.includes('still in flight'));
    expect(warns).toEqual([
      '[system-health] tick ws-1 still in flight after 60000ms; unsettled legs: hung-collector=60000ms',
      '[system-health] tick ws-1 still in flight after 180000ms; unsettled legs: hung-collector=180000ms',
      '[system-health] tick ws-1 still in flight after 420000ms; unsettled legs: hung-collector=420000ms',
    ]);
    // The fast leg is not blamed.
    expect(warns.join('\n')).not.toContain('fast-collector');

    hung.resolve();
    expect(await tick).toBe('snapshot'); // result unchanged
    const slow = h.logs.filter((m) => m.includes('slow tick'));
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatch(/^\[system-health\] slow tick ws-1 completed after 420000ms; slowest legs: hung-collector=420000ms, fast-collector=0ms$/);
    // The in-flight timer is cleared: nothing further fires after completion.
    const before = h.logs.length;
    h.advanceTo(1_000_000 + 60 * 60_000);
    expect(h.logs.length).toBe(before);
  });

  it('is silent for a normal fast tick', async () => {
    const h = harness();
    const result = await watchTick('ws-1', async (legs) => legs.leg('a', async () => 1), {
      now: h.now,
      log: h.log,
      setTimer: h.setTimer,
    });
    expect(result).toBe(1);
    expect(h.logs).toEqual([]);
    expect(h.timers.every((t) => t.cleared)).toBe(true);
  });

  it('reports a slow FAILED tick and re-throws its error unchanged', async () => {
    const h = harness();
    const gate = deferred();
    const boom = new Error('governor boom');
    const tick = watchTick(
      'ws-2',
      async (legs) => {
        await legs.leg('governor-snapshot', () => gate.promise);
        throw boom;
      },
      { now: h.now, log: h.log, setTimer: h.setTimer, inFlightWarnMs: 10 * 60_000 },
    );
    await flush();
    h.advanceTo(1_000_000 + SLOW_TICK_MS + 1);
    gate.resolve();
    await expect(tick).rejects.toBe(boom);
    expect(h.logs).toEqual([
      `[system-health] slow tick ws-2 failed after ${SLOW_TICK_MS + 1}ms; slowest legs: governor-snapshot=${SLOW_TICK_MS + 1}ms`,
    ]);
  });

  it('defaults are the documented thresholds', () => {
    expect(SLOW_TICK_MS).toBe(20_000);
    expect(IN_FLIGHT_WARN_MS).toBe(60_000);
  });

  // Observed 2026-10-06 20:52-20:56Z: a 276s tick logged "unsettled legs: (none)" at 60s and 180s
  // because it was blocked on an await that was not wrapped in a leg. The report must say where.
  it('locates a tick blocked on an UNWRAPPED await after a leg settled', async () => {
    const h = harness();
    const unwrapped = deferred();
    const tick = watchTick(
      'ws-3',
      async (legs) => {
        await legs.leg('pot-started', async () => undefined);
        await unwrapped.promise; // not a leg
        return 'snapshot';
      },
      { now: h.now, log: h.log, setTimer: h.setTimer },
    );
    await flush();
    h.advanceTo(1_000_000 + 60_000);
    expect(h.logs).toEqual([
      '[system-health] tick ws-3 still in flight after 60000ms; unsettled legs: ' +
        '(none; blocked outside any leg for 60000ms since pot-started settled)',
    ]);
    unwrapped.resolve();
    expect(await tick).toBe('snapshot');
  });

  it('says so when the tick is blocked before ANY leg has settled', async () => {
    const h = harness();
    const unwrapped = deferred();
    const tick = watchTick(
      'ws-4',
      async () => {
        await unwrapped.promise; // e.g. a slow import before the first leg
        return 'snapshot';
      },
      { now: h.now, log: h.log, setTimer: h.setTimer },
    );
    await flush();
    h.advanceTo(1_000_000 + 60_000);
    expect(h.logs).toEqual([
      '[system-health] tick ws-4 still in flight after 60000ms; unsettled legs: ' +
        '(none; no leg has settled yet, 60000ms into the tick)',
    ]);
    unwrapped.resolve();
    expect(await tick).toBe('snapshot');
  });
});

describe('createTickLegTracker idle() (EI-25221129396992808)', () => {
  it('is null while any leg runs, then names the last-settled leg and its age', async () => {
    const h = harness();
    const legs = createTickLegTracker(h.now);
    h.advanceTo(1_000_250);
    expect(legs.idle()).toEqual({ label: '', ms: 250 }); // nothing settled: age since creation
    const a = deferred();
    const b = deferred();
    const pa = legs.leg('a', () => a.promise);
    const pb = legs.leg('b', () => b.promise);
    expect(legs.idle()).toBeNull();
    h.advanceTo(1_001_000);
    a.resolve();
    await pa;
    expect(legs.idle()).toBeNull(); // b still running
    h.advanceTo(1_002_000);
    b.resolve();
    await pb;
    h.advanceTo(1_005_000);
    expect(legs.idle()).toEqual({ label: 'b', ms: 3_000 }); // the LAST to settle, not the first
    expect(NOOP_TICK_LEGS.idle()).toBeNull();
  });
});
