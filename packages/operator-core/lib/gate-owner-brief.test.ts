/**
 * gate-owner-brief.test.ts — gate-audit-hardening-2026-08-31 P-001.
 *
 * Pure-composition tests: every case is a value-in/value-out check on
 * `composeGateOwnerBrief`, no I/O. The deliberately-wrong control the falsifiability
 * discipline asks for is the STALLED case: a live holder plus a DEAD fixer must NOT
 * read as remediating — that misread is the measured ~5h gap the audit found.
 */

import { describe, expect, it } from 'vitest';
import { composeGateOwnerBrief, type GateOwnerBriefInput } from './gate-owner-brief';
import { projectFrozenRepairConvergenceCell } from './release/frozen-candidate-repair-queue';
import { buildTestPassReuseHealth } from './release/test-pass-reuse-report';

const NOW = 1_788_193_000_000;
const CANDIDATE = '1111111111111111111111111111111111111111';
const MAIN_PIN = '2222222222222222222222222222222222222222';
const STAGING_HEAD = '3333333333333333333333333333333333333333';

describe('owner brief test progress retrieval', () => {
  const failures: NonNullable<GateOwnerBriefInput['candidateFailures']> = {
    candidateSha: CANDIDATE, repairHeadSha: MAIN_PIN, filesJudged: 400,
    failingFileCount: 83, scope: 'Candidate affected radius only.', unavailable: null, truncated: true,
  };
  const progress = (overrides: Partial<GateOwnerBriefInput> = {}) => composeGateOwnerBrief({
    ...base, repairQueue: redQueue({ candidate: CANDIDATE, repairHead: MAIN_PIN }),
    candidateFailures: failures, ...overrides,
  }).testProgress;
  const convergence = () => projectFrozenRepairConvergenceCell({
    openedAtMs: NOW - 60_000, ageMs: 60_000, attempts: 2, admissionRounds: 2,
    failingFirst: 9, failingNow: 3, shrinkTotal: 6,
    shrinkPerRound: [{ round: 1, failingCount: 9, delta: null }, { round: 2, failingCount: 3, delta: -6 }],
    converging: true, candidate: CANDIDATE, repairHead: MAIN_PIN,
    phase: 'awaiting-fixer', observedAtMs: NOW - 10_000,
  });

  it('keeps aggregate file counts exact when rendered details are truncated, without inventing a case total', () => {
    const p = progress();
    expect(p.candidateFiles).toMatchObject({ value: 83, filesJudged: 400, detailsTruncated: true,
      unit: 'test-files', candidateSha: CANDIDATE, readAtMs: NOW, observedAtMs: null,
      observationTimeReason: expect.stringContaining('does not retain') });
    expect(p.fullSuiteFailingCases).toMatchObject({ value: null, status: 'not-measured', unit: 'test-cases' });
  });

  it('distinguishes measured zero from unavailable evidence', () => {
    expect(progress({ candidateFailures: { ...failures, failingFileCount: 0 } }).candidateFiles.value).toBe(0);
    expect(progress({ candidateFailures: null }).candidateFiles).toMatchObject({ value: null, status: 'unavailable' });
    expect(progress({ candidateFailures: { ...failures, unavailable: 'ledger unreadable' } }).candidateFiles.value).toBeNull();
  });

  it('returns the existing trend with its signature units and observation time', () => {
    expect(progress({ convergence: convergence() }).trend).toMatchObject({
      status: 'converging', baseline: 9, latest: 3, decrease: 6,
      unit: 'queue-failure-signatures', observedAtMs: NOW - 10_000,
    });
  });

  it('withholds aggregate counts from a different or unrecorded current subject', () => {
    for (const candidateFailures of [{ ...failures, candidateSha: STAGING_HEAD },
      { ...failures, repairHeadSha: STAGING_HEAD }]) {
      expect(progress({ candidateFailures }).candidateFiles).toMatchObject({
        status: 'incomparable', value: null, filesJudged: null,
        reason: expect.stringContaining('current frozen candidate'),
      });
    }
    expect(progress({ repairQueue: null }).candidateFiles).toMatchObject({ status: 'incomparable', value: null });
  });

  it('withholds a trend when the repair head or candidate differs', () => {
    const c = convergence();
    for (const changed of [{ ...c, repairHead: STAGING_HEAD }, { ...c, candidate: STAGING_HEAD }]) {
      expect(progress({ convergence: changed }).trend).toMatchObject({ status: 'incomparable', latest: null, rounds: [] });
    }
  });

  it('retains the latest timeout and does not treat an older decreasing series as a current count', () => {
    const p = progress({ convergence: convergence(),
      inconclusive: { status: 'deadline-exceeded', detail: 'three-hour ceiling', observedAtMs: NOW - 1_000 } });
    expect(p.trend).toMatchObject({ status: 'incomparable', baseline: null, latest: null });
    expect(p.lastAttempt).toMatchObject({ inconclusiveStatus: 'deadline-exceeded', detail: 'three-hour ceiling', observedAtMs: NOW - 1_000 });
  });

  it('reports missing reuse evidence as unknown rather than zero', () => {
    expect(progress().passReuse).toMatchObject({ status: 'not-recorded', selectedForReuse: null, consumerSkippedFiles: null });
  });

  it('exposes persisted selector decisions without promoting them to actual runner skips', () => {
    const reuse = buildTestPassReuseHealth(
      'TEST_PASS_REUSE_TOTAL tasks=1 candidates=20 reused=12 audited=1 minSavedTestMs=50 unmeasured=0',
      CANDIDATE, NOW - 5_000,
    );
    expect(reuse).not.toBeNull();
    expect(progress({ testPassReuse: reuse }).passReuse).toMatchObject({
      status: 'recorded', judgedSha: CANDIDATE, recordedAtMs: NOW - 5_000,
      selectedForReuse: 12, candidates: 20, consumerSkippedFiles: null,
    });
  });
});

