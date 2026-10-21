import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
  FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
  FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
  FROZEN_REPAIR_CONVERGENCE_HOLD_MS,
  FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP,
  FROZEN_REPAIR_CONVERGENCE_ROUND_CAP,
  FROZEN_REPAIR_ROUND_GATE_ID_CAP,
  frozenRepairRoundExecution,
  createFrozenCandidateQueue,
  createFrozenCandidateRepairQueue,
  describeUnreadableFrozenCandidateRepairQueue,
  decideFrozenCandidateRepairQueue,
  decideFrozenRepairDispatchInfeasible,
  decideFrozenConvergenceCycleEntry,
  detectFrozenRepairSharedTreeCollision,
  diagnoseFrozenCandidateRepairQueue,
  frozenRepairHeadAwaitsVerification,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  settleFrozenRepairAdmission,
  markFrozenRepairAgeEscalated,
  markFrozenRepairExhausted,
  markFrozenRepairFixerDead,
  markFrozenRepairFixerDispatched,
  markFrozenRepairFixerFinished,
  markFrozenRepairVerificationGreen,
  markFrozenRepairVerificationRed,
  recordFrozenRepairLegMeasurement,
  recordFrozenRepairSupersededRed,
  settleFrozenRepairRetestRequest,
  parseFrozenCandidateRepairQueue,
  parseFrozenCandidateRepairQueueRead,
  summarizeFrozenRepairConvergence,
  buildFrozenRepairConvergenceGateHealth,
  parseFrozenRepairConvergence,
  projectFrozenRepairConvergenceCell,
  projectFrozenRepairConvergenceScope,
  frozenRepairAdmissionHandoffBlock,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const C2 = '3333333333333333333333333333333333333333';
const BASE = '0000000000000000000000000000000000000000';
const T0 = 1_800_000_000_000;

function fresh(): FrozenCandidateRepairQueue {
  return createFrozenCandidateRepairQueue({
    candidate: C,
    base: BASE,
    failingTests: ['lib/a.test.ts'],
    nowMs: T0,
  });
}

