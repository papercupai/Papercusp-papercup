/**
 * scorecards.test.ts — pure unit tests for the trend DIRECTION logic
 * (plan-templates-and-rubric-v2-2026-06-20 P-010). The end-to-end aggregation
 * (reading real scorecards → a RubricTrend) is covered by the integration suite;
 * this pins the direction calc, which is the one non-trivial branch — the
 * default-ordinal severity (healthy<degraded<broken) with unknown/custom ratings
 * excluded as unassessable.
 */
import { describe, it, expect, vi } from 'vitest';
import { cancelStaleEvidencePendingGradingAuditAtomically, cancelSupersededPendingGradingAuditAtomically, classifyGradingAuditCurrentness, classifyScorecardGenerationFreshness, classifySubjectRubricCurrentness, computeTrendDirection, computeRubricStaleness, compressSeries, evaluateScorecardInstrumentContract, evaluateScorecardReleaseGateBinding, isCurrentSourceAuditResponder, isIdleUnknown, markGradingAuditAwaitingReemit, parseCriterionInstrumentKey, parseGradedGeneration, ratingScore10, recordGradingAudit, scorecardEvidenceFingerprint, scorecardScore10, scoreOverridesForScale, settlePendingGradingAuditAtomically } from './scorecards';
import type { Rubric } from './rubrics';
import { effectiveCriterionInstrumentKey } from './rubrics';
import type { CriterionTrend, ScorecardReleaseGateSnapshot } from './scorecards';
import type { SpecTestAdequacyRerunRecipe } from './harness/improvements/observation-types';

describe('superseding a pending grading-audit target', () => {
  it('atomically cancels the pending stamp and clears its live reservation only for the matching superseder', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      statements.push({ text, values });
      return [{ feature_id: 'EI-TARGET' }];
    }) as never;
    const transact = (async (fn: (client: never) => Promise<unknown>) => fn(tx)) as never;
    const notifySyncInvalidate = vi.fn();

    await expect(cancelSupersededPendingGradingAuditAtomically(
      'EI-TARGET',
      'EI-SUPERSEDER',
      { workspaceId: 'ws-test', transact, notifySyncInvalidate },
    )).resolves.toBe(true);

    const write = statements.find((statement) => statement.text.includes('UPDATE harness_shared.work_items'))!;
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->>'state' = 'pending'");
    expect(write.text).toContain("target.payload->'observation'->'gradingAudit'");
    expect(write.text).toContain("jsonb_build_object('state', 'cancelled')");
    expect(write.text).toContain("#- '{dispatchReservation}'");
    expect(write.text).toContain("#- '{dispatchBackoff}'");
    expect(write.text).toContain("payload->'observation'->>'supersedes'");
    expect(write.text).toContain("superseder.payload->'observation'->>'rubricRef' = target.payload->'observation'->>'rubricRef'");
    expect(write.text).toContain("superseder.payload->'observation'->>'sourceHive' IS NOT DISTINCT FROM target.payload->'observation'->>'sourceHive'");
    expect(write.values).toContain('ws-test');
    expect(write.values).toContain('EI-TARGET');
    expect(write.values).toContain('EI-SUPERSEDER');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('scorecards.list');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('rubrics.trend');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('learning.releaseReadiness');
  });

  it('leaves a settled or unrelated target untouched', async () => {
    const tx = (async () => []) as never;
    const transact = (async (fn: (client: never) => Promise<unknown>) => fn(tx)) as never;
    const notifySyncInvalidate = vi.fn();

    await expect(cancelSupersededPendingGradingAuditAtomically(
      'EI-TARGET',
      'EI-OTHER',
      { workspaceId: 'ws-test', transact, notifySyncInvalidate },
    )).resolves.toBe(false);
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });
});

describe('cancelling a pending audit after its exact evidence binding goes stale', () => {
  it('fences the cancellation by audit stamp, evidence identity, binding selector and live binding currentness', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      statements.push({ text, values });
      return [{ feature_id: 'EI-TARGET' }];
    }) as never;
    const transact = (async (fn: (client: never) => Promise<unknown>) => fn(tx)) as never;
    const notifySyncInvalidate = vi.fn();

    await expect(cancelStaleEvidencePendingGradingAuditAtomically(
      'EI-TARGET',
      {
        stampedAt: '2026-10-08T08:27:23.775Z',
        evidenceFingerprint: 'scorecard-evidence-v1',
        harnessSlug: 'papercusp',
        bindingIds: [30308, 30309],
      },
      { workspaceId: 'ws-test', transact, notifySyncInvalidate },
    )).resolves.toBe(true);

    const write = statements.find((statement) => statement.text.includes('UPDATE harness_shared.work_items'))!;
    expect(write.text).toContain("gradingAudit'->>'state' = 'pending'");
    expect(write.text).toContain("gradingAudit'->>'stampedAt' = ?");
    expect(write.text).toContain("observation'->>'evidenceFingerprint' IS NOT DISTINCT FROM ?");
    expect(write.text).toContain("'rerunRecipe'->'selection'->'bindingIds'");
    expect(write.text).toContain('jsonb_array_elements_text');
    expect(write.text).toContain('binding.retracted_at IS NOT NULL');
    expect(write.text).toContain("jsonb_build_object('state', 'cancelled')");
    expect(write.text).toContain("#- '{dispatchReservation}'");
    expect(write.text).toContain("#- '{dispatchBackoff}'");
    expect(write.values).toEqual(expect.arrayContaining([
      'ws-test', 'EI-TARGET', '2026-10-08T08:27:23.775Z', 'scorecard-evidence-v1', 'papercusp', '[30308,30309]',
    ]));
    expect(notifySyncInvalidate).toHaveBeenCalledWith('scorecards.list');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('rubrics.trend');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('learning.releaseReadiness');
  });

  it('refuses malformed or empty binding selectors before writing', async () => {
    const transact = vi.fn() as never;
    await expect(cancelStaleEvidencePendingGradingAuditAtomically(
      'EI-TARGET',
      { stampedAt: 'audit-stamp', bindingIds: [0] },
      { workspaceId: 'ws-test', transact },
    )).resolves.toBe(false);
    await expect(cancelStaleEvidencePendingGradingAuditAtomically(
      'EI-TARGET',
      { stampedAt: 'audit-stamp', bindingIds: [] },
      { workspaceId: 'ws-test', transact },
    )).resolves.toBe(false);
    expect(transact).not.toHaveBeenCalled();
  });
});

