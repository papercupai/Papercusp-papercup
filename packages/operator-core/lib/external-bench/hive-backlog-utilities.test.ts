/**
 * Shared fleet-arm backlog utilities tests (benchmark-suite-metr-hcast-2026-06-17 extraction).
 * The concurrency sampler + the bounded pool are the work-surface-agnostic core every driver shares.
 */
import { describe, expect, it } from 'vitest';
import { concurrencyTimelineFromIntervals, makeConcurrencySampler, makePoolBacklogDriver, runConcurrencyPool } from './hive-backlog-utilities';
import type { CoordEvent } from '@papercusp/bench-metrics';
import type { FleetTaskResult, HiveBacklogRunRequest } from './hive-backlog';
import type { BenchTask } from './types';

describe('concurrencyTimelineFromIntervals', () => {
  it('weights irregular overlaps by elapsed time, independent of input order', () => {
    const intervals = [{ startedAtMs: 100, endedAtMs: 200 }, { startedAtMs: 100, endedAtMs: 110 }];
    const result = concurrencyTimelineFromIntervals(intervals)!;
    expect(result).toEqual({ startedAtMs: 100, endedAtMs: 200, wallClockMs: 100, participantWallClockMs: 110,
      concurrencyTimeline: { samples: [{ tMs: 0, live: 2 }, { tMs: 10, live: 1 }, { tMs: 100, live: 0 }],
        peakConcurrent: 2, avgConcurrent: 1.1 } });
    expect(concurrencyTimelineFromIntervals([...intervals].reverse())).toEqual(result);
  });
  it('includes idle gaps and does not invent overlap at a recovery boundary', () => {
    expect(concurrencyTimelineFromIntervals([{ startedAtMs: 0, endedAtMs: 10 },
      { startedAtMs: 10, endedAtMs: 20 }, { startedAtMs: 30, endedAtMs: 40 }])).toMatchObject({
      wallClockMs: 40, participantWallClockMs: 30,
      concurrencyTimeline: { avgConcurrent: 0.75, peakConcurrent: 1,
        samples: [{ tMs: 0, live: 1 }, { tMs: 10, live: 1 }, { tMs: 20, live: 0 }, { tMs: 30, live: 1 }, { tMs: 40, live: 0 }] } });
  });
  it('records observed zero-duration lifetimes without a fictitious peak', () => {
    expect(concurrencyTimelineFromIntervals([{ startedAtMs: 12, endedAtMs: 12 }])).toMatchObject({
      wallClockMs: 0, participantWallClockMs: 0, concurrencyTimeline: { avgConcurrent: 0, peakConcurrent: 0, samples: [{ tMs: 0, live: 0 }] } });
  });
  it.each([[], [{ startedAtMs: -1, endedAtMs: 2 }], [{ startedAtMs: 3, endedAtMs: 2 }],
    [{ startedAtMs: 1, endedAtMs: NaN }], [{ startedAtMs: 0.5, endedAtMs: 2 }],
    [{ startedAtMs: 0, endedAtMs: Number.MAX_SAFE_INTEGER }, { startedAtMs: 0, endedAtMs: 1 }]].map(intervals => ({ intervals })))
  ('returns unknown for invalid or absent intervals %j', ({ intervals }) => {
    expect(concurrencyTimelineFromIntervals(intervals)).toBeNull();
  });
});

describe('makeConcurrencySampler', () => {
  it('tracks live occupancy, inline peak, and projects the timeline', () => {
    let t = 0;
    const now = () => t;
    const s = makeConcurrencySampler(0, now);
    s.sample(); // t=0 live=0
    s.enter(); // live=1
    s.enter(); // live=2 (peak)
    t = 10;
    s.sample(); // t=10 live=2
    s.exit(); // live=1
    t = 20;
    s.sample(); // t=20 live=1
    expect(s.peak()).toBe(2);
    const tl = s.finalize(); // appends nothing more; finalize is pure
    expect(tl.peakConcurrent).toBe(2);
    expect(tl.samples).toEqual([
      { tMs: 0, live: 0 },
      { tMs: 10, live: 2 },
      { tMs: 20, live: 1 },
    ]);
    expect(tl.avgConcurrent).toBeCloseTo((0 + 2 + 1) / 3, 6);
  });

  it('exit floors at 0', () => {
    const s = makeConcurrencySampler(0, () => 0);
    s.exit();
    s.exit();
    s.enter();
    expect(s.peak()).toBe(1);
  });
});

