/**
 * P-007 (R-7, green-gate-zero-wait-convergence-2026-09-08): the frozen repair queue keeps
 * four latency clocks — newest fixer dispatch, newest admission, verification start, newest verdict — and
 * `frozenRepairLatency` projects them into the red→fix→admit→verdict figures that
 * `gate_health.freezeAndConverge.repairLatency` publishes every tick.
 *
 * The figures are what an operator reads to tell "the mechanism is slow" from "nobody is
 * fixing": `redAwaitingFixerMs` / `admitAwaitingVerdictMs` are LIVE waits that clear the
 * moment the next hop lands, while the *ToMs figures are the settled durations of hops
 * that already happened. Each assertion below pins one of those semantics, plus the
 * persistence rule (a clock newer than the row clock is dropped on parse, exactly like
 * `fixerStateChangedAtMs`) and the two read paths that surface them (diagnostic + gate_health).
 */
import { describe, expect, it } from 'vitest';
import { ADMISSION_GIT_DATE } from './admission-commit-date';
import {
  createFrozenCandidateRepairQueue,
  diagnoseFrozenCandidateRepairQueue,
  frozenRepairLatency,
  markFrozenRepairAdmitted,
  markFrozenRepairFixerDispatched,
  markFrozenRepairVerificationStarted,
  markFrozenRepairVerificationGreen,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  buildFreezeAndConvergeGateHealth,
  deriveTickFreezeDisposition,
  readFreezeAndConverge,
} from './freeze-disposition';

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const BASE = '0000000000000000000000000000000000000000';
const T0 = 1_800_000_000_000;
const MIN = 60_000;

function fresh(): FrozenCandidateRepairQueue {
  return createFrozenCandidateRepairQueue({
    candidate: C,
    base: BASE,
    failingTests: ['lib/a.test.ts'],
    nowMs: T0,
  });
}

function admit(queue: FrozenCandidateRepairQueue, atMs: number): FrozenCandidateRepairQueue {
  return markFrozenRepairAdmitted(queue, {
    atMs,
    actor: 'su-fixer',
    source: { ref: 'staging', sha: C1 },
    fromRepairHead: C,
    toRepairHead: C1,
    paths: ['lib/a.test.ts'],
    unchanged: [],
    blobs: { 'lib/a.test.ts': 'blob-a' },
  });
}