describe('recordGradingAudit settled-stamp corrections (EI-22592430715863943)', () => {
  it('settles only the exact pending stamp and excludes a retraction in the atomic write', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      statements.push({ text, values });
      if (text.includes('FROM harness_shared.consult_state')) return [];
      if (text.includes('FROM harness_shared.task_ledger')) return [{ coord_owner_id: 'su-auditor' }];
      return [{ feature_id: 'EI-TARGET' }];
    }) as never;
    const transact = (async (fn: (client: never) => Promise<unknown>) => fn(tx)) as never;
    const expected = {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-09-20T04:02:01.584Z',
      rubricRevision: 7,
      criteriaHash: 'hash-v7',
      dispatchReservation: {
        key: 'grading-audit:EI-TARGET',
        reservedAt: '2026-09-20T04:02:01.600Z',
      },
      lastDispatchReservation: {
        key: 'grading-audit:EI-TARGET',
        reservedAt: '2026-09-20T04:02:01.600Z',
      },
    };
    const settled = {
      state: 'passed' as const,
      metaRubricRef: expected.metaRubricRef,
      stampedAt: expected.stampedAt,
      rubricRevision: expected.rubricRevision,
      criteriaHash: expected.criteriaHash,
      auditIssueId: 'EI-AUDIT',
      auditor: 'su-auditor',
      auditedAt: '2026-09-20T04:05:00.000Z',
    };

    await expect(
      settlePendingGradingAuditAtomically('EI-TARGET', expected, settled, {
        resolveWorkspace: async () => 'ws-test',
        transact,
      }),
    ).resolves.toBe(true);

    const write = statements.find((statement) => statement.text.includes('UPDATE harness_shared.work_items'))!;
    expect(write.text).toContain("payload->'observation'->'retracted' IS NULL");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->>'state' = 'pending'");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->>'stampedAt' = ?");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->>'criteriaHash' IS NOT DISTINCT FROM ?");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->'dispatchReservation'->>'key' = ?");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt' = ?");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->'lastDispatchReservation'->>'key' = ?");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->'lastDispatchReservation'->>'reservedAt' = ?");
    expect(write.values).toContain('ws-test');
    expect(write.values).toContain('EI-TARGET');
    expect(write.values).toContain('grading-audit:EI-TARGET');
    expect(write.values).toContain('2026-09-20T04:02:01.600Z');
    expect(write.values).toContain(JSON.stringify(settled));
  });

  it('marks only the exact pending lease awaiting re-emit and clears its dispatch reservation', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      statements.push({ text, values });
      if (text.includes('FROM harness_shared.consult_state')) return [];
      if (text.includes('FROM harness_shared.task_ledger')) return [{ coord_owner_id: 'su-auditor' }];
      return [{ feature_id: 'EI-TARGET' }];
    }) as never;
    const transact = (async (fn: (client: never) => Promise<unknown>) => fn(tx)) as never;
    const notifySyncInvalidate = vi.fn();
    const expected = {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-09-20T04:02:01.584Z',
      rubricRevision: 7,
      criteriaHash: 'hash-v7',
      dispatchReservation: {
        key: 'grading-audit:EI-TARGET',
        reservedAt: '2026-09-20T04:02:01.600Z',
      },
    };

    await expect(
      markGradingAuditAwaitingReemit(
        'EI-TARGET',
        expected,
        {
          reason: 'evaluator revision 2 changed falsifiability from pass to unknown',
          at: '2026-09-20T04:03:00.000Z',
          responderOwnerId: 'su-auditor',
        },
        { resolveWorkspace: async () => 'ws-test', transact, notifySyncInvalidate },
      ),
    ).resolves.toBe(true);

    expect(notifySyncInvalidate).toHaveBeenCalledWith('scorecards.list');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('rubrics.trend');
    const write = statements.find((statement) => statement.text.includes('UPDATE harness_shared.work_items'))!;
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->>'state' = 'pending'");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->'dispatchReservation'->>'key' = ?");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt' = ?");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->'lastDispatchReservation'->>'key' = ?");
    expect(write.text).toContain("payload->'observation'->'gradingAudit'->'lastDispatchReservation'->>'reservedAt' = ?");
    expect(write.values).toContain('grading-audit:EI-TARGET');
    expect(write.values).toContain('2026-09-20T04:02:01.600Z');
    const stamp = write.values.find((value): value is string => typeof value === 'string' && value.includes('"awaiting-reemit"'));
    expect(stamp).toBeDefined();
    expect(JSON.parse(stamp!)).toMatchObject({
      state: 'awaiting-reemit',
      reemitRequired: {
        code: 'grading_audit_evaluator_changed',
        at: '2026-09-20T04:03:00.000Z',
        reason: 'evaluator revision 2 changed falsifiability from pass to unknown',
      },
    });
    expect(JSON.parse(stamp!)).not.toHaveProperty('dispatchReservation');

    const updateCount = statements.filter((statement) => statement.text.includes('UPDATE harness_shared.work_items')).length;
    await expect(
      settlePendingGradingAuditAtomically(
        'EI-TARGET',
        expected,
        { ...expected, state: 'awaiting-reemit' },
        { resolveWorkspace: async () => 'ws-test', transact },
      ),
    ).resolves.toBe(false);
    expect(statements.filter((statement) => statement.text.includes('UPDATE harness_shared.work_items'))).toHaveLength(updateCount);
  });

  it('refuses atomic settlement when the consult cascade has moved to another answerer', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      statements.push({ text, values });
      if (text.includes('FROM harness_shared.consult_state')) {
        return [{ answering_owner_id: 'su-current-answerer' }];
      }
      return [{ feature_id: 'EI-TARGET' }];
    }) as never;
    const transact = (async (fn: (client: never) => Promise<unknown>) => fn(tx)) as never;
    const expected = {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-09-20T04:02:01.584Z',
      dispatchReservation: { key: 'grading-audit:EI-TARGET', reservedAt: '2026-09-20T04:02:01.600Z' },
    };
    const settled = {
      state: 'passed' as const,
      metaRubricRef: expected.metaRubricRef,
      stampedAt: expected.stampedAt,
      auditIssueId: 'EI-AUDIT',
      auditor: 'su-stale-answerer',
      auditedAt: '2026-09-20T04:05:00.000Z',
    };

    await expect(
      settlePendingGradingAuditAtomically('EI-TARGET', expected, settled, {
        resolveWorkspace: async () => 'ws-test',
        transact,
      }),
    ).resolves.toBe(false);
    expect(statements[0]?.text).toContain('FOR UPDATE');
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.work_items'))).toBe(false);
  });

  it('recognizes only the current answering identity on an active source-audit consult', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    let activeRows: Array<{ answering_owner_id: string | null }> = [
      { answering_owner_id: 'su-current-answerer' },
    ];
    let taskRows: Array<{ coord_owner_id: string | null }> = [
      { coord_owner_id: 'su-fallback-auditor' },
    ];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      statements.push({ text, values });
      if (text.includes('FROM harness_shared.consult_state')) return activeRows;
      if (text.includes('FROM harness_shared.task_ledger')) return taskRows;
      return [];
    }) as never;
    const transact = (async (fn: (client: never) => Promise<unknown>) => fn(tx)) as never;
    const deps = { resolveWorkspace: async () => 'ws-test', transact };
    const reservation = { key: 'grading-audit:EI-TARGET', reservedAt: '2026-09-20T04:02:01.600Z' };

    await expect(isCurrentSourceAuditResponder('EI-TARGET', reservation, 'su-current-answerer', deps)).resolves.toBe(true);
    await expect(isCurrentSourceAuditResponder('EI-TARGET', reservation, 'su-stale-answerer', deps)).resolves.toBe(false);
    expect(statements[0]?.text).toContain("routing->'cascade'->>'reservationReservedAt' = ?");
    expect(statements[0]?.values).toEqual([
      'ws-test',
      'EI-TARGET',
      'grading-audit:EI-TARGET',
      '2026-09-20T04:02:01.600Z',
    ]);

    // A direct launch fallback has no active consult cursor. Its live task row,
    // rather than the shared lease string alone, identifies the authorized owner.
    activeRows = [];
    await expect(isCurrentSourceAuditResponder('EI-TARGET', reservation, 'su-fallback-auditor', deps)).resolves.toBe(true);
    await expect(isCurrentSourceAuditResponder('EI-TARGET', reservation, 'su-unrelated-session', deps)).resolves.toBe(false);
    expect(statements.some((statement) => statement.text.includes('FROM harness_shared.task_ledger'))).toBe(true);
    taskRows = [];
    await expect(isCurrentSourceAuditResponder('EI-TARGET', reservation, 'su-fallback-auditor', deps)).resolves.toBe(false);
  });

  it('refuses to settle after the dispatch reservation epoch changes', async () => {
    const getIssue = vi.fn(async () => ({
      payload: {
        observation: {
          rubricRef: 'spec-test-adequacy',
          ratings: { coverage: { rating: 'pass', evidence: 'verified' } },
          gradingAudit: {
            state: 'pending' as const,
            metaRubricRef: 'grading-integrity',
            stampedAt: '2026-09-23T18:00:00.000Z',
            rubricRevision: 7,
            criteriaHash: 'hash-v7',
            dispatchReservation: {
              key: 'grading-audit:EI-TARGET',
              reservedAt: '2026-09-23T18:05:00.000Z',
            },
          },
        },
      },
    }));

    const result = await recordGradingAudit(
      'EI-TARGET',
      {
        auditIssueId: 'EI-AUDIT-STALE',
        auditor: 'su-auditor',
        verdict: 'passed',
        rubricRevision: 7,
        criteriaHash: 'hash-v7',
        requireCurrentIdentity: true,
        dispatchReservation: {
          key: 'grading-audit:EI-TARGET',
          reservedAt: '2026-09-23T18:00:00.000Z',
        },
      },
      { getIssue: getIssue as never },
    );

    expect(result).toMatchObject({ ok: false, issueId: 'EI-TARGET' });
    expect((result as { error?: string }).error).toContain('dispatch reservation');
  });

  it('replaces a settled failed stamp when a validated correction uses a new audit card', async () => {
    const getIssue = vi.fn(async () => ({
      payload: {
        observation: {
          rubricRef: 'spec-test-adequacy',
          ratings: { coverage: { rating: 'pass', evidence: 'verified' } },
          gradingAudit: {
            state: 'failed' as const,
            metaRubricRef: 'grading-integrity',
            auditIssueId: 'EI-AUDIT-FALSE',
            auditor: 'su-auditor-1',
            stampedAt: '2026-09-07T00:00:00.000Z',
            auditedAt: '2026-09-07T00:01:00.000Z',
          },
        },
      },
    }));
    const replaceSettledGradingAudit = vi.fn(async () => true);
    const notifySyncInvalidate = vi.fn();

    const result = await recordGradingAudit(
      'EI-TARGET',
      {
        auditIssueId: 'EI-AUDIT-CORRECTION',
        auditor: 'su-auditor-2',
        verdict: 'passed',
        at: '2026-09-07T00:02:00.000Z',
        rubricRevision: 7,
        criteriaHash: 'grading-integrity-v7',
        requireCurrentIdentity: true,
        supersedesAuditIssueId: 'EI-AUDIT-FALSE',
      },
      {
        getIssue: getIssue as never,
        replaceSettledGradingAudit,
        notifySyncInvalidate,
      },
    );

    expect(result).toEqual({
      ok: true,
      issueId: 'EI-TARGET',
      gradingAudit: {
        state: 'passed',
        metaRubricRef: 'grading-integrity',
        rubricRevision: 7,
        criteriaHash: 'grading-integrity-v7',
        auditIssueId: 'EI-AUDIT-CORRECTION',
        auditor: 'su-auditor-2',
        stampedAt: '2026-09-07T00:00:00.000Z',
        auditedAt: '2026-09-07T00:02:00.000Z',
      },
    });
    expect(replaceSettledGradingAudit).toHaveBeenCalledWith('EI-TARGET', 'EI-AUDIT-FALSE', {
      state: 'passed',
      metaRubricRef: 'grading-integrity',
      rubricRevision: 7,
      criteriaHash: 'grading-integrity-v7',
      auditIssueId: 'EI-AUDIT-CORRECTION',
      auditor: 'su-auditor-2',
      stampedAt: '2026-09-07T00:00:00.000Z',
      auditedAt: '2026-09-07T00:02:00.000Z',
    });
    expect(notifySyncInvalidate).toHaveBeenCalledWith('scorecards.list');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('rubrics.trend');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('learning.releaseReadiness');
  });

  it('refuses a settled replacement that does not name the audit currently stamped on the target', async () => {
    const replaceSettledGradingAudit = vi.fn();
    const result = await recordGradingAudit(
      'EI-TARGET',
      {
        auditIssueId: 'EI-AUDIT-CORRECTION',
        auditor: 'su-auditor-2',
        verdict: 'passed',
        supersedesAuditIssueId: 'EI-SOME-OTHER-AUDIT',
      },
      {
        getIssue: vi.fn(async () => ({
          payload: {
            observation: {
              rubricRef: 'r',
              ratings: {},
              gradingAudit: {
                state: 'failed',
                metaRubricRef: 'grading-integrity',
                auditIssueId: 'EI-AUDIT-WINNER',
                stampedAt: '2026-09-07T00:00:00.000Z',
              },
            },
          },
        })) as never,
        replaceSettledGradingAudit,
      },
    );

    expect(result).toMatchObject({ ok: false, issueId: 'EI-TARGET' });
    expect(result.error).toContain('explicitly supersede that audit card');
    expect(replaceSettledGradingAudit).not.toHaveBeenCalled();
  });

  it('does not use explicit supersession to launder a complete stale rubric identity', async () => {
    const replaceSettledGradingAudit = vi.fn();
    const result = await recordGradingAudit(
      'EI-TARGET',
      {
        auditIssueId: 'EI-AUDIT-CORRECTION',
        auditor: 'su-auditor-2',
        verdict: 'passed',
        rubricRevision: 8,
        criteriaHash: 'grading-integrity-v8',
        requireCurrentIdentity: true,
        supersedesAuditIssueId: 'EI-AUDIT-OLD',
      },
      {
        getIssue: vi.fn(async () => ({
          payload: {
            observation: {
              rubricRef: 'r',
              ratings: {},
              gradingAudit: {
                state: 'failed',
                metaRubricRef: 'grading-integrity',
                rubricRevision: 7,
                criteriaHash: 'grading-integrity-v7',
                auditIssueId: 'EI-AUDIT-OLD',
                stampedAt: '2026-09-07T00:00:00.000Z',
              },
            },
          },
        })) as never,
        replaceSettledGradingAudit,
      },
    );

    expect(result).toMatchObject({ ok: false, issueId: 'EI-TARGET' });
    expect(result.error).toContain('stale gradingAudit stamp');
    expect(replaceSettledGradingAudit).not.toHaveBeenCalled();
  });

  it('keeps a replay of the same settled audit idempotent', async () => {
    const existing = {
      state: 'passed' as const,
      metaRubricRef: 'grading-integrity',
      auditIssueId: 'EI-AUDIT-1',
      auditor: 'su-auditor-1',
      stampedAt: '2026-09-07T00:00:00.000Z',
      auditedAt: '2026-09-07T00:01:00.000Z',
    };
    const result = await recordGradingAudit(
      'EI-TARGET',
      { auditIssueId: 'EI-AUDIT-1', auditor: 'su-auditor-2', verdict: 'failed' },
      {
        getIssue: vi.fn(async () => ({ payload: { observation: { rubricRef: 'r', ratings: {}, gradingAudit: existing } } })) as never,
      },
    );

    expect(result).toEqual({ ok: true, issueId: 'EI-TARGET', gradingAudit: existing });
  });

  it('refuses to settle a grading audit after the target was retracted', async () => {
    const result = await recordGradingAudit(
      'EI-WITHDRAWN',
      { auditIssueId: 'EI-AUDIT-LATE', auditor: 'su-auditor', verdict: 'passed' },
      {
        getIssue: vi.fn(async () => ({
          payload: {
            observation: {
              rubricRef: 'r',
              ratings: {},
              retracted: { at: '2026-09-20T04:02:52.814Z', by: 'su-author', reason: 'withdrawn' },
              gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity', stampedAt: '2026-09-20T04:02:01.584Z' },
            },
          },
        })) as never,
      },
    );

    expect(result).toMatchObject({ ok: false, issueId: 'EI-WITHDRAWN' });
    expect(result.error).toContain('retracted and cannot receive a grading-audit settlement');
  });
});

