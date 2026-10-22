/**
 * plan-spec-coverage-gate.test.ts — the plan-ship spec-coverage aggregate and the
 * proof-freshness refusal
 * (first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20 P-008).
 *
 * The headline case is P-008's own acceptance sentence, and it is asserted in BOTH
 * directions in one test: a spec revision recorded after green evidence BLOCKS
 * shipping, and re-proving at the current revision UNBLOCKS it. Asserting only the
 * refusal would leave "until current proof exists" unproven, which is the half that
 * makes the gate escapable rather than a wall.
 *
 * Two further tests are deliberate SCOPE guards rather than behaviour coverage. They
 * pin the boundaries this gate was built inside, so a later widening has to be a
 * deliberate act that updates a test naming the ruling, not a quiet edit:
 *   · "REPORTS an enforceable clause with no evidence without refusing" — D-018/D-013
 *     leave enforcement widening to P-013.
 *   · "withholds the refusal when the evidence census is truncated" — the repo's
 *     bounded-measurement rule; a floor must never be rendered as a verdict.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ADEQUACY_CENSUS_CLAUSE_LIMIT,
  SPEC_EVIDENCE_CENSUS_LIMIT,
  computePlanSpecCoverage,
  evaluatePlanSpecCoverageGate,
  type PlanSpecCoverageDeps,
  type SpecEvidenceCensusRow,
} from './plan-spec-coverage-gate';
import type { SpecClauseRevision } from './spec-clauses-store';
import type { ScorecardRow } from '../../scorecards';

const PLAN = 'first-class-spec-clauses-2026-08-20';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: PLAN,
    specId: 'SPEC-1',
    sourceValId: null,
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'the gate refuses a stale proof',
    behaviorClass: 'failure',
    requiredEvidence: [],
    requiredTestLayers: [],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: { observation: 'a ship succeeds while the clause is proven only at r1' },
    contentHash: 'hash-1',
    createdBy: 'su-author',
    createdAt: '2026-08-20T00:00:00Z',
    acceptedBy: null,
    acceptedAt: null,
    acceptanceRef: null,
    ...over,
  };
}

/**
 * One evidence row as the census reads it.
 *
 * `evidenceKind` and `observedAt` are REQUIRED by `SpecEvidenceCensusRow` (P-013) and
 * are supplied here rather than defaulted away: the composition and staleness
 * partitions are derived from exactly these two fields, so a fixture that omitted them
 * would produce a partition keyed on `undefined` that still "passes" every count
 * assertion. Overridable so a test can state the kind or the timestamp it is exercising.
 */
function evidence(
  specId: string,
  specRevision: number,
  over: Partial<SpecEvidenceCensusRow> = {},
): SpecEvidenceCensusRow {
  return {
    specId,
    specRevision,
    evidenceKind: 'test',
    observedAt: '2026-08-20T01:00:00.000Z',
    ...over,
  };
}

function adequacyCard(subjectRef: string, over: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'EI-adequacy',
    createdAt: '2026-08-20T02:00:00Z',
    createdBy: 'su-grader',
    rubricRef: 'spec-test-adequacy',
    rubricCurrentness: {
      state: 'current', reason: 'current', recordedRevision: 1, currentRevision: 1,
      recordedCriteriaHash: 'criteria-hash-v1', currentCriteriaHash: 'criteria-hash-v1',
    },
    subject: { kind: 'plan', ref: subjectRef },
    ratings: { traceability: { rating: 'pass', evidence: 'covered' } },
    nKeys: 1,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    score10: 10,
    linkedItems: [],
    ...over,
  } as ScorecardRow;
}

