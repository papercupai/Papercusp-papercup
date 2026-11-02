import { describe, expect, it, vi } from 'vitest';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import type { TaskRow } from '../../task-manager/types';
import type { SpecClauseRevision } from './spec-clauses-store';
import { evaluatePlanSpecQuality, SPEC_QUALITY_RUBRIC_REF } from './spec-quality';
import { evaluatePlanSpecQualityGate } from './plan-spec-quality-gate';
import type { PlanClassRubricRef } from './spec-test-adequacy';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'quality-plan',
    specId: 'SPEC-001-01',
    sourceValId: 'VAL-001-01',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'POST /events returns 202 for a valid request',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:spec-one',
    createdBy: 'author',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-001',
    ...over,
  };
}

type TestGateDeps = NonNullable<Parameters<typeof evaluatePlanSpecQualityGate>[1]>;

function gateDeps(over: TestGateDeps = {}): TestGateDeps {
  return {
    listAcceptanceRubrics: vi.fn(async () => [{ classRef: 'plan-class-feature-ship' }]),
    ...over,
  };
}

function matchingCard(
  clauses: SpecClauseRevision[],
  classRef: PlanClassRubricRef = 'plan-class-feature-ship',
): ScorecardRow {
  const evaluation = evaluatePlanSpecQuality({
    planSlug: 'quality-plan',
    harnessSlug: 'papercusp',
    planItemIds: ['P-001'],
    clauses,
    classRef,
  });
  return {
    issueId: 'EI-quality-card',
    createdAt: '2026-08-20T00:02:00.000Z',
    createdBy: 'reviewer',
    subject: evaluation.scorecardDraft.subject,
    rubricRef: SPEC_QUALITY_RUBRIC_REF,
    ratings: evaluation.ratings,
    nKeys: Object.keys(evaluation.ratings).length,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    evidenceFingerprint: scorecardEvidenceFingerprint({
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      ratings: evaluation.ratings,
    }),
    synthesized: false,
    score10: 10,
    linkedItems: [],
  };
}

function auditPendingCard(
  clauses: SpecClauseRevision[],
  dispatchReservation?: { key: string; reservedAt: string },
): ScorecardRow {
  return {
    ...matchingCard(clauses),
    issueId: 'EI-quality-card-pending',
    gradingAudit: {
      state: 'pending',
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-08-20T00:03:00.000Z',
      ...(dispatchReservation ? { dispatchReservation } : {}),
    },
  };
}

function auditFailedCard(clauses: SpecClauseRevision[]): ScorecardRow {
  return {
    ...matchingCard(clauses),
    issueId: 'EI-quality-card-failed',
    gradingAudit: {
      state: 'failed',
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-08-20T00:03:00.000Z',
      auditIssueId: 'EI-audit-card',
      auditor: 'auditor',
      auditedAt: '2026-08-20T00:04:00.000Z',
    },
  };
}

function matchingCardWithInstrumentSnapshots(clauses: SpecClauseRevision[]): ScorecardRow {
  const evaluation = evaluatePlanSpecQuality({
    planSlug: 'quality-plan',
    harnessSlug: 'papercusp',
    planItemIds: ['P-001'],
    clauses,
    classRef: 'plan-class-feature-ship',
  });
  const instrumentSnapshots = {
    'spec-quality.proof': {
      verdict: 'pass' as const,
      measuredAt: '2026-08-20T00:01:30.000Z',
      value: { checked: 1 },
      evidenceRef: 'test:spec-quality-proof',
    },
  };
  return {
    ...matchingCard(clauses),
    instrumentSnapshots,
    evidenceFingerprint: scorecardEvidenceFingerprint({
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      ratings: evaluation.ratings,
      instrumentSnapshots,
    }),
  };
}

function withIdentityEvidence(card: ScorecardRow, evidence: string): ScorecardRow {
  const ratings = {
    ...card.ratings,
    'stable-revision-identity': { rating: 'pass', evidence },
  };
  return {
    ...card,
    ratings,
    evidenceFingerprint: scorecardEvidenceFingerprint({
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      ratings,
      instrumentSnapshots: card.instrumentSnapshots,
    }),
  };
}

