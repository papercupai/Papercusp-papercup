import { describe, expect, it, vi } from 'vitest';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import type { SpecClauseRevision } from '../plans/spec-clauses-store';
import type { SpecEvidenceForAdequacy } from '../plans/spec-test-adequacy';
import {
  evaluateSpecTestAdequacy,
  SPEC_TEST_ADEQUACY_EVALUATOR_REVISION,
  SPEC_TEST_ADEQUACY_RUBRIC_REF,
} from '../plans/spec-test-adequacy';
import { specTestAdequacyCompletionGate } from './spec-test-adequacy-gate';
type ClassResolver = typeof import('../plans/evaluate-spec-test-adequacy').resolveEvaluatorClassRef;
const classResolver = vi.hoisted(() => vi.fn<ClassResolver>(async () => ({ ok: true, classRef: 'plan-class-feature-ship', source: 'active-acceptance-rubric' })));
vi.mock('../plans/evaluate-spec-test-adequacy', () => ({ resolveEvaluatorClassRef: classResolver }));
// P-004: the clause-deliverable read is a DB query; keep this suite offline. An empty map
// means every clause stays a code deliverable, which is the pre-P-004 behaviour.
const readClauseCodeDeliverables = vi.hoisted(() =>
  vi.fn<typeof import('../../plan-verification-escape').readClauseCodeDeliverables>(async () => new Map()),
);
vi.mock('../../plan-verification-escape', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plan-verification-escape')>()),
  readClauseCodeDeliverables,
}));

type GateDeps = NonNullable<Parameters<typeof specTestAdequacyCompletionGate>[1]>;
type ListedEvidence = Awaited<ReturnType<NonNullable<GateDeps['listEvidence']>>>[number];

const WORK_ITEM = {
  id: 'WI-101',
  harness: 'papercusp',
  payload: {
    plan_item: {
      plan_slug: 'reconnect-plan',
      item_id: 'P-003',
      harness_slug: 'papercusp',
    },
  },
  sourcePlanSlug: 'reconnect-plan',
  sourcePlanItemIds: ['P-003'],
};

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    sourceValId: 'VAL-003-01',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-003',
    behavior: 'An acknowledged event is not replayed after reconnect.',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:spec-v1',
    createdBy: 'su-test',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-003',
    ...over,
  };
}

function inventoryExemptionClause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return clause({
    specId: 'INVENTORY-P-003',
    sourceValId: null,
    planItemId: 'P-003',
    behavior: 'Read-only caller, gate, test-suite and registered component inventory.',
    behaviorClass: 'non-automated',
    requiredEvidence: [],
    requiredTestLayers: [],
    mutationRequired: false,
    lifecycleStatus: 'exempt',
    exemption: {
      provenance: 'reconnect-plan#D-006',
      justification: 'This item changes no runtime behavior; implementation and shipment obligations remain on their owning items.',
    },
    falsifier: null,
    acceptanceRef: 'reconnect-plan#D-006',
    sourceBar: null,
    ...over,
  });
}

function passingExecution(): NonNullable<ListedEvidence['testRunExecution']> {
  return {
    status: 'pass', passed: 1, failed: 0, skipped: 0, collectionFailed: false,
    filePath: RECONNECT_TEST_PATH,
    testLayer: 'integration', passedCaseTitles: ['acknowledged events are not replayed'],
  };
}

function evidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  return {
    workItemId: 'WI-101',
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidenceKind: 'test',
    evidenceRef: 'test:reconnect',
    fingerprints: {
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: null,
      rubricFingerprint: 'sha256:rubric',
      environmentFingerprint: 'node:24',
    },
    coverageEvidenceRef: null,
    testRunId: 43,
    testRunExecution: passingExecution(),
    details: {
      adequacy: {
        // Current evaluator evidence must name the exact clause it is proving.
        targeted: 'SPEC-003-01',
        fixtureFree: true,
        testCases: ['acknowledged events are not replayed'],
        falsifiable: true,
        testLayer: 'integration',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        coverageRungs: { l3: true },
      },
    },
    currentness: {
      provenance: 'server-measured',
      // WI-2146375: every dimension here reads 'current', which is only reachable when a
      // comparison input WAS supplied — `unknown` is what you get when nobody asked.
      comparisonSupplied: true,
      overall: 'current',
      dimensions: {
        spec: 'current',
        source: 'current',
        test: 'current',
        fixture: 'not-applicable',
        rubric: 'current',
        environment: 'current',
        coverageEvidence: 'not-applicable',
        testRun: 'current',
      },
      staleReasons: [],
      unknownReasons: [],
    },
    ...over,
  };
}

function listedEvidence(over: Partial<ListedEvidence> = {}): ListedEvidence {
  return {
    id: 1,
    sourceValId: 'VAL-003-01',
    currentRevision: 1,
    observedAt: '2026-08-20T00:01:30.000Z',
    bindingFingerprint: 'sha256:binding',
    createdBy: 'su-test',
    createdAt: '2026-08-20T00:01:31.000Z',
    ...evidence(),
    // No repository measurement is attached to this store fixture by default.
    serverMeasurement: undefined,
    // This suite stubs the store reader, whose current contract certifies fixture absence
    // with independent verification citations. Binder-authored fixtureFree alone is not proof.
    fixtureAbsenceVerification: { verifierBindingIds: [5001] },
    testRunExecution: passingExecution(),
    // Evaluator revision 4 (WI-10006856): a mutation/counterexample target only establishes
    // falsifiability when its run's canonical test FILE also has a successful current test
    // binding on the same clause revision, matched by testRunProvenance.filePath. A null
    // provenance can never link, so the whole suite rated falsifiability `unknown`. Both the
    // test binding and counterexampleEvidence() (which spreads this) share one file.
    testRunProvenance: { filePath: RECONNECT_TEST_PATH, framework: 'vitest', source: 'local',
      mutationPhase: null, commitSha: 'abc123', worktreeDirty: false },
    ...over,
  };
}

const RECONNECT_TEST_PATH = 'packages/reconnect/reconnect.test.ts';

/**
 * The evaluator requires a successful ledger-backed negative control for falsifiability, TARGETED
 * at the clause (a49fca9b96 + WI-10002724 / D-009): clause() declares no falsifier scenarios, so
 * the accepted target is its own lower-cased specId. The inherited `targeted: true` no longer
 * qualifies, which left this whole suite red on staging from a49fca9b96 on.
 */
function counterexampleEvidence(over: Partial<ListedEvidence> = {}): ListedEvidence {
  return listedEvidence({
    id: 2,
    evidenceKind: 'counterexample',
    evidenceRef: 'counterexample:reconnect',
    testRunExecution: { ...passingExecution(), status: 'fail', passed: 0, failed: 1,
      passedCaseTitles: [] },
    testRunProvenance: { filePath: RECONNECT_TEST_PATH, framework: 'vitest',
      source: 'mutation-probe', mutationPhase: 'mutant', commitSha: 'abc123', worktreeDirty: false,
      mutationFailureLines: ['acknowledged events are not replayed: measured assertion failure'],
      mutationFailedCaseTitles: ['acknowledged events are not replayed'] },
    details: {
      adequacy: {
        ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
        outcome: 'killed',
        targeted: 'spec-003-01',
        scenarioIds: ['acknowledged-event-negative-control'],
      },
    },
    ...over,
  });
}

function passingEvidence(): ListedEvidence[] {
  return [listedEvidence(), counterexampleEvidence()];
}

function matchingCard(over: Partial<ScorecardRow> = {}): ScorecardRow {
  const result = evaluateSpecTestAdequacy({
    clause: clause(),
    evidence: passingEvidence(),
    classRef: 'plan-class-feature-ship',
  });
  return {
    issueId: 'EI-scorecard',
    createdAt: '2026-08-20T00:02:00.000Z',
    createdBy: 'reviewer',
    subject: result.scorecardDraft.subject,
    rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
    ratings: result.ratings,
    nKeys: Object.keys(result.ratings).length,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    evidenceFingerprint: scorecardEvidenceFingerprint({
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      ratings: result.ratings,
    }),
    synthesized: false,
    score10: 10,
    linkedItems: [],
    ...over,
  };
}

const ATTESTATION = {
  classRef: 'plan-class-feature-ship' as const,
  current: [
    {
      evidenceKind: 'test' as const,
      evidenceRef: 'test:reconnect',
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: null,
      rubricFingerprint: 'sha256:rubric',
      environmentFingerprint: 'node:24',
    },
  ],
};

