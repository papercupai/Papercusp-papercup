/**
 * P-043 (review-system-rework-reduction-2026-09-23), RSR-P-043-A: plans:bind-spec-evidence
 * judges falsifiability TARGETING at bind time with the evaluator's own rule, so a
 * mutation/counterexample binding the evaluator would fail is refused at bind (naming the
 * accepted targets) instead of being proven, audited, and refused at completion.
 *
 * The central guard is an AGREEMENT property: for every target shape, the bind refusal and the
 * evaluator's falsifiability verdict must say the same thing. A bind rule that drifts from the
 * evaluator in EITHER direction fails here — refusing a binding the evaluator accepts lowers
 * nothing but blocks real proof, and accepting one it rejects is the measured rework.
 */
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { SpecClauseRevision, listSpecClauses } from './spec-clauses-store';
import {
  adequacyCardRevisionDisposition,
  evaluateSpecTestAdequacy,
  isAcceptedMutationTarget,
  mutationTargetRequirement,
  SPEC_TEST_ADEQUACY_EVALUATOR_REVISION,
  type SpecEvidenceForAdequacy,
} from './spec-test-adequacy';
import { mutationTargetingRefusal, type bindingSchema } from './bind-spec-evidence';

type Binding = z.infer<typeof bindingSchema>;

const SCENARIO = 'reconnect-failure';
const MUTATION_CASE = 'reconnect is not replayed';
const TARGETING_TEST_FILE = 'packages/operator-core/lib/agent-tools/plans/bind-spec-evidence-targeting.test.ts';

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
    requiredEvidence: ['integration fixture'],
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
  } as SpecClauseRevision;
}

const scenarioClause = () =>
  clause({ falsifier: { observation: 'The reconnect promise is violated.', requiredScenarios: [SCENARIO] } });

function evidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  return {
    workItemId: 'WI-101',
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidenceKind: 'coverage-census',
    evidenceRef: 'surface:reconnect',
    fingerprints: {
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: 'sha256:fixture',
      rubricFingerprint: 'sha256:rubric',
      environmentFingerprint: 'node:24',
    },
    coverageEvidenceRef: 42,
    testRunId: 43,
    // Revision 6 corroborates positive execution claims against parsed ledger counters.
    testRunExecution: {
      status: 'pass', passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      testLayer: 'integration',
    },
    details: {
      adequacy: {
        fixtureCalibrated: true,
        falsifiable: true,
        testLayer: 'integration',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        coverageRungs: { l3: true, l4: false },
      },
    },
    currentness: {
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
    },
    ...over,
  } as SpecEvidenceForAdequacy;
}

/** A successful, ledger-backed negative control carrying `targeted` (or none when undefined). */
function counterexampleRow(targeted: unknown): SpecEvidenceForAdequacy {
  const base = evidence();
  const originRunId = 'targeting-fixture';
  const adequacy: Record<string, unknown> = { ...(base.details.adequacy as Record<string, unknown>), outcome: 'killed' };
  if (targeted !== undefined) adequacy.targeted = targeted;
  return evidence({
    evidenceKind: 'counterexample',
    evidenceRef: `test-run-group:${originRunId}:counterexample`,
    coverageEvidenceRef: null,
    testRunId: 45,
    testRunProvenance: {
      filePath: TARGETING_TEST_FILE,
      source: 'mutation-probe',
      mutationPhase: 'mutant',
      commitSha: null,
      worktreeDirty: null,
      mutationFailureLines: [`${MUTATION_CASE}: expected the counterexample to be observed`],
    },
    testRunExecution: {
      status: 'fail',
      passed: 0,
      failed: 1,
      skipped: 0,
      collectionFailed: false,
      testLayer: 'integration',
    },
    details: {
      adequacy,
      testExecution: {
        schemaVersion: 1,
        originRunId,
        binding: {
          counterexample: { test: MUTATION_CASE, messageIncludes: 'not replayed' },
        },
      },
    },
  });
}

function currentClauseTestRow(): SpecEvidenceForAdequacy {
  return evidence({
    evidenceKind: 'test',
    evidenceRef: 'test-run:targeting-fixture',
    coverageEvidenceRef: null,
    testRunId: 44,
    testRunProvenance: { filePath: TARGETING_TEST_FILE, commitSha: null, worktreeDirty: null },
    testRunExecution: {
      status: 'pass',
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      testLayer: 'integration',
      passedCaseTitles: [MUTATION_CASE],
    },
    details: { adequacy: { testCases: [MUTATION_CASE], outcome: 'passed' } },
  });
}

function evaluatorEvidence(targeted: unknown): SpecEvidenceForAdequacy[] {
  // Revision 4 requires a successful, current same-clause binding for the
  // counterexample's canonical test file before falsifiability can pass.
  return [evidence(), currentClauseTestRow(), counterexampleRow(targeted)];
}

