/**
 * P-019 (review-system-rework-reduction-2026-09-23, RSR-P-019-A): any-drags adequacy.
 *
 * The evaluator grades EVERY live binding at a clause revision, so one older weak, stale or
 * failing row fails a criterion beside newer sufficient proof. Measured on R-11: a fresh,
 * fully-flagged targeted mutation proof could not pass the bar until 13 older rows were
 * retracted by hand — and nothing in the verdict said WHICH rows. These tests pin both halves
 * of the fix on the evaluator side: the verdict names the dragging binding ids, and once the
 * dragging row is withdrawn (what plans:bind-spec-evidence supersedeAtRevision does) the
 * sufficient binding carries the clause. The store/tool half lives in
 * spec-evidence-store.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import {
  evaluateSpecTestAdequacy,
  LEDGER_PROOF_HINT,
  RETRACT_DRAGGING_SUGGESTION,
  supersedeEligibilityGaps,
  SUPERSEDE_DRAGGING_SUGGESTION,
  type SpecEvidenceForAdequacy,
} from './spec-test-adequacy';

const DRAG_SCENARIO = 'dragging-row-named';
// Since 39ce2b4152 a mutation/counterexample establishes falsifiability only when its run's
// canonical test file ALSO carries a successful current `test` binding to the clause
// (clauseBoundMutationTest pairs them by testRunProvenance.filePath). Every fixture row shares
// this path so the counterexample pairs with the fresh test row, as a real binding would.
const DRAG_TEST_PATH = 'packages/operator-core/lib/agent-tools/plans/drag-fixture.test.ts';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'drag-plan',
    specId: 'SPEC-DRAG-01',
    sourceValId: null,
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-019',
    behavior: 'Fresh sufficient proof carries the clause once the dragging row is withdrawn.',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: [],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    // Falsifiability links a mutation/counterexample to a DECLARED scenario
    // (EI-23935395295801259), so the fixture clause names the one it targets.
    falsifier: {
      observation: 'A sufficient current binding is dragged by an older row, or the failure names no binding.',
      requiredScenarios: [DRAG_SCENARIO],
    },
    contentHash: 'sha256:drag-v1',
    createdBy: 'su-test',
    createdAt: '2026-09-23T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-09-23T00:01:00.000Z',
    acceptanceRef: 'D-019',
    ...over,
  };
}

const CURRENT: SpecEvidenceForAdequacy['currentness'] = {
  comparisonSupplied: true,
  provenance: 'server-measured',
  overall: 'current',
  dimensions: {
    spec: 'current',
    source: 'current',
    test: 'current',
    fixture: 'current',
    rubric: 'current',
    environment: 'current',
    coverageEvidence: 'current',
    testRun: 'current',
  },
  staleReasons: [],
  unknownReasons: [],
};

const STALE: SpecEvidenceForAdequacy['currentness'] = {
  ...CURRENT,
  overall: 'stale',
  dimensions: { ...CURRENT.dimensions, source: 'stale' },
  staleReasons: ['sourceFingerprint mismatched'],
};

function row(
  id: number,
  over: Partial<SpecEvidenceForAdequacy> & { adequacy?: Record<string, unknown> } = {},
): SpecEvidenceForAdequacy {
  const { adequacy, ...rest } = over;
  const executionFailed = ['fail', 'failed'].includes(String(adequacy?.outcome ?? 'passed').toLowerCase());
  return {
    id,
    workItemId: 'WI-019',
    planSlug: 'drag-plan',
    specId: 'SPEC-DRAG-01',
    specRevision: 1,
    specFingerprint: 'sha256:drag-v1',
    evidenceKind: 'test',
    evidenceRef: `test-run:${id}`,
    fingerprints: {
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: 'sha256:drag-fixture',
      rubricFingerprint: null,
      environmentFingerprint: null,
    },
    coverageEvidenceRef: null,
    testRunId: 1000 + id,
    testRunExecution: {
      status: executionFailed ? 'fail' : 'pass',
      passed: executionFailed ? 0 : 1,
      failed: executionFailed ? 1 : 0,
      skipped: 0,
      collectionFailed: false,
      passedCaseTitles: executionFailed ? [] : ['dragging binding control'],
    },
    details: {
      adequacy: {
        falsifiable: true,
        testLayer: 'unit',
        pathReachable: true,
        oracleIndependent: true,
        // Positive controls carry the calibrated fixture used to synthesize these
        // ledger rows; binder-only fixtureFree cannot establish fixture absence.
        fixtureFree: false,
        fixtureCalibrated: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        targeted: DRAG_SCENARIO,
        scenarioIds: [DRAG_SCENARIO],
        testCases: ['dragging binding control'],
        coverageRungs: { l3: true },
        ...adequacy,
      },
    },
    testRunProvenance: { filePath: DRAG_TEST_PATH, commitSha: 'abc123', worktreeDirty: false },
    currentness: CURRENT,
    createdAt: `2026-09-23T00:00:${String(id).padStart(2, '0')}.000Z`,
    ...rest,
  };
}

const counterexample = (id: number) =>
  row(id, { evidenceKind: 'counterexample', evidenceRef: `counterexample:${id}`, adequacy: { outcome: 'pass' } });

// Since 076017374d a counterexample establishes execution-integrity only from a canonical
// mutation-probe MUTANT run that failed (the test caught the defect): measuredExecutionVerdict
// reads a plain counterexample whose run passed as 'unknown'. A positive control that must PASS
// therefore needs this ledger shape, not the binder-shaped `counterexample` above (WI-6554700010008377).
const killedCounterexample = (id: number): SpecEvidenceForAdequacy => {
  const base = row(id, { evidenceKind: 'counterexample', evidenceRef: `counterexample:${id}`, adequacy: { outcome: 'caught' } });
  return {
    ...base,
    testRunExecution: { status: 'fail', passed: 0, failed: 1, skipped: 0, collectionFailed: false, passedCaseTitles: [] },
    testRunProvenance: {
      ...base.testRunProvenance!,
      source: 'mutation-probe',
      mutationPhase: 'mutant',
      mutationFailedCaseTitles: ['dragging binding control'],
    },
  };
};

describe('any-drags adequacy names the dragging binding (P-019)', () => {
  it('keeps a killed counterexample unknown when its declared case is absent, but passes the matching control', () => {
    const negative = killedCounterexample(3);
    negative.testRunExecution = { ...negative.testRunExecution!, skipped: 1 };
    negative.testRunProvenance = {
      ...negative.testRunProvenance!,
      mutationFailedCaseTitles: ['unrelated case'],
    };
    const result = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [row(2), negative], classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['execution-integrity'].rating).toBe('unknown');
    expect(result.draggingBindingIds['execution-integrity']).toEqual([3]);
    expect(result.verdict).not.toBe('pass');

    // Only the measured failed title changes: the canonical mutant failed and skipped
    // another case in both runs. Case scope must distinguish this control from the gap.
    negative.testRunProvenance.mutationFailedCaseTitles = ['dragging binding control'];
    const matching = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [row(2), negative], classRef: 'plan-class-feature-ship',
    });
    expect(matching.ratings['execution-integrity'].rating).toBe('pass');
    expect(matching.verdict, JSON.stringify(Object.fromEntries(
      Object.entries(matching.ratings).map(([criterion, { rating }]) => [criterion, rating]),
    ))).toBe('pass');
  });

  it('names an older failing attempt as the row dragging execution-integrity, and the clause passes once it is withdrawn', () => {
    const olderFailing = row(1, { adequacy: { outcome: 'failed' } });
    const fresh = row(2);
    const negative = killedCounterexample(3);

    const dragged = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [olderFailing, fresh, negative],
      classRef: 'plan-class-feature-ship',
    });
    expect(dragged.ratings['execution-integrity'].rating).toBe('fail');
    expect(dragged.draggingBindingIds['execution-integrity']).toEqual([1]);
    // The fresh sufficient row is NOT named — only the row that actually drags.
    expect(Object.values(dragged.draggingBindingIds).flat(), JSON.stringify(Object.fromEntries(
      Object.entries(dragged.ratings).map(([criterion, { rating }]) => [criterion, rating]),
    ))).not.toContain(2);
    expect(dragged.ratings['execution-integrity'].evidence).toContain('id=1,');
    expect(dragged.ratings['execution-integrity'].suggestion).toContain(SUPERSEDE_DRAGGING_SUGGESTION);

    // Positive control on the same fixture: withdraw the dragging row (what
    // supersedeAtRevision does) and the one sufficient binding carries the clause.
    const repaired = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [fresh, negative],
      classRef: 'plan-class-feature-ship',
    });
    expect(repaired.ratings['execution-integrity'].rating).toBe('pass');
    expect(repaired.wouldBlock).toEqual([]);
    expect(repaired.verdict).toBe('pass');
    expect(repaired.draggingBindingIds).toEqual({});
  });

  it('names every stale row dragging freshness and points at a re-run when nothing current remains', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row(5, { currentness: STALE }), { ...counterexample(6), currentness: STALE }],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings.freshness.rating).toBe('fail');
    expect(result.draggingBindingIds.freshness).toEqual([5, 6]);
    expect(result.ratings.freshness.suggestion).toMatch(/^Re-run the stale proof/);
  });

  it('offers supersession for a stale row that sits beside a current sufficient one', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row(7, { currentness: STALE }), row(8), counterexample(9)],
      classRef: 'plan-class-feature-ship',
      // A supplied comparison input keeps every exact binding in the graded population.
      current: [],
    });
    expect(result.ratings.freshness.rating).toBe('fail');
    expect(result.draggingBindingIds.freshness).toEqual([7]);
    expect(result.ratings.freshness.suggestion).toBe(SUPERSEDE_DRAGGING_SUGGESTION);
  });

  // EI-25215634977268694: the measured case. Fresh live OPERATIONAL proof (no testRunId) was
  // re-bound with supersedeAtRevision beside stale operational rows; every bind returned ok,
  // supersession was refused, and freshness stayed failed until an explicit retract. The
  // suggestion must name the remedy that works, not the one the verb will refuse.
  it('names retract, not supersession, when the current sibling is not ledger-backed', () => {
    // The store sets testRunProvenance only when test_run_id is set, so an unbacked row has none.
    const unbacked = { evidenceKind: 'operational' as const, testRunId: null, testRunProvenance: undefined };
    const staleOps = row(11, { ...unbacked, evidenceRef: 'operational:11', currentness: STALE });
    const freshOps = row(12, { ...unbacked, evidenceRef: 'operational:12' });
    // Calibration: the fresh row really is ineligible under the bind verb's own rule.
    expect(supersedeEligibilityGaps(freshOps)).not.toEqual([]);
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [staleOps, freshOps],
      classRef: 'plan-class-feature-ship',
      current: [],
    });
    expect(result.ratings.freshness.rating).toBe('fail');
    expect(result.draggingBindingIds.freshness).toEqual([11]);
    expect(result.ratings.freshness.suggestion).toBe(RETRACT_DRAGGING_SUGGESTION);
    expect(RETRACT_DRAGGING_SUGGESTION).toContain('retract:[{ bindingId, reason }]');
  });

  it('names retract when the only eligible current sibling is a different evidenceKind', () => {
    // supersedeAtRevision retracts only rows of the superseding binding's own kind, so a
    // ledger-backed current `test` row cannot clear a stale `operational` row.
    const staleOps = row(13, {
      evidenceKind: 'operational',
      evidenceRef: 'operational:13',
      testRunId: null,
      testRunProvenance: undefined,
      currentness: STALE,
    });
    const freshTest = row(14);
    expect(supersedeEligibilityGaps(freshTest)).toEqual([]);
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [staleOps, freshTest],
      classRef: 'plan-class-feature-ship',
      current: [],
    });
    expect(result.draggingBindingIds.freshness).toEqual([13]);
    expect(result.ratings.freshness.suggestion).toBe(RETRACT_DRAGGING_SUGGESTION);
  });

  it('names no binding for a criterion blocked by absence', () => {
    const result = evaluateSpecTestAdequacy({ clause: clause(), evidence: [], classRef: 'plan-class-feature-ship' });
    expect(result.verdict).toBe('fail');
    expect(result.wouldBlock).toContain('traceability');
    expect(result.draggingBindingIds).toEqual({});
  });

  it('surfaces the ledger requirement, including where mutation-probe rows are listed, on a ledger-gated refusal', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row(10)],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.wouldBlock).toContain('falsifiability');
    expect(result.ratings.falsifiability.suggestion).toContain(LEDGER_PROOF_HINT);
    expect(LEDGER_PROOF_HINT).toContain("source:'mutation-probe'");
  });
});

describe('supersedeEligibilityGaps: only proof sufficient on its own may supersede (P-019)', () => {
  const adequacy = { collected: true, skipped: false, executed: true, outcome: 'passed' };

  it('accepts a successful ledger-backed executable binding', () => {
    expect(supersedeEligibilityGaps({
      evidenceKind: 'test',
      testRunId: 5,
      testRunExecution: { status: 'pass', passed: 1, failed: 0, skipped: 0, collectionFailed: false },
      details: { adequacy },
    })).toEqual([]);
  });

  it('does not treat binder pass metadata as the canonical test-run verdict', () => {
    expect(supersedeEligibilityGaps({ evidenceKind: 'test', testRunId: 5, details: { adequacy } })).toContain(
      'canonical test-run execution details unavailable',
    );
  });

  it.each([
    ['no ledger reference', { evidenceKind: 'test' as const, details: { adequacy } }, 'no testRunId/coverageEvidenceRef ledger reference'],
    ['a failing outcome', { evidenceKind: 'test' as const, testRunId: 5, details: { adequacy: { ...adequacy, outcome: 'failed' } } }, 'outcome="failed"'],
    ['a non-executable kind', { evidenceKind: 'manual' as const, testRunId: 5, details: { adequacy } }, 'evidenceKind=manual is not executable'],
    ['falsifiable=false', { evidenceKind: 'test' as const, testRunId: 5, details: { adequacy: { ...adequacy, falsifiable: false } } }, 'falsifiable=false'],
    ['a disclosed gap', { evidenceKind: 'test' as const, testRunId: 5, details: { adequacy: { ...adequacy, disclosedGap: ['no e2e'] } } }, 'an author-disclosed gap is recorded'],
  ])('refuses %s', (_label, binding, expectedGap) => {
    expect(supersedeEligibilityGaps(binding)).toContain(expectedGap);
  });
});
