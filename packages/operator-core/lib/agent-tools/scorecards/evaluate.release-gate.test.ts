/**
 * scorecards:evaluate release-gate binding integration (EI-18706603928993591).
 *
 * The pure SHA/gate truth table lives in scorecards.test.ts. These tests pin the
 * tool-layer seam: evaluate must run that same preflight as emit, surface the
 * stale-pass sentinel before a caller does grading work, and carry testedSha in
 * the evidence identity used for changed/dedup reporting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rubric } from '../../rubrics';
import type { ScorecardRow } from '../../scorecards';
import type { ScorecardReleaseGateBinding } from '../../harness/improvements/observation-types';
import type { EngineerIssue } from '../../issues-engineer';
import { mockResolvedTyped } from '../../testing/typed-mock';

vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics')>();
  const lookup = vi.fn();
  const readRubricWithoutSeeding = vi.fn(async (rubricId: string) => {
    const rubric = await lookup(rubricId);
    return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
  });
  const readRubric = vi.fn(async (rubricId: string) => {
    const rubric = await lookup(rubricId);
    return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
  });
  return {
    ...actual,
    getRubric: lookup,
    getRubricWithoutSeeding: lookup,
    readRubricWithoutSeeding,
    readRubric,
    getRubricPlanRevision: vi.fn(async () => 3),
    readRubricPlanRevision: vi.fn(async () => ({ ok: true as const, revision: 3 })),
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return {
    ...actual,
    listScorecards: vi.fn(async () => [] as ScorecardRow[]),
    resolveScorecardReleaseGateBinding: vi.fn(),
  };
});
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: vi.fn(async () => null) }));
vi.mock('../../harness/improvements/capture-core', () => ({ captureImprovement: vi.fn() }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: vi.fn(async () => {}) }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

import { getRubricWithoutSeeding, readRubric, readRubricWithoutSeeding } from '../../rubrics';
import { captureImprovement } from '../../harness/improvements/capture-core';
import {
  listScorecards,
  resolveScorecardReleaseGateBinding,
  scorecardEvidenceFingerprint,
} from '../../scorecards';
import { emitScorecard } from './emit';
import { evaluateScorecard, scorecardEvaluateArgs } from './evaluate';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const RATINGS = {
  'release-tests': { rating: 'pass', evidence: 'focused release suite passed at the tested commit' },
  'operator-drill': { rating: 'pass', evidence: 'operator drill passed at the tested commit' },
};
const RELEASE_RUBRIC = {
  rubricId: 'release-readiness',
  workspaceId: 'ws',
  characteristic: 'release readiness',
  title: 'Release readiness',
  description: 'Release gate integration fixture',
  criteria: [
    {
      key: 'release-tests',
      title: 'Release tests',
      model: 'm',
      method: 'm',
      driftMarkers: 'd',
      instrumentKey: 'none',
    },
    {
      key: 'operator-drill',
      title: 'Operator drill',
      model: 'm',
      method: 'm',
      driftMarkers: 'd',
      instrumentKey: 'none',
    },
  ],
  ratingScale: ['pass', 'partial', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  releaseGating: true,
} as unknown as Rubric;

const bound = (): ScorecardReleaseGateBinding => ({
  status: 'bound',
  reasonCode: null,
  reason: null,
  checkedAt: '2026-09-04T16:00:00.000Z',
  testedSha: SHA,
  gateVerdict: 'green',
  gateCandidate: SHA,
  lastGreenCommit: SHA,
  stagingHead: SHA,
  commitsBehindHead: 0,
  failingTests: [],
});

const blocked = (reasonCode: string): ScorecardReleaseGateBinding => ({
  status: 'stale-pass-blocked',
  reasonCode,
  reason: reasonCode === 'tested-sha-required'
    ? 'positive release ratings require testedSha'
    : 'the authoritative gate is red',
  checkedAt: '2026-09-04T16:00:00.000Z',
  testedSha: reasonCode === 'tested-sha-required' ? null : SHA,
  gateVerdict: reasonCode === 'tested-sha-required' ? 'green' : 'not-green',
  gateCandidate: SHA,
  lastGreenCommit: SHA,
  stagingHead: SHA,
  commitsBehindHead: 0,
  failingTests: reasonCode === 'gate-not-green' ? ['lint:tsc'] : [],
});

const getRubricM = vi.mocked(getRubricWithoutSeeding);
const readRubricM = vi.mocked(readRubric);
const readRubricWithoutSeedingM = vi.mocked(readRubricWithoutSeeding);
const listScorecardsM = vi.mocked(listScorecards);
const releaseBindingM = vi.mocked(resolveScorecardReleaseGateBinding);
const captureM = vi.mocked(captureImprovement);

/** The issue row `captureImprovement` resolves with — a complete EngineerIssue so the
 *  fixture is checked against the real result type rather than cast through `never`. */