describe('runConcurrencyPool', () => {
  it('runs every task exactly once and returns results', async () => {
    const seen: number[] = [];
    const { results, timedOut } = await runConcurrencyPool<number>({
      backlogLength: 5,
      cap: 2,
      now: () => 0,
      deadlineMs: Infinity,
      perTask: async (i) => {
        seen.push(i);
        return i * 10;
      },
    });
    expect(timedOut).toBe(false);
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(results.sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40]);
  });

  it('respects the concurrency cap (≤cap live at once)', async () => {
    let live = 0;
    let maxLive = 0;
    await runConcurrencyPool<void>({
      backlogLength: 6,
      cap: 2,
      now: () => 0,
      deadlineMs: Infinity,
      onEntered: () => { live += 1; maxLive = Math.max(maxLive, live); },
      onExited: () => { live -= 1; },
      perTask: async () => { await new Promise((r) => setTimeout(r, 3)); },
    });
    expect(maxLive).toBeLessThanOrEqual(2);
  });

  it('stops pulling once the deadline passes (timedOut)', async () => {
    let t = 0;
    const { results, timedOut } = await runConcurrencyPool<number>({
      backlogLength: 100,
      cap: 1,
      now: () => t,
      deadlineMs: 5,
      perTask: async (i) => {
        t += 3; // each task advances logical time
        return i;
      },
    });
    expect(timedOut).toBe(true);
    expect(results.length).toBeLessThan(100); // bailed out at the deadline
  });

  it('fires onResult per settled task', async () => {
    const banked: number[] = [];
    await runConcurrencyPool<number>({
      backlogLength: 3,
      cap: 3,
      now: () => 0,
      deadlineMs: Infinity,
      perTask: async (i) => i,
      onResult: (r) => { banked.push(r); },
    });
    expect(banked.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

describe('makePoolBacklogDriver — the generic non-diff pool driver shell (tau2 / metr-hcast reuse)', () => {
  const task = (id: string): BenchTask => ({ benchmark: 'x', instanceId: id, problemStatement: id, graderMeta: {} });
  const fleetResult = (id: string, seed: string): FleetTaskResult => ({
    attempt: { arm: 'a', blueprintId: 'b', instanceId: id, seed, diff: '', tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1, wallClockMs: 1, trajectoryRef: '', stopReason: 'done' },
    cupId: `bee-${id}`,
    placedAtMs: 0,
    startedAtMs: 0,
    finishedAtMs: 1,
    disposition: 'spawn',
  });
  const req = (backlog: BenchTask[]): HiveBacklogRunRequest => ({ arm: 'su-independent', suite: 'tau2', runId: 'r1', seed: 0, backlog, budget: {} });

  it('emits a canonical HiveBacklogResult from an injected per-task work fn', async () => {
    const driver = makePoolBacklogDriver({
      now: () => Date.now(),
      concurrencyCap: () => 2,
      sampleIntervalMs: 1,
      perTask: async ({ task, seed }) => fleetResult(task.instanceId, seed),
    });
    const res = await driver.run(req([task('t1'), task('t2'), task('t3')]));
    expect(res.arm).toBe('su-independent');
    expect(res.suite).toBe('tau2');
    expect(res.runError).toBeUndefined();
    expect(res.taskResults.map((t) => t.attempt.instanceId).sort()).toEqual(['t1', 't2', 't3']);
    expect(res.concurrencyTimeline).toBeDefined();
    expect(res.taskResults[0].attempt.seed).toBe('0'); // the run seed threaded to perTask
  });

  it('never throws — a perTask that returns its own error result is just collected', async () => {
    const driver = makePoolBacklogDriver({
      now: () => Date.now(),
      concurrencyCap: () => 1,
      sampleIntervalMs: 1,
      // perTask is never-throw by contract; here it returns an "error" FleetTaskResult for one task.
      perTask: async ({ task, seed }) => {
        const r = fleetResult(task.instanceId, seed);
        if (task.instanceId === 't2') r.attempt.stopReason = 'error';
        return r;
      },
    });
    const res = await driver.run(req([task('t1'), task('t2')]));
    expect(res.taskResults).toHaveLength(2);
    expect(res.taskResults.find((t) => t.attempt.instanceId === 't2')!.attempt.stopReason).toBe('error');
  });

  it('threads collectCoordEvents into the result (hive arms emit placements)', async () => {
    const events: CoordEvent[] = [{ kind: 'placement', tMs: 0 } as unknown as CoordEvent];
    const driver = makePoolBacklogDriver({
      now: () => Date.now(),
      concurrencyCap: () => 1,
      sampleIntervalMs: 1,
      perTask: async ({ task, seed }) => fleetResult(task.instanceId, seed),
      collectCoordEvents: () => events,
    });
    const res = await driver.run(req([task('t1')]));
    expect(res.coordEvents).toHaveLength(1);
  });
});
