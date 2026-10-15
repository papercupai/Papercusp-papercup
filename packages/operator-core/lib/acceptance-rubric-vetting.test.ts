import { describe, expect, it } from 'vitest';
import type { Rubric } from './rubrics';
import type { ScorecardRow } from './scorecards';
import { getAcceptanceRubricVettingStatus } from './acceptance-rubric-vetting';

const rubric = {
  rubricId: 'acceptance-plan',
  revision: 4,
  criteriaHash: 'hash-current',
  workspaceId: 'ws-test',
  kind: 'acceptance',
  characteristic: 'plan',
  title: 'Acceptance plan',
  description: '',
  criteria: [{ key: 'criterion', title: 'Criterion', model: 'observable' }],
  ratingScale: ['pass', 'fail'],
  methodRef: null,
} as Rubric;

function card(over: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'EI-vetting',
    createdAt: '2026-09-08T00:00:00.000Z',
    createdBy: 'su-author',
    rubricRef: 'meta-acceptance-rubric',
    ratings: { criterion: { rating: 'pass', evidence: 'reviewed' } },
    nKeys: 1,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    linkedItems: [],
    vetting: { consultId: 'consult-vetting', rubricRevision: 4, criteriaHash: 'hash-current' },
    ...over,
  } as ScorecardRow;
}

function deps(cards: ScorecardRow[]) {
  return {
    vettingGateEnabled: true,
    getRubric: async () => ({ ...rubric, rubricId: 'meta-acceptance-rubric', kind: 'standard' }) as Rubric,
    getRubricPlanRevision: async () => 4,
    listScorecards: async () => cards,
  };
}

describe('getAcceptanceRubricVettingStatus grading-audit admission', () => {
  it.each([
    ['pending', false],
    ['failed', false],
    ['passed', true],
  ] as const)('counts a stamped meta-scorecard only when its audit is %s', async (state, satisfied) => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([
        card({
          gradingAudit: {
            state,
            metaRubricRef: 'grading-integrity',
            stampedAt: '2026-09-08T00:01:00.000Z',
          },
        }),
      ]),
    );

    expect(result.satisfied).toBe(satisfied);
    expect(result.state).toBe(satisfied ? 'vetted' : 'unvetted');
  });

  it('preserves pre-P-013 compatibility for a complete unstamped attestation', async () => {
    await expect(getAcceptanceRubricVettingStatus(rubric, deps([card()]))).resolves.toMatchObject({
      required: true,
      satisfied: true,
      state: 'vetted',
      reason: 'current',
      attestedRevision: 4,
    });
  });

  it('reuses unchanged vetting across a revision-only rubric edit', async () => {
    await expect(
      getAcceptanceRubricVettingStatus(
        { ...rubric, revision: 6 },
        { ...deps([card()]), getRubricPlanRevision: async () => 6 },
      ),
    ).resolves.toMatchObject({
      satisfied: true,
      state: 'vetted',
      reason: 'current',
      currentRevision: 6,
      attestedRevision: 4,
      currentCriteriaHash: 'hash-current',
      attestedCriteriaHash: 'hash-current',
    });
  });

  it('reuses vetting across method-only changes when the BAR meaning epoch is unchanged', async () => {
    const live = {
      ...rubric,
      revision: 6,
      criteriaHash: 'hash-after-method-edit',
      barContract: { meaningRevision: 2 },
    } as Rubric;
    await expect(
      getAcceptanceRubricVettingStatus(
        live,
        {
          ...deps([
            card({
              vetting: {
                consultId: 'consult-vetting',
                rubricRevision: 4,
                criteriaHash: 'hash-before-method-edit',
                rubricMeaningRevision: 2,
              },
            }),
          ]),
          getRubricPlanRevision: async () => 6,
        },
      ),
    ).resolves.toMatchObject({ satisfied: true, state: 'vetted', reason: 'current' });
  });

  it('stales vetting when the BAR meaning epoch changes even if the hash matches', async () => {
    const live = {
      ...rubric,
      barContract: { meaningRevision: 5 },
    } as Rubric;
    await expect(
      getAcceptanceRubricVettingStatus(
        live,
        deps([
          card({
            vetting: {
              consultId: 'consult-vetting',
              rubricRevision: 4,
              criteriaHash: 'hash-current',
              rubricMeaningRevision: 4,
            },
          }),
        ]),
      ),
    ).resolves.toMatchObject({ satisfied: false, state: 'unvetted', reason: 'stale-attestation' });
  });

  it('invalidates same-revision vetting when criterion or method identity changes', async () => {
    await expect(
      getAcceptanceRubricVettingStatus(
        rubric,
        deps([card({ vetting: { consultId: 'consult-vetting', rubricRevision: 4, criteriaHash: 'hash-old' } })]),
      ),
    ).resolves.toMatchObject({
      satisfied: false,
      state: 'unvetted',
      reason: 'stale-attestation',
      currentCriteriaHash: 'hash-current',
      attestedCriteriaHash: 'hash-old',
    });
  });
});