describe('evaluatePlanSpecQualityGate', () => {
  it('blocks activation when a runtime BAR is projected onto an exempt prerequisite instead of its dependent implementation', async () => {
    const sourceBar = {
      barKey: 'R-1',
      barHash: 'a'.repeat(64),
      barSetHash: 'b'.repeat(64),
      rubricSlug: 'quality-plan-acceptance',
      rubricRevision: 4,
      evidencePlane: 'tree' as const,
    };
    const clauses = [
      clause({
        specId: 'INVENTORY-P-001', sourceValId: null, planItemId: 'P-001',
        behaviorClass: 'non-automated', requiredTestLayers: [], mutationRequired: false,
        lifecycleStatus: 'exempt', exemption: { justification: 'Read-only inventory.', provenance: 'D-006' },
      }),
      clause({ specId: 'AUTO-BAR-R-1-P-001', sourceValId: null, planItemId: 'P-001', sourceBar: { ...sourceBar } }),
      clause({ specId: 'AUTO-BAR-R-1-P-002', sourceValId: null, planItemId: 'P-002', sourceBar: { ...sourceBar } }),
      clause({ specId: 'CONTRACT-P-002', sourceValId: null, planItemId: 'P-002' }),
    ];
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      {
        harnessSlug: 'papercup',
        planSlug: 'quality-plan',
        planItemIds: ['P-001', 'P-002'],
        planItems: [
          { id: 'P-001', blockedBy: [] },
          { id: 'P-002', blockedBy: ['P-001'] },
        ],
      },
      gateDeps({ listClauses: async () => clauses, listCards }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_failed',
      wouldBlock: ['item-contract-coverage'],
    });
    expect(listCards).not.toHaveBeenCalled();
  });

  it.each(['current', 'active/accepted current'])(
    'preserves an audited all-active card with the exact equivalent "%s" identity wording',
    async (wording) => {
      const clauses = [clause()];
      const card = matchingCardWithInstrumentSnapshots(clauses);
      const originalEvidence = card.ratings['stable-revision-identity'].evidence;
      const prefix = originalEvidence.slice(0, originalEvidence.lastIndexOf(' 1 ') + 1);
      const historicalCard = withIdentityEvidence(
        card,
        `${prefix}1 ${wording} clause(s) have unique identities, content hashes, and acceptance provenance.`,
      );
      historicalCard.gradingAudit = {
        state: 'passed', metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-20T00:03:00.000Z',
        auditIssueId: 'EI-original-audit', auditor: 'independent-reviewer',
        auditedAt: '2026-08-20T00:04:00.000Z',
      };
      const result = await evaluatePlanSpecQualityGate(
        { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
        gateDeps({ listClauses: async () => clauses, listCards: async () => [historicalCard] }),
      );
      expect(result).toMatchObject({ satisfied: true, scorecardId: card.issueId });
      // All-active evidence was already truthful: preserve the original producer bytes.
      expect(originalEvidence).toMatch(/ 1 current clause\(s\) have unique identities, content hashes, and acceptance provenance\.$/);
    },
  );

  it.each(['draft', 'exempt'] as const)(
    'does not accept old misleading all-provenance wording for a mixed %s set',
    async (lifecycleStatus) => {
      const clauses = [
        clause(),
        clause({
          specId: 'SPEC-001-02', sourceValId: 'VAL-001-02', lifecycleStatus,
          acceptedBy: null, acceptedAt: null, acceptanceRef: null,
          ...(lifecycleStatus === 'exempt' ? {
            behaviorClass: 'non-automated' as const,
            exemption: { justification: 'Editorial-only work.', provenance: 'D-002' },
          } : {}),
        }),
      ];
      const card = matchingCard(clauses);
      const evidence = card.ratings['stable-revision-identity'].evidence;
      const prefix = evidence.slice(0, evidence.lastIndexOf(' 1 active/accepted') + 1);
      const misleadingCard = withIdentityEvidence(
        card,
        `${prefix}2 current clause(s) have unique identities, content hashes, and acceptance provenance.`,
      );
      const result = await evaluatePlanSpecQualityGate(
        { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
        gateDeps({ listClauses: async () => clauses, listCards: async () => [misleadingCard] }),
      );
      expect(result.satisfied).toBe(false);
    },
  );

  it.each(['other-evidence', 'snapshot', 'rating-with-stale-fingerprint', 'pending-audit', 'failed-audit'])(
    'does not turn wording compatibility into an evidence/audit bypass: %s',
    async (change) => {
      const clauses = [clause()];
      const card = matchingCardWithInstrumentSnapshots(clauses);
      const evidence = card.ratings['stable-revision-identity'].evidence;
      const prefix = evidence.slice(0, evidence.lastIndexOf(' 1 ') + 1);
      const interimCard = withIdentityEvidence(
        card,
        `${prefix}1 active/accepted current clause(s) have unique identities, content hashes, and acceptance provenance.`,
      );
      if (change === 'other-evidence') {
        interimCard.ratings['item-contract-coverage'] = { rating: 'pass', evidence: 'Unsupported assertion.' };
        interimCard.evidenceFingerprint = scorecardEvidenceFingerprint({
          rubricRef: interimCard.rubricRef, ratings: interimCard.ratings,
          instrumentSnapshots: interimCard.instrumentSnapshots,
        });
      } else if (change === 'snapshot') {
        interimCard.instrumentSnapshots!['spec-quality.proof'].value = { checked: 999 };
      } else if (change === 'rating-with-stale-fingerprint') {
        interimCard.ratings['stable-revision-identity'] = { rating: 'pass', evidence: 'Altered after grading.' };
      } else {
        interimCard.gradingAudit = {
          state: change === 'pending-audit' ? 'pending' : 'failed',
          metaRubricRef: 'grading-integrity', stampedAt: '2026-08-20T00:03:00.000Z',
        };
      }
      const result = await evaluatePlanSpecQualityGate(
        { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
        gateDeps({ listClauses: async () => clauses, listCards: async () => [interimCard] }),
      );
      expect(result.satisfied).toBe(false);
    },
  );

  it('keeps legacy/no-clause plans report-only', async () => {
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'legacy-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => []), listCards: vi.fn(async () => []) }),
    );

    expect(result).toMatchObject({ satisfied: true, applicable: false, mode: 'report-only' });
    expect(result.wouldBlock).toEqual(['no-first-class-spec-clauses']);
  });

  it('does not treat an unavailable clause store as a proven legacy/no-clause plan', async () => {
    const listCards = vi.fn();
    const listAcceptanceRubrics = vi.fn();
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      {
        listClauses: async () => { throw new Error('clauses unavailable'); },
        listCards, listAcceptanceRubrics,
      },
    );
    expect(result).toMatchObject({
      satisfied: false, mode: 'enforced', code: 'spec_quality_unavailable',
      wouldBlock: ['spec-quality-read-unavailable'],
    });
    expect(listCards).not.toHaveBeenCalled();
    expect(listAcceptanceRubrics).not.toHaveBeenCalled();
  });

  it('fails closed once a plan adopts clauses but leaves an item uncovered', async () => {
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001', 'P-002'] },
      gateDeps({ listClauses: vi.fn(async () => [clause()]), listCards: vi.fn(async () => []) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      code: 'spec_quality_failed',
    });
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });

  it('refuses structurally passing clauses without an exact current scorecard', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => []) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_scorecard_missing',
      wouldBlock: ['exact-specSetHash-scorecard-missing'],
      scorecardDiagnostics: [],
    });
  });

  it('identifies rejected evidence without exposing its contents or requesting a duplicate card', async () => {
    const clauses = [clause()];
    const card = matchingCard(clauses);
    card.ratings.falsifiability!.evidence += ' Changed assertion.';
    card.evidenceFingerprint = scorecardEvidenceFingerprint({ rubricRef: card.rubricRef, ratings: card.ratings });
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [card]) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      code: 'spec_quality_scorecard_missing',
      scorecardDiagnostics: [{ issueId: card.issueId, failedChecks: ['evidence'], differingCriteria: ['falsifiability'] }],
    });
    expect(JSON.stringify(result.scorecardDiagnostics)).not.toContain('Changed assertion.');
  });

  it('accepts only the complete scorecard matching the exact current specSetHash', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [matchingCard(clauses)]) }),
    );

    expect(result).toMatchObject({
      satisfied: true,
      applicable: true,
      mode: 'enforced',
      classRef: 'plan-class-feature-ship',
      scorecardId: 'EI-quality-card',
      wouldBlock: [],
    });
  });

  it('accepts exact current findings with historical replay metadata but refuses changed findings and replay hashes', async () => {
    const clauses = [clause()];
    const evaluation = evaluatePlanSpecQuality({ planSlug: 'quality-plan', harnessSlug: 'papercusp',
      planItemIds: ['P-001'], clauses, classRef: 'plan-class-feature-ship',
      replaySnapshot: { planContentHash: 'a'.repeat(64), clausesAsOf: '2026-08-20T00:00:00.001Z' } });
    const card = { ...matchingCard(clauses), ratings: evaluation.ratings };
    const refresh = () => { card.evidenceFingerprint = scorecardEvidenceFingerprint({ rubricRef: SPEC_QUALITY_RUBRIC_REF, ratings: card.ratings }); };
    refresh();
    const gate = () => evaluatePlanSpecQualityGate({ harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [card]) }));
    expect((await gate()).satisfied).toBe(true);
    const original = card.ratings.falsifiability!.evidence;
    card.ratings.falsifiability!.evidence = original.replace(evaluation.specSetHash, 'f'.repeat(64));
    refresh();
    expect((await gate()).satisfied).toBe(false);
    card.ratings.falsifiability!.evidence = original.replace('Historical replay', 'Untrusted replay');
    refresh();
    expect((await gate()).satisfied).toBe(false);
    card.ratings.falsifiability!.evidence = original.replace('falsifiable', 'unproven');
    refresh();
    expect((await gate()).satisfied).toBe(false);
  });

  it('accepts an instrumented scorecard using the persisted snapshot-aware fingerprint', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => clauses),
        listCards: vi.fn(async () => [matchingCardWithInstrumentSnapshots(clauses)]),
      }),
    );

    expect(result).toMatchObject({
      satisfied: true,
      applicable: true,
      scorecardId: 'EI-quality-card',
      wouldBlock: [],
    });
  });

  it('reports the grading-audit-pending prerequisite instead of "scorecard missing" (EI-22068670622018218)', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [auditPendingCard(clauses)]) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      code: 'spec_quality_scorecard_grading_audit_pending',
      scorecardId: 'EI-quality-card-pending',
      wouldBlock: ['exact-specSetHash-scorecard-grading-audit-pending'],
    });
    expect(result.message).toContain('grading-integrity');
    expect(result.message).toContain('EI-quality-card-pending');
  });

  it('names the auditor task, settlement event, and targeted repair instead of asking for a duplicate audit', async () => {
    const clauses = [clause()];
    const reservation = {
      key: 'grading-audit:EI-quality-card-pending',
      reservedAt: '2026-08-20T00:03:01.000Z',
    };
    const listTasks = vi.fn(async () => [{
      taskId: 'task-grading-auditor',
      class: 'agent-session',
      state: 'running',
      workItemId: 'EI-quality-card-pending',
      detail: { label: reservation.key, coordOwnerId: 'su-reserved-auditor' },
    }] as unknown as TaskRow[]);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => clauses),
        listCards: vi.fn(async () => [auditPendingCard(clauses, reservation)]),
        listTasks,
      }),
    );

    expect(result.code).toBe('spec_quality_scorecard_grading_audit_pending');
    expect(result.message).toContain("task 'task-grading-auditor'");
    expect(result.message).toContain("owner 'su-reserved-auditor'");
    expect(result.message).toContain(reservation.reservedAt);
    expect(result.message).toContain("events:await { event:'scorecard:grading-audit:EI-quality-card-pending' }");
    expect(result.message).toContain("scorecards:repair { targetIds:['EI-quality-card-pending'] }");
    expect(result.message).toContain('preserves an auditor that is still viable or whose state is unknown');
    expect(result.message).not.toContain('no further action is needed while it settles');
    expect(result.message).not.toContain('No grading-audit await key is available');
    expect(result.message).not.toContain('scorecards:emit');
    expect(listTasks).toHaveBeenCalledWith({
      states: ['pending', 'running'],
      labelPrefix: reservation.key,
      limit: 10,
    });
  });

  it('reports the grading-audit-failed verdict distinctly from a pending one', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => clauses), listCards: vi.fn(async () => [auditFailedCard(clauses)]) }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      code: 'spec_quality_scorecard_grading_audit_failed',
      scorecardId: 'EI-quality-card-failed',
      wouldBlock: ['exact-specSetHash-scorecard-grading-audit-failed'],
    });
    // WI-10002063 (sibling of the spec-test-adequacy defect): the GRADED card's id is not
    // the findings — the AUDIT card holds them. A refusal that says "repair whatever the
    // audit flagged" while naming only EI-quality-card-failed is unactionable.
    expect(result.message).toContain('EI-audit-card');
  });

  it('states plainly when a failed grading audit recorded no audit card id (WI-10002063)', async () => {
    const clauses = [clause()];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => clauses),
        listCards: vi.fn(async () => [
          {
            ...auditFailedCard(clauses),
            gradingAudit: {
              state: 'failed' as const,
              metaRubricRef: 'grading-integrity',
              stampedAt: '2026-08-20T00:03:00.000Z',
            },
          },
        ]),
      }),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'spec_quality_scorecard_grading_audit_failed' });
    // auditIssueId is legitimately absent on some audit states, so the honest statement is
    // the contract — a bare interpolation would render "Read the audit card undefined".
    expect(result.message).toContain('No audit card id was recorded');
    expect(result.message).not.toMatch(/undefined|null/);
  });

  it('still reports plain "missing" when no exact card exists at all, pending or not', async () => {
    const clauses = [clause()];
    // computeSpecSetHash hashes semantic content (behavior, behaviorClass, etc.) —
    // NOT revision/contentHash — so the differentiator here must change `behavior`,
    // mirroring the sibling "invalidates an older card" case below.
    const revisedClauses = [
      clause({
        currentRevision: 2,
        revision: 2,
        behavior: 'POST /events returns 201 for a valid request',
        contentHash: 'sha256:spec-two',
      }),
    ];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => revisedClauses),
        // A pending card exists, but for the SUPERSEDED specSetHash (built off the
        // pre-revision `clauses`) — its subjectRef will not match revisedClauses'
        // evaluation, so the generic missing verdict must still apply, not the
        // grading-audit-pending one.
        listCards: vi.fn(async () => [auditPendingCard(clauses)]),
      }),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'spec_quality_scorecard_missing' });
  });

  it('invalidates an older card after a semantic clause revision', async () => {
    const oldClauses = [clause()];
    const revised = [
      clause({
        currentRevision: 2,
        revision: 2,
        behavior: 'POST /events returns 201 for a valid request',
        contentHash: 'sha256:spec-two',
      }),
    ];
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({ listClauses: vi.fn(async () => revised), listCards: vi.fn(async () => [matchingCard(oldClauses)]) }),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'spec_quality_scorecard_missing' });
  });

  it('uses the persisted acceptance class and ignores a passing scorecard under another class', async () => {
    const clauses = [clause({ behaviorClass: 'failure' })];
    const listAcceptanceRubrics = vi.fn(async () => [{ classRef: 'plan-class-bugfix' }]);
    const listCards = vi.fn(async () => [matchingCard(clauses, 'plan-class-feature-ship')]);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => clauses),
        listAcceptanceRubrics,
        listCards,
      }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      classRef: 'plan-class-bugfix',
      code: 'spec_quality_scorecard_missing',
      wouldBlock: ['exact-specSetHash-scorecard-missing'],
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({ classRef: 'plan-class-bugfix', verdict: 'pass' }),
    ]);
    expect(listAcceptanceRubrics).toHaveBeenCalledWith('quality-plan', { harnessSlug: 'papercusp', strict: true });
    expect(listCards).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectRef: expect.stringContaining('spec-set:plan-class-bugfix:'),
      }),
    );
  });

  it('fails closed when the active acceptance rubric has no persisted classRef', async () => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => [clause()]),
        listAcceptanceRubrics: vi.fn(async () => [{ rubricId: 'quality-plan-acceptance', classRef: null }]),
        listCards,
      }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_class_missing',
      wouldBlock: ['acceptance-rubric-class-missing'],
    });
    expect(result.message).toContain(
      'rubrics:amend { rubricRef:"quality-plan-acceptance", classRef:"<plan-class>" }',
    );
    expect(result.message).toContain('plans:set-template-data');
    expect(result.message).toContain('no_template');
    expect(result.classRef).toBeUndefined();
    expect(listCards).not.toHaveBeenCalled();
  });

  it('gives a creation path when no acceptance rubric exists', async () => {
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => [clause()]),
        listAcceptanceRubrics: vi.fn(async () => []),
      }),
    );

    expect(result.message).toContain('rubrics:propose');
    expect(result.message).toContain('kind:"acceptance"');
    expect(result.message).toContain('subjectPlan:"quality-plan"');
    expect(result.message).toContain('plans:set-template-data');
  });

  it('fails closed when multiple active acceptance rubrics make the class ambiguous', async () => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => [clause()]),
        listAcceptanceRubrics: vi.fn(async () => [
          { classRef: 'plan-class-feature-ship' },
          { classRef: 'plan-class-bugfix' },
        ]),
        listCards,
      }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_class_ambiguous',
      wouldBlock: ['acceptance-rubric-class-ambiguous'],
    });
    expect(listCards).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted classRef is not a known plan class', async () => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: 'papercusp', planSlug: 'quality-plan', planItemIds: ['P-001'] },
      gateDeps({
        listClauses: vi.fn(async () => [clause()]),
        listAcceptanceRubrics: vi.fn(async () => [{ classRef: 'subject-plan-ref' }]),
        listCards,
      }),
    );

    expect(result).toMatchObject({
      satisfied: false,
      applicable: true,
      code: 'spec_quality_class_invalid',
      wouldBlock: ['acceptance-rubric-class-invalid'],
    });
    expect(listCards).not.toHaveBeenCalled();
  });
});
