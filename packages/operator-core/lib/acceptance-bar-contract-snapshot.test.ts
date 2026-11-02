import { describe, expect, it, vi } from 'vitest';
vi.mock('./acceptance-rubric-critique', () => ({ readCurrentAcceptanceRubricCritique: vi.fn(async () => null) }));
import {
  ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION,
  ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
  diffAcceptanceBarContractSnapshots,
  nextRepair,
  projectAcceptanceBarContractSnapshot,
  readAcceptanceBarContractSnapshot,
  STALE_PROOF_DIAGNOSIS,
  type AcceptanceBarContractSnapshotInput,
  type AcceptanceBarEvidenceSource,
  type AcceptanceBarPlanItemSource,
  type AcceptanceBarSnapshotDeps,
  type AcceptanceBarSubjectPlanSource,
  type AcceptanceBarWorkContractSource,
  type BoundedAcceptanceBarRows,
} from './acceptance-bar-contract-snapshot';
import {
  buildAcceptanceBarAmendmentCandidate,
  computeAcceptanceBarHash,
  computeAcceptanceBarSetHash,
  effectiveCriterionInstrumentKey,
  type Rubric,
  type RubricCriterion,
} from './rubrics';
import type { SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import type { ScorecardRow } from './scorecards';
import { classifyGradingAuditCurrentness } from './scorecards';
import { getAcceptanceRubricVettingStatus } from './acceptance-rubric-vetting';
import { evaluateAcceptanceBarLifecycle } from './acceptance-bar-lifecycle-evaluator';
import { parseRequirementBars } from './acceptance-bar-seed';
import { evaluateSpecTestAdequacy } from './agent-tools/plans/spec-test-adequacy';
import {
  BAR_READINESS_NOW_MARK,
  reevaluateBarReadinessOnScopeWrite,
  stampBarReadinessNowBlock,
} from './agent-tools/plans/plan-scope-cascade';
import { buildAmendmentReviewBrief } from './consult/acceptance-bar-amendment-review';

const iso = '2026-09-04T12:00:00.000Z';

describe('direct rubric critique in the BAR snapshot', () => {
  it.each([['criteria-hash', 'current'], ['old-hash', 'stale']] as const)(
    'classifies critique %s against the live identity as %s without a meta-card', (criteriaHash, state) => {
      const input = fixture();
      input.vettingScorecards = rows([]);
      input.vettingCritique = { consultId: 'consult-direct', workItemId: null, rubricRevision: 2,
        criteriaHash, createdAt: iso, critics: ['independent-reviewer'] };
      const snapshot = projectAcceptanceBarContractSnapshot(input);
      expect(snapshot.grading.vetting).toMatchObject({ state, scorecardId: null, critique: input.vettingCritique });
      expect(snapshot.readiness.codes.includes('bar_snapshot_vetting_missing')).toBe(false);
    },
  );
});

describe('BAR snapshot settled audit currentness', () => {
  it.each([
    ['pending', 'meta-current', 'stale'],
    ['failed', 'meta-current', 'stale'],
    ['passed', 'meta-old', 'stale'],
    ['passed', null, 'stale'],
    ['passed', 'meta-current', 'current'],
  ] as const)('agrees with canonical vetting for audit %s / %s', async (state, criteriaHash, expected) => {
    const input = fixture();
    const rubric = input.rubrics.rows[0]!;
    const card = input.vettingScorecards.rows[0]!;
    card.gradingAudit = {
      state,
      metaRubricRef: 'grading-integrity',
      stampedAt: iso,
      rubricRevision: 1,
      criteriaHash: criteriaHash ?? undefined,
    };
    card.gradingAuditCurrentness = classifyGradingAuditCurrentness(card.gradingAudit,
      criteriaHash === null ? null : { rubricId: 'grading-integrity', revision: 1, criteriaHash: 'meta-current' });
    const canonical = await getAcceptanceRubricVettingStatus(rubric, {
      vettingGateEnabled: true,
      getRubric: async () => rubric,
      getRubricPlanRevision: async () => rubric.revision ?? null,
      listScorecards: async () => [card],
      readCurrentCritique: async () => null,
    });
    expect(canonical.satisfied).toBe(expected === 'current');
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.grading.vetting).toMatchObject({ state: expected, scorecardId: card.issueId });
    expect(snapshot.readiness.codes.includes('bar_snapshot_vetting_stale')).toBe(expected === 'stale');
  });

  it('keeps a current direct critique admissible when a legacy audit is rejected', () => {
    const input = fixture();
    input.vettingScorecards.rows[0]!.gradingAudit = {
      state: 'failed', metaRubricRef: 'grading-integrity', stampedAt: iso,
    };
    input.vettingCritique = {
      consultId: 'consult-direct', workItemId: null, rubricRevision: 2,
      criteriaHash: 'criteria-hash', createdAt: iso, critics: ['independent-reviewer'],
    };
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.grading.vetting).toMatchObject({ state: 'current', critique: input.vettingCritique });
    expect(snapshot.readiness.codes).not.toContain('bar_snapshot_vetting_stale');
  });
});

function rows<T>(values: T[], limit = Math.max(values.length, 1), truncated = false): BoundedAcceptanceBarRows<T> {
  return { rows: values, limit, truncated };
}

function criterion(n: number): RubricCriterion {
  const value = {
    key: `r-${n}`,
    title: `Outcome ${n}`,
    model: `Outcome ${n} is true.`,
    method: `Run check ${n}.`,
    driftMarkers: `Outcome ${n} is absent.`,
    barKey: `R-${n}`,
    role: 'outcome' as const,
    mandatory: true,
    requiredScope: ['tree'],
    evidencePlane: 'tree' as const,
    passRatings: ['healthy'],
    barProvenance: {
      lifecycle: 'pre-implementation' as const,
      declaredAt: iso,
      declaredBy: 'su-author',
    },
  };
  return { ...value, barHash: computeAcceptanceBarHash(value) };
}

function scorecard(overrides: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'SC-GRADE',
    createdAt: '2026-09-04T13:00:00.000Z',
    createdBy: 'su-grader',
    rubricRef: 'acceptance-plan-a',
    rubricRevision: 2,
    criteriaHash: 'criteria-hash',
    ratings: {},
    nKeys: 0,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    score10: 10,
    linkedItems: [],
    ...overrides,
  } as ScorecardRow;
}

function fixture(n = 2): AcceptanceBarContractSnapshotInput {
  const criteria = Array.from({ length: n }, (_, index) => criterion(index + 1));
  const barSetHash = computeAcceptanceBarSetHash(criteria);
  const plan: AcceptanceBarSubjectPlanSource = {
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    planSlug: 'plan-a',
    status: 'active',
    revision: 7,
    contentHash: 'plan-content-hash',
    adoptionEpoch: 1,
    cohort: 'post-epoch',
    barSetHash,
    rubricSlug: 'acceptance-plan-a',
    rubricRevision: 2,
    seededAt: iso,
    seededBy: 'su-author',
  };
  const rubric = {
    rubricId: 'acceptance-plan-a',
    revision: 2,
    workspaceId: 'ws-1',
    kind: 'acceptance',
    subjectPlan: 'plan-a',
    subjectGoal: null,
    barSetHash,
    barContract: {
      schemaVersion: 1,
      adoptionEpoch: 1,
      cohort: 'post-epoch',
      subjectPlanRevision: 7,
      seededAt: iso,
      seededBy: 'su-author',
    },
    characteristic: 'plan-acceptance',
    title: 'Plan A acceptance',
    description: 'Acceptance',
    criteria,
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
    criteriaHash: 'criteria-hash',
    status: 'active',
    created: '2026-09-04',
    updated: '2026-09-04',
    proposedBy: 'su-author',
    createdBy: 'su-author',
  } as unknown as Rubric;
  const planItems: AcceptanceBarPlanItemSource[] = criteria.map((bar, index) => ({
    itemId: `P-${String(index + 1).padStart(3, '0')}`,
    status: 'done',
  }));
  const clauses: SpecClauseRevision[] = criteria.map((bar, index) => {
    const itemId = planItems[index]!.itemId;
    return {
      planSlug: 'plan-a',
      specId: `AUTO-BAR-${bar.barKey}-${itemId}`,
      sourceValId: null,
      currentRevision: 1,
      revision: 1,
      planItemId: itemId,
      behavior: bar.model,
      behaviorClass: 'happy-path',
      requiredEvidence: ['tree'],
      requiredTestLayers: [],
      mutationRequired: false,
      lifecycleStatus: 'active',
      supersedes: null,
      exemption: null,
      falsifier: { observation: bar.driftMarkers },
      contentHash: `spec-hash-${index + 1}`,
      createdBy: 'su-author',
      createdAt: iso,
      acceptedBy: 'su-author',
      acceptedAt: iso,
      acceptanceRef: `acceptance-plan-a@2:${bar.barKey}`,
      sourceBar: {
        barKey: bar.barKey!,
        barHash: bar.barHash!,
        barSetHash,
        rubricSlug: 'acceptance-plan-a',
        rubricRevision: 2,
        evidencePlane: 'tree',
      },
    } as SpecClauseRevision;
  });
  const workContracts: AcceptanceBarWorkContractSource[] = clauses.map((clause, index) => ({
    workItemId: `WI-${index + 1}`,
    planSlug: clause.planSlug,
    specId: clause.specId,
    specRevision: clause.revision,
    specFingerprint: clause.contentHash,
  }));
  const evidence: AcceptanceBarEvidenceSource[] = clauses.map(
    (clause, index) =>
      ({
        id: index + 1,
        workItemId: `WI-${index + 1}`,
        planSlug: clause.planSlug,
        specId: clause.specId,
        sourceValId: null,
        specRevision: clause.revision,
        currentRevision: clause.revision,
        specFingerprint: clause.contentHash,
        evidenceKind: 'test',
        evidenceRef: `test:${index + 1}`,
        fingerprints: {
          sourceFingerprint: `source-${index + 1}`,
          testFingerprint: null,
          fixtureFingerprint: null,
          rubricFingerprint: null,
          environmentFingerprint: null,
        },
        coverageEvidenceRef: null,
        // Durable rerun anchor. classifySpecEvidenceLineage rates a binding
        // 'unknown' when nothing identifies a rerunnable proof, and that
        // propagates to the adequacy state — masking the test-LAYER logic these
        // cases exist to exercise. Real evidence for an exercised outcome
        // carries a test run id; the fixture must too.
        testRunId: index + 1,
        testRunProvenance: null,
        details: {},
        observedAt: iso,
        bindingFingerprint: `binding-${index + 1}`,
        createdBy: 'su-impl',
        createdAt: iso,
        currentness: {
          overall: 'unknown',
          dimensions: {
            spec: 'current',
            source: 'unknown',
            test: 'not-applicable',
            fixture: 'not-applicable',
            rubric: 'not-applicable',
            environment: 'not-applicable',
            coverageEvidence: 'not-applicable',
            testRun: 'not-applicable',
          },
          staleReasons: [],
          unknownReasons: ['source-current-fingerprint-not-supplied'],
          // The default snapshot reader supplies no `current` input, so this row's
          // `unknown` means "nobody asked", not "the proof is doubtful" (WI-2146375).
          comparisonSupplied: false,
        },
      }) as AcceptanceBarEvidenceSource,
  );
  const ratings = Object.fromEntries(
    criteria.map((bar) => [bar.key, { rating: 'healthy', evidence: `verified ${bar.barKey}` }]),
  );
  const independent = scorecard({ ratings, nKeys: criteria.length, supersededBy: 'SC-AUTHOR' });
  const authorVerdict = scorecard({
    issueId: 'SC-AUTHOR',
    createdAt: '2026-09-04T14:00:00.000Z',
    createdBy: 'su-author',
    ratings,
    nKeys: criteria.length,
    supersedes: 'SC-GRADE',
    acceptance: { verdict: 'accept', reasoning: 'Independent evidence is sound.' },
  });
  const vetting = scorecard({
    issueId: 'SC-VET',
    rubricRef: 'meta-acceptance-rubric',
    createdAt: '2026-09-04T12:30:00.000Z',
    createdBy: 'su-critic',
    rubricRevision: 9,
    ratings: { completeness: { rating: 'healthy', evidence: 'complete' } },
    nKeys: 1,
    subject: { kind: 'rubric', ref: 'acceptance-plan-a' },
    vetting: {
      consultId: 'conv-1',
      rubricRevision: 2,
      criteriaHash: 'criteria-hash',
      critiquePosts: 1,
      critics: ['su-critic'],
    },
  });
  return {
    planRows: rows([plan], 1),
    rubrics: rows([rubric], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT),
    planItems: rows(planItems, ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT),
    clauses: rows(clauses, 1_000),
    workContracts: rows(workContracts, 1_000),
    evidence: rows(evidence, ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT),
    scorecards: rows([authorVerdict, independent], ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT),
    vettingScorecards: rows([vetting], ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT),
    lineage: {
      identities: ['su-impl'],
      workItemRowsRead: n,
      auditRowsRead: 1,
      rowLimit: ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
      truncated: false,
    },
    partyByIdentity: new Map([
      ['su-author', 'su-author'],
      ['su-grader', 'su-grader'],
      ['su-impl', 'su-impl'],
    ]),
    graderSelectionVia: new Map([['su-grader', 'floor']]),
  };
}

function currentRegisteredTestEvidence(
  base: AcceptanceBarEvidenceSource,
  filePath: string,
  testRunId: number,
): AcceptanceBarEvidenceSource {
  return {
    ...base,
    id: testRunId,
    evidenceKind: 'test',
    evidenceRef: `test-run:${testRunId}:${filePath}`,
    testRunId,
    fingerprints: {
      sourceFingerprint: 'source-current',
      testFingerprint: `test-${testRunId}`,
      fixtureFingerprint: `fixture-${testRunId}`,
      rubricFingerprint: `rubric-${testRunId}`,
      environmentFingerprint: `environment-${testRunId}`,
    },
    testRunProvenance: { filePath, commitSha: 'abc123', worktreeDirty: false },
    testRunExecution: {
      status: 'pass',
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      testLayer: 'integration',
      filePath,
      passedCaseTitles: [`source-bar-check-${testRunId}`],
    },
    details: {
      evidencePlane: 'tree',
      adequacy: {
        testLayer: 'integration',
        pathReachable: true,
        fixtureCalibrated: true,
        falsifiable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        targeted: base.specId,
        testCases: [`source-bar-check-${testRunId}`],
      },
    },
    currentness: {
      ...base.currentness,
      overall: 'current',
      comparisonSupplied: true,
      dimensions: {
        ...base.currentness.dimensions,
        source: 'current',
        test: 'current',
        fixture: 'current',
        rubric: 'current',
        environment: 'current',
        testRun: 'current',
      },
      staleReasons: [],
      unknownReasons: [],
    },
  } as unknown as AcceptanceBarEvidenceSource;
}

