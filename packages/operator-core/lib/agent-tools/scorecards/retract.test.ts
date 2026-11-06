import { describe, expect, it, vi } from 'vitest';
import { resetGradingAuditStampForRetraction, retractScorecard, retractScorecardAtomically } from '../../scorecards';

const RATINGS = { criterion: { rating: 'healthy', evidence: 'verified' } };

function atomicRetractionHarness(payload: unknown) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let writtenObservation: Record<string, unknown> | null = null;
  const tx = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      statements.push({ text, values });
      if (text.includes('SELECT feature_id, payload')) return [{ feature_id: 'EI-1', payload }];
      if (text.includes('UPDATE harness_shared.work_items')) {
        const observationJson = values.find(
          (value): value is string => typeof value === 'string' && value.startsWith('{') && value.includes('"retracted"'),
        );
        if (observationJson) writtenObservation = JSON.parse(observationJson) as Record<string, unknown>;
        return [{ feature_id: 'EI-1' }];
      }
      throw new Error(`unexpected query: ${text}`);
    },
    {
      // Production uses unsafe() to interpolate this constant SQL fragment.
      unsafe: (rawSql: string) => rawSql,
    },
  ) as never;
  const transact = (async (fn: (client: never) => Promise<unknown>) => fn(tx)) as never;
  return { statements, transact, writtenObservation: () => writtenObservation };
}

