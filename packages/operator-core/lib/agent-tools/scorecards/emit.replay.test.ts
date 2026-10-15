/**
 * Focused regression coverage for the spec-test-adequacy replay guard in
 * scorecards:emit (EI-22661784888485365).
 *
 * A caller can preserve the current[] fingerprints from an older evaluator
 * result while the exact replay now returns an unknown/blocked criterion. The
 * write boundary must compare the submitted pass-like rating with that replay
 * before reading revisions, deduplicating, or filing the scorecard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from '@papercusp/result-encoding';
import { SPEC_TEST_ADEQUACY_EVALUATOR_REVISION } from '../plans/spec-test-adequacy';

const getRubric = vi.fn();
const getRubricCriteriaHash = vi.fn();
const getRubricEvidenceIdentity = vi.fn();
const getRubricPlanRevision = vi.fn();
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...actual,
    getRubric: (...args: unknown[]) => getRubric(...args),
    readRubric: async (rubricId: string) => {
      const rubric = await getRubric(rubricId);
      return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
    },
    getRubricCriteriaHash: (...args: unknown[]) => getRubricCriteriaHash(...args),
    getRubricEvidenceIdentity: (...args: unknown[]) => getRubricEvidenceIdentity(...args),
    getRubricPlanRevision: (...args: unknown[]) => getRubricPlanRevision(...args),
    readRubricPlanRevision: (...args: unknown[]) => readRubricPlanRevision(...args),
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return { ...actual, listScorecards: (...args: unknown[]) => listScorecards(...args) };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...args: unknown[]) => captureImprovement(...args),
}));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: async () => null,
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...actual, getIssue: async () => null };
});
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));

import { emitScorecard } from './emit';

const RUBRIC = {
  rubricId: 'spec-test-adequacy',
  workspaceId: 'ws-test',
  kind: 'standard',
  characteristic: 'plan-proof',
  title: 'Spec-test adequacy',
  description: '',
  criteria: [{ key: 'plan-class-risk-floor', title: 'Risk floor', model: 'm', method: 'm', driftMarkers: 'd' }],
  ratingScale: ['pass', 'unknown', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  revision: 7,
  criteriaHash: 'criteria-v1',
};

const RERUN_RECIPE = {
  schemaVersion: 1 as const,
  evaluator: 'plans:evaluate-spec-test-adequacy' as const,
  evaluatorRevision: SPEC_TEST_ADEQUACY_EVALUATOR_REVISION,
  classRef: 'plan-class-feature-ship' as const,
  args: {
    slug: 'reconnect-plan',
    classRef: 'plan-class-feature-ship' as const,
    specIds: ['SPEC-003-01'],
    includeDraft: true as const,
  },
  selection: {
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidence: [{ evidenceKind: 'integration fixture', evidenceRef: 'surface:reconnect' }],
  },
  current: {
    supplied: true,
    fingerprints: [
      {
        evidenceKind: 'integration fixture',
        evidenceRef: 'surface:reconnect',
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: 'sha256:fixture',
        rubricFingerprint: 'sha256:rubric',
        environmentFingerprint: 'node:24',
      },
    ],
  },
  derivation: {
    kind: 'listSpecEvidence.currentness' as const,
    classifier: 'classifySpecEvidenceCurrentness' as const,
    unknownWhenMissing: true as const,
  },
};

const emitArgs = (over: Record<string, unknown> = {}) => ({
  rubricRef: 'spec-test-adequacy',
  ratings: {
    'plan-class-risk-floor': { rating: 'pass', evidence: 'risk floor is satisfied' },
  },
  rerunRecipe: RERUN_RECIPE,
  subject: { kind: 'plan' as const, ref: 'reconnect-plan#SPEC-003-01@1' },
  ...over,
});

const blockedReplay = {
  ok: true,
  rows: [
    {
      specId: 'SPEC-003-01',
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      ratings: {
        'plan-class-risk-floor': { rating: 'unknown', evidence: 'the proof floor could not be established' },
      },
      wouldBlock: ['plan-class-risk-floor'],
    },
  ],
};

const passingReplay = {
  ok: true,
  rows: [
    {
      specId: 'SPEC-003-01',
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      ratings: {
        'plan-class-risk-floor': { rating: 'pass', evidence: 'the proof floor is established' },
      },
      wouldBlock: [],
    },
  ],
};

const driftedRecipe = {
  ...RERUN_RECIPE,
  evaluatorBuild: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
};

const driftedReplay = {
  ...passingReplay,
  evaluatorBuild: { sha: 'live-evaluator-sha', version: '1.2.3' },
  evaluatorBuildDrift: {
    recorded: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
    live: { sha: 'live-evaluator-sha', version: '1.2.3' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getRubric.mockResolvedValue(RUBRIC);
  getRubricCriteriaHash.mockResolvedValue(null);
  getRubricEvidenceIdentity.mockResolvedValue({ revision: 7, criteriaHash: 'criteria-v1', meaningRevision: null });
  getRubricPlanRevision.mockResolvedValue(7);
  readRubricPlanRevision.mockResolvedValue({ ok: true, revision: 7 });
  listScorecards.mockResolvedValue([]);
  captureImprovement.mockResolvedValue({ ok: true, created: true, issue: { id: 'EI-1' } });
});

describe('scorecards:emit spec-test-adequacy replay guard', () => {
  it.each(['fail', 'unknown'])('retains the %s replay explanation and repair guidance without filing a card', async (rating) => {
    const replay = {
      ...blockedReplay,
      rows: [{
        ...blockedReplay.rows[0],
        ratings: {
          'plan-class-risk-floor': {
            rating,
            evidence: 'Native environment measurement is unavailable for binding 32838.',
            suggestion: 'Capture a current native environment witness before certifying this layer.',
          },
        },
      }],
    };
    const dispatchTool = vi.fn().mockResolvedValue(replay);
    const result = await emitScorecard(emitArgs(), { createdBy: 'su-grader' }, { dispatchTool });

    expect(result).toMatchObject({ ok: false, code: 'invalid_spec_test_adequacy_binding' });
    expect(result.error).toContain('Native environment measurement is unavailable for binding 32838.');
    expect(result.error).toContain('Capture a current native environment witness');
    expect(getRubricPlanRevision).not.toHaveBeenCalled();
    expect(listScorecards).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('bounds oversized replay diagnostics and labels their truncation in the refusal', async () => {
    const replay = {
      ...blockedReplay,
      rows: [{
        ...blockedReplay.rows[0],
        ratings: {
          'plan-class-risk-floor': {
            rating: 'fail',
            evidence: 'Evidence context '.repeat(1000),
            suggestion: 'Repair context '.repeat(1000),
          },
        },
      }],
    };
    const result = await emitScorecard(emitArgs(), { createdBy: 'su-grader' }, {
      dispatchTool: vi.fn().mockResolvedValue(replay),
    });

    expect(result).toMatchObject({ ok: false, code: 'invalid_spec_test_adequacy_binding' });
    expect(result.error).toContain('Evidence context');
    expect(result.error).toContain('Repair context');
    expect(result.error).toContain('[truncated]');
    expect(result.error!.length).toBeLessThan(3000);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('rejects a pass-like card when the exact replay is unknown and wouldBlock includes the criterion', async () => {
    const dispatchTool = vi.fn().mockResolvedValue(blockedReplay);

    const result = await emitScorecard(emitArgs(), { createdBy: 'su-grader' }, { dispatchTool });

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining("returns 'unknown'"),
    });
    expect(result).toMatchObject({ error: expect.stringContaining("wouldBlock includes 'plan-class-risk-floor'") });
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...RERUN_RECIPE.args,
      detail: 'summary',
      includeDraft: true,
      payloadTier: 'full',
    });
    expect(getRubricPlanRevision).not.toHaveBeenCalled();
    expect(listScorecards).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('applies the same refusal when the dispatcher returns the evaluator as a TOON ToolResult', async () => {
    const dispatchTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: `format: toon\n${encode(blockedReplay, 'toon')}` }],
    });

    const result = await emitScorecard(emitArgs(), { createdBy: 'su-grader' }, { dispatchTool });

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining("returns 'unknown'"),
    });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('preserves draft selection while forcing a compact replay before an oversized result can spill', async () => {
    const matchingReplay = { ...passingReplay, evaluatorBuild: driftedRecipe.evaluatorBuild };
    const spillEnvelope = {
      structuredContent: {
        schemaVersion: 'papercusp.output-envelope/v1',
        state: 'incomplete',
        content: [{ kind: 'evidence-reference', uri: 'papercusp://scratch/oversized-evaluator.spill' }],
      },
      content: [{ type: 'text', text: 'oversized evaluator result spilled' }],
    };
    const dispatchTool = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      args.detail === 'summary' && args.includeDraft === true ? matchingReplay : spillEnvelope,
    );

    const result = await emitScorecard(
      emitArgs({ rerunRecipe: driftedRecipe }),
      { createdBy: 'su-grader' },
      { dispatchTool },
    );

    expect(result).toMatchObject({ ok: true, created: true, issueId: 'EI-1' });
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...RERUN_RECIPE.args,
      evaluatorBuild: driftedRecipe.evaluatorBuild,
      detail: 'summary',
      includeDraft: true,
      payloadTier: 'full',
    });
  });

  it('allows filing when the exact replay also passes and does not block the criterion', async () => {
    const dispatchTool = vi.fn().mockResolvedValue(passingReplay);

    const result = await emitScorecard(emitArgs(), { createdBy: 'su-grader' }, { dispatchTool });

    expect(result).toMatchObject({ ok: true, created: true, issueId: 'EI-1' });
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...RERUN_RECIPE.args,
      detail: 'summary',
      includeDraft: true,
      payloadTier: 'full',
    });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('rejects caller-forged measuredAtCommit and fingerprints against the evaluator measurement', async () => {
    const forgedCurrent = RERUN_RECIPE.current.fingerprints.map(fingerprint => ({
      ...fingerprint,
      sourceFingerprint: 'git:caller-forged',
    }));
    const forgedMeasurementEvidence = {
      status: 'measured' as const,
      selectedBindings: 1,
      measuredBindings: 1,
      unavailableBindings: [],
      withoutMeasurementBasis: [],
      bindings: [{
        bindingId: 1,
        evidenceKind: 'integration fixture',
        evidenceRef: 'surface:reconnect',
        status: 'measured' as const,
        measuredAtCommit: 'forged-commit',
      }],
    };
    const freshMeasurementEvidence = {
      ...forgedMeasurementEvidence,
      bindings: [{ ...forgedMeasurementEvidence.bindings[0]!, measuredAtCommit: 'server-measured-commit' }],
    };
    const recipe = {
      ...RERUN_RECIPE,
      current: { ...RERUN_RECIPE.current, fingerprints: forgedCurrent },
      measurementEvidence: forgedMeasurementEvidence,
    };
    const dispatchTool = vi.fn().mockResolvedValue({
      ...passingReplay,
      rows: [{ ...passingReplay.rows[0]!, measurementEvidence: freshMeasurementEvidence }],
    });

    const result = await emitScorecard(
      emitArgs({ rerunRecipe: recipe }),
      { createdBy: 'su-grader' },
      { dispatchTool },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining('server-measured per-binding measurement provenance'),
    });
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...recipe.args,
      detail: 'summary',
      includeDraft: true,
      payloadTier: 'full',
    });
    expect(getRubricPlanRevision).not.toHaveBeenCalled();
    expect(listScorecards).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('deduplicates an existing spec card when only evaluator build provenance changed', async () => {
    const oldBuild = { sha: '91ea137bce', version: '0.0.0' };
    const newBuild = { sha: '95a2bc900c', version: '0.0.0' };
    const priorRecipe = {
      ...RERUN_RECIPE,
      evaluatorBuild: oldBuild,
      args: { ...RERUN_RECIPE.args, evaluatorBuild: oldBuild },
    };
    const nextRecipe = {
      ...RERUN_RECIPE,
      evaluatorBuild: newBuild,
      args: { ...RERUN_RECIPE.args, evaluatorBuild: newBuild },
    };
    const priorCard = {
      issueId: 'EI-existing',
      createdAt: '2026-10-08T12:30:24.623Z',
      createdBy: 'su-grader',
      rubricRef: 'spec-test-adequacy',
      rubricRevision: 7,
      criteriaHash: 'criteria-v1',
      sourceHive: 'papercusp',
      subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      ratings: emitArgs().ratings,
      rerunRecipe: priorRecipe,
      // Historical rows hold the old fingerprint that included evaluatorBuild.
      evidenceFingerprint: 'legacy-build-specific-fingerprint',
    };
    listScorecards.mockImplementation(async (filter: { limit?: number }) =>
      filter.limit === 1 ? [priorCard] : [],
    );
    const dispatchTool = vi.fn().mockResolvedValue({ ...passingReplay, evaluatorBuild: newBuild });

    const result = await emitScorecard(
      emitArgs({ rerunRecipe: nextRecipe }),
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(result).toMatchObject({
      ok: true,
      created: false,
      reason: 'unchanged-evidence',
      previousIssueId: 'EI-existing',
    });
    expect(getRubricEvidenceIdentity).toHaveBeenCalledWith('spec-test-adequacy');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it.each([null, '   '])('refuses an explicit unmeasured evaluator SHA %s before any replay or persistence', async sha => {
    const build = { sha, version: '0.0.0' };
    const dispatchTool = vi.fn().mockResolvedValue({ ...passingReplay, evaluatorBuild: build });
    const result = await emitScorecard(
      emitArgs({ rerunRecipe: { ...RERUN_RECIPE, evaluatorBuild: build,
        args: { ...RERUN_RECIPE.args, evaluatorBuild: build } } }),
      { createdBy: 'su-grader' }, { dispatchTool },
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining(sha === null ? 'unmeasured evaluator build' : 'requires a valid evaluator rerunRecipe') });
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(listScorecards).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses an args-only unmeasured evaluator identity', async () => {
    const result = await emitScorecard(
      emitArgs({ rerunRecipe: { ...RERUN_RECIPE, args: { ...RERUN_RECIPE.args,
        evaluatorBuild: { sha: null, version: '0.0.0' } } } }),
      { createdBy: 'su-grader' }, { dispatchTool: vi.fn().mockResolvedValue(passingReplay) },
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining('unmeasured evaluator build') });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a pass-like card when the evaluator replay reports build drift', async () => {
    const dispatchTool = vi.fn().mockResolvedValue(driftedReplay);

    const result = await emitScorecard(
      emitArgs({ rerunRecipe: driftedRecipe }),
      { createdBy: 'su-grader' },
      { dispatchTool },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining('evaluator-build drift'),
    });
    expect(result).toMatchObject({ error: expect.stringContaining('no pass-like rating was persisted') });
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...RERUN_RECIPE.args,
      evaluatorBuild: driftedRecipe.evaluatorBuild,
      detail: 'summary',
      includeDraft: true,
      payloadTier: 'full',
    });
    expect(getRubricPlanRevision).not.toHaveBeenCalled();
    expect(listScorecards).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});