function provedFixture(n = 2): AcceptanceBarContractSnapshotInput {
  const input = fixture(n);
  const rubric = input.rubrics.rows[0]!;
  const proofTestPath = 'packages/operator-core/lib/bar-proof-fixture.test.ts';
  const proofCaseTitle = (index: number) => 'bar-proof-case-' + (index + 1);
  for (const criterion of rubric.criteria) {
    criterion.requiredTestLayers = ['integration'];
    criterion.check = { kind: 'instrument', instrumentKey: 'none' };
    criterion.barHash = computeAcceptanceBarHash(criterion);
  }
  const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
  rubric.barSetHash = barSetHash;
  input.planRows.rows[0]!.barSetHash = barSetHash;
  input.clauses.rows.forEach((clause, index) => {
    clause.requiredTestLayers = ['integration'];
    clause.falsifier = { ...clause.falsifier!, requiredScenarios: [proofCaseTitle(index)] };
    clause.sourceBar!.barHash = rubric.criteria[index]!.barHash!;
    clause.sourceBar!.barSetHash = barSetHash;
  });
  input.evidence.rows.forEach((evidence, index) => {
    const caseTitle = proofCaseTitle(index);
    evidence.currentness = { ...evidence.currentness, overall: 'current', comparisonSupplied: true,
      dimensions: { ...evidence.currentness.dimensions, source: 'current' }, unknownReasons: [] };
    evidence.fingerprints = { ...evidence.fingerprints,
      testFingerprint: 'test-fingerprint-' + (index + 1),
      fixtureFingerprint: 'fixture-fingerprint-' + (index + 1),
    };
    evidence.details = { evidencePlane: 'tree', adequacy: { testLayer: 'integration', pathReachable: true,
      fixtureCalibrated: true, falsifiable: true, oracleIndependent: true, collected: true, skipped: false, executed: true,
      outcome: 'passed', targeted: evidence.specId, testCases: [caseTitle], scenarioIds: [caseTitle],
      scenarioTestCases: { [caseTitle]: [caseTitle] } } };
    // Since 39ce2b4152 a counterexample proves falsifiability only when its run's test file
    // also carries this clause's current passing `test` binding (clauseBoundCurrentTests pairs
    // them by testRunProvenance.filePath). The counterexamples below spread this row, so each
    // pairs with its own positive proof, as a real binding would (WI-10006871).
    evidence.testRunProvenance = { filePath: proofTestPath,
      framework: 'vitest', source: 'local', mutationPhase: null, commitSha: 'abc123', worktreeDirty: false };
    evidence.testRunExecution = { status: 'pass', passed: 1, failed: 0, skipped: 0,
      filePath: proofTestPath, collectionFailed: false, testLayer: 'integration', passedCaseTitles: [caseTitle] };
  });
  // Falsifiability is demonstrated by an executed negative control, not by the
  // positive row's `falsifiable: true` self-attestation. Keep the logical
  // identity distinct from the recurrence row so the evaluator retains both.
  const positiveEvidence = [...input.evidence.rows];
  input.evidence.rows.push(...positiveEvidence.map((evidence, index) => {
    const caseTitle = proofCaseTitle(index);
    return {
      ...evidence,
      id: positiveEvidence.length + index + 1,
      evidenceKind: 'counterexample' as const,
      evidenceRef: 'counterexample:' + (index + 1),
      coverageEvidenceRef: null,
      testRunId: positiveEvidence.length + index + 1,
      testRunProvenance: {
        ...evidence.testRunProvenance!,
        source: 'mutation-probe',
        mutationPhase: 'mutant',
        mutationFailedCaseTitles: [caseTitle],
        mutationFailureLines: [caseTitle + ': the pre-fix behavior violates the expected outcome'],
      },
      testRunExecution: { status: 'fail' as const, passed: 0, failed: 1, skipped: 0,
        filePath: proofTestPath, collectionFailed: false, testLayer: 'integration' },
      bindingFingerprint: 'counterexample-binding-' + (index + 1),
      details: {
        evidencePlane: 'tree',
        adequacy: {
          fixtureCalibrated: true, testLayer: 'integration', pathReachable: true,
          falsifiable: true, oracleIndependent: true, collected: true, skipped: false, executed: true,
          targeted: caseTitle, outcome: 'killed', testCases: [caseTitle],
        },
      },
    };
  }));
  const firstCoverageRowId = input.evidence.rows.length + 1;
  input.evidence.rows.push(...positiveEvidence.map((evidence, index) => ({
    ...structuredClone(evidence),
    id: firstCoverageRowId + index,
    evidenceKind: 'coverage-census' as const,
    evidenceRef: 'coverage-census:' + (index + 1),
    coverageEvidenceRef: 100 + index,
    details: {
      evidencePlane: 'tree',
      adequacy: {
        ...(evidence.details.adequacy as object),
        targeted: evidence.specId,
        coverageRungs: { l3: true },
      },
    },
    bindingFingerprint: 'coverage-binding-' + (index + 1),
  })));
  return input;
}

function mechanicallyProvedFixture(): AcceptanceBarContractSnapshotInput {
  const input = fixture(1);
  const rubric = input.rubrics.rows[0]!;
  const criterion = rubric.criteria[0]!;
  const file = 'src/guard.test.ts';
  const subjectPath = 'src/guard.ts';
  // Seed the stored promise from the same structured requirement as the live plan.
  // Adding its intent only to the live copy is a meaning change, not a path-only edit.
  const parsed = parseRequirementBars(liveVerificationPlan({ kind: 'tests', files: [file] }));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  Object.assign(criterion, parsed.bars[0]!.criterion);
  criterion.barHash = computeAcceptanceBarHash(criterion);
  const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
  rubric.barSetHash = barSetHash;
  input.planRows.rows[0]!.barSetHash = barSetHash;
  Object.assign(input.clauses.rows[0]!.sourceBar!, { barHash: criterion.barHash, barSetHash });
  const positive = currentRegisteredTestEvidence(input.evidence.rows[0]!, file, 10);
  positive.currentness.provenance = 'server-measured';
  positive.details = { currentMeasurement: { schemaVersion: 1, kind: 'repo-files',
    sourcePaths: [subjectPath], testPaths: [file] } };
  const mutation = { schemaVersion: 1 as const, probeInvocationId: 'snapshot-probe', leg: 'mutant' as const,
    mode: 'copy-out' as const, subjectPath, mutateExpression: 's/reject/accept/', againstCommit: null,
    subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
    mutantDiff: '-reject\n+accept', mutantDiffTruncated: false,
    testCommandSha256: 'c'.repeat(64), testFileSha256: 'd'.repeat(64) };
  const mutant: AcceptanceBarEvidenceSource = { ...structuredClone(positive), id: 11,
    evidenceKind: 'mutation', evidenceRef: 'test-run:11:mutant', testRunId: 11,
    testRunExecution: { ...positive.testRunExecution!, status: 'fail', passed: 0, failed: 1 },
    testRunProvenance: { ...positive.testRunProvenance!, source: 'mutation-probe', mutationPhase: 'mutant', mutation,
      mutationBaseline: { testRunId: 12, status: 'pass', passed: 1, failed: 0, skipped: 0,
        collectionFailed: false, mutation: { ...mutation, leg: 'baseline' } } } };
  input.evidence.rows = [positive, mutant];
  return input;
}

function liveVerificationPlan(check: RubricCriterion['check']): string {
  return ['## Requirements', '', '**R-1 — Outcome 1.**', '', '```requirement', JSON.stringify({
    intent: { request: 'Keep the same acceptance promise.' },
    acceptance: { condition: 'Outcome 1 is true.', falsifier: 'Outcome 1 is absent.',
      evidencePlane: 'tree', requiredScope: ['tree'] },
    verification: { method: 'Run the current named check.', check, replication: 'Use the live test path.' },
  }), '```'].join('\n');
}