describe('getAcceptanceRubricVettingStatus refusal diagnostics', () => {
  // The defect this covers: the refusal reason used to be derived from the
  // SURVIVOR COUNT alone, so every cause below collapsed to the single string
  // 'missing-attestation' and named no card. Each row must now map to its OWN
  // rejection — if two rows ever agree, the collapse is back.
  it.each([
    ['rubric-unresolved', { rubricResolved: false }, "did not resolve"],
    ['incomplete-ratings', { missingKeys: ['criterion'] }, 'criterion'],
    ['synthesized', { synthesized: true }, 'synthesized floor card'],
    [
      'grading-audit-unsettled',
      {
        gradingAudit: {
          state: 'pending' as const,
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-09-08T00:01:00.000Z',
        },
      },
      "audit is 'pending'",
    ],
    ['no-critique-channel', { vetting: undefined }, 'no vetting linkage'],
  ] as const)('reports %s as its own rejection, naming the card', async (rejectedBy, over, detailFragment) => {
    const result = await getAcceptanceRubricVettingStatus(rubric, deps([card(over as Partial<ScorecardRow>)]));

    expect(result.satisfied).toBe(false);
    // Not 'missing-attestation': a card DOES exist, it was rejected.
    expect(result.reason).toBe('rejected-attestation');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ issueId: 'EI-vetting', rejectedBy });
    expect(result.candidates[0]!.detail).toContain(detailFragment);
    // The whole point: the one-line diagnosis names WHICH card and WHICH check.
    expect(result.diagnosis).toContain('EI-vetting');
    expect(result.diagnosis).toContain(rejectedBy);
  });

  it('distinguishes no card at all from a card that was rejected', async () => {
    const none = await getAcceptanceRubricVettingStatus(rubric, deps([]));
    expect(none).toMatchObject({ reason: 'missing-attestation', candidates: [], diagnosis: null });

    const rejected = await getAcceptanceRubricVettingStatus(rubric, deps([card({ synthesized: true })]));
    expect(rejected.reason).toBe('rejected-attestation');
    expect(rejected.diagnosis).not.toBeNull();
  });

  it('keeps a stale attestation distinct from a rejected one and dates the mismatch', async () => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([card({ vetting: { consultId: 'consult-vetting', rubricRevision: 3, criteriaHash: 'hash-old' } })]),
    );

    expect(result.reason).toBe('stale-attestation');
    expect(result.candidates[0]).toMatchObject({ rejectedBy: 'stale-revision', attestedRevision: 3 });
    expect(result.candidates[0]!.detail).toContain('revision 3');
    expect(result.candidates[0]!.detail).toContain('revision 4');
  });

  it('records the per-card verdict for every card, including the one that carried', async () => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([
        card({ issueId: 'EI-good', createdAt: '2026-09-09T00:00:00.000Z' }),
        card({ issueId: 'EI-synth', createdAt: '2026-09-08T00:00:00.000Z', synthesized: true }),
      ]),
    );

    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('current');
    // Newest first, and the accepted card is reported alongside the rejected one
    // rather than being the only thing a reader can see.
    expect(result.candidates.map((c) => [c.issueId, c.rejectedBy])).toEqual([
      ['EI-good', null],
      ['EI-synth', 'synthesized'],
    ]);
    expect(result.diagnosis).toContain('EI-synth');
    expect(result.diagnosis).not.toContain('EI-good');
  });
});

