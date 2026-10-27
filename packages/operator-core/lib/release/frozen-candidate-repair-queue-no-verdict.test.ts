import { describe, expect, it } from 'vitest';
import {
  FROZEN_CANDIDATE_NO_VERDICT_LIMIT,
  createFrozenCandidateQueue,
  decideFrozenCandidateRepairQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  parseFrozenCandidateRepairQueue,
  recordFrozenCandidateNoVerdict,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

/**
 * EI-27159974011446383 — a ready-to-test queue whose candidate cannot be judged must not pin
 * the queue forever. Measured 2026-10-27 on papercusp-pr-drill-20261014: candidate 2c26b2b9
 * hit the 3h absolute ceiling twice while an admission had already moved repairHead to
 * 6bf1c1a5; every tick still decided `test-candidate`, so the admitted fix was never judged.
 */
const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const BASE = '0000000000000000000000000000000000000000';
const T0 = 1_800_000_000_000;

const readyToTest = (): FrozenCandidateRepairQueue => createFrozenCandidateQueue({ candidate: C, base: BASE, nowMs: T0 });
const admission = (atMs: number) => ({
  atMs,
  actor: 'su-leader',
  source: { ref: 'staging', sha: C1 },
  fromRepairHead: C,
  toRepairHead: C1,
  paths: ['packages/x/fix.ts'],
  unchanged: [],
  blobs: { 'packages/x/fix.ts': 'blob-fix' },
});
const admitted = (): FrozenCandidateRepairQueue => markFrozenRepairAdmitted(readyToTest(), admission(T0 + 1_000));
const unjudged = (queue: FrozenCandidateRepairQueue, runId: string, atMs: number, status = 'error') =>
  recordFrozenCandidateNoVerdict(queue, { status, judgedSha: C, runId, nowMs: atMs });

describe('EI-27159974011446383: an unjudgeable candidate releases its admitted head to verification', () => {
  it('counts the first unjudged run and keeps testing the candidate', () => {
    const queue = admitted();
    const once = unjudged(queue, 'run-1', T0 + 10_000);
    expect(once).not.toBe(queue);
    expect(once.phase).toBe('ready-to-test');
    expect(once.candidateNoVerdict).toEqual({ runs: ['run-1'], lastStatus: 'error', lastAtMs: T0 + 10_000 });
    expect(once.updatedAtMs).toBeGreaterThan(queue.updatedAtMs);
    expect(decideFrozenCandidateRepairQueue(once, { nowMs: T0 + 10_001 }).kind).toBe('test-candidate');
  });

  it(`moves to ready-to-verify after ${FROZEN_CANDIDATE_NO_VERDICT_LIMIT} unjudged runs and never re-decides test-candidate`, () => {
    const queue = unjudged(unjudged(admitted(), 'run-1', T0 + 10_000), 'run-2', T0 + 20_000, 'deadline-exceeded');
    expect(queue.phase).toBe('ready-to-verify');
    expect(queue.candidate).toBe(C);
    expect(queue.repairHead).toBe(C1);
    // The candidate's measurement is ABSENT, not fabricated: no round and no signature, so the
    // verify run finds no failure signature and the full gate at the repair head decides.
    expect(queue.convergenceRounds ?? []).toEqual([]);
    expect(queue.signature).toEqual([]);
    expect(queue.lastVerdictAtMs).toBeUndefined();
    const decision = decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 20_001 });
    expect(decision.kind).toBe('verify-repair');
    expect(decision.kind === 'verify-repair' ? decision.candidate : null).toBe(C1);
    // Recurrence guard: once released, further no-verdict terminals cannot pull it back.
    expect(unjudged(queue, 'run-3', T0 + 30_000)).toBe(queue);
  });

  it('counts a run once even when its terminal is reported twice', () => {
    const once = unjudged(admitted(), 'run-1', T0 + 10_000);
    expect(unjudged(once, 'run-1', T0 + 11_000)).toBe(once);
  });

  it('without an admission it keeps counting but stays on the candidate', () => {
    let queue = readyToTest();
    for (let i = 1; i <= 4; i++) queue = unjudged(queue, `run-${i}`, T0 + i * 10_000);
    expect(queue.phase).toBe('ready-to-test');
    expect(queue.candidateNoVerdict?.runs).toEqual(['run-1', 'run-2', 'run-3', 'run-4']);
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 50_000 }).kind).toBe('test-candidate');
  });

  it('a later admission is released by the streak the candidate already earned', () => {
    let queue = readyToTest();
    queue = unjudged(queue, 'run-1', T0 + 10_000);
    queue = unjudged(queue, 'run-2', T0 + 20_000);
    queue = markFrozenRepairAdmitted(queue, admission(T0 + 25_000));
    expect(queue.phase).toBe('ready-to-test');
    expect(unjudged(queue, 'run-3', T0 + 30_000).phase).toBe('ready-to-verify');
  });

  it.each([
    ['a standing condition', { status: 'disk-headroom', judgedSha: C }],
    ['a peer cancel', { status: 'cancelled', judgedSha: C }],
    ['a real red', { status: 'not-green', judgedSha: C }],
    ['another sha', { status: 'error', judgedSha: C1 }],
    ['a too-short prefix', { status: 'error', judgedSha: C.slice(0, 6) }],
    ['no judged sha', { status: 'error', judgedSha: null }],
  ])('ignores %s (identity, nothing to write)', (_label, input) => {
    const queue = admitted();
    expect(recordFrozenCandidateNoVerdict(queue, { ...input, runId: 'run-x', nowMs: T0 + 10_000 })).toBe(queue);
  });

  it('matches the 12-char sha prefix the gate records', () => {
    const queue = recordFrozenCandidateNoVerdict(admitted(), {
      status: 'error',
      judgedSha: C.slice(0, 12).toUpperCase(),
      runId: 'run-1',
      nowMs: T0 + 10_000,
    });
    expect(queue.candidateNoVerdict?.runs).toEqual(['run-1']);
  });

  it('ignores any phase but ready-to-test', () => {
    const red = markFrozenCandidateVerificationRed(readyToTest(), { failingTests: ['lib/a.test.ts'], nowMs: T0 + 5_000 });
    expect(red.phase).toBe('awaiting-fixer');
    expect(unjudged(red, 'run-1', T0 + 10_000)).toBe(red);
  });

  it('a candidate red after one unjudged run still transitions normally', () => {
    const once = unjudged(admitted(), 'run-1', T0 + 10_000);
    const red = markFrozenCandidateVerificationRed(once, { failingTests: ['lib/a.test.ts'], nowMs: T0 + 20_000 });
    expect(red.phase).toBe('ready-to-verify');
    expect(red.convergenceRounds?.map((round) => round.head)).toEqual([C]);
  });

  it('persists through the parser, and the released row is a VALID verification row', () => {
    const released = unjudged(unjudged(admitted(), 'run-1', T0 + 10_000), 'run-2', T0 + 20_000);
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(released)));
    expect(parsed).not.toBeNull();
    expect(parsed?.phase).toBe('ready-to-verify');
    expect(parsed?.candidateNoVerdict).toEqual(released.candidateNoVerdict);
  });

  it('a malformed streak reads as absent, never as an unparseable queue', () => {
    const raw = JSON.parse(JSON.stringify(unjudged(admitted(), 'run-1', T0 + 10_000)));
    for (const bad of [{ runs: [], lastStatus: 'error', lastAtMs: T0 }, { runs: ['r'], lastStatus: 'red', lastAtMs: T0 }, 'x']) {
      const parsed = parseFrozenCandidateRepairQueue({ ...raw, candidateNoVerdict: bad });
      expect(parsed).not.toBeNull();
      expect(parsed?.candidateNoVerdict).toBeUndefined();
    }
  });

  it('rejects a nonsensical limit instead of releasing on the first run', () => {
    expect(() =>
      recordFrozenCandidateNoVerdict(admitted(), { status: 'error', judgedSha: C, runId: 'r', nowMs: T0 + 1, limit: 0 }),
    ).toThrow(/limit/);
  });
});