describe('AcceptanceBarContractSnapshot — pure bounded projection', () => {
  it('uses live requirement check paths while preserving stored hash and vetting identities', () => {
    const input = mechanicallyProvedFixture();
    const rubric = input.rubrics.rows[0]!;
    const criterion = rubric.criteria[0]!;
    // Proof exists only for the new file. The stored copy intentionally names the old file.
    criterion.check = { kind: 'tests', files: ['src/old-guard.test.ts'] };
    criterion.barHash = computeAcceptanceBarHash(criterion);
    const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
    rubric.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    Object.assign(input.clauses.rows[0]!.sourceBar!, { barHash: criterion.barHash, barSetHash });
    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.proof.adequacy?.state).toBe('fail');
    input.planRows.rows[0]!.content = liveVerificationPlan({ kind: 'tests', files: ['src/guard.test.ts'] });
    const stored = structuredClone(rubric);
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]).toMatchObject({ barHash: criterion.barHash,
      check: { kind: 'tests', files: ['src/guard.test.ts'] },
      method: 'Run the current named check.', replication: 'Use the live test path.',
      proof: { adequacy: { state: 'pass' } } });
    expect(snapshot.rubric).toMatchObject({ criteriaHash: rubric.criteriaHash, barSetHash });
    expect(snapshot.grading.vetting.state).toBe('current');
    expect(snapshot.readiness.codes).not.toContain('bar_snapshot_bar_hash_mismatch');
    expect(snapshot.readiness.codes).not.toContain('bar_snapshot_bar_set_hash_mismatch');
    expect(snapshot.plan).not.toHaveProperty('content');
    expect(rubric).toEqual(stored);
  });

  it('still detects corrupt stored hashes before applying live verification', () => {
    const input = mechanicallyProvedFixture();
    input.rubrics.rows[0]!.criteria[0]!.barHash = 'corrupt';
    input.planRows.rows[0]!.content = liveVerificationPlan({ kind: 'tests', files: ['src/guard.test.ts'] });
    expect(projectAcceptanceBarContractSnapshot(input).readiness.codes).toContain('bar_snapshot_bar_hash_mismatch');
  });

  it.each(['kind-change', 'meaning-change', 'malformed', 'legacy'] as const)(
    'keeps stored verification for a %s live requirement', kind => {
      const input = mechanicallyProvedFixture();
      input.planRows.rows[0]!.content = kind === 'kind-change'
        ? liveVerificationPlan({ kind: 'instrument', instrumentKey: 'none' })
        : kind === 'meaning-change'
          ? liveVerificationPlan({ kind: 'tests', files: ['src/changed-promise.test.ts'] })
            .replace('Keep the same acceptance promise.', 'Adopt a different acceptance promise.')
        : kind === 'malformed' ? '## Requirements\n\n**R-1 — Bad.**\n```requirement\n{broken}\n```'
          : '## Requirements\n\n**R-1 — Legacy.**\nOutcome 1 is true.';
      const snapshot = projectAcceptanceBarContractSnapshot(input);
      expect(snapshot.bars[0]!.check).toEqual({ kind: 'tests', files: ['src/guard.test.ts'] });
      expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('pass');
    },
  );

  it('grades named passing tests and a calibrated caught mutant mechanically through the ship lifecycle', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(mechanicallyProvedFixture());
    expect(snapshot.bars[0]!.proof.adequacy).toMatchObject({ state: 'pass', checks: [{ verdict: 'pass',
      wouldBlock: [], evidenceRefs: ['test-run:10:src/guard.test.ts', 'test-run:11:mutant'] }] });
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'pre-grading').codes).not.toContain('bar_snapshot_proof_inadequate');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).not.toContain('bar_snapshot_proof_inadequate');
  });

  it('keeps supplementary native evidence visible without adding uncertainty to complete tree unit proof', () => {
    const input = mechanicallyProvedFixture();
    const native = currentRegisteredTestEvidence(input.evidence.rows[0]!, 'e2e/native.spec.mts', 13);
    native.currentness = { ...native.currentness, overall: 'unknown', comparisonSupplied: true,
      provenance: 'server-measured', dimensions: { ...native.currentness.dimensions, environment: 'unknown' },
      unknownReasons: ['environment-current-fingerprint-not-supplied'] };
    input.evidence.rows.push(native);

    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('pass');
    expect(snapshot.bars[0]!.proof.history).toContainEqual(expect.objectContaining({
      id: 13, currentness: expect.objectContaining({ overall: 'unknown' }),
    }));
    expect(snapshot.bars[0]!.proof.uncertainEvidence).toBe(0);
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'pre-grading').codes).not.toContain('bar_snapshot_proof_uncertain');
  });

  it.each(['required-test', 'required-mutant', 'live-plane', 'deployed-plane', 'clause-live', 'e2e-layer'] as const)(
    'preserves uncertainty in mechanical snapshot proof for %s', requirement => {
      const input = mechanicallyProvedFixture();
      const optional = currentRegisteredTestEvidence(input.evidence.rows[0]!, 'e2e/native.spec.mts', 13);
      const uncertain = requirement === 'required-test' ? input.evidence.rows[0]!
        : requirement === 'required-mutant' ? input.evidence.rows[1]! : optional;
      uncertain.currentness = { ...uncertain.currentness, overall: 'unknown', comparisonSupplied: true,
        provenance: 'server-measured', dimensions: { ...uncertain.currentness.dimensions, environment: 'unknown' },
        unknownReasons: ['environment-current-fingerprint-not-supplied'] };
      input.evidence.rows.push(optional);
      if (requirement === 'live-plane' || requirement === 'deployed-plane')
        input.rubrics.rows[0]!.criteria[0]!.evidencePlane = requirement === 'live-plane' ? 'live' : 'deployed';
      if (requirement === 'clause-live') input.clauses.rows[0]!.requiredEvidence.push('live');
      if (requirement === 'e2e-layer') input.clauses.rows[0]!.requiredTestLayers.push('e2e');

      const snapshot = projectAcceptanceBarContractSnapshot(input);
      expect(snapshot.bars[0]!.proof.uncertainEvidence).toBe(1);
      expect(evaluateAcceptanceBarLifecycle(snapshot, 'pre-grading').codes).toContain('bar_snapshot_proof_uncertain');
      if (requirement.startsWith('required-')) expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('fail');
    },
  );

  it.each(['missing-mutant', 'uncalibrated', 'stale-test', 'stale-mutant', 'unmeasured', 'other-test'] as const)(
    'keeps mechanical snapshot proof blocked for %s', defect => {
      const input = mechanicallyProvedFixture();
      const [positive, mutant] = input.evidence.rows;
      if (defect === 'missing-mutant') input.evidence.rows = [positive!];
      if (defect === 'uncalibrated') mutant!.testRunProvenance!.mutationBaseline = null;
      if (defect === 'stale-test') positive!.currentness.overall = 'stale';
      if (defect === 'stale-mutant') mutant!.currentness.overall = 'stale';
      if (defect === 'unmeasured') positive!.currentness.provenance = 'replayed-snapshot';
      if (defect === 'other-test') positive!.testRunProvenance!.filePath = 'src/other.test.ts';
      const snapshot = projectAcceptanceBarContractSnapshot(input);
      expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('fail');
      expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
    },
  );

  it('evaluates every structured tests check file even when requiredTestLayers is empty', () => {
    const input = fixture(1);
    const rubric = input.rubrics.rows[0]!;
    const criterion = rubric.criteria[0]!;
    const files = [
      'packages/service/src/api.test.ts',
      'packages/service/src/store.test.ts',
    ];
    criterion.requiredTestLayers = [];
    criterion.check = { kind: 'tests', files };
    criterion.barHash = computeAcceptanceBarHash(criterion);
    const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
    rubric.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    input.clauses.rows[0]!.requiredTestLayers = [];
    input.clauses.rows[0]!.sourceBar = {
      ...input.clauses.rows[0]!.sourceBar!,
      barHash: criterion.barHash!,
      barSetHash,
      rubricSlug: rubric.rubricId,
      rubricRevision: rubric.revision!,
      evidencePlane: 'tree',
    };
    const base = input.evidence.rows[0]!;
    input.evidence.rows = files.map((file, index) => currentRegisteredTestEvidence(base, file, index + 1));

    const snapshot = projectAcceptanceBarContractSnapshot(input);
    const adequacy = snapshot.bars[0]!.proof.adequacy;

    expect(adequacy).toMatchObject({ checks: [{ verdict: 'fail' }] });
    expect(adequacy!.checks[0]!.wouldBlock).toEqual(expect.arrayContaining([
      expect.stringContaining('no caught mutation probe'),
    ]));
    expect(adequacy!.checks[0]!.wouldBlock).not.toContain('correct-layer');
  });

  it.each([{ floor: [] }, { floor: ['integration'] }])('keeps a stricter clause current above the BAR test floor $floor', ({ floor }) => {
    const input = floor.length ? provedFixture(1) : fixture(1);
    input.clauses.rows[0]!.requiredTestLayers = [...floor, 'e2e'];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_projection_stale');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'pre-start').codes).not.toContain('bar_snapshot_projection_stale');
  });

  // review-system-rework-reduction P-001: the amendment keeps an unchanged bar's clause at
  // its revision, so the clause carries the OLDER BAR-set hash it was projected under.
  // That must not read as a stale projection — only its own bar moving may.
  it('keeps a clause projected under an older BAR set current when its own bar is unchanged (P-001)', () => {
    const input = provedFixture(1);
    const clause = input.clauses.rows[0]!;
    clause.sourceBar = { ...clause.sourceBar!, barSetHash: 'f'.repeat(64), rubricRevision: 1 };

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_projection_stale');
  });

  it('still marks the projection stale when the clause pins a different bar hash (P-001 calibration)', () => {
    const input = provedFixture(1);
    const clause = input.clauses.rows[0]!;
    clause.sourceBar = { ...clause.sourceBar!, barHash: 'e'.repeat(64) };

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_projection_stale');
  });

  it('rejects a clause that omits a required BAR test layer', () => {
    const input = provedFixture(1);
    input.clauses.rows[0]!.requiredTestLayers = ['e2e'];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_projection_stale');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'pre-start').satisfied).toBe(false);
  });

  it('requires proof of additional clause layers before shipping', () => {
    const input = provedFixture(1);
    input.clauses.rows[0]!.requiredTestLayers = ['integration', 'e2e'];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_projection_stale');
    expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('correct-layer');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it('projects unified sections with shared validation links and preserves absent legacy intent', () => {
    const input = provedFixture(2);
    const rubric = input.rubrics.rows[0]!;
    const first = rubric.criteria[0]!;
    first.intent = { request: 'Export every selected record.', rationale: 'An incomplete export loses work.',
      constraints: ['Include attachments.'], sourceRefs: ['request:export'] };
    first.barHash = computeAcceptanceBarHash(first);
    const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
    rubric.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    input.clauses.rows.forEach((clause, index) => {
      clause.sourceValId = 'VAL-SHARED';
      clause.sourceBar!.barHash = rubric.criteria[index]!.barHash!;
      clause.sourceBar!.barSetHash = barSetHash;
    });
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]).toMatchObject({ title: first.title, criterionKey: first.key,
      requirement: { intent: first.intent,
        acceptance: { condition: first.model, falsifier: first.driftMarkers, requiredTestLayers: ['integration'] },
        verification: { method: first.method, check: first.check } } });
    expect(snapshot.bars[1]!.requirement!.intent).toBeNull();
    expect(snapshot.bars.map((bar) => bar.mappings[0]!.sourceValId)).toEqual(['VAL-SHARED', 'VAL-SHARED']);
    expect(snapshot.bars[0]!.workContracts[0]).toMatchObject({ workItemId: 'WI-1', specRevision: 1 });
  });

  it('exposes earlier failed grades and implementer reports separately from independent grading and author acceptance', () => {
    const input = provedFixture(1);
    input.scorecards.rows.push(scorecard({ issueId: 'SC-OLD', rubricRevision: 1,
      criteriaHash: 'criteria-hash-before-change',
      createdAt: '2026-09-03T13:00:00.000Z', supersededBy: 'SC-GRADE',
      ratings: { 'r-1': { rating: 'broken', evidence: 'Export omitted an attachment.' } } }),
    scorecard({ issueId: 'SC-SELF', createdBy: 'su-impl',
      ratings: { 'r-1': { rating: 'healthy', evidence: 'Implementation report.' } } }));
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.grading).toMatchObject({ scorecardId: 'SC-GRADE', state: 'pass' });
    expect(snapshot.bars[0]!.grading.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ scorecardId: 'SC-OLD', rating: 'broken', currentRevision: false,
        authoritative: false, supersededBy: 'SC-GRADE' }),
      expect.objectContaining({ scorecardId: 'SC-SELF', role: 'implementer', authoritative: false }),
      expect.objectContaining({ scorecardId: 'SC-GRADE', role: 'independent', authoritative: true }),
      expect.objectContaining({ scorecardId: 'SC-AUTHOR', role: 'author', authorVerdict: 'accept',
        supersedes: 'SC-GRADE', reasoning: 'Independent evidence is sound.' }),
    ]));
    expect(snapshot.grading.authorVerdict).toMatchObject({ createdBy: 'su-author', rubricRevision: 2,
      supersedes: 'SC-GRADE', scorecardId: 'SC-AUTHOR', state: 'accepted' });
  });

  it('keeps a non-mandatory disclosure visible without making its rating a ship blocker', () => {
    const input = provedFixture(2);
    const rubric = input.rubrics.rows[0]!;
    const disclosure = rubric.criteria[1]!;
    disclosure.role = 'disclosure';
    disclosure.mandatory = false;
    disclosure.passRatings = [];
    disclosure.coversBarKeys = ['R-1'];
    disclosure.barHash = computeAcceptanceBarHash(disclosure);
    const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
    rubric.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    input.clauses.rows.forEach((clause, index) => {
      clause.sourceBar!.barHash = rubric.criteria[index]!.barHash!;
      clause.sourceBar!.barSetHash = barSetHash;
    });

    const snapshot = projectAcceptanceBarContractSnapshot(input);
    const disclosureBar = snapshot.bars.find((bar) => bar.barKey === 'R-2')!;

    expect(disclosureBar).toMatchObject({
      role: 'disclosure',
      mandatory: false,
      passRatings: [],
      grading: { state: 'not-pass', rating: 'healthy' },
    });
    expect(disclosureBar.readiness.codes).not.toContain('bar_snapshot_grading_not_pass');
    expect(snapshot.readiness.codes).not.toContain('bar_snapshot_grading_not_pass');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes)
      .not.toContain('bar_snapshot_grading_not_pass');
  });

  it('CONTROL: a mandatory outcome with a non-pass rating still blocks shipment', () => {
    const input = provedFixture(1);
    const independent = input.scorecards.rows.find((card) => card.issueId === 'SC-GRADE')!;
    independent.ratings['r-1'] = { rating: 'degraded', evidence: 'The outcome is not yet satisfied.' };

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'not-pass', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_not_pass');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(false);
  });

  // D-030 — the repair-then-re-grade dead end. `gradingCurrent` compares only the rubric
  // half (revision + criteriaHash), so a NOT-PASS card whose cited basis was evidence
  // defects stayed `current` forever after those defects were repaired: it stayed
  // `not-pass`, and plan-acceptance-gate returns on not-pass BEFORE the recruiter
  // (`if (!gradingMissing && !gradingStale) return refusal`), so the re-grade its own
  // remediation text asks for could not be summoned by any verb. The trigger is COHORT
  // IDENTITY — what a grader would see — never a timestamp.
  const degrade = (input: AcceptanceBarContractSnapshotInput, why: string) => {
    const card = input.scorecards.rows.find((row) => row.issueId === 'SC-GRADE')!;
    card.ratings['r-1'] = { rating: 'degraded', evidence: why };
    return Date.parse(card.createdAt);
  };
  const addBinding = (
    input: AcceptanceBarContractSnapshotInput,
    at: number,
    patch: Partial<AcceptanceBarEvidenceSource>,
  ) => {
    const base = input.evidence.rows[0]!;
    input.evidence.rows.push({
      ...structuredClone(base),
      ...patch,
      createdAt: new Date(at).toISOString(),
    } as AcceptanceBarEvidenceSource);
  };

  it('stales a non-pass grading when a NEW artifact enters the cohort after grading, so a re-grade can be recruited', () => {
    const input = provedFixture(1);
    const gradedAt = degrade(input, 'The cited artifact did not establish the outcome.');
    addBinding(input, gradedAt + 60_000, { evidenceRef: 'evidence-added-after-grading' });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'stale', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_stale');
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_grading_not_pass');
    // This summons an independent re-grade; it does NOT grant a pass. Still unshippable.
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(false);
    // WI-10002509: the ship door has to know WHICH card was staled, not merely that one
    // was. This card's rubric revision is unchanged, so the door's rubric-identity test
    // reads it as current; without this id it counts as a complete grading and the
    // re-grade asked for one line above is never recruited.
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').staleGradingScorecardId).toBe('SC-GRADE');
  });

  it('stales when an UNEXECUTED binding becomes executed — excluding execution rebuilds the dead end one level down', () => {
    const input = provedFixture(1);
    const gradedAt = degrade(input, 'Attested execution with no run in the ledger.');
    // The cohort the grader saw carried an unexecuted binding; the implementer then does
    // the one repair the gate asks for and actually runs it. Same artifact, new state.
    addBinding(input, gradedAt - 60_000, { evidenceRef: 'evidence-awaiting-a-run', testRunId: null, coverageEvidenceRef: null });
    addBinding(input, gradedAt + 60_000, { evidenceRef: 'evidence-awaiting-a-run', testRunId: 4242 });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'stale', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_stale');
  });

  it('stales an operational grading when artifact content changes at the same evidence path', () => {
    const input = provedFixture(1);
    const base = input.evidence.rows[0]!;
    const evidenceRef = 'docs/evidence/osr-r15-live-2026-09-30.json';
    base.evidenceKind = 'operational';
    base.evidenceRef = evidenceRef;
    base.fingerprints = { ...base.fingerprints, sourceFingerprint: 'a'.repeat(64) };
    const gradedAt = degrade(input, 'The operational artifact did not establish the outcome.');
    addBinding(input, gradedAt + 60_000, {
      evidenceKind: 'operational',
      evidenceRef,
      fingerprints: { ...base.fingerprints, sourceFingerprint: 'b'.repeat(64) },
    });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'stale', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_stale');
  });

  it.each(['sourceFingerprint', 'testFingerprint'] as const)(
    'stales a repo-files cohort when its bound %s changes at the same evidence path',
    (fingerprint) => {
      const input = provedFixture(1);
      const base = input.evidence.rows[0]!;
      const evidenceRef = 'test-run-group:attempt-1:0';
      const currentMeasurement = {
        schemaVersion: 1 as const,
        kind: 'repo-files' as const,
        sourcePaths: ['src/subject.ts'],
        testPaths: ['test/subject.test.ts'],
      };
      base.evidenceRef = evidenceRef;
      base.details = { ...base.details, currentMeasurement };
      base.fingerprints = { ...base.fingerprints, [fingerprint]: 'a'.repeat(64) };
      const gradedAt = degrade(input, 'The measured source or test content did not establish the outcome.');
      addBinding(input, gradedAt + 60_000, {
        evidenceRef,
        details: { ...base.details },
        fingerprints: { ...base.fingerprints, [fingerprint]: 'b'.repeat(64) },
      });

      const snapshot = projectAcceptanceBarContractSnapshot(input);

      expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'stale', rating: 'degraded' });
      expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_stale');
    },
  );

  it('CONTROL: a new testRunId with unchanged repo-files content does not stale a non-pass grading', () => {
    const input = provedFixture(1);
    const base = input.evidence.rows[0]!;
    const evidenceRef = 'test-run-group:attempt-1:0';
    base.evidenceRef = evidenceRef;
    base.details = {
      ...base.details,
      currentMeasurement: {
        schemaVersion: 1,
        kind: 'repo-files',
        sourcePaths: ['src/subject.ts'],
        testPaths: ['test/subject.test.ts'],
      },
    };
    base.fingerprints = {
      ...base.fingerprints,
      sourceFingerprint: 'a'.repeat(64),
      testFingerprint: 'b'.repeat(64),
    };
    const gradedAt = degrade(input, 'A rerun with identical measured content remains the same cohort.');
    addBinding(input, gradedAt + 60_000, {
      evidenceRef,
      testRunId: 4242,
      details: { ...base.details },
      fingerprints: { ...base.fingerprints },
    });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'not-pass', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_not_pass');
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_grading_stale');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').staleGradingScorecardId).toBeNull();
  });

  it('CONTROL: a metadata-only rebind of the SAME artifact does NOT stale — the measured ~3:1 over-trigger stays closed', () => {
    const input = provedFixture(1);
    const gradedAt = degrade(input, 'The outcome is not yet satisfied.');
    // 55 such rebinds happened in one honest afternoon; only 19 moved the artifact set.
    // Keying on "newer than the card" re-rolled a grader for every one of them.
    const base = input.evidence.rows[0]!;
    addBinding(input, gradedAt + 60_000, { evidenceRef: base.evidenceRef });
    addBinding(input, gradedAt + 120_000, { evidenceRef: base.evidenceRef });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'not-pass', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_not_pass');
    // WI-10002509 anti-storm control: an honest unchanged fail names NO stale card, so
    // the ship door keeps counting it and stays terminal instead of re-rolling a grader
    // on every ship attempt.
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').staleGradingScorecardId).toBeNull();
  });

  it('CONTROL: a PASSING grading is untouched by a later cohort change, so repairs do not churn ship-ready bars', () => {
    const input = provedFixture(1);
    const gradedAt = Date.parse(input.scorecards.rows.find((row) => row.issueId === 'SC-GRADE')!.createdAt);
    addBinding(input, gradedAt + 60_000, { evidenceRef: 'evidence-added-after-a-pass' });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'pass' });
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_grading_stale');
  });

  it('keeps historical contracts visible without letting them invalidate a current discharge', () => {
    const input = fixture(1);
    const prior = { ...input.workContracts.rows[0]! };
    input.clauses.rows[0]!.revision = 2;
    input.clauses.rows[0]!.currentRevision = 2;
    input.workContracts.rows[0]!.specRevision = 2;
    input.workContracts.rows.push(prior);
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.workContracts).toHaveLength(2);
    expect(snapshot.bars[0]!.readiness.workContract).toBe('current');
    input.workContracts.rows = [prior];
    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.readiness.workContract).toBe('stale');
  });
  it('projects exact source revisions, per-BAR trace, authoritative grading, and one content hash', () => {
    const input = provedFixture();
    const adequacy = evaluateSpecTestAdequacy({
      clause: input.clauses.rows[0]!,
      evidence: input.evidence.rows,
      classRef: 'plan-class-feature-ship',
      harness: 'papercusp',
      sourceBarTestRequirements: { status: 'not-required' },
    });
    expect(adequacy, JSON.stringify(adequacy.ratings)).toMatchObject({
      requiredProofFloor: 'l3',
      verdict: 'pass',
      wouldBlock: [],
      ratings: {
        falsifiability: { rating: 'pass' },
        'execution-integrity': { rating: 'pass' },
      },
    });
    const coverageRows = input.evidence.rows.filter((row) => row.evidenceKind === 'coverage-census');
    expect(coverageRows).toEqual(expect.arrayContaining(input.clauses.rows.map((clause) =>
      expect.objectContaining({
        specId: clause.specId,
        coverageEvidenceRef: expect.any(Number),
        details: expect.objectContaining({
          adequacy: expect.objectContaining({ targeted: clause.specId, coverageRungs: { l3: true } }),
        }),
      }),
    )));
    const counterexampleRows = input.evidence.rows.filter((row) => row.evidenceKind === 'counterexample');
    expect(counterexampleRows).toEqual(expect.arrayContaining(input.clauses.rows.map((clause, index) =>
      expect.objectContaining({
        specId: clause.specId,
        testRunExecution: expect.objectContaining({
          status: 'fail', passed: 0, failed: 1, collectionFailed: false,
        }),
        testRunProvenance: expect.objectContaining({
          source: 'mutation-probe',
          mutationPhase: 'mutant',
          mutationFailedCaseTitles: ['bar-proof-case-' + (index + 1)],
          mutationFailureLines: [
            'bar-proof-case-' + (index + 1) + ': the pre-fix behavior violates the expected outcome',
          ],
        }),
        details: expect.objectContaining({
          adequacy: expect.objectContaining({ targeted: 'bar-proof-case-' + (index + 1), outcome: 'killed' }),
        }),
      }),
    )));
    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot).toMatchObject({
      schemaVersion: ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION,
      planSlug: 'plan-a',
      applicable: true,
      completeness: { complete: true, truncated: false, problems: [] },
      readiness: { state: 'ready', codes: [], nextRepair: null },
      sourceRevisions: { subjectPlan: 7, rubricPlan: 2 },
      grading: {
        authoritativeScorecardId: 'SC-GRADE',
        gradedBy: 'su-grader',
        selectedVia: 'floor',
        rubricRevision: 2,
        criteriaHash: 'criteria-hash',
        vetting: {
          state: 'current',
          scorecardId: 'SC-VET',
          rubricRevision: 2,
          criteriaHash: 'criteria-hash',
        },
        authorVerdict: {
          state: 'accepted',
          scorecardId: 'SC-AUTHOR',
          verdict: 'accept',
          criteriaHash: 'criteria-hash',
        },
      },
    });
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.bars).toHaveLength(2);
    expect(snapshot.bars[0]).toMatchObject({
      barKey: 'R-1',
      readiness: { state: 'ready', mapping: 'live', method: 'declared', workContract: 'current' },
      proof: { state: 'current', currentEvidence: 3 },
      grading: { state: 'pass', scorecardId: 'SC-GRADE', rating: 'healthy' },
    });
  });

  it('is deterministic when every unordered source arrives in the opposite order', () => {
    const input = fixture(8);
    const first = projectAcceptanceBarContractSnapshot(input);
    const reversed = projectAcceptanceBarContractSnapshot({
      ...input,
      planItems: { ...input.planItems, rows: [...input.planItems.rows].reverse() },
      clauses: { ...input.clauses, rows: [...input.clauses.rows].reverse() },
      workContracts: { ...input.workContracts, rows: [...input.workContracts.rows].reverse() },
      evidence: { ...input.evidence, rows: [...input.evidence.rows].reverse() },
      scorecards: { ...input.scorecards, rows: [...input.scorecards.rows].reverse() },
      vettingScorecards: { ...input.vettingScorecards, rows: [...input.vettingScorecards.rows].reverse() },
      partyByIdentity: new Map([...input.partyByIdentity.entries()].reverse()),
    });

    expect(reversed.contentHash).toBe(first.contentHash);
    expect(reversed.bars).toEqual(first.bars);
  });

  it('accepts a fully exercised outcome and refuses a green module suite for a required integration path', () => {
    const input = provedFixture(1);
    const accepted = projectAcceptanceBarContractSnapshot(input);
    expect(accepted.bars[0]!.proof.adequacy?.state).toBe('pass');
    expect(evaluateAcceptanceBarLifecycle(accepted, 'ship').satisfied).toBe(true);
    input.evidence.rows.filter((row) => row.testRunExecution?.status === 'pass').forEach((row) => {
      row.details.adequacy = { ...(row.details.adequacy as object), testLayer: 'unit' };
      row.testRunExecution = { ...row.testRunExecution!, testLayer: 'unit' };
    });
    const blocked = projectAcceptanceBarContractSnapshot(input);
    expect(blocked.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('correct-layer');
    expect(evaluateAcceptanceBarLifecycle(blocked, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it('refuses a measured negative control that does not target the declared falsifier scenario', () => {
    const input = provedFixture(1);
    const negative = input.evidence.rows.find(row => row.evidenceKind === 'counterexample')!;
    negative.details.adequacy = { ...(negative.details.adequacy as object), targeted: negative.specId };
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.adequacy?.state).not.toBe('pass');
    expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('falsifiability');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it.each(['missing', 'wrong'] as const)('refuses %s canonical scenario coverage despite passing measured tests', kind => {
    const input = provedFixture(1);
    for (const row of input.evidence.rows) {
      row.details.adequacy = { ...(row.details.adequacy as object),
        scenarioIds: kind === 'missing' ? [] : ['unrelated-scenario'] };
    }
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('correct-layer');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it.each(['exempt', 'superseded'] as const)(
    'keeps %s clauses in history without grading them as current BAR proof',
    (lifecycleStatus) => {
      const input = provedFixture(1);
      const activeClause = input.clauses.rows[0]!;
      const baselineCurrentEvidence = projectAcceptanceBarContractSnapshot(input).bars[0]!.proof.currentEvidence;
      const historicalClause: SpecClauseRevision = {
        ...activeClause,
        specId: `${activeClause.specId}-${lifecycleStatus}`,
        lifecycleStatus,
        contentHash: `${activeClause.contentHash}-${lifecycleStatus}`,
        supersedes: null,
        exemption: lifecycleStatus === 'exempt' ? { reason: 'non-behavioral historical clause' } : null,
      };
      if (lifecycleStatus === 'superseded') {
        activeClause.supersedes = { specId: historicalClause.specId, revision: historicalClause.revision };
      }
      input.clauses.rows.push(historicalClause);
      const activeEvidence = input.evidence.rows[0]!;
      input.evidence.rows.push({
        ...activeEvidence,
        id: 99,
        workItemId: 'WI-HISTORICAL',
        specId: historicalClause.specId,
        specFingerprint: historicalClause.contentHash,
        evidenceRef: `historical:${lifecycleStatus}`,
        bindingFingerprint: `binding-historical-${lifecycleStatus}`,
        details: {
          ...activeEvidence.details,
          adequacy: { ...(activeEvidence.details.adequacy as object), outcome: 'failed' },
        },
      });

      const snapshot = projectAcceptanceBarContractSnapshot(input);
      const bar = snapshot.bars[0]!;

      expect(bar.proof.adequacy).toMatchObject({ state: 'pass', checks: [{ specId: activeClause.specId }] });
      expect(bar.proof.adequacy?.checks.map((check) => check.specId)).toEqual([activeClause.specId]);
      expect(bar.proof.currentEvidence).toBe(baselineCurrentEvidence);
      expect(bar.mappings.map((mapping) => mapping.specId)).toContain(historicalClause.specId);
      expect(bar.proof.history?.map((row) => row.evidenceRef)).toContain(`historical:${lifecycleStatus}`);
      expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(true);
    },
  );

  // WI-10003187 (measured on p2p-join-catchup-speed-2026-09-23): every revision of an
  // AUTO-BAR clause was `draft` while its bound proof matched the current revision and
  // fingerprint exactly. The gate said proof_stale + proof_inadequate and told the author to
  // re-prove, which can never clear it; one lifecycle-only promotion shipped the plan.
  function neverAcceptedFixture(): AcceptanceBarContractSnapshotInput {
    const input = provedFixture(1);
    for (const clause of input.clauses.rows) {
      clause.lifecycleStatus = 'draft';
      clause.acceptedBy = null;
      clause.acceptedAt = null;
    }
    return input;
  }

  it('names a never-accepted clause instead of calling its current proof stale and inadequate', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(neverAcceptedFixture());
    const bar = snapshot.bars[0]!;

    expect(bar.readiness.clauseAcceptance).toBe('not-accepted');
    expect(bar.readiness.codes).toContain('bar_snapshot_clause_not_accepted');
    expect(bar.readiness.codes).not.toContain('bar_snapshot_proof_stale');
    expect(bar.readiness.codes).not.toContain('bar_snapshot_proof_inadequate');
    expect(bar.readiness.codes).not.toContain('bar_snapshot_proof_depth_missing');

    const ship = evaluateAcceptanceBarLifecycle(snapshot, 'ship');
    expect(ship.satisfied).toBe(false);
    expect(ship.codes).toContain('bar_snapshot_clause_not_accepted');
    expect(ship.codes).not.toContain('bar_snapshot_proof_stale');
    expect(ship.codes).not.toContain('bar_snapshot_proof_inadequate');
    expect(ship.nextRepair).toMatchObject({ code: 'bar_snapshot_clause_not_accepted', barKey: 'R-1' });
    expect(ship.nextRepair?.action).toMatch(/lifecycleStatus:"active"/);
    expect(ship.nextRepair?.action).toMatch(/sourceBar/);
    expect(ship.nextRepair?.action).toMatch(/Do NOT re-prove/);
  });

  it('CONTROL: the same proof on an accepted clause ships — the lifecycle, not the proof, was the gap', () => {
    const input = neverAcceptedFixture();
    input.clauses.rows[0]!.lifecycleStatus = 'active';
    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.clauseAcceptance).toBe('accepted');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(true);
  });

  it('does not block any door before ship on a seeded draft clause', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(neverAcceptedFixture());

    for (const phase of ['pre-start', 'pre-vetting', 'pre-grading'] as const) {
      expect(evaluateAcceptanceBarLifecycle(snapshot, phase).codes).not.toContain('bar_snapshot_clause_not_accepted');
    }
  });

  it('keeps proof_missing for a never-accepted clause with no evidence at all', () => {
    const input = neverAcceptedFixture();
    input.evidence.rows.length = 0;
    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).toEqual(
      expect.arrayContaining(['bar_snapshot_clause_not_accepted', 'bar_snapshot_proof_missing']),
    );
    // Accept first: the promotion carries whatever is bound, so binding before it is not wasted,
    // but the ranked repair should still lead with the one-call lifecycle gap.
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').nextRepair?.code).toBe('bar_snapshot_clause_not_accepted');
  });

  it('does not report a never-accepted clause when one sibling clause is enforceable', () => {
    const input = provedFixture(1);
    const accepted = input.clauses.rows[0]!;
    input.clauses.rows.push({
      ...accepted,
      specId: `${accepted.specId}-draft`,
      contentHash: `${accepted.contentHash}-draft`,
      lifecycleStatus: 'draft',
      acceptedBy: null,
      acceptedAt: null,
    });
    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.clauseAcceptance).toBe('accepted');
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_clause_not_accepted');
    // WI-10003864: every mapping carries its clause lifecycle, so a per-mapping consumer
    // (deriveNonCodeItemProofs) can skip the ones this snapshot never proves.
    expect(snapshot.bars[0]!.mappings.map((mapping) => [mapping.specId, mapping.lifecycleStatus])).toEqual(
      expect.arrayContaining([
        [accepted.specId, accepted.lifecycleStatus],
        [`${accepted.specId}-draft`, 'draft'],
      ]),
    );
  });

  it('keeps the old proof codes for a pre-field snapshot that carries no clauseAcceptance', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(neverAcceptedFixture());
    // Model a snapshot written before WI-10003187: no field, and the code was never emitted.
    const readiness = snapshot.bars[0]!.readiness;
    delete readiness.clauseAcceptance;
    readiness.codes = readiness.codes.filter((code) => code !== 'bar_snapshot_clause_not_accepted');

    const codes = evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes;
    expect(codes).not.toContain('bar_snapshot_clause_not_accepted');
    expect(codes).toContain('bar_snapshot_proof_stale');
  });

  it('does not invent an automated proof floor for a non-automated delivery-plane clause', () => {
    const input = fixture(1);
    input.clauses.rows[0]!.behaviorClass = 'non-automated';
    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]).toMatchObject({ behaviorClass: 'non-automated', requiredTestLayers: [] });
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_proof_depth_missing');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes)
      .not.toContain('bar_snapshot_proof_depth_missing');
  });

  it('requires current file proof when a live-plane BAR declares a tests check without layers', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.evidencePlane = 'live';
    input.rubrics.rows[0]!.criteria[0]!.check = {
      kind: 'tests',
      files: ['packages/operator-core/lib/acceptance-bar-contract-snapshot.test.ts'],
    };
    input.clauses.rows[0]!.behaviorClass = 'non-automated';

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.automatedProofRequired).toBe(true);
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_proof_inadequate');
  });

  // An EXPLICITLY manual BAR (check instrument:'none') must not carry an automated proof
  // floor even on the `tree` plane, where acceptanceBarBehaviorClass projects every clause
  // as `happy-path`. Before this, such a criterion was unshippable by construction: the
  // only escapes were declaring test layers it does not have (which also mutates barHash,
  // breaking the pin) or demoting a mandatory outcome to `disclosure` — both false.
  it('does not invent an automated proof floor for an explicitly manual tree-plane BAR', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.check = { kind: 'instrument', instrumentKey: 'none' };
    // Deliberately left as the production shape: tree plane, happy-path clause, no layers.
    expect(input.clauses.rows[0]!.behaviorClass).toBe('happy-path');

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    // Measured: the manual BAR carries NO readiness codes at all once the exemption applies.
    expect(effectiveCriterionInstrumentKey(input.rubrics.rows[0]!.criteria[0]!)).toBe('none');
    expect(snapshot.bars[0]!.automatedProofRequired).toBe(false);
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_proof_depth_missing');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes)
      .not.toContain('bar_snapshot_proof_depth_missing');
  });

  it('keeps an explicitly manual BAR manual before clauses are projected', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.check = { kind: 'instrument', instrumentKey: 'none' };
    input.clauses.rows = [];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.automatedProofRequired).toBe(false);
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_proof_depth_missing');
  });

  // ANTI-LOOPHOLE (both directions). The exemption is keyed to an explicit authored
  // instrument:'none'; an ordinary automated BAR keeps its floor, so this cannot become a
  // general way to skip proof depth.
  it('requires current file proof for a tree-plane BAR that declares a structured test check without layers', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.check = {
      kind: 'tests',
      files: ['packages/operator-core/lib/acceptance-bar-contract-snapshot.test.ts'],
    };

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_proof_inadequate');
  });

  // FAILS CLOSED: an instrument:'none' criterion whose CLAUSE still declares an automated
  // obligation keeps the floor, matching the mixed-projection rule above it. Measured: the
  // floor is kept as `proof_depth_missing`, because `adequacyState` reads the CRITERION's
  // requiredTestLayers (still empty here), not the clause's.
  it('keeps the proof floor when a manual BAR has a clause declaring a test layer', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.check = { kind: 'instrument', instrumentKey: 'none' };
    input.clauses.rows[0]!.requiredTestLayers = ['unit'];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_proof_depth_missing');
  });

  it.each([false, true])('uses current evidence across planes for mixed-layer adequacy on a live BAR (nested=%s)', (nested) => {
    const input = provedFixture(1);
    const criterion = input.rubrics.rows[0]!.criteria[0]!;
    const clause = input.clauses.rows[0]!;
    criterion.evidencePlane = 'live';
    criterion.requiredTestLayers = ['unit', 'e2e'];
    criterion.barHash = computeAcceptanceBarHash(criterion);
    const barSetHash = computeAcceptanceBarSetHash([criterion]);
    input.rubrics.rows[0]!.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    clause.requiredTestLayers = ['unit', 'e2e'];
    clause.sourceBar!.barHash = criterion.barHash;
    clause.sourceBar!.barSetHash = barSetHash;
    clause.sourceBar!.evidencePlane = 'live';

    const treeUnit = input.evidence.rows[0]!;
    treeUnit.details = {
      ...(!nested ? { evidencePlane: 'tree' } : {}),
      adequacy: { ...(treeUnit.details.adequacy as object), testLayer: 'unit', ...(nested ? { evidencePlane: 'tree' } : {}) },
    };
    treeUnit.testRunExecution = { ...treeUnit.testRunExecution!, testLayer: 'unit' };
    const liveE2e = {
      ...treeUnit,
      id: 99,
      testRunId: 99,
      evidenceRef: 'test:e2e',
      bindingFingerprint: 'binding-e2e',
      details: {
        ...(!nested ? { evidencePlane: 'live' } : {}),
        adequacy: { ...(treeUnit.details.adequacy as object), testLayer: 'e2e', ...(nested ? { evidencePlane: 'live' } : {}) },
      },
    };
    liveE2e.testRunExecution = { ...treeUnit.testRunExecution!, testLayer: 'e2e' };
    input.evidence.rows = [treeUnit, liveE2e, ...input.evidence.rows.slice(1)];

    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.adequacy).toMatchObject({
      state: 'pass',
      checks: [expect.objectContaining({ verdict: 'pass' })],
    });
    expect(snapshot.bars[0]!.proof.evidencePlanes).toEqual(['live', 'tree']);
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).not.toContain('bar_snapshot_proof_inadequate');
  });

  it('surfaces a missing declared evidence plane without blocking pre-start', () => {
    const input = provedFixture(1);
    const bar = input.rubrics.rows[0]!.criteria[0]!;
    const clause = input.clauses.rows[0]!;
    bar.evidencePlane = 'live';
    bar.barHash = computeAcceptanceBarHash(bar);
    const barSetHash = computeAcceptanceBarSetHash([bar]);
    input.rubrics.rows[0]!.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    clause.sourceBar!.barHash = bar.barHash;
    clause.sourceBar!.barSetHash = barSetHash;
    clause.sourceBar!.evidencePlane = 'live';

    const snapshot = projectAcceptanceBarContractSnapshot(input);
    const preStart = evaluateAcceptanceBarLifecycle(snapshot, 'pre-start');
    const ship = evaluateAcceptanceBarLifecycle(snapshot, 'ship');

    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_evidence_plane_unmet');
    expect(snapshot.readiness.codes).toContain('bar_snapshot_evidence_plane_unmet');
    expect(snapshot.readiness.nextRepair).toMatchObject({
      code: 'bar_snapshot_evidence_plane_unmet',
      barKey: 'R-1',
    });
    expect(preStart.codes).not.toContain('bar_snapshot_evidence_plane_unmet');
    expect(ship.blockingBars).toEqual(expect.arrayContaining([
      expect.objectContaining({
        barKey: 'R-1',
        codes: expect.arrayContaining(['bar_snapshot_evidence_plane_unmet']),
      }),
    ]));
  });

  // EI-27140397957005977: the plane is read from CURRENT rows only, so a plane whose only proof
  // went stale (a pinned path moved, e.g. after a bg-host restart) reads as unmet. The repair used
  // to say only "record evidence", which hid that the proof exists and needs a re-measure.
  it('names the stale-proof diagnosis when the declared plane has only stale proof', () => {
    const input = provedFixture(1);
    const bar = input.rubrics.rows[0]!.criteria[0]!;
    const clause = input.clauses.rows[0]!;
    bar.evidencePlane = 'live';
    bar.barHash = computeAcceptanceBarHash(bar);
    const barSetHash = computeAcceptanceBarSetHash([bar]);
    input.rubrics.rows[0]!.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    clause.sourceBar!.barHash = bar.barHash;
    clause.sourceBar!.barSetHash = barSetHash;
    clause.sourceBar!.evidencePlane = 'live';
    const base = input.evidence.rows[0]!;
    const staleLive: AcceptanceBarEvidenceSource = {
      ...base,
      id: 98,
      testRunId: 98,
      evidenceRef: 'test:live-stale',
      bindingFingerprint: 'binding-live-stale',
      details: { ...base.details, evidencePlane: 'live' },
      currentness: { ...base.currentness, overall: 'stale', staleReasons: ['source-stale'] },
    };
    input.evidence.rows = [...input.evidence.rows, staleLive];

    const snapshot = projectAcceptanceBarContractSnapshot(input);
    const trace = snapshot.bars[0]!;
    // The plane HAS proof, but it is stale, so it does not count: the case the old text hid.
    expect(trace.proof.history?.some((row) => row.id === 98 && row.currentness.overall === 'stale')).toBe(true);
    expect(trace.proof.evidencePlanes).not.toContain('live');
    expect(trace.readiness.codes).toContain('bar_snapshot_evidence_plane_unmet');
    expect(snapshot.readiness.nextRepair).toMatchObject({ code: 'bar_snapshot_evidence_plane_unmet', barKey: 'R-1' });
    expect(snapshot.readiness.nextRepair?.action).toContain(STALE_PROOF_DIAGNOSIS);
  });

  it('names where to read why proof went stale, and the same-revision re-measure, on both stale codes', () => {
    expect(STALE_PROOF_DIAGNOSIS).toMatch(/plans:get-spec-evidence \{ specIds, detail:"full" \}/);
    expect(STALE_PROOF_DIAGNOSIS).toMatch(/currentness\.staleReasons/);
    expect(STALE_PROOF_DIAGNOSIS).toMatch(/serverMeasurement\.movedPaths/);
    expect(STALE_PROOF_DIAGNOSIS).toMatch(/\{ fromTestRun \}/);
    for (const code of ['bar_snapshot_proof_stale', 'bar_snapshot_evidence_plane_unmet'] as const) {
      const repair = nextRepair([code], [{ barKey: 'R-1', readiness: { codes: [code] } }]);
      expect(repair).toMatchObject({ code, barKey: 'R-1' });
      expect(repair?.action).toContain(STALE_PROOF_DIAGNOSIS);
    }
    expect(nextRepair(['bar_snapshot_proof_stale'], [{ barKey: 'R-1', readiness: { codes: ['bar_snapshot_proof_stale'] } }])?.action)
      .toMatch(/^Re-prove the current spec revision; superseded proof does not cover it\./);
  });

  it.each([
    ['unreachable', { pathReachable: false }], ['skipped', { skipped: true }],
    ['failed', { outcome: 'failed' }], ['self-oracle', { oracleIndependent: false }],
  ])('refuses %s proof even when the independent rating claims success', (_name, patch) => {
    const input = provedFixture(1);
    input.evidence.rows.forEach((row) => {
      if (_name === 'skipped' && row.evidenceKind !== 'test') return;
      row.details.adequacy = { ...(row.details.adequacy as object), ...patch };
      if (_name === 'skipped' && row.testRunExecution) {
        // A binder's skipped bit is not canonical evidence. Measure the skip on
        // test_runs and leave the declared case unaccounted for in passed titles.
        row.testRunExecution = { ...row.testRunExecution, skipped: 1, passedCaseTitles: [] };
      }
    });
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.grading.state).toBe('pass');
    if (_name === 'skipped') {
      expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('execution-integrity');
    }
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it('does not treat absent freshness comparisons as current proof', () => {
    const input = provedFixture(1);
    const unknownCurrentness = fixture(1).evidence.rows[0]!.currentness;
    input.evidence.rows.forEach((row) => { row.currentness = structuredClone(unknownCurrentness); });
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('freshness');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(false);
  });

  it('keeps failed history after a successful revision without borrowing its evidence plane', () => {
    const input = provedFixture(1);
    const historical = { ...input.evidence.rows[0]!, id: 99, evidenceRef: 'old-live-failure', specRevision: 0,
      details: { evidencePlane: 'live', adequacy: { outcome: 'failed' } } };
    input.evidence.rows.push(historical);
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.evidenceRefs).toContain('old-live-failure');
    expect(snapshot.bars[0]!.proof.evidencePlanes).toEqual(['tree']);
    expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('pass');
    expect(snapshot.bars[0]!.proof.staleEvidence).toBe(1);
    expect(snapshot.bars[0]!.proof.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceRef: 'old-live-failure', specRevision: 0, matchesCurrentSpec: false,
        details: { evidencePlane: 'live', adequacy: { outcome: 'failed' } } }),
      expect.objectContaining({ specRevision: 1, matchesCurrentSpec: true, currentness: { ...input.evidence.rows[0]!.currentness } }),
    ]));
  });

  it.each(['pass', 'failed', 'unknown', 'pending', 'stale'])(
    'shipment selects the latest equivalent registered attempt (%s), retaining immutable history', outcome => {
      const input = provedFixture(1);
      const base = input.evidence.rows[0]!;
      const makeAttempt = (n: number, result: string): AcceptanceBarEvidenceSource[] => {
        // Prepare and finish describe the same measured file and scenario set.
        const scenarioIds = (base.details.adequacy as { scenarioIds: string[] }).scenarioIds;
        const binding = { specId: base.specId, specRevision: base.specRevision,
          testPath: base.testRunProvenance!.filePath, sourcePaths: ['src/journey.ts'],
          testLayer: 'integration', scenarioIds };
        const pending = { ...base, id: n * 10, evidenceRef: `test-run-group:attempt-${n}:0`, testRunId: null,
          details: { currentMeasurement: { schemaVersion: 1, kind: 'repo-files',
            testPaths: [binding.testPath], sourcePaths: binding.sourcePaths },
          testExecution: { schemaVersion: 1, phase: 'pending', originRunId: `attempt-${n}`, binding },
          adequacy: { testLayer: 'integration', scenarioIds, outcome: 'pending', executed: false, collected: false } } };
        return [pending, ...(result === 'pending' ? [] : [{ ...pending, id: n * 10 + 1, testRunId: n,
          details: { ...pending.details, evidencePlane: 'tree',
            testExecution: { ...pending.details.testExecution, phase: 'settled' },
            adequacy: { ...(base.details.adequacy as object), outcome: result } },
          testRunExecution: result === 'failed'
            ? { ...base.testRunExecution!, status: 'fail', passed: 0, failed: 1 }
            : result === 'unknown'
              ? null
              : base.testRunExecution,
        }])];
      };
      const old = makeAttempt(1, outcome === 'pass' ? 'unknown' : 'pass');
      const fresh = makeAttempt(2, outcome === 'stale' ? 'pass' : outcome);
      if (outcome === 'stale') fresh[1]!.currentness = { ...fresh[1]!.currentness, overall: 'stale',
        staleReasons: ['source-fingerprint-changed'] };
      input.evidence.rows = [...old, ...fresh, ...input.evidence.rows.slice(1)];
      if (outcome === 'pass') input.evidence.rows.push({ ...old[1]!, id: 99,
        evidenceKind: 'counterexample', evidenceRef: 'manual-negative-controls:old',
        currentness: { ...old[1]!.currentness, overall: 'stale', staleReasons: ['source-stale'] } });
      const before = JSON.stringify(input.evidence.rows);
      const snapshot = projectAcceptanceBarContractSnapshot(input);
      expect(JSON.stringify(input.evidence.rows)).toBe(before);
      expect(snapshot.bars[0]!.proof.history).toHaveLength(input.evidence.rows.length);
      if (outcome !== 'pending') {
        expect(snapshot.bars[0]!.proof.history?.find(row => row.id === old[1]!.id)?.activeAttempt).toBe(false);
        expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.evidenceRefs).not.toContain(old[1]!.evidenceRef);
      }
      if (outcome === 'pass') {
        expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('pass');
        expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).not.toContain('bar_snapshot_proof_inadequate');
      } else {
        expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock)
          .toContain(outcome === 'stale' ? 'freshness' : 'execution-integrity');
        expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
      }
    },
  );

  it('fails source completeness when BAR meaning no longer matches the server hash', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.model = 'Quietly rewritten outcome.';

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.completeness.complete).toBe(false);
    expect(snapshot.completeness.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch', barKey: 'R-1' })]),
    );
  });

  // EI-23525318282609167: the emitter always sets barKey, and the assertion above
  // proves it — but per-bar readiness.codes used to be derived INDEPENDENTLY of
  // `problems`, so the hash-integrity codes reached the contract level and never
  // reached the BAR. Two consequences, and the second is the dangerous one:
  // nextRepair's `bars.find(...)` missed and reported barKey:null, AND a BAR whose
  // meaning no longer matches its stored hash reported state:'ready'. Measured live
  // on acceptance-unified-requirement-contract-2026-09-05: six mismatching BARs all
  // reported clean while the contract said "0 of 6 BAR(s) blocking".
  it('attributes a BAR hash mismatch to the BAR itself, not only to the contract', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.model = 'Quietly rewritten outcome.';

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    const bar = snapshot.bars.find((candidate) => candidate.barKey === 'R-1');
    expect(bar).toBeDefined();
    // The BAR must not report itself clean while its meaning and hash diverge.
    expect(bar!.readiness.codes).toContain('bar_snapshot_bar_hash_mismatch');
    expect(bar!.readiness.state).toBe('blocked');
    // ...and the ranked repair must name a target an operator can act on.
    expect(snapshot.readiness.nextRepair).toEqual(
      expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch', barKey: 'R-1' }),
    );
  });

  it('accepts exactly 200 BARs and refuses + marks truncation at 201', () => {
    const atLimit = projectAcceptanceBarContractSnapshot(fixture(200));
    expect(atLimit.bars).toHaveLength(200);
    expect(atLimit.completeness.truncated).toBe(false);
    expect(atLimit.completeness.problems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_bar_set_too_large' })]),
    );

    const overLimit = projectAcceptanceBarContractSnapshot(fixture(201));
    expect(overLimit.bars).toHaveLength(200);
    expect(overLimit.completeness.truncated).toBe(true);
    expect(overLimit.completeness.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_bar_set_too_large' })]),
    );
  });

  it('distinguishes exactly-at-limit from over-limit for every bounded source', () => {
    const input = fixture(1);
    input.clauses = { ...input.clauses, limit: input.clauses.rows.length, truncated: false };
    expect(projectAcceptanceBarContractSnapshot(input).completeness.complete).toBe(true);

    input.clauses = { ...input.clauses, truncated: true };
    const over = projectAcceptanceBarContractSnapshot(input);
    expect(over.completeness.complete).toBe(false);
    expect(over.completeness.truncated).toBe(true);
    expect(over.readiness.nextRepair?.code).toBe('bar_snapshot_source_truncated');
  });
});

