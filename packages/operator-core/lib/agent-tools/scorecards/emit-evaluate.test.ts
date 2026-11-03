/**
 * emit-evaluate.test.ts — scorecards:emit / scorecards:evaluate (P-002 of
 * rubric-system-and-auto-loop-release-profile-2026-07-15): the typed tool-layer
 * contract over the observation ledger had NO direct test coverage (scorecards.ts's
 * own scorecards.test.ts/.integration.test.ts cover the storage layer, not this
 * validation+dedup+instrument-contract facade) — this is the P-009 gap-fill for
 * "scorecard deduplication" + "composite verdict propagation" at the tool boundary.
 *
 * DB/system boundaries (getRubric, listScorecards, captureImprovement,
 * readRunningGeneration) are mocked; the REAL scorecardEvidenceFingerprint /
 * evaluateScorecardInstrumentContract / normalizeScorecardRatings /
 * validate* functions run unmocked so the dedup fingerprint + instrument-contract
 * logic is exercised for real, not just its call shape.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/scorecards/emit-evaluate.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  readJsonResult,
} from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS, PAYLOAD_TIER_RATCHET_CHARS } from '@papercusp/tooldef';
import type { Rubric } from '../../rubrics';
import { asStructuredObservation, scorecardAdmissionExclusion } from '../../harness/improvements/observation-types';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import { SPEC_TEST_ADEQUACY_EVALUATOR_REVISION } from '../plans/spec-test-adequacy';
import {
  areAcceptanceLineageRelated,
  isAcceptanceAuthorIdentity,
  resolvePlanImplementerIdentities,
} from '../../acceptance-author-identity';

const readRunningGenerationM = vi.hoisted(() => vi.fn());
const deferredSpendM = vi.hoisted(() => vi.fn());
vi.mock('../../workspace-host/deferred-spend-acceptance-instruments', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workspace-host/deferred-spend-acceptance-instruments')>(),
  measureDeferredSpendAcceptance: (...args: unknown[]) => deferredSpendM(...args),
}));

vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics')>();
  const getRubric = vi.fn();
  const readRubric = vi.fn(async (rubricId: string) => {
    const rubric = await getRubric(rubricId);
    return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
  });
  const readRubricWithoutSeeding = vi.fn(async (rubricId: string) => {
    const rubric = await getRubric(rubricId);
    return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
  });
  const getRubricCriteriaHash = vi.fn(async (_rubricId: string): Promise<string | null> => null);
  const getRubricPlanRevision = vi.fn(async (_rubricId: string): Promise<number | null> => 7);
  return {
    ...actual,
    getRubric,
    getRubricWithoutSeeding: getRubric,
    readRubric,
    readRubricWithoutSeeding,
    getRubricCriteriaHash,
    getRubricPlanRevision,
    readRubricPlanRevision: vi.fn(async () => ({ ok: true as const, revision: 7 })),
    // emitScorecard reads revision/criteriaHash/meaningRevision through ONE call
    // (getRubricEvidenceIdentity). The spread `actual` would run the REAL one,
    // whose module-internal getRubric() call bypasses every mock above, so each
    // revision-keyed guard (dedup, same-revision independent card) silently read
    // revision:null (WI-10002787). Derive it from the mocked readers the tests steer.
    getRubricEvidenceIdentity: vi.fn(async (rubricId: string) => ({
      revision: await getRubricPlanRevision(rubricId),
      criteriaHash: await getRubricCriteriaHash(rubricId),
      meaningRevision:
        ((await getRubric(rubricId)) as { barContract?: { meaningRevision?: number } } | null)?.barContract
          ?.meaningRevision ?? null,
    })),
  };
});
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: readRunningGenerationM }));
vi.mock('../../harness/improvements/capture-core', () => ({ captureImprovement: vi.fn() }));
// WI-10003539: agent-run cards derive an evidence record from durable PG sources. This UNIT
// suite must never reach for the pool; the derivation is covered by its own unit and
// integration suites, so here it is a fixed seam double.
const AGENT_RUN_EVIDENCE_RECORD = {
  schemaVersion: 1,
  derivedBy: 'server',
  holder: 'holder',
  window: { start: '2026-09-05T00:00:00.000Z', end: '2026-09-06T00:00:00.000Z' },
  goalId: null,
  goalSource: 'not-found',
  sourceGeneration: null,
  instructionExposure: { status: 'not-recorded', reason: 'unit-test seam double' },
} as const;
const deriveAgentRunEvidenceRecordSafeM = vi.fn(async () => AGENT_RUN_EVIDENCE_RECORD);
vi.mock('./agent-run-evidence-record', () => ({
  deriveAgentRunEvidenceRecordSafe: (...args: unknown[]) => deriveAgentRunEvidenceRecordSafeM(...(args as [])),
}));
const readAndEvaluateAcceptanceBarLifecycleM = vi.fn();
vi.mock('../../acceptance-bar-lifecycle-evaluator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acceptance-bar-lifecycle-evaluator')>()),
  readAndEvaluateAcceptanceBarLifecycle: (...args: unknown[]) => readAndEvaluateAcceptanceBarLifecycleM(...args),
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...actual, getIssue: vi.fn() };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return { ...actual, listScorecards: vi.fn(async () => [] as ScorecardRow[]) };
});
vi.mock('../../acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  areAcceptanceLineageRelated: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  resolvePlanImplementerIdentities: vi.fn(async () => [] as string[]),
}));

import {
  getRubric,
  getRubricCriteriaHash,
  getRubricPlanRevision,
  readRubric,
  readRubricPlanRevision,
  readRubricWithoutSeeding,
} from '../../rubrics';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { getIssue, type EngineerIssue } from '../../issues-engineer';
import { listScorecards } from '../../scorecards';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { emitScorecard, scorecardEmitArgs } from './emit';
import evaluateTool, { evaluateScorecard, scorecardEvaluateArgs } from './evaluate';
import listTool from './list';
import { collapseCriticsToSoleParty } from './grader-eligibility';

const getRubricM = vi.mocked(getRubric);
const getRubricCriteriaHashM = vi.mocked(getRubricCriteriaHash);
const getRubricPlanRevisionM = vi.mocked(getRubricPlanRevision);
const readRubricPlanRevisionM = vi.mocked(readRubricPlanRevision);
const readRubricM = vi.mocked(readRubric);
const readRubricWithoutSeedingM = vi.mocked(readRubricWithoutSeeding);
const captureM = vi.mocked(captureImprovement);
const listM = vi.mocked(listScorecards);
const getIssueM = vi.mocked(getIssue);

/** A complete EngineerIssue so getIssue / captureImprovement fixtures typecheck against the
 *  real return types instead of hiding behind `as never` (check-mock-cast-escape): only
 *  `payload` varies per test. */
const ISSUE_BASE: EngineerIssue = {
  id: 'ISS-1',
  kind: 'change',
  scope: 'operator',
  title: 'scorecard fixture',
  body: '',
  severity: 'minor',
  source: 'su',
  state: 'open',
  assignee: null,
  assignedBy: null,
  assignedAt: null,
  lastProgressAt: null,
  payload: null,
  parent: null,
  origin: null,
  foundDuring: null,
  linkedFeatureId: null,
  createdBy: null,
  signalOrigin: 'organic',
  assigneeRank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  completionAuthority: null,
  featureOrder: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  goalId: null,
};
const issueWith = (payload: unknown): EngineerIssue => ({ ...ISSUE_BASE, payload });
const sameAuthorM = vi.mocked(isAcceptanceAuthorIdentity);
const lineageRelatedM = vi.mocked(areAcceptanceLineageRelated);
const planImplementersM = vi.mocked(resolvePlanImplementerIdentities);