const heldLiveOwnership = {
  claimState: 'held',
  takenBy: 'su-40d60b0c-5441-431f-959c-7d3c196b534a',
  workItem: 'WI-212675',
  assessment: 'held-live',
} as unknown as GateOwnerBriefInput['ownership'];

/**
 * The EI-22123840107491540 shape: held, but the presence oracle can only say
 * `suspect`/`draining` — neither alive nor dead. `held-needs-confirmation` used to be
 * counted as a live hold here, which is why a stranded gate could never surface as
 * anything but owned-and-being-worked.
 */
const heldUnconfirmedOwnership = {
  claimState: 'held',
  takenBy: 'su-respawn-b353b06382f5752cbb0b9b781e91be86',
  workItem: 'WI-212675',
  assessment: 'held-needs-confirmation',
} as unknown as GateOwnerBriefInput['ownership'];

const claimableOwnership = {
  claimState: 'claimable',
  takenBy: null,
  workItem: 'WI-212675',
  assessment: 'claimable',
} as unknown as GateOwnerBriefInput['ownership'];

const base: GateOwnerBriefInput = {
  nowMs: NOW,
  consecutiveReds: 0,
  failingTests: [],
  failingTestsMeasured: true,
  failingTestsProvenance: 'measured',
  mainBehindStaging: false,
  promotion: {
    judgedSha: CANDIDATE,
    mainPin: CANDIDATE,
    mainContainsJudgedSha: true,
    stagingHead: CANDIDATE,
    stagingContainsMainPin: true,
    stagingContainsJudgedSha: true,
    stagingBufferPresent: false,
  },
  lastGreenAtMs: NOW - 60_000,
  verdictObservedAtMs: NOW - 30_000,
  fireStale: false,
  verdictStale: false,
  inconclusive: null,
  repairQueue: null,
  ownership: heldLiveOwnership,
};