describe('frozen-candidate repair queue', () => {
  it('round-trips an observable admission pre-check and clears it when an admission publishes', () => {
    const pending: FrozenCandidateRepairQueue = {
      ...fresh(),
      admissionPrecheck: {
        schemaVersion: 1,
        operationId: 'repair-precheck-1',
        status: 'running',
        candidate: C,
        repairHead: C,
        builtCommit: C1,
        builtTree: C2,
        files: ['lib/a.test.ts'],
        actor: 'su-test',
        runnerPid: 123,
        runnerPidIdentity: 'boot-id:456',
        startedAtMs: T0 + 1,
        updatedAtMs: T0 + 1,
        expiresAtMs: T0 + 60_000,
        currentFile: 'lib/a.test.ts',
        completedCount: 0,
        totalCount: 1,
        heartbeatAtMs: T0 + 1,
      },
    };
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(pending)));
    expect(parsed?.admissionPrecheck).toEqual(pending.admissionPrecheck);
    expect(parseFrozenCandidateRepairQueue({
      ...pending,
      admissionPrecheck: { ...pending.admissionPrecheck, runnerPid: -1 },
    })?.admissionPrecheck).toBeUndefined();
    expect(parseFrozenCandidateRepairQueue({
      ...pending,
      admissionPrecheck: { ...pending.admissionPrecheck, runnerPid: undefined, runnerPidIdentity: 'boot-id:456' },
    })?.admissionPrecheck).toBeUndefined();
    expect(diagnoseFrozenCandidateRepairQueue(parsed!, { nowMs: T0 + 2 })?.admissionPrecheck).toEqual(
      pending.admissionPrecheck,
    );
    const pinned = {
      ...pending,
      admissionPrecheck: { ...pending.admissionPrecheck!, sourceCommit: C2 },
    };
    expect(
      parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(pinned)))?.admissionPrecheck,
    ).toMatchObject({ sourceCommit: C2 });
    // P-007 (green-main-cycle-time-2026-10-08#D-037): the radius partition survives the queue
    // round-trip; a malformed one rejects the record rather than silently re-admitting its files.
    const radius = {
      status: 'measured' as const,
      reason: 'ok',
      detail: '1 workspace(s)',
      guarded: ['lib/near.test.ts'],
      reportOnly: ['lib/red-leg.test.ts'],
      legs: { 'lib/near.test.ts': '@t/a', 'lib/red-leg.test.ts': '@t/b' },
    };
    const withRadius = {
      ...pending,
      admissionPrecheck: {
        ...pending.admissionPrecheck!,
        files: ['lib/a.test.ts', 'lib/near.test.ts', 'lib/red-leg.test.ts'],
        totalCount: 3,
        radius,
      },
    };
    expect(
      parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(withRadius)))?.admissionPrecheck?.radius,
    ).toEqual(radius);
    for (const bad of [
      { ...radius, status: 'maybe' },
      { ...radius, reason: '' },
      { ...radius, guarded: ['lib/not-in-files.test.ts'] },
      { ...radius, reportOnly: ['lib/near.test.ts'] },
      { ...radius, status: 'skipped' },
      { ...radius, legs: { 'lib/near.test.ts': '' } },
      { ...radius, legs: [] },
    ]) {
      expect(
        parseFrozenCandidateRepairQueue({ ...withRadius, admissionPrecheck: { ...withRadius.admissionPrecheck, radius: bad } })
          ?.admissionPrecheck,
        JSON.stringify(bad),
      ).toBeUndefined();
    }
    const admitted = markFrozenRepairAdmitted(parsed!, {
      atMs: T0 + 3,
      actor: 'su-test',
      source: { ref: C2, sha: C2 },
      fromRepairHead: C,
      toRepairHead: C2,
      paths: ['lib/a.test.ts'],
      unchanged: [],
      blobs: { 'lib/a.test.ts': C1 },
    });
    expect(admitted.admissionPrecheck).toBeUndefined();
  });

  it.each([
    ['currentFile outside the population', { currentFile: 'lib/missing.test.ts' }],
    ['completedCount is not an integer', { completedCount: 0.5 }],
    ['totalCount disagrees with files', { totalCount: 2 }],
    ['heartbeat is newer than the marker version', { heartbeatAtMs: T0 + 2 }],
    ['sourceCommit is malformed', { sourceCommit: 'not-a-sha' }],
  ])('drops malformed admission pre-check progress when %s', (_label, change) => {
    const raw = {
      ...fresh(),
      admissionPrecheck: {
        schemaVersion: 1,
        operationId: 'repair-precheck-malformed',
        status: 'running',
        candidate: C,
        repairHead: C,
        builtCommit: C1,
        builtTree: C2,
        files: ['lib/a.test.ts'],
        actor: 'su-test',
        startedAtMs: T0 + 1,
        updatedAtMs: T0 + 1,
        expiresAtMs: T0 + 60_000,
        currentFile: 'lib/a.test.ts',
        completedCount: 0,
        totalCount: 1,
        heartbeatAtMs: T0 + 1,
        ...change,
      },
    };
    const parsed = parseFrozenCandidateRepairQueue(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.admissionPrecheck).toBeUndefined();
  });

  it('round-trips committed patch provenance without relabeling it as hook attribution', () => {
    const patch = { commit: C1, parent: C, sha256: 'f'.repeat(64) };
    const admission = {
      atMs: T0 + 1, actor: 'su-test', source: { ref: C2, sha: C2 },
      fromRepairHead: C, toRepairHead: C2, paths: ['lib/a.test.ts'], unchanged: [],
      blobs: { 'lib/a.test.ts': C1 }, mode: 'committed-patch' as const, patch,
      reason: 'explicit reviewed missing-capture repair',
    };
    const queue = markFrozenRepairAdmitted(fresh(), admission);
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(queue)));
    expect(parsed?.admissions?.[0]).toMatchObject({ mode: 'committed-patch', patch });
    expect(parsed?.admissions?.[0]).not.toHaveProperty('hunks');
    const malformed = parseFrozenCandidateRepairQueue({ ...queue, admissions: [{ ...admission, patch: { ...patch, sha256: 'bad' } }] });
    expect(malformed?.admissions?.[0]).toMatchObject({ mode: 'committed-patch' });
    expect(malformed?.admissions?.[0]).not.toHaveProperty('patch');
  });

  it("carries a newer build's admission keys through parse and persist (WI-6554700010009930)", () => {
    const patch = { commit: C1, parent: C, sha256: 'f'.repeat(64) };
    const admission = {
      atMs: T0 + 1, actor: 'su-test', source: { ref: C2, sha: C2 },
      fromRepairHead: C, toRepairHead: C2, paths: ['lib/a.test.ts'], unchanged: [],
      blobs: { 'lib/a.test.ts': C1 }, mode: 'committed-patch' as const, patch,
      reason: 'explicit reviewed missing-capture repair',
    };
    const raw = JSON.parse(JSON.stringify(markFrozenRepairAdmitted(fresh(), admission)));
    raw.admissions[0].futureAudit = { reviewer: 'su-next' };
    const parsed = parseFrozenCandidateRepairQueue(raw);
    expect(parsed?.admissions?.[0]).toMatchObject({ futureAudit: { reviewer: 'su-next' }, mode: 'committed-patch', patch });
    const reread = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(parsed)));
    expect(reread?.admissions?.[0]).toHaveProperty('futureAudit', { reviewer: 'su-next' });
    // A key the parser read and rejected stays dropped (the malformed-patch case above).
    raw.admissions[0].patch = { ...patch, sha256: 'bad' };
    expect(parseFrozenCandidateRepairQueue(raw)?.admissions?.[0]).not.toHaveProperty('patch');
  });

  it('round-trips exact consumed hunk identities without consuming a later row', () => {
    const admission = {
      atMs: T0 + 100, actor: 'su-test', source: { ref: C2, sha: C2 },
      fromRepairHead: C, toRepairHead: C2, paths: ['lib/a.test.ts'], unchanged: [],
      blobs: { 'lib/a.test.ts': C1 }, mode: 'hunk-exact' as const,
      hunks: { 'lib/a.test.ts': { applied: 1, agents: ['su-test'] } }, ledgerRowIds: [11],
    };
    const queue = markFrozenRepairAdmitted(fresh(), admission);
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(queue)));
    expect(parsed?.admissions?.[0]?.ledgerRowIds).toEqual([11]);
    expect(parsed?.admissions?.[0]?.ledgerRowIds).not.toContain(12);
    const legacy = parseFrozenCandidateRepairQueue({ ...queue, admissions: [{ ...admission, ledgerRowIds: undefined }] });
    expect(legacy?.admissions?.[0]).not.toHaveProperty('ledgerRowIds');
  });

  it('persists the first red as an unassigned serialized queue without moving C', () => {
    const queue = fresh();
    expect(queue).toMatchObject({
      schemaVersion: 4,
      phase: 'awaiting-fixer',
      candidate: C,
      base: BASE,
      repairHead: C,
      affectedTestProofGroup: null,
      attempts: 0,
      fixerSpawnId: null,
      failingTests: ['lib/a.test.ts'],
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 })).toEqual({
      kind: 'dispatch-fixer',
      reason: 'unassigned',
      nextAttempt: 1,
      repairHead: C,
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('D-005: HOLDS a measured dispatch-infeasible zero-attempt queue — C stays frozen, nothing falls through to tip', () => {
    const decision = decideFrozenCandidateRepairQueue(fresh(), {
      nowMs: T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS + 1,
      dispatchFeasible: false,
    });
    expect(decision).toEqual({
      kind: 'hold-dispatch-infeasible',
      reason: 'dispatch-infeasible',
      candidate: C,
      repairHead: C,
      attempts: 0,
      ageMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS + 1,
      zeroAttemptStalled: true,
      zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      gateDisposition: 'blocked',
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('keeps dispatch-infeasible policy fail-closed for spent attempts and unknown capacity', () => {
    const spent = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    expect(
      decideFrozenCandidateRepairQueue(spent, {
        nowMs: T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS + 1,
        dispatchFeasible: false,
      }),
    ).toMatchObject({ kind: 'wait-for-fixer', fixerSpawnId: 'spawn-1' });
    expect(
      decideFrozenCandidateRepairQueue(fresh(), {
        nowMs: T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS + 1,
      }),
    ).toMatchObject({ kind: 'dispatch-fixer', reason: 'unassigned' });
  });

  it('exposes the zero-attempt stall alarm independently of the dispatch decision', () => {
    expect(
      diagnoseFrozenCandidateRepairQueue(fresh(), {
        nowMs: T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS + 1,
      }),
    ).toMatchObject({
      zeroAttemptStalled: true,
      zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
    });
    expect(
      diagnoseFrozenCandidateRepairQueue(fresh(), {
        nowMs: T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS - 1,
      }),
    ).toMatchObject({ zeroAttemptStalled: false });
  });

  it('P-011 projects the complete bounded lineage ledger and blocked reason through the canonical diagnostic', () => {
    const admission = {
      atMs: T0 + 1,
      actor: 'su-fixer',
      source: { ref: 'staging', sha: C1 },
      fromRepairHead: C,
      toRepairHead: C1,
      paths: ['lib/a.test.ts'],
      unchanged: [],
      blobs: { 'lib/a.test.ts': 'blob-a' },
      reason: 'admit the exact failing path',
    };
    const blocked: FrozenCandidateRepairQueue = {
      ...fresh(),
      phase: 'blocked',
      repairHead: C1,
      attempts: DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAttempts,
      blockedReason: 'attempts-exhausted',
      admissions: [admission],
    };

    const diagnostic = diagnoseFrozenCandidateRepairQueue(blocked, { nowMs: T0 + 2 });

    expect(diagnostic).toMatchObject({
      frozenCandidate: C,
      repairHead: C1,
      phase: 'blocked',
      openedAtMs: T0,
      blockedReason: 'attempts-exhausted',
      admissions: [admission],
      signature: blocked.signature,
      legs: [],
    });
  });

  it('keeps the dispatch-infeasible decision helper pure and explicit', () => {
    expect(
      decideFrozenRepairDispatchInfeasible(fresh(), {
        nowMs: T0 + 1,
        zeroAttemptStallMs: 1,
      }),
    ).toMatchObject({
      kind: 'hold-dispatch-infeasible',
      reason: 'dispatch-infeasible',
      candidate: C,
      attempts: 0,
    });
  });

  describe('WI-2141736: a wall that OUTLASTS the stall window holds the freeze instead of retiring', () => {
    // THE REGRESSION, measured 2026-09-02: the fixer's provider was usage-walled for SIX
    // DAYS. Every queue stalled out after the 15-minute zero-attempt window, retired, and
    // re-cut at tip — 20 retirements and 0 resumes in one day, with freeze-and-converge
    // silently off fleet-wide. Retiring bought nothing (the next queue met the same wall
    // 15 minutes later) and cost the entire convergence property.
    const SIX_DAYS = 6 * 24 * 60 * 60 * 1_000;

    it('HOLDS past the stall window when the wall reset is further away than that window', () => {
      expect(
        decideFrozenRepairDispatchInfeasible(fresh(), {
          nowMs: T0 + 1,
          zeroAttemptStallMs: 1,
          capacityRetryAtMs: T0 + SIX_DAYS,
        }),
      ).toMatchObject({
        kind: 'wait-for-dispatch-capacity',
        // Distinguishes the long-wall hold from the momentary-churn hold: the window HAS
        // elapsed, and the freeze is being held anyway — deliberately, not prematurely.
        zeroAttemptStalled: true,
        capacityRetryAtMs: T0 + SIX_DAYS,
      });
    });

    it('D-005: once the convergence hold itself is exhausted it BLOCKS (hold-dispatch-infeasible) — the inconclusive wait ends, the freeze does not', () => {
      expect(
        decideFrozenRepairDispatchInfeasible(fresh(), {
          nowMs: T0 + SIX_DAYS,
          zeroAttemptStallMs: 1,
          capacityRetryAtMs: T0 + SIX_DAYS * 2,
          convergenceHoldMs: 60_000,
        }),
      ).toMatchObject({
        kind: 'hold-dispatch-infeasible',
        reason: 'dispatch-infeasible',
        candidate: C,
        gateDisposition: 'blocked',
      });
    });

    it('D-005: a SHORT wall past the stall window BLOCKS too — waiting would buy nothing, but re-cutting is never the answer', () => {
      expect(
        decideFrozenRepairDispatchInfeasible(fresh(), {
          nowMs: T0 + 10_000,
          zeroAttemptStallMs: 5_000,
          // Wall lifts in 1s, well inside the stall window: this is ordinary pool churn.
          capacityRetryAtMs: T0 + 11_000,
        }),
      ).toMatchObject({ kind: 'hold-dispatch-infeasible', candidate: C });
    });

    it('D-005: an UNKNOWN wall reset past the stall window BLOCKS — an unknown neither extends the inconclusive wait nor re-cuts', () => {
      expect(
        decideFrozenRepairDispatchInfeasible(fresh(), {
          nowMs: T0 + 10_000,
          zeroAttemptStallMs: 5_000,
          capacityRetryAtMs: null,
        }),
      ).toMatchObject({ kind: 'hold-dispatch-infeasible', candidate: C });
    });

    it('WI-2141736 D-002: the convergence hold is materially LONGER than the stall window it gates', () => {
      // The failure direction that passes every other test in this file. The long-wall hold
      // only ever fires in the window between zeroAttemptStallMs and convergenceHoldMs, so a
      // convergence bound shorter than (or comparable to) the stall window makes that branch
      // UNREACHABLE in production while every fixture-driven test above still goes green —
      // dead code that looks alive. D-002 makes the ordering binding; this asserts it.
      expect(FROZEN_REPAIR_CONVERGENCE_HOLD_MS).toBeGreaterThan(
        FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      );
      // Not merely greater — materially so, or the reachable window is a rounding error.
      expect(FROZEN_REPAIR_CONVERGENCE_HOLD_MS).toBeGreaterThanOrEqual(
        FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS * 4,
      );
    });

    it('WI-2141736 D-001: the SAME predicate DISCRIMINATES a transient wall from a genuine dead end', () => {
      // The vetting finding that the hold and the bound, graded apart, do not compose: an
      // implementation can hold everything and separately retire dead ends while the combined
      // predicate is wrong. This feeds both cases through ONE call site with everything else
      // held identical — same queue, same age, same stall window — so the ONLY difference is
      // whether a measured wall outlasts the stall window. The verdicts MUST differ.
      const stalledQueue = fresh();
      const at = T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS;
      const transientWall = decideFrozenRepairDispatchInfeasible(stalledQueue, {
        nowMs: at,
        zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
        capacityRetryAtMs: at + SIX_DAYS,
      });
      const genuineDeadEnd = decideFrozenRepairDispatchInfeasible(stalledQueue, {
        nowMs: at,
        zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
        capacityRetryAtMs: null,
      });
      expect(transientWall.kind).toBe('wait-for-dispatch-capacity');
      expect(genuineDeadEnd.kind).toBe('hold-dispatch-infeasible');
      // The discrimination itself is the property under test — a predicate that returned the
      // same verdict for both would satisfy the hold test and the retire test separately.
      expect(transientWall.kind).not.toBe(genuineDeadEnd.kind);
    });

    it('still prefers testing a CONVERGED repairHead over holding — convergence beats waiting', () => {
      expect(
        decideFrozenRepairDispatchInfeasible(
          { ...fresh(), repairHead: C1 },
          { nowMs: T0 + 1, zeroAttemptStallMs: 1, capacityRetryAtMs: T0 + SIX_DAYS },
        ),
      ).toMatchObject({ kind: 'test-candidate', candidate: C1 });
    });
  });

  it('WI-2141347: tests a CONVERGED repairHead instead of retiring, when dispatch is infeasible', () => {
    // repairHead diverged from candidate via an admission (P-001 admitPathsOntoRepairHead) — still an
    // ancestor of staging, already vetted, never unpushed fixer content — while candidate itself
    // stays frozen and the queue is still unassigned/awaiting-fixer (a walled provider).
    const converged: FrozenCandidateRepairQueue = { ...fresh(), repairHead: C1 };
    expect(
      decideFrozenRepairDispatchInfeasible(converged, {
        nowMs: T0 + 1,
        zeroAttemptStallMs: 1,
      }),
    ).toEqual({
      kind: 'test-candidate',
      candidate: C1,
      gateDisposition: 'initial-candidate',
      runSuite: true,
      recordVerdict: true,
    });
  });

  it('WI-2141347 / D-005: BLOCKS when the repairHead never moved (nothing new to test) — never a re-cut', () => {
    // Falsifiability control for the fix above: an UNconverged queue (repairHead === candidate,
    // the fresh() default) has nothing new to test, so it holds for admission.
    expect(
      decideFrozenRepairDispatchInfeasible(fresh(), {
        nowMs: T0 + 1,
        zeroAttemptStallMs: 1,
      }),
    ).toMatchObject({ kind: 'hold-dispatch-infeasible', candidate: C, repairHead: C });
  });

  it('WI-2141736 Layer 2: holds a fresh zero-attempt queue instead of retiring on the FIRST measured capacity wall', () => {
    // The pre-Layer-2 defect: an unconverged queue that has been open only 1ms was retired
    // immediately on any single dispatch-infeasible reading, discarding the frozen candidate
    // for a reason unrelated to the code under test. It must now wait until the wall has
    // genuinely persisted past zeroAttemptStallMs before giving up.
    expect(
      decideFrozenRepairDispatchInfeasible(fresh(), {
        nowMs: T0 + 1,
        zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      }),
    ).toEqual({
      kind: 'wait-for-dispatch-capacity',
      repairHead: C,
      attempts: 0,
      ageMs: 1,
      zeroAttemptStalled: false,
      zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('WI-2141736 Layer 2 / D-005: BLOCKS once the zero-attempt wall has genuinely stalled', () => {
    // Falsifiability control for the wait above: crossing the SAME threshold with the SAME
    // (unconverged) queue must leave the inconclusive wait — into a HOLD, never a re-cut.
    expect(
      decideFrozenRepairDispatchInfeasible(fresh(), {
        nowMs: T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
        zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      }),
    ).toEqual({
      kind: 'hold-dispatch-infeasible',
      reason: 'dispatch-infeasible',
      candidate: C,
      repairHead: C,
      attempts: 0,
      ageMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      zeroAttemptStalled: true,
      zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      gateDisposition: 'blocked',
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('WI-2141736 Layer 2: a CONVERGED repairHead still tests immediately, unaffected by the wait gate', () => {
    // The wait gate only applies to the "nothing to test yet" (repairHead === candidate) path;
    // WI-2141347's converged-repairHead behavior must be untouched regardless of age.
    const converged: FrozenCandidateRepairQueue = { ...fresh(), repairHead: C1 };
    expect(
      decideFrozenRepairDispatchInfeasible(converged, {
        nowMs: T0 + 1,
        zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      }),
    ).toEqual({
      kind: 'test-candidate',
      candidate: C1,
      gateDisposition: 'initial-candidate',
      runSuite: true,
      recordVerdict: true,
    });
  });

  it('WI-2141736 Layer 2: decideFrozenCandidateRepairQueue holds the candidate end-to-end when not yet stalled', () => {
    // Same scenario as 'falls through a measured dispatch-infeasible zero-attempt queue instead
    // of freezing C' above, but measured immediately (ageMs=0) instead of past the stall
    // threshold — the exact WI-2141736 filing scenario: a single early capacity-wall reading
    // must not discard the frozen candidate.
    expect(
      decideFrozenCandidateRepairQueue(fresh(), {
        nowMs: T0,
        dispatchFeasible: false,
      }),
    ).toEqual({
      kind: 'wait-for-dispatch-capacity',
      repairHead: C,
      attempts: 0,
      ageMs: 0,
      zeroAttemptStalled: false,
      zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('persists C before its first suite, resumes that exact SHA, and transitions red in place', () => {
    const queue = createFrozenCandidateQueue({
      candidate: C,
      qualificationAttemptId: 'qualification-attempt-1',
      base: BASE,
      affectedTestProofGroup: 'initial-gate-run',
      nowMs: T0,
    });

    expect(queue).toMatchObject({
      schemaVersion: 4,
      phase: 'ready-to-test',
      candidate: C,
      qualificationAttemptId: 'qualification-attempt-1',
      repairHead: C,
      attempts: 0,
      fixerSpawnId: null,
      failingTests: [],
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 1 })).toEqual({
      kind: 'test-candidate',
      candidate: C,
      gateDisposition: 'initial-candidate',
      runSuite: true,
      recordVerdict: true,
    });

    const red = markFrozenCandidateVerificationRed(queue, {
      failingTests: ['lib/a.test.ts'],
      nowMs: T0 + 2,
    });
    expect(red).toMatchObject({
      phase: 'awaiting-fixer',
      candidate: C,
      repairHead: C,
      attempts: 0,
      failingTests: ['lib/a.test.ts'],
    });
    expect(decideFrozenCandidateRepairQueue(red, { nowMs: T0 + 3 })).toMatchObject({
      kind: 'dispatch-fixer',
      repairHead: C,
      nextAttempt: 1,
    });
  });

  it('P-003 keeps the fixer-state clock stable across queue bookkeeping, and advances it on dispatch', () => {
    const initial = fresh();
    expect(initial.fixerStateChangedAtMs).toBe(T0);

    const ageEscalated = markFrozenRepairAgeEscalated(initial, {
      rung: 1,
      nowMs: T0 + 8 * 60 * 60 * 1_000,
    });
    expect(ageEscalated.updatedAtMs).toBe(T0 + 8 * 60 * 60 * 1_000);
    expect(ageEscalated.fixerStateChangedAtMs).toBe(T0);

    const withLeg = recordFrozenRepairLegMeasurement(ageEscalated, {
      head: C,
      measurements: [{ id: 'lint:tsc', status: 'fail' }],
      nowMs: T0 + 9 * 60 * 60 * 1_000,
    });
    expect(withLeg.updatedAtMs).toBe(T0 + 9 * 60 * 60 * 1_000);
    expect(withLeg.fixerStateChangedAtMs).toBe(T0);
    expect(withLeg.legs).toHaveLength(1);

    const admitted = markFrozenRepairAdmitted(withLeg, {
      atMs: T0 + 10 * 60 * 60 * 1_000,
      actor: 'su-fixer',
      source: { ref: 'staging', sha: C1 },
      fromRepairHead: C,
      toRepairHead: C1,
      paths: ['lib/a.test.ts'],
      unchanged: [],
      blobs: { 'lib/a.test.ts': 'blob-a' },
    });
    expect(admitted.updatedAtMs).toBe(T0 + 10 * 60 * 60 * 1_000);
    expect(admitted.fixerStateChangedAtMs).toBe(T0);
    expect(admitted.retestRequested).toEqual({
      candidate: C,
      repairHead: C1,
      requestedAtMs: T0 + 10 * 60 * 60 * 1_000,
    });

    const dispatched = markFrozenRepairFixerDispatched(withLeg, {
      spawnId: 'fixer-1',
      nowMs: T0 + 11 * 60 * 60 * 1_000,
    });
    // Dispatch is the real succession transition; bookkeeping before it must not move the clock.
    expect(dispatched.fixerStateChangedAtMs).toBe(T0 + 11 * 60 * 60 * 1_000);
  });

  it('P-001 round-trips the durable retest marker and settles it only after its exact head was judged', () => {
    const admitted = markFrozenRepairAdmitted(fresh(), {
      atMs: T0 + 1,
      actor: 'su-fixer',
      source: { ref: 'staging', sha: C1 },
      fromRepairHead: C,
      toRepairHead: C1,
      paths: ['lib/a.test.ts'],
      unchanged: [],
      blobs: { 'lib/a.test.ts': 'blob-a' },
    });
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(admitted)));
    expect(parsed?.retestRequested).toEqual({
      candidate: C,
      repairHead: C1,
      requestedAtMs: T0 + 1,
    });

    const stalePass = settleFrozenRepairRetestRequest(parsed!, C);
    expect(stalePass.kind).toBe('refire');
    expect(stalePass.queue).toBe(parsed);
    expect(stalePass.queue.retestRequested?.repairHead).toBe(C1);

    const requestedPass = settleFrozenRepairRetestRequest(parsed!, C1);
    expect(requestedPass.kind).toBe('settled');
    expect(requestedPass.queue.retestRequested).toBeUndefined();

    const malformed = parseFrozenCandidateRepairQueue({
      ...admitted,
      retestRequested: { candidate: 'wrong-candidate', repairHead: C1, requestedAtMs: T0 + 1 },
    });
    expect(malformed).not.toBeNull();
    expect(malformed?.retestRequested).toBeUndefined();
  });

  it('P-003 preserves the dedicated clock through JSONB round-trip and falls back for legacy rows', () => {
    const current = fresh();
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(current)));
    expect(parsed?.fixerStateChangedAtMs).toBe(T0);

    const legacy = { ...current } as Record<string, unknown>;
    delete legacy.fixerStateChangedAtMs;
    const parsedLegacy = parseFrozenCandidateRepairQueue(legacy);
    expect(parsedLegacy).not.toBeNull();
    expect(parsedLegacy?.fixerStateChangedAtMs).toBeUndefined();
  });

  it('persists the initial proof group and parses legacy or malformed proof state fail-closed', () => {
    const current = createFrozenCandidateRepairQueue({
      candidate: C,
      base: BASE,
      affectedTestProofGroup: 'initial-gate-run',
      nowMs: T0,
    });
    expect(current).toMatchObject({
      schemaVersion: 4,
      affectedTestProofGroup: 'initial-gate-run',
    });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        schemaVersion: 1,
        affectedTestProofGroup: undefined,
      }),
    ).toMatchObject({ schemaVersion: 4, affectedTestProofGroup: null });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        schemaVersion: 2,
      }),
    ).toMatchObject({ schemaVersion: 4, affectedTestProofGroup: 'initial-gate-run' });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        affectedTestProofGroup: { corrupt: true },
      }),
    ).toMatchObject({ schemaVersion: 4, affectedTestProofGroup: null });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        qualificationAttemptId: '',
      }),
    ).toBeNull();
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        qualificationAttemptId: undefined,
      }),
    ).toMatchObject({ schemaVersion: 4, qualificationAttemptId: null });
  });

  it('leaves an absent queue on the existing normal gate path', () => {
    expect(decideFrozenCandidateRepairQueue(null, { nowMs: T0 })).toEqual({
      kind: 'run-normal-gate',
      runSuite: true,
      recordVerdict: true,
    });
  });

  it.each([
    [true, 'live'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ] as const)(
    'a pending fixer with liveness %s is inconclusive and burns neither a suite nor a verdict',
    (fixerAlive, expectedLiveness) => {
      const queue = markFrozenRepairFixerDispatched(fresh(), {
        spawnId: 'spawn-1',
        nowMs: T0 + 1,
      });
      expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 2, fixerAlive })).toEqual({
        kind: 'wait-for-fixer',
        fixerSpawnId: 'spawn-1',
        liveness: expectedLiveness,
        gateDisposition: 'inconclusive',
        runSuite: false,
        recordVerdict: false,
      });
    },
  );

  it('waits for an active dispatch reservation and retries after its lease expires', () => {
    const reserved: FrozenCandidateRepairQueue = {
      ...fresh(),
      dispatchReservation: {
        token: 'reservation-1',
        claimedAtMs: T0 + 1,
        expiresAtMs: T0 + 100,
      },
    };

    expect(decideFrozenCandidateRepairQueue(reserved, { nowMs: T0 + 2 })).toEqual({
      kind: 'wait-for-dispatch-reservation',
      reservationToken: 'reservation-1',
      reservationExpiresAtMs: T0 + 100,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    });
    expect(decideFrozenCandidateRepairQueue(reserved, { nowMs: T0 + 100 })).toMatchObject({
      kind: 'dispatch-fixer',
      reason: 'unassigned',
      nextAttempt: 1,
    });
  });

  it('recovers a definitively dead fixer before an active dispatch reservation can hide it', () => {
    const reserved = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'dead-fixer',
      nowMs: T0 + 1,
    });
    const withStaleLease: FrozenCandidateRepairQueue = {
      ...reserved,
      dispatchReservation: {
        token: 'stale-launcher',
        claimedAtMs: T0 + 2,
        expiresAtMs: T0 + 10_000,
      },
    };

    expect(
      decideFrozenCandidateRepairQueue(withStaleLease, {
        nowMs: T0 + 3,
        fixerAlive: false,
      }),
    ).toMatchObject({
      kind: 'recover-dead-fixer',
      fixerSpawnId: 'dead-fixer',
      repairHead: C,
    });

    const recovered = markFrozenRepairFixerDead(withStaleLease, {
      spawnId: 'dead-fixer',
      nowMs: T0 + 4,
    });
    expect(recovered).toMatchObject({ fixerSpawnId: null, attempts: 1, repairHead: C });
    expect(recovered.dispatchReservation).toBeUndefined();
    expect(decideFrozenCandidateRepairQueue(recovered, { nowMs: T0 + 5 })).toMatchObject({
      kind: 'dispatch-fixer',
      reason: 'unassigned',
      nextAttempt: 2,
    });
  });

  it('normalizes queue liveness, age, retirement guard, and advertises the SAFE verb', () => {
    const dead = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'dead-fixer',
      nowMs: T0 + 1,
    });
    const diagnostic = diagnoseFrozenCandidateRepairQueue(dead, {
      nowMs: T0 + 2,
      fixerAlive: false,
    });
    expect(diagnostic).toMatchObject({
      phase: 'awaiting-fixer',
      candidate: C,
      repairHead: C,
      fixerSpawnId: 'dead-fixer',
      fixerAlive: false,
      decision: 'recover-dead-fixer',
      retireAllowed: true,
      retireRefusal: null,
    });
    // WI-1586801: retirement is PERMITTED here (dead fixer, safe phase), but the mechanism's
    // own verdict is `recover-dead-fixer` — it will recover this queue itself. Advertising a
    // paste-ready retire call for it is what destroyed recoverable queues in the field, so the
    // destructive recipe must be absent and the safe verb offered instead.
    expect(diagnostic?.nextAction).not.toContain(`expectedUpdatedAtMs: ${dead.updatedAtMs}`);
    expect(diagnostic?.nextAction).not.toContain("op: 'retire'");
    expect(diagnostic?.nextAction).toContain('recover-dead-fixer');
    expect(diagnostic?.nextAction).toContain("op: 'admit'");

    expect(
      diagnoseFrozenCandidateRepairQueue(dead, {
        nowMs: T0 + 2,
        fixerAlive: true,
      }),
    ).toMatchObject({ retireAllowed: false, retireRefusal: 'live-fixer', nextAction: null });

    // P-008: a DEAD/CANCELLED fixer never blocks retirement (fixerAlive:false above reads
    // retireRefusal:null), while an UNANSWERABLE liveness probe still fails closed. The
    // oracle (releaseFixerSpawnAlive) answers a definitive false for terminal task-ledger
    // states, a missing spawn row, and a stale lease — so 'liveness-unknown' is reserved for
    // a probe that genuinely could not answer, never for a dead or cancelled spawn.
    expect(
      diagnoseFrozenCandidateRepairQueue(dead, {
        nowMs: T0 + 2,
        fixerAlive: null,
      }),
    ).toMatchObject({ retireAllowed: false, retireRefusal: 'liveness-unknown' });
  });

  it('P-003 exposes frozenCandidate separately from repairHead and marks no-suite holds', () => {
    const repaired = markFrozenRepairFixerFinished(
      markFrozenRepairFixerDispatched(fresh(), { spawnId: 'fixer', nowMs: T0 + 1 }),
      { spawnId: 'fixer', repairHead: C1, nowMs: T0 + 2 },
    );
    const diagnostic = diagnoseFrozenCandidateRepairQueue(repaired, {
      nowMs: T0 + 3,
      fixerAlive: true,
    });
    expect(diagnostic).toMatchObject({
      frozenCandidate: C,
      candidate: C,
      repairHead: C1,
      verdictProvenance: {
        frozenCandidate: C,
        repairHead: C1,
        phase: 'ready-to-verify',
        frozenCandidateVerdict: 'full-gate-red',
        repairHeadVerdict: 'not-judged',
      },
    });

    const awaiting = diagnoseFrozenCandidateRepairQueue(
      markFrozenRepairFixerDispatched(fresh(), { spawnId: 'fixer', nowMs: T0 + 1 }),
      { nowMs: T0 + 2, fixerAlive: true },
    );
    expect(awaiting?.verdictProvenance).toEqual({
      frozenCandidate: C,
      repairHead: C,
      phase: 'awaiting-fixer',
      frozenCandidateVerdict: 'full-gate-red',
      repairHeadVerdict: 'same-as-frozen-full-gate-red',
    });

    // EI-22767271786772554: after the canonical red writer appends a round at a
    // distinct repair head, the queue returns to awaiting-fixer. That NEXT-action
    // phase must not erase the completed full-gate verdict from the status identity.
    const redRepairHead = markFrozenRepairVerificationRed(repaired, {
      repairHead: C1,
      failingTests: ['lib/still-red.test.ts'],
      nowMs: T0 + 4,
    });
    expect(
      diagnoseFrozenCandidateRepairQueue(redRepairHead, {
        nowMs: T0 + 5,
        fixerAlive: false,
      })?.verdictProvenance,
    ).toEqual({
      frozenCandidate: C,
      repairHead: C1,
      phase: 'awaiting-fixer',
      frozenCandidateVerdict: 'full-gate-red',
      repairHeadVerdict: 'full-gate-red',
    });
  });

  it('WI-1586801: advertises the retire recipe ONLY when the decision is terminal', () => {
    // The control for the assertions above: if `nextAction` simply never rendered the retire
    // call, those would pass vacuously. A genuinely terminal decision must still get the exact
    // CAS recipe — the trap was advertising it for RECOVERABLE queues, not advertising it ever.
    const exhausted = {
      ...fresh(),
      phase: 'blocked' as const,
      blockedReason: 'attempts-exhausted' as const,
      attempts: 9,
      fixerSpawnId: null,
    };
    const diagnostic = diagnoseFrozenCandidateRepairQueue(exhausted, { nowMs: T0 + 2 });

    expect(diagnostic?.decision).toBe('hold-exhausted');
    expect(diagnostic?.retireAllowed).toBe(true);
    expect(diagnostic?.nextAction).toContain("op: 'retire'");
    expect(diagnostic?.nextAction).toContain(`expectedUpdatedAtMs: ${exhausted.updatedAtMs}`);
  });

  it('verifies exactly the forward head reported by the current fixer', () => {
    const dispatched = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    const finished = markFrozenRepairFixerFinished(dispatched, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    expect(finished).toMatchObject({
      phase: 'ready-to-verify',
      candidate: C,
      repairHead: C1,
      attempts: 1,
    });
    expect(decideFrozenCandidateRepairQueue(finished, { nowMs: T0 + 3 })).toEqual({
      kind: 'verify-repair',
      candidate: C1,
      originalCandidate: C,
      gateDisposition: 'repair-verification',
      runSuite: true,
      recordVerdict: true,
    });
    // A completed fixer's retained spawn id is provenance, not a live lease.
    // Its death must not turn an admitted head into a serialized repair hold.
    expect(decideFrozenCandidateRepairQueue(finished, {
      nowMs: T0 + 3,
      fixerAlive: false,
    })).toEqual({
      kind: 'verify-repair',
      candidate: C1,
      originalCandidate: C,
      gateDisposition: 'repair-verification',
      runSuite: true,
      recordVerdict: true,
    });
  });

  it('rejects a late completion from a replaced fixer', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'dead-spawn',
      nowMs: T0 + 1,
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 2, fixerAlive: false })).toMatchObject({
      kind: 'recover-dead-fixer',
      fixerSpawnId: 'dead-spawn',
    });
    queue = markFrozenRepairFixerDead(queue, {
      spawnId: 'dead-spawn',
      nowMs: T0 + 2,
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 2 })).toMatchObject({
      kind: 'dispatch-fixer',
      reason: 'unassigned',
      nextAttempt: 2,
    });
    queue = markFrozenRepairFixerDispatched(queue, {
      spawnId: 'replacement-spawn',
      nowMs: T0 + 3,
    });
    expect(() =>
      markFrozenRepairFixerFinished(queue, {
        spawnId: 'dead-spawn',
        repairHead: C1,
        nowMs: T0 + 4,
      }),
    ).toThrow(/stale fixer completion/);
  });

  it('retries a red verification forward from C1 rather than C or a moving tip', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    queue = markFrozenRepairVerificationRed(queue, {
      repairHead: C1,
      failingTests: ['lib/still-red.test.ts'],
      nowMs: T0 + 3,
    });
    expect(queue).toMatchObject({
      phase: 'awaiting-fixer',
      candidate: C,
      repairHead: C1,
      attempts: 1,
      fixerSpawnId: null,
      failingTests: ['lib/still-red.test.ts'],
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 4 })).toMatchObject({
      kind: 'dispatch-fixer',
      nextAttempt: 2,
      repairHead: C1,
    });

    queue = markFrozenRepairFixerDispatched(queue, {
      spawnId: 'spawn-2',
      nowMs: T0 + 5,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-2',
      repairHead: C2,
      nowMs: T0 + 6,
    });
    expect(queue.candidate).toBe(C);
    expect(queue.repairHead).toBe(C2);
  });

  it('makes green C1 promotable only after the identical patch is observed on staging', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    queue = markFrozenRepairVerificationGreen(queue, {
      repairHead: C1,
      nowMs: T0 + 3,
    });

    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 4 })).toEqual({
      kind: 'inspect-staging-patch',
      candidate: C1,
      originalCandidate: C,
      runSuite: false,
      recordVerdict: false,
    });
    expect(
      decideFrozenCandidateRepairQueue(queue, {
        nowMs: T0 + 4,
        stagingContainsRepair: false,
      }),
    ).toEqual({
      kind: 'hold-staging-mismatch',
      candidate: C1,
      originalCandidate: C,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    });
    expect(
      decideFrozenCandidateRepairQueue(queue, {
        nowMs: T0 + 4,
        stagingContainsRepair: true,
      }),
    ).toEqual({
      kind: 'promote-repair',
      candidate: C1,
      originalCandidate: C,
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('holds the same queue head at the attempt bound and persists the blocked state', () => {
    let queue = fresh();
    for (let attempt = 1; attempt <= DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAttempts; attempt++) {
      queue = markFrozenRepairFixerDispatched(queue, {
        spawnId: `spawn-${attempt}`,
        nowMs: T0 + attempt * 10,
      });
      queue = markFrozenRepairFixerFinished(queue, {
        spawnId: `spawn-${attempt}`,
        repairHead: `${attempt}`.repeat(40),
        nowMs: T0 + attempt * 10 + 1,
      });
      queue = markFrozenRepairVerificationRed(queue, {
        repairHead: `${attempt}`.repeat(40),
        nowMs: T0 + attempt * 10 + 2,
      });
    }
    // D-005: exhaustion HOLDS — there is no budget, no window, no re-cut.
    const decision = decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100 });
    expect(decision).toEqual({
      kind: 'hold-exhausted',
      reason: 'attempts-exhausted',
      candidate: C,
      repairHead: '3'.repeat(40),
      gateDisposition: 'blocked',
      runSuite: false,
      recordVerdict: false,
    });
    if (decision.kind !== 'hold-exhausted') throw new Error('expected attempt exhaustion');
    queue = markFrozenRepairExhausted(queue, {
      reason: decision.reason,
      nowMs: T0 + 101,
    });
    expect(queue).toMatchObject({
      phase: 'blocked',
      blockedReason: 'attempts-exhausted',
      candidate: C,
      repairHead: '3'.repeat(40),
      fixerSpawnId: null,
    });
    expect(parseFrozenCandidateRepairQueue(queue)).toEqual(queue);
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 102 })).toEqual(decision);
  });

  it('P-010: age is not an input — past the former 8h budget a queue still verifies, and an already-green head still promotes', () => {
    // The FORMER wall-clock boundary. It used to decide `hold-exhausted (wall-clock-exhausted)`
    // here; now nothing reads the age except the escalation rung.
    const expiresAt = T0 + 8 * 60 * 60 * 1_000;
    const ancient = expiresAt + 30 * 24 * 60 * 60 * 1_000;
    const decision = decideFrozenCandidateRepairQueue(fresh(), { nowMs: ancient });
    expect(decision.kind).not.toBe('hold-exhausted');
    expect(JSON.stringify(decision)).not.toMatch(/wall-clock/);
    expect(diagnoseFrozenCandidateRepairQueue(fresh(), { nowMs: ancient })).toMatchObject({
      ageEscalationRung: 91,
      ageEscalationIntervalMs: 8 * 60 * 60 * 1_000,
    });
    expect(diagnoseFrozenCandidateRepairQueue(fresh(), { nowMs: ancient })).not.toHaveProperty('ageExpired');

    let green = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    green = markFrozenRepairFixerFinished(green, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    green = markFrozenRepairVerificationGreen(green, {
      repairHead: C1,
      nowMs: expiresAt - 1,
    });
    expect(
      decideFrozenCandidateRepairQueue(green, {
        nowMs: expiresAt + 1,
        stagingContainsRepair: true,
      }),
    ).toMatchObject({ kind: 'promote-repair', candidate: C1 });
  });

  it('rejects stale verification results instead of promoting an untested head', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    expect(() => markFrozenRepairVerificationGreen(queue, { repairHead: C2, nowMs: T0 + 3 })).toThrow(
      /stale repair result/,
    );
    expect(() => markFrozenRepairVerificationRed(queue, { repairHead: C2, nowMs: T0 + 3 })).toThrow(
      /stale repair result/,
    );
  });

  it('parses only a coherent versioned JSONB record and returns a detached value', () => {
    const raw = fresh();
    const parsed = parseFrozenCandidateRepairQueue(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(parsed?.failingTests).not.toBe(raw.failingTests);
    expect(parseFrozenCandidateRepairQueue({ ...raw, schemaVersion: 5 })).toBeNull();
    expect(parseFrozenCandidateRepairQueue({ ...raw, attempts: -1 })).toBeNull();
    expect(parseFrozenCandidateRepairQueue({ ...raw, updatedAtMs: T0 - 1 })).toBeNull();
    expect(
      parseFrozenCandidateRepairQueue({
        ...raw,
        phase: 'ready-to-verify',
        attempts: 0,
        fixerSpawnId: null,
      }),
    ).toBeNull();
    expect(
      parseFrozenCandidateRepairQueue({
        ...raw,
        phase: 'blocked',
        blockedReason: undefined,
      }),
    ).toBeNull();

    const readyToTest = createFrozenCandidateQueue({
      candidate: C,
      base: BASE,
      nowMs: T0,
    });
    expect(parseFrozenCandidateRepairQueue(readyToTest)).toEqual(readyToTest);
  });

  it('P-025: distinguishes a newer persisted schema from a genuinely absent queue', () => {
    const raw = fresh();
    expect(parseFrozenCandidateRepairQueueRead(null)).toEqual({ status: 'absent' });
    expect(parseFrozenCandidateRepairQueueRead(undefined)).toEqual({ status: 'absent' });
    expect(parseFrozenCandidateRepairQueueRead(raw)).toEqual({
      status: 'value',
      queue: raw,
    });
    expect(
      parseFrozenCandidateRepairQueueRead({
        ...raw,
        schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION + 1,
      }),
    ).toEqual({
      status: 'unreadable',
      reason: 'schema-newer-than-reader',
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION + 1,
      candidate: C,
      repairHead: C,
      phase: raw.phase,
    });
  });

  it('P-025: a present malformed row is unreadable, never absent', () => {
    expect(parseFrozenCandidateRepairQueueRead({ schemaVersion: 4, phase: 'ready-to-test' })).toEqual({
      status: 'unreadable',
      reason: 'invalid-shape',
      schemaVersion: 4,
      candidate: null,
      repairHead: null,
      phase: 'ready-to-test',
    });
  });

  it('P-025: describes the raw identity of an unreadable queue instead of saying none is frozen', () => {
    expect(
      describeUnreadableFrozenCandidateRepairQueue({
        status: 'unreadable',
        reason: 'schema-newer-than-reader',
        schemaVersion: 5,
        candidate: C,
        repairHead: C1,
        phase: 'ready-to-verify',
      }),
    ).toMatch(/candidate 111111111111, repairHead 222222222222, phase ready-to-verify/);
  });
});

