import { describe, expect, it } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  markFrozenRepairVerificationGreen,
  markFrozenRepairVerificationRed,
  parseFrozenCandidateRepairQueue,
  recordFrozenRepairLegMeasurement,
  recordFrozenRepairSupersededRed,
  summarizeFrozenRepairConvergence,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

const C = '1'.repeat(40);
const H = '2'.repeat(40);
const NEWER = '3'.repeat(40);
const T = 1_800_000_000_000;
const FILE = 'lib/failing.test.ts';
const LINT = 'lint:tsc';
const LANE = '@papercusp/operator-core :: test:lane-pure';

function verifying(): FrozenCandidateRepairQueue {
  const queue = createFrozenCandidateRepairQueue({
    candidate: C, base: null, failingTests: [FILE, LINT, LANE], nowMs: T,
  });
  const measured = recordFrozenRepairLegMeasurement(queue, {
    measurements: [{ id: LINT, status: 'fail' }, { id: LANE, status: 'fail' }],
    head: C, nowMs: T,
  });
  return { ...measured, repairHead: H, phase: 'ready-to-verify', attempts: 1, fixerSpawnId: 'history-fixer' };
}

describe('frozen repair verification history (WI-10007020)', () => {
  it('reports a plateau after earlier improvement as not converging without changing the failures', () => {
    const improved = markFrozenRepairVerificationRed(verifying(), {
      repairHead: H, nowMs: T + 1, failingTests: [FILE, LANE],
    });
    const plateau = markFrozenRepairVerificationRed({
      ...improved, repairHead: NEWER, phase: 'ready-to-verify',
    }, {
      repairHead: NEWER, nowMs: T + 2, failingTests: [FILE, LANE],
    });
    const summary = summarizeFrozenRepairConvergence(plateau, T + 3);
    expect(summary.shrinkPerRound.map((round) => round.failingCount)).toEqual([3, 2, 2]);
    expect(summary.shrinkPerRound.at(-1)?.delta).toBe(0);
    expect(plateau.failingTests).toEqual([FILE, LANE]);
    expect(summary.converging).toBe(false);
  });

  it('retains bounded failed identities for each red, including equal-size replacements', () => {
    const before = verifying();
    const next = markFrozenRepairVerificationRed(before, {
      repairHead: H, nowMs: T + 1, failingTests: ['lib/new.test.ts', LINT, LANE],
    });
    const rounds = next.convergenceRounds!;
    expect(rounds[0]).toMatchObject({ failingCount: 3, failingTests: [FILE, LINT, LANE] });
    expect(rounds[1]).toMatchObject({ failingCount: 3, failingTests: ['lib/new.test.ts', LINT, LANE] });
    const reread = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(next)))!;
    expect(reread.convergenceRounds).toEqual(rounds);
    expect(before.failingTests).toEqual([FILE, LINT, LANE]);
  });

  it('marks a remeasured passing leg fixed even when another check remains red', () => {
    const next = markFrozenRepairVerificationRed(verifying(), {
      repairHead: H, nowMs: T + 1, failingTests: [FILE, LANE],
    });
    expect(next.legs?.find((leg) => leg.id === LINT)).toMatchObject({
      state: 'fixed', resolvedHead: H, lastMeasuredRound: 2,
    });
    expect(next.legs?.find((leg) => leg.id === LANE)).toMatchObject({
      state: 'failing', lastMeasuredHead: H, lastMeasuredRound: 2, failingRounds: 2,
    });
  });

  it('leaves unmeasured legs unchanged during a suite-only red', () => {
    const before = verifying();
    const next = markFrozenRepairVerificationRed(before, {
      repairHead: H, nowMs: T + 1, failingTests: [FILE], measuredKinds: ['test-file'],
    });
    expect(next.legs).toEqual(before.legs);
    expect(next.failingTests).toEqual([FILE, LINT, LANE]);
  });

  it('records a full green on the leg lifecycle as well as clearing the signature', () => {
    const next = markFrozenRepairVerificationGreen(verifying(), { repairHead: H, nowMs: T + 1 });
    expect(next.failingTests).toEqual([]);
    expect(next.legs).toHaveLength(2);
    for (const leg of next.legs!) {
      expect(leg).toMatchObject({ state: 'fixed', resolvedHead: H, lastMeasuredHead: H });
    }
  });

  it('preserves the measurement of a previously fixed leg outside this verification', () => {
    const before = verifying();
    const fixed = recordFrozenRepairLegMeasurement(before, {
      measurements: [{ id: LINT, status: 'pass' }], head: H, nowMs: T + 1,
    });
    expect(fixed.signature.some((entry) => entry.id === LINT)).toBe(false);
    const next = markFrozenRepairVerificationRed(fixed, {
      repairHead: H, nowMs: T + 2, failingTests: [FILE, LANE],
    });
    expect(next.legs?.find((leg) => leg.id === LINT)).toEqual(fixed.legs?.find((leg) => leg.id === LINT));
  });

  it('retains superseded verification evidence at the measured head without moving the newer admission', () => {
    const before = { ...verifying(), repairHead: NEWER };
    const next = recordFrozenRepairSupersededRed(before, {
      measuredHead: H, nowMs: T + 1, failingTests: [FILE, LANE],
    });
    expect(next.repairHead).toBe(NEWER);
    expect(next.phase).toBe(before.phase);
    expect(next.convergenceRounds!.at(-1)).toMatchObject({ head: H, failingTests: [FILE, LANE] });
    expect(next.legs?.find((leg) => leg.id === LINT)).toMatchObject({ state: 'fixed', resolvedHead: H });
  });

  it('keeps legacy history unknown and rejects malformed identity lists without reviving them', () => {
    const queue = verifying();
    const legacy = { round: 1, head: C, failingCount: 3, atMs: T };
    const malformed = { round: 2, head: H, failingCount: 1, atMs: T + 1, failingTests: [7] };
    const parsed = parseFrozenCandidateRepairQueue({ ...queue, convergenceRounds: [legacy, malformed] })!;
    expect(parsed.convergenceRounds![0]).not.toHaveProperty('failingTests');
    expect(parsed.convergenceRounds![1]).not.toHaveProperty('failingTests');
    const many = createFrozenCandidateRepairQueue({
      candidate: C, base: null, nowMs: T,
      failingTests: Array.from({ length: 60 }, (_, i) => `lib/failure-${i}.test.ts`),
    });
    expect(many.convergenceRounds![0].failingCount).toBe(50);
    expect(many.convergenceRounds![0]).toHaveProperty('failingTests', many.failingTests);
  });
});