describe('grading-audit rubric identity currentness (EI-22701281083010532)', () => {
  const base = {
    state: 'passed' as const,
    metaRubricRef: 'grading-integrity',
    stampedAt: '2026-09-08T00:00:00.000Z',
    rubricRevision: 4,
    criteriaHash: 'hash-old',
  };

  it('marks an exact revision and criteria hash current', () => {
    expect(
      classifyGradingAuditCurrentness(base, {
        rubricId: 'grading-integrity',
        revision: 4,
        criteriaHash: 'hash-old',
      }),
    ).toEqual({
      state: 'current',
      reason: 'current',
      recordedRevision: 4,
      currentRevision: 4,
      recordedCriteriaHash: 'hash-old',
      currentCriteriaHash: 'hash-old',
    });
  });

  it('marks a settled stamp stale when the graded criteria change', () => {
    expect(
      classifyGradingAuditCurrentness(base, {
        rubricId: 'grading-integrity',
        revision: 6,
        criteriaHash: 'hash-new',
      }),
    ).toMatchObject({ state: 'stale', reason: 'criteria-hash-mismatch', recordedRevision: 4, currentRevision: 6 });
  });

  it('reuses a settled stamp across a revision-only edit when the criteria hash is unchanged', () => {
    expect(
      classifyGradingAuditCurrentness(base, {
        rubricId: 'grading-integrity',
        revision: 6,
        criteriaHash: 'hash-old',
      }),
    ).toMatchObject({ state: 'current', reason: 'current', recordedRevision: 4, currentRevision: 6 });
  });

  it('invalidates a same-revision stamp when a delegated criterion dependency changes', () => {
    expect(
      classifyGradingAuditCurrentness(base, {
        rubricId: 'grading-integrity',
        revision: 4,
        criteriaHash: 'hash-new',
      }),
    ).toMatchObject({ state: 'stale', reason: 'criteria-hash-mismatch' });
  });

  it('keeps missing identity unknown instead of treating historical settlement as current', () => {
    expect(
      classifyGradingAuditCurrentness({ ...base, rubricRevision: undefined, criteriaHash: undefined }, {
        rubricId: 'grading-integrity',
        revision: 6,
        criteriaHash: 'hash-new',
      }),
    ).toMatchObject({ state: 'unknown', reason: 'recorded-identity-missing' });
  });
});

describe('graded subject rubric currentness (EI-23978920367779836)', () => {
  const recorded = { rubricRef: 'acceptance-rubric', revision: 4, criteriaHash: 'old' };
  const live = { rubricId: 'acceptance-rubric', revision: 5, criteriaHash: 'new' };

  it('marks changed subject criteria stale even when the meta-rubric did not change', () => {
    expect(classifySubjectRubricCurrentness('acceptance-rubric', recorded, live)).toMatchObject({
      state: 'stale', reason: 'criteria-hash-mismatch', recordedRevision: 4, currentRevision: 5,
    });
  });

  it('keeps pre-stamp cards unknown instead of assigning a historical revision from the live rubric', () => {
    expect(classifySubjectRubricCurrentness('acceptance-rubric', undefined, live)).toMatchObject({
      state: 'unknown', reason: 'recorded-identity-missing', currentRevision: 5,
    });
  });

  it('explains currentness when BAR meaning is unchanged across a method-only edit', () => {
    expect(classifySubjectRubricCurrentness('acceptance-rubric', { ...recorded, meaningRevision: 2 }, {
      ...live, barContract: { meaningRevision: 2 },
    } as never)).toMatchObject({ state: 'current', reason: 'meaning-unchanged' });
    expect(classifySubjectRubricCurrentness('acceptance-rubric', {
      ...recorded, criteriaHash: 'same', meaningRevision: 2,
    }, {
      ...live, criteriaHash: 'same', barContract: { meaningRevision: 2 },
    } as never)).toMatchObject({ state: 'current', reason: 'current' });
  });
});