/**
 * Default plan status for every namespace a test resolves.
 *
 * `active` is chosen so the DEFAULT is enforcing: a test that says nothing about plan
 * status is asserting about the gate's enforcement behavior, and a default that quietly
 * exempted every plan would make those tests pass for the wrong reason — the vacuous-pass
 * class. Tests that care about the non-enforcing lanes override this explicitly.
 */
function planStatuses(byPlan: Record<string, string> = {}) {
  return vi.fn<NonNullable<GateDeps['listPlanStatuses']>>(
    async ({ planSlugs }) => new Map(planSlugs.map((slug) => [slug, byPlan[slug] ?? 'active'])),
  );
}

function passingDeps() {
  const listClauses = vi.fn<NonNullable<GateDeps['listClauses']>>(async () => [clause()]);
  const listEdges = vi.fn<NonNullable<GateDeps['listEdges']>>(async () => []);
  const listEvidence = vi.fn<NonNullable<GateDeps['listEvidence']>>(async (options) => {
    const rows = passingEvidence();
    return options.evidenceRefs ? rows.filter((row) => options.evidenceRefs!.includes(row.evidenceRef)) : rows;
  });
  const listCards = vi.fn<NonNullable<GateDeps['listCards']>>(async () => [matchingCard()]);
  const listPlanStatuses = planStatuses();
  return {
    listClauses,
    listEdges,
    listEvidence,
    listCards,
    listPlanStatuses,
  };
}

function mechanicalDeps() {
  const deps = passingDeps();
  const rows = passingEvidence();
  const mutant = rows[1]!;
  const mutation = {
    schemaVersion: 1 as const, probeInvocationId: 'mechanical-probe', leg: 'mutant' as const,
    mode: 'copy-out' as const, subjectPath: 'src/reconnect.ts', mutateExpression: 's/false/true/',
    againstCommit: null, subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
    mutantDiff: '-false\n+true', mutantDiffTruncated: false,
    testCommandSha256: 'c'.repeat(64), testFileSha256: 'd'.repeat(64),
  };
  mutant.testRunProvenance!.mutation = mutation;
  mutant.testRunProvenance!.mutationBaseline = {
    testRunId: 99, status: 'pass', passed: 1, failed: 0, skipped: 0,
    collectionFailed: false, mutation: { ...mutation, leg: 'baseline' },
  };
  mutant.details.currentMeasurement = {
    schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/reconnect.ts'], testPaths: [RECONNECT_TEST_PATH],
  };
  for (const row of rows) row.currentness.provenance = 'server-measured';
  deps.listEvidence.mockResolvedValue(rows);
  deps.listCards.mockResolvedValue([]);
  return { ...deps, rows,
    resolveSourceBarTestRequirements: vi.fn<NonNullable<GateDeps['resolveSourceBarTestRequirements']>>(
      async () => ({ status: 'required', files: [RECONNECT_TEST_PATH] }),
    ),
  };
}

describe('completion phase attribution', () => {
  it('keeps a delayed deliverable read visible before the missing-attestation refusal', async () => {
    const active = new Set<string>();
    const completed: string[] = [];
    const phases: NonNullable<Parameters<typeof specTestAdequacyCompletionGate>[0]['phases']> = {
      async track<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
        active.add(phase);
        try { return await work(); }
        finally { active.delete(phase); completed.push(phase); }
      },
    };
    let release!: (value: Map<string, boolean>) => void;
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const pendingRead = new Promise<Map<string, boolean>>((resolve) => { release = resolve; });
    const deps = { ...passingDeps(), readCodeDeliverables: async () => { entered(); return pendingRead; } };
    const pendingGate = specTestAdequacyCompletionGate({ workItem: WORK_ITEM, phases }, deps);
    await enteredRead;
    expect([...active]).toEqual(['completion:spec:code-deliverables']);
    expect(completed).toContain('completion:spec:behavior-contract');
    release(new Map());
    expect(await pendingGate).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(active.size).toBe(0);
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });
});

describe('item-close contribution boundary', () => {
  function contributionWorld() {
    const deps = mechanicalDeps();
    const covering = clause({ createdBy: 'independent-contract-author', falsifier: { observation: 'Acknowledged event replayed.' } });
    const projection = clause({ specId: 'AUTO-BAR-R-9-P-003', contentHash: 'projection-r9',
      sourceValId: null, requiredTestLayers: ['e2e'], sourceBar: {
        barKey: 'R-9', barHash: 'bar-r9', barSetHash: 'bars', rubricSlug: 'reconnect-acceptance',
        rubricRevision: 3, evidencePlane: 'deployed',
      } });
    const pin = (c: SpecClauseRevision) => ({ planSlug: c.planSlug, specId: c.specId,
      revision: c.revision, contentHash: c.contentHash });
    const review = listedEvidence({ id: 700, evidenceKind: 'independent-verification',
      evidenceRef: 'review:contract-contribution', createdBy: 'outside-reviewer', verifiesBindingId: 1,
      details: { itemCloseContribution: { schemaVersion: 1, workItemId: WORK_ITEM.id, planItemId: 'P-003',
        requirementKey: 'R-9', barHash: 'bar-r9', projection: pin(projection), covering: pin(covering),
        proofCohort: deps.rows.map(row => ({ bindingId: row.id, bindingFingerprint: row.bindingFingerprint })),
        itemClose: { behavior: covering.behavior, falsifier: covering.falsifier!.observation,
          requiredTestLayers: covering.requiredTestLayers, requiredEvidence: covering.requiredEvidence,
          mutationRequired: covering.mutationRequired, evidencePlane: 'tree' },
        disposition: 'defer-parent-proof-to-plan-shipment' } } });
    deps.listClauses.mockResolvedValue([projection, covering]);
    const rows = [...deps.rows, review];
    deps.listEvidence.mockResolvedValue(rows);
    const fullDeps = { ...deps, contributionDeferral: {
      mappedProjection: vi.fn(async () => true), independent: vi.fn(async () => true),
    } };
    const input = { workItem: WORK_ITEM, workspaceId: 'test-workspace', attestation: ATTESTATION,
      completion: { contributesTo: ['R-9'], discharges: [] as string[] } };
    return { input, deps: fullDeps, covering, projection, review, rows,
      run: () => specTestAdequacyCompletionGate(input, fullDeps) };
  }

  it('unblocks the next implementation item with proven item scope and a distinct deferred BAR receipt', async () => {
    const w = contributionWorld();
    const result = await w.run();
    expect(result).toMatchObject({ ok: true, checked: ['SPEC-003-01@1'], deferredContributions: [{
      requirementKey: 'R-9', projection: { specId: 'AUTO-BAR-R-9-P-003' },
      covering: { specId: 'SPEC-003-01' }, finalGate: 'plan-shipment', evidencePlane: 'tree',
    }] });
    expect(result.exempted).toBeUndefined();
    expect(result.checked).not.toContain('AUTO-BAR-R-9-P-003@1');
  });

  it.each(['discharge', 'missing-review', 'missing-cover', 'unproven-cover', 'weakened-cover', 'unmapped'] as const)(
    'still refuses %s', async (mode) => {
      const w = contributionWorld();
      if (mode === 'discharge') { w.input.completion.contributesTo = []; w.input.completion.discharges = ['R-9']; }
      if (mode === 'missing-review') w.deps.listEvidence.mockResolvedValue(w.deps.rows);
      if (mode === 'missing-cover') w.deps.listClauses.mockResolvedValue([w.projection]);
      if (mode === 'unproven-cover') w.deps.listEvidence.mockResolvedValue([w.rows[0]!, w.review]);
      if (mode === 'weakened-cover') w.covering.requiredTestLayers = ['static'];
      if (mode === 'unmapped') w.deps.contributionDeferral.mappedProjection.mockResolvedValue(false);
      const result = await w.run();
      expect(result.ok).toBe(false);
      expect(result.deferredContributions).toBeUndefined();
    },
  );

  it('refuses a conflicting declaration even when proof is otherwise adequate', async () => {
    const w = contributionWorld(); w.input.completion.discharges = ['R-9'];
    expect(await w.run()).toMatchObject({ ok: false, reason: expect.stringContaining('both') });
  });

  it('refuses when cited row A is inadequate although unreviewed cohort B earns ordinary adequacy', async () => {
    const w = contributionWorld();
    const relation = w.review.details.itemCloseContribution as { proofCohort: { bindingId: number; bindingFingerprint: string }[] };
    relation.proofCohort = [relation.proofCohort[0]!];
    expect(await w.run()).toMatchObject({ ok: false, reason: expect.stringContaining('no caught mutation probe') });
  });

  it('does not defer an unrelated additional BAR', async () => {
    const w = contributionWorld();
    w.deps.listClauses.mockResolvedValue([w.covering, w.projection,
      { ...w.projection, specId: 'AUTO-BAR-R-8-P-003', contentHash: 'other-projection',
        sourceBar: { ...w.projection.sourceBar!, barKey: 'R-8' } }]);
    expect(await w.run()).toMatchObject({ ok: false, reason: expect.stringContaining('AUTO-BAR-R-8-P-003') });
  });
});