/** Deps with every leg empty; individual tests override only what they exercise. */
function deps(over: Partial<PlanSpecCoverageDeps> = {}): PlanSpecCoverageDeps {
  return {
    listClauses: vi.fn(async () => [] as SpecClauseRevision[]),
    listEvidence: vi.fn(async () => [] as SpecEvidenceCensusRow[]),
    listCards: vi.fn(async () => [] as ScorecardRow[]),
    // ⚠ MUST be stubbed, and must default to an ENFORCING status.
    //
    // The real reader hits the database, and this gate deliberately catches a read failure
    // and degrades to non-enforcing (a status blip must not freeze every ship). Both
    // halves are correct, and together they mean an unstubbed dep here does not throw — it
    // SILENTLY TURNS ENFORCEMENT OFF, and every refusal assertion in this file passes for
    // the wrong reason while proving nothing. That is a fail-open no typecheck can see, so
    // the stub is the guard.
    readPlanStatuses: vi.fn(
      async (input: { harnessSlug?: string; planSlugs: string[] }): Promise<Map<string, string>> =>
        new Map(input.planSlugs.map((slug) => [slug, 'active'])),
    ),
    ...over,
  };
}

describe('evaluatePlanSpecCoverageGate — proof freshness', () => {
  it('keeps delivery gaps visible while reviewing exact validated manual clause pins', async () => {
    const delivery = clause({ specId: 'DELIVERY', revision: 2, currentRevision: 2, contentHash: 'delivery-2' });
    const pendingDeliveryReview = { phase: 'pre-grading' as const, applicable: true, satisfied: true,
      pendingDeliverySpecClauses: [{ planSlug: PLAN, specId: 'DELIVERY', specRevision: 2,
        specContentHash: 'delivery-2' }] };
    const inputs = deps({ listClauses: vi.fn(async () => [delivery]) });
    const input = { harnessSlug: 'papercusp', planSlug: PLAN, pendingDeliveryReview };
    const review = await evaluatePlanSpecCoverageGate(input, inputs);
    expect(review).toMatchObject({ satisfied: true, aggregate: {
      coverage: { proven: 0, unproven: 1 }, pendingDeliverySpecIds: ['DELIVERY'],
    } });
    expect(review.reports).toContain('pending-delivery-review:DELIVERY');
    expect(await evaluatePlanSpecCoverageGate({ planSlug: PLAN }, inputs))
      .toMatchObject({ satisfied: false, code: 'spec_clause_unproven' });
    inputs.listEvidence = vi.fn(async () => [evidence('DELIVERY', 1)]);
    expect(await evaluatePlanSpecCoverageGate(input, inputs)).toMatchObject({ satisfied: true,
      aggregate: { coverage: { staleProof: 1, proven: 0 } } });
    expect(await evaluatePlanSpecCoverageGate({ planSlug: PLAN }, inputs))
      .toMatchObject({ satisfied: false, code: 'spec_proof_stale' });
    inputs.listClauses = vi.fn(async () => [delivery, clause({ specId: 'CODE' })]);
    expect(await evaluatePlanSpecCoverageGate(input, inputs)).toMatchObject({ satisfied: false,
      code: 'spec_clause_unproven', aggregate: { coverage: { unprovenSpecIds: ['CODE'] } } });
  });

  it.each(['revision', 'fingerprint', 'plan', 'phase', 'blocked'])(
    'does not defer a delivery clause with a mismatched %s', async (mismatch) => {
      const pin = { planSlug: PLAN, specId: 'DELIVERY', specRevision: 1, specContentHash: 'hash-1' };
      const pendingDeliveryReview = { phase: 'pre-grading' as 'pre-grading' | 'ship',
        applicable: true, satisfied: true, pendingDeliverySpecClauses: [pin] };
      if (mismatch === 'revision') pin.specRevision = 2;
      if (mismatch === 'fingerprint') pin.specContentHash = 'another-meaning';
      if (mismatch === 'plan') pin.planSlug = 'another-plan';
      if (mismatch === 'phase') pendingDeliveryReview.phase = 'ship';
      if (mismatch === 'blocked') pendingDeliveryReview.satisfied = false;
      expect(await evaluatePlanSpecCoverageGate({ planSlug: PLAN, pendingDeliveryReview },
        deps({ listClauses: vi.fn(async () => [clause({ specId: 'DELIVERY' })]) })))
        .toMatchObject({ satisfied: false, code: 'spec_clause_unproven' });
    },
  );

  it('a spec revision recorded AFTER green evidence blocks shipping, and current proof unblocks it', async () => {
    // The clause was proven at r1, then revised to r2: the existing green evidence is
    // proof of a promise that no longer applies.
    const revised = clause({ specId: 'SPEC-1', revision: 2, currentRevision: 2, contentHash: 'hash-2' });

    const blocked = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [revised]),
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 1)]),
      }),
    );

    expect(blocked.satisfied).toBe(false);
    expect(blocked.code).toBe('spec_proof_stale');
    expect(blocked.mode).toBe('enforced');
    expect(blocked.aggregate?.coverage.staleProof).toBe(1);
    expect(blocked.aggregate?.coverage.proven).toBe(0);
    expect(blocked.aggregate?.coverage.staleProofClauses).toEqual([
      { specId: 'SPEC-1', planItemId: 'P-001', currentRevision: 2, provenRevisions: [1] },
    ]);
    // The refusal has to say which revision is missing proof, or it cannot be repaired.
    expect(blocked.message).toContain('SPEC-1');
    expect(blocked.message).toContain('r2');
    expect(blocked.message).toContain('plans:set-spec-evidence');

    // …and the SAME clause set, re-proven at the current revision, ships.
    const unblocked = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [revised]),
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 1), evidence('SPEC-1', 2)]),
      }),
    );

    expect(unblocked.satisfied).toBe(true);
    expect(unblocked.mode).toBe('enforced');
    expect(unblocked.code).toBeUndefined();
    expect(unblocked.aggregate?.coverage.proven).toBe(1);
    expect(unblocked.aggregate?.coverage.staleProof).toBe(0);
  });

  it('REFUSES an enforceable clause with no evidence (P-013 lands the D-018 widening)', async () => {
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({ listClauses: vi.fn(async () => [clause({ specId: 'SPEC-UNCOVERED' })]) }),
    );

    // ⚠ INVERTED from what it asserted under P-008/D-018, deliberately. It read
    // `satisfied: true, wouldBlock: []` and carried the note "turning this into a refusal
    // is a deliberate P-013 change, and it must fail this test to land". It did.
    //
    // The condition it now refuses on is the WEAKER one: the gate already refused a proof
    // bound to a superseded revision, while accepting a clause with no proof at all.
    expect(verdict.satisfied).toBe(false);
    expect(verdict.mode).toBe('enforced');
    expect(verdict.code).toBe('spec_clause_unproven');
    expect(verdict.wouldBlock).toEqual(['1-enforceable-clause(s)-with-no-evidence']);
    expect(verdict.aggregate?.coverage.unproven).toBe(1);
    expect(verdict.aggregate?.coverage.unprovenSpecIds).toEqual(['SPEC-UNCOVERED']);
    expect(verdict.message).toContain('SPEC-UNCOVERED');
  });

  it('does NOT refuse an unproven clause on a plan that is not eligible to enforce', async () => {
    // The falsifier for the widening above. Enforcement is per-plan (D-018 keeps shipped
    // plans non-blocking; D-012 keeps drafts candidate-only), so without this case
    // "refuses unproven clauses" would pass just as happily if eligibility were ignored —
    // which would refuse every already-shipped plan the admin panel renders.
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ specId: 'SPEC-UNCOVERED' })]),
        readPlanStatuses: vi.fn(
          async (input: { harnessSlug?: string; planSlugs: string[] }): Promise<Map<string, string>> =>
            new Map(input.planSlugs.map((slug) => [slug, 'shipped'])),
        ),
      }),
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.mode).toBe('report-only');
    expect(verdict.code).toBeUndefined();
    // ...but NOT silently: an exempt plan still names what it would have refused on, or a
    // migration lane is indistinguishable from a clean plan and never gets migrated.
    expect(verdict.wouldBlock).toEqual(['1-enforceable-clause(s)-with-no-evidence']);
    expect(verdict.reports.join(' ')).toContain('not-enforcing:historical');
  });

  it('degrades to report-only — never to a refusal — when the plan status cannot be read', async () => {
    // A status blip must not freeze every ship. The risk of a fail-OPEN is that it is
    // invisible, so the degradation is asserted to be REPORTED, not merely harmless.
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ specId: 'SPEC-UNCOVERED' })]),
        readPlanStatuses: vi.fn(async () => {
          throw new Error('pg unreachable');
        }),
      }),
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.mode).toBe('report-only');
    expect(verdict.reports.join(' ')).toContain('not-enforcing:unreadable-plan-status');
    expect(verdict.wouldBlock).toEqual(['1-enforceable-clause(s)-with-no-evidence']);
  });

  it('withholds the refusal when the evidence census is truncated (a floor is not a verdict)', async () => {
    // A full page of rows for OTHER clauses: the row that would prove SPEC-1 current
    // could be exactly the one that fell off the end, so a stale verdict here would be
    // manufactured from a bounded read.
    const saturated = Array.from({ length: SPEC_EVIDENCE_CENSUS_LIMIT }, (_, i) => evidence(`SPEC-OTHER-${i}`, 1));
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ revision: 2, currentRevision: 2 })]),
        listEvidence: vi.fn(async () => [...saturated, evidence('SPEC-1', 1)]),
      }),
    );

    expect(verdict.satisfied).toBe(true);
    expect(verdict.mode).toBe('report-only');
    expect(verdict.code).toBeUndefined();
    expect(verdict.aggregate?.bounded.truncatedByLimit).toBe(true);
    expect(verdict.reports).toContain('evidence-census-truncated');
    expect(verdict.message).toContain('FLOOR');
  });

  it('a plan with no first-class clauses is report-only, never a refusal', async () => {
    const verdict = await evaluatePlanSpecCoverageGate({ harnessSlug: 'papercusp', planSlug: PLAN }, deps());
    expect(verdict).toMatchObject({ satisfied: true, applicable: false, mode: 'report-only' });
    expect(verdict.reports).toContain('no-first-class-spec-clauses');
  });

  it('a read failure degrades to report-only instead of freezing the ship', async () => {
    const verdict = await evaluatePlanSpecCoverageGate(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => {
          throw new Error('clause store unavailable');
        }),
      }),
    );

    expect(verdict).toMatchObject({ satisfied: true, applicable: false, code: 'spec_coverage_unavailable' });
    expect(verdict.aggregate).toBeNull();
    expect(verdict.message).toContain('clause store unavailable');
  });
});