const RUBRIC: Rubric = {
  rubricId: 'test-rubric',
  workspaceId: 'ws',
  characteristic: 'test',
  title: 'Test Rubric',
  description: 'd',
  criteria: [
    { key: 'crit-a', title: 'Criterion A', model: 'm', method: 'm', driftMarkers: 'd' },
    { key: 'crit-b', title: 'Criterion B', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
  ratingScale: ['pass', 'partial', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
} as unknown as Rubric;

const ACCEPTANCE_RUBRIC: Rubric = {
  ...RUBRIC,
  rubricId: 'acceptance-rubric',
  kind: 'acceptance',
  proposedBy: 'su-implementer',
  createdBy: 'su-implementer',
} as Rubric;

const BAR_ACCEPTANCE_RUBRIC = {
  ...ACCEPTANCE_RUBRIC,
  subjectPlan: 'bar-plan',
  barContract: {
    schemaVersion: 1,
    adoptionEpoch: 1,
    cohort: 'post-epoch',
    subjectPlanRevision: 7,
    seededAt: '2026-09-08T00:00:00.000Z',
    seededBy: 'su-seeder',
  },
} as unknown as Rubric;

const RATINGS = {
  'crit-a': { rating: 'pass', evidence: 'observed A working' },
  'crit-b': { rating: 'pass', evidence: 'observed B working' },
};

function scorecardFixture(fields: Partial<ScorecardRow>): ScorecardRow {
  return { issueId: 'EI-fixture', createdAt: '2026-11-02T00:00:00Z', createdBy: 'su-grader',
    rubricRef: RUBRIC.rubricId, ratings: RATINGS, nKeys: 2, missingKeys: [], extraKeys: [],
    rubricResolved: true, synthesized: false, score10: 10, linkedItems: [], ...fields };
}

function currentRubricFixture(): NonNullable<ScorecardRow['rubricCurrentness']> {
  return { state: 'current', reason: 'current', recordedRevision: 7, currentRevision: 7,
    recordedCriteriaHash: 'a'.repeat(64), currentCriteriaHash: 'a'.repeat(64) };
}

// EI-22177729599840121: a valid meta-acceptance-rubric attestation for the CURRENT
// rubric revision (7, matching getRubricPlanRevisionM's default) — satisfies the
// vet-before-grade check emitScorecard now runs for every non-implementer
// acceptance-kind grading. Module-scoped so any describe block can hand it to
// listM.mockResolvedValue([...]) to represent "this rubric has been vetted".
const vettingCard = (critics: string[]) =>
  ({
    issueId: 'EI-vetting',
    createdAt: '2026-08-25T21:00:12Z',
    createdBy: 'su-vetting-author',
    rubricRef: 'meta-acceptance-rubric',
    subject: { kind: 'rubric', ref: 'acceptance-rubric' },
    ratings: RATINGS,
    nKeys: 2,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    score10: 10,
    linkedItems: [],
    vetting: { consultId: 'conv-vet-1', rubricRevision: 7, critiquePosts: 1, critics },
  }) as unknown as ScorecardRow;

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
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
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

beforeEach(() => {
  vi.clearAllMocks();
  readRunningGenerationM.mockResolvedValue(null);
  sameAuthorM.mockImplementation(async (author, candidate) => author === candidate);
  lineageRelatedM.mockImplementation(async (author, candidate) => author === candidate);
  planImplementersM.mockResolvedValue([]);
  getRubricM.mockResolvedValue(RUBRIC);
  readRubricM.mockImplementation(async (rubricId) => {
    const rubric = await getRubricM(rubricId);
    return rubric ? { kind: 'found', rubric } : { kind: 'missing' };
  });
  readRubricWithoutSeedingM.mockImplementation(async (rubricId) => {
    const rubric = await getRubricM(rubricId);
    return rubric ? { kind: 'found', rubric } : { kind: 'missing' };
  });
  getRubricPlanRevisionM.mockResolvedValue(7);
  getRubricCriteriaHashM.mockResolvedValue(null);
  readRubricPlanRevisionM.mockResolvedValue({ ok: true, revision: 7 });
  readAndEvaluateAcceptanceBarLifecycleM.mockResolvedValue({ satisfied: true });
  listM.mockResolvedValue([]);
  mockResolvedTyped(captureM, { ok: true, created: true, issue: ISSUE_BASE, possibleDuplicates: [] });
  getIssueM.mockResolvedValue(null);
});

describe('diagnostic scorecard baseline', () => {
  const subject = { kind: 'work-item' as const, ref: 'WI-123',
    windowStart: '2026-11-02T00:00:00Z', windowEnd: '2026-11-03T00:00:00Z' };
  const rubric = { ...BAR_ACCEPTANCE_RUBRIC, revision: 7,
    criteriaHash: 'a'.repeat(64), barSetHash: 'b'.repeat(64) };

  beforeEach(() => {
    getRubricM.mockResolvedValue(rubric);
    readAndEvaluateAcceptanceBarLifecycleM.mockResolvedValue({ satisfied: false, message: 'proof missing' });
  });

  it('persists a confirmed failure despite missing acceptance proof without a grading transition', async () => {
    const ratings = { ...RATINGS, 'crit-a': { rating: 'fail', evidence: 'The measured criterion failed.' } };
    const result = await emitScorecard(scorecardEmitArgs.parse({ rubricRef: rubric.rubricId,
      purpose: 'diagnostic', subject, ratings }), { createdBy: 'su-implementer' });
    expect(result).toMatchObject({ ok: true, created: true, purpose: 'diagnostic',
      acceptanceEligible: false, rubricRevision: 7, criteriaHash: rubric.criteriaHash, barSetHash: rubric.barSetHash });
    expect(captureM).toHaveBeenCalledOnce();
    const observation = captureM.mock.calls[0][0].payloadExtra?.observation;
    expect(observation).toMatchObject({ purpose: 'diagnostic', rubricRef: rubric.rubricId,
      rubricRevision: 7, criteriaHash: rubric.criteriaHash, barSetHash: rubric.barSetHash, subject, ratings });
    expect(observation).not.toHaveProperty('acceptance');
    expect(observation).not.toHaveProperty('gradingAudit');
    expect(observation).not.toHaveProperty('vetting');
    const readBack = asStructuredObservation(observation);
    expect(readBack).toMatchObject({ purpose: 'diagnostic', barSetHash: rubric.barSetHash, subject, ratings });
    expect(scorecardAdmissionExclusion(readBack!)).toBe('diagnostic');
    expect(readAndEvaluateAcceptanceBarLifecycleM).not.toHaveBeenCalled();
  });

  it('retains an unavailable instrument reason and next evidence action', async () => {
    const ratings = { ...RATINGS, 'crit-a': { rating: 'unknown', evidence: 'The probe could not run.',
      unknownReason: 'instrument-unavailable' as const, nextEvidenceAction: 'Restore the registered probe and run it.' } };
    await expect(emitScorecard({ rubricRef: rubric.rubricId, purpose: 'diagnostic', subject, ratings },
      { createdBy: 'su-implementer' })).resolves.toMatchObject({ ok: true, canonicalRatings: ratings });
    expect(captureM.mock.calls[0][0]).toMatchObject({ payloadExtra: { observation: { ratings } } });
  });

  it('refuses an unexplained diagnostic unknown before writing', async () => {
    await expect(emitScorecard({ rubricRef: rubric.rubricId, purpose: 'diagnostic', subject,
      ratings: { ...RATINGS, 'crit-a': { rating: 'unknown', evidence: 'No measurement yet.' } } },
      { createdBy: 'su-implementer' })).resolves.toMatchObject({ ok: false, code: 'diagnostic_unknown_reason_required' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it.each(['acceptance', 'vetting', 'baselineRef', 'testedSha'])(
    'refuses diagnostic grading side effects: %s', async field => {
      const value = field === 'acceptance' ? { verdict: 'accept', reasoning: 'pretend settled' }
        : field === 'vetting' ? { workItemId: 'WI-123' } : 'EI-123';
      const result = await emitScorecard({ rubricRef: rubric.rubricId, purpose: 'diagnostic', subject,
        ratings: RATINGS, [field]: value } as Parameters<typeof emitScorecard>[0], { createdBy: 'su-implementer' });
      expect(result).toMatchObject({ ok: false, code: 'diagnostic_operation_invalid' });
      expect(captureM).not.toHaveBeenCalled();
    });

  it('refuses an obsolete BAR digest before writing', async () => {
    await expect(emitScorecard({ rubricRef: rubric.rubricId, purpose: 'diagnostic', subject,
      ratings: RATINGS, barSetHash: 'c'.repeat(64) }, { createdBy: 'su-implementer' }))
      .resolves.toMatchObject({ ok: false, code: 'scorecard_rubric_identity_mismatch' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('corrects an exact diagnostic without losing the prior immutable observation', async () => {
    const prior = scorecardFixture({ issueId: 'EI-baseline', createdBy: 'su-implementer', purpose: 'diagnostic',
      rubricRef: rubric.rubricId, rubricRevision: 7, criteriaHash: rubric.criteriaHash,
      barSetHash: rubric.barSetHash, subject, ratings: RATINGS });
    listM.mockResolvedValue([prior]);
    const result = await emitScorecard({ rubricRef: rubric.rubricId, purpose: 'diagnostic', subject,
      ratings: RATINGS, supersedes: prior.issueId }, { createdBy: 'su-implementer' });
    expect(result).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({ payloadExtra: { observation: {
      purpose: 'diagnostic', supersedes: prior.issueId,
    } } });
    expect(prior).not.toHaveProperty('supersedes');
  });

  it('refuses a diagnostic correction of another author or window', async () => {
    listM.mockResolvedValue([scorecardFixture({ issueId: 'EI-baseline', createdBy: 'su-other', purpose: 'diagnostic',
      rubricRef: rubric.rubricId, rubricRevision: 7, criteriaHash: rubric.criteriaHash,
      barSetHash: rubric.barSetHash, subject, ratings: RATINGS })]);
    expect(await emitScorecard({ rubricRef: rubric.rubricId, purpose: 'diagnostic', subject,
      ratings: RATINGS, supersedes: 'EI-baseline' }, { createdBy: 'su-implementer' }))
      .toMatchObject({ ok: false, code: 'diagnostic_correction_invalid' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it.each(['comparison-rubric-mismatch', 'comparison-scope-mismatch', 'comparison-window-mismatch'])(
    'does not compute a delta across %s', async scenario => {
      readAndEvaluateAcceptanceBarLifecycleM.mockResolvedValue({ satisfied: true });
      const candidate = scorecardFixture({ issueId: 'EI-old', rubricRef: rubric.rubricId, rubricRevision: 7,
        criteriaHash: rubric.criteriaHash, barSetHash: rubric.barSetHash, subject, ratings: RATINGS,
        ...(scenario === 'comparison-rubric-mismatch' ? { barSetHash: 'c'.repeat(64) } : {}),
        ...(scenario === 'comparison-scope-mismatch' ? { sourceHive: 'other-hive' } : {}),
        ...(scenario === 'comparison-window-mismatch' ? { subject: { ...subject, windowEnd: '2026-11-04T00:00:00Z' } } : {}),
      });
      listM.mockResolvedValue([candidate]);
      const result = await evaluateScorecard({ rubricRef: rubric.rubricId, subject, ratings: RATINGS });
      expect(result).toMatchObject({ ok: true, latest: null, comparison: { status: 'incompatible',
        reasons: [scenario.replace('comparison-', '').replace('rubric-mismatch', 'rubric-identity-mismatch')] },
        delta: { previousIssueId: null } });
      expect(listM).toHaveBeenCalledWith(expect.objectContaining({ finalizedOnly: true, limit: 1 }));
    });
});

describe('emitScorecard', () => {
  it('preserves a diagnostic baseline when ordinary grading becomes ready', async () => {
    const subject = { kind: 'work-item' as const, ref: 'WI-exact', windowStart: '2026-11-01T00:00:00Z' };
    const rubric = { ...RUBRIC, revision: 7, criteriaHash: 'a'.repeat(64) };
    getRubricM.mockResolvedValue(rubric);
    const baseline = scorecardFixture({ issueId: 'EI-baseline', purpose: 'diagnostic', rubricRef: rubric.rubricId,
      rubricRevision: 7, criteriaHash: rubric.criteriaHash, barSetHash: null, subject,
      ratings: RATINGS, missingKeys: [], extraKeys: [], rubricResolved: true,
      rubricCurrentness: currentRubricFixture() });
    listM.mockImplementation(async filter => filter?.issueIds ? [baseline] : []);
    const result = await emitScorecard({ rubricRef: rubric.rubricId, subject,
      baselineRef: baseline.issueId, ratings: RATINGS }, { createdBy: 'su-grader' });
    expect(result).toMatchObject({ ok: true, created: true });
    const observation = captureM.mock.calls[0][0].payloadExtra?.observation;
    expect(observation).toMatchObject({ baselineRef: baseline.issueId, subject });
    expect(observation).not.toHaveProperty('supersedes');
    expect(observation).not.toHaveProperty('purpose', 'diagnostic');
    expect(baseline).not.toHaveProperty('supersedes');
  });

  it.each(['rubric', 'scope', 'window'])('refuses a diagnostic regrade across a different %s', async dimension => {
    const subject = { kind: 'work-item' as const, ref: 'WI-exact', windowEnd: '2026-11-01T00:00:00Z' };
    const rubric = { ...RUBRIC, revision: 7, criteriaHash: 'a'.repeat(64) };
    getRubricM.mockResolvedValue(rubric);
    const baseline = scorecardFixture({ issueId: 'EI-baseline', purpose: 'diagnostic', rubricRef: rubric.rubricId,
      rubricRevision: 7, criteriaHash: rubric.criteriaHash, subject,
      ratings: RATINGS, missingKeys: [], extraKeys: [], rubricResolved: true,
      rubricCurrentness: currentRubricFixture(),
      ...(dimension === 'rubric' ? { barSetHash: 'b'.repeat(64) } : {}),
      ...(dimension === 'scope' ? { sourceHive: 'other-hive' } : {}),
      ...(dimension === 'window' ? { subject: { ...subject, windowEnd: '2026-11-02T00:00:00Z' } } : {}),
    });
    listM.mockImplementation(async filter => filter?.issueIds ? [baseline] : []);
    expect(await emitScorecard({ rubricRef: rubric.rubricId, subject,
      baselineRef: baseline.issueId, ratings: RATINGS }, { createdBy: 'su-grader' }))
      .toMatchObject({ ok: false, code: 'baseline_not_comparable' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('rubric not found → ok:false, never reaches captureImprovement', async () => {
    getRubricM.mockResolvedValue(null);
    const r = await emitScorecard({ rubricRef: 'nope', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("'nope' not found") });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses a retired acceptance rubric before any revision read, deduplication, or ledger write', async () => {
    getRubricM.mockResolvedValue({ ...ACCEPTANCE_RUBRIC, status: 'retired' } as Rubric);

    const r = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'retired_acceptance_rubric',
      error: expect.stringContaining('terminal subject plan'),
    });
    expect(getRubricPlanRevisionM).not.toHaveBeenCalled();
    expect(listM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('empty ratings → ok:false with missing criteria, never files an incomplete card', async () => {
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: {} }, { createdBy: 'su-1' });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining('missing required criterion key(s): crit-a, crit-b'),
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('incomplete ratings (missing a required criterion) → ok:false, never files', async () => {
    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: { 'crit-a': RATINGS['crit-a'] } },
      { createdBy: 'su-1' },
    );
    expect(r.ok).toBe(false);
    expect(captureM).not.toHaveBeenCalled();
  });

  it('files a fresh complete scorecard when no prior scorecard exists', async () => {
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true, issueId: 'ISS-1' });
    expect((r as { evidenceFingerprint?: string }).evidenceFingerprint).toEqual(expect.any(String));
    expect(captureM).toHaveBeenCalledTimes(1);
    expect(captureM.mock.calls[0][0]).toMatchObject({
      kind: 'change',
      lane: 'observation',
      createdBy: 'su-1',
      payloadExtra: { observation: { rubricRef: 'test-rubric' } },
    });
  });

  // EI-25880885804871835: plans:evaluate-spec-quality returns a terminal draft
  // without identity fields; scorecards:emit must stamp the reviewed rubric
  // revision/hash before persistence so scorecards:get can classify currentness.
  it('stamps rubric identity on evaluator-produced spec-quality cards', async () => {
    const criteriaHash = 'a'.repeat(64);
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-quality' });
    getRubricPlanRevisionM.mockResolvedValue(5);
    getRubricCriteriaHashM.mockResolvedValue(criteriaHash);

    const r = await emitScorecard({
      rubricRef: 'spec-quality',
      subject: { kind: 'plan', ref: 'quality-plan:plan-class-feature-ship:spec-set' },
      ratings: RATINGS,
      terminal: true,
    }, { createdBy: 'su-evaluator' });

    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: {
        rubricRef: 'spec-quality',
        rubricRevision: 5,
        criteriaHash,
      } },
    });
  });

  it('stamps a graded subject rubric separately from the scoring rubric', async () => {
    getRubricM.mockImplementation(async (ref) => ref === 'subject-rubric'
      ? { ...RUBRIC, rubricId: ref, revision: 4, criteriaHash: 'subject-hash' }
      : RUBRIC);
    getRubricPlanRevisionM.mockImplementation(async (ref) => ref === 'subject-rubric' ? 4 : 7);
    getRubricCriteriaHashM.mockImplementation(async (ref) => ref === 'subject-rubric' ? 'subject-hash' : 'meta-hash');

    const result = await emitScorecard({
      rubricRef: 'test-rubric',
      subject: { kind: 'rubric', ref: 'subject-rubric' },
      ratings: RATINGS,
    }, { createdBy: 'su-1' });

    expect(result).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({ payloadExtra: { observation: {
      rubricRef: 'test-rubric', rubricRevision: 7, criteriaHash: 'meta-hash',
      subjectRubricIdentity: { rubricRef: 'subject-rubric', revision: 4, criteriaHash: 'subject-hash' },
    } } });
  });

  it('publishes the vetting channel XOR and accepts exactly one, either, or neither channel', () => {
    const schema = z.toJSONSchema(scorecardEmitArgs) as {
      oneOf?: Array<{ required?: string[] }>;
    };

    expect(schema.oneOf).toHaveLength(3);
    expect(schema.oneOf?.some((branch) => branch.required?.includes('vettingConsult'))).toBe(true);
    expect(schema.oneOf?.some((branch) => branch.required?.includes('vettingWorkItem'))).toBe(true);
    expect(
      schema.oneOf?.some(
        (branch) =>
          !branch.required?.includes('vettingConsult') && !branch.required?.includes('vettingWorkItem'),
      ),
    ).toBe(true);

    const common = { rubricRef: 'test-rubric', ratings: RATINGS };
    expect(scorecardEmitArgs.safeParse({ ...common, vettingConsult: 'conv-vet-1' }).success).toBe(true);
    expect(scorecardEmitArgs.safeParse({ ...common, vettingWorkItem: 'EI-review-1' }).success).toBe(true);
    expect(scorecardEmitArgs.safeParse(common).success).toBe(true);
    expect(
      scorecardEmitArgs.safeParse({
        ...common,
        vettingConsult: 'conv-vet-1',
        vettingWorkItem: 'EI-review-1',
      }).success,
    ).toBe(false);
  });

  it('does not confuse the separate Scout host with evaluator freshness, and preserves its telemetry', async () => {
    readRunningGenerationM.mockResolvedValue({
      deployedSha: 'release-sha',
      hostStartedAt: '2026-09-11T00:00:00.000Z',
      bootHeadSha: 'older-sha',
      scoutCodeHash: 'older-code',
      staleHost: true,
    });

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });

    expect(r).toMatchObject({
      ok: true,
      created: true,
      staleHost: true,
      deployedSha: 'release-sha',
      gradedGeneration: { deployedSha: 'release-sha', staleHost: true },
    });
    expect(captureM).toHaveBeenCalledTimes(1);
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: {
        observation: {
          gradedGeneration: { bootHeadSha: 'older-sha', deployedSha: 'release-sha', staleHost: true },
        },
      },
    });
  });

  it('refuses to persist when the Scout host generation changes during evidence gathering', async () => {
    readRunningGenerationM
      .mockResolvedValueOnce({
        deployedSha: 'release-sha',
        hostStartedAt: '2026-09-11T00:00:00.000Z',
        bootHeadSha: 'older-sha',
        scoutCodeHash: 'older-code',
        staleHost: true,
      })
      .mockResolvedValueOnce({
        deployedSha: 'release-sha',
        hostStartedAt: '2026-09-11T00:01:00.000Z',
        bootHeadSha: 'older-sha',
        scoutCodeHash: 'older-code',
        staleHost: true,
      });
    captureM.mockImplementationOnce(async (captureInput) => {
      await captureInput.beforeIssueCreate?.();
      return { ok: true, created: true, issue: ISSUE_BASE, possibleDuplicates: [] };
    });

    const result = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });

    expect(result).toMatchObject({
      ok: false,
      code: 'generation_changed_re_gather_required',
      reGatherRequired: true,
      generationChange: {
        evidenceHostStartedAt: '2026-09-11T00:00:00.000Z',
        persistenceHostStartedAt: '2026-09-11T00:01:00.000Z',
      },
    });
    expect(readRunningGenerationM).toHaveBeenCalledTimes(2);
    expect(captureM).toHaveBeenCalledTimes(1);
    expect(captureM.mock.calls[0][0].beforeIssueCreate).toBeTypeOf('function');
  });

  it('returns and persists unknown host parity when the comparison inputs are unavailable', async () => {
    const generation = {
      deployedSha: 'release-sha',
      hostStartedAt: null,
      bootHeadSha: null,
      scoutCodeHash: null,
      staleHost: null,
    };
    readRunningGenerationM
      .mockResolvedValueOnce(generation)
      .mockResolvedValueOnce({ ...generation, hostStartedAt: '2026-09-12T00:01:00.000Z' });
    captureM.mockImplementationOnce(async (captureInput) => {
      await captureInput.beforeIssueCreate?.();
      return { ok: true, created: true, issue: ISSUE_BASE, possibleDuplicates: [] };
    });

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });

    expect(r).toMatchObject({ ok: true, created: true, gradedGeneration: generation, staleHost: null });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { gradedGeneration: generation } },
    });
    expect(readRunningGenerationM).toHaveBeenCalledTimes(2);
  });

  it('surfaces the running generation on a successful emit', async () => {
    const generation = {
      deployedSha: 'current-sha',
      hostStartedAt: '2026-09-12T00:00:00.000Z',
      bootHeadSha: 'current-sha',
      scoutCodeHash: 'current-code',
      staleHost: false,
    };
    readRunningGenerationM.mockResolvedValue(generation);
    captureM.mockImplementationOnce(async (captureInput) => {
      await captureInput.beforeIssueCreate?.();
      return { ok: true, created: true, issue: ISSUE_BASE, possibleDuplicates: [] };
    });

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });

    expect(r).toMatchObject({ ok: true, gradedGeneration: generation, staleHost: false, deployedSha: 'current-sha' });
  });

  it('stamps the graded rubric revision server-side and passes the rubric ref to the revision reader', async () => {
    getRubricPlanRevisionM.mockResolvedValue(11);
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(getRubricPlanRevisionM).toHaveBeenCalledWith('test-rubric');
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'test-rubric', rubricRevision: 11 } },
    });
  });

  it('accepts, persists, and fingerprints the spec-test-adequacy rerun recipe', async () => {
    const parsed = scorecardEmitArgs.safeParse({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rerunRecipe: RERUN_RECIPE,
    });
    expect(parsed.success).toBe(true);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, rerunRecipe: RERUN_RECIPE },
      { createdBy: 'su-1' },
    );
    const expectedFingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rerunRecipe: RERUN_RECIPE,
    });
    expect(r).toMatchObject({ ok: true, created: true, evidenceFingerprint: expectedFingerprint });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'test-rubric', rerunRecipe: RERUN_RECIPE } },
    });
  });

  it('accepts and persists the evaluator build identity while keeping unstamped history compatible', async () => {
    const stamped = {
      ...RERUN_RECIPE,
      evaluatorBuild: { sha: 'abc1234', version: '0.0.13' },
    };
    expect(
      scorecardEmitArgs.safeParse({
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        rerunRecipe: stamped,
      }).success,
    ).toBe(true);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, rerunRecipe: stamped },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rerunRecipe: stamped } },
    });
  });

  it('rejects a malformed evaluator build stamp instead of accepting an unidentifiable recipe', () => {
    const malformed = {
      ...RERUN_RECIPE,
      evaluatorBuild: { sha: 42, version: '0.0.13' },
    };
    expect(
      scorecardEmitArgs.safeParse({
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        rerunRecipe: malformed,
      }).success,
    ).toBe(false);
  });

  // EI-21670417404287969 / EI-21723288985786146 (and EI-21597519978995942, filed a
  // third time from a validator pass): the four nullable fingerprint dimensions were
  // `.nullable()` WITHOUT `.optional()`, making each a REQUIRED key that merely accepts
  // null. An operational/check row has no test and no fixture, so the evaluator output
  // legitimately omits those dimensions — and the documented evaluator→emit chain could
  // not be passed through unchanged. The three sibling call sites (get-spec-evidence,
  // evaluate-spec-test-adequacy, bind-spec-evidence) were already `.nullable().optional()`;
  // emit.ts was the lone straggler.
  it('accepts a fingerprint row that OMITS the nullable dimensions it did not measure', () => {
    const omitted = {
      ...RERUN_RECIPE,
      current: {
        supplied: true,
        fingerprints: [
          {
            evidenceKind: 'operational',
            evidenceRef: 'surface:reconnect',
            sourceFingerprint: 'git:abc',
            // testFingerprint / fixtureFingerprint / rubricFingerprint /
            // environmentFingerprint deliberately absent — this row measured none.
          },
        ],
      },
    };
    expect(scorecardEmitArgs.safeParse({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rerunRecipe: omitted,
    }).success).toBe(true);
  });

  it('still accepts the explicit-null spelling (callers already emitting nulls keep working)', () => {
    const explicitNulls = {
      ...RERUN_RECIPE,
      current: {
        supplied: true,
        fingerprints: [
          {
            evidenceKind: 'operational',
            evidenceRef: 'surface:reconnect',
            sourceFingerprint: 'git:abc',
            testFingerprint: null,
            fixtureFingerprint: null,
            rubricFingerprint: null,
            environmentFingerprint: null,
          },
        ],
      },
    };
    expect(scorecardEmitArgs.safeParse({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rerunRecipe: explicitNulls,
    }).success).toBe(true);
  });

  // CONTROL — proves the loosening is SCOPED to the four nullable dimensions and did not
  // simply make the fingerprint row permissive. Without this, both assertions above would
  // still pass if the schema had been gutted entirely.
  it('CONTROL: still REJECTS a fingerprint row missing the genuinely required sourceFingerprint', () => {
    const missingRequired = {
      ...RERUN_RECIPE,
      current: {
        supplied: true,
        fingerprints: [{ evidenceKind: 'operational', evidenceRef: 'surface:reconnect' }],
      },
    };
    expect(scorecardEmitArgs.safeParse({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rerunRecipe: missingRequired,
    }).success).toBe(false);
  });

  it('rejects a partially scoped replay fingerprint instead of accepting an ambiguous legacy key', () => {
    const partial = {
      ...RERUN_RECIPE,
      current: {
        supplied: true,
        fingerprints: [
          {
            ...RERUN_RECIPE.current.fingerprints[0],
            specId: undefined,
          },
        ],
      },
    };
    expect(scorecardEmitArgs.safeParse({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rerunRecipe: partial,
    }).success).toBe(false);
  });

  it('refuses a spec-test-adequacy card without the evaluator rerun recipe', async () => {
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-test-adequacy' } as Rubric);

    const r = await emitScorecard(
      {
        rubricRef: 'spec-test-adequacy',
        ratings: RATINGS,
        subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      },
      { createdBy: 'su-1' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining('rerunRecipe'),
    });
    expect(getRubricPlanRevisionM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-plan subject kind', { kind: 'work-item', ref: 'WI-101' }],
    ['a subject ref that differs from the evaluator selection', { kind: 'plan', ref: 'reconnect-plan#SPEC-003-02@1' }],
  ] as const)('refuses spec-test-adequacy with %s', async (_label, subject) => {
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-test-adequacy' } as Rubric);

    const r = await emitScorecard(
      {
        rubricRef: 'spec-test-adequacy',
        ratings: RATINGS,
        rerunRecipe: RERUN_RECIPE,
        subject,
      },
      { createdBy: 'su-1' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining("kind:'plan'"),
    });
    expect(getRubricPlanRevisionM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses an obsolete evaluator revision before persisting an otherwise valid recipe', async () => {
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-test-adequacy' } as Rubric);

    const r = await emitScorecard(
      {
        rubricRef: 'spec-test-adequacy',
        ratings: RATINGS,
        rerunRecipe: { ...RERUN_RECIPE, evaluatorRevision: SPEC_TEST_ADEQUACY_EVALUATOR_REVISION - 1 },
        subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      },
      { createdBy: 'su-1' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining('evaluator rule revision'),
    });
    expect(getRubricPlanRevisionM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses freshness=pass when the evaluator recipe records that current fingerprints were not supplied', async () => {
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-test-adequacy' } as Rubric);
    const omittedCurrent = {
      ...RERUN_RECIPE,
      current: { supplied: false, fingerprints: [] },
    };

    const r = await emitScorecard(
      {
        rubricRef: 'spec-test-adequacy',
        ratings: { freshness: { rating: 'pass', evidence: 'Every bound proof dimension is current.' } },
        rerunRecipe: omittedCurrent,
        subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      },
      { createdBy: 'su-1' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining('current fingerprints'),
    });
    expect(getRubricPlanRevisionM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('accepts and persists the evaluator-owned plan subject for spec-test-adequacy', async () => {
    getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: 'spec-test-adequacy' } as Rubric);

    const r = await emitScorecard(
      {
        rubricRef: 'spec-test-adequacy',
        ratings: RATINGS,
        rerunRecipe: RERUN_RECIPE,
        subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      },
      { createdBy: 'su-1' },
    );

    expect(r).toMatchObject({ ok: true, created: true, issueId: 'ISS-1' });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: {
        observation: {
          rubricRef: 'spec-test-adequacy',
          subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
          rerunRecipe: RERUN_RECIPE,
        },
      },
    });
  });

  it('uses a persisted rerun recipe in the latest-hash fallback for legacy rows without a stored fingerprint', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'ISS-RECIPE',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        rerunRecipe: RERUN_RECIPE,
        rubricRevision: 7,
        missingKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, rerunRecipe: RERUN_RECIPE },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: true, created: false, reason: 'unchanged-evidence', previousIssueId: 'ISS-RECIPE' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('files the scorecard ALREADY-TERMINAL (initialState done) — a verdict, not pending work (D-002, observation-lane-scorecard-classification-2026-08-16)', async () => {
    await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(captureM).toHaveBeenCalledTimes(1);
    // The load-bearing byte: without initialState the row files state 'open' and
    // renders forever as an untriaged observation — the exact misread that opened
    // the 01a0031d investigation ("EI-… remains open only as evidence").
    expect(captureM.mock.calls[0][0]).toMatchObject({ initialState: 'done' });
  });

  it('DEDUPLICATION: identical evidence to the latest scorecard is declined (unchanged-evidence), never re-files', async () => {
    const firstFingerprint = (await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS },
      { createdBy: 'su-1' },
    )) as { evidenceFingerprint: string };
    captureM.mockClear();
    listM.mockResolvedValue([
      {
        issueId: 'ISS-1',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        rubricRevision: 7,
        evidenceFingerprint: firstFingerprint.evidenceFingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: false, reason: 'unchanged-evidence', previousIssueId: 'ISS-1' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses another complete independent card for the same rubric revision and returns every existing id', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-INDEPENDENT-1',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
      {
        issueId: 'EI-INDEPENDENT-2',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer-2',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-grader' });

    expect(r).toMatchObject({
      ok: false,
      code: 'existing_independent_scorecards',
      existingIndependentScorecardIds: ['EI-INDEPENDENT-1', 'EI-INDEPENDENT-2'],
      acknowledgementRequired: 'acknowledgeExisting:true',
    });
    expect((r as { error: string }).error).toContain('revision 7');
    expect(captureM).not.toHaveBeenCalled();
  });

  it('does not treat a complete independent card for another subject as a duplicate', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-OTHER-SUBJECT',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: {
          ...RATINGS,
          'crit-a': { rating: 'pass', evidence: 'other subject evidence' },
        },
        subject: { kind: 'scorecard', ref: 'EI-OTHER-SUBJECT' },
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        subject: { kind: 'scorecard', ref: 'EI-TARGET-SUBJECT' },
      },
      { createdBy: 'su-grader' },
    );

    expect(r).toMatchObject({ ok: true, created: true, issueId: 'ISS-1' });
    expect(listM).toHaveBeenCalledWith({
      rubricRef: 'test-rubric',
      subjectRef: 'EI-TARGET-SUBJECT',
      limit: 500,
    });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('still requires acknowledgement for a second complete independent card on the same subject', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-SAME-SUBJECT',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        subject: { kind: 'scorecard', ref: 'EI-TARGET-SUBJECT' },
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        subject: { kind: 'scorecard', ref: 'EI-TARGET-SUBJECT' },
      },
      { createdBy: 'su-grader' },
    );

    expect(r).toMatchObject({
      ok: false,
      code: 'existing_independent_scorecards',
      existingIndependentScorecardIds: ['EI-SAME-SUBJECT'],
      acknowledgementRequired: 'acknowledgeExisting:true',
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('explicit acknowledgement permits an intentional additional independent card', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-INDEPENDENT',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: {
          ...RATINGS,
          'crit-a': { rating: 'pass', evidence: 'new independent observation' },
        },
        acknowledgeExisting: true,
      },
      { createdBy: 'su-grader' },
    );

    expect(r).toMatchObject({ ok: true, created: true, issueId: 'ISS-1' });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('force:true does not bypass the same-revision independent-card acknowledgement guard', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-INDEPENDENT',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: { 'crit-a': { rating: 'fail', evidence: 'new evidence' }, 'crit-b': RATINGS['crit-b'] },
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 4,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, force: true },
      { createdBy: 'su-grader' },
    );

    expect(r).toMatchObject({ ok: false, code: 'existing_independent_scorecards' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('ignores stale, incomplete, synthesized, and same-grader cards when deciding whether acknowledgement is needed', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'EI-OLD-REVISION',
        rubricRef: 'test-rubric',
        rubricRevision: 6,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
      {
        issueId: 'EI-INCOMPLETE',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: ['crit-b'],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 5,
        linkedItems: [],
      } as unknown as ScorecardRow,
      {
        issueId: 'EI-SYNTHETIC',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-peer',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: true,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
      {
        issueId: 'EI-SAME-GRADER',
        rubricRef: 'test-rubric',
        rubricRevision: 7,
        ratings: RATINGS,
        createdBy: 'su-grader',
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-grader' });

    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('types acknowledgement as a literal true', () => {
    expect(scorecardEmitArgs.safeParse({ rubricRef: 'test-rubric', ratings: RATINGS }).success).toBe(true);
    expect(
      scorecardEmitArgs.safeParse({ rubricRef: 'test-rubric', ratings: RATINGS, acknowledgeExisting: true }).success,
    ).toBe(true);
    expect(
      scorecardEmitArgs.safeParse({ rubricRef: 'test-rubric', ratings: RATINGS, acknowledgeExisting: false }).success,
    ).toBe(false);
  });

  it('CHANGED rubric revision vs the latest scorecard files a new card even when evidence is unchanged', async () => {
    const fingerprint = scorecardEvidenceFingerprint({ rubricRef: 'test-rubric', ratings: RATINGS });
    listM.mockResolvedValue([
      {
        issueId: 'ISS-OLD-REVISION',
        rubricRef: 'test-rubric',
        rubricRevision: 6,
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: fingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    getRubricPlanRevisionM.mockResolvedValue(7);

    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM).toHaveBeenCalledTimes(1);
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'test-rubric', rubricRevision: 7 } },
    });
  });

  it('CHANGED evidence vs the latest scorecard files a new one even with a latest on record', async () => {
    listM.mockResolvedValue([
      {
        issueId: 'ISS-OLD',
        rubricRef: 'test-rubric',
        ratings: { 'crit-a': { rating: 'fail', evidence: 'was broken' }, 'crit-b': RATINGS['crit-b'] },
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: 'stale-fingerprint-does-not-match',
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('force:true re-files even when evidence is unchanged', async () => {
    const first = (await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' })) as {
      evidenceFingerprint: string;
    };
    captureM.mockClear();
    listM.mockResolvedValue([
      {
        issueId: 'ISS-1',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: first.evidenceFingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS, force: true }, { createdBy: 'su-1' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM).toHaveBeenCalledTimes(1);
  });

  it('a corrected filing records supersedes and is not swallowed by unchanged-evidence dedup', async () => {
    const first = (await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' })) as {
      evidenceFingerprint: string;
    };
    captureM.mockClear();
    mockResolvedTyped(getIssueM, issueWith({ observation: { rubricRef: 'test-rubric', ratings: RATINGS } }));
    listM.mockResolvedValue([
      {
        issueId: 'ISS-OLD',
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: first.evidenceFingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, supersedes: 'ISS-OLD' },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: true, created: true, supersedes: 'ISS-OLD' });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'test-rubric', supersedes: 'ISS-OLD' } },
    });
  });

  it('inherits an omitted sourceHive from the superseded scorecard instead of the caller harness', async () => {
    mockResolvedTyped(
      getIssueM,
      issueWith({ observation: { rubricRef: 'test-rubric', ratings: RATINGS, sourceHive: 'prior-hive' } }),
    );

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, supersedes: 'ISS-PRIOR' },
      { createdBy: 'su-1', ctxHarness: 'caller-hive' },
    );

    expect(r).toMatchObject({ ok: true, created: true, supersedes: 'ISS-PRIOR' });
    expect(listM).toHaveBeenCalledWith({ rubricRef: 'test-rubric', sourceHive: 'prior-hive', limit: 1 });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: {
        observation: {
          rubricRef: 'test-rubric',
          sourceHive: 'prior-hive',
          supersedes: 'ISS-PRIOR',
        },
      },
    });
  });

  it('preserves a legacy empty sourceHive when a Hive-scoped caller supersedes the card', async () => {
    mockResolvedTyped(getIssueM, issueWith({ observation: { rubricRef: 'test-rubric', ratings: RATINGS } }));

    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, supersedes: 'ISS-LEGACY' },
      { createdBy: 'su-1', ctxHarness: 'papercusp' },
    );

    expect(r).toMatchObject({ ok: true, created: true, supersedes: 'ISS-LEGACY' });
    expect(listM).toHaveBeenCalledWith({ rubricRef: 'test-rubric', sourceHive: undefined, limit: 1 });
    expect(captureM.mock.calls[0][0].payloadExtra?.observation).not.toHaveProperty('sourceHive');
  });

  it('still refuses an explicit sourceHive that conflicts with the superseded scorecard', async () => {
    mockResolvedTyped(
      getIssueM,
      issueWith({ observation: { rubricRef: 'test-rubric', ratings: RATINGS, sourceHive: 'prior-hive' } }),
    );

    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        sourceHive: 'different-hive',
        supersedes: 'ISS-PRIOR',
      },
      { createdBy: 'su-1', ctxHarness: 'caller-hive' },
    );

    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("belongs to sourceHive 'prior-hive', not 'different-hive'"),
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  // WI-2141737: the reporter's exact case — an explicit sourceHive against a
  // PRE-STAMP card that carries no sourceHive key at all. The old refusal
  // rendered the absent prior value as '', which reads as a value the caller
  // could pass; the arg schema is min(1), so no caller can pass it, and the
  // reporter reasonably concluded such cards were permanently un-finalizable.
  // The refusal must distinguish ABSENT from empty and name the form that works.
  it('tells a caller to omit sourceHive when the superseded card has none at all', async () => {
    mockResolvedTyped(getIssueM, issueWith({ observation: { rubricRef: 'test-rubric', ratings: RATINGS } }));

    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        sourceHive: 'papercusp',
        supersedes: 'ISS-LEGACY',
      },
      { createdBy: 'su-1', ctxHarness: 'papercusp' },
    );

    expect(r).toMatchObject({ ok: false });
    const message = (r as { error: string }).error;
    // Never render an absent stored value as a passable empty string.
    expect(message).not.toContain("belongs to sourceHive ''");
    expect(message).toContain('no sourceHive');
    // Name the satisfiable form, so the refusal does not read as a dead end.
    expect(message).toContain('omit sourceHive');
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses to supersede a scorecard from another rubric', async () => {
    mockResolvedTyped(getIssueM, issueWith({ observation: { rubricRef: 'other-rubric', ratings: RATINGS } }));
    const r = await emitScorecard(
      { rubricRef: 'test-rubric', ratings: RATINGS, supersedes: 'ISS-OTHER' },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("grades 'other-rubric'") });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('release-gating rubric with an invalid instrument contract refuses to file (never calls captureImprovement)', async () => {
    getRubricM.mockResolvedValue({
      ...RUBRIC,
      releaseGating: true,
      criteria: [{ ...RUBRIC.criteria[0], instrumentKey: 'some-live-instrument' }, RUBRIC.criteria[1]],
    } as Rubric);
    const r = await emitScorecard({ rubricRef: 'test-rubric', ratings: RATINGS }, { createdBy: 'su-1' });
    expect(r.ok).toBe(false);
    expect((r as { instrumentContract?: unknown }).instrumentContract).toBeDefined();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses acceptance on a standard rubric', async () => {
    const r = await emitScorecard(
      {
        rubricRef: 'test-rubric',
        ratings: RATINGS,
        acceptance: { verdict: 'accept', reasoning: 'The independent evidence satisfies this plan.' },
      },
      { createdBy: 'su-1' },
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("only for kind:'acceptance'") });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('an independent acceptance grader emits ratings without an implementer verdict', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    // EI-22177729599840121: emitScorecard now refuses a non-implementer acceptance
    // grading unless the rubric already carries a current meta-rubric attestation —
    // this test is about the independence contract, not vetting, so satisfy it.
    listM.mockResolvedValue([vettingCard(['su-critic'])]);
    const r = await emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS }, { createdBy: 'su-grader' });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'acceptance-rubric', ratings: RATINGS } },
    });
    expect(captureM.mock.calls[0][0].payloadExtra?.observation).not.toHaveProperty('acceptance');
  });

  it('keeps acceptance authority with createdBy after a repair re-propose changes proposedBy', async () => {
    getRubricM.mockResolvedValue({
      ...ACCEPTANCE_RUBRIC,
      createdBy: 'su-original-author',
      proposedBy: 'su-repair-proposer',
    });
    listM.mockResolvedValue([
      {
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const acceptance = { verdict: 'accept' as const, reasoning: 'The independent evidence meets this plan.' };
    const authorResult = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptance },
      { createdBy: 'su-original-author' },
    );
    expect(authorResult).toMatchObject({ ok: true, created: true, acceptance });

    const repairProposerResult = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptance },
      { createdBy: 'su-repair-proposer' },
    );
    expect(repairProposerResult).toMatchObject({
      ok: false,
      error: expect.stringContaining("acceptance must be recorded by the acceptance-rubric author ('su-original-author')"),
    });
  });

  it('refuses an acceptance grader descended from the implementer even when its owner id differs', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    lineageRelatedM.mockImplementation(
      async (author, candidate) => author === candidate || (author === 'su-implementer' && candidate === 'su-child'),
    );
    const r = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-child' },
    );
    expect(r).toMatchObject({
      ok: false,
      code: 'grader_in_implementer_lineage',
      error: expect.stringContaining('spawn/rebind lineage'),
    });
    // The remedy routes grading through the plan ship recruiter (plans:set-plan-status),
    // never a hand-picked or hand-assigned peer (grader-eligibility.ts, 68e81197f0).
    expect((r as { error?: string }).error).toContain('Do not recruit a grader yourself');
    expect((r as { error?: string }).error).toContain("status:'shipped'");
    expect((r as { error?: string }).error).toContain('mints a lineage-safe judge');
    expect((r as { error?: string }).error).toMatch(/never launch a grader from this lineage/i);
    expect((r as { error?: string }).error).not.toContain('launch or assign a lineage-independent grader');
    expect(captureM).not.toHaveBeenCalled();
  });

  it('P-005: the lineage guard is judged PER EMITTER — grader 1 passing does not carry grader 2', async () => {
    // Grading is a min-1/max-2 cascade since D-003, so the same rubric is graded
    // by two different parties in sequence. This pins that the verdict keys on
    // `createdBy` and nothing else: a clean first card must not license a second
    // grader who is in the implementer's lineage, and the refusal of one must not
    // taint the other. Head-only enforcement would pass every other test here.
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    lineageRelatedM.mockImplementation(
      async (author, candidate) => author === candidate || (author === 'su-implementer' && candidate === 'su-grader-2'),
    );
    // EI-22177729599840121: satisfy the vet-before-grade prerequisite so this test's
    // clean graders (su-grader-1) reach the lineage logic under test, not an
    // unrelated unvetted-rubric refusal.
    listM.mockResolvedValue([vettingCard(['su-critic'])]);

    const first = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader-1' },
    );
    expect(first).toMatchObject({ ok: true, created: true });

    const second = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader-2' },
    );
    expect(second).toMatchObject({ ok: false, code: 'grader_in_implementer_lineage' });

    // …and the order does not matter: the refused grader is refused first too.
    const secondFirst = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader-2' },
    );
    expect(secondFirst).toMatchObject({ ok: false, code: 'grader_in_implementer_lineage' });
    const cleanAfterRefusal = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-grader-1' },
    );
    expect(cleanAfterRefusal).toMatchObject({ ok: true, created: true });
  });

  it('fails closed when an acceptance grader cannot read the current rubric revision', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    readRubricPlanRevisionM.mockResolvedValue({ ok: false, revision: null });

    await expect(
      emitScorecard(
        { rubricRef: 'acceptance-rubric', ratings: RATINGS },
        { createdBy: 'su-grader' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'grader_is_sole_vetting_critic_revision_unreadable',
      error: expect.stringContaining('current revision could not be read'),
    });
    expect(readRubricPlanRevisionM).toHaveBeenCalledWith('acceptance-rubric');
    expect(listM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses an independent grade from the acceptance rubric sole vetting critic', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-08-25T21:00:12Z',
        createdBy: 'su-vetting-author',
        rubricRef: 'meta-acceptance-rubric',
        subject: { kind: 'rubric', ref: 'acceptance-rubric' },
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          critiquePosts: 1,
          critics: ['su-critic'],
        },
      } as unknown as ScorecardRow,
    ]);

    await expect(
      emitScorecard(
        { rubricRef: 'acceptance-rubric', ratings: RATINGS },
        { createdBy: 'su-critic' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'grader_is_sole_vetting_critic',
      error: expect.stringContaining('sole recorded vetting critic'),
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses a grade when every one of several vetting critics resolves to the grader', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    // WI-905074 regression. Both recorded critics are the SAME party as the grader
    // (an alias/rebind of one identity). The old guard tested `critics.length === 1`,
    // so a second row made the identity comparison unreachable and this bypassed the
    // refusal entirely — no independent party ever challenged the rubric.
    lineageRelatedM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-critic-rebound' && candidate === 'su-critic'),
    );
    listM.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-08-25T21:00:12Z',
        createdBy: 'su-vetting-author',
        rubricRef: 'meta-acceptance-rubric',
        subject: { kind: 'rubric', ref: 'acceptance-rubric' },
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          critiquePosts: 2,
          critics: ['su-critic', 'su-critic-rebound'],
        },
      } as unknown as ScorecardRow,
    ]);

    await expect(
      emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS }, { createdBy: 'su-critic' }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'grader_is_sole_vetting_critic',
      error: expect.stringContaining('only distinct party among the 2'),
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('allows one of several vetting critics to grade because another critic preserves independent challenge', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([
      {
        issueId: 'EI-vetting',
        createdAt: '2026-08-25T21:00:12Z',
        createdBy: 'su-vetting-author',
        rubricRef: 'meta-acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          critiquePosts: 2,
          critics: ['su-critic', 'su-other-critic'],
        },
      } as unknown as ScorecardRow,
    ]);

    await expect(
      emitScorecard(
        { rubricRef: 'acceptance-rubric', ratings: RATINGS },
        { createdBy: 'su-critic' },
      ),
    ).resolves.toMatchObject({ ok: true, created: true });
  });

  it('refuses a verdict from the independent grader', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    const r = await emitScorecard(
      {
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        acceptance: { verdict: 'accept', reasoning: 'I am not the rubric author.' },
      },
      { createdBy: 'su-grader' },
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('must be recorded by') });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('requires the implementer verdict and a prior complete independent grading', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    const missing = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-implementer' },
    );
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('must record acceptance') });

    const tooEarly = await emitScorecard(
      {
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        acceptance: { verdict: 'accept', reasoning: 'No independent card exists yet.' },
      },
      { createdBy: 'su-implementer' },
    );
    expect(tooEarly).toMatchObject({ ok: false, error: expect.stringContaining('must follow') });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('stores an implementer verdict after independent grading and includes it in evidence identity', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([
      {
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);
    const acceptance = { verdict: 'accept' as const, reasoning: 'The independent evidence meets this plan.' };
    const r = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptance },
      { createdBy: 'su-implementer' },
    );
    expect(r).toMatchObject({ ok: true, created: true, acceptance });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: { observation: { rubricRef: 'acceptance-rubric', acceptance } },
    });
    expect((r as { evidenceFingerprint: string }).evidenceFingerprint).not.toBe(
      scorecardEvidenceFingerprint({ rubricRef: 'acceptance-rubric', ratings: RATINGS }),
    );
  });

  it('rejects an acceptance-author verdict that supersedes the independent grading', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([
      {
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);

    const r = await emitScorecard(
      {
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets this plan.' },
        supersedes: 'EI-independent',
      },
      { createdBy: 'su-implementer' },
    );

    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining('must not use supersedes'),
    });
    expect(captureM).not.toHaveBeenCalled();
    expect(getIssueM).not.toHaveBeenCalled();
  });

  it('lets an audited successor record the author verdict and never treats that successor as an independent grader', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    sameAuthorM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-successor'),
    );
    lineageRelatedM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-successor'),
    );
    listM.mockResolvedValue([
      {
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);
    const acceptance = { verdict: 'accept' as const, reasoning: 'The independent evidence meets this plan.' };
    await expect(
      emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptance }, { createdBy: 'su-successor' }),
    ).resolves.toMatchObject({ ok: true, created: true, acceptance });

    listM.mockResolvedValue([
      {
        issueId: 'EI-successor-self-grade',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-successor',
        rubricRef: 'acceptance-rubric',
        ratings: RATINGS,
        nKeys: 2,
        missingKeys: [],
        extraKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      },
    ]);
    await expect(
      emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptance }, { createdBy: 'su-successor' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('must follow') });
  });
});