describe('test-checked completion uses mechanical adequacy', () => {
  it('completes with passing named tests and a caught mutant without reading judge cards', async () => {
    const deps = mechanicalDeps();
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);
    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('rejects a renamed source BAR selector absent from the passing run ledger', async () => {
    const deps = mechanicalDeps();
    deps.resolveSourceBarTestRequirements.mockResolvedValue({
      status: 'required',
      files: [RECONNECT_TEST_PATH],
      cases: [{ file: RECONNECT_TEST_PATH, testName: 'acknowledged events survive reconnect' }],
    });
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('acknowledged events survive reconnect'),
    });
  });

  it('does not satisfy a source BAR selector recorded only for another test file', async () => {
    const deps = mechanicalDeps();
    const selector = 'acknowledged events are not replayed';
    deps.resolveSourceBarTestRequirements.mockResolvedValue({
      status: 'required',
      files: [RECONNECT_TEST_PATH],
      cases: [{ file: RECONNECT_TEST_PATH, testName: selector }],
    });
    const primary = deps.rows[0]!;
    primary.testRunExecution!.passedCaseTitles = ['a different passing case'];
    primary.details.adequacy = {
      ...(primary.details.adequacy as Record<string, unknown>),
      testCases: ['a different passing case'],
    };
    const otherFile = 'packages/reconnect/other.test.ts';
    deps.listEvidence.mockResolvedValue([...deps.rows, {
      ...primary,
      id: 44,
      testRunId: 44,
      evidenceRef: 'test:other-file',
      testRunExecution: {
        ...primary.testRunExecution!,
        filePath: otherFile,
        passedCaseTitles: [selector],
      },
      testRunProvenance: { ...primary.testRunProvenance!, filePath: otherFile },
    }]);
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining(selector),
    });
  });

  it('accepts a source BAR selector found in the same file’s server-recorded case titles', async () => {
    const deps = mechanicalDeps();
    const selector = 'acknowledged events are not replayed';
    deps.resolveSourceBarTestRequirements.mockResolvedValue({
      status: 'required',
      files: [RECONNECT_TEST_PATH],
      cases: [{ file: RECONNECT_TEST_PATH, testName: selector }],
    });
    const primary = deps.rows[0]!;
    primary.testRunExecution!.passedCaseTitles = ['reconnect suite > ' + selector];
    primary.details.adequacy = {
      ...(primary.details.adequacy as Record<string, unknown>),
      testCases: [selector],
    };
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);
    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it('reports the missing caught mutant without recruiting a grading audit', async () => {
    const deps = mechanicalDeps();
    deps.listEvidence.mockResolvedValue([deps.rows[0]!]);
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('no caught mutation probe') });
    expect(result).not.toHaveProperty('pendingGradingAuditTargetIds');
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('re-evaluates after a measured source or named test becomes stale', async () => {
    const deps = mechanicalDeps();
    expect(await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps))
      .toMatchObject({ ok: true });
    deps.rows[0]!.currentness.overall = 'stale';
    expect(await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps))
      .toMatchObject({ ok: false, reason: expect.stringContaining('no longer current') });
    expect(deps.listCards).not.toHaveBeenCalled();
  });
});