const redQueue = (over: Partial<NonNullable<GateOwnerBriefInput['repairQueue']>> = {}) => ({
  frozenCandidate: CANDIDATE,
  candidate: CANDIDATE,
  repairHead: MAIN_PIN,
  phase: 'awaiting-fixer',
  openedAtMs: NOW - 3_600_000,
  admissions: [],
  signature: [],
  legs: [],
  blockedReason: null,
  verdictProvenance: null,
  attempts: 1,
  updatedAtMs: NOW - 120_000,
  ageMs: 3_600_000,
  fixerSpawnId: 's-123',
  fixerAlive: true,
  zeroAttemptStalled: false,
  ...over,
});

describe('composeGateOwnerBrief', () => {
  it('answers green when the gate is green and current, with no whyNot leg', () => {
    const b = composeGateOwnerBrief(base);
    expect(b.answer).toBe('green');
    expect(b.assessment.code).toBe('green');
    expect(b.mainGreen.value).toBe(true);
    expect(b.whyNot).toBeNull();
  });

  it('D-013: a promoted judged SHA stays green while staging has an ordinary post-absorption buffer', () => {
    const b = composeGateOwnerBrief({
      ...base,
      mainBehindStaging: true,
      promotion: {
        judgedSha: CANDIDATE,
        mainPin: MAIN_PIN,
        mainContainsJudgedSha: true,
        stagingHead: STAGING_HEAD,
        stagingContainsMainPin: true,
        stagingContainsJudgedSha: true,
        stagingBufferPresent: true,
      },
    });
    expect(b.answer).toBe('green');
    expect(b.promotion.mainContainsJudgedSha).toBe(true);
    expect(b.promotion.staging).toMatchObject({
      bufferPresent: true,
      relation: 'ahead-after-absorption',
    });
    expect(b.mainGreen.value).toBe(true);
    expect(b.whyNot).toBeNull();
  });

  it('D-013: green-not-promoted is reachable only from exact judged-SHA promotion evidence', () => {
    const b = composeGateOwnerBrief({
      ...base,
      mainBehindStaging: false,
      promotion: {
        judgedSha: CANDIDATE,
        mainPin: MAIN_PIN,
        mainContainsJudgedSha: false,
        stagingHead: MAIN_PIN,
        stagingContainsMainPin: true,
        stagingContainsJudgedSha: false,
        stagingBufferPresent: false,
      },
    });
    expect(b.answer).toBe('green-not-promoted');
    expect(b.assessment.safeAction).toMatch(/frozen-lineage promotion/i);
  });

  it('P-005: a missing promotion measurement is named instead of guessed', () => {
    const b = composeGateOwnerBrief({ ...base, mainBehindStaging: null, promotion: null });
    expect(b.answer).toBe('green');
    expect(b.unknownLegs.map((l) => l.leg)).toContain('promotion.mainContainsJudgedSha');
  });

  it('P-011 exposes the frozen identity, admission ledger, signature lifecycle, phase and blocked reason', () => {
    const admission = {
      atMs: NOW - 20_000,
      actor: 'su-fixer',
      source: { ref: 'staging', sha: MAIN_PIN },
      fromRepairHead: CANDIDATE,
      toRepairHead: MAIN_PIN,
      paths: ['lib/a.test.ts'],
      unchanged: [],
      blobs: { 'lib/a.test.ts': 'blob-a' },
    };
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 2,
      repairQueue: redQueue({
        phase: 'blocked',
        admissions: [admission],
        blockedReason: 'attempts-exhausted',
        signature: [
          {
            kind: 'test-file',
            id: 'lib/a.test.ts',
            recipe: 'npm run test:file -- lib/a.test.ts',
            admittedRound: 1,
            measuredHead: CANDIDATE,
          },
          {
            kind: 'lint-leg',
            id: 'lint:tsc',
            recipe: 'npm run lint:tsc',
            admittedRound: 2,
            measuredHead: MAIN_PIN,
          },
        ],
        legs: [
          {
            id: 'lint:tsc',
            state: 'fixed',
            admittedRound: 2,
            admittedHead: MAIN_PIN,
            admittedAtMs: NOW - 20_000,
            lastMeasuredHead: STAGING_HEAD,
            lastMeasuredAtMs: NOW - 10_000,
            lastMeasuredRound: 3,
            failingRounds: 1,
            resolvedHead: STAGING_HEAD,
            resolvedAtMs: NOW - 10_000,
          },
        ],
      }),
    });

    expect(b.remediation).toMatchObject({
      frozenCandidate: CANDIDATE,
      repairHead: MAIN_PIN,
      phase: 'blocked',
      frozenSinceAtMs: NOW - 3_600_000,
      admissions: [admission],
      admissionsMeasured: true,
      blockedReason: 'attempts-exhausted',
      blockedReasonMeasured: true,
    });
    expect(b.remediation?.signature.map((entry) => entry.status)).toEqual([
      'red-at-candidate',
      'admitted-in-2',
    ]);
    expect(b.remediation?.legs[0]?.status).toBe(`green-at-${STAGING_HEAD}`);
  });

  it('not-judging outranks everything else when the gate is not firing', () => {
    const b = composeGateOwnerBrief({ ...base, fireStale: true, consecutiveReds: 7 });
    expect(b.answer).toBe('not-judging');
  });

  it('unmeasured counters answer unknown and name the missing leg', () => {
    const b = composeGateOwnerBrief({ ...base, consecutiveReds: null });
    expect(b.answer).toBe('unknown');
    expect(b.mainGreen.value).toBeNull();
    expect(b.unknownLegs.map((l) => l.leg)).toContain('verdict');
  });

  it('a red with no live holder is red-unowned — the pileup shape', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 79,
      failingTests: ['lint:tsc'],
      ownership: claimableOwnership,
    });
    expect(b.answer).toBe('red-unowned');
    expect(b.whyNot?.failingLegs).toEqual(['lint:tsc']);
    expect(b.ownership.assessmentCode).toBe('claimable');
  });

  it('a red with a live holder and a live fixer is red-owned-remediating', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 79,
      failingTests: ['lint:tsc'],
      repairQueue: redQueue(),
    });
    expect(b.answer).toBe('red-owned-remediating');
    expect(b.remediation?.fixerAlive).toBe(true);
  });

  it('a live holder with a DEAD fixer is red-owned-stalled, never remediating (the 5h-gap case)', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 79,
      failingTests: ['lint:tsc'],
      repairQueue: redQueue({ fixerAlive: false }),
    });
    expect(b.answer).toBe('red-owned-stalled');
  });

  it('zero-attempt stall also reads as stalled even when liveness is unmeasurable', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 12,
      repairQueue: redQueue({ fixerAlive: null, zeroAttemptStalled: true }),
    });
    expect(b.answer).toBe('red-owned-stalled');
    expect(b.unknownLegs.map((l) => l.leg)).toContain('remediation.fixerAlive');
  });

  // ── EI-22123840107491540: the cell must not report a live-looking hold for a
  // stranded gate. The measured case is reproduced exactly: ownership resolved to
  // `held-needs-confirmation` (holder `suspect`, no turn in 5h11m, two required wakes
  // absorbed) while the repair queue had never dispatched a fixer at all.
  it('an UNCONFIRMED holder with no fixer ever dispatched is red-owned-unconfirmed, not stalled or remediating', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 89,
      failingTests: ['lint:tsc'],
      ownership: heldUnconfirmedOwnership,
      repairQueue: redQueue({ attempts: 0, fixerSpawnId: null, fixerAlive: null, zeroAttemptStalled: true }),
    });
    expect(b.answer).toBe('red-owned-unconfirmed');
    // The two readings this used to collapse into. `red-owned-stalled` is the
    // dangerous one: its safeAction ends at "tell the holder / escalate", which is
    // exactly what the reporter did — twice — with no terminating branch left.
    expect(b.answer).not.toBe('red-owned-stalled');
    expect(b.answer).not.toBe('red-owned-remediating');
    // The answer must name the reclaim, or it is the same dead end in a new code.
    expect(b.assessment.safeAction).toMatch(/reclaim/i);
  });

  it('an UNCONFIRMED holder with a LIVE fixer still reads remediating — the new code stays narrow', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 4,
      ownership: heldUnconfirmedOwnership,
      repairQueue: redQueue({ fixerAlive: true }),
    });
    expect(b.answer).toBe('red-owned-remediating');
  });

  // Deliberately-wrong control: the ownership oracle's own liveness table
  // (`POSITIVELY_LIVE`) marks draining/suspect false, so a brief that treats
  // `held-needs-confirmation` as a live hold contradicts the module it reads from.
  // Pin the two together rather than trusting the two files to stay in step.
  it('does not treat an unconfirmed hold the same as a live one when remediation has stalled', () => {
    const stalled = { ...base, consecutiveReds: 30, repairQueue: redQueue({ fixerAlive: false }) };
    const live = composeGateOwnerBrief({ ...stalled, ownership: heldLiveOwnership });
    const unconfirmed = composeGateOwnerBrief({ ...stalled, ownership: heldUnconfirmedOwnership });
    expect(live.answer).not.toBe(unconfirmed.answer);
  });

  /*
   * FALSIFIABILITY CONTROL — kept permanently, per the tier-1 rule for a subject you
   * `import` (mutating the shared tree to prove a guard fails is the shape git-sync
   * commits by accident). `OLD_OWNED_LIVE_CODES` is the pre-EI-22123840107491540
   * classification verbatim; the control asserts it lands on the WRONG answer for the
   * measured input, and the calibration asserts the REAL subject lands on the right
   * one. Without the control, both tests above would also pass if the whole
   * `red-owned-unconfirmed` branch were deleted and the code simply never reached.
   */
  describe('falsifiability control: the pre-fix classification', () => {
    const OLD_OWNED_LIVE_CODES = new Set(['held-live', 'held-needs-confirmation']);
    const strandedInput = {
      ...base,
      consecutiveReds: 89,
      ownership: heldUnconfirmedOwnership,
      repairQueue: redQueue({ attempts: 0, fixerSpawnId: null, fixerAlive: null, zeroAttemptStalled: true }),
    };

    it('the OLD rule classifies the stranded holder as a live hold — the defect', () => {
      const code = (strandedInput.ownership as unknown as { assessment: string }).assessment;
      expect(OLD_OWNED_LIVE_CODES.has(code)).toBe(true);
    });

    it('CALIBRATION: the real subject reaches the stranded answer on that same input', () => {
      expect(composeGateOwnerBrief(strandedInput).answer).toBe('red-owned-unconfirmed');
    });
  });

  it('P-005: an inconclusive attempt at zero reds is no-verdict, never a manufactured red or green', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 0,
      failingTestsMeasured: false,
      failingTestsProvenance: 'not-measured',
      inconclusive: { status: 'repair-in-progress', detail: 'fixer dispatched', observedAtMs: NOW - 5_000 },
    });
    expect(b.answer).toBe('no-verdict');
    expect(b.answer).not.toBe('red-owned-remediating');
    expect(b.mainGreen.value).toBeNull();
    expect(b.whyNot?.inconclusiveStatus).toBe('repair-in-progress');
    expect(b.whyNot?.provenance).toBe('not-measured');
    expect(b.assessment.safeAction).toMatch(/clear the condition/i);
  });

  it('stamps every leg with a vintage and reports the spread between them', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 3,
      failingTests: ['lint:tsc'],
      verdictObservedAtMs: NOW - 600_000,
      repairQueue: redQueue({ updatedAtMs: NOW - 60_000 }),
    });
    expect(b.mainGreen.vintage.observedAtMs).toBe(NOW - 600_000);
    expect(b.mainGreen.vintage.ageMs).toBe(600_000);
    expect(b.ownership.vintage.observedAtMs).toBe(NOW);
    // spread = newest (ownership, NOW) − oldest (verdict, NOW-600s)
    expect(b.vintageSpreadMs).toBe(600_000);
    expect(b.lastGreen.ageMs).toBe(60_000);
  });

  /* ═══════════════════════════════════════════════════════════════════════════════
   * main-green-status-visible-2026-09-03 P-010 — per-leg attestations.
   *
   * The spread was already reported; what it structurally cannot say is WHICH leg is old,
   * which is the question a reader must answer before deciding which half of a mixed brief
   * to believe. The deliberately-wrong control here is the two-hour spread: it must NOT
   * read as `coherent`, and it must NAME the stale leg rather than leave a number to convert.
   * ══════════════════════════════════════════════════════════════════════════════ */

  it('names WHICH leg is stale, not merely that the legs disagree about when', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 3,
      failingTests: ['lint:tsc'],
      // The live 2026-09-03 shape: a ~2h-old verdict fused with a live ownership read.
      verdictObservedAtMs: NOW - 7_040_975,
      repairQueue: redQueue({ updatedAtMs: NOW - 60_000 }),
    });
    expect(b.attestations.verdict).toBe('incoherent');
    expect(b.attestations.staleLegs).toEqual(['mainGreen', 'promotion']);
    expect(b.attestations.oldestLeg).toBe('promotion');
    // The stale leg is named in prose too — the reader should not have to convert ms.
    expect(b.attestations.summary).toContain('mainGreen');
    // Newest first, so the tail IS an oldest leg. The verdict and promotion identity
    // share one gate_health timestamp; stable input order leaves promotion at the tail.
    expect(b.attestations.legs[0]!.leg).toBe('ownership');
    expect(b.attestations.legs.at(-1)!.leg).toBe('promotion');
    expect(b.attestations.legs.at(-1)!.stale).toBe(true);
  });

  it('a brief whose legs were all observed together reads coherent with no stale legs', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 3,
      failingTests: ['lint:tsc'],
      verdictObservedAtMs: NOW - 30_000,
      repairQueue: redQueue({ updatedAtMs: NOW - 45_000 }),
    });
    expect(b.attestations.verdict).toBe('coherent');
    expect(b.attestations.staleLegs).toEqual([]);
    expect(b.attestations.legs.every((l) => l.stale === false)).toBe(true);
  });

  /**
   * THE CONTROL THAT MATTERS. Fewer than two stamped legs means there is nothing to
   * compare, and `coherent` there would be a verdict of agreement computed over an empty
   * comparison — the same false-green shape as a count over zero measurements. It must be
   * `not-knowable`, and it must say so.
  */
  it('one stamped leg is NOT-KNOWABLE, never coherent — an empty comparison is not agreement', () => {
    const b = composeGateOwnerBrief({ ...base, verdictObservedAtMs: null, promotion: null });
    // Ownership is stamped at `nowMs` by construction; verdict and promotion evidence
    // are deliberately absent so this remains a real one-leg comparison.
    expect(b.attestations.legs.map((l) => l.leg)).toEqual(['ownership']);
    expect(b.attestations.spreadMs).toBeNull();
    expect(b.attestations.verdict).toBe('not-knowable');
    expect(b.attestations.summary).toContain('not agreement');
  });

  it('vintageSpreadMs and attestations.spreadMs are ONE derivation, so they cannot drift', () => {
    for (const verdictObservedAtMs of [NOW - 30_000, NOW - 600_000, NOW - 7_040_975, null]) {
      const b = composeGateOwnerBrief({
        ...base,
        consecutiveReds: 3,
        verdictObservedAtMs,
        repairQueue: redQueue({ updatedAtMs: NOW - 60_000 }),
      });
      expect(b.vintageSpreadMs).toBe(b.attestations.spreadMs);
    }
  });

  it('an unstamped leg contributes no attestation — it cannot attest to its own freshness', () => {
    const withQueue = composeGateOwnerBrief({ ...base, consecutiveReds: 3, repairQueue: redQueue() });
    const withoutQueue = composeGateOwnerBrief({ ...base, consecutiveReds: 3, repairQueue: null });
    expect(withQueue.attestations.legs.map((l) => l.leg)).toContain('remediation');
    expect(withoutQueue.attestations.legs.map((l) => l.leg)).not.toContain('remediation');
  });

  it('never claims measurement it does not have: an explicit not-measured list stays labelled', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 5,
      failingTests: ['lint:tsc'],
      failingTestsMeasured: false,
      failingTestsProvenance: 'not-measured',
    });
    expect(b.whyNot?.measured).toBe(false);
    expect(b.whyNot?.provenance).toBe('not-measured');
  });

  it('P-005: a carried list remains visible with provenance rather than reading as a fresh measurement', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 5,
      failingTests: ['lint:tsc'],
      failingTestsMeasured: null,
      failingTestsProvenance: 'carried',
      inconclusive: { status: 'repair-in-progress', detail: 'fixer dispatched', observedAtMs: NOW - 5_000 },
    });
    expect(b.whyNot).toMatchObject({
      failingLegs: ['lint:tsc'],
      measured: null,
      provenance: 'carried',
    });
  });
});

