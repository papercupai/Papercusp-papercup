/**
 * The session retention prune's batch loop (WI-6554700010009718).
 *
 * The loop used to stop after a FIXED 40 batches of 5,000 rows. session_turn_parts
 * takes ~470k rows/day, so that ceiling deleted exactly 200k every day and the
 * 14-day window was never reached, while the workflow reported SUCCESS. These
 * tests pin the replacement contract: the loop stops only when a short batch
 * shows nothing is left, or when the wall-clock deadline passes, and in the
 * second case it says so (`exhausted`).
 */
import { describe, expect, it } from 'vitest';
import { drainInBatches } from './session-ingest';

/** A fake table: each call deletes up to `limit` of the rows that remain. */
function fakeTable(rows: number) {
  const state = { remaining: rows, calls: 0 };
  const deleteBatch = async (limit: number) => {
    state.calls += 1;
    const n = Math.min(limit, state.remaining);
    state.remaining -= n;
    return n;
  };
  return { state, deleteBatch };
}

describe('drainInBatches', () => {
  it('keeps going past 40 full batches until a short batch shows nothing is left', async () => {
    // 45 full batches of 3, then a short batch of 2: more than the old 40-batch ceiling.
    const { state, deleteBatch } = fakeTable(45 * 3 + 2);
    const report = await drainInBatches(deleteBatch, {
      batchRows: 3,
      deadline: Number.POSITIVE_INFINITY,
      now: () => 0,
    });
    expect(state.remaining).toBe(0);
    expect(report).toEqual({ deleted: 137, batches: 46, exhausted: false });
  });

  it('stops at the deadline and reports exhausted while rows remain', async () => {
    const { state, deleteBatch } = fakeTable(100);
    let clock = 0;
    const report = await drainInBatches(
      async (limit) => {
        clock += 10;
        return deleteBatch(limit);
      },
      { batchRows: 5, deadline: 30, now: () => clock },
    );
    expect(report).toEqual({ deleted: 15, batches: 3, exhausted: true });
    expect(state.remaining).toBe(85);
  });

  it('runs one batch and reports done when nothing is past the window', async () => {
    const { state, deleteBatch } = fakeTable(0);
    const report = await drainInBatches(deleteBatch, {
      batchRows: 5000,
      deadline: Number.POSITIVE_INFINITY,
      now: () => 0,
    });
    expect(report).toEqual({ deleted: 0, batches: 1, exhausted: false });
    expect(state.calls).toBe(1);
  });

  it('a deadline already past runs no batch at all and reports exhausted', async () => {
    const { state, deleteBatch } = fakeTable(10);
    const report = await drainInBatches(deleteBatch, { batchRows: 5, deadline: 0, now: () => 0 });
    expect(report).toEqual({ deleted: 0, batches: 0, exhausted: true });
    expect(state.calls).toBe(0);
  });
});