describe('AcceptanceBarContractSnapshot — fixed-call loader', () => {
  it('calls every batch reader once for a 200-BAR plan (no per-BAR/N+1 reads)', async () => {
    const source = fixture(200);
    const deps: AcceptanceBarSnapshotDeps = {
      readPlans: vi.fn(async () => source.planRows),
      readRubrics: vi.fn(async () => source.rubrics),
      readPlanItems: vi.fn(async () => source.planItems),
      readClauses: vi.fn(async () => source.clauses),
      readWorkContracts: vi.fn(async () => source.workContracts),
      readEvidence: vi.fn(async () => source.evidence),
      readLineage: vi.fn(async () => source.lineage),
      readScorecards: vi.fn(async () => source.scorecards),
      readVettingScorecards: vi.fn(async () => source.vettingScorecards),
      readParties: vi.fn(async () => new Map(source.partyByIdentity)),
      readGraderSelectionVia: vi.fn(async () => new Map(source.graderSelectionVia)),
    };

    const snapshot = await readAcceptanceBarContractSnapshot('plan-a', deps);

    expect(snapshot.bars).toHaveLength(200);
    for (const reader of Object.values(deps)) expect(reader).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('isolates timing observer failures from the verdict (source failure: %s)', async sourceFails => {
    const source = fixture(1);
    const deps: AcceptanceBarSnapshotDeps = {
      readPlans: async () => source.planRows,
      readRubrics: async () => source.rubrics,
      readPlanItems: async () => source.planItems,
      readClauses: async () => {
        if (sourceFails) throw new Error('clause read down');
        return source.clauses;
      },
      readWorkContracts: async () => source.workContracts,
      readEvidence: async () => source.evidence,
      readLineage: async () => source.lineage,
      readScorecards: async () => source.scorecards,
      readVettingScorecards: async () => source.vettingScorecards,
      readCurrentCritique: async () => null,
      readParties: async () => new Map(source.partyByIdentity),
      readGraderSelectionVia: async () => new Map(source.graderSelectionVia),
    };
    const baseline = await readAcceptanceBarContractSnapshot('plan-a', deps);
    const timings: Array<[string, number]> = [];
    const observed = await readAcceptanceBarContractSnapshot('plan-a', deps, {
      onRead(source, elapsedMs) {
        timings.push([source, elapsedMs]);
        throw new Error('diagnostic sink unavailable');
      },
    });
    expect(observed.readiness).toEqual(baseline.readiness);
    expect(observed.completeness).toEqual(baseline.completeness);
    expect(timings).toContainEqual(['clauses', expect.any(Number)]);
    expect(timings.every(([, elapsedMs]) => Number.isFinite(elapsedMs) && elapsedMs >= 0)).toBe(true);
    expect(observed.completeness.complete).toBe(!sourceFails);
  });

  it('turns a reader failure into an explicit unavailable source and blocked repair', async () => {
    const source = fixture(1);
    const snapshot = await readAcceptanceBarContractSnapshot('plan-a', {
      readPlans: async () => source.planRows,
      readRubrics: async () => source.rubrics,
      readPlanItems: async () => source.planItems,
      readClauses: async () => {
        throw new Error('clause read down');
      },
      readWorkContracts: async () => source.workContracts,
      readEvidence: async () => source.evidence,
      readLineage: async () => source.lineage,
      readScorecards: async () => source.scorecards,
      readVettingScorecards: async () => source.vettingScorecards,
      readParties: async () => new Map(source.partyByIdentity),
      readGraderSelectionVia: async () => new Map(source.graderSelectionVia),
    });

    expect(snapshot.completeness.complete).toBe(false);
    expect(snapshot.completeness.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_source_unavailable', source: 'clauses' })]),
    );
    expect(snapshot.readiness.nextRepair?.code).toBe('bar_snapshot_source_unavailable');
  });
});

describe('AcceptanceBarContractSnapshot — semantic dry-run diff', () => {
  it('lets the canonical amendment candidate repair a legacy structured-check hash only when next hashes validate', () => {
    const input = fixture(1);
    const stored = input.rubrics.rows[0]!;
    const prior = stored.criteria[0]!;
    const legacyHash = prior.barHash!;
    const legacyCriterion: RubricCriterion = {
      ...prior,
      check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
      // Models a row written by the pre-EI-22795002901203049 hash function,
      // which did not bind the already-persisted structured check.
      barHash: legacyHash,
    };
    stored.criteria[0] = legacyCriterion;
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.completeness.problems).toContainEqual(
      expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch', barKey: 'R-1' }),
    );

    const repairedCriterion = {
      ...legacyCriterion,
      barHash: computeAcceptanceBarHash(legacyCriterion),
    };
    const repairedSetHash = computeAcceptanceBarSetHash([repairedCriterion]);
    const desiredMappings = new Map([['R-1', { planItemIds: ['P-001'] }]]);
    const itemStatuses = new Map([['P-001', 'done']]);
    const contract = {
      rubricRevision: 3,
      subjectPlanRevision: 8,
      barSetHash: repairedSetHash,
      barContract: { ...stored.barContract!, subjectPlanRevision: 8 },
    };
    const repaired = buildAcceptanceBarAmendmentCandidate(
      snapshot,
      [repairedCriterion],
      desiredMappings,
      itemStatuses,
      contract,
    );
    expect(repaired.completeness.problems).not.toContainEqual(
      expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch' }),
    );
    expect(evaluateAcceptanceBarLifecycle(repaired, 'pre-vetting').satisfied).toBe(true);

    const malformedCriterion = { ...repairedCriterion, barHash: '0'.repeat(64) };
    const malformed = buildAcceptanceBarAmendmentCandidate(
      snapshot,
      [malformedCriterion],
      desiredMappings,
      itemStatuses,
      { ...contract, barSetHash: computeAcceptanceBarSetHash([malformedCriterion]) },
    );
    expect(malformed.completeness.problems).toContainEqual(
      expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch' }),
    );
    expect(evaluateAcceptanceBarLifecycle(malformed, 'pre-vetting').satisfied).toBe(false);
  });

  it('keeps a METHOD-only edit distinct and does not require BAR amendment', () => {
    const before = projectAcceptanceBarContractSnapshot(fixture(1));
    const after = structuredClone(before);
    after.bars[0]!.method = 'A better runbook.';

    const diff = diffAcceptanceBarContractSnapshots(before, after, 'amend');

    expect(diff.changed).toBe(true);
    expect(diff.requiresAmendment).toBe(false);
    expect(diff.changes).toEqual([
      expect.objectContaining({ barKey: 'R-1', kinds: ['method-only'], fields: ['method'] }),
    ]);
  });

  it.each(['add', 'replace', 'remove'] as const)(
    'keeps a replication-only %s visible in the shared diff and full-replacement review excerpt (EI-26146508253136257)',
    (operation) => {
      const input = fixture(3);
      const rubric = input.rubrics.rows[0]!;
      // Force the real excerpt path with an unchanged prefix, rather than a small
      // patch that happens to show the omitted replication change in full.
      rubric.criteria[0]!.method = 'An unchanged detailed procedure. '.repeat(120);
      rubric.criteria[1]!.replication = operation === 'add' ? undefined : 'Original replication drill.';
      const before = projectAcceptanceBarContractSnapshot(input);
      const nextCriteria = rubric.criteria.map((criterion) => criterion.barKey === 'R-2'
        ? { ...criterion, replication: operation === 'remove' ? undefined : 'Run the revised replication drill.' }
        : criterion);
      const candidate = buildAcceptanceBarAmendmentCandidate(
        before,
        nextCriteria,
        new Map(before.bars.map((bar) => [bar.barKey, { planItemIds: bar.mappings.map((mapping) => mapping.planItemId) }])),
        new Map(input.planItems.rows.map((item) => [item.itemId, item.status])),
        {
          rubricRevision: 3,
          subjectPlanRevision: 8,
          barSetHash: computeAcceptanceBarSetHash(nextCriteria),
          barContract: { ...rubric.barContract!, subjectPlanRevision: 8 },
        },
      );
      const diff = diffAcceptanceBarContractSnapshots(before, candidate, 'amend');
      const approval = {
        schemaVersion: 1,
        kind: 'acceptance-bar-amendment-approval',
        rubricRef: rubric.rubricId,
        subjectPlan: rubric.subjectPlan!,
        proposedPatchHash: 'c'.repeat(64),
        bars: [],
      } as const;
      const brief = buildAmendmentReviewBrief({
        rubricRef: rubric.rubricId,
        previewPostRef: 'thread-post:42',
        preview: { approval: { ...approval, bars: [] }, changes: diff.changes },
        patch: { criteria: nextCriteria },
      });
      const excerpt = JSON.parse(brief.split('```json\n')[1]!.split('\n```')[0]!);

      expect(candidate.bars.map((bar) => bar.barHash)).toEqual(before.bars.map((bar) => bar.barHash));
      expect(computeAcceptanceBarSetHash(nextCriteria)).toBe(rubric.barSetHash);
      expect(diff).toMatchObject({ changed: true, requiresAmendment: false });
      expect(diff.changes).toEqual([{ barKey: 'R-2', kinds: ['method-only'], fields: ['replication'] }]);
      expect(brief).toContain('Changed BARs: R-2 (method-only: replication).');
      expect(excerpt.changedCriteria).toEqual([JSON.parse(JSON.stringify(nextCriteria[1]))]);
      expect(excerpt.omittedUnchangedBarKeys).toEqual(['R-1', 'R-3']);
      expect(excerpt).not.toHaveProperty('criteria');
      expect(brief).toContain('must not be submitted to rubrics:amend');
      expect(brief).toContain(JSON.stringify(approval));
    },
  );

  it('reports changed requirement intent in the amendment candidate diff', () => {
    const input = fixture(1);
    const rubric = input.rubrics.rows[0]!;
    rubric.criteria[0]!.intent = {
      request: 'The original acceptance request.',
      constraints: ['Preserve the acceptance contract.'],
      rationale: 'New references are part of the signed BAR intent.',
      sourceRefs: ['D-021 §1-3', 'D-024 §1-5', 'D-027 §1-5'],
    };
    const before = projectAcceptanceBarContractSnapshot(input);
    const changedCriterion: RubricCriterion = {
      ...rubric.criteria[0]!,
      intent: {
        ...rubric.criteria[0]!.intent!,
        request: 'Keep the amended source lineage explicit.',
      },
      evidenceRuntime: 'desktop-shell',
      method: 'Inspect the amended source references.',
    };
    changedCriterion.barHash = computeAcceptanceBarHash(changedCriterion);

    const candidate = buildAcceptanceBarAmendmentCandidate(
      before,
      [changedCriterion],
      new Map([['R-1', { planItemIds: ['P-001'] }]]),
      new Map([['P-001', 'done']]),
      {
        rubricRevision: 3,
        subjectPlanRevision: 8,
        barSetHash: computeAcceptanceBarSetHash([changedCriterion]),
        barContract: { ...rubric.barContract!, subjectPlanRevision: 8 },
      },
    );

    const diff = diffAcceptanceBarContractSnapshots(before, candidate, 'amend');

    expect(diff.changes).toEqual([
      expect.objectContaining({
        barKey: 'R-1',
        kinds: ['bar-meaning', 'method-only'],
        fields: ['evidenceRuntime', 'intent.request', 'method'],
      }),
    ]);

    const brief = buildAmendmentReviewBrief({
      rubricRef: rubric.rubricId,
      previewPostRef: 'thread-post:42',
      preview: {
        approval: {
          schemaVersion: 1,
          kind: 'acceptance-bar-approval',
          rubricRef: rubric.rubricId,
          bars: [{ barKey: 'R-1' }],
        } as never,
        changes: diff.changes,
      },
      patch: { criteria: [changedCriterion] },
    });
    expect(brief).toContain('Changed BARs: R-1 (bar-meaning+method-only: evidenceRuntime, intent.request, method).');
  });

  it('names a required proof-layer change instead of reporting a hash-only BAR amendment', () => {
    const before = projectAcceptanceBarContractSnapshot(fixture(1));
    const after = structuredClone(before);
    after.bars[0]!.requiredTestLayers = ['integration'];

    const diff = diffAcceptanceBarContractSnapshots(before, after, 'amend');

    expect(diff.requiresAmendment).toBe(true);
    expect(diff.changes).toEqual([
      expect.objectContaining({
        barKey: 'R-1',
        kinds: ['bar-meaning'],
        fields: ['requiredTestLayers'],
      }),
    ]);
  });

  it('names a structured-check change in a BAR amendment preview', () => {
    const beforeInput = fixture(1);
    const afterInput = fixture(1);
    const changedCriterion = afterInput.rubrics.rows[0]!.criteria[0]!;
    changedCriterion.check = {
      kind: 'tests',
      files: ['packages/operator-core/lib/acceptance-bar-contract-snapshot.test.ts'],
    };
    changedCriterion.barHash = computeAcceptanceBarHash(changedCriterion);

    const diff = diffAcceptanceBarContractSnapshots(
      projectAcceptanceBarContractSnapshot(beforeInput),
      projectAcceptanceBarContractSnapshot(afterInput),
      'amend',
    );

    expect(diff.changes).toEqual([
      expect.objectContaining({ barKey: 'R-1', kinds: ['bar-meaning'], fields: ['check'] }),
    ]);
  });

  it('classifies BAR meaning, evidence plane, mapping, and provenance separately', () => {
    const before = projectAcceptanceBarContractSnapshot(fixture(1));
    const after = structuredClone(before);
    after.bars[0]!.model = 'Changed outcome.';
    after.bars[0]!.evidencePlane = 'live';
    after.bars[0]!.mappings = [];
    after.bars[0]!.provenance = { ...after.bars[0]!.provenance!, declaredAt: '2026-09-05T00:00:00.000Z' };

    const diff = diffAcceptanceBarContractSnapshots(before, after, 'migration');

    expect(diff.requiresAmendment).toBe(true);
    expect(diff.changes[0]?.kinds).toEqual(['bar-meaning', 'evidence-plane', 'mapping', 'provenance-cohort']);
    expect(diff.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  // WI-2146375. The acceptance-BAR ship gate reads `bar.proof.uncertainEvidence` and, when it is
  // non-zero, raises `bar_snapshot_proof_uncertain` — which `phaseSnapshotCodes` returns at phase
  // 'ship', so it BLOCKS. The count used to include rows whose currentness was `unknown` purely
  // because the reader supplied no comparison input. `defaultReadEvidence` never supplies one and
  // `source_fingerprint` is NOT NULL, so every bound row counted, unconditionally — and since zero
  // rows already raises `bar_snapshot_proof_missing`, the proof leg had NO satisfiable state and no
  // enrolled plan could ship. Measured both ways on :3170 before the fix.
  it('does not call proof uncertain when the reader never asked for a currentness comparison', () => {
    const input = fixture(1);
    const evidence = input.evidence.rows[0]!;
    expect(evidence.currentness.comparisonSupplied).toBe(false);
    expect(evidence.currentness.overall).toBe('unknown');

    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.proof.uncertainEvidence).toBe(0);
  });

  it('DOES call proof uncertain when a comparison was supplied and came back unknown', () => {
    const input = fixture(1);
    // The control that keeps the test above honest: flipping ONLY `comparisonSupplied` must
    // restore the count. If this ever passes alongside the assertion above, the count is
    // ignoring the dimensions rather than ignoring un-asked questions, and the check is vacuous.
    input.evidence.rows[0]!.currentness.comparisonSupplied = true;

    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.proof.uncertainEvidence).toBe(1);
  });

  it('does not let uncertain evidence from a superseded spec revision poison current proof', () => {
    const input = fixture(1);
    const evidence = input.evidence.rows[0]!;
    evidence.specRevision += 1;
    evidence.currentness = {
      ...evidence.currentness,
      overall: 'stale',
      comparisonSupplied: true,
      dimensions: {
        ...evidence.currentness.dimensions,
        spec: 'stale',
        environment: 'unknown',
      },
      staleReasons: ['spec-stale'],
      unknownReasons: ['environment-current-fingerprint-not-supplied'],
    };

    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.proof.uncertainEvidence).toBe(0);
  });
});

/**
 * Plan `bar-reporting-layer-repairs-2026-09-07` — the reporting layer's four
 * projection/evaluator repairs. (Its fifth, R-5/P-005, is an authorization
 * surface and lives beside its own subject in
 * `agent-tools/scorecards/grader-eligibility.test.ts`.)
 *
 * Each `it` below is the corresponding spec clause's `falsifier.probeMethod`
 * executed literally, so the clause and its proof cannot drift apart. Every
 * rule keeps a permanent CONTROL that must fail in the opposite direction —
 * the discipline the sibling blocks in this file already follow, and the only
 * thing that keeps a later green run evidence of anything. The shared defect
 * these four repair (plan D-002) is one confusion: asserting a fact about the
 * AUTHOR where the system only observed a failed read.
 */
describe('BAR reporting-layer repairs (bar-reporting-layer-repairs-2026-09-07)', () => {
  describe('R-1 / P-001 — a readiness verdict is attributable to the BAR that produced it', () => {
    /** One blocked BAR beside one clean BAR — the shape the flat message erased. */
    const oneBlockedOfTwo = () => {
      const input = provedFixture(2);
      // The lever the sibling blocks above already use: a clause demanding a test
      // layer its BAR does not require blocks exactly that one BAR.
      input.clauses.rows[0]!.requiredTestLayers = ['e2e'];
      return projectAcceptanceBarContractSnapshot(input);
    };

    it('names the blocking barKey adjacent to its own codes', () => {
      const verdict = evaluateAcceptanceBarLifecycle(oneBlockedOfTwo(), 'pre-start');

      expect(verdict.blockingBars).toEqual([
        { barKey: 'R-1', codes: ['bar_snapshot_projection_stale'], contract: 'automated' },
      ]);
      expect(verdict.message).toContain('R-1: bar_snapshot_projection_stale');
      // The clean BAR is counted out loud, so "one BAR is blocked" cannot be read as
      // "the whole contract regressed" — the misreading whose wrong next action is
      // `rubrics:amend`, which destroys an in-flight grading card.
      expect(verdict.message).toContain('1 of 2 BAR(s) blocking, 1 clean');
    });

    it('attributes each code to its owning BAR and leaves contract-level empty', () => {
      const verdict = evaluateAcceptanceBarLifecycle(oneBlockedOfTwo(), 'pre-start');

      expect(verdict.codeAttribution).toEqual([{ code: 'bar_snapshot_projection_stale', barKeys: ['R-1'] }]);
      expect(verdict.contractCodes).toEqual([]);
    });

    it('CONTROL: a code no BAR owns is reported as contract-level, not attributed to one', () => {
      // Falsifiability. If attribution swept every code onto some BAR, `contractCodes`
      // would always be empty and the rule above would pass while saying nothing.
      const input = fixture(1);
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);

      const verdict = evaluateAcceptanceBarLifecycle(projectAcceptanceBarContractSnapshot(input), 'pre-start');

      expect(verdict.contractCodes).toContain('bar_snapshot_rubric_unresolved');
      expect(verdict.codeAttribution.find((entry) => entry.code === 'bar_snapshot_rubric_unresolved')?.barKeys).toEqual(
        [],
      );
      expect(verdict.message).toContain('contract-level:');
    });
  });

  describe('R-2 / P-002 — an unresolvable rubric is UNKNOWN, never an author-attributable absence', () => {
    it('emits the unresolved code and neither absence code when the plan PINS a rubric', () => {
      const input = fixture(1);
      // The pin is the whole premise: it is in-band evidence the author DID write one.
      expect(input.planRows.rows[0]!.rubricSlug).toBe('acceptance-plan-a');
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);

      const codes = projectAcceptanceBarContractSnapshot(input).readiness.codes;

      expect(codes).toContain('bar_snapshot_rubric_unresolved');
      expect(codes).not.toContain('bar_snapshot_rubric_missing');
      expect(codes).not.toContain('bar_snapshot_bar_set_empty');
    });

    it('carries the pin as evidence, so a reader can re-route instead of blaming the author', () => {
      const input = fixture(1);
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);

      const problem = projectAcceptanceBarContractSnapshot(input).completeness.problems.find(
        (entry) => entry.code === 'bar_snapshot_rubric_unresolved',
      );

      expect(problem?.detail).toContain('acceptance-plan-a');
      expect(problem?.detail).toContain('at revision 2');
      expect(problem?.detail).not.toContain('acceptance-plan-a@2');
      expect(problem?.detail).toContain('not evidence that none exists');
    });

    it('reports a failed rubric READ as unresolved even with no pin to appeal to', () => {
      const input = fixture(1);
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);
      input.planRows.rows[0]!.rubricSlug = null;
      input.readFailures = { rubric: 'connection closed' };

      const codes = projectAcceptanceBarContractSnapshot(input).readiness.codes;

      expect(codes).toContain('bar_snapshot_rubric_unresolved');
      expect(codes).not.toContain('bar_snapshot_rubric_missing');
    });

    it('CONTROL: with no pin AND no read failure, the same empty read IS an absence', () => {
      // The direction that must still fire. Without this, suppressing the absence
      // codes unconditionally would pass every assertion above.
      const input = fixture(1);
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);
      input.planRows.rows[0]!.rubricSlug = null;

      const codes = projectAcceptanceBarContractSnapshot(input).readiness.codes;

      expect(codes).toContain('bar_snapshot_rubric_missing');
      expect(codes).toContain('bar_snapshot_bar_set_empty');
      expect(codes).not.toContain('bar_snapshot_rubric_unresolved');
    });
  });

  describe('R-6 / P-004 — rubric evidence follows substantive identity, not revision churn', () => {
    /**
     * Two inputs differing ONLY in the rubric revision counter: same criteria, same
     * `barHash` for every BAR. The recorded cards stay pinned at revision 2.
     */
    const bumpedTo3 = (criteriaHash = 'criteria-hash') => {
      const input = fixture(1);
      const rubric = input.rubrics.rows[0]!;
      const hashesBefore = rubric.criteria.map((entry) => entry.barHash);

      (rubric as unknown as { revision: number }).revision = 3;
      rubric.criteriaHash = criteriaHash;
      input.planRows.rows[0]!.rubricRevision = 3;

      // The premise the clause names: BAR identity is byte-identical either way.
      expect(rubric.criteria.map((entry) => entry.barHash)).toEqual(hashesBefore);
      return projectAcceptanceBarContractSnapshot(input);
    };

    it('keeps an already-recorded grading card and the vetting attestation current', () => {
      const snapshot = bumpedTo3();

      expect(snapshot.bars[0]!.grading.state).toBe('pass');
      expect(snapshot.grading.vetting.state).toBe('current');
      expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_projection_stale');
    });

    it('keeps grading and vetting current when only rubric metadata changes within the same BAR meaning epoch', () => {
      const input = fixture(1);
      const rubric = input.rubrics.rows[0]!;
      rubric.revision = 3;
      rubric.criteriaHash = 'criteria-hash-after-method-change';
      rubric.barContract!.meaningRevision = 2;
      input.planRows.rows[0]!.rubricRevision = 3;
      for (const card of input.scorecards.rows) card.rubricMeaningRevision = 2;
      for (const card of input.vettingScorecards.rows) {
        if (card.vetting) card.vetting.rubricMeaningRevision = 2;
      }

      const snapshot = projectAcceptanceBarContractSnapshot(input);

      expect(snapshot.bars[0]!.grading.state).toBe('pass');
      expect(snapshot.grading.vetting.state).toBe('current');
    });

    it('stales grading and vetting when the BAR meaning epoch advances', () => {
      const input = fixture(1);
      input.rubrics.rows[0]!.barContract!.meaningRevision = 3;
      for (const card of input.scorecards.rows) card.rubricMeaningRevision = 2;
      for (const card of input.vettingScorecards.rows) {
        if (card.vetting) card.vetting.rubricMeaningRevision = 2;
      }

      const snapshot = projectAcceptanceBarContractSnapshot(input);

      expect(snapshot.bars[0]!.grading.state).toBe('stale');
      expect(snapshot.grading.vetting.state).toBe('stale');
    });

    it('CONTROL: a same-revision dependency identity change invalidates both', () => {
      const input = fixture(1);
      input.rubrics.rows[0]!.criteriaHash = 'criteria-hash-after-method-change';
      const snapshot = projectAcceptanceBarContractSnapshot(input);

      expect(snapshot.bars[0]!.grading.state).toBe('stale');
      expect(snapshot.grading.vetting.state).toBe('stale');
    });

    it('CONTROL: one-sided legacy identity is unknown and never becomes passing proof', () => {
      const input = fixture(1);
      for (const card of input.scorecards.rows) delete card.criteriaHash;
      for (const card of input.vettingScorecards.rows) {
        if (card.vetting) delete card.vetting.criteriaHash;
      }
      const snapshot = projectAcceptanceBarContractSnapshot(input);

      expect(snapshot.bars[0]!.grading.state).toBe('stale');
      expect(snapshot.grading.vetting.state).toBe('stale');
    });
  });

  describe('R-4 / P-004 — the accepted judgment is recordable apart from the delivered fact', () => {
    const withAuthorVerdict = (verdict: string) => {
      const input = fixture(1);
      const author = input.scorecards.rows.find((card) => card.issueId === 'SC-AUTHOR')!;
      (author as unknown as { acceptance: unknown }).acceptance = {
        verdict,
        reasoning: 'Every reachable criterion is proved; the delivery plane is not this author to reach.',
      };
      return projectAcceptanceBarContractSnapshot(input);
    };

    it('persists a verdict distinguishable from both accept and reject, and reads it back', () => {
      const snapshot = withAuthorVerdict('accept-pending-delivery');

      expect(snapshot.grading.authorVerdict.state).toBe('accepted-pending-delivery');
      expect(snapshot.grading.authorVerdict.verdict).toBe('accept-pending-delivery');
      expect(snapshot.grading.authorVerdict.reasoning).toContain('not this author to reach');
      // Distinguishable from the two verdicts it exists to avoid: `accept` would
      // overclaim delivery and `reject` would be false.
      expect(snapshot.grading.authorVerdict.state).not.toBe('accepted');
      expect(snapshot.grading.authorVerdict.state).not.toBe('rejected');
    });

    it('surfaces it through the readiness projection as its own code', () => {
      const codes = withAuthorVerdict('accept-pending-delivery').readiness.codes;

      expect(codes).toContain('bar_snapshot_author_accepted_pending_delivery');
      // The author's own obligation IS met — the disclosure must not masquerade as
      // a missing or rejected verdict, which is what forces the ceremony to stall.
      expect(codes).not.toContain('bar_snapshot_author_verdict_missing');
      expect(codes).not.toContain('bar_snapshot_author_rejected');
    });

    it('CONTROL: accept and reject keep their own distinct states and codes', () => {
      const accepted = withAuthorVerdict('accept');
      expect(accepted.grading.authorVerdict.state).toBe('accepted');
      expect(accepted.readiness.codes).not.toContain('bar_snapshot_author_accepted_pending_delivery');

      const rejected = withAuthorVerdict('reject');
      expect(rejected.grading.authorVerdict.state).toBe('rejected');
      expect(rejected.readiness.codes).toContain('bar_snapshot_author_rejected');
      expect(rejected.readiness.codes).not.toContain('bar_snapshot_author_accepted_pending_delivery');
    });

    it('CONTROL: an unrecognized verdict does not fall through into the new state', () => {
      // The new branch is a strict equality on one literal, not a catch-all — an
      // unparseable verdict must still read as "no verdict recorded".
      const snapshot = withAuthorVerdict('probably-fine');

      expect(snapshot.grading.authorVerdict.state).toBe('missing');
      expect(snapshot.readiness.codes).not.toContain('bar_snapshot_author_accepted_pending_delivery');
    });
  });
});