/**
 * D-005 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03) — an exhausted frozen
 * candidate HOLDS. The P-048/P-008 escape hatch (`recut-at-tip`, `maxCandidateEscapes`,
 * `priorEscapes`, the escape ledger) was deleted outright, not disabled: every automatic retire
 * observed since 2026-08-19 was a re-cut in disguise.
 *
 * These tests pin the property the deletion exists for, at every exhaustion site and under
 * ANY limits: the decision never names a sha outside the frozen lineage, never asks the caller
 * to re-cut, never records a verdict on the pin, and a persisted blocked row re-decides to the
 * SAME hold every tick. Each site still pins its DISTINCT `reason`, so a regression that
 * re-wired one site shows up as a changed reason rather than a vacuous "it holds".
 */
describe('D-005 — an exhausted frozen candidate HOLDS; it never re-cuts (P-048 hatch deleted)', () => {
  const HOLD = {
    kind: 'hold-exhausted',
    gateDisposition: 'blocked',
    runSuite: false,
    recordVerdict: false,
  } as const;

  /** Drive a queue to the attempt bound (three dispatch -> finish -> red cycles). */
  function attemptsExhausted(): FrozenCandidateRepairQueue {
    let queue = fresh();
    for (let attempt = 1; attempt <= DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAttempts; attempt++) {
      queue = markFrozenRepairFixerDispatched(queue, {
        spawnId: `spawn-${attempt}`,
        nowMs: T0 + attempt * 10,
      });
      queue = markFrozenRepairFixerFinished(queue, {
        spawnId: `spawn-${attempt}`,
        repairHead: `${attempt}`.repeat(40),
        nowMs: T0 + attempt * 10 + 1,
      });
      queue = markFrozenRepairVerificationRed(queue, {
        repairHead: `${attempt}`.repeat(40),
        nowMs: T0 + attempt * 10 + 2,
      });
    }
    return queue;
  }

  /** A queue already PERSISTED as blocked — the steady state of the hold. */
  function persistedBlocked(): FrozenCandidateRepairQueue {
    return markFrozenRepairExhausted(fresh(), {
      reason: 'attempts-exhausted',
      nowMs: T0 + 5,
    });
  }

  /** The two exhaustion sites, each with the queue + observation that reaches it. (The third,
   * the 8h wall clock, was deleted by P-010: age is not an exhaustion site any more.) */
  const SITES = [
    { site: 'persisted-blocked', queue: persistedBlocked, nowMs: T0 + 6, reason: 'attempts-exhausted', repairHead: C },
    { site: 'attempt-bound', queue: attemptsExhausted, nowMs: T0 + 100, reason: 'attempts-exhausted', repairHead: '3'.repeat(40) },
  ] as const;

  it.each(SITES)('$site: holds with its own reason, on the frozen lineage, recording nothing', ({ queue, nowMs, reason, repairHead }) => {
    expect(decideFrozenCandidateRepairQueue(queue(), { nowMs })).toEqual({
      ...HOLD,
      reason,
      candidate: C,
      repairHead,
    });
  });

  it.each(SITES)('$site: holds under ANY limits — no limit object re-opens a re-cut', ({ queue, nowMs }) => {
    const variants = [
      DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
      { maxAttempts: 1 },
      { ...DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS, maxFreeRetries: 0 },
      // A stale caller still passing the P-010-deleted age budget: ignored, never honoured.
      { ...DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS, maxAgeMs: 1 } as unknown as typeof DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
      // A stale caller still passing the deleted budget field: ignored, never honoured.
      { ...DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS, maxCandidateEscapes: 5 } as unknown as typeof DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
    ];
    for (const limits of variants) {
      const decision = decideFrozenCandidateRepairQueue(queue(), { nowMs }, limits);
      expect(decision).toMatchObject(HOLD);
      // The lineage invariant, spelled out: the only shas a hold may name are the pin and
      // its own repairHead. A staging tip has no way in.
      expect(decision).toMatchObject({ candidate: C });
      expect([C, '3'.repeat(40)]).toContain((decision as { repairHead: string }).repairHead);
      expect(JSON.stringify(decision)).not.toMatch(/recut|abandoned|escape/i);
    }
  });

  it('the persisted blocked row re-decides to the SAME hold every tick — an idempotent steady state', () => {
    const blocked = persistedBlocked();
    const first = decideFrozenCandidateRepairQueue(blocked, { nowMs: T0 + 6 });
    expect(decideFrozenCandidateRepairQueue(blocked, { nowMs: T0 + 6 + 60 * 60 * 1_000 })).toEqual(first);
    expect(decideFrozenCandidateRepairQueue(blocked, { nowMs: T0 + 6 + 30 * 24 * 60 * 60 * 1_000 })).toEqual(first);
    // Persisting the hold and re-reading it changes nothing either.
    expect(parseFrozenCandidateRepairQueue(blocked)).toEqual(blocked);
  });

  it('a dispatch-infeasible hold persists as blocked with its own reason and re-decides to hold-exhausted', () => {
    // The engine turns `hold-dispatch-infeasible` into a blocked row via markFrozenRepairExhausted;
    // the next tick must read that row back as a hold carrying the SAME reason — not as a fresh
    // awaiting-fixer queue that would try (and fail) to dispatch again, and never as a re-cut.
    const held = markFrozenRepairExhausted(fresh(), { reason: 'dispatch-infeasible', nowMs: T0 + 5 });
    expect(held).toMatchObject({ phase: 'blocked', blockedReason: 'dispatch-infeasible', candidate: C, repairHead: C });
    expect(parseFrozenCandidateRepairQueue(held)).toEqual(held);
    expect(decideFrozenCandidateRepairQueue(held, { nowMs: T0 + 6, dispatchFeasible: false })).toEqual({
      ...HOLD,
      reason: 'dispatch-infeasible',
      candidate: C,
      repairHead: C,
    });
  });

  it('the diagnostic never advertises a re-cut: terminal holds get the owner-only retire recipe, recoverable queues get the lineage verb', () => {
    const terminal = diagnoseFrozenCandidateRepairQueue(attemptsExhausted(), { nowMs: T0 + 100 });
    expect(terminal).toMatchObject({ decision: 'hold-exhausted', retireAllowed: true });
    expect(terminal?.nextAction).toContain("op: 'retire'");
    expect(terminal?.nextAction).toContain('confirm: true');
    expect(JSON.stringify(terminal)).not.toMatch(/recut|checkpoint-run|escape/i);

    const recoverable = diagnoseFrozenCandidateRepairQueue(fresh(), { nowMs: T0 + 1 });
    expect(recoverable?.decision).toBe('dispatch-fixer');
    expect(recoverable?.nextAction).toContain('do NOT retire');
    expect(JSON.stringify(recoverable)).not.toMatch(/recut|checkpoint-run|escape/i);
  });

  it('leaves the non-exhausted paths untouched', () => {
    expect(decideFrozenCandidateRepairQueue(fresh(), { nowMs: T0 + 1 })).toMatchObject({
      kind: 'dispatch-fixer',
    });
    expect(decideFrozenCandidateRepairQueue(null, { nowMs: T0 + 1 })).toEqual({
      kind: 'run-normal-gate',
      runSuite: true,
      recordVerdict: true,
    });
  });
});