describe('specTestAdequacyCompletionGate', () => {
  it('does not mistake binder-only fixtureFree metadata for store-verified fixture absence', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue(passingEvidence().map(row => ({
      ...row, fixtureAbsenceVerification: undefined,
    })));
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('fixture-calibration') });
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('refuses a work-item close when the globally passing clause needs proof bound to a sibling work item', async () => {
    const deps = passingDeps();
    const combined = passingEvidence().map((row, index) => ({
      ...row,
      workItemId: index === 0 ? WORK_ITEM.id : 'WI-parent',
      fingerprints: { ...row.fingerprints, fixtureFingerprint: 'sha256:calibrated-fixture' },
      details: {
        ...row.details,
        adequacy: { ...(row.details.adequacy as Record<string, unknown>), fixtureFree: false, fixtureCalibrated: true },
      },
      currentness: { ...row.currentness, dimensions: { ...row.currentness.dimensions, fixture: 'current' as const } },
    }));
    expect(evaluateSpecTestAdequacy({ clause: clause(), evidence: combined, classRef: 'plan-class-feature-ship' }).verdict)
      .toBe('pass');
    deps.listEvidence.mockImplementation(async (options) =>
      combined.filter((row) => !options.workItemIds || options.workItemIds.includes(row.workItemId)),
    );
    const result = await specTestAdequacyCompletionGate({
      workItem: WORK_ITEM, attestation: { classRef: 'plan-class-feature-ship' },
    }, deps);
    expect(deps.listEvidence).toHaveBeenCalledWith(expect.objectContaining({ workItemIds: [WORK_ITEM.id] }));
    expect(result).toMatchObject({ ok: false, applicable: true, checked: [] });
    if (!result.ok) expect(result.reason).toContain('falsifiability');
  });

  it('derives an omitted completion class and preserves its proof requirements', async () => {
    const deps = passingDeps();
    const { classRef: _classRef, ...attestation } = ATTESTATION;
    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'change' }, attestation }, deps);
    expect(classResolver).toHaveBeenCalledWith('reconnect-plan', 'papercusp', { classRef: undefined, workItemIds: ['WI-101'] });
    expect(result.checked).toContain('SPEC-003-01@1');
  });

  it('refuses a contradictory explicit completion class before reading proof', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'change' }, attestation: { classRef: 'plan-class-investigation' } }, deps);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('plan_class_mismatch') });
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('refuses an omitted completion class when the subject class is unavailable', async () => {
    const deps = passingDeps();
    const { classRef: _classRef, ...attestation } = ATTESTATION;
    classResolver.mockResolvedValueOnce({ ok: false, code: 'plan_class_unresolved', message: 'plan_class_unresolved: no persisted class', wouldBlock: ['plan_class_unresolved'] });
    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'change' }, attestation }, deps);
    expect(result).toMatchObject({ ok: false, reason: 'plan_class_unresolved: no persisted class', checked: [] });
    expect(deps.listEvidence).not.toHaveBeenCalled();
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('retains the persisted bugfix proof floor when completion class is omitted', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([listedEvidence()]);
    const { classRef: _classRef, ...attestation } = ATTESTATION;
    classResolver.mockResolvedValueOnce({ ok: true, classRef: 'plan-class-bugfix', source: 'active-acceptance-rubric' });
    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'change' }, attestation }, deps);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('risk-floor') });
    expect(deps.listEvidence).toHaveBeenCalled();
  });
  it('is non-applicable for a legacy work item with no plan provenance', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-legacy', harness: 'papercusp', payload: null } },
      deps,
    );

    expect(result).toEqual({ ok: true, applicable: false, checked: [] });
    // P-016/D-012: the VERDICT is unchanged, but the reason it is reached moved. This
    // used to assert `listEdges` was NOT called — the gate returned non-applicable from
    // the missing plan stamp alone, before looking at behavior at all. Applicability is
    // behavior-owned now, so the edges ARE consulted (unscoped); this item is
    // non-applicable because it genuinely has no edges, not because it has no plan.
    expect(deps.listEdges).toHaveBeenCalledWith({ harnessSlug: 'papercusp', workItemId: 'WI-legacy' });
    expect(deps.listClauses).not.toHaveBeenCalled();
  });

  it('falls back to canonical sourcePlan columns when the payload stamp is absent', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate(
      {
        workItem: {
          id: WORK_ITEM.id,
          harness: WORK_ITEM.harness,
          payload: null,
          sourcePlanSlug: WORK_ITEM.sourcePlanSlug,
          sourcePlanItemIds: WORK_ITEM.sourcePlanItemIds,
        },
        attestation: ATTESTATION,
      },
      deps,
    );

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    // P-016/D-013 design call (a): the edge read is UNSCOPED by plan. It used to pass
    // `planSlug: 'reconnect-plan'`, which is precisely what made an edge into another
    // plan's namespace invisible. The stamp is still what SCOPES enforcement below — it
    // is just no longer what scopes discovery.
    expect(deps.listEdges).toHaveBeenCalledWith({
      harnessSlug: 'papercusp',
      workItemId: 'WI-101',
    });
    expect(deps.listClauses).toHaveBeenCalledWith({
      harnessSlug: 'papercusp',
      planSlug: 'reconnect-plan',
      planItemIds: ['P-003'],
    });
  });

  it('requires an attestation before evaluating test-requiring current clauses', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true, checked: [] });
    if (!result.ok) expect(result.reason).toContain('SPEC-003-01@1');
    expect(deps.listEvidence).not.toHaveBeenCalled();
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('accepts only the exact current complete terminal scorecard', async () => {
    const result = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      passingDeps(),
    );

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it('refuses terminal completion when the only proof is an ephemeral session-local path', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        evidenceRef: '/tmp/pui-p001-counterexample-guard.log',
        coverageEvidenceRef: null,
        testRunId: null,
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true, checked: [] });
    if (!result.ok) {
      expect(result.reason).toContain('traceability');
    }
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('accepts grading-integrity evidence enrichment without coupling prose to the evaluator fingerprint', async () => {
    const deps = passingDeps();
    const card = matchingCard();
    const enrichedRatings = Object.fromEntries(
      Object.entries(card.ratings).map(([key, value]) => [
        key,
        {
          ...value,
          evidence: `${value.evidence} Re-run plans:get-spec-evidence with the exact current binding.`,
        },
      ]),
    );
    deps.listCards.mockResolvedValue([
      {
        ...card,
        ratings: enrichedRatings,
        evidenceFingerprint: scorecardEvidenceFingerprint({
          rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
          ratings: enrichedRatings,
        }),
        gradingAudit: {
          state: 'passed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      },
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it('accepts the exact current cohort without historical unknown bindings vetoing it', async () => {
    const deps = passingDeps();
    const historical = listedEvidence({
      id: 1,
      evidenceRef: 'test:historical',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        dimensions: {
          ...evidence().currentness.dimensions,
          source: 'unknown',
          test: 'unknown',
        },
        unknownReasons: ['source_fingerprint_absent', 'test_fingerprint_absent'],
      },
    });
    const current = listedEvidence({ id: 2 });
    const counterexample = counterexampleEvidence({ id: 3 });
    deps.listEvidence.mockImplementation(async (options) => {
      const rows = [historical, current, counterexample];
      return options.evidenceRefs ? rows.filter((row) => options.evidenceRefs!.includes(row.evidenceRef)) : rows;
    });
    const attestation = {
      ...ATTESTATION,
      evidenceRefs: [current.evidenceRef, counterexample.evidenceRef],
    };
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation }, deps);

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it.each([
    [
      'divergent evaluator verdict',
      {
        ratings: {
          ...matchingCard().ratings,
          freshness: { rating: 'fail', evidence: 'The current evidence is stale.' },
        },
      },
    ],
    [
      'provisional scorecard',
      { provisional: { violatableKeys: ['freshness'], stampedAt: '2026-08-20T00:02:00.000Z' } },
    ],
    [
      'pending grading audit',
      {
        gradingAudit: {
          state: 'pending' as const,
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      },
    ],
  ])('refuses a %s without treating it as pass', async (_label, cardPatch) => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([matchingCard(cardPatch as Partial<ScorecardRow>)]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true, checked: [] });
    if (!result.ok) expect(result.reason).toContain(_label === 'pending grading audit'
      ? 'current proof cohort is awaiting a settled independent grading audit'
      : 'no current terminal complete scorecard');
  });

  it('returns only current pending scorecard issue ids for auditor dispatch', async () => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([
      matchingCard({
        issueId: 'EI-pending-current',
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
      matchingCard({
        issueId: 'EI-pending-superseded',
        supersededBy: 'EI-replacement',
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
      matchingCard({
        issueId: 'EI-pending-retracted',
        retracted: {} as ScorecardRow['retracted'],
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({
      ok: false,
      applicable: true,
      retryable: true,
      pendingGradingAuditTargetIds: ['EI-pending-current'],
    });
  });

  it.each(['passed', 'failed'] as const)(
    'routes a legacy %s audit stamp with missing recorded identity back through pending dispatch',
    async (state) => {
      const deps = passingDeps();
      deps.listCards.mockResolvedValue([
        matchingCard({
          issueId: `EI-legacy-${state}`,
          gradingAudit: {
            state,
            metaRubricRef: 'grading-integrity',
            stampedAt: '2026-08-20T00:02:00.000Z',
            auditIssueId: 'EI-old-audit',
          },
          gradingAuditCurrentness: {
            state: 'unknown',
            reason: 'recorded-identity-missing',
            recordedRevision: null,
            currentRevision: 6,
            recordedCriteriaHash: null,
            currentCriteriaHash: 'hash-current',
          },
        }),
      ]);

      const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

      expect(result).toMatchObject({
        ok: false,
        applicable: true,
        retryable: true,
        pendingGradingAuditTargetIds: [`EI-legacy-${state}`],
      });
      if (!result.ok) expect(result.failedGradingAuditTargetIds).toBeUndefined();
    },
  );

  it('returns only current failed scorecard issue ids for state-specific repair guidance', async () => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([
      matchingCard({
        issueId: 'EI-failed-current',
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
          auditIssueId: 'EI-audit-failed-current',
        },
      }),
      matchingCard({
        issueId: 'EI-failed-superseded',
        supersededBy: 'EI-replacement',
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
      matchingCard({
        issueId: 'EI-failed-retracted',
        retracted: {} as ScorecardRow['retracted'],
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({
      ok: false,
      applicable: true,
      retryable: true,
      failedGradingAuditTargetIds: ['EI-failed-current'],
    });
  });

  it('exposes the audit handle on a FAILED grading audit so the refusal can reach the findings (WI-10002063)', async () => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([
      matchingCard({
        issueId: 'EI-failed-current',
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
          auditIssueId: 'EI-audit-failed-current',
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    if (result.ok) throw new Error('expected the gate to refuse');
    expect(result).toMatchObject({
      failedGradingAudits: [{ issueId: 'EI-failed-current', auditIssueId: 'EI-audit-failed-current' }],
    });
    // The refusal TEXT must carry the resolvable handle too: an agent reading `reason`
    // must not have to already know `failedGradingAudits` exists in order to find the findings.
    expect(result.reason).toContain('EI-audit-failed-current');
  });

  it('distinguishes a FAILED grading audit from a scorecard no-match (WI-10002063)', async () => {
    const failedDeps = passingDeps();
    failedDeps.listCards.mockResolvedValue([
      matchingCard({
        issueId: 'EI-failed-current',
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
          auditIssueId: 'EI-audit-failed-current',
        },
      }),
    ]);
    const failed = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      failedDeps,
    );

    const noMatchDeps = passingDeps();
    noMatchDeps.listCards.mockResolvedValue([]);
    const noMatch = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      noMatchDeps,
    );

    if (failed.ok || noMatch.ok) throw new Error('expected both gates to refuse');

    // A failed audit is not a MATCHING problem. Telling an agent whose evidence matched
    // fine that "no scorecard matches" sends them off re-emitting cards — the active
    // misdirection this guards. The two refusals must not be confusable in EITHER direction.
    expect(failed.reason).toMatch(/grading audit FAILED/);
    expect(failed.reason).not.toMatch(/no current terminal complete scorecard matches/);
    expect(noMatch.reason).toMatch(/no current terminal complete scorecard matches/);
    expect(noMatch.reason).not.toMatch(/grading audit FAILED/);
    expect(noMatch.failedGradingAudits).toBeUndefined();
  });

  it('says plainly when a failed grading audit recorded no audit card, rather than printing a blank handle (WI-10002063)', async () => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([
      matchingCard({
        issueId: 'EI-failed-no-audit-card',
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    if (result.ok) throw new Error('expected the gate to refuse');
    // auditIssueId is legitimately absent on an identity-reopen failure, so the honest
    // statement is the CONTRACT here — a bare interpolation would read "undefined".
    expect(result.reason).toContain('no audit card recorded for graded card EI-failed-no-audit-card');
    expect(result.reason).not.toMatch(/undefined|null/);
    expect(result.failedGradingAudits).toMatchObject([{ issueId: 'EI-failed-no-audit-card' }]);
  });

  it('returns evaluator would-block reasons for stale or otherwise inadequate evidence', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'stale',
          staleReasons: ['test_fingerprint_mismatch'],
        },
      }),
      counterexampleEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'stale',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'stale',
          },
          staleReasons: ['test_fingerprint_mismatch'],
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) expect(result.reason).toContain('freshness');
  });

  it('names the omitted fingerprint dimension in a freshness refusal', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'unknown',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'unknown',
          },
          unknownReasons: ['test-current-fingerprint-not-supplied'],
        },
      }),
      counterexampleEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'unknown',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'unknown',
          },
          unknownReasons: ['test-current-fingerprint-not-supplied'],
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) {
      // Freshness must be a NAMED blocker. It is no longer the only one: under evaluator
      // revision 4 a non-current test binding also cannot corroborate the counterexample's
      // canonical test file, so falsifiability blocks beside it (WI-10006856).
      expect(result.reason).toMatch(/unknown \[[^\]]*\bfreshness\b[^\]]*\]/);
      expect(result.reason).toContain('Freshness is unknown because the currentness probe reported:');
      expect(result.reason).toContain('test:reconnect: testFingerprint omitted');
    }
  });

  it('explains evaluator unknown ratings without claiming a build outage and never dispatches a grading audit', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'unknown',
          dimensions: { ...evidence().currentness.dimensions, test: 'unknown' },
          unknownReasons: ['test-current-fingerprint-not-supplied'],
        },
      }),
      counterexampleEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'unknown',
          dimensions: { ...evidence().currentness.dimensions, test: 'unknown' },
          unknownReasons: ['test-current-fingerprint-not-supplied'],
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true, checked: [] });
    if (!result.ok) {
      expect(result.reason).toMatch(/\d+ criterion\(s\) rated unknown/);
      expect(result.reason).toContain('does not establish a build or evaluator-capability problem');
      expect(result.reason).toContain('plans:evaluate-spec-test-adequacy');
      expect(result.reason).toContain('testFingerprint omitted');
      expect(result.reason).not.toContain('capability unavailable on build');
      expect(result.reason).toContain('freshness');
      expect(result.reason).toContain('grading-integrity audit');
      expect(result.pendingGradingAuditTargetIds).toBeUndefined();
    }
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('distinguishes a mismatched fingerprint dimension in a freshness refusal', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'stale',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'stale',
          },
          staleReasons: ['test_fingerprint_mismatch'],
        },
      }),
      counterexampleEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'stale',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'stale',
          },
          staleReasons: ['test_fingerprint_mismatch'],
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) {
      // See the omitted-dimension case above: freshness must be named, falsifiability may join it.
      expect(result.reason).toMatch(/fail \[[^\]]*\bfreshness\b[^\]]*\]/);
      expect(result.reason).toContain('testFingerprint mismatched');
      expect(result.reason).not.toContain('testFingerprint omitted');
    }
  });

  it('treats an active non-automated clause with no required layers as non-applicable', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([
      clause({ behaviorClass: 'non-automated', requiredTestLayers: [], mutationRequired: false }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM }, deps);

    // WI-10002055: the exemption must be NAMED. `checked: []` alone cannot distinguish
    // this — a clause considered and deliberately excused — from a clause never
    // considered at all, which is what made zero enforcement the silent resting state.
    expect(result).toEqual({
      ok: true,
      applicable: false,
      checked: [],
      exempted: ['SPEC-003-01@1 — exempt (non-automated clause declaring no required test layer)'],
    });
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('honors a current registered inventory exemption for a docs-only feature close without proof', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([clause(), inventoryExemptionClause()]);

    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'feature' },
      changedPaths: ['docs/evidence/inventory.json'],
    }, deps);

    expect(result).toEqual({
      ok: true,
      applicable: false,
      checked: [],
      exempted: [
        'SPEC-003-01@1 — exempt (registered non-code inventory scope INVENTORY-P-003@1; item completion only, final shipment BAR proof remains required)',
      ],
    });
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('keeps runtime adequacy enforced when an inventory feature claims executable source changes', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([clause(), inventoryExemptionClause()]);

    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'feature' },
      changedPaths: ['packages/operator-core/lib/example.ts'],
    }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(!result.ok && result.reason).toContain('SPEC-003-01@1');
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'runtime configuration paths', changedPaths: ['packages/operator-core/package.json'] },
    { label: 'paths outside the documentation tree', changedPaths: ['config/runtime.json'] },
  ])('keeps runtime adequacy enforced for inventory changes in $label', async ({ changedPaths }) => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([clause(), inventoryExemptionClause()]);

    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'feature' },
      changedPaths,
    }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(!result.ok && result.reason).toContain('SPEC-003-01@1');
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('does not infer a documentation inventory exemption without changed-path evidence', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([clause(), inventoryExemptionClause()]);

    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'feature' },
    }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(!result.ok && result.reason).toContain('SPEC-003-01@1');
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('keeps runtime adequacy enforced when the stamped feature covers a sibling plan item', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([
      clause(),
      inventoryExemptionClause(),
      clause({ specId: 'SPEC-004-01', planItemId: 'P-004', contentHash: 'sha256:sibling-v1' }),
    ]);

    const result = await specTestAdequacyCompletionGate({
      workItem: {
        ...WORK_ITEM,
        kind: 'feature',
        sourcePlanItemIds: ['P-003', 'P-004'],
      },
      changedPaths: ['docs/evidence/inventory.json'],
    }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(!result.ok && result.reason).toContain('SPEC-003-01@1');
    expect(!result.ok && result.reason).toContain('SPEC-004-01@1');
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('keeps cross-plan runtime adequacy enforced alongside a registered inventory exemption', async () => {
    const deps = passingDeps();
    const crossPlanClause = clause({
      planSlug: 'other-plan',
      specId: 'SPEC-900-01',
      planItemId: 'P-900',
      contentHash: 'sha256:other-v1',
    });
    deps.listEdges.mockResolvedValue([{
      workItemId: WORK_ITEM.id,
      planSlug: 'other-plan',
      specId: 'SPEC-900-01',
      specRevision: 1,
      specFingerprint: 'sha256:edge',
    }]);
    deps.listClauses.mockImplementation(async ({ planSlug }) =>
      planSlug === 'other-plan' ? [crossPlanClause] : [clause(), inventoryExemptionClause()],
    );

    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'feature' },
      changedPaths: ['docs/evidence/inventory.json'],
    }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(!result.ok && result.reason).toContain('SPEC-900-01@1');
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('keeps runtime adequacy enforced when an inventory feature submits proof', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([clause(), inventoryExemptionClause()]);

    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'feature' },
      changedPaths: ['docs/evidence/inventory.json'],
      attestation: ATTESTATION,
    }, deps);

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    expect(deps.listEvidence).toHaveBeenCalled();
  });

  it('does not infer inventory authority from an unregistered or mismatched exemption clause', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([
      clause(),
      inventoryExemptionClause({
        exemption: { provenance: 'unregistered', justification: 'looks like inventory' },
        acceptanceRef: 'reconnect-plan#D-006',
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'feature' },
      changedPaths: ['docs/evidence/inventory.json'],
    }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(!result.ok && result.reason).toContain('SPEC-003-01@1');
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('treats a task-kind plan deliverable as non-applicable without an executable-proof attestation', async () => {
    const deps = passingDeps();

    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'task' } }, deps);

    expect(result).toEqual({
      ok: true,
      applicable: false,
      checked: [],
      exempted: ['SPEC-003-01@1 — exempt (non-code work-item kind)'],
    });
    expect(deps.listEvidence).not.toHaveBeenCalled();
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it.each(['src/client.ts', 'src/client.rs', 'scripts/run.sh', 'sql/123-fix.sql', 'src/style.css'])(
    'refuses task-kind executable changes to %s even when the attestation is omitted',
    async (path) => {
      const deps = passingDeps();
      const input = { workItem: { ...WORK_ITEM, kind: 'task' }, changedPaths: [path] };

      const result = await specTestAdequacyCompletionGate(input, deps);

      expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
      expect(!result.ok && result.reason).toContain('work_items:update');
      expect(!result.ok && result.reason).toContain('re-claim the current item');
      expect(deps.listEvidence).not.toHaveBeenCalled();
      expect(deps.listCards).not.toHaveBeenCalled();
    },
  );

  it('does not let task kind suppress an explicitly submitted executable-proof attestation', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'task' },
      attestation: ATTESTATION,
    }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(!result.ok && result.reason).toContain('work_items:update');
  });

  it('requires both a code kind AND settled audits, never treating re-kind as proof', async () => {
    const deps = passingDeps();
    const pendingCard = matchingCard({
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-20T00:02:00.000Z',
      },
    });
    deps.listCards.mockResolvedValue([pendingCard]);
    const input = { workItem: { ...WORK_ITEM, kind: 'task' }, attestation: ATTESTATION };

    const wrongKind = await specTestAdequacyCompletionGate(input, deps);
    expect(wrongKind).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(deps.listCards).not.toHaveBeenCalled();

    const rightKind = await specTestAdequacyCompletionGate({
      ...input, workItem: { ...WORK_ITEM, kind: 'change' },
    }, deps);
    expect(rightKind).toMatchObject({
      ok: false, applicable: true, pendingGradingAuditTargetIds: ['EI-scorecard'],
    });
  });

  it('preserves the exemption for genuine documentation changes without an executable attestation', async () => {
    const deps = passingDeps();
    const input = { workItem: { ...WORK_ITEM, kind: 'task' }, changedPaths: ['docs/design.md', 'report.csv'] };

    expect(await specTestAdequacyCompletionGate(input, deps))
      .toEqual({
        ok: true,
        applicable: false,
        checked: [],
        exempted: ['SPEC-003-01@1 — exempt (non-code work-item kind)'],
      });
    expect(deps.listEvidence).not.toHaveBeenCalled();
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('names an excused clause even when a sibling clause IS enforced in the same completion', async () => {
    // The mixed case is the one a populated `checked` hides: without `exempted`, a
    // completion that enforced one clause and silently excused another is
    // indistinguishable from one that enforced everything it was given.
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([
      clause(),
      clause({
        specId: 'SPEC-003-02',
        behaviorClass: 'non-automated',
        requiredTestLayers: [],
        mutationRequired: false,
      }),
    ]);

    const result = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      deps,
    );

    expect(result.exempted).toEqual([
      'SPEC-003-02@1 — exempt (proof floor none — non-automated with no required test layer)',
    ]);
    // The enforced sibling is unaffected: this change reports, it does not gate.
    expect(result.checked).toEqual(['SPEC-003-01@1']);
    expect(result.ok).toBe(true);
  });

  it('reports NO exemption when every clause was genuinely enforced', async () => {
    // Calibration control: if `exempted` were populated unconditionally, the test
    // above would pass while saying nothing. An all-enforced completion must omit it.
    const deps = passingDeps();

    const result = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      deps,
    );

    expect(result.exempted).toBeUndefined();
    expect(result.checked).toEqual(['SPEC-003-01@1']);
  });
});