// review-system-rework-reduction-2026-09-23 P-030 (P-031 merged in by D-005), spec RSR-P-030-A:
// a scope write re-evaluates BAR readiness IN THE SAME WRITE and surfaces the blocking code in
// the plan's Now. This drives the REAL projection (the evaluator the ship gate uses) through the
// cascade the drop write calls, so the code in the Now banner is the gate's own, not a fixture's.
describe('scope-write cascade: dropping a BAR’s last live item (P-031 guard)', () => {
  const nowPlan =
    '---\ntitle: Plan A\nslug: plan-a\nstatus: active\n---\n\n# Plan A\n\n## Now\n\n' +
    '**State:** Building.\n\n**Next:** Finish P-001.\n\n## Items\n\n- [ ] P-001 outcome\n';

  it('the live readiness names bar_snapshot_mapping_dropped_only and the drop write stamps it into Now', async () => {
    const live = fixture(1);
    expect(projectAcceptanceBarContractSnapshot(live).readiness.codes).not.toContain(
      'bar_snapshot_mapping_dropped_only',
    );

    const afterDrop: AcceptanceBarContractSnapshotInput = {
      ...live,
      planItems: rows([{ itemId: 'P-001', status: 'dropped' }], ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT),
    };
    const snapshot = projectAcceptanceBarContractSnapshot(afterDrop);
    expect(snapshot.readiness.state).toBe('blocked');
    expect(snapshot.readiness.codes).toContain('bar_snapshot_mapping_dropped_only');

    let body = nowPlan;
    const result = await reevaluateBarReadinessOnScopeWrite(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'plan-a', cause: 'item-dropped' },
      {
        async readBarReadiness() {
          const { state, codes, nextRepair } = snapshot.readiness;
          return { state, codes: [...codes], nextRepair };
        },
        async restampNow(_slug, _scope, reading, cause) {
          const stamped = stampBarReadinessNowBlock(body, reading, cause, new Date(iso));
          if (stamped === null) return false;
          body = stamped;
          return true;
        },
      },
    );

    expect(result.codes).toContain('bar_snapshot_mapping_dropped_only');
    expect(result.nowStamped).toBe(true);
    expect(body).toContain(BAR_READINESS_NOW_MARK);
    expect(body).toMatch(/BAR READINESS BLOCKED[^\n]*bar_snapshot_mapping_dropped_only/);
    // The author's Now survives beneath the banner.
    expect(body).toContain('Building.');
    expect(body).toContain('Finish P-001.');
  });
});