function binding(targeted: unknown, over: Partial<Binding> = {}): Binding {
  const adequacy: Record<string, unknown> = { collected: true, executed: true, skipped: false, outcome: 'killed' };
  if (targeted !== undefined) adequacy.targeted = targeted;
  return {
    workItemId: 'WI-101',
    specId: 'SPEC-003-01',
    specRevision: 1,
    evidenceKind: 'counterexample',
    evidenceRef: 'counterexample:reconnect',
    sourceFingerprint: 'git:abc',
    details: { adequacy },
    ...over,
  } as Binding;
}

function loaderFor(c: SpecClauseRevision) {
  return vi.fn<typeof listSpecClauses>(async () => [c]);
}

const SCOPE = { planSlug: 'reconnect-plan', harnessSlug: 'papercusp', slugArg: 'reconnect-plan' };

describe('RSR-P-043-A: bind-time targeting agrees with the evaluator', () => {
  const cases: Array<{ name: string; clause: () => SpecClauseRevision; targeted: unknown }> = [
    { name: 'scenario clause, declared scenario id', clause: scenarioClause, targeted: SCENARIO },
    { name: 'scenario clause, boolean target', clause: scenarioClause, targeted: true },
    { name: 'scenario clause, sibling scenario id', clause: scenarioClause, targeted: 'other-case' },
    {
      name: 'scenario clause, uppercase scenario id remains case-sensitive',
      clause: scenarioClause,
      targeted: SCENARIO.toUpperCase(),
    },
    { name: 'scenario clause, own specId (fallback only applies with NO scenarios)', clause: scenarioClause, targeted: 'spec-003-01' },
    { name: 'scenario clause, no target', clause: scenarioClause, targeted: undefined },
    { name: 'no-scenario clause, own specId (D-009 fallback)', clause: () => clause(), targeted: 'spec-003-01' },
    { name: 'no-scenario clause, boolean target', clause: () => clause(), targeted: true },
    { name: 'no-scenario clause, sibling spec id', clause: () => clause(), targeted: 'spec-003-02' },
    { name: 'no-scenario clause, no target', clause: () => clause(), targeted: undefined },
  ];

  it.each(cases)('$name', async ({ clause: makeClause, targeted }) => {
    const c = makeClause();
    const evaluatorPasses =
      evaluateSpecTestAdequacy({
        clause: c,
        evidence: evaluatorEvidence(targeted),
        classRef: 'plan-class-feature-ship',
      }).ratings.falsifiability.rating === 'pass';
    const refusal = await mutationTargetingRefusal(binding(targeted), SCOPE, loaderFor(c));

    expect(refusal === null).toBe(evaluatorPasses);
    expect(isAcceptedMutationTarget(c, targeted)).toBe(evaluatorPasses);
  });

  it('accepts the exact uppercase generated specId as a self-target at bind and evaluation', async () => {
    const specId = 'AUTO-BAR-R-5-P-004';
    const c = clause({ specId });
    const evaluatorPasses =
      evaluateSpecTestAdequacy({
        clause: c,
        evidence: [
          { ...evidence(), specId },
          { ...currentClauseTestRow(), specId },
          { ...counterexampleRow(specId), specId },
        ],
        classRef: 'plan-class-feature-ship',
      }).ratings.falsifiability.rating === 'pass';
    const refusal = await mutationTargetingRefusal(binding(specId, { specId }), SCOPE, loaderFor(c));

    expect(mutationTargetRequirement(c).acceptedTargets).toContain(specId);
    expect(evaluatorPasses).toBe(true);
    expect(refusal).toBeNull();
  });

  it('the matrix is not vacuous: it holds both accepted and refused targets', () => {
    const verdicts = cases.map(({ clause: makeClause, targeted }) => isAcceptedMutationTarget(makeClause(), targeted));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  // Falsifiability controls, kept permanently beside the subject instead of mutating
  // bind-spec-evidence.ts in the shared tree. The same agreement check must REJECT a bind that
  // never refuses (the pre-P-043 behaviour) and one that refuses every targeted binding, and must
  // ACCEPT the real guard, or the matrix above could pass for a reason unrelated to the rule.
  type Refuse = (b: Binding, c: SpecClauseRevision) => Promise<unknown>;
  async function disagreements(refuse: Refuse): Promise<string[]> {
    const out: string[] = [];
    for (const { name, clause: makeClause, targeted } of cases) {
      const c = makeClause();
      const evaluatorPasses =
        evaluateSpecTestAdequacy({
          clause: c,
          evidence: evaluatorEvidence(targeted),
          classRef: 'plan-class-feature-ship',
        }).ratings.falsifiability.rating === 'pass';
      if (((await refuse(binding(targeted), c)) === null) !== evaluatorPasses) out.push(name);
    }
    return out;
  }

  it('controls: the agreement check catches a never-refusing and an always-refusing bind', async () => {
    expect(await disagreements(async () => null)).not.toEqual([]);
    expect(await disagreements(async () => ({ ok: false, error: 'mutation_target_rejected' }))).not.toEqual([]);
  });

  it('calibration: the real guard disagrees with the evaluator on no case', async () => {
    expect(await disagreements((b, c) => mutationTargetingRefusal(b, SCOPE, loaderFor(c)))).toEqual([]);
  });

  it('a refusal names the accepted targets and a correctedCall the evaluator then accepts', async () => {
    const c = scenarioClause();
    const refusal = await mutationTargetingRefusal(binding(true), SCOPE, loaderFor(c));

    expect(refusal).toMatchObject({
      clause: 'SPEC-003-01@1',
      targeted: true,
      acceptedTargets: [SCENARIO],
      correctedCall: { tool: 'plans:bind-spec-evidence', args: { slug: 'reconnect-plan' } },
    });
    expect(refusal!.reason).toContain(SCENARIO);
    const corrected = (refusal!.correctedCall.args as { binding: Binding }).binding;
    expect(corrected.details?.adequacy).toMatchObject({ targeted: SCENARIO, outcome: 'killed' });
    expect(await mutationTargetingRefusal(corrected, SCOPE, loaderFor(c))).toBeNull();
  });

  it('returns a compact replay call for a refused fromTestRun item', async () => {
    const c = scenarioClause();
    const correctionInput = {
      workItemId: 'WI-143',
      specId: 'SPEC-003-01',
      specRevision: 1,
      fromTestRun: 214,
      details: { adequacy: { testCases: [MUTATION_CASE] } },
    };
    const refusal = await mutationTargetingRefusal(
      binding(undefined),
      { ...SCOPE, harnessArg: 'web' },
      loaderFor(c),
      correctionInput,
    );

    expect(refusal?.correctedCall).toEqual({
      tool: 'plans:bind-spec-evidence',
      args: {
        harness: 'web',
        slug: 'reconnect-plan',
        items: [{
          ...correctionInput,
          details: { adequacy: { testCases: [MUTATION_CASE], targeted: SCENARIO } },
        }],
      },
    });
    expect(JSON.stringify(refusal?.correctedCall).length).toBeLessThan(600);
  });

  it('names the D-009 own-specId fallback for a clause with no declared scenarios', async () => {
    const refusal = await mutationTargetingRefusal(binding(undefined), SCOPE, loaderFor(clause()));
    expect(refusal?.acceptedTargets).toEqual(['SPEC-003-01', 'spec-003-01']);
    expect(refusal?.reason).toContain("this clause's own specId");
    expect(mutationTargetRequirement(clause()).selfTarget).toBe('SPEC-003-01');
  });

  it('resolves the exact bound revision, and never loads a clause for a non-targeting evidence kind', async () => {
    const loader = loaderFor(scenarioClause());
    await mutationTargetingRefusal(binding(SCENARIO, { specRevision: 3 }), SCOPE, loader);
    expect(loader).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'reconnect-plan', specIds: ['SPEC-003-01'], revision: 3 }),
    );

    const untouched = loaderFor(scenarioClause());
    expect(await mutationTargetingRefusal(binding(true, { evidenceKind: 'test' }), SCOPE, untouched)).toBeNull();
    expect(untouched).not.toHaveBeenCalled();
  });

  it('defers an unknown spec to the store instead of inventing a refusal', async () => {
    const empty = vi.fn<typeof listSpecClauses>(async () => []);
    expect(await mutationTargetingRefusal(binding(true), SCOPE, empty)).toBeNull();
  });
});

