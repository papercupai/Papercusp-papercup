import { describe, expect, it } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  recordFrozenRepairLegMeasurement,
  retireRepairSignatureOnLegPass,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

/**
 * WI-10007409 — the queue signature and `legs[]` must not give two answers to "what is still
 * failing" when the leg's own re-run at the current repairHead is new evidence of a fix.
 */

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const C2 = '3333333333333333333333333333333333333333';
const BASE = '0000000000000000000000000000000000000000';
const T0 = 1_800_000_000_000;
const LANE = '@papercusp/operator-core :: test:lane-stateful';
const DESKTOP = '@papercusp/desktop :: test';
const FILE = 'lib/a.test.ts';

/** A queue whose signature entries were all measured failing at `measuredAt`, now at `repairHead`. */
function queueAt(measuredAt: string, repairHead: string): FrozenCandidateRepairQueue {
  const created = createFrozenCandidateRepairQueue({
    candidate: C,
    base: BASE,
    failingTests: [LANE, DESKTOP, FILE],
    nowMs: T0,
  });
  return {
    ...created,
    repairHead,
    signature: (created.signature ?? []).map((entry) => ({ ...entry, measuredHead: measuredAt })),
  };
}

function ids(queue: FrozenCandidateRepairQueue): string[] {
  return (queue.signature ?? []).map((entry) => entry.id);
}

describe('repair tick retires a signature entry its own re-run fixed (WI-10007409)', () => {
  it('fixture names all three entries (guards against a vacuous signature)', () => {
    expect(ids(queueAt(C, C1))).toEqual([LANE, DESKTOP, FILE]);
  });

  it('retires a carried-forward entry measured at an older head once it passes at the repairHead', () => {
    const queue = queueAt(C, C1);
    const next = recordFrozenRepairLegMeasurement(queue, {
      measurements: [
        { id: LANE, status: 'pass' },
        { id: DESKTOP, status: 'fail' },
      ],
      head: C1,
      nowMs: T0 + 1_000,
    });
    expect(ids(next)).toEqual([DESKTOP, FILE]);
    // The flat projection stays the signature's projection — the two can never disagree.
    expect(next.failingTests).toEqual(ids(next));
    // And the leg ledger agrees: fixed at the head that retired it.
    const lane = next.legs?.find((leg) => leg.id === LANE);
    expect(lane?.state).toBe('fixed');
    expect(lane?.resolvedHead).toBe(C1);
  });

  it('does NOT retire on a same-head contradiction (failed and passed at one head = flake signal, P-009)', () => {
    const queue = queueAt(C1, C1);
    const next = recordFrozenRepairLegMeasurement(queue, {
      measurements: [{ id: LANE, status: 'pass' }],
      head: C1,
      nowMs: T0 + 1_000,
    });
    expect(ids(next)).toEqual([LANE, DESKTOP, FILE]);
    expect(next.failingTests).toEqual([LANE, DESKTOP, FILE]);
  });

  it('does NOT retire on a pass measured at a head other than the repairHead', () => {
    const queue = queueAt(C, C1);
    const next = recordFrozenRepairLegMeasurement(queue, {
      measurements: [{ id: LANE, status: 'pass' }],
      head: C2,
      nowMs: T0 + 1_000,
    });
    expect(ids(next)).toEqual([LANE, DESKTOP, FILE]);
  });

  it('a failing or errored report for the same id in the batch wins over its pass', () => {
    const signature = queueAt(C, C1).signature;
    for (const status of ['fail', 'errored'] as const) {
      expect(
        retireRepairSignatureOnLegPass(signature, {
          measurements: [
            { id: LANE, status: 'pass' },
            { id: LANE, status },
          ],
          head: C1,
          repairHead: C1,
        }),
      ).toBeNull();
    }
  });

  it('returns null (untouched row) when nothing retires, and never retires an unmeasured entry', () => {
    const signature = queueAt(C, C1).signature;
    expect(
      retireRepairSignatureOnLegPass(signature, { measurements: [], head: C1, repairHead: C1 }),
    ).toBeNull();
    const retained = retireRepairSignatureOnLegPass(signature, {
      measurements: [{ id: DESKTOP, status: 'pass' }],
      head: C1,
      repairHead: C1,
    });
    expect(retained?.map((entry) => entry.id)).toEqual([LANE, FILE]);
  });
});
