import { describe, expect, it, vi } from 'vitest';

import {
  createFrozenCandidateQueue,
  markFrozenRepairAdmitted,
  type FrozenCandidateRepairQueue,
} from '../../release/frozen-candidate-repair-queue';
import {
  recordFrozenCandidateNoVerdictTick,
  type FrozenRepairQueueTransitionOutcome,
} from './release-actions';

/**
 * EI-27159974011446383 — the effectful half: every non-verdict tick routes its terminal through
 * `recordFrozenCandidateNoVerdict` on the FRESH row (via the CAS transition), and nothing else.
 */
const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const T0 = 1_800_000_000_000;
const target = { workspaceId: 'ws', installSlug: 'papercusp-pr-drill' };

const admitted = (): FrozenCandidateRepairQueue =>
  markFrozenRepairAdmitted(createFrozenCandidateQueue({ candidate: C, base: null, nowMs: T0 }), {
    atMs: T0 + 1_000,
    actor: 'su-leader',
    source: { ref: 'staging', sha: C1 },
    fromRepairHead: C,
    toRepairHead: C1,
    paths: ['packages/x/fix.ts'],
    unchanged: [],
    blobs: { 'packages/x/fix.ts': 'blob-fix' },
  });

/** A stand-in for applyFrozenCandidateRepairQueueTransition over one in-memory row. */
function memoryTransition(row: { current: FrozenCandidateRepairQueue }) {
  return vi.fn(async (_target: unknown, reduce: (fresh: FrozenCandidateRepairQueue) => FrozenCandidateRepairQueue | Promise<FrozenCandidateRepairQueue>) => {
    const fresh = row.current;
    const next = await reduce(fresh);
    if (next === fresh) return { status: 'unchanged', queue: fresh, fresh, retries: 0 } as FrozenRepairQueueTransitionOutcome;
    row.current = next;
    return { status: 'written', queue: next, fresh, retries: 0 } as FrozenRepairQueueTransitionOutcome;
  });
}

describe('EI-27159974011446383: recordFrozenCandidateNoVerdictTick', () => {
  it('two unjudged runs on the candidate move the persisted row to ready-to-verify', async () => {
    const row = { current: admitted() };
    const applyTransition = memoryTransition(row);
    const first = await recordFrozenCandidateNoVerdictTick(
      target,
      { status: 'error', candidate: C.slice(0, 12), runId: 'run-1', nowMs: T0 + 10_000 },
      { applyTransition },
    );
    expect(first?.status).toBe('written');
    expect(row.current.phase).toBe('ready-to-test');
    await recordFrozenCandidateNoVerdictTick(
      target,
      { status: 'deadline-exceeded', candidate: C, runId: 'run-2', nowMs: T0 + 20_000 },
      { applyTransition },
    );
    expect(row.current.phase).toBe('ready-to-verify');
    expect(row.current.repairHead).toBe(C1);
    expect(applyTransition).toHaveBeenCalledTimes(2);
    expect(applyTransition.mock.calls[0][0]).toBe(target);
  });

  it.each(['skipped-locked', 'cancelled', 'disk-headroom', 'migrations-pending'])(
    'never reads the queue for a %s tick',
    async (status) => {
      const applyTransition = memoryTransition({ current: admitted() });
      expect(await recordFrozenCandidateNoVerdictTick(target, { status, candidate: C, runId: 'r' }, { applyTransition })).toBeNull();
      expect(applyTransition).not.toHaveBeenCalled();
    },
  );

  it('never reads the queue when the terminal names no candidate', async () => {
    const applyTransition = memoryTransition({ current: admitted() });
    expect(await recordFrozenCandidateNoVerdictTick(target, { status: 'error', candidate: undefined }, { applyTransition })).toBeNull();
    expect(applyTransition).not.toHaveBeenCalled();
  });

  it('is fail-safe: a failed transition leaves the tick recorded and returns null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const applyTransition = vi.fn(async () => {
      throw new Error('cas exhausted');
    });
    expect(
      await recordFrozenCandidateNoVerdictTick(target, { status: 'error', candidate: C, runId: 'r' }, { applyTransition }),
    ).toBeNull();
    expect(warn.mock.calls.some(([line]) => String(line).includes('no-verdict record failed: cas exhausted'))).toBe(true);
    warn.mockRestore();
  });
});
