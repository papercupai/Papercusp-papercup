/**
 * plan-acceptance-gate-independent-evidence.test.ts
 *
 * verification-system-improvements-2026-10-10 P-008 (D-005, D-023), AUTO-BAR-R-8-P-008.
 * Unit-level ORDERING pin for the independent-verification door on a BAR-ADOPTED plan.
 *
 * The integration suite (plan-acceptance-gate-independent-evidence.integration.test.ts)
 * drives the real door against the baseline DB, but it can only reach the door with the
 * rubric-completion flag off: no fixture seeds a complete adopted BAR contract. This file
 * covers the other half. On a plan whose BAR contract is adopted and whose ONLY remaining
 * ship-phase obligation is grading (missing or stale, pre-grading satisfied), the gate
 * defers its BAR refusal and walks on toward grader recruitment. The door must refuse
 * BEFORE that recruitment: a grader is not recruited to grade live evidence nobody outside
 * the implementers' lineage has re-observed.
 *
 * Every collaborator is mocked; the door itself is mocked to a chosen verdict so the
 * subject is the gate's ordering and pass-through, not the door's SQL.
 * Deliberately a separate file: plan-acceptance-gate.test.ts is a shared suite that other
 * plans measure, so adding cases there would stale their bound proof.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluatePlanAcceptanceGate } from './plan-acceptance-gate';
import {
  getAcceptanceRubricForPlan,
  getAcceptanceRubricsForPlan,
  readRubricPlanRevision,
  type Rubric,
} from './rubrics';
import { listScorecards } from './scorecards';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';
import {
  readAndEvaluateAcceptanceBarLifecycle,
  type AcceptanceBarLifecycleVerdict,
} from './acceptance-bar-lifecycle-evaluator';
import { areAcceptanceLineageRelated, resolvePlanImplementerIdentities } from './acceptance-author-identity';
import { readGraderSelectionVia } from './acceptance-grading-authority';
import { evaluatePlanSpecCoverageGate } from './agent-tools/plans/plan-spec-coverage-gate';
import { planDesignEvidenceGate } from './agent-tools/work_items/design-evidence-gate';
import {
  evaluateIndependentVerificationGate,
  type IndependentVerificationVerdict,
} from './independent-verification-gate';
import { evaluateBlindReviewGate } from './blind-review-gate';

vi.mock('./agent-tools/work_items/design-evidence-gate', () => ({ planDesignEvidenceGate: vi.fn() }));
vi.mock('./rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rubrics')>()),
  getAcceptanceRubricForPlan: vi.fn(),
  getAcceptanceRubricsForPlan: vi.fn(),
  getRetiredAcceptanceRubricsForPlan: vi.fn(async () => []),
  getRubric: vi.fn(),
  getRubricPlanRevision: vi.fn(),
  readRubricPlanRevision: vi.fn(),
  META_ACCEPTANCE_RUBRIC_ID: 'meta-acceptance-rubric',
}));
vi.mock('./scorecards', async (orig) => ({
  ...(await orig<typeof import('./scorecards')>()),
  listScorecards: vi.fn(),
}));
vi.mock('./acceptance-author-identity', () => ({
  areAcceptanceLineageRelated: vi.fn(),
  resolvePlanImplementerIdentities: vi.fn(),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('./acceptance-bar-lifecycle-evaluator', () => ({ readAndEvaluateAcceptanceBarLifecycle: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
vi.mock('./goals/plan-closure-observations', async (orig) => ({
  ...(await orig<typeof import('./goals/plan-closure-observations')>()),
  beginPlanClosureObservation: vi.fn(),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('./independent-verification-gate', () => ({ evaluateIndependentVerificationGate: vi.fn() }));
// The blind-review door (verification-system-improvements-2026-10-10 P-006) sits right
// after this suite's door and has its own suites; hold it satisfied so the positive
// control isolates the independent-verification door.
vi.mock('./blind-review-gate', () => ({ evaluateBlindReviewGate: vi.fn() }));
vi.mock('./acceptance-grading-authority', async (orig) => ({
  ...(await orig<typeof import('./acceptance-grading-authority')>()),
  readGraderSelectionVia: vi.fn(),
}));
vi.mock('./agent-tools/plans/plan-spec-coverage-gate', () => ({ evaluatePlanSpecCoverageGate: vi.fn() }));

const SLUG = 'iv-order-plan-2026-10-11';
const HARNESS = 'papercusp';

const mockRubric = vi.mocked(getAcceptanceRubricForPlan);
const mockRubrics = vi.mocked(getAcceptanceRubricsForPlan);
const mockScorecards = vi.mocked(listScorecards);
const mockBarLifecycle = vi.mocked(readAndEvaluateAcceptanceBarLifecycle);
const mockIndependent = vi.mocked(evaluateIndependentVerificationGate);

const sqlReturning = (rows: unknown[]) => {
  const sql = (() => Promise.resolve(rows)) as unknown as ReturnType<typeof getOrgPg>['sql'];
  return { sql } as ReturnType<typeof getOrgPg>;
};

const barVerdict = (
  phase: AcceptanceBarLifecycleVerdict['phase'],
  codes: AcceptanceBarLifecycleVerdict['codes'],
): AcceptanceBarLifecycleVerdict => ({
  phase, applicable: true, satisfied: codes.length === 0, codes,
  blockingBars: [], contractCodes: codes, codeAttribution: codes.map((code) => ({ code, barKeys: [] })),
  nextRepair: null, staleGradingScorecardId: null,
  message: codes.length ? 'BAR proof or grading is incomplete' : null,
});

const ivVerdict = (over: Partial<IndependentVerificationVerdict> = {}): IndependentVerificationVerdict => ({
  satisfied: false,
  applicable: true,
  code: 'independent_verification_missing',
  message: `plan '${SLUG}' lacks an independent re-observation of AUTO-BAR-R-1-P-001 r1 (live).`,
  inScope: 1,
  gaps: [{
    specId: 'AUTO-BAR-R-1-P-001', revision: 1, evidencePlane: 'live', barKey: 'R-1',
    reason: 'no-independent-binding', rejectedBindingIds: [], citableBindingIds: [],
  }],
  ...over,
});

const rubric = (): Rubric => ({
  gradingAuthority: 'independent',
  rubricId: `ar-${SLUG}`,
  workspaceId: 'test-ws',
  kind: 'acceptance',
  subjectPlan: SLUG,
  characteristic: 'plan-acceptance',
  title: 'Acceptance',
  description: '',
  criteriaHash: 'criteria-hash-current',
  criteria: [{ key: 'k1', title: 'K1', model: '', method: '', driftMarkers: '' }],
  ratingScale: ['pass', 'fail', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-implementer',
  proposedBy: 'su-implementer',
  ratifiedBy: null,
  createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-11T00:00:00Z',
});

/** Ship phase leaves only `gradingCode`; pre-grading is satisfied, so the gate defers. */
const onlyGradingRemains = (gradingCode: 'bar_snapshot_grading_missing' | 'bar_snapshot_grading_stale') =>
  mockBarLifecycle.mockImplementation(async (_slug, phase) =>
    barVerdict(phase, phase === 'ship' ? [gradingCode] : []));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(planDesignEvidenceGate).mockResolvedValue([]);
  vi.mocked(areAcceptanceLineageRelated).mockImplementation(async (a, b) => a === b);
  vi.mocked(resolvePlanImplementerIdentities).mockResolvedValue([]);
  vi.mocked(readRubricPlanRevision).mockResolvedValue({ ok: true as const, revision: 1 });
  vi.mocked(readGraderSelectionVia).mockResolvedValue(new Map());
  vi.mocked(evaluateBlindReviewGate).mockResolvedValue({
    satisfied: true, applicable: true, acceptedReviewIds: [1], rejectedReviews: [], undispositionedGaps: [],
  });
  // Only the rubric family is on: the code-truth gates have their own suites and run
  // before the door; turning them on here would only test their mocks.
  vi.mocked(getFlag).mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
  vi.mocked(evaluatePlanSpecCoverageGate).mockResolvedValue({
    satisfied: true, applicable: true, mode: 'enforced', planSlug: SLUG,
    aggregate: null, wouldBlock: [], reports: [],
  });
  // An ADOPTED BAR plan (epoch set, Requirements present) with a known harness: the door
  // only runs when the plan's harness is known.
  vi.mocked(getOrgPg).mockReturnValue(sqlReturning([{
    plan_slug: SLUG, harness_slug: HARNESS, template: null, template_slug: null,
    acceptance_bar_epoch: 1,
    content: '## Requirements\n\n**R-1 — Live result.** The live result is observed.\n',
  }]));
  mockRubric.mockResolvedValue(rubric());
  mockRubrics.mockImplementation(async () => [rubric()]);
  mockScorecards.mockResolvedValue([]);
  mockIndependent.mockResolvedValue(ivVerdict());
});