describe('getAcceptanceRubricVettingStatus names a stand-down that strands a pending audit (EI-24121421744054354)', () => {
  const pendingAudit = {
    gradingAudit: {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-09-08T00:01:00.000Z',
    },
  } as Partial<ScorecardRow>;
  const suppressed = { reason: 'workspace-wide-loop-standdown' as const, pausedOwnerCount: 7, targetOwnerId: 'su-author' };

  it('appends the stand-down to the pending card and exposes it machine-readably', async () => {
    let reads = 0;
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([card(pendingAudit)]),
      readGradingAuditDispatchSuppression: async (targetOwnerId) => {
        reads += 1;
        expect(targetOwnerId).toBe('su-author');
        return suppressed;
      },
    });

    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe('rejected-attestation');
    expect(result.gradingAuditDispatchSuppressed).toEqual(suppressed);
    expect(result.candidates[0]).toMatchObject({ rejectedBy: 'grading-audit-unsettled' });
    // The original observation survives; the blocker is ADDED, not substituted.
    expect(result.candidates[0]!.detail).toContain("audit is 'pending'");
    expect(result.candidates[0]!.detail).toContain('workspace-wide loop stand-down');
    expect(result.candidates[0]!.detail).toContain('7 loop owner(s)');
    expect(result.diagnosis).toContain('workspace-wide loop stand-down');
    expect(reads).toBe(1);
  });

  it('says nothing about a stand-down when none is active', async () => {
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([card(pendingAudit)]),
      readGradingAuditDispatchSuppression: async (targetOwnerId) => {
        expect(targetOwnerId).toBe('su-author');
        return null;
      },
    });

    expect(result.gradingAuditDispatchSuppressed).toBeUndefined();
    expect(result.candidates[0]!.detail).not.toContain('stand-down');
  });

  it('does not attribute an unrelated owner stand-down to this card', async () => {
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([card(pendingAudit)]),
      readGradingAuditDispatchSuppression: async (targetOwnerId) =>
        targetOwnerId === 'su-paused' ? { reason: 'workspace-wide-loop-standdown', pausedOwnerCount: 1,
          targetOwnerId } : null,
    });

    expect(result.gradingAuditDispatchSuppressed).toBeUndefined();
    expect(result.candidates[0]!.detail).not.toContain('stand-down');
  });

  it('fails open without text when the suppression read throws', async () => {
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([card(pendingAudit)]),
      readGradingAuditDispatchSuppression: async () => {
        throw new Error('pg down');
      },
    });

    expect(result.satisfied).toBe(false);
    expect(result.gradingAuditDispatchSuppressed).toBeUndefined();
    expect(result.candidates[0]!.detail).not.toContain('stand-down');
  });

  it('does not consult or cite the stand-down for a card rejected for another cause', async () => {
    // A FAILED audit is not waiting on dispatch — re-launching would not settle it —
    // so blaming the pause there would send the reader to the wrong repair.
    let reads = 0;
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([
        card({ gradingAudit: { state: 'failed', metaRubricRef: 'grading-integrity', stampedAt: '2026-09-08T00:01:00.000Z' } } as Partial<ScorecardRow>),
      ]),
      readGradingAuditDispatchSuppression: async () => {
        reads += 1;
        return suppressed;
      },
    });

    expect(result.candidates[0]).toMatchObject({ rejectedBy: 'grading-audit-unsettled' });
    expect(result.candidates[0]!.detail).not.toContain('stand-down');
    expect(result.gradingAuditDispatchSuppressed).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('does not consult the stand-down when a settled attestation already carries', async () => {
    let reads = 0;
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([
        card({ issueId: 'EI-good', createdAt: '2026-09-09T00:00:00.000Z' }),
        card({ issueId: 'EI-pending', ...pendingAudit }),
      ]),
      readGradingAuditDispatchSuppression: async () => {
        reads += 1;
        return suppressed;
      },
    });

    expect(result.satisfied).toBe(true);
    expect(reads).toBe(0);
    expect(result.gradingAuditDispatchSuppressed).toBeUndefined();
  });
});