describe('evaluateScorecard', () => {
  const deliveryRubric = (): Rubric => ({
    ...BAR_ACCEPTANCE_RUBRIC,
    ratingScale: ['pass', 'partial', 'fail', 'unknown'],
    criteria: [{ ...RUBRIC.criteria[0], barKey: 'R-15', evidencePlane: 'deployed',
      check: { kind: 'instrument', instrumentKey: 'none' } }, RUBRIC.criteria[1]],
  });
  const deliveryRatings = {
    ...RATINGS, 'crit-a': { rating: 'unknown', evidence: 'No public artifact exists before publication; verify the public URL install after exact candidate approval.',
      unknownReason: 'not-assessed' as const, nextEvidenceAction: 'After approval and publication, download into a fresh HOME and run the installed journey.' },
  };

  it('returns the evaluated rubric identity and refuses an emit after that definition changes', async () => {
    const reviewedRubric = {
      ...RUBRIC,
      revision: 7,
      criteriaHash: 'a'.repeat(64),
      barContract: { meaningRevision: 3 },
    } as Rubric;
    getRubricM.mockResolvedValue(reviewedRubric);

    const skeleton = await evaluateScorecard({ rubricRef: 'test-rubric' });
    expect(skeleton).toMatchObject({
      ok: true,
      rubricRevision: 7,
      criteriaHash: 'a'.repeat(64),
      rubricMeaningRevision: 3,
    });

    const evaluated = await evaluateScorecard({ rubricRef: 'test-rubric', ratings: RATINGS });
    expect(evaluated).toMatchObject({
      ok: true,
      rubricRevision: 7,
      criteriaHash: 'a'.repeat(64),
      rubricMeaningRevision: 3,
    });
    if (!evaluated.ok) throw new Error('test rubric should evaluate successfully');

    getRubricM.mockResolvedValue({
      ...reviewedRubric,
      revision: 8,
      criteriaHash: 'b'.repeat(64),
      barContract: { meaningRevision: 4 },
    } as Rubric);
    getRubricPlanRevisionM.mockResolvedValue(8);
    getRubricCriteriaHashM.mockResolvedValue('b'.repeat(64));

    const emitted = await emitScorecard(scorecardEmitArgs.parse({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rubricRevision: evaluated.rubricRevision,
      criteriaHash: evaluated.criteriaHash,
      rubricMeaningRevision: evaluated.rubricMeaningRevision,
    }), { createdBy: 'su-grader' });

    expect(emitted).toMatchObject({ ok: false, code: 'scorecard_rubric_identity_mismatch' });
    expect(captureM).not.toHaveBeenCalled();

    getRubricM.mockResolvedValue(reviewedRubric);
    getRubricPlanRevisionM.mockResolvedValue(7);
    getRubricCriteriaHashM.mockResolvedValue('a'.repeat(64));
    getRubricM.mockResolvedValueOnce(reviewedRubric);
    getRubricM.mockResolvedValueOnce({
      ...reviewedRubric,
      barContract: { meaningRevision: 4 },
    } as Rubric);
    const changedDuringEmit = await emitScorecard(scorecardEmitArgs.parse({
      rubricRef: 'test-rubric',
      ratings: RATINGS,
      rubricRevision: evaluated.rubricRevision,
      criteriaHash: evaluated.criteriaHash,
      rubricMeaningRevision: evaluated.rubricMeaningRevision,
    }), { createdBy: 'su-grader' });
    expect(changedDuringEmit).toMatchObject({ ok: false, code: 'scorecard_rubric_identity_mismatch' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('preflights and files an independent unknown review for an explicitly pending manual delivery BAR', async () => {
    getRubricM.mockResolvedValue(deliveryRubric());
    listM.mockResolvedValue([vettingCard(['su-critic'])]);
    const request = { rubricRef: 'acceptance-rubric', pendingDeliveryBarKeys: ['R-15'] };
    expect(await evaluateScorecard(request)).toMatchObject({ ok: true,
      skeleton: expect.arrayContaining([expect.objectContaining({ key: 'crit-a', pendingDelivery: true, requiredRating: 'unknown' })]) });
    expect(readAndEvaluateAcceptanceBarLifecycleM).toHaveBeenLastCalledWith('bar-plan', 'pre-grading', {
      expectedApplicable: true, pendingDeliveryBarKeys: ['R-15'],
    });
    const emitted = await emitScorecard({ ...request, ratings: deliveryRatings }, { createdBy: 'su-grader' });
    expect(emitted).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({ payloadExtra: { observation: { ratings: deliveryRatings } } });
    expect(readAndEvaluateAcceptanceBarLifecycleM).toHaveBeenLastCalledWith('bar-plan', 'pre-grading', {
      expectedApplicable: true, pendingDeliveryBarKeys: ['R-15'],
    });
  });

  it.each(['pass', 'partial', 'fail'])('refuses a %s claim on pending delivery in both scorecard doors', async (rating) => {
    getRubricM.mockResolvedValue(deliveryRubric());
    const args = { rubricRef: 'acceptance-rubric', pendingDeliveryBarKeys: ['R-15'],
      ratings: { ...RATINGS, 'crit-a': { rating, evidence: 'No published artifact.' } } };
    expect(await evaluateScorecard(args)).toMatchObject({ ok: false, code: 'pending_delivery_review_invalid' });
    expect(await emitScorecard(args, { createdBy: 'su-grader' }))
      .toMatchObject({ ok: false, code: 'pending_delivery_review_invalid' });
    expect(readAndEvaluateAcceptanceBarLifecycleM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it.each(['tree', 'tests', 'absent', 'duplicate', 'legacy'])('rejects an invalid %s pending-delivery review', async (invalid) => {
    const rubric = deliveryRubric();
    if (invalid === 'tree') rubric.criteria[0].evidencePlane = 'tree';
    if (invalid === 'tests') rubric.criteria[0].check = { kind: 'tests', files: ['x.test.ts'] };
    if (invalid === 'legacy') rubric.barContract = undefined;
    getRubricM.mockResolvedValue(rubric);
    const args = { rubricRef: 'acceptance-rubric', pendingDeliveryBarKeys: invalid === 'duplicate' ? ['R-15', 'R-15']
      : [invalid === 'absent' ? 'R-missing' : 'R-15'], ratings: deliveryRatings };
    expect(await evaluateScorecard(args)).toMatchObject({ ok: false, code: 'pending_delivery_review_invalid' });
    expect(await emitScorecard(args, { createdBy: 'su-grader' }))
      .toMatchObject({ ok: false, code: 'pending_delivery_review_invalid' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses final author acceptance with pending delivery', async () => {
    getRubricM.mockResolvedValue(deliveryRubric());
    expect(await emitScorecard({ rubricRef: 'acceptance-rubric', pendingDeliveryBarKeys: ['R-15'],
      ratings: deliveryRatings, acceptance: { verdict: 'accept', reasoning: 'Premature final accept.' } },
    { createdBy: 'su-implementer' })).toMatchObject({ ok: false, code: 'pending_delivery_review_invalid' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('still requires measured runtime citations for a different deployed BAR', async () => {
    const rubric = deliveryRubric();
    rubric.criteria[1] = { ...rubric.criteria[1], barKey: 'R-16', evidencePlane: 'live' };
    getRubricM.mockResolvedValue(rubric);
    expect(await emitScorecard({ rubricRef: 'acceptance-rubric', pendingDeliveryBarKeys: ['R-15'],
      ratings: { ...deliveryRatings, 'crit-b': { ...deliveryRatings['crit-a'] } } }, { createdBy: 'su-grader' }))
      .toMatchObject({ ok: false, code: 'acceptance_runtime_citation_missing' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('no ratings → returns the read-only grading skeleton (never validates/dedupes)', async () => {
    const r = await evaluateScorecard({ rubricRef: 'test-rubric' });
    expect(r).toMatchObject({ ok: true, skeleton: [{ key: 'crit-a' }, { key: 'crit-b' }], latest: null });
    expect(listM).toHaveBeenCalledWith({ rubricRef: 'test-rubric', sourceHive: undefined, finalizedOnly: true, limit: 1 });
  });

  it('empty ratings → returns the grading skeleton with allowed values instead of crashing', async () => {
    const r = await evaluateScorecard({ rubricRef: 'test-rubric', ratings: {} });
    expect(r).toMatchObject({
      ok: true,
      skeleton: [
        { key: 'crit-a', allowedRatings: ['pass', 'partial', 'fail'], rating: null, evidence: null },
        { key: 'crit-b', allowedRatings: ['pass', 'partial', 'fail'], rating: null, evidence: null },
      ],
      latest: null,
    });
  });

  it('rubric not found → ok:false', async () => {
    getRubricM.mockResolvedValue(null);
    const r = await evaluateScorecard({ rubricRef: 'nope' });
    expect(r).toMatchObject({ ok: false });
  });

  it('preflights the adopted acceptance BAR lifecycle before returning a gradeable skeleton', async () => {
    getRubricM.mockResolvedValue(BAR_ACCEPTANCE_RUBRIC);
    const lifecycle = {
      phase: 'pre-grading',
      satisfied: false,
      message: 'acceptance BAR contract is not ready for grading — contract-level: bar_snapshot_rubric_revision_mismatch',
    };
    readAndEvaluateAcceptanceBarLifecycleM.mockResolvedValue(lifecycle);

    const r = await evaluateScorecard({ rubricRef: 'acceptance-rubric' });

    expect(r).toMatchObject({
      ok: false,
      code: 'acceptance_bar_contract_not_ready',
      error: lifecycle.message,
      lifecycle,
    });
    expect(readAndEvaluateAcceptanceBarLifecycleM).toHaveBeenCalledWith('bar-plan', 'pre-grading', {
      expectedApplicable: true,
    });
    expect(listM).not.toHaveBeenCalled();
  });

  it.each([
    ['readiness-missing', 'bar_snapshot_proof_missing', 'Bind the missing criterion proof.'],
    ['readiness-stale', 'bar_snapshot_proof_stale', 'Re-run and bind proof for the current source.'],
    ['readiness-incompatible', 'bar_snapshot_rubric_revision_mismatch', 'Read the current rubric and re-grade its exact identity.'],
    ['readiness-instrument-unavailable', 'bar_snapshot_proof_uncertain', 'Restore the failed instrument and measure again.'],
    ['diagnostic-not-readiness', 'bar_snapshot_grading_missing', 'Obtain independent final grading; a diagnostic is a baseline.'],
  ])('ordinary readiness preserves the measured refusal: %s', async (_scenario, code, action) => {
    getRubricM.mockResolvedValue(BAR_ACCEPTANCE_RUBRIC);
    const lifecycle = {
      phase: 'pre-grading', satisfied: false, codes: [code],
      blockingBars: [{ barKey: 'R-1', codes: [code] }],
      nextRepair: { action, responsibleRole: 'independent-grader' },
      message: `R-1 is unresolved: ${code}; ${action}`,
    };
    readAndEvaluateAcceptanceBarLifecycleM.mockResolvedValue(lifecycle);
    const projected = lookupByMcpName('scorecards:evaluate');
    expect(projected).toBeDefined();
    const result = await dispatchProjectedTool(projected!, 'scorecards:evaluate', {
      rubricRef: 'acceptance-rubric',
    }, {
      log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
      workspaceId: 'ws', runId: 'ordinary-readiness-regression', isSuperuser: true,
      uiClientId: 'su-independent', role: 'su',
      gateBypass: { role: true, capability: true, quota: true },
      transport: 'mcp', requestedFormat: 'json', tx: {},
    }, {});
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(readJsonResult(result.result!)).toMatchObject({
      ok: false, code: 'acceptance_bar_contract_not_ready', lifecycle,
      evidenceApplicabilityRead: { tool: 'plans:get-spec-evidence', args: { slug: 'bar-plan' } },
    });
    expect(listM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('links an ad-hoc criterion to its actual work-item namespace without inventing a plan', async () => {
    getRubricM.mockResolvedValue(RUBRIC);
    const result = await evaluateScorecard({ rubricRef: RUBRIC.rubricId,
      subject: { kind: 'work-item', ref: 'WI-ad-hoc' } });
    expect(result).toMatchObject({ ok: true, skeleton: expect.arrayContaining([
      expect.objectContaining({ evidenceApplicabilityRead: { tool: 'plans:get-spec-evidence',
        args: { slug: 'adhoc-work-item-specs', workItemIds: ['WI-ad-hoc'] }, criterionKey: expect.any(String) } }),
    ]) });
  });

  // WI-10005160: a plan slug is unique per harness, not per workspace, so the BAR read must be
  // scoped to the rubric's subject harness or it can span two copies and refuse
  // `bar_snapshot_plan_ambiguous`.
  it('scopes the BAR lifecycle preflight to the rubric subject harness', async () => {
    getRubricM.mockResolvedValue({ ...BAR_ACCEPTANCE_RUBRIC, subjectHarnessSlug: 'papercusp' });
    readAndEvaluateAcceptanceBarLifecycleM.mockResolvedValue({ phase: 'pre-grading', satisfied: false, message: 'not ready' });

    await evaluateScorecard({ rubricRef: 'acceptance-rubric' });

    expect(readAndEvaluateAcceptanceBarLifecycleM).toHaveBeenCalledWith('bar-plan', 'pre-grading', {
      expectedApplicable: true,
      harnessSlug: 'papercusp',
    });
  });

  it('scorecards:emit scopes its pre-grading BAR read to the rubric subject harness', async () => {
    getRubricM.mockResolvedValue({ ...BAR_ACCEPTANCE_RUBRIC, subjectHarnessSlug: 'papercusp' });
    const lifecycle = { phase: 'pre-grading', satisfied: false, message: 'acceptance BAR contract is not ready for grading' };
    readAndEvaluateAcceptanceBarLifecycleM.mockResolvedValue(lifecycle);

    const r = await emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS }, { createdBy: 'su-grader' });

    expect(r).toMatchObject({ ok: false, code: 'acceptance_bar_contract_not_ready', lifecycle });
    expect(readAndEvaluateAcceptanceBarLifecycleM).toHaveBeenCalledWith('bar-plan', 'pre-grading', {
      expectedApplicable: true,
      harnessSlug: 'papercusp',
    });
  });

  it('does not collapse a failed backing-plan read into a false not-found', async () => {
    getRubricM.mockResolvedValue(null);
    readRubricWithoutSeedingM.mockResolvedValue({ kind: 'read-failed' });
    readRubricPlanRevisionM.mockResolvedValue({ ok: false, revision: null });

    const r = await evaluateScorecard({ rubricRef: 'active-acceptance-rubric' });

    expect(r).toMatchObject({
      ok: false,
      error:
        "rubric 'active-acceptance-rubric' could not be resolved because the backing plan read failed; " +
        'retry or verify independently before treating it as absent',
    });
    expect(r.error).not.toContain('not found');
    expect(readRubricWithoutSeedingM).toHaveBeenCalledWith('active-acceptance-rubric');
    expect(readRubricPlanRevisionM).not.toHaveBeenCalled();
  });

  it('scorecards:emit reports a backing-plan read failure without claiming the rubric is missing', async () => {
    readRubricM.mockResolvedValue({ kind: 'read-failed' });

    const result = await emitScorecard(
      { rubricRef: 'grading-integrity', ratings: RATINGS },
      { createdBy: 'su-grader' },
    );

    expect(result).toMatchObject({
      ok: false,
      error:
        "rubric 'grading-integrity' could not be resolved because the backing plan read failed; " +
        'retry or verify independently before treating it as absent',
    });
    expect(result.error).not.toContain('not found');
  });

  it.each(['evaluate', 'emit'] as const)(
    'current BAR fingerprints reach %s while stale proof and implementer grading stay blocked',
    async (door) => {
      getRubricM.mockResolvedValue({ ...BAR_ACCEPTANCE_RUBRIC, subjectHarnessSlug: 'papercusp' });
      planImplementersM.mockResolvedValue(['su-plan-implementer']);
      const current = [{
        planSlug: 'bar-plan',
        specId: 'AUTO-BAR-R-1-P-002',
        specRevision: 8,
        specFingerprint: 'spec:current',
        evidenceKind: 'test' as const,
        evidenceRef: 'reports.test.ts',
        sourceFingerprint: 'source:current',
        testFingerprint: 'test:current',
      }];
      // Model the lifecycle's measured comparison, not a blanket successful
      // preflight: omitted and changed source fingerprints must still refuse.
      readAndEvaluateAcceptanceBarLifecycleM.mockImplementation(
        async (_plan, _phase, options: { current?: typeof current; harnessSlug?: string }) => ({
          phase: 'pre-grading',
          satisfied: options.harnessSlug === 'papercusp' &&
            options.current?.[0]?.sourceFingerprint === 'source:current',
          message: 'R-1 source proof is missing or stale',
        }),
      );
      const run = (fingerprints?: typeof current) => door === 'evaluate'
        ? evaluateScorecard(
            scorecardEvaluateArgs.parse({ rubricRef: 'acceptance-rubric', current: fingerprints }),
            { id: 'su-plan-implementer', workspaceId: 'ws' },
          )
        : emitScorecard(
            scorecardEmitArgs.parse({ rubricRef: 'acceptance-rubric', ratings: RATINGS, current: fingerprints }),
            { createdBy: 'su-plan-implementer', workspaceId: 'ws' },
          );

      await expect(run()).resolves.toMatchObject({ ok: false, code: 'acceptance_bar_contract_not_ready' });
      await expect(run([{ ...current[0], sourceFingerprint: 'source:changed' }])).resolves.toMatchObject({
        ok: false, code: 'acceptance_bar_contract_not_ready',
      });
      await expect(run(current)).resolves.toMatchObject(door === 'evaluate'
        ? { ok: true, graderEligibility: { role: 'disqualified', refusal: { code: 'grader_in_implementer_lineage' } } }
        : { ok: false, code: 'grader_in_implementer_lineage' });
      expect(captureM).not.toHaveBeenCalled();
    },
  );

  it('with ratings + no latest scorecard: changed:true and every criterion listed as changed', async () => {
    const r = await evaluateScorecard({ rubricRef: 'test-rubric', ratings: RATINGS });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect((r as { delta: { changedCriteria: string[] } }).delta.changedCriteria.sort()).toEqual(['crit-a', 'crit-b']);
  });

  it.each(['evaluate', 'emit'] as const)(
    '%s refuses a positive rating when a bound artifact key has no snapshot, even without release gating',
    async (door) => {
      const artifactKey = 'docs/evidence/retained-report.json:summary';
      getRubricM.mockResolvedValue({
        ...RUBRIC,
        releaseGating: false,
        criteria: [{ ...RUBRIC.criteria[0], instrumentKey: artifactKey }],
      } as Rubric);
      const ratings = { 'crit-a': { rating: 'pass', evidence: 'The artifact appears healthy.' } };

      const result = door === 'evaluate'
        ? await evaluateScorecard({ rubricRef: 'test-rubric', ratings })
        : await emitScorecard({ rubricRef: 'test-rubric', ratings }, { createdBy: 'su-1' });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(artifactKey),
        instrumentContract: { missingSnapshots: [artifactKey], positiveClaimsWithoutSnapshots: [artifactKey] },
      });
      if (door === 'emit') expect(captureM).not.toHaveBeenCalled();
    },
  );

  it('keeps every skeleton + canonical-rating row through an ambient trimmed dispatch', async () => {
    const criteria = Array.from({ length: 26 }, (_, i) => ({
      key: `criterion-${i + 1}`,
      title: `Criterion ${i + 1} ${'t'.repeat(120)}`,
      model: 'm',
      method: 'm',
      driftMarkers: 'd',
    }));
    const rubric = { ...RUBRIC, criteria } as Rubric;
    const ratings = Object.fromEntries(
      criteria.map((criterion) => [
        criterion.key,
        { rating: 'pass', evidence: `verified ${criterion.key} ${'e'.repeat(180)}` },
      ]),
    );
    getRubricM.mockResolvedValue(rubric);

    // Non-vacuity: this is large enough to trigger the generic trimmed fallback
    // that caused the live 26 → 12+marker / 6 split, but still below the separate
    // hard ceiling. The declaration under test must therefore be the reason the
    // payload remains complete.
    const raw = await evaluateScorecard({ rubricRef: rubric.rubricId, ratings });
    const rawChars = JSON.stringify(raw).length;
    expect(rawChars).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);

    const projected = lookupByMcpName('scorecards:evaluate');
    expect(projected).toBeDefined();
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
    const dispatched = await dispatchProjectedTool(
      projected!,
      'scorecards:evaluate',
      { rubricRef: rubric.rubricId, ratings },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'scorecards-evaluate-completeness-test',
        isSuperuser: true,
        uiClientId: 'su-scorecards-evaluate-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        contextTier: 'trimmed',
        tx: {},
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      rubric: { criteriaCount: number };
      skeleton: unknown[];
      canonicalRatings: Record<string, unknown>;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.rubric.criteriaCount).toBe(26);
    expect(payload?.skeleton).toHaveLength(26);
    expect(Object.keys(payload?.canonicalRatings ?? {})).toHaveLength(26);
  });

  it('with ratings identical to the latest scorecard: changed:false and an empty changedCriteria delta', async () => {
    const subject = { kind: 'work-item' as const, ref: 'WI-exact' };
    getRubricM.mockResolvedValue({ ...RUBRIC, revision: 7, criteriaHash: 'a'.repeat(64) });
    const evalR = (await evaluateScorecard({ rubricRef: 'test-rubric', subject, ratings: RATINGS })) as {
      evidenceFingerprint: string;
    };
    listM.mockResolvedValue([
      {
        issueId: 'ISS-1',
        rubricRef: 'test-rubric',
        rubricRevision: 7, criteriaHash: 'a'.repeat(64), subject,
        ratings: RATINGS,
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: evalR.evidenceFingerprint,
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    const r2 = await evaluateScorecard({ rubricRef: 'test-rubric', subject, ratings: RATINGS });
    expect(r2).toMatchObject({ ok: true, changed: false });
    expect((r2 as { delta: { changedCriteria: string[] } }).delta.changedCriteria).toEqual([]);
  });

  it('a SINGLE criterion change vs the latest is reflected precisely in changedCriteria', async () => {
    const subject = { kind: 'work-item' as const, ref: 'WI-exact' };
    getRubricM.mockResolvedValue({ ...RUBRIC, revision: 7, criteriaHash: 'a'.repeat(64) });
    listM.mockResolvedValue([
      {
        issueId: 'ISS-1',
        rubricRef: 'test-rubric',
        rubricRevision: 7, criteriaHash: 'a'.repeat(64), subject,
        ratings: { 'crit-a': RATINGS['crit-a'], 'crit-b': { rating: 'fail', evidence: 'was broken' } },
        missingKeys: [],
        rubricResolved: true,
        evidenceFingerprint: 'irrelevant-old-fingerprint',
        synthesized: false,
        score10: null,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);
    const r = await evaluateScorecard({ rubricRef: 'test-rubric', subject, ratings: RATINGS });
    expect((r as { delta: { changedCriteria: string[] } }).delta.changedCriteria).toEqual(['crit-b']);
  });

  it('release-gating rubric with an invalid instrument contract returns ok:false but STILL includes the skeleton + latest for the caller to inspect', async () => {
    getRubricM.mockResolvedValue({
      ...RUBRIC,
      releaseGating: true,
      criteria: [{ ...RUBRIC.criteria[0], instrumentKey: 'some-live-instrument' }, RUBRIC.criteria[1]],
    } as Rubric);
    const r = await evaluateScorecard({ rubricRef: 'test-rubric', ratings: RATINGS });
    expect(r.ok).toBe(false);
    expect((r as { skeleton?: unknown }).skeleton).toBeDefined();
    expect((r as { instrumentContract?: unknown }).instrumentContract).toBeDefined();
  });
});

describe('eligibility-only acceptance preflight (EI-27075741789891557)', () => {
  const args = { rubricRef: 'acceptance-rubric', eligibilityOnly: true };

  beforeEach(() => {
    getRubricM.mockResolvedValue({
      ...BAR_ACCEPTANCE_RUBRIC,
      revision: 8,
      criteriaHash: 'criteria:identity-only',
      barContract: { ...BAR_ACCEPTANCE_RUBRIC.barContract!, meaningRevision: 3 },
    });
    readRubricPlanRevisionM.mockResolvedValue({ ok: true, revision: 8 });
    readAndEvaluateAcceptanceBarLifecycleM.mockResolvedValue({
      satisfied: false,
      message: 'acceptance BAR snapshot is stale and product proof is missing',
    });
  });

  it('answers eligible identity before an unready BAR without returning grading data', async () => {
    expect(scorecardEvaluateArgs.safeParse(args).success).toBe(true);
    const result = await evaluateScorecard(args, { id: 'su-independent', workspaceId: 'ws' });

    expect(result).toMatchObject({
      ok: true,
      eligibilityOnly: true,
      rubricRef: 'acceptance-rubric',
      rubricRevision: 8,
      criteriaHash: 'criteria:identity-only',
      rubricMeaningRevision: 3,
      graderEligibility: {
        role: 'independent-grader', canEmitGrading: true, blocksEmit: false,
        advice: expect.stringContaining('must still validate BAR readiness, ratings and evidence'),
      },
    });
    for (const key of ['skeleton', 'latest', 'canonicalRatings', 'instrumentContract', 'releaseGateBinding']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(readAndEvaluateAcceptanceBarLifecycleM).not.toHaveBeenCalled();
    expect(listM).not.toHaveBeenCalledWith(expect.objectContaining({ rubricRef: 'acceptance-rubric' }));
    expect(deferredSpendM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });

  it('projects eligibility-only through the real tool dispatch using the caller identity', async () => {
    planImplementersM.mockResolvedValue(['su-principal']);
    const projected = lookupByMcpName('scorecards:evaluate');
    expect(projected).toBeDefined();
    const dispatched = await dispatchProjectedTool(projected!, 'scorecards:evaluate', args, {
      log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
      workspaceId: 'ws', runId: 'eligibility-only-preflight-test', isSuperuser: true,
      uiClientId: 'su-principal', role: 'su',
      gateBypass: { role: true, capability: true, quota: true },
      transport: 'mcp', requestedFormat: 'json', tx: {},
    }, {});

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(readJsonResult(dispatched.result!)).toMatchObject({
      ok: true, eligibilityOnly: true, rubricRevision: 8, criteriaHash: 'criteria:identity-only',
      graderEligibility: {
        role: 'disqualified', canEmitGrading: false, principalImplementers: ['su-principal'],
        refusal: { code: 'grader_in_implementer_lineage' },
      },
    });
    expect(readAndEvaluateAcceptanceBarLifecycleM).not.toHaveBeenCalled();
  });

  it('keeps an implementer-lineage caller disqualified despite an unready BAR', async () => {
    lineageRelatedM.mockImplementation(async (author, candidate) =>
      author === candidate || (author === 'su-implementer' && candidate === 'su-relative'));

    await expect(evaluateScorecard(args, { id: 'su-relative', workspaceId: 'ws' })).resolves.toMatchObject({
      ok: true,
      graderEligibility: {
        role: 'disqualified', canEmitGrading: false, blocksEmit: true,
        advice: expect.not.stringContaining('skeleton below'),
        refusal: { code: 'grader_in_implementer_lineage' },
      },
    });
    expect(readAndEvaluateAcceptanceBarLifecycleM).not.toHaveBeenCalled();
  });

  it('does not grant the acceptance author independent-grader clearance', async () => {
    await expect(evaluateScorecard(args, { id: 'su-implementer', workspaceId: 'ws' })).resolves.toMatchObject({
      ok: true,
      graderEligibility: { role: 'acceptance-author', canEmitGrading: false },
    });
  });

  it('reports unresolved identity as unknown without granting clearance', async () => {
    readRubricPlanRevisionM.mockRejectedValue(new Error('identity revision unavailable'));

    await expect(evaluateScorecard(args, { id: 'su-independent', workspaceId: 'ws' })).resolves.toMatchObject({
      ok: true,
      graderEligibility: { role: 'unknown', canEmitGrading: false, advice: expect.stringContaining('NOT a clearance') },
    });
    expect(readAndEvaluateAcceptanceBarLifecycleM).not.toHaveBeenCalled();
  });

  it('keeps a retired rubric disqualified', async () => {
    getRubricM.mockResolvedValue({ ...BAR_ACCEPTANCE_RUBRIC, status: 'retired' });

    await expect(evaluateScorecard(args, { id: 'su-independent', workspaceId: 'ws' })).resolves.toMatchObject({
      ok: true,
      graderEligibility: {
        role: 'disqualified', canEmitGrading: false,
        refusal: { code: 'retired_acceptance_rubric' },
      },
    });
  });

  it('does not guess eligibility when the caller identity is absent', async () => {
    await expect(evaluateScorecard(args)).resolves.toMatchObject({ ok: true, graderEligibility: null });
  });

  it.each([
    { name: 'skeleton', ratings: undefined },
    { name: 'empty ratings', ratings: {} },
    { name: 'ratings', ratings: RATINGS },
  ])('retains the BAR readiness refusal for ordinary $name requests', async ({ ratings }) => {
    await expect(evaluateScorecard(
      { rubricRef: args.rubricRef, ratings }, { id: 'su-independent', workspaceId: 'ws' },
    )).resolves.toMatchObject({ ok: false, code: 'acceptance_bar_contract_not_ready' });
    expect(readAndEvaluateAcceptanceBarLifecycleM).toHaveBeenCalled();
  });

  it.each([
    { sourceHive: 'grader-hive' },
    { ratings: {} },
    { subject: { ref: 'subject' } },
    { instrumentSnapshots: {} },
    { testedSha: 'a'.repeat(40) },
    { current: [] },
    { pendingDeliveryBarKeys: ['R-1'] },
  ])('refuses grading or history inputs rather than silently ignoring them: %j', async (gradingInput) => {
    await expect(evaluateScorecard({ ...args, ...gradingInput }, { id: 'su-independent' })).resolves.toMatchObject({
      ok: false, code: 'eligibility_only_input_invalid',
    });
    expect(getRubricM).not.toHaveBeenCalled();
    expect(readAndEvaluateAcceptanceBarLifecycleM).not.toHaveBeenCalled();
    expect(captureM).not.toHaveBeenCalled();
  });
});

describe('acceptance-grader eligibility is answerable BEFORE the grading work (EI-21974075442192005)', () => {
  // The rails are pure identity facts, so the only thing that made them expensive
  // was WHERE they were reachable: a launched reviewer completed a full independent
  // pass — re-running both bound suites, verifying every claimed repair, writing
  // evidence strings for seven criteria — and learned at the terminal emit that it
  // could never file the result. Each test below pins the PRE-FLIGHT answer AND the
  // refusal it predicts in the same case: an advisory that drifts from its rail is
  // the failure this module exists to prevent (WI-905074 widened the refusal and
  // left the advisory speaking for it on the old narrow test).
  // (vettingCard is module-scoped above — shared with the vet-before-grade tests.)

  it('the sole vetting critic is told it is disqualified by the PRE-FLIGHT, with the same code emit refuses with', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([vettingCard(['su-critic'])]);

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-critic', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      ok: true,
      graderEligibility: {
        role: 'disqualified',
        blocksEmit: true,
        canEmitGrading: false,
        refusal: { code: 'grader_is_sole_vetting_critic' },
      },
    });
    // The pre-flight still returns the skeleton: a disqualified reviewer's useful
    // next act is handing it to the replacement grader.
    expect((preflight as { skeleton?: unknown[] }).skeleton).toHaveLength(2);

    // …and it agrees with the surface that actually refuses.
    const emitted = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-critic' },
    );
    expect(emitted).toMatchObject({ ok: false, code: 'grader_is_sole_vetting_critic' });
  });

  it('a grader inside the implementer lineage is refused by the pre-flight too, not only by emit', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    lineageRelatedM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-relative'),
    );

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-relative', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      graderEligibility: {
        role: 'disqualified',
        blocksEmit: true,
        refusal: { code: 'grader_in_implementer_lineage' },
      },
    });
    const refusal = (preflight as {
      graderEligibility?: { refusal?: { error?: string } };
    }).graderEligibility?.refusal;
    expect(refusal?.error).toContain('Do not recruit a grader yourself');
    expect(refusal?.error).toContain("status:'shipped'");
    expect(refusal?.error).toContain('mints a lineage-safe judge');
    expect(refusal?.error).toMatch(/never launch a grader from this lineage/i);
    await expect(
      emitScorecard({ rubricRef: 'acceptance-rubric', ratings: RATINGS }, { createdBy: 'su-relative' }),
    ).resolves.toMatchObject({ ok: false, code: 'grader_in_implementer_lineage' });
  });

  it('reports principal plan implementers and excludes them without changing acceptance-author authority', async () => {
    getRubricM.mockResolvedValue({
      ...ACCEPTANCE_RUBRIC,
      subjectPlan: 'split-role-plan',
      createdBy: 'su-acceptance-author',
      proposedBy: 'su-repair-proposer',
    } as Rubric);
    planImplementersM.mockResolvedValue(['su-plan-implementer']);

    await expect(
      evaluateScorecard(
        { rubricRef: 'acceptance-rubric' },
        { id: 'su-plan-implementer', workspaceId: 'ws' },
      ),
    ).resolves.toMatchObject({
      graderEligibility: {
        role: 'disqualified',
        principalImplementers: ['su-plan-implementer'],
        refusal: { code: 'grader_in_implementer_lineage' },
      },
    });

    await expect(
      evaluateScorecard(
        { rubricRef: 'acceptance-rubric' },
        { id: 'su-acceptance-author', workspaceId: 'ws' },
      ),
    ).resolves.toMatchObject({
      graderEligibility: {
        role: 'acceptance-author',
        implementer: 'su-acceptance-author',
        principalImplementers: ['su-plan-implementer'],
      },
    });
  });

  it('an eligible independent grader is told so — the pre-flight is not a blanket warning', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    listM.mockResolvedValue([vettingCard(['su-critic'])]);

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-someone-else', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      graderEligibility: { role: 'independent-grader', canEmitGrading: true, blocksEmit: false },
    });
  });

  it('a retired acceptance rubric is a hard pre-flight block with the same refusal emit returns', async () => {
    getRubricM.mockResolvedValue({ ...ACCEPTANCE_RUBRIC, status: 'retired' } as Rubric);

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-someone-else', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      ok: true,
      graderEligibility: {
        role: 'disqualified',
        canEmitGrading: false,
        blocksEmit: true,
        refusal: { code: 'retired_acceptance_rubric' },
      },
    });
    expect(readRubricPlanRevisionM).not.toHaveBeenCalled();

    const emitted = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS },
      { createdBy: 'su-someone-else' },
    );
    expect(emitted).toMatchObject({
      ok: false,
      code: 'retired_acceptance_rubric',
      error: preflight.graderEligibility?.refusal?.error,
    });
  });

  it('the rubric author is told it records the acceptance verdict, not the grading', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-implementer', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      graderEligibility: {
        role: 'acceptance-author',
        canEmitGrading: false,
        blocksEmit: false,
        implementer: 'su-implementer',
      },
    });
  });

  it('preflight also keeps acceptance authority with createdBy after a repair re-propose', async () => {
    getRubricM.mockResolvedValue({
      ...ACCEPTANCE_RUBRIC,
      createdBy: 'su-original-author',
      proposedBy: 'su-repair-proposer',
    });

    await expect(
      evaluateScorecard(
        { rubricRef: 'acceptance-rubric' },
        { id: 'su-original-author', workspaceId: 'ws' },
      ),
    ).resolves.toMatchObject({
      graderEligibility: {
        role: 'acceptance-author',
        implementer: 'su-original-author',
      },
    });

    await expect(
      evaluateScorecard(
        { rubricRef: 'acceptance-rubric' },
        { id: 'su-repair-proposer', workspaceId: 'ws' },
      ),
    ).resolves.toMatchObject({
      graderEligibility: {
        role: 'independent-grader',
        implementer: 'su-original-author',
      },
    });
  });

  it('a NON-acceptance rubric, and a caller-less call, report null rather than a guess', async () => {
    getRubricM.mockResolvedValue(RUBRIC);
    await expect(
      evaluateScorecard({ rubricRef: 'test-rubric' }, { id: 'su-anyone', workspaceId: 'ws' }),
    ).resolves.toMatchObject({ graderEligibility: null });

    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    await expect(evaluateScorecard({ rubricRef: 'acceptance-rubric' })).resolves.toMatchObject({
      graderEligibility: null,
    });
  });

  it('an unresolvable eligibility read reports `unknown` and explicitly denies clearance', async () => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
    readRubricPlanRevisionM.mockRejectedValue(new Error('pg down'));

    const preflight = await evaluateScorecard(
      { rubricRef: 'acceptance-rubric' },
      { id: 'su-someone-else', workspaceId: 'ws' },
    );
    expect(preflight).toMatchObject({
      ok: true,
      graderEligibility: { role: 'unknown', canEmitGrading: false },
    });
    // The wording matters: silence from a pre-flight reads as permission.
    expect(
      (preflight as { graderEligibility: { advice: string } }).graderEligibility.advice,
    ).toContain('NOT a clearance');
  });
});

describe('collapseCriticsToSoleParty — the predicate the refusal and its advisory share', () => {
  it('collapses a lone critic, and a longer list that is all one lineage', async () => {
    await expect(collapseCriticsToSoleParty(['su-a'], { workspaceId: 'ws' })).resolves.toBe('su-a');
    await expect(
      collapseCriticsToSoleParty(['su-a', 'su-a-rebound'], {
        workspaceId: 'ws',
        lineageRelated: (async (x: string | null, y: string | null) =>
          x === y || (x === 'su-a-rebound' && y === 'su-a')) as typeof areAcceptanceLineageRelated,
      }),
    ).resolves.toBe('su-a');
  });

  it('does NOT collapse two genuinely independent critics — that vetting preserved the three-party chain', async () => {
    await expect(collapseCriticsToSoleParty(['su-a', 'su-b'], { workspaceId: 'ws' })).resolves.toBeNull();
    await expect(collapseCriticsToSoleParty([], { workspaceId: 'ws' })).resolves.toBeNull();
  });
});

/**
 * EI-22076444083578001 / EI-22075966283697642: two callers' jq broke while inspecting
 * these tools' output — one read the `skeleton` ARRAY as an object, the other tried to
 * CSV-serialize the object-valued `generationFreshness`. Neither shape was published
 * anywhere a caller could read it: `scorecards:evaluate` carried no `guidance.returns`
 * at all, and `scorecards:list`'s named only its scalar fields. That is precisely the
 * gap `guidance.returns` exists to close (EI-10882) — arg schemas are published, return
 * shapes were not, so the only way to learn one was to call the tool and stringify it.
 *
 * These pin the PROSE to the CODE in both directions: change the emitted shape and the
 * code half fails; delete the promise and the prose half fails. Neither can drift alone.
 */
describe('scorecards result-shape contract is PUBLISHED, and matches what the code emits', () => {
  /** The repo idiom for reading a default-imported tool's authored guidance. */
  type GuidanceTool = { guidance?: { returns?: string } };

  it('`skeleton` is an ARRAY, and scorecards:evaluate says so in guidance.returns', async () => {
    const result = await evaluateScorecard({ rubricRef: 'test-rubric' });

    // The code half: a positional ARRAY of criterion rows, never an object keyed by
    // criterion — the assumption that broke the reporting caller's jq.
    const skeleton = (result as { skeleton: unknown }).skeleton;
    expect(Array.isArray(skeleton)).toBe(true);
    expect(skeleton).toHaveLength(RUBRIC.criteria.length);

    // The prose half: without it a caller has no published way to learn the above.
    const returns = (evaluateTool as unknown as GuidanceTool).guidance?.returns ?? '';
    expect(returns, 'scorecards:evaluate must publish guidance.returns').not.toBe('');
    expect(returns).toContain('skeleton');
    expect(returns).toContain('ARRAY');
  });

  it('`generationFreshness` reaches the caller as a nested OBJECT, and both readers name it', async () => {
    const subject = { kind: 'work-item' as const, ref: 'WI-exact' };
    getRubricM.mockResolvedValue({ ...RUBRIC, revision: 7, criteriaHash: 'a'.repeat(64) });
    listM.mockResolvedValue([
      {
        issueId: 'EI-1',
        rubricRef: 'test-rubric',
        rubricRevision: 7, criteriaHash: 'a'.repeat(64), subject,
        ratings: RATINGS,
        gradedGeneration: { deployedSha: 'abc', hostStartedAt: '2026-09-02T00:00:00.000Z' },
        generationFreshness: { status: 'stale' },
      } as unknown as ScorecardRow,
    ]);

    // The code half: an OBJECT on the row, which is what a flat/CSV projection breaks on.
    const result = await evaluateScorecard({ rubricRef: 'test-rubric', subject });
    const latest = (result as { latest: { generationFreshness?: unknown } | null }).latest;
    expect(latest?.generationFreshness).toBeTypeOf('object');
    expect(latest?.generationFreshness).not.toBeNull();

    // The prose half, on BOTH tools that hand a ScorecardRow to a caller.
    for (const [name, tool] of [
      ['scorecards:evaluate', evaluateTool],
      ['scorecards:list', listTool],
    ] as const) {
      const returns = (tool as unknown as GuidanceTool).guidance?.returns ?? '';
      expect(returns, `${name} must name generationFreshness in guidance.returns`).toContain(
        'generationFreshness',
      );
      expect(returns, `${name} must say it is an OBJECT, not a scalar`).toContain('OBJECT');
    }
  });
});

describe('scorecards:evaluate input ownership is explicit', () => {
  it('accepts the same subject/window on evaluate and emit for registered instruments', () => {
    expect(
      scorecardEvaluateArgs.safeParse({
        rubricRef: 'test-rubric',
        subject: { kind: 'plan', ref: 'test-plan' },
      }).success,
    ).toBe(true);

    const evaluate = evaluateTool as unknown as {
      description?: string;
      guidance?: { when?: string; chaining?: string };
    };
    expect(evaluate.description).toContain('exact subject/window');
    expect(evaluate.guidance?.when).toContain('same `subject` and observation window');
    expect(evaluate.guidance?.chaining).toContain('Registered instruments execute on both calls');
  });

  it('documents source-vs-target hive ownership for cross-hive grading', () => {
    const evaluateSourceHive = scorecardEvaluateArgs.shape.sourceHive.description ?? '';
    const emitSchema = z.toJSONSchema(scorecardEmitArgs) as {
      oneOf?: Array<{ properties?: Record<string, { description?: string }> }>;
    };
    const emitShape = emitSchema.oneOf?.find((branch) => branch.properties?.sourceHive)?.properties ?? {};
    const emitSourceHive = emitShape.sourceHive?.description ?? '';
    const emitTargetHive = emitShape.targetHive?.description ?? '';

    expect(evaluateSourceHive).toContain('hive that produced/filed the scorecard');
    expect(evaluateSourceHive).toContain('not the harness that owns the rubric subject plan');
    // emit's descriptions were trimmed for tool prompt-weight (2787acd888); pin the same
    // four semantics against the compact wording: grader hive, subject hive → targetHive,
    // targetHive names the subject plan's hive, and the two are independent.
    expect(emitSourceHive).toContain('grader hive');
    expect(emitSourceHive).toContain("put the subject plan's hive in targetHive");
    expect(emitTargetHive).toContain('Subject plan/repository hive');
    expect(emitTargetHive).toContain('Independent of sourceHive');
  });
});

describe('DS-P010-DISTINCT-OBSERVATIONS public scorecards handlers', () => {
  const plan = 'workspace-host-deferred-spend-reconciliation-2026-09-07';
  const keys = ['workspace-host.deferred-spend.r007', 'workspace-host.deferred-spend.r008'];
  const subject = { kind: 'plan' as const, ref: plan,
    windowStart: '2026-10-25T19:00:00Z', windowEnd: '2026-10-25T20:00:00Z' };
  beforeEach(() => {
    getRubricM.mockResolvedValue({ ...RUBRIC, revision: 7, criteriaHash: 'c'.repeat(64),
      subjectPlan: plan, subjectHarnessSlug: 'papercusp',
      criteria: RUBRIC.criteria.map((criterion, index) => ({ ...criterion,
        check: { kind: 'instrument', instrumentKey: keys[index] } })) });
  });
  // The instrument boundary is doubled here; the adjacent composer suite runs the
  // real P007/P008/P009 collectors. No fixture establishes live product evidence.
  function measurement(verdict: 'unknown' | 'fail') {
    return { scope: 'deferred-spend-acceptance',
      identity: { observation: { observedAt: '2026-10-25T20:00:02Z' } },
      manifestRef: 'artifact:papercusp:evidence/deferred-spend/handler-control.json', manifestHash: 'a'.repeat(64),
      criteria: { r007: { verdict: 'pass', reasons: [] }, r008: { verdict, reasons: ['distinct measured outcome'] } } };
  }
  const supplied = Object.fromEntries(keys.map(key => [key, { verdict: 'pass' as const,
    measuredAt: '2026-10-25T20:00:02Z', provenance: 'platform-computed' as const }]));
  it.each(['unknown', 'fail'] as const)('baseline: evaluate and emit each execute one shared measurement and retain R008 %s independently', async verdict => {
    deferredSpendM.mockResolvedValue(measurement(verdict));
    const args = { rubricRef: 'test-rubric', subject, ratings: RATINGS, instrumentSnapshots: supplied };
    const evaluated = await evaluateScorecard(scorecardEvaluateArgs.parse(args));
    expect(deferredSpendM).toHaveBeenCalledTimes(1);
    expect(evaluated).toMatchObject({ ok: true, instrumentContract: {
      verdictMismatches: [keys[1]], positiveClaimContradictions: verdict === 'fail' ? [keys[1]] : [],
    } });
    expect(await emitScorecard(scorecardEmitArgs.parse(args), { createdBy: 'su-1' })).toMatchObject({ ok: true, created: true });
    expect(deferredSpendM).toHaveBeenCalledTimes(2);
    expect(deferredSpendM).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'ws', harness: 'papercusp', planSlug: plan,
      rubricRef: 'test-rubric', rubricRevision: 7, criteriaHash: 'c'.repeat(64), subjectRef: plan,
      windowStart: subject.windowStart, windowEnd: subject.windowEnd }));
    expect(captureM.mock.calls[0][0]).toMatchObject({ payloadExtra: { observation: { instrumentSnapshots: {
      [keys[0]]: { verdict: 'pass' }, [keys[1]]: { verdict },
    } } } });
  });
  it.each(['resolver-error', 'missing-identity'] as const)('counterexample: both handlers replace forged passes on %s', async defect => {
    if (defect === 'resolver-error') deferredSpendM.mockRejectedValue(new Error('unavailable'));
    else deferredSpendM.mockResolvedValue({ ...measurement('unknown'), identity: undefined });
    const args = { rubricRef: 'test-rubric', subject, ratings: RATINGS, instrumentSnapshots: supplied };
    expect(await evaluateScorecard(scorecardEvaluateArgs.parse(args))).toMatchObject({ ok: true, instrumentContract: {
      verdictMismatches: keys, positiveClaimContradictions: [],
    } });
    expect(await emitScorecard(scorecardEmitArgs.parse(args), { createdBy: 'su-1' })).toMatchObject({ ok: true, created: true });
    expect(deferredSpendM).toHaveBeenCalledTimes(2);
    expect(captureM.mock.calls[0][0]).toMatchObject({ payloadExtra: { observation: { instrumentSnapshots: {
      [keys[0]]: { verdict: 'unknown', provenance: 'platform-computed' },
      [keys[1]]: { verdict: 'unknown', provenance: 'platform-computed' },
    } } } });
  });
});

