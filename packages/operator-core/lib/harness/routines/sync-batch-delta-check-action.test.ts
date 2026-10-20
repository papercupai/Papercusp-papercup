/**
 * green-main-ratchet-convergence-2026-10-17#D-034 (WI-6554700010018126): the routine-level
 * timeout of `system:sync-batch-delta-check` is DERIVED from the per-leg budgets. It used to
 * be a fixed 45 min that equalled probe + tsc + affected, so a red-confirm leg after a
 * full-budget run was cut off, and raising a leg budget silently shortened the margin.
 */
import { describe, expect, it } from 'vitest';
import { SYNC_DELTA_RUN_BUDGET_MS, SYNC_DELTA_TIMEOUTS_MS } from '../../release/sync-batch-delta-check';
import { getSystemActionEntry } from './system-actions';
import {
  SYNC_BATCH_DELTA_MAX_CONFIRM_LEGS,
  SYNC_BATCH_DELTA_ROUTINE_TIMEOUT_MS,
} from './sync-batch-delta-check-action';

const MIN = 60_000;

describe('sync-batch-delta-check routine timeout (D-034)', () => {
  it('covers one full in-budget run plus every confirm leg, with a margin', () => {
    expect(SYNC_BATCH_DELTA_ROUTINE_TIMEOUT_MS).toBe(
      SYNC_DELTA_RUN_BUDGET_MS + SYNC_BATCH_DELTA_MAX_CONFIRM_LEGS * SYNC_DELTA_TIMEOUTS_MS.confirm + 5 * MIN,
    );
    expect(SYNC_BATCH_DELTA_ROUTINE_TIMEOUT_MS).toBeGreaterThan(
      SYNC_DELTA_RUN_BUDGET_MS + SYNC_BATCH_DELTA_MAX_CONFIRM_LEGS * SYNC_DELTA_TIMEOUTS_MS.confirm,
    );
    // Today: (10 + 10 + 45) + 3 x 10 + 5 = 100 min. The literal is a tripwire for a leg change.
    expect(SYNC_BATCH_DELTA_ROUTINE_TIMEOUT_MS).toBe(100 * MIN);
  });

  it('is the timeout the registered system action actually carries', () => {
    expect(getSystemActionEntry('sync-batch-delta-check')?.routineTimeoutMs).toBe(SYNC_BATCH_DELTA_ROUTINE_TIMEOUT_MS);
  });
});