describe('getAcceptanceRubricVettingStatus names the repair call for a pending audit (WI-10005150)', () => {
  // The defect: a pending-audit rejection said only "audit is 'pending'". Automatic
  // re-dispatch sweeps just the newest scorecards, so an aged-out pending card never
  // moves on its own, and the lever (scorecards:repair with an explicit target) was
  // discoverable only by reading grading-integrity.ts. The rejection must carry it.
  const pendingAudit = {
    gradingAudit: {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-09-08T00:01:00.000Z',
    },
  } as Partial<ScorecardRow>;
  const repairCall = (ids: string[]) => ({ tool: 'scorecards:repair', args: { targetIds: ids } });

  it('names the exact call on the card and machine-readably when no suppression reader is wired', async () => {
    const result = await getAcceptanceRubricVettingStatus(rubric, deps([card(pendingAudit)]));

    expect(result.satisfied).toBe(false);
    expect(result.candidates[0]).toMatchObject({ rejectedBy: 'grading-audit-unsettled' });
    // The original observation survives; the lever is ADDED, not substituted.
    expect(result.candidates[0]!.detail).toContain("audit is 'pending'");
    expect(result.candidates[0]!.detail).toContain("scorecards:repair { targetIds: ['EI-vetting'] }");
    expect(result.diagnosis).toContain("scorecards:repair { targetIds: ['EI-vetting'] }");
    expect(result.pendingGradingAuditRepair).toEqual(repairCall(['EI-vetting']));
  });

  it('names the call when the suppression reader reports nothing suppressed', async () => {
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([card(pendingAudit)]),
      readGradingAuditDispatchSuppression: async () => null,
    });

    expect(result.gradingAuditDispatchSuppressed).toBeUndefined();
    expect(result.pendingGradingAuditRepair).toEqual(repairCall(['EI-vetting']));
  });

  it('does not offer repair for a suppressed card, whose repair would only return skipped', async () => {
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([card(pendingAudit)]),
      readGradingAuditDispatchSuppression: async () => ({
        reason: 'workspace-wide-loop-standdown',
        pausedOwnerCount: 2,
      }),
    });

    expect(result.gradingAuditDispatchSuppressed).toBeDefined();
    expect(result.pendingGradingAuditRepair).toBeUndefined();
    expect(result.candidates[0]!.detail).not.toContain('targetIds');
  });

  it('lists only the unsuppressed cards when suppression is per owner', async () => {
    const result = await getAcceptanceRubricVettingStatus(rubric, {
      ...deps([
        card({ issueId: 'EI-free', createdAt: '2026-09-09T00:00:00.000Z', createdBy: 'su-free', ...pendingAudit }),
        card({ issueId: 'EI-held', createdAt: '2026-09-08T00:00:00.000Z', createdBy: 'su-paused', ...pendingAudit }),
      ]),
      readGradingAuditDispatchSuppression: async (owner) =>
        owner === 'su-paused'
          ? { reason: 'workspace-wide-loop-standdown', pausedOwnerCount: 1, targetOwnerId: owner }
          : null,
    });

    expect(result.pendingGradingAuditRepair).toEqual(repairCall(['EI-free']));
    const byId = new Map(result.candidates.map((c) => [c.issueId, c.detail]));
    expect(byId.get('EI-free')).toContain("targetIds: ['EI-free']");
    expect(byId.get('EI-held')).not.toContain('targetIds');
    expect(byId.get('EI-held')).toContain('stand-down');
  });

  it('does not offer repair for a pending audit whose rubric subject is stale', async () => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([
        card({
          ...pendingAudit,
          subject: { kind: 'rubric', ref: 'acceptance-plan' },
          subjectRubricCurrentness: {
            state: 'stale',
            reason: 'meaning-revision-mismatch',
            recordedRevision: 3,
            currentRevision: 4,
            recordedCriteriaHash: 'hash-old',
            currentCriteriaHash: 'hash-current',
          },
        }),
      ]),
    );

    expect(result).toMatchObject({ satisfied: false, state: 'unvetted', reason: 'rejected-attestation' });
    expect(result.candidates[0]).toMatchObject({ rejectedBy: 'grading-audit-unsettled' });
    expect(result.candidates[0]!.detail).toContain('subject rubric is stale (meaning-revision-mismatch)');
    expect(result.candidates[0]!.detail).toContain('scorecards:repair skips non-current rubric subjects');
    expect(result.pendingGradingAuditRepair).toBeUndefined();
    expect(result.diagnosis).not.toContain("scorecards:repair { targetIds: ['EI-vetting'] }");
  });

  it('does not offer repair for a FAILED audit, which a new auditor would not settle', async () => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([
        card({ gradingAudit: { state: 'failed', metaRubricRef: 'grading-integrity', stampedAt: '2026-09-08T00:01:00.000Z' } } as Partial<ScorecardRow>),
      ]),
    );

    expect(result.candidates[0]).toMatchObject({ rejectedBy: 'grading-audit-unsettled' });
    expect(result.pendingGradingAuditRepair).toBeUndefined();
    expect(result.candidates[0]!.detail).not.toContain('scorecards:repair');
  });

  it('does not offer repair once a settled attestation carries, so no auditor is spent for nothing', async () => {
    const result = await getAcceptanceRubricVettingStatus(
      rubric,
      deps([
        card({ issueId: 'EI-good', createdAt: '2026-09-09T00:00:00.000Z' }),
        card({ issueId: 'EI-pending', ...pendingAudit }),
      ]),
    );

    expect(result.satisfied).toBe(true);
    expect(result.pendingGradingAuditRepair).toBeUndefined();
    expect(result.diagnosis).not.toContain('scorecards:repair');
  });
});