describe('RSR-P-043-A: an adequacy card across an evaluator revision bump', () => {
  const live = { falsifiability: { rating: 'pass' }, freshness: { rating: 'pass' } };
  const recorded = { falsifiability: { rating: 'pass', evidence: 'x' }, freshness: { rating: 'pass', evidence: 'y' } };

  it('carries an older-revision card whose verdicts are unchanged (its audit stays valid)', () => {
    expect(
      adequacyCardRevisionDisposition({ recordedRevision: 1, recordedRatings: recorded, liveRatings: live, currentRevision: 2 }),
    ).toEqual({ recordedRevision: 1, currentRevision: 2, changed: [], state: 'carried' });
  });

  it('reads a missing stamp as revision 1', () => {
    expect(
      adequacyCardRevisionDisposition({ recordedRevision: undefined, recordedRatings: recorded, liveRatings: live }),
    ).toMatchObject({ recordedRevision: 1, currentRevision: SPEC_TEST_ADEQUACY_EVALUATOR_REVISION, state: 'carried' });
  });

  it('marks a same-revision card with unchanged verdicts current', () => {
    expect(
      adequacyCardRevisionDisposition({ recordedRevision: 2, recordedRatings: recorded, liveRatings: live, currentRevision: 2 })
        .state,
    ).toBe('current');
  });

  it('a changed verdict — including a criterion present on only one side — needs a new card and audit', () => {
    const changed = adequacyCardRevisionDisposition({
      recordedRevision: 1,
      recordedRatings: { ...recorded, falsifiability: { rating: 'pass' } },
      liveRatings: { ...live, falsifiability: { rating: 'unknown' }, 'test-layer': { rating: 'pass' } },
      currentRevision: 2,
    });
    expect(changed.state).toBe('verdict-changed');
    expect(changed.changed).toEqual([
      { criterion: 'falsifiability', recorded: 'pass', current: 'unknown' },
      { criterion: 'test-layer', recorded: null, current: 'pass' },
    ]);
  });
});
