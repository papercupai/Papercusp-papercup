/**
 * P-013 (goal-mode-design-intent-hardening-2026-08-16, D-004): grade-the-grader.
 * A TERMINAL standard-rubric card is stamped audit-pending; a NON-AUTHOR audit
 * against the grading-integrity meta-rubric settles it. The self-audit refusal and
 * the flag-off case are the falsifiability controls — an implementation that stamps
 * unconditionally, or settles on a self-audit, fails one of them in each direction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { scorecardRatingEntrySchema } from './evaluate';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { PgReadQueryTimeoutError } from '../../pg-read-query';

const getRubric = vi.fn();
const getRubricEvidenceIdentity = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const getIssue = vi.fn();
const recordGradingAudit = vi.fn();
const markGradingAuditAwaitingReemit = vi.fn();
const isCurrentSourceAuditResponder = vi.fn();
const closeSourceAuditConsults = vi.hoisted(() => vi.fn());
vi.mock('../../grading-audit-routing', () => ({ closeSourceAuditConsults }));
// This suite supplies legacy vetting cards below. The newer direct-critique
// reader is a separate PG boundary, covered by its own suite; leaving it live
// makes the audit-stamp exclusion case reach the real org-admin database.
vi.mock('../../acceptance-rubric-critique', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acceptance-rubric-critique')>()),
  readCurrentAcceptanceRubricCritique: vi.fn(async () => null),
}));
const gateEnabled = vi.fn();
const dispatchPendingGradingAudits = vi.fn();
const readRunningGeneration = vi.fn();
const replaySpecTestAdequacyForHistoricalAudit = vi.fn();

vi.mock('../plans/evaluate-spec-test-adequacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans/evaluate-spec-test-adequacy')>();
  return {
    ...actual,
    replaySpecTestAdequacyForHistoricalAudit: (...args: unknown[]) => replaySpecTestAdequacyForHistoricalAudit(...args),
  };
});

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    // scorecards:emit now uses the failure-aware writer read; keep this unit
    // suite on the same mocked rubric fixtures instead of falling through to PG.
    readRubric: async (rubricId: string) => {
      const rubric = await getRubric(rubricId);
      return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
    },
    getRubricEvidenceIdentity: (...a: unknown[]) => getRubricEvidenceIdentity(...a),
    // EI-21828643965337454 put the acceptance path behind a FAIL-CLOSED revision
    // read. Unstubbed, it reached the real PG-backed read, returned `ok:false`, and
    // the acceptance-kind case below refused with `..._revision_unreadable` — which
    // looked like the audit-stamp exclusion breaking, when nothing about stamping
    // had changed. Stub it readable; the unreadable leg is covered in
    // emit.vetting.test.ts, which is where that guard's behaviour belongs.
    readRubricPlanRevision: async () => ({ ok: true, revision: 1 }),
    // EI-22177729599840121: the (fail-open) sibling read the new vet-before-grade
    // check uses via acceptance-rubric-vetting.ts's default deps — previously
    // unreached from this file, now exercised by the single acceptance-kind test
    // below. Stub it readable (revision 1, matching readRubricPlanRevision above)
    // rather than leaving it to fall through to the real PG-backed implementation.
    getRubricPlanRevision: async () => 1,
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return {
    ...real,
    listScorecards: (...a: unknown[]) => listScorecards(...a),
    recordGradingAudit: (...a: unknown[]) => recordGradingAudit(...a),
    markGradingAuditAwaitingReemit: (...a: unknown[]) => markGradingAuditAwaitingReemit(...a),
    isCurrentSourceAuditResponder: (...a: unknown[]) => isCurrentSourceAuditResponder(...a),
  };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...a: unknown[]) => captureImprovement(...a),
}));
// Keep scorecard writes inside the unit tier: these push notifications are
// database-backed in production and are covered by their own integration tests.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
const emitScorecardEmitted = vi.hoisted(() => vi.fn());
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted }));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: (...args: unknown[]) => readRunningGeneration(...args),
}));
vi.mock('../../build-info', () => ({
  getBuildInfo: () => ({ sha: 'graded-evaluator-sha', version: '1.2.2' }),
}));
// Collaborator mock, matching emit-evaluate.test.ts. emit.ts's acceptance branch
// calls these identity helpers, which fall back to a REAL org-admin pool when no
// sql seam is injected — a unit tier must not open a live connection. This file
// predated the callerInImplementerLineage guard added to emit.ts on 2026-08-30.
vi.mock('../../acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  areAcceptanceLineageRelated: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  // grader-eligibility resolves the plan's principal implementers before the
  // author/lineage rails; these cards have no subject plan, so the seat is empty.
  resolvePlanImplementerIdentities: vi.fn(async () => []),
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...real, getIssue: (...a: unknown[]) => getIssue(...a) };
});
vi.mock('../../grading-integrity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../grading-integrity')>();
  return {
    ...real,
    dispatchPendingGradingAudits: (...a: unknown[]) => dispatchPendingGradingAudits(...a),
    gradingAuditGateEnabled: (...a: unknown[]) => gateEnabled(...a),
  };
});

import { emitScorecard, scorecardEmitArgs } from './emit';
import { SPEC_TEST_ADEQUACY_EVALUATOR_REVISION } from '../plans/spec-test-adequacy';
import { auditVerdictFromRatings } from '../../scorecards';
import { needsGradingAudit } from '../../grading-integrity';
import type { ObservationRatings } from '../../harness/improvements/observation-types';

const mkRubric = (rubricId: string, kind: string) => ({
  rubricId,
  revision: 1,
  criteriaHash: 'rubric-hash-v1',
  workspaceId: 'ws',
  kind,
  characteristic: 'grading-integrity',
  title: rubricId,
  description: '',
  criteria: [{ key: 'c1', title: 'C1', model: 'm', method: 'm', driftMarkers: 'd' }],
  ratingScale: ['pass', 'fail', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-rubric-author',
  proposedBy: 'su-rubric-author',
  ratifiedBy: 'su-ratifier',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
});

const RATINGS: ObservationRatings = { c1: { rating: 'pass', evidence: 're-ran the probe, held' } };
const FAIL_RATINGS: ObservationRatings = { c1: { rating: 'fail', evidence: 'probe not re-runnable' } };
const RE_RUN_FAIL_RATINGS: ObservationRatings = {
  're-runnable-evidence': { rating: 'fail', evidence: 'probe not re-runnable' },
};
const RE_RUN_PASS_RATINGS: ObservationRatings = {
  're-runnable-evidence': { rating: 'pass', evidence: 'probe replayed on the available evaluator' },
};
const RE_RUN_UNKNOWN_RATINGS: ObservationRatings = {
  're-runnable-evidence': { rating: 'unknown', evidence: 'available evaluator returned unknown' },
};
const REPLAY_SPLIT_RATINGS: ObservationRatings = {
  're-runnable-evidence': { rating: 'pass', evidence: 'exact target recipe executed' },
  'degenerate-distribution': {
    rating: 'fail',
    evidence: 'spot replay contradicted the uniform target card',
    evidenceKind: 'test',
    evidenceRef: 'surface:reconnect',
  },
};

const RERUN_RECIPE = {
  schemaVersion: 1 as const,
  evaluator: 'plans:evaluate-spec-test-adequacy' as const,
  evaluatorBuild: { sha: 'graded-evaluator-sha', version: '1.2.2' },
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
    evidence: [{ evidenceKind: 'test', evidenceRef: 'surface:reconnect' }],
  },
  current: {
    supplied: true,
    fingerprints: [
      {
        evidenceKind: 'test',
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

const GRADED_CARD = {
  id: 'EI-CARD',
  createdAt: '2026-10-02T00:14:36.135Z',
  createdBy: 'su-grader-author',
  payload: {
    observation: {
      rubricRef: 'goal-mode-e2e',
      ratings: { c1: { rating: 'pass', evidence: 'e' } },
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-17T12:00:00.000Z',
        rubricRevision: 1,
        criteriaHash: 'rubric-hash-v1',
      },
    },
  },
};

const replayableGradedCard = (deployedSha: string) => ({
  ...GRADED_CARD,
  payload: {
    observation: {
      ...GRADED_CARD.payload.observation,
      rerunRecipe: RERUN_RECIPE,
      gradedGeneration: {
        deployedSha,
        hostStartedAt: '2026-09-08T18:00:00.000Z',
      },
    },
  },
});

const runningGeneration = (deployedSha: string) => ({
  deployedSha,
  hostStartedAt: '2026-09-08T19:00:00.000Z',
  bootHeadSha: null,
  scoutCodeHash: null,
  staleHost: false,
});

const replayAuditRubric = () => ({
  ...mkRubric('grading-integrity', 'standard'),
  criteria: [
    { key: 're-runnable-evidence', title: 'Re-runnable evidence', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
});

const replayConsistencyAuditRubric = () => ({
  ...mkRubric('grading-integrity', 'standard'),
  criteria: [
    { key: 're-runnable-evidence', title: 'Re-runnable evidence', model: 'm', method: 'm', driftMarkers: 'd' },
    { key: 'degenerate-distribution', title: 'Degenerate distribution', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
});

const replayConsistencyGradedCard = () => ({
  ...replayableGradedCard('a'.repeat(40)),
  payload: {
    observation: {
      ...replayableGradedCard('a'.repeat(40)).payload.observation,
      rubricRef: 'spec-test-adequacy',
      ratings: { traceability: { rating: 'pass', evidence: 'exact binding replay passed' } },
    },
  },
});

const legacyReplayConsistencyGradedCard = () => ({
  ...replayConsistencyGradedCard(),
  payload: {
    observation: {
      ...replayConsistencyGradedCard().payload.observation,
      rerunRecipe: {
        ...RERUN_RECIPE,
        args: {
          ...RERUN_RECIPE.args,
          evidenceRefs: ['surface:reconnect'],
          specRevision: 1,
          specFingerprint: 'sha256:spec-v1',
          replaySnapshot: true,
          current: RERUN_RECIPE.current.fingerprints,
        },
        selection: {
          ...RERUN_RECIPE.selection,
          evidence: [{ evidenceKind: 'test', evidenceRef: 'surface:reconnect' }],
        },
      },
    },
  },
});

const targetReplay = (
  rating: 'pass' | 'fail',
  evaluatorBuild = RERUN_RECIPE.evaluatorBuild,
) => ({
  ok: true,
  evaluatorBuild,
  rows: [
    {
      specId: 'SPEC-003-01',
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      verdict: rating,
      wouldBlock: rating === 'fail' ? ['traceability'] : [],
      ratings: { traceability: { rating } },
    },
  ],
});

const historicalTargetReplay = (
  rating: 'pass' | 'fail',
  evaluatorBuild = RERUN_RECIPE.evaluatorBuild,
) => ({
  ...targetReplay(rating, evaluatorBuild),
  historicalAuditOnly: {
    provenance: 'historical-audit-only',
    asOf: GRADED_CARD.createdAt,
    freshness: 'historical-snapshot',
    bindings: [{
      id: 19999,
      evidenceKind: 'test',
      evidenceRef: 'surface:reconnect',
      createdAt: '2026-10-01T23:00:00.000Z',
      withdrawal: { at: '2026-10-02T01:00:00.000Z', reason: 'superseded by binding 21019' },
    }],
  },
});

const exactReplayConsistencyGradedCard = () => {
  const card = replayConsistencyGradedCard();
  const current = [{
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidenceKind: 'test',
    evidenceRef: 'surface:reconnect',
    sourceFingerprint: 'git:graded',
    testFingerprint: 'sha256:test-graded',
  }];
  return {
    ...card,
    payload: {
      observation: {
        ...card.payload.observation,
        rerunRecipe: {
          ...RERUN_RECIPE,
          args: {
            ...RERUN_RECIPE.args,
            evidenceRefs: ['surface:reconnect'],
            bindingIds: [19999],
            specRevision: 1,
            specFingerprint: 'sha256:spec-v1',
            replaySnapshot: true,
          },
          selection: { ...RERUN_RECIPE.selection, bindingIds: [19999] },
          current: { supplied: true, fingerprints: current },
        },
      },
    },
  };
};

beforeEach(() => {
  emitScorecardEmitted.mockReset().mockResolvedValue(undefined);
  closeSourceAuditConsults.mockReset().mockResolvedValue(undefined);
  getRubric.mockReset().mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
  getRubricEvidenceIdentity.mockReset().mockImplementation(async (id: string) => {
    const rubric = await getRubric(id);
    return { revision: rubric?.revision ?? null, criteriaHash: rubric?.criteriaHash ?? null, meaningRevision: null };
  });
  listScorecards.mockReset().mockResolvedValue([]);
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-AUDIT-1' } });
  getIssue.mockReset().mockResolvedValue(null);
  recordGradingAudit.mockReset().mockResolvedValue({
    ok: true,
    issueId: 'EI-CARD',
    gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: 'x' },
  });
  markGradingAuditAwaitingReemit.mockReset().mockResolvedValue(true);
  isCurrentSourceAuditResponder.mockReset().mockResolvedValue(true);
  gateEnabled.mockReset().mockResolvedValue(true);
  dispatchPendingGradingAudits.mockReset().mockResolvedValue({ requestedTargetIds: [], receipts: [] });
  readRunningGeneration.mockReset().mockResolvedValue(null);
  replaySpecTestAdequacyForHistoricalAudit.mockReset().mockResolvedValue(historicalTargetReplay('pass'));
});

describe('CRM canonical producer independence (P-012)', () => {
  const args = { rubricRef: 'crm-interaction-quality', rubricRevision: 1, criteriaHash: 'a'.repeat(64),
    ratings: { c1: { ...RATINGS.c1, evidenceRef: 'source:42' } },
    subject: { kind: 'work-item' as const, ref: 'WI-42' }, terminal: true,
    interactionReviewerHandle: { workspaceId: 'ws', harnessSlug: 'crm', receiptId: 43,
      operationId: 'call-review', specificationRevision: 'b'.repeat(64), target: { kind: 'work-item' as const, id: 'WI-43' } } };
  const input = { createdBy: 'su-reviewer', workspaceId: 'ws', ctxHarness: 'crm' };
  const producer = { state: 'done', terminalOwner: 'su-producer', terminalCompletionRef: 'completion:42' };
  const reader = (value: unknown = producer) => vi.fn(async () => value) as never;
  const reviewer = (ownerId = 'su-reviewer') => vi.fn(async () => ({ ownerId, completionRef: 'completion:43',
    output: { interactionGrade: { gradedWorkItemRef: 'WI-42', rubricRef: args.rubricRef,
      rubricRevision: args.rubricRevision, criteriaHash: args.criteriaHash,
      ratings: [{ key: 'c1', ...args.ratings.c1 }] } }, evidenceRef: 'operation-output:43',
    input: { reviewBinding: { gradedWorkItemRef: 'WI-42', rubricRef: args.rubricRef,
      rubricRevision: args.rubricRevision, criteriaHash: args.criteriaHash } } }));

  beforeEach(() => getRubric.mockResolvedValue({ ...mkRubric('crm-interaction-quality', 'standard'), criteriaHash: 'a'.repeat(64) }));

  it('refuses a changed review instrument before reading the producer or writing', async () => {
    const read = reader();
    for (const pin of [{ rubricRevision: 2 }, { criteriaHash: 'b'.repeat(64) }]) {
      expect(await emitScorecard({ ...args, ...pin }, input, { readInteractionProducer: read }))
        .toMatchObject({ ok: false, code: 'scorecard_rubric_identity_mismatch' });
    }
    expect(read).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses instrument drift or failed identity reads after the independence check', async () => {
    for (const identity of [{ revision: 2, criteriaHash: 'a'.repeat(64), meaningRevision: null },
      { revision: null, criteriaHash: null, meaningRevision: null }]) {
      getRubricEvidenceIdentity.mockResolvedValueOnce(identity);
      expect(await emitScorecard(args, input, { readInteractionProducer: reader(), readInteractionReviewer: reviewer(), lineageRelated: async () => false }))
        .toMatchObject({ ok: false, code: 'scorecard_rubric_identity_mismatch' });
    }
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it.each(['su-producer', 'su-child'])('refuses producer or producer lineage %s before a ledger write', async (createdBy) => {
    const related = vi.fn(async () => true);
    const result = await emitScorecard(args, { ...input, createdBy }, {
      readInteractionProducer: reader(), readInteractionReviewer: reviewer(), lineageRelated: related,
    });
    expect(result).toMatchObject({ ok: false, code: 'interaction_grader_in_producer_lineage' });
    expect(related).toHaveBeenCalledWith('su-producer', createdBy);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('permits an unrelated reviewer through the canonical writer', async () => {
    const read = reader();
    const result = await emitScorecard(args, input, { readInteractionProducer: read,
      readInteractionReviewer: reviewer(), lineageRelated: async () => false });
    expect(result.ok).toBe(true);
    expect(read).toHaveBeenCalledWith('ws', 'WI-42', { includeBody: false });
    expect(captureImprovement).toHaveBeenCalledOnce();
    expect(captureImprovement.mock.calls[0][0].payloadExtra.observation.interactionReviewer)
      .toEqual({ ownerId: 'su-reviewer', completionRef: 'completion:43', outputEvidenceRef: 'operation-output:43', handle: args.interactionReviewerHandle });
  });

  it.each([{ rating: 'fail' }, { evidence: 'invented evidence' }, { evidenceRef: 'different-source' }])
    ('refuses ratings changed by the transport caller %j', async (patch) => {
      expect(await emitScorecard({ ...args, ratings: { c1: { ...args.ratings.c1, ...patch } } }, input,
        { readInteractionProducer: reader(), readInteractionReviewer: reviewer(), lineageRelated: async () => false }))
        .toMatchObject({ ok: false, code: 'interaction_reviewer_output_mismatch' });
      expect(captureImprovement).not.toHaveBeenCalled();
    });

  it.each([null, {}, { interactionGrade: { ratings: [] } }])
    ('refuses missing or incomplete canonical reviewer output %j', async (output) => {
      const readReview = async () => ({ ...await reviewer()(), output });
      expect(await emitScorecard(args, input,
        { readInteractionProducer: reader(), readInteractionReviewer: readReview, lineageRelated: async () => false }))
        .toMatchObject({ ok: false, code: 'interaction_reviewer_output_mismatch' });
      expect(captureImprovement).not.toHaveBeenCalled();
    });

  it.each(['su-producer', 'su-child'])('refuses actual reviewer %s behind an unrelated app caller', async (ownerId) => {
    const related = vi.fn(async (_producer: string | null | undefined, candidate: string | null | undefined) => candidate === ownerId);
    expect(await emitScorecard(args, { ...input, createdBy: 'app:crm' }, {
      readInteractionProducer: reader(), readInteractionReviewer: reviewer(ownerId), lineageRelated: related,
    })).toMatchObject({ code: 'interaction_grader_in_producer_lineage' });
    expect(related).toHaveBeenCalledWith('su-producer', ownerId);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a missing reviewer receipt and failed canonical receipt read', async () => {
    expect(await emitScorecard({ ...args, interactionReviewerHandle: undefined }, input,
      { readInteractionProducer: reader() })).toMatchObject({ code: 'interaction_reviewer_required' });
    expect(await emitScorecard(args, input, { readInteractionProducer: reader(),
      readInteractionReviewer: vi.fn().mockRejectedValue(new Error('handle_mismatch')) }))
      .toMatchObject({ code: 'interaction_producer_unreadable' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('permits a distinct terminal reviewer through an unrelated app transport', async () => {
    const readReview = reviewer('su-independent');
    expect((await emitScorecard(args, { ...input, createdBy: 'app:crm' }, {
      readInteractionProducer: reader(), readInteractionReviewer: readReview, lineageRelated: async () => false,
    })).ok).toBe(true);
    expect(readReview).toHaveBeenCalledWith(args.interactionReviewerHandle, 'app:crm');
    expect(captureImprovement.mock.calls[0][0].payloadExtra.observation.interactionReviewer.ownerId).toBe('su-independent');
  });

  it('verifies the retained binding after private source cleanup without requiring a public source packet', async () => {
    const proof = await reviewer('su-independent')();
    expect(proof.input).not.toHaveProperty('reviewContext');
    expect(proof.input.reviewBinding).not.toHaveProperty('sourceContent');
    expect((await emitScorecard(args, { ...input, createdBy: 'app:crm' }, {
      readInteractionProducer: reader(), readInteractionReviewer: async () => proof,
      lineageRelated: async () => false,
    })).ok).toBe(true);
  });

  it.each([{ gradedWorkItemRef: 'WI-99' }, { rubricRef: 'other' }, { rubricRevision: 2 },
    { criteriaHash: 'c'.repeat(64) }])('refuses a changed retained review binding %j', async (patch) => {
    const proof = await reviewer()();
    proof.input.reviewBinding = { ...proof.input.reviewBinding, ...patch };
    expect(await emitScorecard(args, input, { readInteractionProducer: reader(),
      readInteractionReviewer: async () => proof, lineageRelated: async () => false,
    })).toMatchObject({ ok: false, code: 'interaction_reviewer_mismatch' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses an unbound public source packet as a replacement for retained review identity', async () => {
    const proof = await reviewer()();
    expect(await emitScorecard(args, input, { readInteractionProducer: reader(),
      readInteractionReviewer: async () => ({ ...proof, input: { reviewContext: proof.input.reviewBinding } }),
      lineageRelated: async () => false,
    })).toMatchObject({ ok: false, code: 'interaction_reviewer_mismatch' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it.each([{ workspaceId: 'other' }, { harnessSlug: 'other' }, { operationId: 'send-email' },
    { target: { kind: 'work-item' as const, id: 'WI-42' } }])('refuses an out-of-scope reviewer handle %j', async (patch) => {
    const readReview = reviewer();
    expect(await emitScorecard({ ...args, interactionReviewerHandle: { ...args.interactionReviewerHandle, ...patch } }, input,
      { readInteractionProducer: reader(), readInteractionReviewer: readReview }))
      .toMatchObject({ code: 'interaction_reviewer_required' });
    expect(readReview).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses a review of a different producing task', async () => {
    expect(await emitScorecard(args, input, { readInteractionProducer: reader(),
      readInteractionReviewer: async () => ({ ownerId: 'reviewer', completionRef: 'completion:43',
        output: null, evidenceRef: 'operation-output:43',
        input: { reviewBinding: { gradedWorkItemRef: 'WI-99' } } }) }))
      .toMatchObject({ code: 'interaction_reviewer_mismatch' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it.each([null, { ...producer, state: 'open' }, { ...producer, terminalOwner: null },
    { ...producer, terminalCompletionRef: null }])('fails closed on unresolved producer %j', async (row) => {
    const result = await emitScorecard(args, input, { readInteractionProducer: reader(row) });
    expect(result).toMatchObject({ ok: false, code: 'interaction_producer_unresolved' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses missing subject and failed identity reads', async () => {
    expect(await emitScorecard({ ...args, rubricRevision: undefined }, input)).toMatchObject({ code: 'interaction_producer_required' });
    expect(await emitScorecard({ ...args, subject: undefined }, input)).toMatchObject({ code: 'interaction_producer_required' });
    expect(await emitScorecard(args, input, { readInteractionProducer: vi.fn().mockRejectedValue(new Error('read failed')) }))
      .toMatchObject({ code: 'interaction_producer_unreadable' });
    expect(await emitScorecard(args, input, { readInteractionProducer: reader(), readInteractionReviewer: reviewer(), lineageRelated: async () => { throw new Error('identity failed'); } }))
      .toMatchObject({ code: 'interaction_producer_unreadable' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses the proposed instrument before grading', async () => {
    getRubric.mockResolvedValue({ ...mkRubric('crm-interaction-quality', 'standard'),
      status: 'proposed', criteriaHash: 'a'.repeat(64) });
    expect(await emitScorecard(args, input)).toMatchObject({ ok: false, code: 'interaction_rubric_not_active' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});

describe('scorecards:emit audit-pending stamp (P-013)', () => {
  it('returns a retryable no-write envelope for a bounded PG statement timeout', async () => {
    captureImprovement.mockRejectedValueOnce(new OrgTxnTimeoutError('57014', new Error('statement timeout')));

    const result = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'scorecard_emit_timeout',
      pgCode: '57014',
      retryable: true,
    });
    expect((result as { error?: string }).error).toContain('No scorecard was persisted by this attempt');
  });

  it('returns a retryable no-write envelope when the database pool acquisition misses its deadline', async () => {
    captureImprovement.mockRejectedValueOnce(
      new DbCallDeadlineError('boundedPgReadTxn:acquire(admin)', 8_000, 8_000, 'org-admin'),
    );

    const result = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'scorecard_emit_timeout',
      retryable: true,
    });
    expect((result as { pgCode?: string }).pgCode).toBeUndefined();
    expect((result as { error?: string }).error).toContain('No scorecard was persisted by this attempt');
  });

  it('returns a retryable no-write envelope when a bounded read misses its whole-call deadline', async () => {
    captureImprovement.mockRejectedValueOnce(
      new PgReadQueryTimeoutError(
        'Query call did not complete within 16000ms of the WHOLE call (connect + acquire + execute)',
      ),
    );

    const result = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'scorecard_emit_timeout',
      retryable: true,
    });
    expect((result as { error?: string }).error).toContain('No scorecard was persisted by this attempt');
  });

  it('pins only the newly emitted card audit while preserving the caller identity and context', async () => {
    const launchContext: UnifiedToolContext = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      emit: vi.fn(),
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      runId: 'emit-pinned-audit-test',
      isSuperuser: true,
      uiClientId: 'su-grader',
      role: 'su',
      gateBypass: { role: true, capability: true, quota: true },
      transport: 'mcp',
      requestedFormat: 'json',
      contextTier: 'full',
      tx: {},
    };
    Object.freeze(launchContext);
    const gradingLaunch = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' };
    const args = scorecardEmitArgs.parse({
      rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true, gradingLaunch,
    });
    const res = await emitScorecard(args,
      { createdBy: 'su-grader', ctxHarness: 'papercusp', launchContext });

    expect(res).toMatchObject({ ok: true, issueId: 'EI-AUDIT-1', gradingAuditPending: true });
    await vi.waitFor(() => expect(dispatchPendingGradingAudits).toHaveBeenCalledOnce());
    expect(dispatchPendingGradingAudits).toHaveBeenCalledWith({
      targetIds: ['EI-AUDIT-1'], ctx: { ...launchContext, gradingLaunch }, harness: 'papercusp',
    });
    expect(captureImprovement.mock.calls[0]?.[0]).toMatchObject({ createdBy: 'su-grader' });
    expect(launchContext).not.toHaveProperty('gradingLaunch');
  });

  it.each([
    { agent: 'claude', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' },
    { agent: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', account: 'auto' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', account: 'auto' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'default' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto', createdBy: 'other' },
  ])('refuses an unsupported audit profile before any card or dispatch: %j', (gradingLaunch) => {
    expect(scorecardEmitArgs.safeParse({
      rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true, gradingLaunch,
    }).success).toBe(false);
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(dispatchPendingGradingAudits).not.toHaveBeenCalled();
  });

  it('targets the newly filed card even without an explicit grading launch profile', async () => {
    const launchContext = { workspaceId: 'ws-test', harnessSlug: 'papercusp' };
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp', launchContext: launchContext as never },
    );

    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(dispatchPendingGradingAudits).toHaveBeenCalledOnce());
    expect(dispatchPendingGradingAudits).toHaveBeenCalledWith({
      targetIds: ['EI-AUDIT-1'],
      ctx: launchContext,
      harness: 'papercusp',
    });
  });

  it('names targeted repair instead of promising automatic dispatch without a launch context', async () => {
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );

    expect(res).toMatchObject({ ok: true, issueId: 'EI-AUDIT-1', gradingAuditPending: true });
    expect(dispatchPendingGradingAudits).not.toHaveBeenCalled();
    expect((res as { gradingAuditNextStep?: string }).gradingAuditNextStep)
      .toContain("scorecards:repair { targetIds:['EI-AUDIT-1'] }");
    expect((res as { gradingAuditNextStep?: string }).gradingAuditNextStep)
      .not.toContain('automatically selects');
  });

  it('a terminal standard-rubric card is stamped pending and says so in the result', async () => {
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );
    expect(res.ok).toBe(true);
    expect((res as { gradingAuditPending?: boolean }).gradingAuditPending).toBe(true);
    // EI-22068670622018218: the boolean alone told callers THAT the card was pending but
    // not what settles it, so the mechanism got rediscovered a gate-refusal later. The
    // stamp must ship the next step with it: a NON-AUTHOR grading-integrity audit naming
    // THIS card, plus the two traps (self-audit refused, re-emit files a duplicate).
    const nextStep = (res as { gradingAuditNextStep?: string }).gradingAuditNextStep ?? '';
    expect(nextStep).toContain('NON-AUTHOR');
    expect(nextStep).toContain("scorecards:repair { targetIds:['EI-AUDIT-1'] }");
    expect(nextStep).toContain('grading-integrity');
    expect(nextStep).toContain("subject:{ kind:'scorecard'");
    expect(nextStep).toMatch(/self-audits are refused/i);
    expect(nextStep).toMatch(/duplicate pending card/i);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { gradingAudit?: { state: string; metaRubricRef: string } } };
    };
    expect(payload.payloadExtra.observation.gradingAudit).toMatchObject({
      state: 'pending',
      metaRubricRef: 'grading-integrity',
    });
  });

  it('control (kill-switch): flag OFF stamps nothing', async () => {
    gateEnabled.mockResolvedValue(false);
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );
    expect(res.ok).toBe(true);
    expect((res as { gradingAuditPending?: boolean }).gradingAuditPending).toBeUndefined();
    // The next step is bound to the stamp that creates it: no stamp, no instruction to
    // audit a card nothing is waiting on.
    expect((res as { gradingAuditNextStep?: string }).gradingAuditNextStep).toBeUndefined();
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { gradingAudit?: unknown } };
    };
    expect(payload.payloadExtra.observation.gradingAudit).toBeUndefined();
  });

  it('an acceptance-kind card is NOT stamped (it has its own grader ≠ author gate)', async () => {
    getRubric.mockResolvedValue(mkRubric('plan-x-acceptance', 'acceptance'));
    // EI-22177729599840121: this is the first acceptance-kind case in this file to
    // reach emitScorecard's vet-before-grade check (createdBy 'su-grader' ≠ the
    // rubric's 'su-rubric-author') — satisfy it with a current attestation so this
    // test stays about audit-stamp exclusion, not vetting.
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-08-25T21:00:12Z',
        createdBy: 'su-vetting-author',
        rubricRef: 'meta-acceptance-rubric',
        subject: { kind: 'rubric', ref: 'plan-x-acceptance' },
        ratings: RATINGS,
        nKeys: 1,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 1,
          criteriaHash: 'rubric-hash-v1',
          critiquePosts: 1,
          critics: ['su-critic'],
        },
      },
    ]);
    const res = await emitScorecard(
      { rubricRef: 'plan-x-acceptance', ratings: RATINGS, terminal: true },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
      // This case exercises audit-stamp exclusion, not the PG-backed coord
      // identity lineage. Keep the unit test on the existing identity seam.
      { sameAcceptanceAuthor: async () => false },
    );
    expect(res.ok).toBe(true);
    expect((res as { gradingAuditPending?: boolean }).gradingAuditPending).toBeUndefined();
  });
});

describe('scorecards:emit grading audit path (P-013)', () => {
  const auditArgs = {
    rubricRef: 'grading-integrity',
    ratings: RATINGS,
    terminal: true,
    subject: { kind: 'scorecard' as const, ref: 'EI-CARD' },
  };
  const activeReservation = {
    key: 'grading-audit:EI-CARD',
    reservedAt: '2026-09-23T18:00:00.000Z',
  };
  const gradedCardWithReservation = () => ({
    ...GRADED_CARD,
    payload: {
      observation: {
        ...GRADED_CARD.payload.observation,
        gradingAudit: {
          ...GRADED_CARD.payload.observation.gradingAudit,
          dispatchReservation: activeReservation,
        },
      },
    },
  });
  const gradedCardWithLapsedReservation = () => ({
    ...GRADED_CARD,
    payload: {
      observation: {
        ...GRADED_CARD.payload.observation,
        gradingAudit: {
          ...GRADED_CARD.payload.observation.gradingAudit,
          lastDispatchReservation: activeReservation,
        },
      },
    },
  });
  beforeEach(() => {
    getRubric.mockResolvedValue(mkRubric('grading-integrity', 'standard'));
    getIssue.mockResolvedValue(GRADED_CARD);
  });

  it('identifies an omitted active dispatch lease before filing a card', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());

    const res = await emitScorecard(auditArgs, { createdBy: 'su-second-auditor', ctxHarness: 'papercusp' });

    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('grading_audit_reservation_missing');
    expect((res as { error?: string }).error).toContain('gradingAuditReservation is missing');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('identifies a mismatched active dispatch lease before filing a card', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());

    const res = await emitScorecard(
      {
        ...auditArgs,
        gradingAuditReservation: { ...activeReservation, reservedAt: '2026-09-23T18:00:01.000Z' },
      },
      { createdBy: 'su-stale-auditor', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('grading_audit_reservation_mismatch');
    expect((res as { error?: string }).error).toContain('does not match its latest dispatch reservation epoch');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses a stale grading-audit stamp before filing an unrecordable audit card', async () => {
    getIssue.mockResolvedValue({
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          gradingAudit: {
            ...GRADED_CARD.payload.observation.gradingAudit,
            rubricRevision: 1,
            criteriaHash: 'hash-before-edit',
          },
        },
      },
    });

    const res = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });

    expect(res).toMatchObject({ ok: false });
    expect((res as { error?: string }).error).toContain('stale gradingAudit stamp (criteria-hash-mismatch)');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses and reopens a target whose pinned evaluator build became stale before filing', async () => {
    getIssue.mockResolvedValue({
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          rerunRecipe: {
            ...RERUN_RECIPE,
            evaluatorBuild: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
          },
        },
      },
    });

    const res = await emitScorecard(
      auditArgs,
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { getEvaluatorBuild: () => ({ sha: 'live-evaluator-sha', version: '1.2.2' }) },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_evaluator_changed' });
    expect((res as { error?: string }).error).toContain('sha-mismatch');
    expect(markGradingAuditAwaitingReemit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({ state: 'pending' }),
      expect.objectContaining({
        responderOwnerId: 'su-auditor',
        reason: expect.stringContaining('evaluatorBuildCurrentness=stale (sha-mismatch)'),
      }),
    );
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('settles only when the emitter presents the exact active dispatch lease', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());

    const res = await emitScorecard(
      { ...auditArgs, gradingAuditReservation: activeReservation },
      { createdBy: 'su-dispatched-auditor', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(true);
    expect(recordGradingAudit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({ dispatchReservation: activeReservation }),
    );
  });

  it('refuses a prior cascade answerer before filing when the consult moved to another auditor', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());
    isCurrentSourceAuditResponder.mockResolvedValue(false);

    const res = await emitScorecard(
      { ...auditArgs, gradingAuditReservation: activeReservation },
      { createdBy: 'su-stale-answerer', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('different active consult answerer');
    expect(isCurrentSourceAuditResponder).toHaveBeenCalledWith('EI-CARD', activeReservation, 'su-stale-answerer');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  // EI-25246208524832409: a long audit can outlive the 15-min active lease. The
  // retained latest epoch proves this is still the dispatched auditor's lease.
  it('admits the dispatched auditor whose lease lapsed and carries the retained epoch into settlement', async () => {
    getIssue.mockResolvedValue(gradedCardWithLapsedReservation());
    const res = await emitScorecard(
      { ...auditArgs, gradingAuditReservation: activeReservation },
      { createdBy: 'su-lapsed-auditor', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(true);
    expect(isCurrentSourceAuditResponder).toHaveBeenCalledWith('EI-CARD', activeReservation, 'su-lapsed-auditor');
    expect(recordGradingAudit).toHaveBeenCalledTimes(1);
    // The lapsed token must reach the settle CAS so a newer claim-and-release cannot win
    // between the pre-emit read and the atomic update.
    const [subject, settled] = recordGradingAudit.mock.calls[0] as [string, Record<string, unknown>];
    expect(subject).toBe('EI-CARD');
    expect(settled).toMatchObject({ dispatchReservation: activeReservation });
    expect(settled).toMatchObject({ auditor: 'su-lapsed-auditor' });
  });

  it('refuses a lapsed lease presented by a session that is not its consult answerer', async () => {
    getIssue.mockResolvedValue(gradedCardWithLapsedReservation());
    isCurrentSourceAuditResponder.mockResolvedValue(false);

    const res = await emitScorecard(
      { ...auditArgs, gradingAuditReservation: activeReservation },
      { createdBy: 'su-other-answerer', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('grading_audit_reservation_unavailable');
    expect(isCurrentSourceAuditResponder).toHaveBeenCalledWith('EI-CARD', activeReservation, 'su-other-answerer');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('a NON-AUTHOR audit files, settles the subject, and is itself never stamped pending (one level)', async () => {
    const res = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(res.ok).toBe(true);
    expect(closeSourceAuditConsults).toHaveBeenCalledWith(expect.any(String), 'EI-CARD');
    expect(recordGradingAudit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({
        auditIssueId: 'EI-AUDIT-1',
        auditor: 'su-auditor',
        verdict: 'passed',
        rubricRevision: 1,
        criteriaHash: 'rubric-hash-v1',
        requireCurrentIdentity: true,
      }),
    );
    expect((res as { gradingAuditRecorded?: boolean }).gradingAuditRecorded).toBe(true);
    // D-004 one level: the audit card carries NO pending stamp of its own.
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { gradingAudit?: unknown } };
    };
    expect(payload.payloadExtra.observation.gradingAudit).toBeUndefined();
  });

  it('a failing rating settles the subject as failed', async () => {
    await emitScorecard({ ...auditArgs, ratings: FAIL_RATINGS }, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
  });

  it.each([[true, false], [true, true], [false, false]])('an identical retry finishes only the existing audit settlement (success=%s, cleanupFails=%s)', async (success, cleanupFails) => {
    getIssue.mockResolvedValue(gradedCardWithReservation());
    recordGradingAudit.mockRejectedValueOnce(new Error('connection closed after audit insert'));
    const args = { ...auditArgs, gradingAuditReservation: activeReservation };
    const input = { createdBy: 'su-auditor', ctxHarness: 'papercusp' };
    await expect(emitScorecard(args, input)).rejects.toThrow('connection closed after audit insert');
    const stored = captureImprovement.mock.calls[0][0].payloadExtra.observation;
    listScorecards.mockResolvedValue([{ ...stored, issueId: 'EI-AUDIT-1', createdBy: input.createdBy }]);
    recordGradingAudit.mockResolvedValueOnce(success
      ? { ok: true, gradingAudit: { state: 'passed', auditIssueId: 'EI-AUDIT-1', auditor: input.createdBy } }
      : { ok: false, error: 'dispatch reservation changed' });
    if (cleanupFails) closeSourceAuditConsults.mockRejectedValueOnce(new Error('consult cleanup unavailable'));

    const retry = await emitScorecard(args, input);
    expect(retry).toMatchObject({ created: false, reason: 'unchanged-evidence', previousIssueId: 'EI-AUDIT-1', gradingAuditRecorded: success });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(recordGradingAudit).toHaveBeenLastCalledWith('EI-CARD', expect.objectContaining({
      auditIssueId: 'EI-AUDIT-1', auditor: input.createdBy, dispatchReservation: activeReservation, requireCurrentIdentity: true,
    }));
    if (success) {
      if (cleanupFails) expect(retry).toMatchObject({ gradingAuditCleanupError: 'consult cleanup unavailable' });
      expect(closeSourceAuditConsults).toHaveBeenCalledOnce();
      expect(emitScorecardEmitted).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'EI-AUDIT-1' }),
        expect.objectContaining({ filed: false, settledAudit: expect.objectContaining({ issueId: 'EI-CARD', state: 'passed' }) }));
    } else {
      expect(retry).toMatchObject({ gradingAuditError: 'dispatch reservation changed' });
      expect(closeSourceAuditConsults).not.toHaveBeenCalled();
      expect(emitScorecardEmitted).not.toHaveBeenCalled();
    }
  });

  it('does not attribute an identical stored audit to a different retrying auditor', async () => {
    getIssue.mockResolvedValue(GRADED_CARD);
    recordGradingAudit.mockRejectedValueOnce(new Error('settlement interrupted'));
    await expect(emitScorecard(auditArgs, { createdBy: 'su-original', ctxHarness: 'papercusp' })).rejects.toThrow();
    const stored = captureImprovement.mock.calls[0][0].payloadExtra.observation;
    listScorecards.mockResolvedValue([{ ...stored, issueId: 'EI-AUDIT-1', createdBy: 'su-original' }]);
    recordGradingAudit.mockClear();
    const retry = await emitScorecard({ ...auditArgs, acknowledgeExisting: true }, { createdBy: 'su-other', ctxHarness: 'papercusp' });
    expect(retry).toMatchObject({ created: false, reason: 'unchanged-evidence' });
    expect(recordGradingAudit).not.toHaveBeenCalled();
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  // EI-26525990062935280: the first auditor's card was persisted but its settlement
  // failed, and that auditor is gone, so only a fresh dispatched auditor can settle
  // the stamp. Its audit must not be refused as a redundant independent card.
  it('lets a freshly dispatched auditor settle a pending stamp that an earlier audit card never settled', async () => {
    getIssue.mockResolvedValue(gradedCardWithReservation());
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-STRANDED-AUDIT',
        createdAt: '2026-09-23T17:00:00.000Z',
        createdBy: 'su-departed-auditor',
        rubricRef: 'grading-integrity',
        rubricRevision: 1,
        criteriaHash: 'rubric-hash-v1',
        subject: { kind: 'scorecard', ref: 'EI-CARD' },
        ratings: RATINGS,
        nKeys: 1,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);

    const res = await emitScorecard(
      { ...auditArgs, ratings: FAIL_RATINGS, gradingAuditReservation: activeReservation },
      { createdBy: 'su-fresh-auditor', ctxHarness: 'papercusp' },
    );

    expect((res as { code?: string }).code).not.toBe('existing_independent_scorecards');
    expect(res.ok).toBe(true);
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(recordGradingAudit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({
        auditor: 'su-fresh-auditor',
        verdict: 'failed',
        dispatchReservation: activeReservation,
      }),
    );
  });

  // The guard still refuses a redundant NON-audit card: see the
  // existing_independent_scorecards cases in emit-evaluate.test.ts.

  it('refuses unknown audit ratings before filing an orphan audit card', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    const res = await emitScorecard(
      {
        ...auditArgs,
        ratings: {
          're-runnable-evidence': { rating: 'unknown', evidence: 'the evaluator build could not verify this' },
          'degenerate-distribution': { rating: 'unknown', evidence: 'the evaluator build could not verify this' },
        },
      },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_verdict_unknown' });
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
    expect(closeSourceAuditConsults).not.toHaveBeenCalled();
  });

  it('refuses a same-rubric non-author emit for a pending subject audit and teaches the grading-integrity shape', async () => {
    getRubric.mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
    getIssue.mockResolvedValue(null);
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-PENDING-SUBJECT',
        createdAt: '2026-08-27T14:00:00.000Z',
        createdBy: 'su-subject-author',
        subject: { kind: 'plan', ref: 'plan-x' },
        rubricRef: 'goal-mode-e2e',
        ratings: RATINGS,
        nKeys: 1,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-27T14:00:00.000Z',
        },
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);

    const res = await emitScorecard(
      {
        rubricRef: 'goal-mode-e2e',
        ratings: RATINGS,
        terminal: true,
        subject: { kind: 'plan', ref: 'plan-x' },
      },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('grading-integrity');
    expect((res as { error?: string }).error).toContain("supersedes:'EI-PENDING-SUBJECT'");
    expect((res as { error?: string }).error).toContain("subject:{ kind:'scorecard'");
    expect((res as { error?: string }).error).toContain('EI-PENDING-SUBJECT');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('dedupes an identical same-author terminal replay before checking its pending audit', async () => {
    getRubric.mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
    getIssue.mockResolvedValue(null);
    const args = {
      rubricRef: 'goal-mode-e2e',
      ratings: RATINGS,
      terminal: true,
      subject: { kind: 'plan' as const, ref: 'plan-x' },
    };
    const input = { createdBy: 'su-subject-author', ctxHarness: 'papercusp' };
    const original = await emitScorecard(args, input);
    expect(original).toMatchObject({ ok: true, created: true, gradingAuditPending: true });

    const observation = captureImprovement.mock.calls[0]?.[0].payloadExtra.observation;
    const pendingCard = {
      ...observation,
      issueId: 'EI-PENDING-IDENTICAL-REPLAY',
      createdBy: input.createdBy,
      rubricRef: args.rubricRef,
      subject: args.subject,
      gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity' },
    };
    listScorecards.mockImplementation(async (filter: { rubricRef?: string; limit?: number }) => {
      if (filter.rubricRef === 'grading-integrity') return [];
      return filter.limit === 1 || filter.limit === 100 ? [pendingCard] : [];
    });
    captureImprovement.mockClear();
    dispatchPendingGradingAudits.mockClear();

    const retry = await emitScorecard(args, input);

    expect(retry).toMatchObject({
      ok: true,
      created: false,
      reason: 'unchanged-evidence',
      previousIssueId: pendingCard.issueId,
    });
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(dispatchPendingGradingAudits).not.toHaveBeenCalled();
  });

  it('refuses a same-author re-emit while the subject still has a live pending audit', async () => {
    getRubric.mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
    getIssue.mockResolvedValue(null);
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-PENDING-SAME-AUTHOR',
        createdAt: '2026-08-27T14:00:00.000Z',
        createdBy: 'su-subject-author',
        subject: { kind: 'plan', ref: 'plan-x' },
        rubricRef: 'goal-mode-e2e',
        ratings: RATINGS,
        nKeys: 1,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-27T14:00:00.000Z',
        },
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);

    const res = await emitScorecard(
      {
        rubricRef: 'goal-mode-e2e',
        ratings: RATINGS,
        terminal: true,
        force: true,
        subject: { kind: 'plan', ref: 'plan-x' },
      },
      { createdBy: 'su-subject-author', ctxHarness: 'papercusp' },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_required' });
    expect((res as { error?: string }).error).toContain('EI-PENDING-SAME-AUTHOR');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  describe('a RE-OPENED audit (WI-10005211)', () => {
    // A grading-integrity revision re-opens every settled audit, so a windowed
    // grader's earlier cards all read pending again at once. The card already
    // carries an independent verdict; it must not block its own author's next card.
    const reopenedCard = {
      issueId: 'EI-REOPENED',
      createdAt: '2026-10-01T12:38:00.000Z',
      createdBy: 'su-subject-author',
      subject: { kind: 'plan', ref: 'plan-x' },
      rubricRef: 'goal-mode-e2e',
      ratings: RATINGS,
      nKeys: 1,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        rubricRevision: 10,
        stampedAt: '2026-10-02T01:38:32.000Z',
      },
      synthesized: false,
      score10: 10,
      linkedItems: [],
    };
    const priorAudit = (retracted?: object) => ({
      issueId: 'EI-PRIOR-AUDIT',
      createdAt: '2026-10-01T14:19:00.000Z',
      createdBy: 'su-auditor',
      subject: { kind: 'scorecard', ref: 'EI-REOPENED' },
      rubricRef: 'grading-integrity',
      ratings: RATINGS,
      nKeys: 1,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      synthesized: false,
      score10: 10,
      linkedItems: [],
      ...(retracted ? { retracted } : {}),
    });
    const withAudits = (audits: object[]) =>
      listScorecards.mockImplementation(async (filter: { rubricRef?: string }) =>
        filter.rubricRef === 'grading-integrity' ? audits : [reopenedCard],
      );
    const emitNext = (createdBy: string) =>
      emitScorecard(
        {
          rubricRef: 'goal-mode-e2e',
          ratings: RATINGS,
          terminal: true,
          force: true,
          subject: { kind: 'plan', ref: 'plan-x' },
        },
        { createdBy, ctxHarness: 'papercusp' },
      );

    beforeEach(() => {
      getRubric.mockResolvedValue(mkRubric('goal-mode-e2e', 'standard'));
      getIssue.mockResolvedValue(null);
    });

    it("files the author's next same-subject card instead of refusing on its own re-opened card", async () => {
      withAudits([priorAudit()]);

      const res = await emitNext('su-subject-author');

      expect(res.ok).toBe(true);
      expect(captureImprovement).toHaveBeenCalledOnce();
      expect(listScorecards).toHaveBeenCalledWith(
        expect.objectContaining({ rubricRef: 'grading-integrity', subjectRefs: ['EI-REOPENED'] }),
      );
    });

    it('control: a RETRACTED prior audit is not a verdict, so the card still blocks', async () => {
      withAudits([priorAudit({ reason: 'withdrawn', at: '2026-10-01T15:00:00.000Z' })]);

      const res = await emitNext('su-subject-author');

      expect(res).toMatchObject({ ok: false, code: 'grading_audit_required' });
      expect((res as { error?: string }).error).toContain('EI-REOPENED');
      expect(captureImprovement).not.toHaveBeenCalled();
    });

    it('control: a NON-AUTHOR is still taught the audit shape on a re-opened card', async () => {
      withAudits([priorAudit()]);

      const res = await emitNext('su-other-grader');

      expect(res).toMatchObject({ ok: false, code: 'grading_audit_required' });
      expect((res as { error?: string }).error).toContain("subject:{ kind:'scorecard', ref:'EI-REOPENED' }");
      expect(captureImprovement).not.toHaveBeenCalled();
    });
  });

  it('control (THE mirror rule): a SELF-audit is refused and nothing is filed or settled', async () => {
    const res = await emitScorecard(auditArgs, {
      createdBy: 'su-grader-author', // the graded card's own author
      ctxHarness: 'papercusp',
    });
    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('self_audit_refused');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses an auditor in the graded card author lineage, not only the exact author', async () => {
    const lineageRelated = vi.fn(async (
      first: string | null | undefined,
      second: string | null | undefined,
      _opts?: import('../../acceptance-author-identity').AcceptanceAuthorIdentityOpts,
    ) => {
      return first === 'su-grader-author' && second === 'su-grader-descendant';
    });
    const res = await emitScorecard(
      auditArgs,
      {
        createdBy: 'su-grader-descendant',
        ctxHarness: 'papercusp',
        workspaceId: 'ws-test',
      },
      { lineageRelated },
    );
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining("auditor 'su-grader-descendant' is in the graded card author's identity lineage ('su-grader-author')"),
    });
    expect(lineageRelated).toHaveBeenCalledWith('su-grader-author', 'su-grader-descendant', {
      workspaceId: 'ws-test',
    });
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses an auditor who is the graded card evidence source even when they are not its author', async () => {
    getIssue.mockResolvedValue({
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          // The critic identity is the evidence source for this vetting card;
          // its author is deliberately different to prove the old author-only
          // guard would have allowed the audit.
          vetting: {
            consultId: 'conv-vetting',
            rubricRevision: 1,
            critiquePosts: 1,
            critics: ['su-evidence-source'],
          },
        },
      },
    });

    const res = await emitScorecard(auditArgs, {
      createdBy: 'su-evidence-source',
      ctxHarness: 'papercusp',
      workspaceId: 'ws-test',
    });

    expect(res).toMatchObject({ ok: false, code: 'auditor_is_graded_card_evidence_source' });
    expect((res as { error?: string }).error).toContain('recorded evidence source');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('refuses a degenerate-distribution failure when the historical replay reproduces every target rating', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    const dispatchTool = vi.fn().mockResolvedValue(targetReplay('pass'));

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_consistent' });
    expect((res as { error?: string }).error).toContain('reproduced every applicable rating');
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(replaySpecTestAdequacyForHistoricalAudit).toHaveBeenCalledOnce();
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it.each(['pass', 'fail'] as const)(
    'corroborates a failed rerun against the historical card when distribution is %s',
    async (distributionRating) => {
      getRubric.mockResolvedValue(replayConsistencyAuditRubric());
      getIssue.mockResolvedValue(replayConsistencyGradedCard());
      readRunningGeneration.mockResolvedValue(runningGeneration('a'.repeat(40)));

      const res = await emitScorecard(
        {
          ...auditArgs,
          ratings: {
            ...REPLAY_SPLIT_RATINGS,
            're-runnable-evidence': {
              rating: 'fail',
              evidence: 'Live freshness is unknown, while the recorded card says pass.',
            },
            'degenerate-distribution': {
              ...REPLAY_SPLIT_RATINGS['degenerate-distribution'],
              rating: distributionRating,
            },
          },
        },
        { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      );

      expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_consistent' });
      expect(replaySpecTestAdequacyForHistoricalAudit).toHaveBeenCalledOnce();
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(recordGradingAudit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['surface:reconnect', false],
    ['test-run:20852939', true],
  ] as const)('checks a failed rerun citation against the historical selection (%s)', async (evidenceRef, allowed) => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    readRunningGeneration.mockResolvedValue(runningGeneration('a'.repeat(40)));

    const res = await emitScorecard(
      {
        ...auditArgs,
        ratings: {
          ...REPLAY_SPLIT_RATINGS,
          're-runnable-evidence': {
            rating: 'fail',
            evidence: 'Independent execution contradicts the selected proof.',
            evidenceKind: 'test-run',
            evidenceRef,
          },
          'degenerate-distribution': { rating: 'pass', evidence: 'The distribution is not the disputed finding.' },
        },
      },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );

    expect(res.ok).toBe(allowed);
    expect(replaySpecTestAdequacyForHistoricalAudit).toHaveBeenCalledOnce();
    if (allowed) {
      expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
    } else {
      expect(res).toMatchObject({ code: 'grading_audit_replay_consistent' });
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(recordGradingAudit).not.toHaveBeenCalled();
    }
  });

  it('passes exact binding ids and the graded fingerprint tuple to the historical replay', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(exactReplayConsistencyGradedCard());
    const dispatchTool = vi.fn();

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_consistent' });
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(replaySpecTestAdequacyForHistoricalAudit).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({
        replaySnapshot: true,
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidenceRefs: ['surface:reconnect'],
        bindingIds: [19999],
        current: [expect.objectContaining({
          sourceFingerprint: 'git:graded',
          testFingerprint: 'sha256:test-graded',
        })],
      }),
      selection: expect.objectContaining({ bindingIds: [19999] }),
      auditAsOf: new Date(GRADED_CARD.createdAt),
    }));
  });

  it('refuses a replay-consistent audit challenge without a structured evidence citation', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    const dispatchTool = vi.fn().mockResolvedValue(targetReplay('pass'));

    const res = await emitScorecard(
      {
        ...auditArgs,
        ratings: {
          ...REPLAY_SPLIT_RATINGS,
          'degenerate-distribution': {
            rating: 'fail',
            evidence: 'the spec may be checking the wrong behavior',
          },
        },
      },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_consistent' });
    expect(scorecardRatingEntrySchema.shape.evidenceKind.description).toContain('both fields are required');
    expect(scorecardRatingEntrySchema.shape.evidenceRef.description).toContain('selection membership');
    expect((res as { error?: string }).error).toContain("ratings['degenerate-distribution'].evidenceKind");
    expect((res as { error?: string }).error).toContain("ratings['degenerate-distribution'].evidenceRef");
    expect((res as { error?: string }).error).toContain('outside the replay selection');
    expect((res as { error?: string }).error).toContain('does not parse it to establish selection membership');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('allows a replay-consistent audit challenge when it cites evidence outside the graded selection', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    readRunningGeneration.mockResolvedValue(runningGeneration('a'.repeat(40)));
    const dispatchTool = vi.fn().mockResolvedValue(targetReplay('pass'));

    const res = await emitScorecard(
      {
        ...auditArgs,
        ratings: {
          ...REPLAY_SPLIT_RATINGS,
          'degenerate-distribution': {
            ...REPLAY_SPLIT_RATINGS['degenerate-distribution'],
            evidence: 'the bound run killed a tracker-only case; the spec falsifier is auto-open plus Retry',
            evidenceKind: 'test-run',
            evidenceRef: '20852939',
          },
        },
      },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res.ok).toBe(true);
    expect(captureImprovement).toHaveBeenCalledOnce();
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
  });

  it.each(['test-run:20852939', '20852939'])(
    'refuses a test-run citation alias for a run already in the graded selection (%s)',
    async (evidenceRef) => {
      const card = exactReplayConsistencyGradedCard();
      const observation = card.payload.observation;
      const recipe = observation.rerunRecipe;
      const selectedMutationRef =
        'test-run 20852939 mutation-probe mutant fail papercusp-desktop/src-tauri/src/main.rs @bbc63f74e66e';
      const selectedSourceRef = 'papercusp-desktop/src-tauri/src/main.rs';
      getRubric.mockResolvedValue(replayConsistencyAuditRubric());
      getIssue.mockResolvedValue({
        ...card,
        payload: {
          observation: {
            ...observation,
            rerunRecipe: {
              ...recipe,
              args: {
                ...recipe.args,
                evidenceRefs: [selectedSourceRef, selectedMutationRef],
                bindingIds: [27284, 27285],
              },
              selection: {
                ...recipe.selection,
                evidence: [
                  { evidenceKind: 'mutation', evidenceRef: selectedMutationRef },
                  { evidenceKind: 'test', evidenceRef: selectedSourceRef },
                ],
                bindingIds: [27284, 27285],
              },
            },
          },
        },
      });
      const dispatchTool = vi.fn().mockResolvedValue(targetReplay('pass'));

      const res = await emitScorecard(
        {
          ...auditArgs,
          ratings: {
            ...REPLAY_SPLIT_RATINGS,
            'degenerate-distribution': {
              ...REPLAY_SPLIT_RATINGS['degenerate-distribution'],
              evidenceKind: 'test-run',
              evidenceRef,
            },
          },
        },
        { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
        { dispatchTool },
      );

      expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_consistent' });
      expect(dispatchTool).not.toHaveBeenCalled();
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(recordGradingAudit).not.toHaveBeenCalled();
    },
  );

  it('allows the same audit split when the historical replay contradicts a target rating', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    readRunningGeneration.mockResolvedValue(runningGeneration('a'.repeat(40)));
    replaySpecTestAdequacyForHistoricalAudit.mockResolvedValue(historicalTargetReplay('fail'));
    const dispatchTool = vi.fn();

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res.ok).toBe(true);
    expect(captureImprovement).toHaveBeenCalledOnce();
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
  });

  it('replays a legacy card from its historical snapshot even when live bindings are unavailable', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(legacyReplayConsistencyGradedCard());
    const dispatchTool = vi.fn().mockResolvedValue({ ok: false, error: 'selection_empty', count: 0 });
    replaySpecTestAdequacyForHistoricalAudit.mockResolvedValue({
      ok: true,
      evaluatorBuild: RERUN_RECIPE.evaluatorBuild,
      rows: targetReplay('pass').rows,
      historicalAuditOnly: {
        provenance: 'historical-audit-only',
        asOf: GRADED_CARD.createdAt,
        freshness: 'historical-snapshot',
        bindings: [
          {
            id: 19999,
            evidenceKind: 'test',
            evidenceRef: 'surface:reconnect',
            withdrawal: { at: '2026-10-02T01:00:00.000Z', reason: 'superseded by binding 21019' },
          },
        ],
      },
    });

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_consistent' });
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(replaySpecTestAdequacyForHistoricalAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.any(String),
        auditAsOf: new Date(GRADED_CARD.createdAt),
        selection: expect.objectContaining({ specId: 'SPEC-003-01', specRevision: 1 }),
      }),
    );
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('fails closed when a legacy historical replay has no graded-card creation time', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue({ ...legacyReplayConsistencyGradedCard(), createdAt: undefined });
    const dispatchTool = vi.fn().mockResolvedValue({ ok: false, error: 'selection_empty', count: 0 });

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_replay_uncorroborated' });
    expect((res as { error?: string }).error).toContain('creation time or workspace scope is unavailable');
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(replaySpecTestAdequacyForHistoricalAudit).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('defers the grading audit when the exact evaluator replay reports build drift', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    const liveEvaluatorBuild = { sha: 'current-evaluator-sha', version: '1.2.3' };
    replaySpecTestAdequacyForHistoricalAudit.mockResolvedValue({
      ...historicalTargetReplay('fail', liveEvaluatorBuild),
      evaluatorBuildDrift: { recorded: RERUN_RECIPE.evaluatorBuild, live: liveEvaluatorBuild },
    });
    const dispatchTool = vi.fn();

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_evaluator_changed' });
    expect((res as { error?: string }).error).toContain('evaluator-build-drift');
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('fails closed when replay build identity differs without a drift marker', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    getIssue.mockResolvedValue(replayConsistencyGradedCard());
    const liveEvaluatorBuild = { sha: 'current-evaluator-sha', version: '1.2.3' };
    replaySpecTestAdequacyForHistoricalAudit.mockResolvedValue(historicalTargetReplay('fail', liveEvaluatorBuild));
    const dispatchTool = vi.fn();

    const res = await emitScorecard(
      { ...auditArgs, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_evaluator_changed' });
    expect((res as { error?: string }).error).toContain('changed build identity');
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it('requires re-emitting a legacy card when a newer evaluator revision changes its rating', async () => {
    getRubric.mockResolvedValue(replayConsistencyAuditRubric());
    const currentCard = replayConsistencyGradedCard();
    const reservation = {
      key: 'grading-audit:EI-CARD',
      reservedAt: '2026-09-24T11:38:02.124Z',
    };
    const { evaluatorRevision: _currentRevision, ...legacyRecipe } = RERUN_RECIPE;
    getIssue.mockResolvedValue({
      ...currentCard,
      payload: {
        observation: {
          ...currentCard.payload.observation,
          gradingAudit: {
            ...currentCard.payload.observation.gradingAudit,
            dispatchReservation: reservation,
          },
          rerunRecipe: legacyRecipe,
          ratings: {
            falsifiability: { rating: 'pass', evidence: 'recorded under the earlier targeting rule' },
            traceability: { rating: 'pass', evidence: 'exact binding replay passed' },
          },
        },
      },
    });
    const exactReplay = targetReplay('pass');
    replaySpecTestAdequacyForHistoricalAudit.mockResolvedValue({
      ...historicalTargetReplay('pass'),
      rows: [
        {
          ...exactReplay.rows[0],
          wouldBlock: ['falsifiability'],
          ratings: {
            falsifiability: { rating: 'unknown' },
            traceability: { rating: 'pass' },
          },
        },
      ],
    });
    const dispatchTool = vi.fn();

    const res = await emitScorecard(
      { ...auditArgs, gradingAuditReservation: reservation, ratings: REPLAY_SPLIT_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
      { dispatchTool },
    );

    expect(res).toMatchObject({ ok: false, code: 'grading_audit_evaluator_changed' });
    expect((res as { error?: string }).error).toContain(`changed from 1 to ${SPEC_TEST_ADEQUACY_EVALUATOR_REVISION}`);
    expect((res as { error?: string }).error).toContain('re-emit the target card');
    expect(markGradingAuditAwaitingReemit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({ state: 'pending', dispatchReservation: reservation }),
      expect.objectContaining({ reason: expect.stringContaining(`changed from 1 to ${SPEC_TEST_ADEQUACY_EVALUATOR_REVISION}`) }),
    );
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(recordGradingAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['older', false, 'auditor-build-older-than-graded-build'],
    ['unknown', null, 'generation-ancestry-unknown'],
  ] as const)(
    'fails closed when the auditor generation is %s than the replayable graded card',
    async (_label, probeResult, reason) => {
      const gradedSha = 'a'.repeat(40);
      const auditorSha = 'b'.repeat(40);
      getRubric.mockResolvedValue(replayAuditRubric());
      getIssue.mockResolvedValue(replayableGradedCard(gradedSha));
      readRunningGeneration.mockResolvedValue(runningGeneration(auditorSha));
      const generationAncestry = vi.fn().mockReturnValue(probeResult);

      const res = await emitScorecard(
        { ...auditArgs, ratings: RE_RUN_FAIL_RATINGS },
        { createdBy: 'su-auditor', ctxHarness: 'papercusp', checkRoot: '/test/root' },
        { generationAncestry },
      );

      expect(res).toMatchObject({ ok: false, code: 'grading_audit_generation_incompatible' });
      expect((res as { error?: string }).error).toContain(reason);
      expect(generationAncestry).toHaveBeenCalledWith('/test/root', gradedSha, auditorSha);
      expect(readRunningGeneration).toHaveBeenCalledOnce();
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(recordGradingAudit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['pass', RE_RUN_PASS_RATINGS],
    ['unknown', RE_RUN_UNKNOWN_RATINGS],
  ] as const)(
    'fails closed when a stale auditor records re-runnable-evidence=%s',
    async (_rating, ratings) => {
      const gradedSha = 'a'.repeat(40);
      const auditorSha = 'b'.repeat(40);
      getRubric.mockResolvedValue(replayAuditRubric());
      getIssue.mockResolvedValue(replayableGradedCard(gradedSha));
      readRunningGeneration.mockResolvedValue(runningGeneration(auditorSha));
      const generationAncestry = vi.fn().mockReturnValue(false);

      const res = await emitScorecard(
        { ...auditArgs, ratings },
        { createdBy: 'su-auditor', ctxHarness: 'papercusp', checkRoot: '/test/root' },
        { generationAncestry },
      );

      if (_rating === 'unknown') {
        expect(res).toMatchObject({ ok: false, code: 'grading_audit_verdict_unknown' });
        expect(generationAncestry).not.toHaveBeenCalled();
      } else {
        expect(res).toMatchObject({ ok: false, code: 'grading_audit_generation_incompatible' });
        expect((res as { error?: string }).error).toContain('auditor-build-older-than-graded-build');
        expect(generationAncestry).toHaveBeenCalledWith('/test/root', gradedSha, auditorSha);
      }
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(recordGradingAudit).not.toHaveBeenCalled();
    },
  );

  it('allows a descendant auditor generation to settle a failing replayable card', async () => {
    const gradedSha = 'a'.repeat(40);
    const auditorSha = 'b'.repeat(40);
    getRubric.mockResolvedValue(replayAuditRubric());
    getIssue.mockResolvedValue(replayableGradedCard(gradedSha));
    readRunningGeneration.mockResolvedValue(runningGeneration(auditorSha));
    const generationAncestry = vi.fn().mockReturnValue(true);

    const res = await emitScorecard(
      { ...auditArgs, ratings: RE_RUN_FAIL_RATINGS },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp', checkRoot: '/test/root' },
      { generationAncestry },
    );

    expect(res.ok).toBe(true);
    expect(generationAncestry).toHaveBeenCalledWith('/test/root', gradedSha, auditorSha);
    expect(readRunningGeneration).toHaveBeenCalledOnce();
    expect(recordGradingAudit).toHaveBeenCalledWith('EI-CARD', expect.objectContaining({ verdict: 'failed' }));
  });

  it('refuses without a scorecard subject, on a non-scorecard subject, and on an already-audited one', async () => {
    const noSubject = await emitScorecard(
      { rubricRef: 'grading-integrity', ratings: RATINGS, terminal: true },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );
    expect(noSubject.ok).toBe(false);
    expect((noSubject as { error?: string }).error).toContain("kind:'scorecard'");

    getIssue.mockResolvedValue(null);
    const notCard = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(notCard.ok).toBe(false);
    expect((notCard as { error?: string }).error).toContain('not a scorecard');

    getIssue.mockResolvedValue({
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          retracted: { at: '2026-08-17T12:00:00.000Z', by: 'su-author', reason: 'withdrawn' },
          gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity', stampedAt: 'x' },
        },
      },
    });
    const withdrawn = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(withdrawn.ok).toBe(false);
    expect((withdrawn as { error?: string }).error).toContain('is retracted and cannot be audited');
    expect(recordGradingAudit).not.toHaveBeenCalled();

    getIssue.mockResolvedValue({
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          gradingAudit: {
            state: 'passed',
            metaRubricRef: 'grading-integrity',
            stampedAt: 'x',
            rubricRevision: 1,
            criteriaHash: 'rubric-hash-v1',
          },
        },
      },
    });
    const already = await emitScorecard(auditArgs, { createdBy: 'su-auditor', ctxHarness: 'papercusp' });
    expect(already.ok).toBe(false);
    expect((already as { error?: string }).error).toContain('already audited');
  });

  it('allows a correction to supersede the existing audit card after the subject is settled', async () => {
    const settledGradedCard = {
      ...GRADED_CARD,
      payload: {
        observation: {
          ...GRADED_CARD.payload.observation,
          gradingAudit: {
            state: 'passed',
            metaRubricRef: 'grading-integrity',
            auditIssueId: 'EI-AUDIT-OLD',
            auditor: 'su-old-auditor',
            stampedAt: '2026-08-17T12:00:00.000Z',
            rubricRevision: 1,
            criteriaHash: 'rubric-hash-v1',
          },
        },
      },
    };
    const priorAudit = {
      id: 'EI-AUDIT-OLD',
      createdBy: 'su-old-auditor',
      payload: {
        observation: {
          rubricRef: 'grading-integrity',
          ratings: RATINGS,
          subject: { kind: 'scorecard', ref: 'EI-CARD' },
        },
      },
    };
    // The settled-subject exception and the generic supersedes validator both
    // read the referenced audit card; keep both reads on the same prior card.
    getIssue
      .mockResolvedValueOnce(settledGradedCard)
      .mockResolvedValueOnce(priorAudit)
      .mockResolvedValueOnce(priorAudit);

    const res = await emitScorecard(
      { ...auditArgs, supersedes: 'EI-AUDIT-OLD' },
      { createdBy: 'su-auditor', ctxHarness: 'papercusp' },
    );

    expect(res).toMatchObject({ ok: true, created: true, supersedes: 'EI-AUDIT-OLD' });
    expect(recordGradingAudit).toHaveBeenCalledWith(
      'EI-CARD',
      expect.objectContaining({
        auditIssueId: 'EI-AUDIT-1',
        verdict: 'passed',
        supersedesAuditIssueId: 'EI-AUDIT-OLD',
      }),
    );
    expect(captureImprovement.mock.calls[0]?.[0]).toMatchObject({
      payloadExtra: {
        observation: {
          rubricRef: 'grading-integrity',
          supersedes: 'EI-AUDIT-OLD',
          subject: { kind: 'scorecard', ref: 'EI-CARD' },
        },
      },
    });
  });
});

describe('pure halves (P-013)', () => {
  it('auditVerdictFromRatings: failures dominate; unknown/custom/empty ratings cannot pass', () => {
    expect(auditVerdictFromRatings({ a: { rating: 'pass' }, b: { rating: 'exemplary' } })).toBe('passed');
    expect(auditVerdictFromRatings({ a: { rating: 'pass' }, b: { rating: 'severe' } })).toBe('failed');
    expect(auditVerdictFromRatings({ a: { rating: 'pass' }, b: { rating: 'unknown' } })).toBeNull();
    expect(auditVerdictFromRatings({ a: { rating: 'custom-unmapped' } })).toBeNull();
    expect(auditVerdictFromRatings({})).toBeNull();
  });

  it('needsGradingAudit: standard+terminal only, never the meta-rubric itself (one level, no regress)', () => {
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'goal-mode-e2e', provisional: false })).toBe(true);
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'goal-mode-e2e', provisional: true })).toBe(false);
    expect(needsGradingAudit({ rubricKind: 'acceptance', rubricRef: 'plan-x', provisional: false })).toBe(false);
    expect(needsGradingAudit({ rubricKind: 'standard', rubricRef: 'grading-integrity', provisional: false })).toBe(
      false,
    );
  });
});