describe('frozenRepairLatency — P-007 red→fix→admit→verdict clocks', () => {
  it('a fresh red is a live wait for a fixer and nothing else', () => {
    const latency = frozenRepairLatency(fresh(), T0 + 5 * MIN);
    expect(latency).toEqual({
      redToFixerSpawnMs: null,
      fixToAdmitMs: null,
      admitToResumeRunStartMs: null,
      admitToVerdictMs: null,
      redAwaitingFixerMs: 5 * MIN,
      admitAwaitingResumeRunStartMs: null,
      admitAwaitingVerdictMs: null,
      stamps: {
        openedAtMs: T0,
        lastRedAtMs: T0,
        fixerSpawnedAtMs: null,
        lastAdmittedAtMs: null,
        lastResumeRunStartedAtMs: null,
        // The opening red IS a verdict (the candidate's), so the clock starts stamped; it only
        // becomes an admit→verdict figure once a verdict lands AFTER an admission.
        lastVerdictAtMs: T0,
      },
    });
  });

  it('a fixer dispatch settles red→spawn and clears the live fixer wait', () => {
    const dispatched = markFrozenRepairFixerDispatched(fresh(), { spawnId: 'spawn-1', nowMs: T0 + 2 * MIN });
    expect(dispatched.fixerSpawnedAtMs).toBe(T0 + 2 * MIN);
    const latency = frozenRepairLatency(dispatched, T0 + 3 * MIN);
    expect(latency.redToFixerSpawnMs).toBe(2 * MIN);
    expect(latency.redAwaitingFixerMs).toBeNull();
    expect(latency.fixToAdmitMs).toBeNull();
    expect(latency.admitToResumeRunStartMs).toBeNull();
    expect(latency.admitToVerdictMs).toBeNull();
    expect(latency.admitAwaitingResumeRunStartMs).toBeNull();
    expect(latency.admitAwaitingVerdictMs).toBeNull();
  });

  it('an admission settles fix→admit and opens the live verdict wait', () => {
    const dispatched = markFrozenRepairFixerDispatched(fresh(), { spawnId: 'spawn-1', nowMs: T0 + 2 * MIN });
    const admitted = admit(dispatched, T0 + 9 * MIN);
    expect(admitted.lastAdmittedAtMs).toBe(T0 + 9 * MIN);
    const latency = frozenRepairLatency(admitted, T0 + 12 * MIN);
    expect(latency.redToFixerSpawnMs).toBe(2 * MIN);
    expect(latency.fixToAdmitMs).toBe(7 * MIN);
    expect(latency.admitToResumeRunStartMs).toBeNull();
    expect(latency.admitAwaitingResumeRunStartMs).toBe(3 * MIN);
    expect(latency.admitToVerdictMs).toBeNull();
    expect(latency.admitAwaitingVerdictMs).toBe(3 * MIN);
    expect(latency.redAwaitingFixerMs).toBeNull();
  });

  it('an auto-admission with no fixer since the red reports fixToAdmit 0 — the admission IS the fix', () => {
    const admitted = admit(fresh(), T0 + 4 * MIN);
    const latency = frozenRepairLatency(admitted, T0 + 4 * MIN);
    expect(latency.redToFixerSpawnMs).toBeNull();
    expect(latency.fixToAdmitMs).toBe(0);
    expect(latency.admitAwaitingResumeRunStartMs).toBe(0);
    expect(latency.admitAwaitingVerdictMs).toBe(0);
  });

  it('records the first resume-run start and clears the live start wait', () => {
    const admitted = admit(fresh(), T0 + 9 * MIN);
    const started = markFrozenRepairVerificationStarted(admitted, {
      repairHead: C1,
      nowMs: T0 + 12 * MIN,
    });
    const retry = markFrozenRepairVerificationStarted(started, {
      repairHead: C1,
      nowMs: T0 + 20 * MIN,
    });
    expect(retry).toBe(started);
    expect(frozenRepairLatency(started, T0 + 13 * MIN)).toMatchObject({
      admitToResumeRunStartMs: 3 * MIN,
      admitAwaitingResumeRunStartMs: null,
      admitAwaitingVerdictMs: 4 * MIN,
      stamps: { lastResumeRunStartedAtMs: T0 + 12 * MIN },
    });
  });

  it('leaves a newer repair head unchanged when a stale run tries to stamp its start', () => {
    const admitted = admit(fresh(), T0 + 9 * MIN);
    expect(markFrozenRepairVerificationStarted(admitted, { repairHead: C, nowMs: T0 + 12 * MIN })).toBe(admitted);
  });

  it('a green verdict settles admit→verdict and clears the live verdict wait', () => {
    const admitted = admit(markFrozenRepairFixerDispatched(fresh(), { spawnId: 'spawn-1', nowMs: T0 + 2 * MIN }), T0 + 9 * MIN);
    const started = markFrozenRepairVerificationStarted(admitted, { repairHead: C1, nowMs: T0 + 12 * MIN });
    const green = markFrozenRepairVerificationGreen(started, { repairHead: C1, nowMs: T0 + 40 * MIN });
    expect(green.lastVerdictAtMs).toBe(T0 + 40 * MIN);
    const latency = frozenRepairLatency(green, T0 + 41 * MIN);
    expect(latency.admitToVerdictMs).toBe(31 * MIN);
    expect(latency.admitToResumeRunStartMs).toBe(3 * MIN);
    expect(latency.admitAwaitingResumeRunStartMs).toBeNull();
    expect(latency.admitAwaitingVerdictMs).toBeNull();
    expect(latency.redAwaitingFixerMs).toBeNull();
    expect(latency.stamps).toEqual({
      openedAtMs: T0,
      lastRedAtMs: T0,
      fixerSpawnedAtMs: T0 + 2 * MIN,
      lastAdmittedAtMs: T0 + 9 * MIN,
      lastResumeRunStartedAtMs: T0 + 12 * MIN,
      lastVerdictAtMs: T0 + 40 * MIN,
    });
  });

  it('never reports a negative live wait when the clock reads earlier than the stamp', () => {
    const latency = frozenRepairLatency(fresh(), T0 - MIN);
    expect(latency.redAwaitingFixerMs).toBe(0);
  });
});