// P-038 (R-9): every blocking-BAR row says whether the BAR owes automated proof or is an
// explicit MANUAL contract, computed by the same predicate the proof floor uses — so a proof
// code can never be misread as "bind a test" on a BAR that never owed one.
describe('blocking BARs carry their contract kind (P-038 guard)', () => {
  it('labels an instrumentKey:none BAR manual and a structured-tests BAR automated', () => {
    const manual = fixture(1);
    manual.rubrics.rows[0]!.criteria[0]!.check = { kind: 'instrument', instrumentKey: 'none' };
    manual.planItems = rows([{ itemId: 'P-001', status: 'dropped' }], ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT);
    const manualVerdict = evaluateAcceptanceBarLifecycle(projectAcceptanceBarContractSnapshot(manual), 'ship');
    expect(manualVerdict.blockingBars).toEqual([
      expect.objectContaining({ barKey: 'R-1', contract: 'manual', codes: expect.arrayContaining(['bar_snapshot_mapping_dropped_only']) }),
    ]);

    const automated = fixture(1);
    automated.rubrics.rows[0]!.criteria[0]!.check = {
      kind: 'tests',
      files: ['packages/operator-core/lib/acceptance-bar-contract-snapshot.test.ts'],
    };
    const automatedVerdict = evaluateAcceptanceBarLifecycle(projectAcceptanceBarContractSnapshot(automated), 'ship');
    expect(automatedVerdict.blockingBars).toEqual([
      expect.objectContaining({ barKey: 'R-1', contract: 'automated', codes: expect.arrayContaining(['bar_snapshot_proof_depth_missing']) }),
    ]);
  });
});