// EI-12147: the graded-generation stamp's read-side validator — a scorecard row must
// surface WHICH generation it graded, and a malformed/pre-stamp payload must degrade.
// WI-5397 widened the stamp (deployedSha/bootHeadSha/scoutCodeHash/staleHost) while
// keeping BACKWARD COMPAT with the pre-WI-5397 `{ sha, hostStartedAt }` shape.
describe('parseGradedGeneration (EI-12147, widened WI-5397)', () => {
  it('projects a complete new-shape stamp', () => {
    expect(
      parseGradedGeneration({
        deployedSha: 'abc1234',
        hostStartedAt: '2026-07-14T18:21:25.000Z',
        bootHeadSha: 'abc1234',
        scoutCodeHash: 'deadbeef',
        staleHost: false,
      }),
    ).toEqual({
      deployedSha: 'abc1234',
      hostStartedAt: '2026-07-14T18:21:25.000Z',
      bootHeadSha: 'abc1234',
      scoutCodeHash: 'deadbeef',
      staleHost: false,
    });
  });
  it('BACKWARD COMPAT: a pre-WI-5397 row storing the legacy `sha` key is read as deployedSha', () => {
    expect(parseGradedGeneration({ sha: 'abc1234', hostStartedAt: '2026-07-14T18:21:25.000Z' })).toEqual({
      deployedSha: 'abc1234',
      hostStartedAt: '2026-07-14T18:21:25.000Z',
    });
  });
  it('tolerates a half-resolved stamp (one leg null) — partial identity still discriminates', () => {
    expect(parseGradedGeneration({ deployedSha: null, hostStartedAt: '2026-07-14T18:21:25.000Z' })).toEqual({
      deployedSha: null,
      hostStartedAt: '2026-07-14T18:21:25.000Z',
    });
    expect(parseGradedGeneration({ deployedSha: 'abc1234', hostStartedAt: null })).toEqual({
      deployedSha: 'abc1234',
      hostStartedAt: null,
    });
  });
  it('preserves staleHost null as an explicitly unknown comparison', () => {
    expect(
      parseGradedGeneration({
        deployedSha: 'abc1234',
        hostStartedAt: null,
        bootHeadSha: null,
        staleHost: null,
      }),
    ).toEqual({ deployedSha: 'abc1234', hostStartedAt: null, staleHost: null });
  });
  it('an all-null/absent stamp carries no identity — null, so pre-stamp and unresolved rows read the same', () => {
    expect(parseGradedGeneration({ sha: null, hostStartedAt: null })).toBeNull();
    expect(parseGradedGeneration({})).toBeNull();
  });
  it('malformed payloads degrade to null, never throw', () => {
    expect(parseGradedGeneration(undefined)).toBeNull();
    expect(parseGradedGeneration(null)).toBeNull();
    expect(parseGradedGeneration('abc1234')).toBeNull();
    expect(parseGradedGeneration(['abc1234'])).toBeNull();
    expect(parseGradedGeneration({ sha: 42, hostStartedAt: false })).toBeNull();
  });
});

describe('scorecard generation freshness evidence plane (EI-25738206826588439)', () => {
  const makeTreeOnlyRecipe = (): SpecTestAdequacyRerunRecipe => {
    const fingerprints = Array.from({ length: 4 }, (_, index) => ({
      planSlug: 'tree-only-plan',
      specId: 'SPEC-1',
      specRevision: 3,
      specFingerprint: 'sha256:spec',
      evidenceKind: 'test/mutation',
      evidenceRef: `run:${index + 1}`,
      sourceFingerprint: `sha256:source-${index + 1}`,
      testFingerprint: `sha256:test-${index + 1}`,
      fixtureFingerprint: null,
      rubricFingerprint: null,
      environmentFingerprint: null,
    }));
    return {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      classRef: 'unit-test',
      args: {
        slug: 'tree-only-plan',
        classRef: 'unit-test',
        specIds: ['SPEC-1'],
        includeDraft: true,
        current: fingerprints,
      },
      selection: {
        planSlug: 'tree-only-plan',
        specId: 'SPEC-1',
        specRevision: 3,
        specFingerprint: 'sha256:spec',
        evidence: fingerprints.map(({ evidenceKind, evidenceRef }) => ({ evidenceKind, evidenceRef })),
      },
      current: { supplied: true, fingerprints },
      derivation: {
        kind: 'listSpecEvidence.currentness',
        classifier: 'classifySpecEvidenceCurrentness',
        unknownWhenMissing: true,
      },
    };
  };

  it('does not mark a complete matched tree-only recipe stale after the host boundary changes', () => {
    expect(
      classifyScorecardGenerationFreshness(
        '2026-07-14T00:00:00.000Z',
        makeTreeOnlyRecipe(),
        Date.parse('2026-07-15T00:00:00.000Z'),
      ),
    ).toMatchObject({ status: 'not-applicable' });
  });

  it('keeps incomplete, mismatched, and runtime-bound recipes on the live host comparison', () => {
    const treeOnly = makeTreeOnlyRecipe();
    const incomplete = structuredClone(treeOnly);
    incomplete.args.current?.pop();
    const mismatched = structuredClone(treeOnly);
    mismatched.selection.evidence[0]!.evidenceRef = 'run:wrong';
    const runtimeBound = makeTreeOnlyRecipe();
    runtimeBound.current.fingerprints[0]!.environmentFingerprint = 'sha256:environment';
    runtimeBound.args.current![0]!.environmentFingerprint = 'sha256:environment';

    for (const recipe of [undefined, incomplete, mismatched, runtimeBound]) {
      expect(
        classifyScorecardGenerationFreshness(
          '2026-07-14T00:00:00.000Z',
          recipe,
          Date.parse('2026-07-15T00:00:00.000Z'),
        ),
      ).toMatchObject({ status: 'stale' });
    }
  });
});

// WI-4607: the criterion→instrument binding is a trailing token on the model prose.
describe('parseCriterionInstrumentKey (WI-4607)', () => {
  it('prefers the structured instrumentKey over the legacy model token', () => {
    expect(parseCriterionInstrumentKey('x [instrumentKey: old]', 'new')).toBe('new');
  });
  it('parses a trailing [instrumentKey: <key>] token', () => {
    expect(parseCriterionInstrumentKey('work flows and lands [instrumentKey: placement-count]')).toBe('placement-count');
  });
  it('returns the literal "none" for an explicit no-instrument binding', () => {
    expect(parseCriterionInstrumentKey('deterministic replay [instrumentKey: none]')).toBe('none');
  });
  it('returns null when the model carries no token', () => {
    expect(parseCriterionInstrumentKey('good fresh ideas keep flowing')).toBeNull();
  });
  it('binds a dotted registered key (woe.*, goal-mode.*) in BOTH readers — the old [a-z0-9-]+ copies dropped it', () => {
    expect(parseCriterionInstrumentKey('never edits [instrumentKey: goal-mode.never-implements]')).toBe(
      'goal-mode.never-implements',
    );
    expect(effectiveCriterionInstrumentKey({ model: 'ideas land [instrumentKey: woe.ideation-yield]' })).toBe(
      'woe.ideation-yield',
    );
    // A key must still start with a letter or digit, so a stray separator does not bind.
    expect(parseCriterionInstrumentKey('x [instrumentKey: .hidden]')).toBeNull();
  });
  it('binds only a TRAILING token — a mid-prose mention does NOT bind', () => {
    expect(parseCriterionInstrumentKey('the [instrumentKey: foo] is discussed but not bound here')).toBeNull();
  });
  it('tolerates trailing whitespace after the token', () => {
    expect(parseCriterionInstrumentKey('x [instrumentKey: gate-red-count]  \n')).toBe('gate-red-count');
  });
  it('is null-safe for a missing/empty model', () => {
    expect(parseCriterionInstrumentKey(null)).toBeNull();
    expect(parseCriterionInstrumentKey(undefined)).toBeNull();
    expect(parseCriterionInstrumentKey('')).toBeNull();
  });
  it('rejects a malformed token (uppercase / spaces in the key)', () => {
    expect(parseCriterionInstrumentKey('x [instrumentKey: Not Valid]')).toBeNull();
  });
});