describe('retractScorecard', () => {
  it('routes a complete scorecard through the atomic retraction writer', async () => {
    const getIssue = vi.fn(async () => ({
      payload: {
        observation: {
          rubricRef: 'rubric-a',
          ratings: RATINGS,
          sourceHive: 'papercusp',
          evidenceFingerprint: 'fp-1',
          instrumentSnapshots: { probe: { verdict: 'pass' } },
        },
        unrelated: { keep: true },
      },
    }));
    const retractAtomically = vi.fn(async (_issueId: string, retraction: { at?: string; by: string; reason: string }) => ({
      retraction: { at: retraction.at!, by: retraction.by, reason: retraction.reason },
      updated: true,
    }));

    const result = await retractScorecard(
      'EI-1',
      { by: 'su-1', reason: 'wrong repository', at: '2026-08-14T23:00:00.000Z' },
      { getIssue: getIssue as never, retractScorecardAtomically: retractAtomically as never },
    );

    expect(result).toEqual({
      ok: true,
      issueId: 'EI-1',
      retracted: true,
      retraction: { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'wrong repository' },
    });
    expect(retractAtomically).toHaveBeenCalledWith('EI-1', {
      at: '2026-08-14T23:00:00.000Z',
      by: 'su-1',
      reason: 'wrong repository',
    });
  });

  it('retracts an incomplete historical scorecard with an empty ratings map', async () => {
    const getIssue = vi.fn(async () => ({
      payload: { observation: { rubricRef: 'rubric-a', ratings: {} } },
    }));
    const retractAtomically = vi.fn(async (_issueId: string, retraction: { at?: string; by: string; reason: string }) => ({
      retraction: { at: retraction.at!, by: retraction.by, reason: retraction.reason },
      updated: true,
    }));

    const result = await retractScorecard(
      'EI-1',
      { by: 'su-1', reason: 'incomplete legacy card', at: '2026-08-14T23:00:00.000Z' },
      { getIssue: getIssue as never, retractScorecardAtomically: retractAtomically as never },
    );

    expect(result).toEqual({
      ok: true,
      issueId: 'EI-1',
      retracted: true,
      retraction: { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'incomplete legacy card' },
    });
    expect(retractAtomically).toHaveBeenCalledWith('EI-1', {
      at: '2026-08-14T23:00:00.000Z',
      by: 'su-1',
      reason: 'incomplete legacy card',
    });
  });

  it('replays an existing retraction through the atomic writer so stale audit leases can be repaired', async () => {
    const prior = { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'withdrawn' };
    const getIssue = vi.fn(async () => ({
      payload: { observation: { rubricRef: 'rubric-a', ratings: RATINGS, retracted: prior } },
    }));
    const retractAtomically = vi.fn(async () => ({ retraction: prior, updated: false }));
    const result = await retractScorecard(
      'EI-1',
      { by: 'su-2', reason: 'again' },
      { getIssue: getIssue as never, retractScorecardAtomically: retractAtomically as never },
    );
    expect(result).toEqual({ ok: true, issueId: 'EI-1', retracted: true, retraction: prior });
    expect(retractAtomically).toHaveBeenCalledWith('EI-1', prior);
  });

  it('cancels a stale pending audit and clears its lease when replaying a retraction', async () => {
    const priorRetraction = { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'withdrawn' };
    const harness = atomicRetractionHarness({
      observation: {
        rubricRef: 'rubric-a',
        ratings: RATINGS,
        evidenceFingerprint: 'fp-1',
        retracted: priorRetraction,
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-14T22:00:00.000Z',
          rubricRevision: 7,
          criteriaHash: 'hash-v7',
          dispatchReservation: { key: 'grading-audit:EI-1', reservedAt: '2026-08-14T22:01:00.000Z' },
          dispatchBackoff: { until: '2026-08-14T23:30:00.000Z' },
        },
      },
    });

    const result = await retractScorecardAtomically(
      'EI-1',
      { at: '2026-08-14T23:30:00.000Z', by: 'su-2', reason: 'new replay' },
      {
        resolveWorkspace: async () => 'ws-test',
        transact: harness.transact,
      },
    );

    expect(result).toEqual({ retraction: priorRetraction, updated: true });
    expect(harness.writtenObservation()).toMatchObject({
      rubricRef: 'rubric-a',
      ratings: RATINGS,
      evidenceFingerprint: 'fp-1',
      retracted: priorRetraction,
      gradingAudit: {
        state: 'cancelled',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-14T22:00:00.000Z',
        rubricRevision: 7,
        criteriaHash: 'hash-v7',
      },
    });
    expect(harness.writtenObservation()?.gradingAudit).not.toHaveProperty('dispatchReservation');
    expect(harness.writtenObservation()?.gradingAudit).not.toHaveProperty('dispatchBackoff');
    expect(harness.statements[0]?.text).toContain('FOR UPDATE');
  });

  it('cancels a pending audit in the same transaction that first retracts the scorecard', async () => {
    const requestedRetraction = { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'invalid source evidence' };
    const harness = atomicRetractionHarness({
      observation: {
        rubricRef: 'rubric-a',
        ratings: RATINGS,
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-14T22:00:00.000Z',
          dispatchReservation: { key: 'grading-audit:EI-1', reservedAt: '2026-08-14T22:01:00.000Z' },
        },
      },
    });

    const result = await retractScorecardAtomically('EI-1', requestedRetraction, {
      resolveWorkspace: async () => 'ws-test',
      transact: harness.transact,
    });

    expect(result).toEqual({ retraction: requestedRetraction, updated: true });
    expect(harness.writtenObservation()).toMatchObject({
      retracted: requestedRetraction,
      gradingAudit: { state: 'cancelled', metaRubricRef: 'grading-integrity' },
    });
    expect(harness.writtenObservation()?.gradingAudit).not.toHaveProperty('dispatchReservation');
  });

  it('atomically retracts a grading-integrity audit and repairs its cited subject', async () => {
    const retraction = { at: '2026-08-14T23:00:00.000Z', by: 'su-1', reason: 'falsified finding' };
    const getIssue = vi.fn(async () => ({
      payload: {
        observation: {
          rubricRef: 'grading-integrity',
          ratings: RATINGS,
          subject: { kind: 'scorecard', ref: 'EI-SUBJECT' },
        },
      },
    }));
    const retractGradingAudit = vi.fn(async () => ({ retraction, subjectReset: true }));
    const result = await retractScorecard(
      'EI-AUDIT',
      { by: 'su-1', reason: 'falsified finding', at: retraction.at },
      {
        getIssue: getIssue as never,
        retractGradingAudit: retractGradingAudit as never,
      },
    );

    expect(result).toEqual({ ok: true, issueId: 'EI-AUDIT', retracted: true, retraction });
    expect(retractGradingAudit).toHaveBeenCalledWith('EI-AUDIT', 'EI-SUBJECT', retraction);
  });

  it('clears settlement metadata and preserves the retracted audit rubric identity on its subject', () => {
    const subject = {
      rubricRef: 'rubric-a',
      ratings: RATINGS,
      gradingAudit: {
        state: 'failed',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-14T22:00:00.000Z',
        auditIssueId: 'EI-AUDIT',
        auditor: 'su-1',
        auditedAt: '2026-08-14T23:00:00.000Z',
        dispatchReservation: { key: 'grading-audit:EI-SUBJECT', reservedAt: '2026-08-14T22:00:01.000Z' },
        lastDispatchReservation: { key: 'grading-audit:EI-SUBJECT', reservedAt: '2026-08-14T22:00:01.000Z' },
      },
    };

    expect(
      resetGradingAuditStampForRetraction(subject, 'EI-AUDIT', {
        rubricRevision: 6,
        criteriaHash: 'hash-v6',
      }),
    ).toEqual({
      rubricRef: 'rubric-a',
      ratings: RATINGS,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-14T22:00:00.000Z',
        rubricRevision: 6,
        criteriaHash: 'hash-v6',
      },
    });
    expect(resetGradingAuditStampForRetraction(subject, 'EI-AUDIT')).toEqual({
      rubricRef: 'rubric-a',
      ratings: RATINGS,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-14T22:00:00.000Z',
      },
    });
    const legacyReopened = {
      ...subject,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-14T22:00:00.000Z',
      },
    };
    expect(
      resetGradingAuditStampForRetraction(legacyReopened, 'EI-AUDIT', {
        rubricRevision: 6,
        criteriaHash: 'hash-v6',
      }),
    ).toEqual({
      ...legacyReopened,
      gradingAudit: {
        ...legacyReopened.gradingAudit,
        rubricRevision: 6,
        criteriaHash: 'hash-v6',
      },
    });
    expect(
      resetGradingAuditStampForRetraction(
        {
          ...legacyReopened,
          gradingAudit: {
            ...legacyReopened.gradingAudit,
            dispatchReservation: { key: 'new-audit', reservedAt: '2026-08-14T23:30:00.000Z' },
          },
        },
        'EI-AUDIT',
        { rubricRevision: 6, criteriaHash: 'hash-v6' },
      ),
    ).toBeNull();
    expect(
      resetGradingAuditStampForRetraction(
        {
          ...legacyReopened,
          gradingAudit: {
            ...legacyReopened.gradingAudit,
            auditIssueId: 'EI-LATER-CORRECTION',
            state: 'passed',
          },
        },
        'EI-AUDIT',
        { rubricRevision: 6, criteriaHash: 'hash-v6' },
      ),
    ).toBeNull();
    expect(
      resetGradingAuditStampForRetraction(legacyReopened, 'EI-AUDIT', {
        rubricRevision: 6,
      }),
    ).toBeNull();
    expect(
      resetGradingAuditStampForRetraction(
        { ...subject, gradingAudit: { ...subject.gradingAudit, auditIssueId: 'EI-LATER-CORRECTION', state: 'passed' } },
        'EI-AUDIT',
      ),
    ).toBeNull();
  });

  it('refuses a non-scorecard issue without mutating it', async () => {
    const getIssue = vi.fn(async () => ({ payload: { observation: { kind: 'friction' } } }));
    const result = await retractScorecard(
      'EI-1',
      { by: 'su-1', reason: 'not a scorecard' },
      { getIssue: getIssue as never },
    );
    expect(result).toMatchObject({ ok: false, retracted: false, error: expect.stringContaining('not a complete scorecard') });
  });
});