describe('P-009 — shared-tree collision detector (REPORT-ONLY)', () => {
  /**
   * PERMANENT DELIBERATELY-WRONG CONTROL (CLAUDE.md: no cp/mutate/restore — the subject is a
   * module we import, so the wrong implementation lives here forever as a control).
   *
   * This is the naive detector this guard must NOT be. It commits the two errors that make a
   * report-only guard worse than none: it reports `measured: true` when nothing was measured
   * (a false all-clear), and it ignores the repair phase (a false alarm before any repair
   * exists). Every assertion below must REJECT this shape.
   */
  function naiveCollision(queue: FrozenCandidateRepairQueue | null, edited: readonly string[] | null | undefined) {
    const failing = queue?.failingTests ?? [];
    const paths = (edited ?? []).filter((p) => failing.includes(p));
    return { measured: true, collidingPaths: paths, collisionCount: paths.length };
  }

  const inFlight = (): FrozenCandidateRepairQueue => ({
    ...fresh(),
    failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
  });

  it('CALIBRATION: on a plain collision the real detector and the control agree', () => {
    // Without this, every "differs from the control" assertion below would also pass if the
    // detector were simply broken in some unrelated way.
    const q = inFlight();
    const got = detectFrozenRepairSharedTreeCollision(q, ['lib/a.test.ts']);
    expect(got.collidingPaths).toEqual(naiveCollision(q, ['lib/a.test.ts']).collidingPaths);
    expect(got.measured).toBe(true);
    expect(got.repairInFlight).toBe(true);
    expect(got.collisionCount).toBe(1);
  });

  it('says so LOUDLY: names the frozen lineage and that a shared-checkout edit is NOT admission', () => {
    const got = detectFrozenRepairSharedTreeCollision(inFlight(), ['lib/b.test.ts']);
    expect(got.detail).toContain('FROZEN-REPAIR COLLISION');
    expect(got.detail).toContain('NOT admission');
    expect(got.detail).toContain('lib/b.test.ts');
  });

  it('NOT MEASURED is not an all-clear — the control calls it measured, this must not', () => {
    // The whole point of the field. A failed/absent measurement that renders as zero
    // collisions is a false all-clear precisely when the measurement broke.
    const q = inFlight();
    for (const missing of [null, undefined]) {
      const got = detectFrozenRepairSharedTreeCollision(q, missing);
      expect(got.measured).toBe(false);
      expect(got.measured).not.toBe(naiveCollision(q, missing).measured);
      expect(got.collisionCount).toBe(0);
      // ...and it must still SAY that it did not measure, rather than going silent.
      expect(got.detail).toContain('NOT MEASURED');
    }
  });

  it('ready-to-test is NOT in flight, so an overlapping edit is not a collision', () => {
    // No repair exists yet — the candidate has not had its first suite, so an edit races nothing.
    // The control fires here; the real detector must not.
    const q: FrozenCandidateRepairQueue = { ...inFlight(), phase: 'ready-to-test' };
    const got = detectFrozenRepairSharedTreeCollision(q, ['lib/a.test.ts']);
    expect(got.repairInFlight).toBe(false);
    expect(got.collisionCount).toBe(0);
    expect(got.detail).toBeNull();
    expect(naiveCollision(q, ['lib/a.test.ts']).collisionCount).toBe(1); // the control's false alarm
  });

  it('blocked IS in flight — the head stays immutable and nobody is watching', () => {
    const q: FrozenCandidateRepairQueue = { ...inFlight(), phase: 'blocked' };
    const got = detectFrozenRepairSharedTreeCollision(q, ['lib/a.test.ts']);
    expect(got.repairInFlight).toBe(true);
    expect(got.collisionCount).toBe(1);
  });

  it('normalizes ./ and backslash paths the control compares literally', () => {
    const q = inFlight();
    const edited = ['./lib/a.test.ts', 'lib\\b.test.ts'];
    const got = detectFrozenRepairSharedTreeCollision(q, edited);
    expect(got.collidingPaths).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(naiveCollision(q, edited).collisionCount).toBe(0); // the control misses both
  });

  it('caps the listed paths but reports the TRUE count and marks the truncation', () => {
    const many = Array.from({ length: FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP + 5 }, (_, i) => `lib/t${i}.test.ts`);
    const q: FrozenCandidateRepairQueue = { ...fresh(), failingTests: many };
    const got = detectFrozenRepairSharedTreeCollision(q, many);
    expect(got.collidingPaths).toHaveLength(FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP);
    expect(got.collisionCount).toBe(many.length); // the count must NOT be capped
    expect(got.truncated).toBe(true);
    expect(got.detail).toContain('5 more');
  });

  it('is REPORT-ONLY: a collision changes no control field of the diagnostic', () => {
    // The plan asks for detection FIRST. If this ever fails, the guard has started
    // blocking on a signal that was only supposed to be reported.
    const q = inFlight();
    const clean = diagnoseFrozenCandidateRepairQueue(q, { nowMs: T0 + 1, sharedTreeEditedPaths: [] });
    const colliding = diagnoseFrozenCandidateRepairQueue(q, {
      nowMs: T0 + 1,
      sharedTreeEditedPaths: ['lib/a.test.ts', 'lib/b.test.ts'],
    });
    expect(colliding!.sharedTreeCollision.collisionCount).toBe(2); // the collision really is seen
    for (const field of ['decision', 'retireAllowed', 'retireRefusal', 'nextAction'] as const) {
      expect(colliding![field]).toEqual(clean![field]);
    }
  });
});