describe('scorecardEvidenceFingerprint (EI-12459)', () => {
  it('is stable across object/key insertion order', () => {
    const a = scorecardEvidenceFingerprint({
      rubricRef: 'r',
      ratings: {
        b: { rating: 'FAIL', evidence: 'b' },
        a: { rating: 'PASS', evidence: 'a' },
      },
      instrumentSnapshots: {
        z: { verdict: 'fail', measuredAt: '2026-07-15T00:00:00Z', value: { y: 2, x: 1 } },
      },
    });
    const b = scorecardEvidenceFingerprint({
      rubricRef: 'r',
      ratings: {
        a: { evidence: 'a', rating: 'PASS' },
        b: { evidence: 'b', rating: 'FAIL' },
      },
      instrumentSnapshots: {
        z: { measuredAt: '2026-07-15T00:00:00Z', value: { x: 1, y: 2 }, verdict: 'fail' },
      },
    });
    expect(a).toBe(b);
  });

  it('changes when evidence changes', () => {
    const before = scorecardEvidenceFingerprint({
      rubricRef: 'r',
      ratings: { a: { rating: 'PASS', evidence: 'n=1' } },
    });
    const after = scorecardEvidenceFingerprint({
      rubricRef: 'r',
      ratings: { a: { rating: 'PASS', evidence: 'n=2' } },
    });
    expect(after).not.toBe(before);
  });

  it('keeps legacy no-verdict fingerprints stable and changes identity when acceptance changes', () => {
    const ratings = { a: { rating: 'PASS', evidence: 'n=1' } };
    const legacy = scorecardEvidenceFingerprint({ rubricRef: 'r', ratings });
    const accepted = scorecardEvidenceFingerprint({
      rubricRef: 'r',
      ratings,
      acceptance: { verdict: 'accept', reasoning: 'Independent evidence is sufficient.' },
    });
    const rejected = scorecardEvidenceFingerprint({
      rubricRef: 'r',
      ratings,
      acceptance: { verdict: 'reject', reasoning: 'Independent evidence is insufficient.' },
    });
    expect(accepted).not.toBe(legacy);
    expect(rejected).not.toBe(accepted);
  });

  it('includes the optional spec-test-adequacy rerun recipe while preserving legacy hashes when absent', () => {
    const ratings = { a: { rating: 'PASS', evidence: 'n=1' } };
    const recipe = {
      schemaVersion: 1 as const,
      evaluator: 'plans:evaluate-spec-test-adequacy' as const,
      evaluatorRevision: 12,
      evaluatorBuild: { sha: 'build-a', version: '0.0.0' },
      classRef: 'plan-class-feature-ship',
      args: {
        slug: 'p',
        classRef: 'plan-class-feature-ship',
        evaluatorBuild: { sha: 'build-a', version: '0.0.0' },
        specIds: ['s'],
        includeDraft: true as const,
      },
      selection: {
        planSlug: 'p',
        specId: 's',
        specRevision: 1,
        specFingerprint: 'spec-fingerprint',
        evidence: [{ evidenceKind: 'test', evidenceRef: 'test:1' }],
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness' as const,
        classifier: 'classifySpecEvidenceCurrentness' as const,
        unknownWhenMissing: true as const,
      },
    };
    const legacy = scorecardEvidenceFingerprint({ rubricRef: 'r', ratings });
    const withRecipe = scorecardEvidenceFingerprint({ rubricRef: 'r', ratings, rerunRecipe: recipe });
    expect(withRecipe).not.toBe(legacy);
    expect(scorecardEvidenceFingerprint({ rubricRef: 'r', ratings, rerunRecipe: recipe })).toBe(withRecipe);

    const nextBuildRecipe = {
      ...recipe,
      evaluatorBuild: { sha: 'build-b', version: '0.0.0' },
      args: { ...recipe.args, evaluatorBuild: { sha: 'build-b', version: '0.0.0' } },
    };
    expect(scorecardEvidenceFingerprint({ rubricRef: 'r', ratings, rerunRecipe: nextBuildRecipe })).toBe(withRecipe);
    expect(scorecardEvidenceFingerprint({
      rubricRef: 'r', ratings, rerunRecipe: { ...nextBuildRecipe, evaluatorRevision: 13 },
    })).not.toBe(withRecipe);
  });

  it('includes testedSha in release evidence identity while preserving legacy hashes when absent', () => {
    const ratings = { a: { rating: 'PASS', evidence: 'same drill output' } };
    const legacy = scorecardEvidenceFingerprint({ rubricRef: 'r', ratings });
    const atA = scorecardEvidenceFingerprint({ rubricRef: 'r', ratings, testedSha: 'aaaaaaa111111' });
    const atB = scorecardEvidenceFingerprint({ rubricRef: 'r', ratings, testedSha: 'bbbbbbb222222' });

    expect(atA).not.toBe(legacy);
    expect(atB).not.toBe(atA);
    expect(scorecardEvidenceFingerprint({ rubricRef: 'r', ratings, testedSha: 'aaaaaaa111111' })).toBe(atA);
  });
});

describe('evaluateScorecardReleaseGateBinding (EI-18706603928993591)', () => {
  const snapshot = (over: Record<string, unknown> = {}): ScorecardReleaseGateSnapshot => ({
    generatedAtMs: Date.parse('2026-09-04T16:00:00.000Z'),
    gate: {
      countersUnknown: null,
      recordedVerdict: 'green' as const,
      verdictStale: false,
      verdictStaleReason: null,
      fireStale: false,
      fireStaleReason: null,
      consecutiveNoVerdict: 0,
      inconclusive: null,
      observedCandidate: 'abcdef123456',
      failingTests: [],
      ...((over.gate as Record<string, unknown> | undefined) ?? {}),
    },
    deploy: {
      greenPin: { sha: 'abcdef1234567890' },
      stagingHead: { sha: 'abcdef1234567890' },
      greenPinBehindStaging: 0,
      ...((over.deploy as Record<string, unknown> | undefined) ?? {}),
    },
  }) as ScorecardReleaseGateSnapshot;

  it('binds a short tested SHA only when the same commit is green, current, and at staging HEAD', () => {
    expect(
      evaluateScorecardReleaseGateBinding({
        testedSha: 'abcdef1',
        snapshot: snapshot(),
      }),
    ).toMatchObject({
      status: 'bound',
      testedSha: 'abcdef1',
      gateVerdict: 'green',
      gateCandidate: 'abcdef123456',
      lastGreenCommit: 'abcdef1234567890',
      stagingHead: 'abcdef1234567890',
      commitsBehindHead: 0,
    });
  });

  it('returns the stale-pass sentinel with the gate red reason and failing tests', () => {
    expect(
      evaluateScorecardReleaseGateBinding({
        testedSha: 'abcdef1',
        snapshot: snapshot({
          gate: { recordedVerdict: 'not-green', failingTests: ['lint:tsc'] },
          deploy: { greenPinBehindStaging: 23 },
        }),
      }),
    ).toMatchObject({
      status: 'stale-pass-blocked',
      reasonCode: 'gate-not-green',
      commitsBehindHead: 23,
      failingTests: ['lint:tsc'],
      reason: expect.stringContaining('lint:tsc'),
    });
  });

  it('blocks a green-tested commit once staging HEAD advances beyond it', () => {
    expect(
      evaluateScorecardReleaseGateBinding({
        testedSha: 'abcdef1',
        snapshot: snapshot({
          deploy: {
            greenPin: { sha: 'abcdef1234567890' },
            stagingHead: { sha: '9999999fedcba' },
            greenPinBehindStaging: 4,
          },
        }),
      }),
    ).toMatchObject({
      status: 'stale-pass-blocked',
      reasonCode: 'tested-sha-behind-head',
      commitsBehindHead: 4,
    });
  });

  it('blocks missing SHA bindings and no-verdict gate runs instead of trusting an older green', () => {
    expect(
      evaluateScorecardReleaseGateBinding({ testedSha: null, snapshot: snapshot() }),
    ).toMatchObject({ status: 'stale-pass-blocked', reasonCode: 'tested-sha-required' });

    expect(
      evaluateScorecardReleaseGateBinding({
        testedSha: 'abcdef1',
        snapshot: snapshot({ gate: { consecutiveNoVerdict: 2 } }),
      }),
    ).toMatchObject({ status: 'stale-pass-blocked', reasonCode: 'gate-no-verdict' });
  });

  it('blocks an unmeasured gate even when its compatibility fields look green', () => {
    expect(
      evaluateScorecardReleaseGateBinding({
        testedSha: 'abcdef1',
        snapshot: snapshot({
          gate: {
            countersUnknown: { status: 'unknown', reason: 'not-measured' },
            recordedVerdict: 'green',
          },
        }),
      }),
    ).toMatchObject({ status: 'stale-pass-blocked', reasonCode: 'gate-counters-unknown' });
  });
});