describe('independent-verification door on a BAR-adopted plan (P-008 / D-005)', () => {
  it.each(['bar_snapshot_grading_missing', 'bar_snapshot_grading_stale'] as const)(
    'refuses independent_verification_missing before grader recruitment when only %s remains',
    async (gradingCode) => {
      onlyGradingRemains(gradingCode);

      const result = await evaluatePlanAcceptanceGate(SLUG, { gradingRecruitment: true });

      expect(result).toMatchObject({ satisfied: false, code: 'independent_verification_missing' });
      expect(result.message).toContain('independent re-observation');
      // The deferral path really ran: pre-grading was consulted and passed.
      expect(mockBarLifecycle).toHaveBeenCalledWith(SLUG, 'pre-grading', expect.objectContaining({
        expectedApplicable: true, harnessSlug: HARNESS,
      }));
      expect(mockIndependent).toHaveBeenCalledWith({ planSlug: SLUG, harnessSlug: HARNESS });
      // ...and the rubric family, where an ungraded verdict would recruit a grader, never ran.
      expect(mockRubrics).not.toHaveBeenCalled();
      expect(mockScorecards).not.toHaveBeenCalled();
    },
  );

  it('positive control: with the door satisfied the same plan reaches the ungraded refusal', async () => {
    onlyGradingRemains('bar_snapshot_grading_missing');
    mockIndependent.mockResolvedValue(ivVerdict({ satisfied: true, code: undefined, message: undefined, gaps: [] }));

    const result = await evaluatePlanAcceptanceGate(SLUG, { gradingRecruitment: true });

    expect(result).toMatchObject({ satisfied: false, code: 'acceptance_ungraded' });
    expect(mockIndependent).toHaveBeenCalledTimes(1);
    expect(mockRubrics).toHaveBeenCalled();
  });

  it('passes a fail-closed independent_verification_unavailable through unchanged', async () => {
    onlyGradingRemains('bar_snapshot_grading_missing');
    mockIndependent.mockResolvedValue(ivVerdict({
      code: 'independent_verification_unavailable',
      message: 'independent verification could not be read: relation missing',
      gaps: [],
      readFailure: 'relation missing',
    }));

    const result = await evaluatePlanAcceptanceGate(SLUG);

    expect(result).toMatchObject({ satisfied: false, code: 'independent_verification_unavailable' });
    expect(result.message).toContain('could not be read');
    expect(mockRubrics).not.toHaveBeenCalled();
  });

  it('is not waived by force: the refusal stands and is never listed as forced past', async () => {
    onlyGradingRemains('bar_snapshot_grading_missing');

    const result = await evaluatePlanAcceptanceGate(SLUG, { force: { reason: 'owner waiver of code-truth checks' } });

    expect(result).toMatchObject({ satisfied: false, code: 'independent_verification_missing' });
    expect(result.forcedPast ?? []).not.toContain('independent_verification_missing');
  });

  it('does not reach the door while a pre-grading BAR obligation still blocks', async () => {
    mockBarLifecycle.mockImplementation(async (_slug, phase) => barVerdict(phase, phase === 'ship'
      ? ['bar_snapshot_proof_inadequate', 'bar_snapshot_grading_missing']
      : ['bar_snapshot_proof_inadequate']));

    const result = await evaluatePlanAcceptanceGate(SLUG, { gradingRecruitment: true });

    expect(result).toMatchObject({
      satisfied: false, code: 'acceptance_bar_contract_not_ready', blockingPhase: 'pre-grading',
    });
    expect(mockIndependent).not.toHaveBeenCalled();
  });
});