describe('WI-212675 — a no-op fixer at a never-verified converged head means "verify", not "dead"', () => {
  /** An awaiting-fixer queue whose repairHead was fast-forwarded by converge (phase untouched). */
  function convergedAwaitingFixer(
    overrides: Partial<FrozenCandidateRepairQueue> = {},
  ): FrozenCandidateRepairQueue {
    return {
      ...fresh(),
      phase: 'awaiting-fixer',
      attempts: 1,
      fixerSpawnId: 'spawn-1',
      repairHead: C1,
      ...overrides,
    };
  }

  /**
   * PERMANENT deliberately-wrong control: the obvious "has the head moved?" reading. It is
   * wrong in exactly the way that would re-run a red head for free — it cannot tell a head
   * that CONVERGED from one that was already VERIFIED RED. Kept so the real predicate has
   * something to differ from; the comparison test below fails if they ever agree everywhere.
   */
  function naiveHeadMoved(queue: FrozenCandidateRepairQueue): boolean {
    return queue.repairHead !== queue.candidate;
  }

  it('CALIBRATION: at the frozen candidate itself there is nothing to verify (round 1 seeds it red)', () => {
    const queue = { ...fresh(), phase: 'awaiting-fixer' as const, attempts: 1, fixerSpawnId: 'spawn-1' };
    expect(queue.repairHead).toBe(C);
    expect(frozenRepairHeadAwaitsVerification(queue)).toBe(false);
    expect(naiveHeadMoved(queue)).toBe(false);
  });

  it('a converged head with no round recorded at it AWAITS verification', () => {
    const queue = convergedAwaitingFixer();
    expect(queue.convergenceRounds?.map((r) => r.head)).toEqual([C]);
    expect(frozenRepairHeadAwaitsVerification(queue)).toBe(true);
  });

  it('LOAD-BEARING: a head already verified RED does not re-enter verification — the naive control says it does', () => {
    // verify → red → dispatch → no-op fixer: the no-op must read as a failed attempt here,
    // or every tick would spend a full suite on a head the suite already judged.
    const red = markFrozenRepairVerificationRed(
      { ...convergedAwaitingFixer(), phase: 'ready-to-verify' },
      { repairHead: C1, failingTests: ['lib/a.test.ts'], nowMs: T0 + 1_000 },
    );
    const redispatched = { ...red, fixerSpawnId: 'spawn-2', attempts: 2 };
    expect(redispatched.phase).toBe('awaiting-fixer');
    expect(redispatched.convergenceRounds?.map((r) => r.head)).toEqual([C, C1]);
    expect(frozenRepairHeadAwaitsVerification(redispatched)).toBe(false);
    expect(naiveHeadMoved(redispatched)).toBe(true);
  });

  it('a SECOND converge past a red-verified head awaits verification again — each head costs one suite', () => {
    const red = markFrozenRepairVerificationRed(
      { ...convergedAwaitingFixer(), phase: 'ready-to-verify' },
      { repairHead: C1, failingTests: ['lib/a.test.ts'], nowMs: T0 + 1_000 },
    );
    const convergedAgain = { ...red, repairHead: C2, fixerSpawnId: 'spawn-2', attempts: 2 };
    expect(frozenRepairHeadAwaitsVerification(convergedAgain)).toBe(true);
  });

  it('legacy queue with NO rounds: a moved head errs toward one verification, the candidate never does', () => {
    const { convergenceRounds: _rounds, ...legacy } = convergedAwaitingFixer();
    expect(Object.hasOwn(legacy, 'convergenceRounds')).toBe(false);
    expect(frozenRepairHeadAwaitsVerification(legacy)).toBe(true);
    expect(frozenRepairHeadAwaitsVerification({ ...legacy, repairHead: C })).toBe(false);
  });

  it('the completion marker accepts the converged head unchanged and lands in ready-to-verify', () => {
    const queue = convergedAwaitingFixer();
    const finished = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-1',
      repairHead: queue.repairHead,
      nowMs: T0 + 2_000,
    });
    expect(finished).toMatchObject({ phase: 'ready-to-verify', repairHead: C1, fixerSpawnId: 'spawn-1' });
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(finished)))).not.toBeNull();
    expect(decideFrozenCandidateRepairQueue(finished, { nowMs: T0 + 3_000 })).toMatchObject({
      kind: 'verify-repair',
      candidate: C1,
      originalCandidate: C,
    });
  });
});