describe('evaluateScorecardInstrumentContract (rubric/instrument contract)', () => {
  const rubric = (over: Partial<Rubric> = {}): Rubric => ({
    gradingAuthority: 'independent',
    rubricId: 'release-r',
    workspaceId: 'default',
    kind: 'standard',
    characteristic: 'release',
    title: 'Release',
    description: '',
    criteria: [
      {
        key: 'cycle',
        title: 'Cycle',
        model: 'm',
        method: 'method',
        driftMarkers: 'bad',
        instrumentKey: 'metrics.cycle',
        window: { kind: 'rolling', ms: 60_000 },
      },
    ],
    ratingScale: ['PASS', 'FAIL', 'UNKNOWN'],
    methodRef: 'runbook',
    releaseGating: true,
    status: 'active',
    createdBy: 'su-1',
    proposedBy: 'su-1',
    ratifiedBy: 'su-2',
    createdAt: '2026-07-15T00:00:00Z',
    updatedAt: '2026-07-15T00:00:00Z',
    ...over,
  });

  it('passes exact, fresh, verdict-consistent snapshots', () => {
    const out = evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: { cycle: { rating: 'PASS', evidence: '0/10 errors' } },
      instrumentSnapshots: {
        'metrics.cycle': { verdict: 'pass', measuredAt: '2026-07-15T00:00:30Z' },
      },
      nowMs: Date.parse('2026-07-15T00:01:00Z'),
    });
    expect(out.valid).toBe(true);
  });

  it('fails loudly on missing, stale, extra, and verdict-mismatched snapshots', () => {
    const missing = evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: { cycle: { rating: 'PASS', evidence: 'e' } },
      nowMs: Date.parse('2026-07-15T00:02:00Z'),
    });
    expect(missing.valid).toBe(false);
    expect(missing.missingSnapshots).toEqual(['metrics.cycle']);
    expect(missing.positiveClaimsWithoutSnapshots).toEqual(['metrics.cycle']);

    const bad = evaluateScorecardInstrumentContract({
      rubric: rubric(),
      ratings: { cycle: { rating: 'PASS', evidence: 'e' } },
      instrumentSnapshots: {
        'metrics.cycle': { verdict: 'fail', measuredAt: '2026-07-15T00:00:00Z' },
        extra: { verdict: 'pass', measuredAt: '2026-07-15T00:01:59Z' },
      },
      nowMs: Date.parse('2026-07-15T00:02:00Z'),
    });
    expect(bad.valid).toBe(false);
    expect(bad.staleSnapshots).toEqual(['metrics.cycle']);
    expect(bad.extraSnapshots).toEqual(['extra']);
    expect(bad.verdictMismatches).toEqual(['metrics.cycle']);
  });

  it('identifies unsupported positive ratings on non-release-gating instrument bindings', () => {
    const nonRelease = rubric({ releaseGating: false });
    const positive = evaluateScorecardInstrumentContract({
      rubric: nonRelease,
      ratings: { cycle: { rating: 'healthy', evidence: 'The report looks healthy.' } },
      nowMs: Date.parse('2026-07-15T00:01:00Z'),
    });
    expect(positive.valid).toBe(false);
    expect(positive.positiveClaimsWithoutSnapshots).toEqual(['metrics.cycle']);

    const negative = evaluateScorecardInstrumentContract({
      rubric: nonRelease,
      ratings: { cycle: { rating: 'fail', evidence: 'The report shows a failure.' } },
      nowMs: Date.parse('2026-07-15T00:01:00Z'),
    });
    expect(negative.positiveClaimsWithoutSnapshots).toEqual([]);
  });

  it('pins post-watermark snapshots to the declared watermark', () => {
    const post = rubric({
      criteria: [
        {
          key: 'cycle',
          title: 'Cycle',
          model: 'm',
          method: 'method',
          driftMarkers: 'bad',
          instrumentKey: 'metrics.cycle',
          window: { kind: 'post-watermark', watermarkRef: 'bg-host-restart' },
        },
      ],
    });
    const out = evaluateScorecardInstrumentContract({
      rubric: post,
      ratings: { cycle: { rating: 'PASS', evidence: 'e' } },
      instrumentSnapshots: {
        'metrics.cycle': {
          verdict: 'pass',
          measuredAt: '2026-07-15T00:02:00Z',
          window: { watermarkRef: 'wrong', sinceMs: Date.parse('2026-07-15T00:00:00Z') },
        },
      },
    });
    expect(out.valid).toBe(false);
    expect(out.windowMismatches).toEqual(['metrics.cycle']);
  });

  it('fails closed when a persisted rolling window is missing its duration', () => {
    const malformed = rubric({
      criteria: [
        {
          key: 'cycle',
          title: 'Cycle',
          model: 'm',
          method: 'method',
          driftMarkers: 'bad',
          instrumentKey: 'metrics.cycle',
          window: { kind: 'rolling' },
        },
      ],
    });
    const out = evaluateScorecardInstrumentContract({
      rubric: malformed,
      ratings: { cycle: { rating: 'PASS', evidence: 'e' } },
      instrumentSnapshots: {
        'metrics.cycle': { verdict: 'pass', measuredAt: '2026-07-15T00:00:30Z' },
      },
      nowMs: Date.parse('2026-07-15T00:01:00Z'),
    });
    expect(out.valid).toBe(false);
    expect(out.windowMismatches).toEqual(['metrics.cycle']);
  });
});

const s = (...ratings: string[]) => ratings.map((rating, i) => ({ at: `2026-06-20T0${i}:00:00.000Z`, rating }));

/** Build a minimal CriterionTrend from a rating list (only the fields staleness reads).
 *  `idleCount` = how many of the 'unknown' ratings are idle-tagged (EI-7624). */
const crit = (criterion: string, ...ratings: string[]): CriterionTrend => critIdle(criterion, 0, ...ratings);
const critIdle = (criterion: string, idleCount: number, ...ratings: string[]): CriterionTrend => {
  const distribution: Record<string, number> = {};
  for (const r of ratings) distribution[r] = (distribution[r] ?? 0) + 1;
  return {
    criterion,
    count: ratings.length,
    distribution,
    idleCount,
    notAssessedCount: 0,
    unknownReasons: {},
    first: { rating: ratings[0] ?? 'unknown', at: '2026-06-20T00:00:00.000Z' },
    latest: { rating: ratings[ratings.length - 1] ?? 'unknown', at: '2026-06-20T01:00:00.000Z' },
    direction: 'unknown',
    // CriterionTrend gained a required scale-aware mean; these direction fixtures do not read it.
    mean10: null,
  };
};

describe('computeTrendDirection (P-010)', () => {
  it('worsening — severity rises first→latest', () => {
    expect(computeTrendDirection(s('healthy', 'degraded', 'broken'))).toBe('worsening');
    expect(computeTrendDirection(s('healthy', 'broken'))).toBe('worsening');
    expect(computeTrendDirection(s('degraded', 'broken'))).toBe('worsening');
  });

  it('improving — severity falls first→latest', () => {
    expect(computeTrendDirection(s('broken', 'degraded', 'healthy'))).toBe('improving');
    expect(computeTrendDirection(s('broken', 'healthy'))).toBe('improving');
  });

  it('stable — first and latest assessable ratings are equal (incl. a dip that recovers)', () => {
    expect(computeTrendDirection(s('healthy', 'healthy'))).toBe('stable');
    expect(computeTrendDirection(s('degraded', 'broken', 'degraded'))).toBe('stable'); // net first→latest only
  });

  it('unknown — fewer than 2 ASSESSABLE points', () => {
    expect(computeTrendDirection(s())).toBe('unknown'); // empty
    expect(computeTrendDirection(s('healthy'))).toBe('unknown'); // single point
    expect(computeTrendDirection(s('unknown', 'unknown'))).toBe('unknown'); // no assessable
    expect(computeTrendDirection(s('unknown', 'broken'))).toBe('unknown'); // only 1 assessable
  });

  it('excludes unknown + custom ratings from the calc (orders only the default scale)', () => {
    // unknown in the middle is skipped: assessable = [healthy(0), broken(2)] → worsening.
    expect(computeTrendDirection(s('healthy', 'unknown', 'broken'))).toBe('worsening');
    // a custom (non-default) rating is unassessable, like unknown.
    expect(computeTrendDirection(s('degraded', 'flapping', 'healthy'))).toBe('improving'); // [1, 0]
    expect(computeTrendDirection(s('custom-a', 'custom-b'))).toBe('unknown'); // none orderable
  });

  it('is case-insensitive on the rating vocabulary', () => {
    expect(computeTrendDirection(s('HEALTHY', 'Broken'))).toBe('worsening');
  });
});