const RELEASE_ISSUE: EngineerIssue = {
  id: 'EI-release-card',
  kind: 'change',
  scope: 'operator',
  title: 'release-gate scorecard',
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

beforeEach(() => {
  vi.clearAllMocks();
  getRubricM.mockResolvedValue(RELEASE_RUBRIC);
  readRubricWithoutSeedingM.mockImplementation(async (rubricId) => {
    const rubric = await getRubricM(rubricId);
    return rubric ? { kind: 'found', rubric } : { kind: 'missing' };
  });
  readRubricM.mockImplementation(async (rubricId) => {
    const rubric = await getRubricM(rubricId);
    return rubric ? { kind: 'found', rubric } : { kind: 'missing' };
  });
  listScorecardsM.mockResolvedValue([]);
  releaseBindingM.mockResolvedValue(bound());
  mockResolvedTyped(captureM, {
    ok: true,
    created: true,
    issue: RELEASE_ISSUE,
    possibleDuplicates: [],
  });
});

describe('scorecards:evaluate release-gate binding', () => {
  it('accepts only a commit-shaped testedSha at the tool boundary', () => {
    expect(scorecardEvaluateArgs.safeParse({ rubricRef: 'release-readiness', ratings: RATINGS, testedSha: SHA }).success)
      .toBe(true);
    expect(scorecardEvaluateArgs.safeParse({ rubricRef: 'release-readiness', ratings: RATINGS, testedSha: 'not-a-sha' }).success)
      .toBe(false);
  });

  it('blocks a positive release evaluation with no testedSha before it can look green', async () => {
    releaseBindingM.mockResolvedValue(blocked('tested-sha-required'));

    const result = await evaluateScorecard({ rubricRef: 'release-readiness', ratings: RATINGS });

    expect(releaseBindingM).toHaveBeenCalledWith(undefined);
    expect(result).toMatchObject({
      ok: false,
      code: 'stale_pass_blocked',
      canonicalRatings: RATINGS,
      releaseGateBinding: {
        status: 'stale-pass-blocked',
        reasonCode: 'tested-sha-required',
      },
    });
  });

  it('surfaces the authoritative red reason and failing tests during preflight', async () => {
    releaseBindingM.mockResolvedValue(blocked('gate-not-green'));

    const result = await evaluateScorecard({
      rubricRef: 'release-readiness',
      ratings: RATINGS,
      testedSha: SHA,
    });

    expect(releaseBindingM).toHaveBeenCalledWith(SHA);
    expect(result).toMatchObject({
      ok: false,
      code: 'stale_pass_blocked',
      releaseGateBinding: {
        status: 'stale-pass-blocked',
        reasonCode: 'gate-not-green',
        gateVerdict: 'not-green',
        failingTests: ['lint:tsc'],
      },
    });
  });

  it('returns a bound proof and makes testedSha part of the validated evidence identity', async () => {
    const result = await evaluateScorecard({
      rubricRef: 'release-readiness',
      ratings: RATINGS,
      testedSha: SHA,
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      releaseGateBinding: { status: 'bound', testedSha: SHA },
      evidenceFingerprint: scorecardEvidenceFingerprint({
        rubricRef: 'release-readiness',
        ratings: RATINGS,
        testedSha: SHA,
      }),
    });
  });

  it('uses a legacy row\'s persisted testedSha in the fallback identity', async () => {
    listScorecardsM.mockResolvedValue([
      {
        issueId: 'EI-release-card',
        rubricRef: 'release-readiness',
        ratings: RATINGS,
        testedSha: SHA,
        missingKeys: [],
        rubricResolved: true,
        synthesized: false,
        score10: 10,
        linkedItems: [],
      } as unknown as ScorecardRow,
    ]);

    const result = await evaluateScorecard({
      rubricRef: 'release-readiness',
      ratings: RATINGS,
      testedSha: SHA,
    });

    expect(result).toMatchObject({ ok: true, changed: false });
  });
});

describe('scorecards:emit release-gate binding', () => {
  it('writes nothing when the live gate cannot bind a pass to testedSha', async () => {
    releaseBindingM.mockResolvedValue(blocked('gate-not-green'));

    const result = await emitScorecard(
      { rubricRef: 'release-readiness', ratings: RATINGS, testedSha: SHA },
      { createdBy: 'su-grader' },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'stale_pass_blocked',
      releaseGateBinding: { reasonCode: 'gate-not-green', failingTests: ['lint:tsc'] },
    });
    expect(captureM).not.toHaveBeenCalled();
  });

  it('persists the bound SHA/proof and fingerprints the tested commit', async () => {
    const result = await emitScorecard(
      { rubricRef: 'release-readiness', ratings: RATINGS, testedSha: SHA },
      { createdBy: 'su-grader' },
    );

    const evidenceFingerprint = scorecardEvidenceFingerprint({
      rubricRef: 'release-readiness',
      ratings: RATINGS,
      testedSha: SHA,
    });
    expect(result).toMatchObject({
      ok: true,
      created: true,
      issueId: 'EI-release-card',
      evidenceFingerprint,
      releaseGateBinding: { status: 'bound', testedSha: SHA },
    });
    expect(captureM).toHaveBeenCalledTimes(1);
    expect(captureM.mock.calls[0]?.[0]).toMatchObject({
      initialState: 'done',
      payloadExtra: {
        observation: {
          rubricRef: 'release-readiness',
          testedSha: SHA,
          releaseGateBinding: { status: 'bound', testedSha: SHA },
          evidenceFingerprint,
        },
      },
    });
  });
});