describe('latency clocks — persistence', () => {
  it('round-trips the four clocks through JSON and drops a clock newer than the row clock', () => {
    const admitted = admit(markFrozenRepairFixerDispatched(fresh(), { spawnId: 'spawn-1', nowMs: T0 + 2 * MIN }), T0 + 9 * MIN);
    const started = markFrozenRepairVerificationStarted(admitted, { repairHead: C1, nowMs: T0 + 12 * MIN });
    const green = markFrozenRepairVerificationGreen(started, { repairHead: C1, nowMs: T0 + 40 * MIN });
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(green)));
    expect(parsed).toMatchObject({
      fixerSpawnedAtMs: T0 + 2 * MIN,
      lastAdmittedAtMs: T0 + 9 * MIN,
      lastResumeRunStartedAtMs: T0 + 12 * MIN,
      lastVerdictAtMs: T0 + 40 * MIN,
    });
    // A stamp from the future relative to updatedAtMs is inadmissible — same rule as fixerStateChangedAtMs.
    const skewed = parseFrozenCandidateRepairQueue({
      ...JSON.parse(JSON.stringify(green)),
      lastResumeRunStartedAtMs: green.updatedAtMs + 1,
    });
    expect(skewed).not.toBeNull();
    expect(skewed?.lastResumeRunStartedAtMs).toBeUndefined();
    expect(skewed?.lastVerdictAtMs).toBe(T0 + 40 * MIN);
    expect(skewed?.lastAdmittedAtMs).toBe(T0 + 9 * MIN);
  });
});

describe('latency clocks — read paths', () => {
  it('the queue diagnostic carries the same projection the pure function computes', () => {
    const admitted = admit(markFrozenRepairFixerDispatched(fresh(), { spawnId: 'spawn-1', nowMs: T0 + 2 * MIN }), T0 + 9 * MIN);
    const nowMs = T0 + 12 * MIN;
    const diagnostic = diagnoseFrozenCandidateRepairQueue(admitted, { nowMs });
    expect(diagnostic?.repairLatency).toEqual(frozenRepairLatency(admitted, nowMs));
    expect(diagnostic?.repairLatency.admitAwaitingVerdictMs).toBe(3 * MIN);
  });

  it('gate_health.freezeAndConverge.repairLatency is written from the tick queue and reads back intact', () => {
    const admitted = admit(markFrozenRepairFixerDispatched(fresh(), { spawnId: 'spawn-1', nowMs: T0 + 2 * MIN }), T0 + 9 * MIN);
    const nowMs = T0 + 12 * MIN;
    const disposition = deriveTickFreezeDisposition({
      flagEnabled: true,
      repairQueue: admitted,
      summary: 'repair head awaiting verification',
      green: null,
      nowMs,
    });
    const expected = frozenRepairLatency(admitted, nowMs);
    expect(disposition.repairLatency).toEqual(expected);
    const health = buildFreezeAndConvergeGateHealth(disposition, nowMs);
    expect(health.freezeAndConverge.repairLatency).toEqual(expected);
    expect(readFreezeAndConverge(JSON.parse(JSON.stringify(health)))?.repairLatency).toEqual(expected);
  });

  it('a tick whose queue carries no clocks publishes repairLatency null, never a fabricated figure', () => {
    const disposition = deriveTickFreezeDisposition({
      flagEnabled: true,
      repairQueue: { candidate: C },
      summary: 'frozen repair fixer sp-1 dispatched for 11111111 (attempt 1); no suite run',
      green: null,
      nowMs: T0,
    });
    expect(disposition.repairLatency ?? null).toBeNull();
    const health = buildFreezeAndConvergeGateHealth(disposition, T0);
    expect(health.freezeAndConverge.repairLatency).toBeNull();
    expect(readFreezeAndConverge({ freezeAndConverge: { ...health.freezeAndConverge, repairLatency: { stamps: {} } } })?.repairLatency).toBeNull();
  });
});

