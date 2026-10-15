/**
 * The final unchanged-evidence read must be scoped to the scorecard's typed
 * subject. A newer card for another subject can otherwise hide an identical
 * prior card and make the emitter append a duplicate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRubric = vi.fn();
const readRubric = vi.fn();
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
    readRubric: (...args: unknown[]) => readRubric(...args),
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
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: async () => null }));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...actual, getIssue: async () => null };
});
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));

import { emitScorecard } from './emit';
import { asStructuredObservation } from '../../harness/improvements/observation-types';
import { scorecardEvidenceFingerprint } from '../../scorecards';

const RUBRIC = {
  rubricId: 'subject-dedup-test',
  workspaceId: 'ws-test',
  kind: 'standard',
  characteristic: 'subject-dedup',
  title: 'Subject dedup',
  description: '',
  criteria: [{ key: 'c1', title: 'C1', model: 'm', method: 'm', driftMarkers: 'd' }],
  ratingScale: ['pass', 'unknown', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  revision: 7,
  criteriaHash: 'criteria-v1',
};

const rubricRef = 'subject-dedup-test';
const subjectRef = 'plan-alpha#SPEC-P-001@1';
const ratings = { c1: { rating: 'pass', evidence: 'the same measured evidence' } };
const rerunRecipe = {
  schemaVersion: 1 as const,
  evaluator: 'plans:evaluate-spec-test-adequacy' as const,
  evaluatorBuild: { sha: 'd740fc3802', version: '0.0.0' },
  evaluatorRevision: 3,
  classRef: 'plan-class-feature-ship',
  args: {
    harness: 'papercusp',
    planItemIds: ['P-001'],
    specFingerprint: 'spec-fingerprint-v1',
  },
  selection: {
    planSlug: 'plan-alpha',
    specId: 'SPEC-P-001',
    specRevision: 1,
    specFingerprint: 'spec-fingerprint-v1',
    evidence: [{ evidenceKind: 'test', evidenceRef: 'packages/operator-core/lib/example.test.ts' }],
  },
  current: {
    supplied: true,
    fingerprints: [{
      planSlug: 'plan-alpha',
      specId: 'SPEC-P-001',
      specRevision: 1,
      specFingerprint: 'spec-fingerprint-v1',
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/example.test.ts',
      sourceFingerprint: 'sha256-file-set-v1:source',
      testFingerprint: 'sha256-file-set-v1:test',
      fixtureFingerprint: null,
      rubricFingerprint: null,
      environmentFingerprint: null,
    }],
  },
  derivation: {
    kind: 'listSpecEvidence.currentness' as const,
    classifier: 'classifySpecEvidenceCurrentness' as const,
    unknownWhenMissing: true as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getRubric.mockResolvedValue(RUBRIC);
  readRubric.mockResolvedValue({ kind: 'found', rubric: RUBRIC });
  getRubricEvidenceIdentity.mockResolvedValue({ revision: 7, criteriaHash: 'criteria-v1', meaningRevision: null });
  getRubricPlanRevision.mockResolvedValue(7);
  readRubricPlanRevision.mockResolvedValue({ ok: true, revision: 7 });
  listScorecards.mockResolvedValue([]);
  captureImprovement.mockResolvedValue({ ok: true, created: true, issue: { id: 'EI-new' } });
});

describe('scorecards:emit unchanged-evidence subject scope', () => {
  it('finds the prior same-subject card when a newer other-subject card exists', async () => {
    const args = { rubricRef, ratings, subject: { kind: 'plan' as const, ref: subjectRef } };
    const input = { createdBy: 'su-grader', ctxHarness: 'papercusp' };
    const firstEmit = await emitScorecard(args, input);
    expect(firstEmit).toMatchObject({ ok: true, created: true });
    const storedObservation = (captureImprovement.mock.calls[0]?.[0] as unknown as {
      payloadExtra: { observation: Record<string, unknown> };
    }).payloadExtra.observation;
    expect(storedObservation.evidenceFingerprint).toBe(
      (firstEmit as { evidenceFingerprint?: string }).evidenceFingerprint,
    );
    const sameSubject = {
      ...storedObservation,
      issueId: 'EI-same-subject',
      createdBy: 'su-grader',
      rubricRef,
      sourceHive: 'papercusp',
      subject: { kind: 'plan', ref: subjectRef },
    };
    const newerOtherSubject = {
      ...sameSubject,
      issueId: 'EI-newer-other-subject',
      ratings: { c1: { rating: 'fail', evidence: 'different measured evidence' } },
      evidenceFingerprint: 'different-subject-evidence',
      subject: { kind: 'issue', ref: 'EI-unrelated' },
    };

    listScorecards.mockImplementation(async (filter: {
      limit?: number;
      subjectKind?: string;
      subjectRef?: string;
    }) => {
      if (filter.limit !== 1) return [];
      if (filter.subjectKind === 'plan' && filter.subjectRef === subjectRef) return [sameSubject];
      return [newerOtherSubject];
    });

    const result = await emitScorecard(args, input);

    const finalFilter = listScorecards.mock.calls.at(-1)?.[0];
    expect(finalFilter).toEqual({
      rubricRef,
      sourceHive: 'papercusp',
      subjectRef,
      subjectKind: 'plan',
      limit: 1,
    });
    expect(result, JSON.stringify({ result, storedObservation, finalFilter })).toMatchObject({
      ok: true,
      created: false,
      reason: 'unchanged-evidence',
      previousIssueId: 'EI-same-subject',
    });
    expect(captureImprovement).toHaveBeenCalledOnce();
  });

  it('dedupes a stored raw recipe after listScorecards reconstructs replay args', async () => {
    const normalized = asStructuredObservation({
      rubricRef,
      sourceHive: 'papercusp',
      ratings,
      rerunRecipe,
    })?.rerunRecipe;
    expect(normalized).toBeDefined();
    expect(normalized!.args).not.toEqual(rerunRecipe.args);

    const rawFingerprint = scorecardEvidenceFingerprint({ rubricRef, ratings, rerunRecipe });
    expect(scorecardEvidenceFingerprint({ rubricRef, ratings, rerunRecipe: normalized! })).toBe(rawFingerprint);
    expect(scorecardEvidenceFingerprint({
      rubricRef,
      ratings,
      rerunRecipe: { ...normalized!, selection: { ...normalized!.selection, specRevision: 2 } },
    })).not.toBe(rawFingerprint);
    expect(scorecardEvidenceFingerprint({
      rubricRef,
      ratings,
      rerunRecipe: {
        ...normalized!,
        current: { ...normalized!.current, fingerprints: [] },
      },
    })).not.toBe(rawFingerprint);
    const sameSubject = {
      issueId: 'EI-normalized-recipe',
      createdBy: 'su-grader',
      rubricRef,
      sourceHive: 'papercusp',
      subject: { kind: 'plan', ref: subjectRef },
      ratings,
      evidenceFingerprint: rawFingerprint,
      rerunRecipe: normalized,
      rubricRevision: RUBRIC.revision,
      criteriaHash: RUBRIC.criteriaHash,
    };
    listScorecards.mockImplementation(async (filter: {
      limit?: number;
      subjectKind?: string;
      subjectRef?: string;
    }) => {
      if (filter.limit !== 1) return [];
      if (filter.subjectKind === 'plan' && filter.subjectRef === subjectRef) return [sameSubject];
      return [];
    });

    const result = await emitScorecard(
      { rubricRef, ratings, subject: { kind: 'plan', ref: subjectRef }, rerunRecipe },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );

    expect(result, JSON.stringify({ result, rawFingerprint, normalized, sameSubject })).toMatchObject({
      ok: true,
      created: false,
      reason: 'unchanged-evidence',
      previousIssueId: 'EI-normalized-recipe',
    });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('supersedes a same-author terminal card when changed evidence replaces a pending audit target', async () => {
    const oldRatings = { c1: { rating: 'pass', evidence: 'prior measured evidence' } };
    const priorCard = {
      issueId: 'EI-prior-terminal',
      createdBy: 'su-grader',
      rubricRef,
      sourceHive: 'papercusp',
      subject: { kind: 'plan', ref: subjectRef },
      ratings: oldRatings,
      evidenceFingerprint: scorecardEvidenceFingerprint({ rubricRef, ratings: oldRatings }),
      rubricRevision: RUBRIC.revision,
      criteriaHash: RUBRIC.criteriaHash,
      gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity' },
    };
    listScorecards.mockImplementation(async (filter: { limit?: number }) =>
      filter.limit === 1 || filter.limit === 100 ? [priorCard] : [],
    );

    const result = await emitScorecard(
      {
        rubricRef,
        ratings: { c1: { rating: 'pass', evidence: 'new measured evidence' } },
        terminal: true,
        subject: { kind: 'plan', ref: subjectRef },
      },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );

    expect(result).toMatchObject({ ok: true, created: true, supersedes: 'EI-prior-terminal' });
    expect(captureImprovement.mock.calls[0]?.[0].payloadExtra.observation).toMatchObject({
      supersedes: 'EI-prior-terminal',
    });
  });

  it('keeps force as an explicit append and does not auto-supersede the prior terminal card', async () => {
    const priorCard = {
      issueId: 'EI-prior-terminal',
      createdBy: 'su-grader',
      rubricRef,
      sourceHive: 'papercusp',
      subject: { kind: 'plan', ref: subjectRef },
      ratings,
      evidenceFingerprint: scorecardEvidenceFingerprint({ rubricRef, ratings }),
      rubricRevision: RUBRIC.revision,
      criteriaHash: RUBRIC.criteriaHash,
      gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity' },
    };
    listScorecards.mockImplementation(async (filter: { limit?: number }) =>
      filter.limit === 1 ? [priorCard] : [],
    );

    const result = await emitScorecard(
      { rubricRef, ratings, terminal: true, force: true, subject: { kind: 'plan', ref: subjectRef } },
      { createdBy: 'su-grader', ctxHarness: 'papercusp' },
    );

    expect(result).toMatchObject({ ok: true, created: true });
    expect(result).not.toHaveProperty('supersedes');
    expect(captureImprovement.mock.calls[0]?.[0].payloadExtra.observation).not.toHaveProperty('supersedes');
  });
});