describe('computeRubricStaleness (P-011)', () => {
  it('flags a criterion persistently rated unknown (model drifted)', () => {
    const r = computeRubricStaleness([crit('placement-health', 'unknown', 'unknown', 'unknown')]);
    expect(r.stale).toBe(true);
    expect(r.staleCriteria).toHaveLength(1);
    expect(r.staleCriteria[0].criterion).toBe('placement-health');
    expect(r.staleCriteria[0].staleFraction).toBe(1);
    expect(r.staleCriteria[0].samples).toBe(3);
    expect(r.reason).toMatch(/placement-health/);
  });

  it('does NOT flag a criterion being assessed (healthy/degraded/broken)', () => {
    const r = computeRubricStaleness([crit('end-to-end-flow', 'healthy', 'degraded', 'broken')]);
    expect(r.stale).toBe(false);
    expect(r.staleCriteria).toEqual([]);
    expect(r.reason).toMatch(/no staleness/);
  });

  it('does NOT flag persistent broken (a real system finding, not a stale rubric)', () => {
    // The default staleRatings is ['unknown'] only — persistent 'broken' is the
    // trend's worsening/broken signal, not staleness.
    const r = computeRubricStaleness([crit('watchdog-determinism', 'broken', 'broken', 'broken', 'broken')]);
    expect(r.stale).toBe(false);
  });

  it('needs ≥ minSamples (default 3) before judging — too few unknowns is quiet, not stale', () => {
    expect(computeRubricStaleness([crit('c', 'unknown', 'unknown')]).stale).toBe(false); // 2 < 3
    expect(computeRubricStaleness([crit('c', 'unknown', 'unknown')], { minSamples: 2 }).stale).toBe(true);
  });

  // A NEVER-GRADED rubric used to return the reassuring "criteria are being assessed"
  // — byte-identical to a well-assessed one. Measured on the live store: 13-scorecard
  // `autoloop-release-readiness` and 0-scorecard `cup-lifecycle-durability` produced the
  // same staleness block. An agent standing up new success criteria reads this to decide
  // whether its grading rails are live, so the false-clean is load-bearing.
  it('does NOT report a never-graded rubric as clean — assessed:false, and the reason says UNKNOWN', () => {
    const r = computeRubricStaleness([]);
    expect(r.stale).toBe(false); // nothing was flagged...
    expect(r.assessed).toBe(false); // ...but nothing was JUDGED either
    expect(r.judgedCriteria).toBe(0);
    expect(r.reason).toMatch(/UNKNOWN, not clean/);
    expect(r.reason).toMatch(/never been graded/);
    // The regression control: it must NOT claim assessment is happening.
    expect(r.reason).not.toMatch(/criteria are being assessed/);
  });

  it('distinguishes never-graded from genuinely-assessed (they must not render alike)', () => {
    const neverGraded = computeRubricStaleness([]);
    const assessed = computeRubricStaleness([crit('end-to-end-flow', 'healthy', 'degraded', 'broken')]);
    // Both are stale:false — that is exactly why `stale` alone cannot be trusted.
    expect(neverGraded.stale).toBe(assessed.stale);
    // The new fields are what separate them.
    expect(neverGraded.assessed).toBe(false);
    expect(assessed.assessed).toBe(true);
    expect(assessed.judgedCriteria).toBe(1);
    expect(neverGraded.reason).not.toBe(assessed.reason);
  });

  it('treats "every criterion below minSamples" as UNKNOWN too, not clean', () => {
    // 2 unknowns < minSamples 3 → nothing judgeable, so this is not a clean bill either.
    const r = computeRubricStaleness([crit('c', 'unknown', 'unknown')]);
    expect(r.stale).toBe(false);
    expect(r.assessed).toBe(false);
    expect(r.judgedCriteria).toBe(0);
    expect(r.reason).toMatch(/UNKNOWN, not clean/);
  });

  it('counts only the criteria it could actually judge', () => {
    const r = computeRubricStaleness([
      crit('judged-a', 'healthy', 'degraded', 'broken'), // 3 samples → judged
      crit('too-quiet', 'healthy'), // 1 sample → not judged
    ]);
    expect(r.assessed).toBe(true);
    expect(r.judgedCriteria).toBe(1);
  });

  it('flags at/above the staleFraction threshold (default 0.5)', () => {
    // 2/4 unknown = 0.5 → stale (>= threshold).
    expect(computeRubricStaleness([crit('c', 'unknown', 'unknown', 'healthy', 'degraded')]).stale).toBe(true);
    // 1/4 unknown = 0.25 → not stale.
    expect(computeRubricStaleness([crit('c', 'unknown', 'healthy', 'degraded', 'broken')]).stale).toBe(false);
  });

  it('reports only the stale criteria across a mixed rubric', () => {
    const r = computeRubricStaleness([
      crit('fresh', 'healthy', 'degraded', 'healthy'),
      crit('drifted', 'unknown', 'unknown', 'unknown'),
      crit('also-fresh', 'broken', 'degraded', 'broken'),
    ]);
    expect(r.stale).toBe(true);
    expect(r.staleCriteria.map((c) => c.criterion)).toEqual(['drifted']);
  });

  it('is case-insensitive on the stale rating, and honors a custom staleRatings set', () => {
    expect(computeRubricStaleness([crit('c', 'UNKNOWN', 'Unknown', 'unknown')]).stale).toBe(true);
    // widen to also treat 'broken' as stale evidence (D-004's broader signal).
    const r = computeRubricStaleness([crit('c', 'broken', 'broken', 'unknown')], { staleRatings: ['unknown', 'broken'] });
    expect(r.stale).toBe(true);
    expect(r.staleCriteria[0].staleFraction).toBe(1);
  });

  it('empty criteria → not stale', () => {
    const r = computeRubricStaleness([]);
    expect(r.stale).toBe(false);
    expect(r.staleCriteria).toEqual([]);
  });

  // EI-7624: idle-tagged unknowns ("the stage did not run") are no-signal, not
  // drift-signal — excluded from BOTH sides of the fraction.
  describe('idle-tagged unknowns (EI-7624)', () => {
    it('a mostly-idle window does not manufacture staleness', () => {
      // 9 idle-unknowns + 3 healthy: pre-fix 9/12 = stale; post-fix 0/3 → fresh.
      const c = critIdle('bee-execution', 9, ...Array(9).fill('unknown'), 'healthy', 'healthy', 'healthy');
      expect(computeRubricStaleness([c]).stale).toBe(false);
    });

    it('idle exclusion does not dilute a real drift signal in the non-idle samples', () => {
      // 9 idle-unknowns + 3 bare-unknowns + 1 healthy: the non-idle base is 4,
      // of which 3 are unassessable → 0.75 ≥ 0.5 → stale.
      const c = critIdle('drifted', 9, ...Array(12).fill('unknown'), 'healthy');
      const r = computeRubricStaleness([c]);
      expect(r.stale).toBe(true);
      expect(r.staleCriteria[0].samples).toBe(4);
      expect(r.staleCriteria[0].staleFraction).toBe(0.75);
      expect(r.staleCriteria[0].idleExcluded).toBe(9);
      expect(r.staleCriteria[0].reason).toMatch(/9 idle-tagged excluded/);
    });

    it('idle exclusion applies to the minSamples gate (all-idle window → quiet, not stale)', () => {
      const c = critIdle('paused-stage', 5, ...Array(5).fill('unknown'));
      expect(computeRubricStaleness([c]).stale).toBe(false); // 0 non-idle samples < 3
    });

    it('idleExcluded is 0 and the reason unchanged when nothing was idle-tagged', () => {
      const r = computeRubricStaleness([crit('c', 'unknown', 'unknown', 'unknown')]);
      expect(r.staleCriteria[0].idleExcluded).toBe(0);
      expect(r.staleCriteria[0].reason).not.toMatch(/idle-tagged excluded/);
    });

    it('idleCount is ignored when unknown is not in the staleRatings set', () => {
      // staleRatings ['broken']: idle-unknowns are irrelevant to that calc.
      const c = critIdle('c', 2, 'unknown', 'unknown', 'broken', 'broken', 'broken');
      const r = computeRubricStaleness([c], { staleRatings: ['broken'] });
      expect(r.stale).toBe(true);
      expect(r.staleCriteria[0].samples).toBe(5); // no idle exclusion
      expect(r.staleCriteria[0].staleFraction).toBe(0.6);
    });
  });
});