// WI-10007622: the live papercusp queue published admitToVerdictMs = 844,636,939,525 ms (~26.8
// years) on 2026-10-06 21:22Z because lastAdmittedAtMs held the synthetic ADMISSION_GIT_DATE
// (2000-01-01) — a reconciled admission's atMs had been read from its deterministic commit date.
describe('latency clocks — a clock older than the queue itself is inadmissible', () => {
  const SYNTHETIC_MS = Date.parse(ADMISSION_GIT_DATE);

  it('replays the live 10-06 stamps: no decades-long span, and the poisoned clock is named', () => {
    const latency = frozenRepairLatency(
      {
        openedAtMs: 1_791_213_906_418,
        phase: 'ready-to-verify',
        convergenceRounds: [],
        lastAdmittedAtMs: SYNTHETIC_MS,
        lastResumeRunStartedAtMs: 1_791_314_664_063,
        lastVerdictAtMs: 1_791_321_739_525,
      },
      1_791_321_740_000,
    );
    expect(latency.admitToVerdictMs).toBeNull();
    expect(latency.admitToResumeRunStartMs).toBeNull();
    expect(latency.admitAwaitingVerdictMs).toBeNull();
    expect(latency.admitAwaitingResumeRunStartMs).toBeNull();
    expect(latency.fixToAdmitMs).toBeNull();
    expect(latency.stamps.lastAdmittedAtMs).toBeNull();
    expect(latency.inadmissibleStamps).toEqual(['lastAdmittedAtMs']);
    // The sound clocks are untouched.
    expect(latency.stamps.lastResumeRunStartedAtMs).toBe(1_791_314_664_063);
    expect(latency.stamps.lastVerdictAtMs).toBe(1_791_321_739_525);
  });

  it('every optional clock is held to the same floor; a clock AT openedAtMs is admissible', () => {
    const poisoned: FrozenCandidateRepairQueue = {
      ...fresh(),
      fixerSpawnedAtMs: SYNTHETIC_MS,
      lastAdmittedAtMs: T0 - 1,
      lastResumeRunStartedAtMs: T0,
      lastVerdictAtMs: SYNTHETIC_MS,
    };
    const latency = frozenRepairLatency(poisoned, T0 + MIN);
    expect(latency.inadmissibleStamps).toEqual(['fixerSpawnedAtMs', 'lastAdmittedAtMs', 'lastVerdictAtMs']);
    expect(latency.stamps.lastResumeRunStartedAtMs).toBe(T0);
    expect(latency.redToFixerSpawnMs).toBeNull();
    // A sound queue carries no marker at all.
    expect(frozenRepairLatency(fresh(), T0 + MIN)).not.toHaveProperty('inadmissibleStamps');
  });

  it('gate_health keeps the marker through the read-side guard and drops unknown keys', () => {
    const poisoned = { ...admit(fresh(), T0 + 9 * MIN), lastAdmittedAtMs: SYNTHETIC_MS };
    const nowMs = T0 + 12 * MIN;
    const disposition = deriveTickFreezeDisposition({
      flagEnabled: true,
      repairQueue: poisoned,
      summary: 'repair head awaiting verification',
      green: null,
      nowMs,
    });
    expect(disposition.repairLatency?.inadmissibleStamps).toEqual(['lastAdmittedAtMs']);
    const health = buildFreezeAndConvergeGateHealth(disposition, nowMs);
    const read = readFreezeAndConverge(JSON.parse(JSON.stringify(health)))?.repairLatency;
    expect(read?.inadmissibleStamps).toEqual(['lastAdmittedAtMs']);
    expect(read?.admitToVerdictMs).toBeNull();
    const tampered = readFreezeAndConverge({
      freezeAndConverge: {
        ...health.freezeAndConverge,
        repairLatency: { ...health.freezeAndConverge.repairLatency, inadmissibleStamps: ['bogus', 7] },
      },
    })?.repairLatency;
    expect(tampered).not.toHaveProperty('inadmissibleStamps');
  });
});