describe('P-013 / D-007 — convergence rounds + the owner-visible off switch', () => {
  /** A queue parked at the phase a red repair verification is legal from. */
  function readyToVerify(overrides: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
    return {
      ...fresh(),
      phase: 'ready-to-verify',
      attempts: 1,
      fixerSpawnId: 'spawn-1',
      ...overrides,
    };
  }

  /**
   * PERMANENT deliberately-wrong control. This is the obvious ring-buffer trim, and it is
   * wrong in exactly one way: it drops the FIRST round, which is the baseline every shrink
   * figure is measured against. It stays in this file so the real cap has something to be
   * different from — if a refactor makes `capConvergenceRounds` behave like this, the test
   * below that compares them starts failing instead of silently passing.
   */
  function naiveCap<T>(rounds: readonly T[], cap: number): T[] {
    return rounds.slice(-cap);
  }

  it('CALIBRATION: the first red seeds round 1, so a shrink always has a baseline', () => {
    // createFrozenCandidateRepairQueue routes through markFrozenCandidateVerificationRed,
    // so creation IS the first red. If this stops being true, `failingFirst` silently
    // becomes the SECOND red and every shrink figure understates by one round.
    const queue = fresh();
    expect(queue.convergenceRounds).toEqual([{ round: 1, head: C, failingCount: 1, failingTests: ['lib/a.test.ts'], atMs: T0 }]);
  });

  it('each subsequent red appends a round with its failing-set size', () => {
    const first = readyToVerify();
    const second = markFrozenRepairVerificationRed(first, {
      repairHead: C,
      failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
      nowMs: T0 + 1_000,
    });
    // P-007 (#D-040): lib/b.test.ts is newly red; a red at the candidate has no admission to own it.
    expect(second.convergenceRounds).toEqual([
      { round: 1, head: C, failingCount: 1, failingTests: ['lib/a.test.ts'], atMs: T0 },
      { round: 2, head: C, failingCount: 2, failingTests: ['lib/a.test.ts', 'lib/b.test.ts'], atMs: T0 + 1_000, attributions: [{ entry: 'test-file:lib/b.test.ts', basis: 'none', admissions: [] }] },
    ]);
  });

  it('LOAD-BEARING: trimming to the cap retains the FIRST round, unlike a naive ring buffer', () => {
    const many = Array.from({ length: FROZEN_REPAIR_CONVERGENCE_ROUND_CAP + 6 }, (_, i) => ({
      round: i + 1,
      head: C,
      // A genuinely converging cycle: 40 failures shrinking by one each round.
      failingCount: 40 - i,
      atMs: T0 + i * 1_000,
    }));
    const parsed = parseFrozenCandidateRepairQueue({
      ...readyToVerify(),
      convergenceRounds: many,
    });
    expect(parsed).not.toBeNull();
    const kept = parsed!.convergenceRounds!;
    expect(kept).toHaveLength(FROZEN_REPAIR_CONVERGENCE_ROUND_CAP);
    // The whole point: round 1 survives the trim.
    expect(kept[0]).toEqual(many[0]);
    expect(kept[kept.length - 1]).toEqual(many[many.length - 1]);
    // ...and the naive trim, which is what a reasonable person writes first, does NOT.
    const naive = naiveCap(many, FROZEN_REPAIR_CONVERGENCE_ROUND_CAP);
    expect(naive[0]).not.toEqual(many[0]);
    expect(kept).not.toEqual(naive);
  });

  it('round numbers keep counting after a trim — history is never renumbered', () => {
    const many = Array.from({ length: FROZEN_REPAIR_CONVERGENCE_ROUND_CAP + 3 }, (_, i) => ({
      round: i + 1,
      head: C,
      failingCount: 30 - i,
      atMs: T0 + i * 1_000,
    }));
    const queue = readyToVerify({ convergenceRounds: many });
    const next = markFrozenRepairVerificationRed(queue, {
      repairHead: C,
      failingTests: [],
      nowMs: T0 + 99_000,
    });
    const rounds = next.convergenceRounds!;
    // Highest existing round was cap+3; the new one must be cap+4, not a reused index.
    expect(rounds[rounds.length - 1]!.round).toBe(FROZEN_REPAIR_CONVERGENCE_ROUND_CAP + 4);
    expect(new Set(rounds.map((r) => r.round)).size).toBe(rounds.length);
  });

  it('a legacy queue with no rounds parses, and reads as "none recorded" not "not converging"', () => {
    const legacy = { ...fresh() } as Record<string, unknown>;
    delete legacy.convergenceRounds;
    const parsed = parseFrozenCandidateRepairQueue(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.convergenceRounds).toBeUndefined();
    const summary = summarizeFrozenRepairConvergence(parsed!, T0 + 5_000);
    expect(summary.admissionRounds).toBe(0);
    expect(summary.failingFirst).toBeNull();
    expect(summary.shrinkTotal).toBeNull();
    // NOT false — "no rounds recorded" is not evidence of a treadmill.
    expect(summary.converging).toBeNull();
  });

  it('malformed rounds are dropped WITHOUT failing the parse — the queue is safety state', () => {
    const parsed = parseFrozenCandidateRepairQueue({
      ...readyToVerify(),
      convergenceRounds: [
        { round: 1, head: C, failingCount: 5, atMs: T0 },
        { round: 0, head: C, failingCount: 5, atMs: T0 },
        { round: 2, head: '', failingCount: 5, atMs: T0 },
        { round: 3, head: C, failingCount: -1, atMs: T0 },
        { round: 4, head: C, failingCount: 2, atMs: 'nope' },
        'not-an-object',
      ],
    });
    // The queue itself survives — refusing it would discard the frozen head.
    expect(parsed).not.toBeNull();
    expect(parsed!.repairHead).toBe(C);
    expect(parsed!.convergenceRounds).toEqual([{ round: 1, head: C, failingCount: 5, atMs: T0 }]);
  });

  it("a newer build's keys on a round survive this build's read-modify-write (WI-6554700010009930)", () => {
    // The live incident: an older parser rebuilt rounds from a fixed key list, so every write
    // from the older build stripped the `executed` record the newer gate had appended. A key
    // this build does not know must ride through parse -> mutate -> persist -> parse unchanged.
    const futureRound = { round: 1, head: C, failingCount: 5, atMs: T0, futureEvidence: { files: 3 } };
    const parsed = parseFrozenCandidateRepairQueue({ ...readyToVerify(), convergenceRounds: [futureRound] });
    expect(parsed!.convergenceRounds![0]).toEqual(futureRound);
    const next = markFrozenRepairVerificationRed(parsed!, { repairHead: C, failingTests: [], nowMs: T0 + 1_000 });
    const reread = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(next)));
    expect(reread!.convergenceRounds![0]).toEqual(futureRound);
    // The round THIS build appended carries no invented key.
    expect(reread!.convergenceRounds).toHaveLength(2);
    expect(reread!.convergenceRounds![1]).not.toHaveProperty('futureEvidence');
  });

  it('a round key the parser read and REJECTED is never revived by the carry-forward', () => {
    const parsed = parseFrozenCandidateRepairQueue({
      ...readyToVerify(),
      convergenceRounds: [{ round: 1, head: C, failingCount: 5, atMs: T0, executed: 'not-a-record' }],
    });
    expect(parsed!.convergenceRounds).toEqual([{ round: 1, head: C, failingCount: 5, atMs: T0 }]);
  });

  it('summarizes a converging cycle: monotonic shrink to a smaller set', () => {
    const queue = readyToVerify({
      failingTests: ['lib/a.test.ts'],
      convergenceRounds: [
        { round: 1, head: C, failingCount: 12, atMs: T0 },
        { round: 2, head: C, failingCount: 5, atMs: T0 + 1_000 },
        { round: 3, head: C, failingCount: 1, atMs: T0 + 2_000 },
      ],
    });
    const summary = summarizeFrozenRepairConvergence(queue, T0 + 10_000);
    expect(summary).toMatchObject({
      openedAtMs: T0,
      ageMs: 10_000,
      admissionRounds: 3,
      failingFirst: 12,
      failingNow: 1,
      shrinkTotal: 11,
      converging: true,
    });
    expect(summary.shrinkPerRound).toEqual([
      { round: 1, failingCount: 12, delta: null },
      { round: 2, failingCount: 5, delta: -7 },
      { round: 3, failingCount: 1, delta: -4 },
    ]);
  });

  it('a cycle whose failing set GREW is not reported as converging', () => {
    const queue = readyToVerify({
      failingTests: Array.from({ length: 9 }, (_, i) => `lib/${i}.test.ts`),
      convergenceRounds: [
        { round: 1, head: C, failingCount: 4, atMs: T0 },
        { round: 2, head: C, failingCount: 9, atMs: T0 + 1_000 },
      ],
    });
    const summary = summarizeFrozenRepairConvergence(queue, T0 + 2_000);
    expect(summary.shrinkTotal).toBe(-5);
    expect(summary.converging).toBe(false);
  });

  it('a single recorded round is UNKNOWN, never a verdict', () => {
    const summary = summarizeFrozenRepairConvergence(fresh(), T0 + 1_000);
    expect(summary.admissionRounds).toBe(1);
    // One data point cannot establish a trend in either direction.
    expect(summary.converging).toBeNull();
  });

  it('off switch: ON (the deployed default) opens a cycle on a first real red', () => {
    expect(decideFrozenConvergenceCycleEntry({ flagEnabled: true, hasOpenQueue: false })).toEqual({
      kind: 'open-cycle',
      reason: 'first-real-red',
    });
  });

  it('off switch: OFF suppresses a NEW cycle', () => {
    expect(decideFrozenConvergenceCycleEntry({ flagEnabled: false, hasOpenQueue: false })).toEqual({
      kind: 'suppressed',
      reason: 'off-switch-disabled',
    });
  });

  it('LOAD-BEARING: an ALREADY-OPEN cycle is never suppressed, even with the switch OFF', () => {
    // Turning the default off must stop new cycles opening; abandoning a candidate that is
    // mid-convergence would strand its repair worktree and un-freeze a head the gate has
    // already committed to. Both switch positions must agree here.
    expect(decideFrozenConvergenceCycleEntry({ flagEnabled: false, hasOpenQueue: true })).toEqual({
      kind: 'advance-existing-cycle',
      reason: 'queue-already-open',
    });
    expect(decideFrozenConvergenceCycleEntry({ flagEnabled: true, hasOpenQueue: true })).toEqual(
      decideFrozenConvergenceCycleEntry({ flagEnabled: false, hasOpenQueue: true }),
    );
  });
});

describe('WI-10007489 — each red round records the radius it EXECUTED', () => {
  function readyToVerify(overrides: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
    return { ...fresh(), phase: 'ready-to-verify', attempts: 1, fixerSpawnId: 'spawn-1', ...overrides };
  }

  const targeted = frozenRepairRoundExecution({
    mode: 'targeted',
    fileKeys: ['lib/b.test.ts', 'lib/a.test.ts', 'lib/a.test.ts'],
    gateIds: ['lint:tsc', 'operator-core:test'],
    radiusMode: 'repair-ledger',
  });

  it('the builder counts de-duplicated files and digests them independent of order', () => {
    expect(targeted).toMatchObject({
      mode: 'targeted',
      fileCount: 2,
      gateIds: ['lint:tsc', 'operator-core:test'],
      radiusMode: 'repair-ledger',
    });
    expect(targeted.filesDigest).toMatch(/^[0-9a-f]{16}$/);
    const reordered = frozenRepairRoundExecution({
      mode: 'targeted',
      fileKeys: ['lib/a.test.ts', 'lib/b.test.ts'],
    });
    expect(reordered.filesDigest).toBe(targeted.filesDigest);
    // A different set must not collide with this one, or the digest proves nothing.
    const other = frozenRepairRoundExecution({ mode: 'targeted', fileKeys: ['lib/a.test.ts'] });
    expect(other.filesDigest).not.toBe(targeted.filesDigest);
  });

  it('an empty file set records a ZERO count and no digest; an uncounted full run records no count', () => {
    const empty = frozenRepairRoundExecution({ mode: 'targeted', fileKeys: [] });
    expect(empty.fileCount).toBe(0);
    expect(empty.filesDigest).toBeUndefined();
    const full = frozenRepairRoundExecution({ mode: 'full' });
    // Absent, never 0: a full run whose files were not counted did not run zero files.
    expect(Object.hasOwn(full, 'fileCount')).toBe(false);
    expect(full).toEqual({ mode: 'full', gateIds: [] });
  });

  it('gate ids are capped so the persisted row stays bounded', () => {
    const many = Array.from({ length: FROZEN_REPAIR_ROUND_GATE_ID_CAP + 9 }, (_, i) => `gate-${i}`);
    const record = frozenRepairRoundExecution({ mode: 'targeted', gateIds: many });
    expect(record.gateIds).toHaveLength(FROZEN_REPAIR_ROUND_GATE_ID_CAP);
    expect(record.gateIds[0]).toBe('gate-0');
  });

  it('a repair-head red stores the executed radius on the round it appends', () => {
    const next = markFrozenRepairVerificationRed(readyToVerify(), {
      repairHead: C,
      failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
      nowMs: T0 + 1_000,
      executed: targeted,
    });
    expect(next.convergenceRounds).toEqual([
      { round: 1, head: C, failingCount: 1, failingTests: ['lib/a.test.ts'], atMs: T0 },
      { round: 2, head: C, failingCount: 2, failingTests: ['lib/a.test.ts', 'lib/b.test.ts'], atMs: T0 + 1_000, executed: targeted, attributions: [{ entry: 'test-file:lib/b.test.ts', basis: 'none', admissions: [] }] },
    ]);
  });

  it('a superseded red and an opening candidate red record it too', () => {
    const admitted = markFrozenRepairAdmitted(readyToVerify(), {
      atMs: T0 + 500,
      actor: 'su-peer',
      source: { ref: 'staging', sha: C1 },
      fromRepairHead: C,
      toRepairHead: C1,
      paths: ['lib/a.ts'],
      unchanged: [],
      blobs: {},
    });
    const superseded = recordFrozenRepairSupersededRed(admitted, {
      measuredHead: C,
      failingTests: ['lib/a.test.ts'],
      nowMs: T0 + 1_000,
      executed: frozenRepairRoundExecution({ mode: 'full' }),
    });
    expect(superseded.convergenceRounds?.at(-1)?.executed).toEqual({ mode: 'full', gateIds: [] });

    // The gate's opening red: a ready-to-test candidate measured red by the full suite.
    const readyToTest = createFrozenCandidateQueue({
      candidate: C,
      base: BASE,
      failingTests: ['lib/a.test.ts'],
      nowMs: T0,
    });
    const opened = markFrozenCandidateVerificationRed(readyToTest, {
      failingTests: ['lib/a.test.ts'],
      nowMs: T0 + 2_000,
      executed: frozenRepairRoundExecution({ mode: 'full' }),
    });
    expect(opened.convergenceRounds).toEqual([
      { round: 1, head: C, failingCount: 1, failingTests: ['lib/a.test.ts'], atMs: T0 + 2_000, executed: { mode: 'full', gateIds: [] } },
    ]);
  });

  it('the executed record survives a persist + parse round trip', () => {
    const next = markFrozenRepairVerificationRed(readyToVerify(), {
      repairHead: C,
      failingTests: ['lib/a.test.ts'],
      nowMs: T0 + 1_000,
      executed: targeted,
    });
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(next)));
    expect(parsed?.convergenceRounds?.at(-1)?.executed).toEqual(targeted);
  });

  it('LEGACY: a round with no executed record parses unchanged and gains no field', () => {
    const parsed = parseFrozenCandidateRepairQueue({
      ...readyToVerify(),
      convergenceRounds: [{ round: 1, head: C, failingCount: 3, atMs: T0 }],
    });
    expect(parsed?.convergenceRounds).toEqual([{ round: 1, head: C, failingCount: 3, atMs: T0 }]);
    expect(Object.hasOwn(parsed!.convergenceRounds![0]!, 'executed')).toBe(false);
  });

  it('a malformed executed record is dropped while its ROUND is kept', () => {
    const parsed = parseFrozenCandidateRepairQueue({
      ...readyToVerify(),
      convergenceRounds: [
        { round: 1, head: C, failingCount: 3, atMs: T0, executed: { mode: 'partial', gateIds: [] } },
        { round: 2, head: C, failingCount: 2, atMs: T0 + 1, executed: { mode: 'full', gateIds: 'lint:tsc' } },
        { round: 3, head: C, failingCount: 1, atMs: T0 + 2, executed: { mode: 'full', fileCount: -1, gateIds: [] } },
        { round: 4, head: C, failingCount: 1, atMs: T0 + 3, executed: { mode: 'full', filesDigest: 'NOT-HEX', gateIds: [] } },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.convergenceRounds!.map((round) => round.round)).toEqual([1, 2, 3, 4]);
    expect(parsed!.convergenceRounds!.slice(0, 3).every((round) => round.executed === undefined)).toBe(true);
    // A bad digest alone is stripped; the rest of the record is still evidence.
    expect(parsed!.convergenceRounds![3]!.executed).toEqual({ mode: 'full', gateIds: [] });
  });
});

