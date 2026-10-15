/** P-008 (EI-20581177540737568): provisional-until-terminal on scorecards:emit. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRubric = vi.fn();
const getRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    getRubricPlanRevision: (...a: unknown[]) => getRubricPlanRevision(...a),
    // The real identity helper closes over the real getRubric, bypassing this suite's mock.
    getRubricEvidenceIdentity: async (rubricId: string) => ({
      revision: await getRubricPlanRevision(rubricId),
      criteriaHash: (await getRubric(rubricId))?.criteriaHash ?? null,
      meaningRevision: null,
    }),
  };
});

describe('scorecards:emit preserved grading baseline', () => {
  const hash = 'a'.repeat(64);
  const subject = { kind: 'pot' as const, ref: 'target' };
  const baseline = () => ({ issueId: 'EI-baseline', rubricRef: RUBRIC.rubricId, rubricRevision: 33,
    criteriaHash: hash, subject, createdBy: 'baseline-grader', createdAt: '2026-10-09T10:00:00Z',
    rubricResolved: true, missingKeys: [], extraKeys: [], synthesized: false,
    rubricCurrentness: { state: 'current' }, gradingAudit: { state: 'passed' },
    gradingAuditCurrentness: { state: 'current' }, ratings: {
      ...RATINGS, 'never-implements': { rating: 'broken', evidence: 'Confirmed baseline failure', remediation: 'WI-12' },
    } });
  const args = () => ({ rubricRef: RUBRIC.rubricId, ratings: RATINGS, subject,
    baselineRef: 'EI-baseline', terminal: true });
  beforeEach(() => {
    getRubric.mockResolvedValue({ ...RUBRIC, criteriaHash: hash });
    listScorecards.mockImplementation(async (filter: { issueIds?: string[] }) =>
      filter.issueIds ? [baseline()] : []);
  });
  it('persists the explicit baseline while preserving its independent scorecard', async () => {
    // The same-subject baseline is deliberately present in the duplicate query:
    // naming the preserved baseline is sufficient; unrelated peer cards remain guarded.
    listScorecards.mockResolvedValue([baseline()]);
    expect(await emitScorecard(args(), EMIT_INPUT)).toMatchObject({ ok: true, created: true });
    expect(captureImprovement.mock.calls[0][0].payloadExtra.observation).toMatchObject({ baselineRef: 'EI-baseline' });
    expect(captureImprovement.mock.calls[0][0].payloadExtra.observation.supersedes).toBeUndefined();
  });
  it('refuses to replace the baseline as a correction in the same filing', async () => {
    expect(await emitScorecard({ ...args(), supersedes: 'EI-baseline' }, EMIT_INPUT))
      .toMatchObject({ ok: false, code: 'baseline_correction_conflict' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });
  it.each([
    { subject: undefined },
    { subject: { kind: 'pot', ref: 'foreign' } }, { rubricRevision: 32 }, { criteriaHash: 'b'.repeat(64) },
    { gradingAuditCurrentness: { state: 'stale' } },
    { missingKeys: ['missing'] }, { retracted: { at: '2026-10-09T11:00:00Z' } },
  ])('refuses missing, changed or unsettled baseline evidence: %j', change => {
    listScorecards.mockResolvedValue([{ ...baseline(), ...change }]);
    return expect(emitScorecard(args(), EMIT_INPUT)).resolves.toMatchObject({ ok: false, code: 'baseline_not_comparable' });
  });
  it('requires the existing grading audit before comparing a pending baseline', async () => {
    listScorecards.mockResolvedValue([{ ...baseline(), gradingAudit: { state: 'pending' } }]);
    expect(await emitScorecard(args(), EMIT_INPUT)).toMatchObject({ ok: false, code: 'grading_audit_required' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });
  it('refuses an absent baseline instead of filing ungrounded comparison evidence', async () => {
    listScorecards.mockResolvedValue([]);
    expect(await emitScorecard(args(), EMIT_INPUT)).toMatchObject({ ok: false, code: 'baseline_not_comparable' });
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return { ...real, listScorecards: (...a: unknown[]) => listScorecards(...a) };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...a: unknown[]) => captureImprovement(...a),
}));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: async () => null,
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...real, getIssue: async () => null };
});

import { emitScorecard } from './emit';
import { scorecardEvidenceFingerprint } from '../../scorecards';
import type { ObservationRatings } from '../../harness/improvements/observation-types';

const RUBRIC = {
  rubricId: 'goal-mode-e2e',
  revision: 33,
  workspaceId: 'ws',
  kind: 'standard',
  characteristic: 'goal-mode',
  title: 'Goal mode e2e',
  description: '',
  criteria: [
    {
      key: 'never-implements',
      title: 'Never implements',
      model: 'm',
      method: 'm',
      driftMarkers: 'd',
      criterionClass: 'violatable' as const,
    },
    { key: 'kickoff-portfolio-read', title: 'Kickoff', model: 'm', method: 'm', driftMarkers: 'd' },
  ],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-author',
  proposedBy: 'su-author',
  ratifiedBy: 'su-ratifier',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const RATINGS: ObservationRatings = {
  'never-implements': { rating: 'healthy', evidence: 'edit ledger empty for the run window' },
  'kickoff-portfolio-read': { rating: 'healthy', evidence: 'portfolio read at kickoff, msg id' },
};

const EMIT_INPUT = { createdBy: 'su-grader', ctxHarness: 'papercusp' };

beforeEach(() => {
  getRubric.mockReset().mockResolvedValue(RUBRIC);
  getRubricPlanRevision.mockReset().mockResolvedValue(33);
  listScorecards.mockReset().mockResolvedValue([]);
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-1' } });
});

describe('scorecards:emit provisional stamping (P-008)', () => {
  it('DEFAULT IS PROVISIONAL: rating a violatable criterion without terminal:true stamps the card', async () => {
    const res = await emitScorecard({ rubricRef: 'goal-mode-e2e', ratings: RATINGS }, EMIT_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok || !('provisional' in res)) throw new Error('expected provisional on result');
    expect(res.provisional).toMatchObject({ violatableKeys: ['never-implements'] });
    expect(Date.parse(res.provisional!.stampedAt)).toBeGreaterThan(0);
    // …and the stamp persists on the observation payload, not just the reply.
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { provisional?: unknown } };
    };
    expect(payload.payloadExtra.observation.provisional).toMatchObject({
      violatableKeys: ['never-implements'],
    });
  });

  it('terminal:true files a FINAL card — no stamp anywhere', async () => {
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      EMIT_INPUT,
    );
    expect(res.ok).toBe(true);
    expect('provisional' in res).toBe(false);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { provisional?: unknown } };
    };
    expect(payload.payloadExtra.observation.provisional).toBeUndefined();
  });

  it('a rubric with NO violatable criteria never stamps, terminal flag or not', async () => {
    getRubric.mockResolvedValue({
      ...RUBRIC,
      criteria: RUBRIC.criteria.map(({ criterionClass: _c, ...rest }) => rest),
    });
    const res = await emitScorecard({ rubricRef: 'goal-mode-e2e', ratings: RATINGS }, EMIT_INPUT);
    expect(res.ok).toBe(true);
    expect('provisional' in res).toBe(false);
  });

  it('finality-aware dedup: a terminal re-emit of IDENTICAL ratings is NOT declined as unchanged', async () => {
    const fingerprint = scorecardEvidenceFingerprint({ rubricRef: 'goal-mode-e2e', ratings: RATINGS });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-interim',
        rubricRef: 'goal-mode-e2e',
        rubricRevision: 33,
        ratings: RATINGS,
        evidenceFingerprint: fingerprint,
        provisional: { violatableKeys: ['never-implements'], stampedAt: '2026-08-17T00:00:00.000Z' },
      },
    ]);
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true, supersedes: undefined },
      EMIT_INPUT,
    );
    expect(res.ok).toBe(true);
    // The finalization filed a NEW card instead of bouncing off the fingerprint match.
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    if (res.ok && 'created' in res) expect(res.created).toBe(true);
  });

  it('CONTROL: same ratings + same finality IS still declined by fingerprint (dedup not weakened)', async () => {
    const fingerprint = scorecardEvidenceFingerprint({ rubricRef: 'goal-mode-e2e', ratings: RATINGS });
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prior-final',
        rubricRef: 'goal-mode-e2e',
        rubricRevision: 33,
        ratings: RATINGS,
        evidenceFingerprint: fingerprint,
        // no provisional — a final card, matching the new terminal emit's finality
      },
    ]);
    const res = await emitScorecard(
      { rubricRef: 'goal-mode-e2e', ratings: RATINGS, terminal: true },
      EMIT_INPUT,
    );
    expect(res.ok).toBe(true);
    if (res.ok && 'reason' in res) expect(res.reason).toBe('unchanged-evidence');
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});