/**
 * plan-verification-profiles P-004: the executable-proof floor belongs to the CODE module,
 * so it applies only when the clause's plan item resolves to a code deliverable (D-001).
 * The resolver verdict arrives through readClauseCodeDeliverables; absent stays code (D-005).
 */
describe('specTestAdequacyCompletionGate — verification-profile deliverable floor (P-004)', () => {
  const NON_CODE = new Map([['reconnect-plan\u0000P-003', false]]);
  const CODE = new Map([['reconnect-plan\u0000P-003', true]]);

  it('exempts a happy-path clause whose plan item resolves to a non-code deliverable, without an attestation', async () => {
    const deps = passingDeps();
    readClauseCodeDeliverables.mockResolvedValueOnce(NON_CODE);

    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'feature' } }, deps);

    expect(result).toEqual({
      ok: true,
      applicable: false,
      checked: [],
      exempted: ['SPEC-003-01@1 — exempt (non-code deliverable for plan item P-003; the code module does not apply)'],
    });
    expect(readClauseCodeDeliverables).toHaveBeenLastCalledWith({
      harnessSlug: 'papercusp',
      clauses: [expect.objectContaining({ planSlug: 'reconnect-plan', planItemId: 'P-003' })],
    });
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });

  it('keeps the attestation requirement when the same clause resolves to a code deliverable', async () => {
    const deps = passingDeps();
    readClauseCodeDeliverables.mockResolvedValueOnce(CODE);

    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'feature' } }, deps);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/current spec-test-adequacy attestation required for SPEC-003-01@1/);
  });

  it('fails safe to code when the deliverable read throws', async () => {
    const deps = passingDeps();
    readClauseCodeDeliverables.mockRejectedValueOnce(new Error('pg down'));

    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'feature' } }, deps);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/attestation required for SPEC-003-01@1/);
  });

  it('names a non-code clause as exempt beside an enforced code clause under one attestation', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([clause(), clause({ specId: 'SPEC-004-01', planItemId: 'P-004' })]);
    readClauseCodeDeliverables.mockResolvedValueOnce(new Map([
      ['reconnect-plan\u0000P-003', true],
      ['reconnect-plan\u0000P-004', false],
    ]));

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result.exempted).toEqual([
      'SPEC-004-01@1 — exempt (non-code deliverable for plan item P-004; the code module does not apply)',
    ]);
    expect(result.checked).toEqual(['SPEC-003-01@1']);
    expect(result.ok).toBe(true);
  });
});