describe('P-013 / D-007 — the gate_health.convergence PROJECTION', () => {
  /**
   * PERMANENT deliberately-wrong control (CLAUDE.md: prove falsifiability without mutating the
   * shared tree). This is the projection an implementer writes when they treat "put the summary
   * in gate_health" as a copy job: it carries the numbers and drops the cycle IDENTITY and the
   * observation stamp. Every assertion below must REJECT it. It also proves the assertions are
   * not merely restating `summarizeFrozenRepairConvergence`, which they would pass unchanged.
   */
  function naiveProjection(queue: FrozenCandidateRepairQueue, nowMs: number): Record<string, unknown> {
    return { ...summarizeFrozenRepairConvergence(queue, nowMs) };
  }

  function twoRoundQueue(): FrozenCandidateRepairQueue {
    return parseFrozenCandidateRepairQueue({
      ...fresh(),
      failingTests: ['lib/a.test.ts'],
      convergenceRounds: [
        { round: 1, head: C, failingCount: 5, atMs: T0 },
        { round: 2, head: C1, failingCount: 1, atMs: T0 + 1_000 },
      ],
    })!;
  }

  it('CALIBRATION: the real projection carries every summary field unchanged', () => {
    // If this fails, the controls below prove nothing — they would be rejecting the honest
    // projection for the wrong reason.
    const queue = twoRoundQueue();
    const summary = summarizeFrozenRepairConvergence(queue, T0 + 2_000);
    const projected = buildFrozenRepairConvergenceGateHealth(queue, T0 + 2_000);
    expect(projected).toMatchObject(summary as unknown as Record<string, unknown>);
    expect(projected.converging).toBe(true);
    expect(projected.shrinkTotal).toBe(4);
  });

  it('LOAD-BEARING: the projection names WHICH cycle it describes — the naive one cannot', () => {
    const queue = twoRoundQueue();
    const projected = buildFrozenRepairConvergenceGateHealth(queue, T0 + 2_000);
    expect(projected.candidate).toBe(queue.candidate);
    expect(projected.repairHead).toBe(queue.repairHead);
    expect(projected.phase).toBe(queue.phase);
    // The control: shrink figures with no cycle identity read as describing whatever candidate
    // the reader is currently looking at.
    const control = naiveProjection(queue, T0 + 2_000);
    expect(control.candidate).toBeUndefined();
    expect(control.repairHead).toBeUndefined();
    expect(control.phase).toBeUndefined();
  });

  it('LOAD-BEARING: the projection is stamped, so a stale reading is distinguishable', () => {
    const projected = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 9_000);
    expect(projected.observedAtMs).toBe(T0 + 9_000);
    expect(naiveProjection(twoRoundQueue(), T0 + 9_000).observedAtMs).toBeUndefined();
  });

  it('round-trips through JSON — what PG stores is what a reader gets back', () => {
    const projected = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000);
    expect(parseFrozenRepairConvergence(JSON.parse(JSON.stringify(projected)))).toEqual(projected);
  });

  it('the parser REJECTS the naive projection rather than rendering it with holes', () => {
    // A blob missing the identity fields is not a degraded reading to be shown with blanks; it
    // is a reading whose subject is unknown.
    const control = naiveProjection(twoRoundQueue(), T0 + 2_000);
    expect(parseFrozenRepairConvergence(JSON.parse(JSON.stringify(control)))).toBeNull();
  });

  it('absent / cleared / malformed all read as null — never as a clean zero', () => {
    expect(parseFrozenRepairConvergence(undefined)).toBeNull();
    // JSON null is how the retire paths CLEAR the projection.
    expect(parseFrozenRepairConvergence(null)).toBeNull();
    expect(parseFrozenRepairConvergence('convergence')).toBeNull();
    expect(parseFrozenRepairConvergence([])).toBeNull();
    const good = JSON.parse(
      JSON.stringify(buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000)),
    ) as Record<string, unknown>;
    expect(parseFrozenRepairConvergence({ ...good, shrinkPerRound: 'lots' })).toBeNull();
    expect(parseFrozenRepairConvergence({ ...good, shrinkPerRound: [{ round: 1 }] })).toBeNull();
  });

  it('LOAD-BEARING: a wrong-typed tri-state is REJECTED, not coerced to "not yet knowable"', () => {
    const good = JSON.parse(
      JSON.stringify(buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000)),
    ) as Record<string, unknown>;
    // `converging: null` is a legitimate stored value ("fewer than two rounds"), so a corrupt
    // value coerced to null would be indistinguishable from an honest unknown.
    expect(parseFrozenRepairConvergence({ ...good, converging: 'yes' })).toBeNull();
    expect(parseFrozenRepairConvergence({ ...good, failingFirst: 'five' })).toBeNull();
    expect(parseFrozenRepairConvergence({ ...good, shrinkTotal: '4' })).toBeNull();
  });

  it('a genuinely-unknown cycle parses, with its nulls intact', () => {
    // One round: converging is NULL by design. The parser must accept that, or the projection
    // would only ever be readable for cycles that already have a verdict.
    const projected = buildFrozenRepairConvergenceGateHealth(fresh(), T0 + 1_000);
    expect(projected.converging).toBeNull();
    const parsed = parseFrozenRepairConvergence(JSON.parse(JSON.stringify(projected)));
    expect(parsed).not.toBeNull();
    expect(parsed!.converging).toBeNull();
    expect(parsed!.admissionRounds).toBe(1);
  });
});

describe('P-006 / D-004 — failingNow publishes WHAT it counts, beside itself', () => {
  /**
   * PERMANENT deliberately-wrong control (CLAUDE.md: prove falsifiability without mutating the
   * shared tree). This is the "scope" an implementer writes when they read D-004 as asking for a
   * disclaimer: a static sentence with no subject and no vintage. It reads reassuring and settles
   * nothing — a reader still cannot tell WHICH sha or WHEN, so they can still difference this
   * count against repairTickLegs and get a number. Every assertion below must REJECT it.
   */
  const naiveScope = {
    population: 'queue-admitted-failing-set' as const,
    subject: null,
    admittedAtOrBeforeMs: null,
    admittedAtOrAfterMs: null,
    notComparableTo: [] as readonly { reading: string; why: string }[],
    summary: 'Counts may vary. Compare with care.',
  };

  function twoRoundQueue(): FrozenCandidateRepairQueue {
    return parseFrozenCandidateRepairQueue({
      ...fresh(),
      failingTests: ['lib/a.test.ts'],
      convergenceRounds: [
        { round: 1, head: C, failingCount: 5, atMs: T0 },
        { round: 2, head: C1, failingCount: 1, atMs: T0 + 1_000 },
      ],
    })!;
  }

  it('CALIBRATION: the measured projection still carries failingNow itself, unchanged', () => {
    // If this fails, the assertions below prove nothing about scope — they would be passing or
    // failing for the wrong reason.
    const record = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000);
    const cell = projectFrozenRepairConvergenceCell(record);
    expect(cell.failingNow).toBe(1);
    expect(cell.unmeasured).toBe(false);
  });

  it('LOAD-BEARING: the scope names the SUBJECT sha — the naive control cannot', () => {
    const queue = twoRoundQueue();
    const record = buildFrozenRepairConvergenceGateHealth(queue, T0 + 2_000);
    const { scope } = projectFrozenRepairConvergenceCell(record);
    expect(scope.subject).toBe(queue.repairHead);
    expect(scope.summary).toContain(queue.repairHead.slice(0, 12));
    // The control: a count with no subject describes whatever sha the reader has in mind.
    expect(naiveScope.subject).toBeNull();
    expect(naiveScope.summary).not.toContain(queue.repairHead.slice(0, 12));
  });

  it('LOAD-BEARING: the scope BOUNDS the admission window instead of inventing an instant', () => {
    const record = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 9_000);
    const { scope } = projectFrozenRepairConvergenceCell(record);
    // The queue's own updatedAtMs is NOT carried in the stored record, so the honest answer is a
    // bound, not a timestamp. Both ends come from fields the record really has.
    expect(scope.admittedAtOrBeforeMs).toBe(record.observedAtMs);
    expect(scope.admittedAtOrAfterMs).toBe(record.openedAtMs);
    expect(scope.admittedAtOrAfterMs!).toBeLessThanOrEqual(scope.admittedAtOrBeforeMs!);
    expect(naiveScope.admittedAtOrBeforeMs).toBeNull();
  });

  it('LOAD-BEARING: the scope NAMES repairTickLegs.failingSignatures as incomparable', () => {
    // This is the exact 1-vs-2 disagreement that opened P-006. A scope that does not name the
    // sibling reading leaves the subtraction available.
    const record = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000);
    const { scope } = projectFrozenRepairConvergenceCell(record);
    const named = scope.notComparableTo.map((entry) => entry.reading);
    expect(named).toContain('gate_health.repairTickLegs.failingSignatures');
    for (const entry of scope.notComparableTo) expect(entry.why.length).toBeGreaterThan(40);
    expect(naiveScope.notComparableTo).toHaveLength(0);
  });

  it('LOAD-BEARING: the UNMEASURED branch carries a scope too, and it does not read as zero', () => {
    // The incomparability is structural, so it holds when there is no record at all. An
    // unmeasured cell whose scope is missing invites "nothing counted" to be read as
    // "nothing failing" — the exact false all-clear this plan exists to end.
    const cell = projectFrozenRepairConvergenceCell(null);
    expect(cell.unmeasured).toBe(true);
    expect(cell.failingNow).toBeNull();
    expect(cell.scope.population).toBe('nothing-counted');
    expect(cell.scope.summary).toContain('not zero');
    expect(cell.scope.notComparableTo.map((e) => e.reading)).toContain(
      'gate_health.repairTickLegs.failingSignatures',
    );
  });

  it('LOAD-BEARING: scope is DERIVED, never STORED — a stored blob without it still parses', () => {
    // D-004's hard constraint. If a later change persists the scope as a required field,
    // parseFrozenRepairConvergence rejects every pre-existing row and the cell silently drops to
    // unmeasured. This test goes red for exactly that drift, in both directions.
    const record = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000);
    expect(record).not.toHaveProperty('scope');
    const stored = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    expect(stored.scope).toBeUndefined();
    // The pre-existing-row case: a blob written before this change must still be readable, and
    // the reader must still get a scope for it.
    const parsed = parseFrozenRepairConvergence(stored);
    expect(parsed).not.toBeNull();
    expect(projectFrozenRepairConvergenceCell(parsed).scope.subject).toBe(record.repairHead);
  });

  it('the scope is a PURE function of the record — same record, same scope', () => {
    const record = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000);
    expect(projectFrozenRepairConvergenceScope(record)).toEqual(
      projectFrozenRepairConvergenceCell(record).scope,
    );
    expect(projectFrozenRepairConvergenceScope(null)).toEqual(
      projectFrozenRepairConvergenceCell(null).scope,
    );
  });
});

describe('P-005 attempt refunds for unproductive infrastructure fixer deaths', () => {
  it('refunds the attempt when the dead fixer provably never worked, and the retry is free', () => {
    const dispatched = markFrozenRepairFixerDispatched(fresh(), { spawnId: 's-1', nowMs: T0 + 1 });
    expect(dispatched.attempts).toBe(1);
    const dead = markFrozenRepairFixerDead(dispatched, {
      spawnId: 's-1',
      nowMs: T0 + 2,
      unproductiveInfrastructureDeath: { reason: 'zero tool invocations (status=failed)' },
    });
    expect(dead).toMatchObject({ attempts: 0, freeRetries: 1, fixerSpawnId: null });
    // the refunded queue re-dispatches as attempt 1 — the dead launch never counted
    expect(decideFrozenCandidateRepairQueue(dead, { nowMs: T0 + 3 })).toMatchObject({
      kind: 'dispatch-fixer',
      nextAttempt: 1,
    });
  });

  it('a death WITHOUT classification keeps the attempt burned (fail-closed default)', () => {
    const dispatched = markFrozenRepairFixerDispatched(fresh(), { spawnId: 's-1', nowMs: T0 + 1 });
    const dead = markFrozenRepairFixerDead(dispatched, { spawnId: 's-1', nowMs: T0 + 2 });
    expect(dead.attempts).toBe(1);
    expect(dead.freeRetries).toBeUndefined();
  });

  it('the refund budget bounds free retries; past it an infrastructure death burns again', () => {
    const limits = { ...DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS, maxFreeRetries: 1 };
    let queue = markFrozenRepairFixerDispatched(fresh(), { spawnId: 's-1', nowMs: T0 + 1 }, limits);
    queue = markFrozenRepairFixerDead(
      queue,
      { spawnId: 's-1', nowMs: T0 + 2, unproductiveInfrastructureDeath: { reason: 'no work' } },
      limits,
    );
    expect(queue).toMatchObject({ attempts: 0, freeRetries: 1 });
    queue = markFrozenRepairFixerDispatched(queue, { spawnId: 's-2', nowMs: T0 + 3 }, limits);
    queue = markFrozenRepairFixerDead(
      queue,
      { spawnId: 's-2', nowMs: T0 + 4, unproductiveInfrastructureDeath: { reason: 'no work' } },
      limits,
    );
    // budget spent: the second infrastructure death is NOT refunded
    expect(queue).toMatchObject({ attempts: 1, freeRetries: 1 });
  });

  it('never refunds below zero attempts, even on a hand-built inconsistent queue', () => {
    const crafted: FrozenCandidateRepairQueue = {
      ...fresh(),
      attempts: 0,
      fixerSpawnId: 'ghost',
    };
    const dead = markFrozenRepairFixerDead(crafted, {
      spawnId: 'ghost',
      nowMs: T0 + 2,
      unproductiveInfrastructureDeath: { reason: 'no work' },
    });
    expect(dead.attempts).toBe(0);
    expect(dead.freeRetries).toBeUndefined();
  });

  it('refunded infrastructure deaths cannot exhaust the attempt budget within the refund window', () => {
    // three dispatch→infra-death cycles under maxAttempts:3 — with refunds, the queue is
    // still only 1 attempt deep after the wave that used to exhaust it (D-001: 130/130)
    let queue = fresh();
    for (let i = 0; i < 3; i += 1) {
      queue = markFrozenRepairFixerDispatched(queue, { spawnId: `s-${i}`, nowMs: T0 + 10 + i });
      queue = markFrozenRepairFixerDead(queue, {
        spawnId: `s-${i}`,
        nowMs: T0 + 11 + i,
        unproductiveInfrastructureDeath: { reason: 'provider capacity' },
      });
    }
    expect(queue).toMatchObject({ attempts: 0, freeRetries: 3 });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 20 })).toMatchObject({
      kind: 'dispatch-fixer',
      nextAttempt: 1,
    });
  });

  it('parser round-trips freeRetries and drops malformed/zero values as absent', () => {
    const dispatched = markFrozenRepairFixerDispatched(fresh(), { spawnId: 's-1', nowMs: T0 + 1 });
    const refunded = markFrozenRepairFixerDead(dispatched, {
      spawnId: 's-1',
      nowMs: T0 + 2,
      unproductiveInfrastructureDeath: { reason: 'no work' },
    });
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(refunded)))).toMatchObject({
      freeRetries: 1,
    });
    for (const bad of [-1, 1.5, 'two', null, 0]) {
      const row = { ...JSON.parse(JSON.stringify(refunded)), freeRetries: bad };
      const parsed = parseFrozenCandidateRepairQueue(row);
      expect(parsed).not.toBeNull();
      expect(parsed?.freeRetries).toBeUndefined();
    }
    // legacy row (field absent) parses as before
    const legacy = JSON.parse(JSON.stringify(dispatched));
    delete legacy.freeRetries;
    expect(parseFrozenCandidateRepairQueue(legacy)?.freeRetries).toBeUndefined();
  });

  it('assertLimits rejects a malformed maxFreeRetries when provided', () => {
    expect(() =>
      markFrozenRepairFixerDispatched(
        fresh(),
        { spawnId: 's-1', nowMs: T0 + 1 },
        { ...DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS, maxFreeRetries: -1 },
      ),
    ).toThrow(/maxFreeRetries/);
  });
});