describe('computePlanSpecCoverage — the aggregate', () => {
  it('counts only accepted/active clauses as enforceable, and partitions the rest', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [
          clause({ specId: 'A', lifecycleStatus: 'active' }),
          clause({ specId: 'B', lifecycleStatus: 'accepted' }),
          clause({ specId: 'C', lifecycleStatus: 'draft' }),
          clause({ specId: 'D', lifecycleStatus: 'exempt' }),
          clause({ specId: 'E', lifecycleStatus: 'superseded' }),
          clause({ specId: 'F', lifecycleStatus: 'retired' }),
        ]),
      }),
    );

    expect(aggregate.clauses).toMatchObject({ total: 6, enforceable: 2, draft: 1, exempt: 1, inactive: 2 });
    // A draft clause is a candidate input, not an uncovered promise (D-012): it must
    // not appear as a coverage gap in either direction.
    expect(aggregate.coverage.unprovenSpecIds).toEqual(['A', 'B']);
  });

  it('reports undeclared falsifiers without treating them as coverage (D-016)', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [
          clause({ specId: 'A', falsifier: { observation: 'a stale proof ships' } }),
          clause({ specId: 'B', falsifier: null }),
        ]),
        listEvidence: vi.fn(async () => [evidence('A', 1), evidence('B', 1)]),
      }),
    );

    expect(aggregate.clauses.falsifierDeclared).toBe(1);
    // Both are PROVEN — an undeclared falsifier is a gradeable gap, not missing proof.
    expect(aggregate.coverage.proven).toBe(2);
  });

  it('counts an adequacy scorecard only at the clause’s CURRENT revision', async () => {
    // Only the r1 card exists; the clause below is at r2. The fake honours the batched
    // filter exactly, so an r1 card can only reach the gate if the gate asked for r1.
    const listCards = vi.fn(async (filter: { subjectRef?: string; subjectRefs?: readonly string[] } = {}) => {
      const asked = filter.subjectRefs ?? (filter.subjectRef ? [filter.subjectRef] : []);
      return asked.includes(`${PLAN}#SPEC-1@1`) ? [adequacyCard(`${PLAN}#SPEC-1@1`)] : [];
    });
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ revision: 2, currentRevision: 2 })]),
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 2)]),
        listCards: listCards as unknown as PlanSpecCoverageDeps['listCards'],
      }),
    );

    expect(aggregate.adequacy).toMatchObject({ graded: 0, ungraded: 1, ungradedSpecIds: ['SPEC-1'] });
  });

  it.each([
    ['stale', {
      state: 'stale', reason: 'criteria-hash-mismatch', recordedRevision: 6, currentRevision: 7,
      recordedCriteriaHash: 'old-hash', currentCriteriaHash: 'current-hash',
    }],
    ['unknown', {
      state: 'unknown', reason: 'live-identity-missing', recordedRevision: 6, currentRevision: null,
      recordedCriteriaHash: 'old-hash', currentCriteriaHash: null,
    }],
  ] as const)('does not count an adequacy card with %s scored-rubric currentness', async (_state, rubricCurrentness) => {
    const subjectRef = `${PLAN}#SPEC-1@1`;
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause()]),
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 1)]),
        listCards: vi.fn(async () => [adequacyCard(subjectRef, { rubricCurrentness })]),
      }),
    );

    expect(aggregate.adequacy).toMatchObject({ graded: 0, ungraded: 1, ungradedSpecIds: ['SPEC-1'] });
  });

  it('reads every clause’s adequacy cards in ONE batched read and grades each by its own subject', async () => {
    const specs = ['SPEC-1', 'SPEC-2', 'SPEC-3'];
    const listCards = vi.fn(async (filter: { subjectRefs?: readonly string[] } = {}) =>
      (filter.subjectRefs ?? [])
        .filter((ref) => ref !== `${PLAN}#SPEC-2@1`)
        .map((ref) => adequacyCard(ref, { issueId: `EI-${ref}` })),
    );
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => specs.map((specId) => clause({ specId }))),
        listEvidence: vi.fn(async () => specs.map((specId) => evidence(specId, 1))),
        listCards: listCards as unknown as PlanSpecCoverageDeps['listCards'],
      }),
    );

    // One read for the plan, not one per clause: the per-clause fan-out scanned the
    // rubric's whole card population once per clause and starved the GOAL portfolio read.
    expect(listCards).toHaveBeenCalledTimes(1);
    expect(listCards.mock.calls[0]?.[0]).toMatchObject({
      rubricRef: 'spec-test-adequacy',
      subjectRefs: specs.map((specId) => `${PLAN}#${specId}@1`),
    });
    expect(aggregate.adequacy).toMatchObject({ graded: 2, ungraded: 1, ungradedSpecIds: ['SPEC-2'] });
  });

  it('falls back to per-subject reads when the batch fills its cap, so a dropped older card is never read as missing', async () => {
    const crowd = Array.from({ length: 500 }, (_, i) => adequacyCard(`${PLAN}#OTHER-${i}@1`, { issueId: `EI-crowd-${i}` }));
    const listCards = vi.fn(async (filter: { subjectRef?: string; subjectRefs?: readonly string[] } = {}) => {
      if (filter.subjectRefs) return crowd;
      return filter.subjectRef === `${PLAN}#SPEC-1@1` ? [adequacyCard(`${PLAN}#SPEC-1@1`)] : [];
    });
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ specId: 'SPEC-1' }), clause({ specId: 'SPEC-2' })]),
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 1), evidence('SPEC-2', 1)]),
        listCards: listCards as unknown as PlanSpecCoverageDeps['listCards'],
      }),
    );

    expect(listCards).toHaveBeenCalledTimes(3);
    expect(listCards.mock.calls.slice(1).map(([filter]) => filter)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectRef: `${PLAN}#SPEC-1@1`, limit: 20 }),
        expect.objectContaining({ subjectRef: `${PLAN}#SPEC-2@1`, limit: 20 }),
      ]),
    );
    expect(aggregate.adequacy).toMatchObject({ graded: 1, ungraded: 1, ungradedSpecIds: ['SPEC-2'] });
  });

  it('marks boundedness on the AGGREGATE, not only on the row list', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({ listClauses: vi.fn(async () => [clause()]), listEvidence: vi.fn(async () => [evidence('SPEC-1', 1)]) }),
    );

    expect(aggregate.bounded).toMatchObject({
      evidenceCensusLimit: SPEC_EVIDENCE_CENSUS_LIMIT,
      evidenceRowsRead: 1,
      truncatedByLimit: false,
      adequacyClauseLimit: ADEQUACY_CENSUS_CLAUSE_LIMIT,
      adequacyTruncatedByLimit: false,
    });
  });

  it('pins the census limit itself rather than inheriting listSpecEvidence’s 200-row page default', async () => {
    const listEvidence = vi.fn(async () => [] as SpecEvidenceCensusRow[]);
    await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({ listClauses: vi.fn(async () => [clause()]), listEvidence }),
    );
    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ planSlugs: [PLAN], limit: SPEC_EVIDENCE_CENSUS_LIMIT }),
    );
  });
});

