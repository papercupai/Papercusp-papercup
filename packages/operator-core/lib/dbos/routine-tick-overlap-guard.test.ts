/**
 * routine-tick-overlap-guard.test.ts — pins the EI-9935 routinesTick overlap
 * guard: don't let two invocations of the 30s-cadence scheduled tick run
 * concurrently (the confirmed root cause of the 2026-07-12 00:15-00:30 EDT
 * dead-routines flap — see routine-tick-overlap-guard.ts's header for the
 * live evidence).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  anotherRoutinesTickInFlight,
  createInProcessPassRegistry,
  exitInProcessPass,
  IN_PROCESS_PASS_STALE_MS,
  ROUTINE_TICK_OVERLAP_QUERY_DEADLINE_MS,
  ROUTINE_TICK_OVERLAP_STALE_MS,
  shouldShedForOverlap,
  tryEnterInProcessPass,
  type InFlightRow,
} from './routine-tick-overlap-guard';

describe('in-process pass guard (WI-6554700010019234)', () => {
  it('admits the first pass and refuses a second while the first is fresh', () => {
    const reg = createInProcessPassRegistry();
    expect(tryEnterInProcessPass(reg, 'a', 1_000)).toBe(true);
    expect(tryEnterInProcessPass(reg, 'b', 31_000)).toBe(false);
    // The refused pass registers nothing, so it cannot block anyone itself.
    expect([...reg.passes.keys()]).toEqual(['a']);
  });

  it('admits the next pass once the running pass exits', () => {
    const reg = createInProcessPassRegistry();
    expect(tryEnterInProcessPass(reg, 'a', 1_000)).toBe(true);
    exitInProcessPass(reg, 'a');
    expect(tryEnterInProcessPass(reg, 'b', 2_000)).toBe(true);
  });

  it('decides without any I/O, so a stalled event loop cannot make it fail open', () => {
    // Nine queued ticks released together after a stall (the 2026-10-21 14:51Z shape):
    // exactly one may run.
    const reg = createInProcessPassRegistry();
    const admitted = Array.from({ length: 9 }, (_, i) => tryEnterInProcessPass(reg, `t${i}`, 5_000));
    expect(admitted.filter(Boolean)).toHaveLength(1);
  });

  it('is stale-safe: a pass in flight for staleMs or longer no longer blocks', () => {
    const reg = createInProcessPassRegistry();
    expect(tryEnterInProcessPass(reg, 'wedged', 0, 1_000)).toBe(true);
    expect(tryEnterInProcessPass(reg, 'next', 999, 1_000)).toBe(false);
    expect(tryEnterInProcessPass(reg, 'next', 1_000, 1_000)).toBe(true);
    expect(reg.passes.has('wedged')).toBe(false);
    // The wedged pass finishing later removes only its own (already pruned) entry.
    exitInProcessPass(reg, 'wedged');
    expect(reg.passes.has('next')).toBe(true);
  });

  it('defaults its stale window to the in-process window, well past the DB guard window', () => {
    // A slow pass (measured >10 min under load) must not be treated as dead after the DB
    // guard's 5 minutes: that admitted a second concurrent pass live on 2026-10-21.
    expect(IN_PROCESS_PASS_STALE_MS).toBeGreaterThanOrEqual(6 * ROUTINE_TICK_OVERLAP_STALE_MS);
    const reg = createInProcessPassRegistry();
    expect(tryEnterInProcessPass(reg, 'a', 0)).toBe(true);
    expect(tryEnterInProcessPass(reg, 'b', ROUTINE_TICK_OVERLAP_STALE_MS)).toBe(false);
    expect(tryEnterInProcessPass(reg, 'b', IN_PROCESS_PASS_STALE_MS - 1)).toBe(false);
    expect(tryEnterInProcessPass(reg, 'b', IN_PROCESS_PASS_STALE_MS)).toBe(true);
  });

  it('reports each evicted pass and its age', () => {
    const reg = createInProcessPassRegistry();
    const evicted: Array<[string, number]> = [];
    expect(tryEnterInProcessPass(reg, 'hung', 0, 1_000)).toBe(true);
    expect(tryEnterInProcessPass(reg, 'next', 500, 1_000, (id, age) => evicted.push([id, age]))).toBe(false);
    expect(evicted).toEqual([]);
    expect(tryEnterInProcessPass(reg, 'next', 1_200, 1_000, (id, age) => evicted.push([id, age]))).toBe(true);
    expect(evicted).toEqual([['hung', 1_200]]);
  });

  it('lets the same pass id re-enter (a DBOS replay of the running workflow)', () => {
    const reg = createInProcessPassRegistry();
    expect(tryEnterInProcessPass(reg, 'a', 0)).toBe(true);
    expect(tryEnterInProcessPass(reg, 'a', 10)).toBe(true);
  });
});

describe('shouldShedForOverlap (pure)', () => {
  it('no other in-flight rows ⇒ do not shed', () => {
    expect(shouldShedForOverlap([])).toBe(false);
  });
  it('at least one other in-flight row ⇒ shed', () => {
    expect(shouldShedForOverlap([{ workflow_uuid: 'other-1' }])).toBe(true);
  });
});

describe('anotherRoutinesTickInFlight', () => {
  it('returns false when the query finds nothing (normal case, no overlap)', async () => {
    const queryInFlight = vi.fn(async () => [] as InFlightRow[]);
    const result = await anotherRoutinesTickInFlight('self-id', { queryInFlight, now: () => 1_000_000 });
    expect(result).toBe(false);
    expect(queryInFlight).toHaveBeenCalledWith('self-id', 1_000_000 - 5 * 60_000);
  });

  it('returns true when another PENDING tick is found within the stale window', async () => {
    const queryInFlight = vi.fn(async () => [{ workflow_uuid: 'other-tick' }]);
    const result = await anotherRoutinesTickInFlight('self-id', { queryInFlight, now: () => 1_000_000 });
    expect(result).toBe(true);
  });

  it('passes the caller-provided staleMs through as the cutoff', async () => {
    const queryInFlight = vi.fn(async () => []);
    await anotherRoutinesTickInFlight('self-id', { queryInFlight, now: () => 1_000_000 }, 30_000);
    expect(queryInFlight).toHaveBeenCalledWith('self-id', 1_000_000 - 30_000);
  });

  it('is FAIL-SOFT: a query error resolves to false, never wedging the scheduler', async () => {
    const queryInFlight = vi.fn(async () => {
      throw new Error('pg connection refused');
    });
    const result = await anotherRoutinesTickInFlight('self-id', { queryInFlight, now: () => 1_000_000 });
    expect(result).toBe(false);
  });

  it('is FAIL-SOFT when the overlap query does not settle before its caller deadline', async () => {
    vi.useFakeTimers();
    const queryInFlight = vi.fn(() => new Promise<InFlightRow[]>(() => {}));
    const result = anotherRoutinesTickInFlight('self-id', {
      queryInFlight,
      now: () => 1_000_000,
    });
    const assertion = expect(result).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(ROUTINE_TICK_OVERLAP_QUERY_DEADLINE_MS);
    await assertion;
  });

  it('defaults `now` to Date.now when not provided', async () => {
    const before = Date.now();
    const queryInFlight = vi.fn(async (_selfId: string, _cutoffEpochMs: number) => [] as InFlightRow[]);
    await anotherRoutinesTickInFlight('self-id', { queryInFlight });
    const after = Date.now();
    const cutoffArg = queryInFlight.mock.calls[0][1];
    // cutoff = now() - 5min, so it must fall within [before-5min, after-5min]
    expect(cutoffArg).toBeGreaterThanOrEqual(before - 5 * 60_000 - 1);
    expect(cutoffArg).toBeLessThanOrEqual(after - 5 * 60_000 + 1);
  });
});