// verification-system-improvements-2026-10-10 P-001: every contract refusal code the
// verification-system map names must have a test that triggers it. Each case breaks one
// source of an otherwise valid fixture and looks for the code wherever the snapshot reports it.
describe('snapshot source codes (verification-system map)', () => {
  const allCodes = (snapshot: ReturnType<typeof projectAcceptanceBarContractSnapshot>): string[] => [
    ...snapshot.completeness.problems.map((problem) => problem.code),
    ...snapshot.readiness.codes,
    ...snapshot.bars.flatMap((b) => b.readiness.codes),
  ];
  const triggered = [
    'bar_snapshot_plan_missing',
    'bar_snapshot_cohort_incomplete',
    'bar_snapshot_rubric_ambiguous',
    'bar_snapshot_bar_key_duplicate',
    'bar_snapshot_bar_set_hash_mismatch',
    'bar_snapshot_work_contract_missing',
    'bar_snapshot_work_contract_stale',
    'bar_snapshot_author_verdict_stale',
    'bar_snapshot_grading_missing',
  ];

  it('no grading scorecard raises bar_snapshot_grading_missing', () => {
    const input = fixture(1);
    input.scorecards.rows.length = 0;
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_grading_missing');
  });

  it('CALIBRATION: the unmodified fixture raises none of these codes', () => {
    const codes = allCodes(projectAcceptanceBarContractSnapshot(fixture(2)));
    for (const code of triggered) expect(codes).not.toContain(code);
  });

  it('an absent subject plan row raises bar_snapshot_plan_missing', () => {
    const input = fixture(1);
    input.planRows = rows([], 1);
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_plan_missing');
  });

  it('a post-epoch plan with no seed identity raises bar_snapshot_cohort_incomplete', () => {
    const input = fixture(1);
    input.planRows.rows[0]!.seededBy = null as unknown as string;
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_cohort_incomplete');
  });

  it('two active acceptance rubrics raise bar_snapshot_rubric_ambiguous', () => {
    const input = fixture(1);
    input.rubrics.rows.push({ ...input.rubrics.rows[0]!, rubricId: 'acceptance-plan-a-twin' } as Rubric);
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_rubric_ambiguous');
  });

  it('two BARs sharing one key raise bar_snapshot_bar_key_duplicate', () => {
    const input = fixture(2);
    const criteria = input.rubrics.rows[0]!.criteria;
    criteria[1]!.barKey = criteria[0]!.barKey;
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_bar_key_duplicate');
  });

  it('a plan BAR-set pin that differs from the recomputed hash raises bar_snapshot_bar_set_hash_mismatch', () => {
    const input = fixture(2);
    input.planRows.rows[0]!.barSetHash = 'f'.repeat(64);
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_bar_set_hash_mismatch');
  });

  it('a clause with no linked work-item raises bar_snapshot_work_contract_missing', () => {
    const input = fixture(1);
    input.workContracts.rows.length = 0;
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_work_contract_missing');
  });

  it('a work-item linked to an older clause revision raises bar_snapshot_work_contract_stale', () => {
    const input = fixture(1);
    input.workContracts.rows[0]!.specRevision = 99;
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_work_contract_stale');
  });

  it('an implementer verdict older than the grading raises bar_snapshot_author_verdict_stale', () => {
    const input = fixture(1);
    const author = input.scorecards.rows.find((card) => card.issueId === 'SC-AUTHOR')!;
    author.createdAt = '2026-09-04T00:00:00.000Z';
    expect(allCodes(projectAcceptanceBarContractSnapshot(input))).toContain('bar_snapshot_author_verdict_stale');
  });
});