/**
 * P-013 instrumentation — the behavior-class / evidence-level / staleness partitions.
 *
 * The through-line of every test here is that a PARTITION of a census must reconcile
 * with the census it partitions. A partition that merely looks plausible is worse than
 * no partition: it is a second count of the same population, and two counts of one
 * population are indistinguishable from one correct count right up until they disagree
 * about the thing you are relying on.
 */
describe('computePlanSpecCoverage — P-013 instrumentation partitions', () => {
  /** Sum one field across every present class. The reconciliation half of every test. */
  const sumOver = (
    byClass: Awaited<ReturnType<typeof computePlanSpecCoverage>>['byBehaviorClass'],
    field: 'total' | 'enforceable' | 'proven' | 'staleProof' | 'unproven' | 'falsifierDeclared',
  ) => Object.values(byClass).reduce((n, slice) => n + (slice?.[field] ?? 0), 0);

  const mixedClassDeps = () =>
    deps({
      listClauses: vi.fn(async () => [
        // Two happy-path clauses, both proven at their current revision.
        clause({ specId: 'HP-1', behaviorClass: 'happy-path' }),
        clause({ specId: 'HP-2', behaviorClass: 'happy-path' }),
        // One authorization clause with NO evidence — the case the flat number buries.
        clause({ specId: 'AUTHZ-1', behaviorClass: 'authorization', falsifier: null }),
        // One exempt clause: counted in `total`, never enforceable.
        clause({ specId: 'EX-1', behaviorClass: 'observability', lifecycleStatus: 'exempt' }),
      ]),
      listEvidence: vi.fn(async () => [evidence('HP-1', 1), evidence('HP-2', 1)]),
    });

  /**
   * CALIBRATION CONTROL — proves the reconciliation assertion below has teeth.
   *
   * `sumOver(partition) === flatTotal` passes trivially when both sides are 0, which is
   * exactly the state an unpopulated partition produces. So a reconciliation test on a
   * fixture with no clauses would be a guard that can never fail. This control runs the
   * SAME comparison against a deliberately-wrong partition and asserts it DISAGREES,
   * which is what establishes that a wrong partition is detectable at all.
   *
   * It also pins the non-vacuity of the real fixture: the totals it reconciles against
   * are non-zero, asserted here rather than assumed.
   */
  it('CONTROL: the reconciliation comparison detects a partition that does not add up', async () => {
    const aggregate = await computePlanSpecCoverage({ harnessSlug: 'papercusp', planSlug: PLAN }, mixedClassDeps());

    // Non-vacuity: if these ever become 0, every reconciliation assertion below goes
    // trivially green and stops measuring anything.
    expect(aggregate.clauses.total).toBeGreaterThan(0);
    expect(aggregate.clauses.enforceable).toBeGreaterThan(0);
    expect(aggregate.coverage.proven).toBeGreaterThan(0);

    // A partition that drops one class — the realistic form of the bug (a class missed
    // by the accumulator) — must NOT reconcile.
    const { authorization: _dropped, ...missingAClass } = aggregate.byBehaviorClass;
    expect(sumOver(missingAClass, 'enforceable')).not.toBe(aggregate.clauses.enforceable);
  });

  it('partitions coverage by behavior class, and every field reconciles with the flat total', async () => {
    const aggregate = await computePlanSpecCoverage({ harnessSlug: 'papercusp', planSlug: PLAN }, mixedClassDeps());

    // The reconciliation property, field by field. This is what makes the partition a
    // VIEW of the census rather than a second census of the same rows.
    expect(sumOver(aggregate.byBehaviorClass, 'total')).toBe(aggregate.clauses.total);
    expect(sumOver(aggregate.byBehaviorClass, 'enforceable')).toBe(aggregate.clauses.enforceable);
    expect(sumOver(aggregate.byBehaviorClass, 'proven')).toBe(aggregate.coverage.proven);
    expect(sumOver(aggregate.byBehaviorClass, 'staleProof')).toBe(aggregate.coverage.staleProof);
    expect(sumOver(aggregate.byBehaviorClass, 'unproven')).toBe(aggregate.coverage.unproven);
    expect(sumOver(aggregate.byBehaviorClass, 'falsifierDeclared')).toBe(aggregate.clauses.falsifierDeclared);
  });

  it('surfaces a high-risk class at 0% proven that the flat coverage number reads as healthy', async () => {
    const aggregate = await computePlanSpecCoverage({ harnessSlug: 'papercusp', planSlug: PLAN }, mixedClassDeps());

    // THE MOTIVATING CASE. Flat reading: 2 of 3 enforceable clauses proven — the kind of
    // number that gets reported as "coverage is fine".
    expect(aggregate.coverage.proven).toBe(2);
    expect(aggregate.clauses.enforceable).toBe(3);

    // Partitioned reading: the single unproven clause is the AUTHORIZATION one, which the
    // adequacy grader already treats as high-risk. Same census, materially different story.
    expect(aggregate.byBehaviorClass['happy-path']).toMatchObject({ enforceable: 2, proven: 2, unproven: 0 });
    expect(aggregate.byBehaviorClass.authorization).toMatchObject({ enforceable: 1, proven: 0, unproven: 1 });
  });

  it('OMITS a class the plan never declared rather than zero-filling it', async () => {
    const aggregate = await computePlanSpecCoverage({ harnessSlug: 'papercusp', planSlug: PLAN }, mixedClassDeps());

    // Absence must stay distinguishable from "declared and fully accounted for". A
    // zero-filled row here would render "this plan says nothing about concurrency"
    // identically to "this plan's concurrency clauses are all proven".
    expect(aggregate.byBehaviorClass.concurrency).toBeUndefined();
    expect(aggregate.byBehaviorClass['migration-data-integrity']).toBeUndefined();

    // ...while an exempt-only class IS present, with enforceable 0 — the one case where
    // total and enforceable legitimately diverge.
    expect(aggregate.byBehaviorClass.observability).toMatchObject({ total: 1, enforceable: 0 });
  });

  it('counts stale evidence in byKind but NOT in currentByKind', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ specId: 'SPEC-1', revision: 2, currentRevision: 2 })]),
        listEvidence: vi.fn(async () => [
          // Stale: bound to r1 while the clause is at r2.
          evidence('SPEC-1', 1, { evidenceKind: 'manual' }),
          // Current.
          evidence('SPEC-1', 2, { evidenceKind: 'mutation' }),
        ]),
      }),
    );

    // Both rows exist and are reported...
    expect(aggregate.evidence.byKind).toEqual({ manual: 1, mutation: 1 });
    // ...but only the current-revision one is proof that still counts. Collapsing these
    // into one number is how a superseded attestation keeps a clause looking proven.
    expect(aggregate.evidence.currentByKind).toEqual({ mutation: 1 });
  });

  it('measures revision lag from the clause’s BEST proven revision, not its worst', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [clause({ specId: 'SPEC-1', revision: 5, currentRevision: 5 })]),
        // Proof exists at r1 and r4. The honest lag is 1 (5 − 4), not 4 (5 − 1):
        // measuring from the oldest row on file would report how much history was
        // retained, not how far the proof has fallen behind the promise.
        listEvidence: vi.fn(async () => [evidence('SPEC-1', 1), evidence('SPEC-1', 4)]),
      }),
    );

    expect(aggregate.coverage.staleProof).toBe(1);
    expect(aggregate.evidence.staleness.maxRevisionLag).toBe(1);
  });

  it('reports the oldest CURRENT proof, never an older stale row that no longer counts', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({
        listClauses: vi.fn(async () => [
          clause({ specId: 'A', revision: 2, currentRevision: 2 }),
          clause({ specId: 'B', revision: 1, currentRevision: 1 }),
        ]),
        listEvidence: vi.fn(async () => [
          // OLDEST row overall, but stale — it must not become the reported weakest link,
          // or the measure would report the age of discarded proof.
          evidence('A', 1, { observedAt: '2020-01-01T00:00:00.000Z' }),
          evidence('A', 2, { observedAt: '2026-06-01T00:00:00.000Z' }),
          evidence('B', 1, { observedAt: '2026-07-01T00:00:00.000Z' }),
        ]),
      }),
    );

    expect(aggregate.evidence.staleness.oldestCurrentProofAt).toBe('2026-06-01T00:00:00.000Z');
    // `newestProofAt` spans every row read, stale included — it answers "when did anything
    // last happen here", which is a different question from "how old is the live proof".
    expect(aggregate.evidence.staleness.newestProofAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('reports no staleness signal at all when a plan has no evidence, rather than a zeroed one', async () => {
    const aggregate = await computePlanSpecCoverage(
      { harnessSlug: 'papercusp', planSlug: PLAN },
      deps({ listClauses: vi.fn(async () => [clause({ specId: 'SPEC-1' })]) }),
    );

    // A null here means "never proven". A 0 or an epoch would be a manufactured
    // measurement of something that was never measured.
    expect(aggregate.evidence.staleness.oldestCurrentProofAt).toBeNull();
    expect(aggregate.evidence.staleness.newestProofAt).toBeNull();
    expect(aggregate.evidence.byKind).toEqual({});
    expect(aggregate.coverage.unproven).toBe(1);
  });
});