/**
 * main-green-status-visible-2026-09-03 P-007 — the brief must never read all-clear while a
 * NON-TEST leg is red. `failingTests` names test files only, so a gate red on a lint leg
 * alone composed `whyNot.failingLegs: []` beside a red answer: a red explained by nothing,
 * which a reader rounds to "nothing is actually failing".
 */
describe('P-007 — a red non-test leg never reads all-clear on the owner brief', () => {
  const redLeg = { measured: 'measured' as const, outstanding: ['lint:tsc'] };

  it('THE FALSIFIER: red gate, ZERO failing test files, one red lint leg — the leg is NAMED and the answer is red', () => {
    const b = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 3,
      failingTests: [],
      failingTestsMeasured: true,
      repairQueue: redQueue(),
      nonTestLegs: redLeg,
    });
    expect(b.answer).toBe('red-owned-remediating');
    expect(b.mainGreen.value).toBe(false);
    expect(b.whyNot).toMatchObject({
      failingLegs: [],
      failingNonTestLegs: ['lint:tsc'],
      nonTestLegsMeasured: 'measured',
    });
  });

  it('CONTROL: the same red with NO leg reading carries an empty list beside a null flag — never an unlabelled []', () => {
    const b = composeGateOwnerBrief({ ...base, consecutiveReds: 3, failingTests: [], repairQueue: redQueue() });
    expect(b.whyNot).toMatchObject({ failingNonTestLegs: [], nonTestLegsMeasured: null });
    const notRecorded = composeGateOwnerBrief({
      ...base,
      consecutiveReds: 3,
      failingTests: [],
      repairQueue: redQueue(),
      nonTestLegs: { measured: 'not-recorded', outstanding: [] },
    });
    expect(notRecorded.whyNot).toMatchObject({ failingNonTestLegs: [], nonTestLegsMeasured: 'not-recorded' });
  });

  it('a zero-red counter CONTRADICTED by a red leg answers unknown — never green — and names the contradiction', () => {
    const b = composeGateOwnerBrief({ ...base, nonTestLegs: redLeg });
    expect(b.answer).toBe('unknown');
    expect(b.mainGreen.value).toBeNull();
    expect(b.unknownLegs.map((l) => l.leg)).toContain('verdict');
    expect(b.unknownLegs.find((l) => l.leg === 'verdict')!.why).toMatch(/lint:tsc/);
    expect(b.whyNot?.failingNonTestLegs).toEqual(['lint:tsc']);
    // The deliberately wrong reading — the counter's half of the contradiction.
    expect(b.answer).not.toBe('green');
  });

  it('CALIBRATION: measured legs with nothing outstanding leave the green answer untouched', () => {
    const b = composeGateOwnerBrief({ ...base, nonTestLegs: { measured: 'measured', outstanding: [] } });
    expect(b.answer).toBe('green');
    expect(b.whyNot).toBeNull();
  });

  it('fireStale still outranks the leg contradiction (a producer that is not firing is the first fact)', () => {
    const b = composeGateOwnerBrief({ ...base, fireStale: true, nonTestLegs: redLeg });
    expect(b.answer).toBe('not-judging');
  });
});