// plan-verification-friction-reduction-2026-10-11 P-002 (D-001): the server re-measures
// bound proof when a caller omits current fingerprints, so the inadequate-proof repair must
// not send agents to hand-supply them. It must instead name the two unknownReasons that
// distinguish "the server could not measure" from "the binding has no recipe to measure".
describe('bar_snapshot_proof_inadequate repair text (P-002)', () => {
  const action = nextRepair(['bar_snapshot_proof_inadequate'], [
    { barKey: 'R-2', readiness: { codes: ['bar_snapshot_proof_inadequate'] } },
  ])?.action ?? '';

  it('does not tell the caller to supply current fingerprints', () => {
    expect(action).toContain('plans:evaluate-spec-test-adequacy');
    expect(action).toMatch(/do not need to supply current fingerprints/i);
    expect(action).not.toMatch(/\bsupply current fingerprints before\b/i);
    expect(action).not.toMatch(/with current fingerprints/i);
  });

  it('names the reasons that separate a failed server measurement from a recipe-less binding', () => {
    expect(action).toContain('server-measurement-unavailable:');
    expect(action).toContain('-current-fingerprint-not-supplied');
    expect(action).toContain('fromTestRun');
  });
});

// plan-verification-profiles-2026-10-17 P-004 (R-10, D-009): the ship snapshot grades a BAR clause
// on the SAME deliverable verdict the completion gate uses. A general plan's requirement BAR
// declares a test layer (a requirement block may omit one only with an explicitly manual check),
// so without the resolver every such BAR asked a non-code deliverable for a code test.
describe('ship-side adequacy reads the deliverable resolver (plan-verification-profiles P-004)', () => {
  function layeredManualFixture(plan: { verificationProfile?: string | null }, item: { deliverable?: string | null } | null) {
    const input = fixture(1);
    const rubric = input.rubrics.rows[0]!;
    const bar = rubric.criteria[0]!;
    bar.requiredTestLayers = ['integration'];
    bar.barHash = computeAcceptanceBarHash(bar);
    const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
    rubric.barSetHash = barSetHash;
    Object.assign(input.planRows.rows[0]!, { barSetHash, ...plan });
    const clause = input.clauses.rows[0]!;
    clause.requiredTestLayers = ['integration'];
    Object.assign(clause.sourceBar!, { barHash: bar.barHash, barSetHash });
    if (item === null) input.planItems.rows = [];
    else Object.assign(input.planItems.rows[0]!, item);
    // What non-code work honestly binds: a current manual row on the BAR's plane, no test run.
    const row = input.evidence.rows[0]!;
    Object.assign(row, {
      evidenceKind: 'manual',
      evidenceRef: 'work-item:WI-1',
      testRunId: null,
      details: {
        evidencePlane: 'tree',
        adequacy: {
          fixtureCalibrated: true, fixtureFree: true, falsifiable: true, pathReachable: true, oracleIndependent: true,
          collected: true, skipped: false, executed: true, outcome: 'passed', targeted: row.specId,
        },
      },
      currentness: { ...row.currentness, overall: 'current', comparisonSupplied: true,
        dimensions: { ...row.currentness.dimensions, source: 'current' }, unknownReasons: [] },
    });
    return input;
  }

  it('passes a general plan item BAR on manual evidence despite its declared test layer', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(layeredManualFixture({ verificationProfile: 'general' }, { deliverable: null }));
    const adequacy = snapshot.bars[0]!.proof.adequacy;
    expect(adequacy?.state, JSON.stringify(adequacy).slice(0, 1500)).toBe('pass');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).not.toContain('bar_snapshot_proof_inadequate');
  });

  it('passes a declared non-code deliverable inside a coding plan the same way', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(layeredManualFixture({ verificationProfile: 'coding' }, { deliverable: 'doc' }));
    expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('pass');
  });

  // NEGATIVE CONTROLS: the same BAR and evidence for a code deliverable still owes a code test,
  // so the passes above come from the resolver, not from a weaker snapshot.
  it('control: a coding plan item BAR on the same evidence is refused as inadequate', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(layeredManualFixture({ verificationProfile: 'coding' }, { deliverable: null }));
    expect(snapshot.bars[0]!.proof.adequacy?.state).not.toBe('pass');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it('control: a declared code deliverable inside a general plan keeps the code floor', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(layeredManualFixture({ verificationProfile: 'general' }, { deliverable: 'code' }));
    expect(snapshot.bars[0]!.proof.adequacy?.state).not.toBe('pass');
  });

  // D-005 fail-safe: an unread profile, or a clause whose plan item has no row, stays code.
  it('treats an unread profile or a missing plan item row as code', () => {
    for (const [plan, item] of [[{}, { deliverable: null }], [{ verificationProfile: 'general' }, null]] as const) {
      const snapshot = projectAcceptanceBarContractSnapshot(layeredManualFixture(plan, item));
      expect(snapshot.bars[0]!.proof.adequacy?.state, JSON.stringify({ plan, item })).not.toBe('pass');
    }
  });
});