describe('Work on everything evidence contract through evaluate and emit', () => {
  const rubricRef = 'work-on-everything-stewardship-health';
  const subject = { kind: 'agent-run' as const, ref: 'holder', windowStart: '2026-09-05T00:00:00Z', windowEnd: '2026-09-06T00:00:00Z' };
  const ratings = Object.fromEntries(Object.entries(RATINGS).map(([key, value]) => [key, {
    ...value, evidenceRef: 'test:stewardship-run', evidenceKind: 'test', attribution: 'subject' as const,
  }]));

  beforeEach(() => getRubricM.mockResolvedValue({ ...RUBRIC, rubricId: rubricRef }));

  it('refuses prose-only evidence at both public handlers without writing', async () => {
    expect(await evaluateScorecard({ rubricRef, ratings: RATINGS })).toMatchObject({ ok: false, error: expect.stringContaining('evidenceRef') });
    expect(await emitScorecard({ rubricRef, ratings: RATINGS }, { createdBy: 'su-1' })).toMatchObject({ ok: false, error: expect.stringContaining('evidenceRef') });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('preserves the complete evidence bundle and computed rollup through emission', async () => {
    const args = { rubricRef, subject, ratings, instrumentSnapshots: {
      unsupported: { verdict: 'pass' as const, measuredAt: subject.windowEnd, provenance: 'platform-computed' as const, value: { retainedCount: 42 } },
    } };
    const evaluated = await evaluateScorecard(scorecardEvaluateArgs.parse(args));
    expect(evaluated).toMatchObject({ ok: true, rollup: { verdict: 'pass', coverage: { sufficient: true } } });
    expect(await emitScorecard(scorecardEmitArgs.parse(args), { createdBy: 'su-1' })).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({ payloadExtra: { observation: {
      subject, ratings, rollup: { verdict: 'pass' },
      instrumentSnapshots: { unsupported: { provenance: 'self-reported', value: { retainedCount: 42 } } },
      evidenceRecord: AGENT_RUN_EVIDENCE_RECORD,
    } } });
    // The derivation is asked about exactly the graded holder and window.
    expect(deriveAgentRunEvidenceRecordSafeM).toHaveBeenCalledWith(expect.objectContaining({
      holder: subject.ref, windowStart: subject.windowStart, windowEnd: subject.windowEnd,
    }));
  });

  it('rejects a missing absence control at both handlers', async () => {
    const missingControl = { ...ratings, 'crit-a': { ...ratings['crit-a'], absenceClaim: true } };
    expect(await evaluateScorecard({ rubricRef, ratings: missingControl })).toMatchObject({ ok: false, error: expect.stringContaining('positiveControlRef') });
    expect(await emitScorecard({ rubricRef, ratings: missingControl }, { createdBy: 'su-1' })).toMatchObject({ ok: false, error: expect.stringContaining('positiveControlRef') });
    expect(captureM).not.toHaveBeenCalled();
  });
});

/**
 * P-003 (review-verification-efficiency-2026-09-09): the acceptance-rubric AUTHOR
 * records accept/reject by EXACT independent scorecard reference, and the server
 * adopts that card's ratings verbatim instead of making the author re-transcribe a
 * grading they did not perform.
 *
 * What is removed is the TRANSCRIPTION, never the PERSISTENCE. That distinction is
 * the whole design and it is load-bearing downstream: plan-acceptance-gate reads
 * RATINGS from the independent card and only the VERDICT from the author's, but it
 * finds the author's card at all only while that card passes its `complete` filter
 * (rubricResolved && no missingKeys). A card persisted without ratings is dropped
 * there and its verdict then reads as `acceptance_not_recorded` — so these tests
 * assert the persisted card still carries complete ratings, not merely that the
 * call was accepted.
 *
 * Unit-level against the real handler (the mocks above are collaborators, not the
 * subject): a doc-string guard cannot tell whether adoption actually happened, and
 * P-003 asks for verified handler behavior.
 */
describe('scorecards:emit — author acceptance by exact reference (P-003)', () => {
  /** What the independent grader actually wrote — deliberately DIFFERENT text from
   *  RATINGS so an assertion cannot pass by coincidence when nothing was adopted. */
  const GRADER_RATINGS = {
    'crit-a': { rating: 'pass', evidence: 'grader re-derived A from source' },
    'crit-b': { rating: 'pass', evidence: 'grader re-derived B from source' },
  };

  /** A complete, live, independent grading at the CURRENT rubric revision (7 —
   *  getRubricPlanRevisionM's default in beforeEach, so the two cannot drift). */
  const independentCard = (over: Record<string, unknown> = {}) =>
    ({
      issueId: 'EI-independent',
      createdAt: '2026-09-10T01:00:00Z',
      createdBy: 'su-grader',
      rubricRef: 'acceptance-rubric',
      ratings: GRADER_RATINGS,
      rubricRevision: 7,
      nKeys: 2,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      synthesized: false,
      score10: 10,
      linkedItems: [],
      ...over,
    }) as unknown as ScorecardRow;

  const ACCEPT = { verdict: 'accept' as const, reasoning: 'The independent grading meets this plan.' };

  /** The author's verdict citing the exact card, with NO ratings of their own. */
  const acceptanceOfArgs = (over: Record<string, unknown> = {}) => ({
    rubricRef: 'acceptance-rubric',
    acceptance: ACCEPT,
    acceptanceOf: 'EI-independent',
    ...over,
  });

  const asAuthor = { createdBy: 'su-implementer' };

  beforeEach(() => {
    getRubricM.mockResolvedValue(ACCEPTANCE_RUBRIC);
  });

  it('adopts the named card ratings verbatim, so the persisted card is still schema-complete', async () => {
    listM.mockResolvedValue([independentCard()]);

    const r = await emitScorecard(acceptanceOfArgs() as never, asAuthor);

    expect(r).toMatchObject({ ok: true, created: true, acceptance: expect.objectContaining(ACCEPT) });
    // The PERSISTED card is what the acceptance gate reads. Assert the grader's
    // evidence actually landed in it — the author never typed these strings, so
    // their presence can only mean adoption ran. (Completeness itself is already
    // proven by ok:true: validateScorecardCompleteness runs before the write and
    // refuses a card missing any declared criterion.)
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: {
        observation: {
          ratings: {
            'crit-a': { evidence: expect.stringContaining('grader re-derived A') },
            'crit-b': { evidence: expect.stringContaining('grader re-derived B') },
          },
        },
      },
    });
  });

  it('stamps adoption provenance naming the exact card, its grader and the graded revision', async () => {
    listM.mockResolvedValue([independentCard()]);

    await emitScorecard(acceptanceOfArgs() as never, asAuthor);

    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: {
        observation: {
          acceptance: {
            adoptedRatingsFrom: { scorecardId: 'EI-independent', gradedBy: 'su-grader', rubricRevision: 7 },
          },
        },
      },
    });
  });

  it('does NOT stamp adoption when the author supplied their own ratings', async () => {
    // An author who transcribed the ratings made their own record of them;
    // marking that as adopted would misreport whose judgment the card carries.
    listM.mockResolvedValue([independentCard()]);

    const r = await emitScorecard(acceptanceOfArgs({ ratings: RATINGS }) as never, asAuthor);

    expect(r).toMatchObject({ ok: true, created: true });
    expect(captureM.mock.calls[0][0]).toMatchObject({
      payloadExtra: {
        observation: {
          acceptance: expect.not.objectContaining({ adoptedRatingsFrom: expect.anything() }),
        },
      },
    });
  });

  it('refuses acceptanceOf without a verdict — a reference with nothing to attach it to', async () => {
    listM.mockResolvedValue([independentCard()]);

    const r = await emitScorecard(
      { rubricRef: 'acceptance-rubric', ratings: RATINGS, acceptanceOf: 'EI-independent' } as never,
      asAuthor,
    );

    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('acceptance:{ verdict, reasoning }') });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses acceptance_of_not_found when the named id is not a card for this rubric', async () => {
    listM.mockResolvedValue([independentCard()]);

    const r = await emitScorecard(acceptanceOfArgs({ acceptanceOf: 'EI-nope' }) as never, asAuthor);

    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_not_found' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses acceptance_of_retracted — a verdict must accept a live grading, not a withdrawn one', async () => {
    listM.mockResolvedValue([independentCard({ retracted: true })]);

    const r = await emitScorecard(acceptanceOfArgs() as never, asAuthor);

    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_retracted' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses acceptance_of_not_independent for a card inside the author lineage', async () => {
    // Naming a card must never become a way to accept evidence the independence
    // scan would have refused — that would be an authorization bypass wearing the
    // costume of a convenience argument.
    lineageRelatedM.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-grader'),
    );
    listM.mockResolvedValue([independentCard()]);

    const r = await emitScorecard(acceptanceOfArgs() as never, asAuthor);

    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_not_independent' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses acceptance_of_not_independent for an incomplete card', async () => {
    listM.mockResolvedValue([independentCard({ missingKeys: ['crit-b'] })]);

    const r = await emitScorecard(acceptanceOfArgs() as never, asAuthor);

    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_not_independent' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses acceptance_of_stale_revision — adopted ratings must cover criteria still in force', async () => {
    // The independence scan never needed this rail because it only GATED. Adoption
    // does: copying ratings from a card that graded an older revision would persist
    // a grading of criteria that have since changed, under the current revision's
    // identity.
    listM.mockResolvedValue([independentCard({ rubricRevision: 6 })]);

    const r = await emitScorecard(acceptanceOfArgs() as never, asAuthor);

    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_stale_revision' });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses acceptance_of_stale_criteria even when the noisy revision counter is unchanged', async () => {
    getRubricCriteriaHashM.mockResolvedValue('hash-current');
    listM.mockResolvedValue([independentCard({ rubricRevision: 7, criteriaHash: 'hash-old' })]);

    const r = await emitScorecard(acceptanceOfArgs() as never, asAuthor);

    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_stale_criteria' });
    expect(r.error).toContain('criteria-hash-mismatch');
    expect(captureM).not.toHaveBeenCalled();
  });

  it('never adopts from the independence SCAN — omitting ratings without an exact reference refuses', async () => {
    // REGRESSION GUARD. Both paths set `acceptedIndependent`, so it is tempting to
    // let either one feed adoption. They are not interchangeable: the scan is a
    // pure gate and deliberately carries no revision rail, so scan-fed adoption
    // would route around acceptance_of_stale_revision by simply OMITTING the
    // argument that triggers it. The card below is scan-eligible but graded a
    // stale revision — exactly the case that must not be silently adopted.
    listM.mockResolvedValue([independentCard({ rubricRevision: 6 })]);

    const r = await emitScorecard(
      { rubricRef: 'acceptance-rubric', acceptance: ACCEPT } as never,
      asAuthor,
    );

    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('acceptanceOf') });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('refuses a card that graded a DIFFERENT SUBJECT — the wrong-subject negative control', async () => {
    // SPEC-P003-SCORECARD-REFERENCE@1 names wrong-subject as required evidence.
    // The card below is eligible in EVERY other respect (complete, live, current
    // revision, outside the author's lineage) and differs only in what it graded.
    // Adopting it would let an author's verdict rest on a grading of someone
    // else's subject — the ratings the ship gate reads would describe other work.
    listM.mockResolvedValue([independentCard({ subject: { kind: 'plan', ref: 'a-completely-different-plan' } })]);

    const r = await emitScorecard(
      acceptanceOfArgs({ subject: { kind: 'plan', ref: 'the-plan-under-acceptance' } }) as never,
      asAuthor,
    );

    // Pin the exact code, like every sibling control here. A bare `ok: false`
    // cannot tell the subject rail from an unrelated refusal, so it would keep
    // passing if the rail were removed and the fixture later went ineligible for
    // some other reason — a negative control that cannot fail for the right
    // reason is not evidence.
    expect(r).toMatchObject({ ok: false, code: 'acceptance_of_wrong_subject' });
    expect(captureM).not.toHaveBeenCalled();
  });
});
vi.mock('../../acceptance-rubric-critique', () => ({ readCurrentAcceptanceRubricCritique: vi.fn(async () => null) }));