/**
 * P-016 / D-012 / D-013 — applicability is BEHAVIOR-owned, and the report is advisory.
 *
 * D-013 splits this surface: P-016 REPORTS what the universal resolver newly resolves,
 * P-013 turns the same reconciled condition into hard enforcement. Both halves need a
 * falsifier, and the second is the one that matters: a test that only proves the new
 * clauses are VISIBLE would pass just as happily if P-016 had also started refusing on
 * them, which would block completions fleet-wide on edges authored as documentation.
 */
describe('specTestAdequacyCompletionGate — universal contract resolution (P-016)', () => {
  const OTHER_PLAN_CLAUSE = clause({
    planSlug: 'other-plan',
    specId: 'SPEC-900-01',
    planItemId: 'P-900',
    contentHash: 'sha256:other-v1',
  });

  /** Routes clause reads by namespace so a cross-namespace resolution is observable. */
  function namespacedDeps(
    edges: Array<{ planSlug: string; specId: string; specRevision: number }>,
    clausesByPlan: Record<string, SpecClauseRevision[]>,
    statusByPlan: Record<string, string> = {},
  ) {
    const deps = passingDeps();
    deps.listPlanStatuses = planStatuses(statusByPlan);
    deps.listEdges.mockImplementation(async () =>
      edges.map((edge) => ({
        workItemId: 'WI-101',
        planSlug: edge.planSlug,
        specId: edge.specId,
        specRevision: edge.specRevision,
        specFingerprint: 'sha256:edge',
      })),
    );
    deps.listClauses.mockImplementation(async (options) => {
      const pool = clausesByPlan[options.planSlug] ?? [];
      if (options.specIds) return pool.filter((c) => options.specIds!.includes(c.specId));
      if (options.planItemIds) return pool.filter((c) => options.planItemIds!.includes(c.planItemId));
      return pool;
    });
    return deps;
  }

  it('resolves a STANDALONE behavior-changing item through its edges — no plan provenance needed', async () => {
    const deps = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'other-plan': [OTHER_PLAN_CLAUSE],
    });

    const result = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-101', kind: 'bug', harness: 'papercusp', payload: null } },
      deps,
    );

    // Before P-016 this returned from the missing plan stamp having read nothing at all.
    expect(deps.listEdges).toHaveBeenCalledWith({ harnessSlug: 'papercusp', workItemId: 'WI-101' });

    // P-013: the resolved clause is now ENFORCED, not merely reported. Carrying no plan
    // provenance is exactly what used to buy this item an exemption from its own resolved
    // obligations — the D-012 gap one level down — so the refusal here IS the fix.
    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) expect(result.reason).toContain('SPEC-900-01@1');
  });

  it('ENFORCES a cross-namespace clause — P-013 closes the D-013 split', async () => {
    const deps = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'reconnect-plan': [clause()],
      'other-plan': [OTHER_PLAN_CLAUSE],
    });

    const result = await specTestAdequacyCompletionGate(
      { workItem: { ...WORK_ITEM, kind: 'bug' }, attestation: ATTESTATION },
      deps,
    );

    // This assertion is INVERTED from what it read under P-016, deliberately. P-016
    // resolved cross-namespace clauses but enforced only the stamped namespace's, so this
    // case passed with `checked: ['SPEC-003-01@1']` alone. That half-state was always
    // scoped to end here: both namespaces are eligible, so both refuse.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('SPEC-900-01@1');

    // The evidence read must be scoped to the SAME namespaces as the enforced set. If it
    // stayed single-plan, the cross-namespace clause would find zero rows and refuse for a
    // reason the gate manufactured — a refusal that looks identical to a real one.
    const evidenceCall = deps.listEvidence.mock.calls.at(-1)?.[0];
    expect(evidenceCall?.planSlugs).toEqual(expect.arrayContaining(['reconnect-plan', 'other-plan']));
  });

  it('does NOT enforce a namespace whose plan is not yet eligible — the widening still narrows', async () => {
    // The falsifier for the widening above. Enforcement is gated on plan ELIGIBILITY, so
    // a plan that has shipped (historical) or is still a draft (pre-enforcement) stays
    // report-only. Without this case, "enforces cross-namespace clauses" would pass just
    // as happily if eligibility were ignored entirely and every plan refused — which is
    // the fleet-wide refusal this plan's migration semantics exist to prevent.
    const deps = namespacedDeps(
      [{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }],
      { 'reconnect-plan': [clause()], 'other-plan': [OTHER_PLAN_CLAUSE] },
      { 'other-plan': 'shipped' },
    );

    const result = await specTestAdequacyCompletionGate(
      { workItem: { ...WORK_ITEM, kind: 'bug' }, attestation: ATTESTATION },
      deps,
    );

    // The eligible namespace still enforces and passes; the shipped one does not reach
    // the verdict at all.
    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    if (result.ok) expect(result.checked).not.toContain('SPEC-900-01@1');

    // ...and it is not silently dropped either: the report names it AND says why, so a
    // correct permanent exemption reads differently from an unreconciled migration TODO.
    expect(result.impactReport).toContain('other-plan/SPEC-900-01@1');
    expect(result.impactReport).toContain('already shipped');

    // The evidence read narrows with the enforced set — a shipped plan is never queried.
    const evidenceCall = deps.listEvidence.mock.calls.at(-1)?.[0];
    expect(evidenceCall?.planSlugs).toEqual(['reconnect-plan']);
  });

  it('forwards an exact evidence selection so superseded bindings remain historical without poisoning completion', async () => {
    const deps = passingDeps();
    const evidenceRefs = ['test:reconnect', 'counterexample:reconnect'];
    const result = await specTestAdequacyCompletionGate(
      {
        workItem: { ...WORK_ITEM, kind: 'bug' },
        attestation: { ...ATTESTATION, evidenceRefs },
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    expect(deps.listEvidence).toHaveBeenCalledWith(expect.objectContaining({ evidenceRefs }));
  });

  it('preserves an immutable evaluator replay snapshot through the completion evidence read', async () => {
    const deps = passingDeps();
    const attestation = {
      ...ATTESTATION,
      evidenceRefs: ['test:reconnect', 'counterexample:reconnect'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
    };

    const result = await specTestAdequacyCompletionGate(
      { workItem: { ...WORK_ITEM, kind: 'bug' }, attestation },
      deps,
    );

    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    expect(deps.listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceRefs: attestation.evidenceRefs,
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        replaySnapshot: true,
        // A replayed snapshot is a caller-supplied tuple, never server proof; the
        // completion gate must not be able to buy 'server-measured' with a flag.
        currentProvenance: 'replayed-snapshot',
        current: ATTESTATION.current,
      }),
    );
  });

  it('does NOT enforce an active plan that has adopted no clauses — the per-plan migration lane', async () => {
    // "Migrate active plans individually" is the other half of the scope line. An ACTIVE
    // plan reached only by an edge, with no clause of its own adopted, must not refuse —
    // otherwise enabling enforcement blocks every active plan at once instead of arriving
    // per plan as each is reconciled.
    const deps = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'reconnect-plan': [clause()],
      'other-plan': [],
    });

    const result = await specTestAdequacyCompletionGate(
      { workItem: { ...WORK_ITEM, kind: 'bug' }, attestation: ATTESTATION },
      deps,
    );

    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    const evidenceCall = deps.listEvidence.mock.calls.at(-1)?.[0];
    expect(evidenceCall?.planSlugs).toEqual(['reconnect-plan']);
  });

  it('never turns an unresolved standalone item into a refusal (enforcement is P-013)', async () => {
    const deps = namespacedDeps([], {});

    const result = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-orphan', kind: 'change', harness: 'papercusp', payload: null } },
      deps,
    );

    // D-012 REQUIRES a behavior-changing item to resolve clauses; D-013 assigns the
    // refusal to P-013. So this reports and passes — asserting both together is what
    // stops enforcement from leaking in unnoticed.
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ applicable: false, checked: [] });
    expect(result.impactReport).toContain('Reported, not enforced');
  });

  it('reports an edge pinned to a superseded revision instead of dropping it', async () => {
    const deps = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'other-plan': [{ ...OTHER_PLAN_CLAUSE, revision: 3, currentRevision: 3 }],
    });

    const result = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-101', kind: 'bug', harness: 'papercusp', payload: null } },
      deps,
    );

    // A silently-dropped stale edge is a coverage claim against a since-revised promise.
    expect(result.impactReport).toContain('edge@1 vs current@3');
  });

  it('keeps a draft clause non-enforceable until promotion makes it active', async () => {
    const asDraft = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'other-plan': [{ ...OTHER_PLAN_CLAUSE, lifecycleStatus: 'draft' }],
    });
    const draftResult = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-101', kind: 'bug', harness: 'papercusp', payload: null } },
      asDraft,
    );
    // Candidate inputs are non-enforceable until promoted (D-012), so the clause is
    // resolved but contributes no enforceable obligation — no refusal, nothing to name.
    expect(draftResult).toMatchObject({ ok: true, applicable: false, checked: [] });
    expect(draftResult.impactReport ?? '').not.toContain('other-plan/SPEC-900-01@1');

    const asActive = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'other-plan': [OTHER_PLAN_CLAUSE],
    });
    const activeResult = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-101', kind: 'bug', harness: 'papercusp', payload: null } },
      asActive,
    );
    // The promotion is the only difference between the two runs — a positive control,
    // without which "draft is invisible" is indistinguishable from "nothing resolves".
    //
    // ⚠ The control MOVED with P-013 and had to be re-pointed rather than deleted. It
    // used to read the promoted clause out of `impactReport`; enforcement is what an
    // eligible active clause now produces, so a clause that reaches the VERDICT is the
    // evidence that it resolved. Left as-is, this assertion would have failed for the
    // right reason and been indistinguishable from a regression.
    expect(activeResult).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!activeResult.ok) expect(activeResult.reason).toContain('SPEC-900-01@1');
  });
});