describe('compressSeries (WI-2943)', () => {
  const at = (i: number) => `2026-06-20T${String(i).padStart(2, '0')}:00:00.000Z`;

  it('empty → no runs', () => {
    expect(compressSeries([])).toEqual([]);
  });

  it('a single rating is one run of 1', () => {
    expect(compressSeries([{ at: at(0), rating: 'healthy' }])).toEqual([
      { rating: 'healthy', from: at(0), to: at(0), n: 1 },
    ]);
  });

  it('collapses consecutive identical ratings into runs with from/to/n', () => {
    const series = [
      { at: at(0), rating: 'unknown' },
      { at: at(1), rating: 'unknown' },
      { at: at(2), rating: 'unknown' },
      { at: at(3), rating: 'healthy' },
      { at: at(4), rating: 'unknown' },
    ];
    expect(compressSeries(series)).toEqual([
      { rating: 'unknown', from: at(0), to: at(2), n: 3 },
      { rating: 'healthy', from: at(3), to: at(3), n: 1 },
      { rating: 'unknown', from: at(4), to: at(4), n: 1 },
    ]);
  });

  it('preserves the total count across runs (lossless on n)', () => {
    const ratings = ['a', 'a', 'b', 'a', 'c', 'c', 'c', 'b'];
    const series = ratings.map((rating, i) => ({ at: at(i), rating }));
    const runs = compressSeries(series);
    expect(runs.reduce((n, r) => n + r.n, 0)).toBe(ratings.length);
  });
});

describe('numeric 0–10 read-time projection (rubrics-tab-scorecard-ui P-004 / D-001)', () => {
  it('ratingScore10 maps both shared vocabularies; unknown/custom → null', () => {
    expect(ratingScore10('pass')).toBe(10);
    expect(ratingScore10('Partial')).toBe(5); // case-insensitive
    expect(ratingScore10('weak')).toBe(5);
    expect(ratingScore10('fail')).toBe(0);
    expect(ratingScore10('healthy')).toBe(10);
    expect(ratingScore10('degraded')).toBe(5);
    expect(ratingScore10('broken')).toBe(0);
    expect(ratingScore10('unknown')).toBeNull();
    expect(ratingScore10('some-custom-rating')).toBeNull();
  });

  it('ratingScore10 honors per-rubric overrides without mutating the default', () => {
    expect(ratingScore10('partial', { partial: 7 })).toBe(7);
    expect(ratingScore10('partial')).toBe(5); // default untouched
    expect(ratingScore10('custom-tier', { 'custom-tier': 3 })).toBe(3);
  });

  it('scorecardScore10 is the mean over MAPPABLE ratings only (unknown excluded, never 0)', () => {
    const score = scorecardScore10({
      a: { rating: 'pass' }, // 10
      b: { rating: 'partial' }, // 5
      c: { rating: 'fail' }, // 0
      d: { rating: 'unknown' }, // excluded
    });
    expect(score).toBe(5); // (10+5+0)/3, NOT /4
  });

  it('counts weak-rated criteria at the midpoint instead of excluding them from the mean', () => {
    const score = scorecardScore10({
      pass1: { rating: 'pass' },
      pass2: { rating: 'pass' },
      pass3: { rating: 'pass' },
      pass4: { rating: 'pass' },
      weak1: { rating: 'weak' },
      weak2: { rating: 'weak' },
    });
    expect(score).toBe(8.3); // (4×10 + 2×5) / 6
  });

  it('scorecardScore10 rounds to 1 decimal and is null for an all-unknown scorecard', () => {
    expect(scorecardScore10({ a: { rating: 'pass' }, b: { rating: 'pass' }, c: { rating: 'partial' } })).toBe(8.3);
    expect(scorecardScore10({ a: { rating: 'unknown' }, b: { rating: 'unknown' } })).toBeNull();
    expect(scorecardScore10({})).toBeNull();
  });

  it('computeTrendDirection now orders the pass vocabulary (was silently unknown pre-P-004)', () => {
    expect(computeTrendDirection(s('pass', 'fail'))).toBe('worsening');
    expect(computeTrendDirection(s('fail', 'partial', 'pass'))).toBe('improving');
    expect(computeTrendDirection(s('pass', 'pass'))).toBe('stable');
    // mixed-vocabulary series still works (both are ordinal 0..2)
    expect(computeTrendDirection(s('healthy', 'fail'))).toBe('worsening');
  });
});

describe('extended 5-level scale (exemplary / pass / partial / fail / severe)', () => {
  it('default map: extended words are additive — pass/fail unchanged for 3-level rubrics', () => {
    expect(ratingScore10('exemplary')).toBe(10);
    expect(ratingScore10('severe')).toBe(0);
    expect(ratingScore10('pass')).toBe(10); // 3-level ceiling stays 10
    expect(ratingScore10('fail')).toBe(0);
  });

  it('scoreOverridesForScale: extended vocabulary → mid-level re-map; plain scale → undefined', () => {
    expect(scoreOverridesForScale(['pass', 'partial', 'fail', 'unknown'])).toBeUndefined();
    expect(scoreOverridesForScale(['healthy', 'degraded', 'broken'])).toBeUndefined();
    expect(scoreOverridesForScale(null)).toBeUndefined();
    expect(scoreOverridesForScale([])).toBeUndefined();
    const ov = scoreOverridesForScale(['exemplary', 'pass', 'partial', 'fail', 'severe', 'unknown']);
    expect(ov).toEqual({ pass: 8, fail: 2 });
    // case-insensitive detection
    expect(scoreOverridesForScale(['Exemplary', 'Pass', 'Fail'])).toEqual({ pass: 8, fail: 2 });
  });

  it('five levels spread monotonically under the extended overrides', () => {
    const ov = scoreOverridesForScale(['exemplary', 'pass', 'partial', 'fail', 'severe'])!;
    expect(ratingScore10('exemplary', ov)).toBe(10);
    expect(ratingScore10('pass', ov)).toBe(8);
    expect(ratingScore10('partial', ov)).toBe(5);
    expect(ratingScore10('fail', ov)).toBe(2);
    expect(ratingScore10('severe', ov)).toBe(0);
    expect(ratingScore10('unknown', ov)).toBeNull(); // still excluded
  });

  it('scorecardScore10 means over the extended scale', () => {
    const ov = scoreOverridesForScale(['exemplary', 'pass', 'partial', 'fail', 'severe'])!;
    // (10 + 8 + 2) / 3 = 6.7
    expect(
      scorecardScore10(
        { a: { rating: 'exemplary' }, b: { rating: 'pass' }, c: { rating: 'fail' }, d: { rating: 'unknown' } },
        ov,
      ),
    ).toBe(6.7);
  });

  it('computeTrendDirection orders the extended endpoints (exemplary best, severe worst)', () => {
    expect(computeTrendDirection(s('pass', 'exemplary'))).toBe('improving');
    expect(computeTrendDirection(s('exemplary', 'pass'))).toBe('worsening');
    expect(computeTrendDirection(s('fail', 'severe'))).toBe('worsening');
    expect(computeTrendDirection(s('severe', 'partial', 'pass'))).toBe('improving');
  });
});

describe('isIdleUnknown — read-time idle normalization (rubric-system-improvements P-001)', () => {
  it("canonical 'idle:' prefix on an unknown is idle", () => {
    expect(isIdleUnknown('unknown', 'idle: no loop wake this window')).toBe(true);
    expect(isIdleUnknown('unknown', '  IDLE : frozen hive')).toBe(true);
  });

  it('common not-run phrasings normalize to idle (fixes already-filed scorecards retroactively)', () => {
    expect(isIdleUnknown('unknown', 'Not exercised — no routing decision points in a single-fixture drill.')).toBe(true);
    expect(isIdleUnknown('unknown', 'not applicable — member, not leader')).toBe(true);
    expect(isIdleUnknown('unknown', 'Not assessable from tool_invocations timestamps alone.')).toBe(true);
    expect(isIdleUnknown('unknown', 'n/a — this drill has no code edits')).toBe(true);
    expect(isIdleUnknown('unknown', 'Not observed during the window.')).toBe(true);
  });

  it("a bare can't-assess unknown stays NON-idle — it is the drift signal staleness needs", () => {
    expect(isIdleUnknown('unknown', 'the criterion model no longer matches how dispatch works')).toBe(false);
    expect(isIdleUnknown('unknown', '')).toBe(false);
    expect(isIdleUnknown('unknown', undefined)).toBe(false);
  });

  it('never idle for a non-unknown rating, whatever the evidence says', () => {
    expect(isIdleUnknown('pass', 'idle: whatever')).toBe(false);
    expect(isIdleUnknown('degraded', 'not exercised')).toBe(false);
  });

  it('phrasing must LEAD the evidence — a mid-sentence mention is not idle', () => {
    expect(isIdleUnknown('unknown', 'the drill ran but evidence was not applicable to this criterion')).toBe(false);
  });
});