describe('WI-10000741 / D-014 — a red measured behind a mid-suite admission is RECORDED, not discarded', () => {
  /**
   * The row as the gate re-reads it AFTER an hour-long suite that judged `C`: while the suite
   * ran, a peer admitted a fix through `release:repair-queue { op:'admit' }`, so the persisted
   * row's repairHead is C1 (ready-to-verify, one ledger entry) — the run's red is for a head
   * the row no longer carries.
   */
  function admittedDuringSuite(): FrozenCandidateRepairQueue {
    return markFrozenRepairAdmitted(
      { ...fresh(), phase: 'ready-to-verify', attempts: 1, fixerSpawnId: 'spawn-1' },
      {
        atMs: T0 + 500,
        actor: 'su-peer',
        source: { ref: 'staging', sha: C1 },
        fromRepairHead: C,
        toRepairHead: C1,
        paths: ['lib/a.ts'],
        unchanged: [],
        blobs: {},
      },
    );
  }

  it('appends a convergence round AT THE MEASURED HEAD with the fresh failing-set size', () => {
    const queue = admittedDuringSuite();
    const next = recordFrozenRepairSupersededRed(queue, {
      measuredHead: C,
      failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
      nowMs: T0 + 1_000,
    });
    // P-007 (#D-040): measured at the candidate, so su-peer's later admission is NOT blamed.
    expect(next.convergenceRounds).toEqual([
      { round: 1, head: C, failingCount: 1, failingTests: ['lib/a.test.ts'], atMs: T0 },
      { round: 2, head: C, failingCount: 2, failingTests: ['lib/a.test.ts', 'lib/b.test.ts'], atMs: T0 + 1_000, attributions: [{ entry: 'test-file:lib/b.test.ts', basis: 'none', admissions: [] }] },
    ]);
    expect(next.failingTests).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(next.signature?.map((entry) => entry.id)).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    // Every signature entry says WHERE it was measured — the superseded head, never the newer one.
    expect(next.signature?.every((entry) => entry.measuredHead === C)).toBe(true);
    expect(next.updatedAtMs).toBe(T0 + 1_000);
  });

  it('reports a manual-lineage trend when no automated fixer was dispatched', () => {
    const manualAdmission = markFrozenRepairAdmitted(
      { ...fresh(), phase: 'ready-to-verify', attempts: 0, fixerSpawnId: null },
      {
        atMs: T0 + 500,
        actor: 'su-manual',
        source: { ref: 'staging', sha: C1 },
        fromRepairHead: C,
        toRepairHead: C1,
        paths: ['lib/a.ts'],
        unchanged: [],
        blobs: {},
      },
    );
    const recorded = recordFrozenRepairSupersededRed(manualAdmission, {
      measuredHead: C,
      failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
      nowMs: T0 + 1_000,
    });
    const cell = projectFrozenRepairConvergenceCell(
      buildFrozenRepairConvergenceGateHealth(recorded, T0 + 2_000),
    );

    expect(recorded.attempts).toBe(0);
    expect(cell).toMatchObject({
      unmeasured: false,
      admissionRounds: 2,
      converging: false,
      code: 'not-converging',
    });
  });

  it("leaves everything the admission owns untouched: phase, repairHead, admissions, fixer fields, attempts", () => {
    const queue = admittedDuringSuite();
    const next = recordFrozenRepairSupersededRed(queue, {
      measuredHead: C,
      failingTests: ['lib/a.test.ts'],
      nowMs: T0 + 1_000,
    });
    expect(next.phase).toBe('ready-to-verify');
    expect(next.repairHead).toBe(C1);
    expect(next.admissions).toEqual(queue.admissions);
    expect(next.admissions).toHaveLength(1);
    expect(next.fixerSpawnId).toBe(queue.fixerSpawnId);
    expect(next.attempts).toBe(queue.attempts);
    expect(next.candidate).toBe(C);
    // The CONTROL: the same measurement recorded as the row's own verdict DOES move the phase —
    // that is the difference between "record the legs" and "overwrite the admission".
    const asVerdict = markFrozenRepairVerificationRed(
      { ...queue, repairHead: C },
      { repairHead: C, failingTests: ['lib/a.test.ts'], nowMs: T0 + 1_000 },
    );
    expect(asVerdict.phase).toBe('awaiting-fixer');
    expect(next.phase).not.toBe(asVerdict.phase);
  });

  it('the newer head still reads as AWAITING verification — the recorded round is at the old head, not at it', () => {
    const queue = admittedDuringSuite();
    expect(frozenRepairHeadAwaitsVerification(queue)).toBe(true);
    const next = recordFrozenRepairSupersededRed(queue, {
      measuredHead: C,
      failingTests: ['lib/a.test.ts'],
      nowMs: T0 + 1_000,
    });
    expect(frozenRepairHeadAwaitsVerification(next)).toBe(true);
    expect(next.convergenceRounds?.some((round) => round.head === C1)).toBe(false);
  });

  it('the recorded round feeds the convergence summary like any other red', () => {
    const queue = admittedDuringSuite();
    const next = recordFrozenRepairSupersededRed(queue, {
      measuredHead: C,
      failingTests: [],
      nowMs: T0 + 1_000,
    });
    const summary = summarizeFrozenRepairConvergence(next, T0 + 2_000);
    expect(summary.admissionRounds).toBe(2);
    expect(summary.failingFirst).toBe(1);
    expect(summary.failingNow).toBe(0);
  });

  it('refuses a head that is NOT superseded — that verdict belongs to markFrozenRepairVerificationRed', () => {
    const queue = { ...fresh(), phase: 'ready-to-verify' as const };
    expect(queue.repairHead).toBe(C);
    expect(() =>
      recordFrozenRepairSupersededRed(queue, { measuredHead: C, failingTests: ['lib/a.test.ts'], nowMs: T0 + 1 }),
    ).toThrow(/not superseded/);
  });

  it('refuses a blank measured head and a bad timestamp', () => {
    const queue = admittedDuringSuite();
    expect(() =>
      recordFrozenRepairSupersededRed(queue, { measuredHead: '  ', failingTests: [], nowMs: T0 + 1 }),
    ).toThrow(/measuredHead/);
    expect(() =>
      recordFrozenRepairSupersededRed(queue, { measuredHead: C, failingTests: [], nowMs: Number.NaN }),
    ).toThrow(/nowMs/);
  });
});

describe('settleFrozenRepairAdmission — what a missed door write means (WI-10006866)', () => {
  // The door's entry: hunk-exact, wall-clock atMs, built onto the fresh queue's head C.
  const door = {
    atMs: T0 + 10, actor: 'su-door', source: { ref: 'staging', sha: C1 },
    fromRepairHead: C, toRepairHead: C2, paths: ['lib/a.test.ts'], unchanged: [],
    blobs: { 'lib/a.test.ts': C1 }, mode: 'hunk-exact' as const,
  };
  // What a concurrent repair-queue read writes when it reconciles the row from the ref:
  // no mode, the synthetic 2000-01-01 commit date, provenance stamped.
  const reconciled = {
    atMs: 946_684_800_000, actor: 'su-door', source: { ref: 'staging', sha: C1 },
    fromRepairHead: C, toRepairHead: C2, paths: ['lib/a.test.ts'], unchanged: [],
    blobs: { 'lib/a.test.ts': C1 }, provenance: 'reconciled-from-ref' as const,
  };

  it('adopts a reconciled rebuild of the SAME admission: persisted, door entry replaces it', () => {
    // The measured 2026-10-06 shape: the row is already at the admission because a reader
    // reconciled it; the door's CAS missed. Retracting here is what created ref-behind-row.
    const row = { ...markFrozenRepairAdmitted(fresh(), reconciled), updatedAtMs: T0 + 1 };
    const out = settleFrozenRepairAdmission(row, door);
    expect(out.kind).toBe('adopt-reconciled');
    expect(out.queue?.repairHead).toBe(C2);
    expect(out.queue?.admissions).toHaveLength(1);
    expect(out.queue?.admissions?.[0]).toEqual(door);
    expect(out.queue?.admissions?.[0]).not.toHaveProperty('provenance');
    expect(out.queue?.updatedAtMs).toBeGreaterThanOrEqual(door.atMs);
    expect(out.queue?.lastAdmittedAtMs).toBe(door.atMs);
    // The writer persists JSON, so the settled row must survive a parse round trip.
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(out.queue)))?.repairHead).toBe(C2);
  });

  it('a row that already carries the door entry is recorded, and returns the fresh row ITSELF (no write)', () => {
    const row = markFrozenRepairAdmitted(fresh(), door);
    const out = settleFrozenRepairAdmission(row, door);
    expect(out.kind).toBe('recorded');
    expect(out.queue).toBe(row);
  });

  it('a row still at the parent (an unrelated writer won the CAS) gets the admission applied', () => {
    const row = { ...fresh(), updatedAtMs: T0 + 5 };
    const out = settleFrozenRepairAdmission(row, door);
    expect(out.kind).toBe('apply');
    expect(out.queue?.repairHead).toBe(C2);
    expect(out.queue?.admissions?.at(-1)).toEqual(door);
  });

  it('diverged rows are NOT reported as persisted: another head, an unledgered head, another parent', () => {
    const elsewhere = { ...fresh(), repairHead: C1 };
    expect(settleFrozenRepairAdmission(elsewhere, door)).toMatchObject({ kind: 'diverged', queue: null });
    const unledgered = { ...markFrozenRepairAdmitted(fresh(), door), admissions: [] };
    expect(settleFrozenRepairAdmission(unledgered, door)).toMatchObject({ kind: 'diverged', queue: null });
    const otherParent = markFrozenRepairAdmitted({ ...fresh(), repairHead: C1 }, { ...reconciled, fromRepairHead: C1 });
    expect(settleFrozenRepairAdmission(otherParent, door)).toMatchObject({ kind: 'diverged', queue: null });
  });
});

describe('WI-6554700010018209: a candidate red after a mid-suite admission belongs to the candidate', () => {
  const readyToTest = () => createFrozenCandidateQueue({ candidate: C, base: BASE, nowMs: T0 });
  const admitDuringSuite = (queue: FrozenCandidateRepairQueue) =>
    markFrozenRepairAdmitted(queue, {
      atMs: T0 + 1_000,
      actor: 'su-fixer',
      source: { ref: 'staging', sha: C1 },
      fromRepairHead: C,
      toRepairHead: C1,
      paths: ['tests/host-smoke.test.ts'],
      unchanged: [],
      blobs: { 'tests/host-smoke.test.ts': 'blob-fix' },
    });

  it('records the round and signature at the candidate and leaves the admitted head to verification', () => {
    const admitted = admitDuringSuite(readyToTest());
    expect(admitted.phase).toBe('ready-to-test');
    expect(admitted.repairHead).toBe(C1);

    const red = markFrozenCandidateVerificationRed(admitted, {
      failingTests: ['tests/host-smoke.test.ts'],
      nowMs: T0 + 2_000,
    });

    expect(red.phase).toBe('ready-to-verify');
    expect(red.repairHead).toBe(C1);
    expect(red.candidate).toBe(C);
    expect(red.convergenceRounds?.map((r) => r.head)).toEqual([C]);
    expect(red.signature?.length).toBeGreaterThan(0);
    expect(red.signature?.every((entry) => entry.measuredHead === C)).toBe(true);
    expect(red.retestRequested?.repairHead).toBe(C1);
    expect(red.fixerStateChangedAtMs).toBe(admitted.fixerStateChangedAtMs);
    expect(red.lastVerdictAtMs).toBe(T0 + 2_000);
  });

  it('with no admission the candidate red still dispatches the fixer at the candidate', () => {
    const red = markFrozenCandidateVerificationRed(readyToTest(), {
      failingTests: ['tests/host-smoke.test.ts'],
      nowMs: T0 + 2_000,
    });
    expect(red.phase).toBe('awaiting-fixer');
    expect(red.repairHead).toBe(C);
    expect(red.convergenceRounds?.map((r) => r.head)).toEqual([C]);
    expect(red.fixerStateChangedAtMs).toBe(T0 + 2_000);
  });
});

describe('WI-6554700010019177 — frozenRepairAdmissionHandoffBlock mirrors the admission handoff guard', () => {
  const head = 'c'.repeat(40);
  const queueWith = (qualificationAttemptId: string | null) => ({ qualificationAttemptId, repairHead: head });
  const present = (attemptId: string, phase: string) =>
    ({ status: 'present', transaction: { attemptId, phase, repairHead: head } }) as const;

  it('does not block a queue with no origin attempt: no handoff is written', () => {
    expect(frozenRepairAdmissionHandoffBlock(queueWith(null), present('live-1', 'running'))).toBeNull();
  });

  it('does not block when the stored transaction IS the origin, whatever its phase', () => {
    expect(frozenRepairAdmissionHandoffBlock(queueWith('origin-1'), present('origin-1', 'terminal'))).toBeNull();
    expect(frozenRepairAdmissionHandoffBlock(queueWith('origin-1'), present('origin-1', 'running'))).toBeNull();
  });

  it('does not block on an unreadable transaction: the write guard stays the authority', () => {
    expect(frozenRepairAdmissionHandoffBlock(queueWith('origin-1'), { status: 'unreadable', error: 'x' })).toBeNull();
  });

  it('blocks a live successor and tells the caller to wait for its verdict', () => {
    const block = frozenRepairAdmissionHandoffBlock(queueWith('origin-1-aaaa'), present('live-2-bbbb', 'running'));
    expect(block).toMatchObject({
      reason: 'qualification-attempt-mismatch',
      originAttemptId: 'origin-1-aaaa',
      transactionAttemptId: 'live-2-bbbb',
      transactionPhase: 'running',
      transactionRepairHead: head,
    });
    expect(block!.detail).toContain('records its verdict');
  });

  it('blocks a terminal non-origin attempt and a missing transaction, each with its own retry point', () => {
    expect(frozenRepairAdmissionHandoffBlock(queueWith('origin-1'), present('other-2', 'terminal'))!.detail)
      .toContain('re-stamps the origin');
    expect(frozenRepairAdmissionHandoffBlock(queueWith('origin-1'), { status: 'none' })).toMatchObject({
      transactionAttemptId: null,
      detail: expect.stringContaining('no qualification transaction is stored'),
    });
  });
});