/**
 * P-043 (review-system-rework-reduction-2026-09-23), RSR-P-043-A: a card graded under an older
 * evaluator RULE revision is re-evaluated from its stored bindings at completion; an unchanged
 * verdict keeps the card and its passed audit, and only a changed verdict needs a new one.
 */
describe('P-043: adequacy cards across an evaluator rule revision', () => {
  const PASSED_AUDIT = {
    state: 'passed' as const,
    metaRubricRef: 'grading-integrity',
    stampedAt: '2026-08-20T00:02:00.000Z',
  };

  function stampedCard(recordedRevision: number | undefined, over: Partial<ScorecardRow> = {}): ScorecardRow {
    const live = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: passingEvidence(),
      classRef: 'plan-class-feature-ship',
    });
    expect(live.scorecardDraft.rerunRecipe.evaluatorRevision).toBe(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION);
    const recipe: ScorecardRow['rerunRecipe'] = { ...live.scorecardDraft.rerunRecipe };
    if (recordedRevision === undefined) delete recipe!.evaluatorRevision;
    else recipe!.evaluatorRevision = recordedRevision;
    return matchingCard({ rerunRecipe: recipe, gradingAudit: PASSED_AUDIT, ...over });
  }

  function proofCohort(rows: ListedEvidence[]) {
    return rows.map((row) => ({
      planSlug: row.planSlug, specId: row.specId, specRevision: row.specRevision,
      specFingerprint: row.specFingerprint, evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef, sourceFingerprint: row.fingerprints.sourceFingerprint,
      testFingerprint: row.fingerprints.testFingerprint,
      fixtureFingerprint: row.fingerprints.fixtureFingerprint,
      rubricFingerprint: row.fingerprints.rubricFingerprint,
      environmentFingerprint: row.fingerprints.environmentFingerprint,
    })).sort((a, b) => `${a.evidenceKind}:${a.evidenceRef}`.localeCompare(`${b.evidenceKind}:${b.evidenceRef}`));
  }

  it('refuses an audited card for an older proof cohort even when every verdict stayed pass', async () => {
    const original = passingEvidence();
    const moved = original.map((row) => row.evidenceKind === 'test'
      ? { ...row, fingerprints: { ...row.fingerprints, sourceFingerprint: 'git:new-source' } }
      : row);
    const prior = stampedCard(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION);
    const previousRecipe = {
      ...prior.rerunRecipe!, current: { supplied: true, fingerprints: proofCohort(original) },
    };
    const pendingRecipe = {
      ...prior.rerunRecipe!, current: { supplied: true, fingerprints: proofCohort(moved) },
    };
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue(moved);
    deps.listCards.mockResolvedValue([
      { ...prior, rerunRecipe: previousRecipe },
      stampedCard(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION, {
        issueId: 'EI-refreshed', rerunRecipe: pendingRecipe,
        gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity', stampedAt: '2026-08-20T00:03:00.000Z' },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({
      ok: false, applicable: true, pendingGradingAuditTargetIds: ['EI-refreshed'],
    });
  });

  it('reports the current pending audit instead of a failed audit for an older proof cohort', async () => {
    const original = passingEvidence();
    const moved = original.map((row) => row.evidenceKind === 'test'
      ? { ...row, fingerprints: { ...row.fingerprints, sourceFingerprint: 'git:new-source' } }
      : row);
    const prior = stampedCard(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION);
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue(moved);
    deps.listCards.mockResolvedValue([
      { ...prior, issueId: 'EI-historical-failed',
        rerunRecipe: { ...prior.rerunRecipe!, current: { supplied: true, fingerprints: proofCohort(original) } },
        gradingAudit: { ...PASSED_AUDIT, state: 'failed', auditIssueId: 'EI-historical-audit' } },
      { ...prior, issueId: 'EI-current-pending',
        rerunRecipe: { ...prior.rerunRecipe!, current: { supplied: true, fingerprints: proofCohort(moved) } },
        gradingAudit: { ...PASSED_AUDIT, state: 'pending' } },
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    if (result.ok) throw new Error('expected the current pending audit to block completion');
    expect(result.pendingGradingAuditTargetIds).toEqual(['EI-current-pending']);
    expect(result.failedGradingAuditTargetIds).toBeUndefined();
    expect(result.failedGradingAudits).toBeUndefined();
    expect(result.reason).toContain('current proof cohort is awaiting a settled independent grading audit');
    expect(result.reason).toContain('EI-current-pending');
    expect(result.reason).not.toContain('EI-historical-audit');
    expect(result.reason).not.toContain('grading audit FAILED');
  });

  it('accepts richer criterion explanations for the same independently audited proof cohort', async () => {
    const original = passingEvidence();
    const prior = stampedCard(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION);
    const ratings = Object.fromEntries(Object.entries(prior.ratings).map(([key, rating]) => [
      key, { ...rating, evidence: `${rating.evidence} Verified with a fuller probe.` },
    ])) as ScorecardRow['ratings'];
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([{
      ...prior, ratings,
      rerunRecipe: { ...prior.rerunRecipe!, current: { supplied: true, fingerprints: proofCohort(original) } },
    }]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it.each([false, true])('compares shared scenario receipt fingerprints without losing drift (changed=%s)', async (changed) => {
    const scenarios = ['admin-account', 'unrelated-account'];
    const testCases = scenarios.map((scenario) => `${scenario}: unauthorized events are refused`);
    const scenarioClause = clause({
      falsifier: { observation: 'An unauthorized caller succeeds.', requiredScenarios: scenarios },
    });
    const baseline = listedEvidence();
    baseline.testRunExecution = { ...passingExecution(), passed: testCases.length, passedCaseTitles: testCases };
    baseline.details = {
      ...baseline.details,
      adequacy: {
        ...((baseline.details.adequacy ?? {}) as Record<string, unknown>),
        scenarioIds: scenarios,
        scenarioTestCases: Object.fromEntries(scenarios.map((scenario, index) => [scenario, [testCases[index]]])),
        testCases,
      },
    };
    const mutations = scenarios.map((target, index) => {
      const row = counterexampleEvidence({ id: 2 + index });
      return {
        ...row,
        testRunExecution: { ...row.testRunExecution!, failed: testCases.length },
        testRunProvenance: {
          ...row.testRunProvenance!,
          mutationFailedCaseTitles: testCases,
          mutationFailureLines: testCases.map((title) => `${title}: measured assertion failure`),
        },
        details: {
          ...row.details,
          adequacy: {
            ...((row.details.adequacy ?? {}) as Record<string, unknown>),
            targeted: target, scenarioIds: [target], testCases: [testCases[index]],
          },
        },
      };
    });
    const rows = [baseline, ...mutations];
    const live = evaluateSpecTestAdequacy({
      clause: scenarioClause, evidence: rows, classRef: 'plan-class-feature-ship',
    });
    expect(live.verdict, JSON.stringify(live.ratings)).toBe('pass');
    const card = stampedCard(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION, {
      ratings: live.ratings,
      rerunRecipe: {
        ...live.scorecardDraft.rerunRecipe,
        current: { supplied: true, fingerprints: proofCohort([baseline, mutations[0]]) },
      },
    });
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([scenarioClause]);
    deps.listEvidence.mockResolvedValue(changed ? rows.map((row, index) => index === 2
      ? { ...row, fingerprints: { ...row.fingerprints, sourceFingerprint: 'git:changed-scenario-source' } }
      : row) : rows);
    deps.listCards.mockResolvedValue([card]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result.ok).toBe(!changed);
    if (!result.ok) expect(result.reason).toContain('audited scorecard proof cohort differs');
  });

  it('the evaluator stamps its rule revision on every card recipe, and it is past the pre-stamp revision', () => {
    expect(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION).toBeGreaterThan(1);
  });

  it('keeps an older-revision card and its passed audit when every re-evaluated verdict is unchanged', async () => {
    const deps = passingDeps();
    const older = SPEC_TEST_ADEQUACY_EVALUATOR_REVISION - 1;
    deps.listCards.mockResolvedValue([stampedCard(older)]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toEqual({
      ok: true,
      applicable: true,
      checked: ['SPEC-003-01@1'],
      carriedAcrossEvaluatorRevision: [
        {
          label: 'SPEC-003-01@1',
          issueId: 'EI-scorecard',
          recordedRevision: older,
          currentRevision: SPEC_TEST_ADEQUACY_EVALUATOR_REVISION,
        },
      ],
    });
  });

  it('reads a recipe minted before the stamp as revision 1 and carries it on unchanged verdicts', async () => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([stampedCard(undefined)]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({
      ok: true,
      carriedAcrossEvaluatorRevision: [expect.objectContaining({ recordedRevision: 1 })],
    });
  });

  it('reports nothing carried for a card graded under the current revision', async () => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([stampedCard(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION)]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it('refuses when the rule bump CHANGED a verdict, naming the revision move and the changed criterion', async () => {
    const live = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: passingEvidence(),
      classRef: 'plan-class-feature-ship',
    });
    const [criterion] = Object.entries(live.ratings).find(([, value]) => value.rating === 'pass')!;
    const oldRuleRatings = { ...live.ratings, [criterion]: { rating: 'not-applicable', evidence: 'old rule' } };
    const deps = passingDeps();
    const older = SPEC_TEST_ADEQUACY_EVALUATOR_REVISION - 1;
    deps.listCards.mockResolvedValue([stampedCard(older, { ratings: oldRuleRatings })]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(
      `the evaluator rule moved from revision ${older} to ${SPEC_TEST_ADEQUACY_EVALUATOR_REVISION}`,
    );
    expect(result.reason).toContain(`${criterion}: not-applicable→pass`);
    expect(result.reason).toContain('only these changed verdicts need a re-emitted card and a new audit');
  });
});
