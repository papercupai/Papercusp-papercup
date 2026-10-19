/**
 * plan-acceptance-gate.test.ts — the plan-completion acceptance gate
 * (acceptance-rubrics-on-every-plan-2026-08-11 P-005/P-008).
 *
 * Unit-level: every collaborator is mocked; the subject is the VERDICT logic —
 * flag gating, exemptions, missing/ungraded/self-graded refusals (each with its
 * teaching message), and the independent-grader satisfaction path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./acceptance-rubric-critique', () => ({ readCurrentAcceptanceRubricCritique: vi.fn(async () => null) }));
import {
  ACCEPTANCE_VERDICT_REQUIRED_AFTER,
  evaluatePlanAcceptanceGate,
  findDurableDeliverableCompanions,
  messageWithAdditionalBlockers,
  planAcceptanceRepairAction,
  receiverHeldAcceptanceRefusal,
} from './plan-acceptance-gate';
import { unfinishedItemsAreAuditedNonCode } from './plan-verification-profile';
import { ACCEPTANCE_GRADING_NO_CLAIM_FACT } from './consult/grading-cascade';
import {
  getAcceptanceRubricForPlan,
  getAcceptanceRubricsForPlan,
  getRubric,
  getRubricPlanRevision,
  readRubricPlanRevision,
  type Rubric,
} from './rubrics';
import { listScorecards, type ScorecardRow } from './scorecards';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';
import { readAndEvaluateAcceptanceBarLifecycle, type AcceptanceBarLifecycleVerdict } from './acceptance-bar-lifecycle-evaluator';
import {
  areAcceptanceLineageRelated,
  resolvePlanImplementerIdentities,
} from './acceptance-author-identity';
import { readGraderSelectionVia } from './acceptance-grading-authority';
import {
  evaluatePlanSpecCoverageGate,
  type PlanSpecCoverageGateVerdict,
} from './agent-tools/plans/plan-spec-coverage-gate';
import { planDesignEvidenceGate } from './agent-tools/work_items/design-evidence-gate';
import { getBuildInfo } from './build-info';
import { beginPlanClosureObservation } from './goals/plan-closure-observations';
// This suite checks shipment wiring; the design adapter's filesystem and
// all-item aggregation are exercised by design-compare/acceptance.test.ts.
vi.mock('./agent-tools/work_items/design-evidence-gate', () => ({ planDesignEvidenceGate: vi.fn() }));

const rubricMocks = vi.hoisted(() => ({
  getAcceptanceRubricForPlan: vi.fn(),
  getAcceptanceRubricsForPlan: vi.fn(),
  getRetiredAcceptanceRubricsForPlan: vi.fn(),
}));
vi.mock('./rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rubrics')>()),
  getAcceptanceRubricForPlan: rubricMocks.getAcceptanceRubricForPlan,
  getAcceptanceRubricsForPlan: rubricMocks.getAcceptanceRubricsForPlan,
  getRetiredAcceptanceRubricsForPlan: rubricMocks.getRetiredAcceptanceRubricsForPlan,
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
  areAcceptanceLineageRelated: vi.fn(
    async (author: string | null, candidate: string | null) => author === candidate,
  ),
  resolvePlanImplementerIdentities: vi.fn(async () => [] as string[]),
}));
vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(),
}));
vi.mock('./acceptance-bar-lifecycle-evaluator', () => ({ readAndEvaluateAcceptanceBarLifecycle: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
// D-032's persisted closure verdict has its own suite (goals/plan-closure-observations*);
// here only the gate's ordering and canonical-call contract with it is asserted.
vi.mock('./goals/plan-closure-observations', async (orig) => ({
  ...(await orig<typeof import('./goals/plan-closure-observations')>()),
  beginPlanClosureObservation: vi.fn(),
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));
// P-008's independent-verification door issues its own SQL against the real schema;
// this suite's getOrgPg mock answers the gate's queries only. The door has its own
// integration suite (plan-acceptance-gate-independent-evidence.integration.test.ts).
vi.mock('./independent-verification-gate', () => ({
  evaluateIndependentVerificationGate: vi.fn(async () => ({
    satisfied: true,
    applicable: false,
    inScope: 0,
    gaps: [],
  })),
}));
// P-006's blind gap review door is the same shape: its own SQL against the real schema,
// covered by blind-review-gate.test.ts and plan-acceptance-gate-blind-review.integration.test.ts.
// Unstubbed, every fixture here that names a harness_slug read this suite's catch-all
// getOrgPg rows as "no review" and refused blind_review_missing before the check under test.
vi.mock('./blind-review-gate', () => ({
  evaluateBlindReviewGate: vi.fn(async () => ({
    satisfied: true,
    applicable: false,
    acceptedReviewIds: [],
    rejectedReviews: [],
    undispositionedGaps: [],
  })),
}));
// P-004: only the DURABLE READ is stubbed. The ranking kernel it feeds
// (pickAuthoritativeGrading/gradingViaOf) stays real, so these cases exercise
// the gate's actual ordering rather than a re-implementation of it — the read
// is stubbed because it is the one part that needs a consult_state row.
vi.mock('./acceptance-grading-authority', async (orig) => ({
  ...(await orig<typeof import('./acceptance-grading-authority')>()),
  readGraderSelectionVia: vi.fn(),
}));
// P-008's spec-coverage census is mocked here on purpose: this suite's subject is the
// WIRING (does the acceptance gate refuse, waive under force, and carry the aggregate),
// not the census itself — that has its own suite next to the module.
vi.mock('./agent-tools/plans/plan-spec-coverage-gate', () => ({
  evaluatePlanSpecCoverageGate: vi.fn(),
}));
// rubric-template self-registers into the template registry on import; keep the real
// module (it is dependency-free) so RUBRIC_TEMPLATE_NAME stays the real constant.

const mockRubric = vi.mocked(getAcceptanceRubricForPlan);
const mockRubrics = vi.mocked(getAcceptanceRubricsForPlan);
const mockGetRubric = vi.mocked(getRubric);
const mockRevision = vi.mocked(getRubricPlanRevision);
// EI-21827040531672903: the gate reads through readRubricPlanRevision, which reports a
// FAILED read distinctly from "no revision". Existing cases drive the plain value mock,
// so the read mock delegates to it and reports success; the fail-open case overrides
// this to return { ok: false }.
const mockRevisionRead = vi.mocked(readRubricPlanRevision);
const mockScorecards = vi.mocked(listScorecards);
const mockFlag = vi.mocked(getFlag);
const mockPg = vi.mocked(getOrgPg);
const mockBarLifecycle = vi.mocked(readAndEvaluateAcceptanceBarLifecycle);
const mockLineageRelated = vi.mocked(areAcceptanceLineageRelated);
const mockPlanImplementers = vi.mocked(resolvePlanImplementerIdentities);
const mockGraderVia = vi.mocked(readGraderSelectionVia);
const mockSpecCoverage = vi.mocked(evaluatePlanSpecCoverageGate);

const coverageVerdict = (over: Partial<PlanSpecCoverageGateVerdict> = {}): PlanSpecCoverageGateVerdict => ({
  satisfied: true,
  applicable: true,
  mode: 'enforced',
  planSlug: 'some-plan-2026-08-11',
  aggregate: null,
  wouldBlock: [],
  reports: [],
  ...over,
});

/** A sql`` tag that resolves the same rows for any query. */
const sqlReturning = (rows: unknown[]) => {
  const sql = (() => Promise.resolve(rows)) as unknown as ReturnType<typeof getOrgPg>['sql'];
  return { sql } as ReturnType<typeof getOrgPg>;
};

const acceptanceRubric = (over: Partial<Rubric> = {}): Rubric => ({
  // D-002 default; `over` still wins, so a case can declare 'owner-authorized'.
  gradingAuthority: 'independent',
  rubricId: 'ar-some-plan',
  workspaceId: 'test-ws',
  kind: 'acceptance',
  subjectPlan: 'some-plan-2026-08-11',
  characteristic: 'plan-acceptance',
  title: 'Acceptance: some plan',
  description: '',
  criteriaHash: 'criteria-hash-current',
  criteria: [{ key: 'k1', title: 'K1', model: '', method: '', driftMarkers: '' }],
  ratingScale: ['pass', 'fail', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-implementer',
  proposedBy: 'su-implementer',
  ratifiedBy: null,
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
  ...over,
});

const scorecard = (over: Partial<ScorecardRow> = {}): ScorecardRow => ({
  issueId: 'EI-1',
  createdAt: '2026-08-11T01:00:00Z',
  createdBy: 'su-grader',
  rubricRef: 'ar-some-plan',
  criteriaHash: 'criteria-hash-current',
  ratings: { k1: { rating: 'pass', evidence: 'verified live' } },
  nKeys: 1,
  missingKeys: [],
  extraKeys: [],
  rubricResolved: true,
  synthesized: false,
  score10: 10,
  linkedItems: [],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(planDesignEvidenceGate).mockResolvedValue([]);
  mockBarLifecycle.mockResolvedValue({ phase: 'ship', applicable: false, satisfied: true,
    codes: [], blockingBars: [], contractCodes: [], codeAttribution: [], nextRepair: null,
    staleGradingScorecardId: null, message: null });
  mockRubrics.mockImplementation(async (planSlug) => {
    const one = await mockRubric(planSlug);
    return one ? [one] : [];
  });
  // Default: no retired acceptance rubric on record (only the already-shipped cases set one).
  rubricMocks.getRetiredAcceptanceRubricsForPlan.mockResolvedValue([]);
  mockLineageRelated.mockImplementation(async (author, candidate) => author === candidate);
  mockPlanImplementers.mockResolvedValue([]);
  // Delegate the ok/failed-aware read to the plain value mock every existing case
  // already drives, so those cases keep expressing "the revision is N" unchanged.
  mockRevisionRead.mockImplementation(async (rubricId: string) => ({
    ok: true as const,
    revision: await mockRevision(rubricId),
  }));
  // This suite exercises the acceptance-rubric family in isolation. The newer
  // code-truth gates have their own focused suite and deliberately run first in
  // production, so leave them disabled here unless a test opts in explicitly.
  mockFlag.mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
  // Safe default so a suite that never opts the P-008 flag in cannot trip over an
  // unstubbed mock if the flag mapping above is ever widened.
  mockSpecCoverage.mockResolvedValue(coverageVerdict());
  // Default: no grading cascade provenance is on record, so every card ranks as
  // floor-qualified — which is precisely the pre-P-004 latest-wins these cases
  // were written against, and why they still express what they always did.
  mockGraderVia.mockResolvedValue(new Map());
  // Default: the subject plan row exists and is a plain work plan (no exemption).
  mockPg.mockReturnValue(
    sqlReturning([{ plan_slug: 'some-plan-2026-08-11', template: null, template_slug: null, content: null }]),
  );
});

describe('grading-recruitment unfinished-item exception', () => {
  const unfinished = [{ itemId: 'P-011' }];

  it('admits an unfinished tail only when every item is effectively audited not-code', () => {
    expect(
      unfinishedItemsAreAuditedNonCode(unfinished, [
        { entry: { itemId: 'P-011', verdict: 'not-code' } },
      ]),
    ).toBe(true);
  });

  it.each([
    ['missing audit', []],
    ['implemented audit', [{ entry: { itemId: 'P-011', verdict: 'implemented' } }]],
    [
      'mixed tail',
      [
        { entry: { itemId: 'P-011', verdict: 'not-code' } },
        { entry: { itemId: 'P-010', verdict: 'partial' } },
      ],
    ],
  ])('refuses %s evidence', (_label, audits) => {
    const items = _label === 'mixed tail' ? [...unfinished, { itemId: 'P-010' }] : unfinished;
    expect(unfinishedItemsAreAuditedNonCode(items, audits)).toBe(false);
  });

  it('does not manufacture an exception when there are no unfinished items', () => {
    expect(unfinishedItemsAreAuditedNonCode([], [])).toBe(false);
  });
});

describe('evaluatePlanAcceptanceGate', () => {
  it.each(['ready', 'awaiting-acceptance'])('binds repair scope and CAS to the observed %s subject', async (status) => {
    mockFlag.mockResolvedValue(false);
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'observed-plan', harness_slug: 'actual-home', status }]));
    const verdict = await evaluatePlanAcceptanceGate('observed-plan');
    expect(verdict.repairAction?.nextVerb).toMatchObject({
      name: 'plans:set-plan-status', args: { slug: 'observed-plan', harness: 'actual-home', status: 'shipped' },
    });
    expect(verdict.repairAction?.nextVerb?.args.expectedCurrent)
      .toBe(status === 'awaiting-acceptance' ? status : undefined);
  });

  it('D-032: reads the closure fingerprint BEFORE the gate reads anything, then records the verdict', async () => {
    const events: string[] = [];
    const record = vi.fn(async () => undefined);
    vi.mocked(beginPlanClosureObservation).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('fingerprint-read');
      return { record };
    });
    mockFlag.mockResolvedValue(false);
    const sql = (() => {
      events.push('gate-read');
      return Promise.resolve([{ plan_slug: 'observed-plan', harness_slug: 'actual-home', status: 'ready' }]);
    }) as unknown as ReturnType<typeof getOrgPg>['sql'];
    mockPg.mockReturnValue({ sql } as ReturnType<typeof getOrgPg>);

    const verdict = await evaluatePlanAcceptanceGate('observed-plan');

    expect(events[0]).toBe('fingerprint-read');
    expect(events).toContain('gate-read');
    expect(record).toHaveBeenCalledWith('actual-home', verdict);
  });

  it.each([
    ['force', { force: { reason: 'waive code truth' } }],
    ['gradingRecruitment', { gradingRecruitment: true }],
  ])('D-032: never records a %s read as the closure verdict', async (_name, opts) => {
    mockFlag.mockResolvedValue(false);
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'observed-plan', harness_slug: 'actual-home', status: 'ready' }]));
    await evaluatePlanAcceptanceGate('observed-plan', opts);
    expect(beginPlanClosureObservation).not.toHaveBeenCalled();
  });

  it('stamps even an early refusal with the loaded build provenance', async () => {
    mockRubric.mockResolvedValue(null);

    const verdict = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(verdict).toMatchObject({
      satisfied: false,
      code: 'acceptance_rubric_missing',
      buildProvenance: getBuildInfo(),
    });
    expect(verdict.buildProvenance).toHaveProperty('sha');
    expect(verdict.buildProvenance).toHaveProperty('version');
  });

  it('refuses stale design proof before a disabled rubric gate can return success', async () => {
    mockFlag.mockResolvedValue(false);
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'design-plan', harness_slug: 'papercusp', status: 'ready' }]));
    vi.mocked(planDesignEvidenceGate).mockResolvedValue([
      { status: 'satisfied', report: 'earlier passing obligation' },
      { status: 'unsatisfied', enforced: true, featureId: 'design-plan', blockingReferenceIds: ['desktop'], report: 'stale-build' },
    ]);
    expect(await evaluatePlanAcceptanceGate('design-plan')).toMatchObject({ satisfied: false, code: 'design_evidence_unsatisfied', message: 'stale-build' });
    expect(planDesignEvidenceGate).toHaveBeenCalledWith('design-plan', 'papercusp');
  });
  it('refuses an unreadable design obligation at shipment', async () => {
    mockFlag.mockResolvedValue(false);
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'design-plan', harness_slug: 'papercusp', status: 'ready' }]));
    vi.mocked(planDesignEvidenceGate).mockRejectedValue(new Error('identity unreadable'));
    expect(await evaluatePlanAcceptanceGate('design-plan')).toMatchObject({ satisfied: false, code: 'design_evidence_unavailable' });
  });
  it('permits shipment when the current design family has no enforced failure', async () => {
    mockFlag.mockResolvedValue(false);
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'design-plan', harness_slug: 'papercusp', status: 'ready' }]));
    vi.mocked(planDesignEvidenceGate).mockResolvedValue([{ status: 'satisfied', report: 'all current obligations pass' }]);
    expect(await evaluatePlanAcceptanceGate('design-plan')).toMatchObject({ satisfied: true });
  });
  it('never borrows a shipped or exempt twin when the subject slug is ambiguous', async () => {
    mockPg.mockReturnValue(sqlReturning([
      { plan_slug: 'same-slug', harness_slug: 'a', status: 'shipped', template: 'rubric' },
      { plan_slug: 'same-slug', harness_slug: 'b', status: 'ready' },
    ]));
    expect(await evaluatePlanAcceptanceGate('same-slug')).toMatchObject({
      satisfied: false, code: 'acceptance_bar_contract_not_ready',
    });
    expect(mockRubrics).not.toHaveBeenCalled();
    expect(await evaluatePlanAcceptanceGate('same-slug', { harnessSlug: 'b' })).toMatchObject({
      satisfied: false, code: 'acceptance_rubric_missing',
    });
    expect(mockRubrics).toHaveBeenCalledWith('same-slug', { harnessSlug: 'b' });
    expect(mockBarLifecycle).toHaveBeenCalledWith('same-slug', 'ship', expect.objectContaining({ harnessSlug: 'b' }));
  });

  it('refuses an unresolved explicit subject instead of reading another harness rubric', async () => {
    mockPg.mockReturnValue(sqlReturning([
      { plan_slug: 'same-slug', harness_slug: 'a', status: 'shipped' },
    ]));
    expect(await evaluatePlanAcceptanceGate('same-slug', { harnessSlug: 'b' })).toMatchObject({
      satisfied: false, code: 'acceptance_bar_contract_not_ready',
    });
    expect(mockRubrics).not.toHaveBeenCalled();
  });

  it('flag OFF → satisfied, skipped:flag-off (no rubric read at all)', async () => {
    mockFlag.mockResolvedValue(false);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, skipped: 'flag-off' });
    expect(mockRubric).not.toHaveBeenCalled();
  });

  it('a rubric-template plan is exempt (no rubric-of-a-rubric)', async () => {
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'some-rubric', template: 'rubric', template_slug: null }]));
    const v = await evaluatePlanAcceptanceGate('some-rubric');
    expect(v).toMatchObject({ satisfied: true, skipped: 'rubric-template-plan' });
  });

  it('a scheduled template INSTANCE is exempt', async () => {
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'run-2026-08-11', template: null, template_slug: 'daily-ops' }]));
    const v = await evaluatePlanAcceptanceGate('run-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, skipped: 'template-instance' });
  });

  // EI-22078741539479611: the gate is a PRE-ship question. Asked of a plan that is
  // already shipped it used to answer `acceptance_rubric_missing` (the ship retired the
  // rubric) or `audit_coverage_stale` (a peer edited a cited file) — "cannot be marked
  // shipped" about a shipped plan, prescribing a repair that re-opens a settled gate.
  it('an ALREADY-SHIPPED plan → satisfied, skipped:already-shipped, naming the retired rubric', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        { plan_slug: 'some-plan-2026-08-11', template: null, template_slug: null, content: null, status: 'shipped' },
      ]),
    );
    // The ship retired the contract: the LIVE read finds nothing, the RETIRED read finds it.
    mockRubric.mockResolvedValue(null);
    rubricMocks.getRetiredAcceptanceRubricsForPlan.mockResolvedValue([acceptanceRubric({ status: 'retired' })]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, skipped: 'already-shipped', rubricId: 'ar-some-plan' });
    expect(v.code).toBeUndefined();
    expect(v.message).toContain('already shipped');
    expect(v.message).toContain("'ar-some-plan' was retired WITH the ship");
    expect(v.message).toMatch(/Do NOT author a replacement acceptance rubric/);
    // Short-circuited BEFORE the rubric family — the live read is never consulted.
    expect(mockRubrics).not.toHaveBeenCalled();
  });

  it('CONTROL: the same plan NOT yet shipped falls through to acceptance_rubric_missing', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        {
          plan_slug: 'some-plan-2026-08-11',
          template: null,
          template_slug: null,
          content: null,
          status: 'awaiting-acceptance',
        },
      ]),
    );
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_missing' });
    expect(rubricMocks.getRetiredAcceptanceRubricsForPlan).not.toHaveBeenCalled();
  });

  it('a shipped plan with NO rubric on record still skips, and says so instead of inventing one', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        { plan_slug: 'pre-gate-plan', template: null, template_slug: null, content: null, status: 'shipped' },
      ]),
    );
    const v = await evaluatePlanAcceptanceGate('pre-gate-plan');
    expect(v).toMatchObject({ satisfied: true, skipped: 'already-shipped' });
    expect(v.rubricId).toBeUndefined();
    expect(v.message).toContain('No acceptance rubric is on record');
  });

  it('refuses an ephemeral deliverable reference without a durable companion', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        {
          plan_slug: 'some-plan-2026-08-11',
          template: null,
          template_slug: null,
          content: '## Now\n\nThe detector docs are here.\nReport: https://claude.ai/code/artifact/abc123',
        },
      ]),
    );

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'ephemeral_deliverable_unbacked' });
    expect(v.message).toContain('claude.ai/code/artifact/abc123');
    expect(v.message).toContain("line 4, column 9");
    expect(v.message).toContain('durable companion/source reference');
    expect(v.message).toContain('not waived by');
  });

  it('locates a bare scratch directory reference when prose triggers the durability gate', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        {
          plan_slug: 'scratch-prose-plan',
          template: null,
          template_slug: null,
          content:
            '## Notes\n\nThe in-tree `.papercusp/scratch/` directory is deliberately not flagged by the sibling lint.',
        },
      ]),
    );

    const v = await evaluatePlanAcceptanceGate('scratch-prose-plan');
    expect(v).toMatchObject({ satisfied: false, code: 'ephemeral_deliverable_unbacked' });
    expect(v.message).toContain("scratch-path '.papercusp/scratch'");
    expect(v.message).toMatch(/line 3, column \d+/);
  });

  it('allows an ephemeral URL when the plan records its durable source path', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        {
          plan_slug: 'some-plan-2026-08-11',
          template: null,
          template_slug: null,
          content:
            'Report: https://claude.ai/code/artifact/abc123\nDurable source: `packages/reports/retraction-log.md`',
        },
      ]),
    );
    mockRubric.mockResolvedValue(null);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_missing' });
  });

  it('parses bare durable companion paths with extensions and trims sentence punctuation', () => {
    expect(findDurableDeliverableCompanions('durable source: report.md')).toEqual(['report.md']);
    expect(findDurableDeliverableCompanions('durable source: findings.csv')).toEqual(['findings.csv']);
    expect(findDurableDeliverableCompanions('durable source: docs/plans/x.md')).toEqual(['docs/plans/x.md']);
    expect(findDurableDeliverableCompanions('durable source: report.md.')).toEqual(['report.md']);
    expect(findDurableDeliverableCompanions('durable source: `report.md`')).toEqual(['report.md']);
  });

  it('does not let the code-truth force escape hatch bypass deliverable durability', async () => {
    mockPg.mockReturnValue(
      sqlReturning([
        {
          plan_slug: 'some-plan-2026-08-11',
          template: null,
          template_slug: null,
          content: 'Report: https://claude.ai/artifacts/abc123',
        },
      ]),
    );

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { force: { reason: 'owner waiver' } });
    expect(v).toMatchObject({ satisfied: false, code: 'ephemeral_deliverable_unbacked' });
  });

  describe('BAR missing-or-stale-grade recruitment', () => {
    // `staleGradingScorecardId` defaults to null: these cases describe a BAR whose
    // stale reading names a card OTHER than the ones under test (or none at all).
    // A case about the stale card ITSELF must pass its id, which is the whole
    // distinction WI-10002509 turns on.
    const verdict = (phase: AcceptanceBarLifecycleVerdict['phase'],
      codes: AcceptanceBarLifecycleVerdict['codes'],
      staleGradingScorecardId: string | null = null): AcceptanceBarLifecycleVerdict => ({
      phase, applicable: true, satisfied: codes.length === 0, codes,
      blockingBars: [], contractCodes: codes, codeAttribution: codes.map((code) => ({ code, barKeys: [] })),
      nextRepair: null, staleGradingScorecardId,
      message: codes.length ? 'BAR proof or grading is incomplete' : null,
    });

    it('records a narrow reasoned waiver for only inadequate or stale BAR proof metadata', async () => {
      mockPg.mockReturnValue(sqlReturning([{
        plan_slug: 'some-plan-2026-08-11', harness_slug: 'papercusp', template: null, template_slug: null,
        acceptance_bar_epoch: 1,
        content: '## Requirements\n\n**R-1 — Result.** The required result.\n',
      }]));
      mockBarLifecycle.mockResolvedValue(verdict('ship', [
        'bar_snapshot_proof_inadequate',
        'bar_snapshot_proof_stale',
      ]));
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([
        scorecard({ createdBy: 'su-implementer' }),
        scorecard({ createdBy: 'su-grader' }),
      ]);

      const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', {
        force: { reason: 'The proof metadata is stale; the waiver is recorded.', acceptanceBarProofMetadata: true },
      });

      expect(result.satisfied).toBe(true);
      expect(result.forcedPast).toMatchObject({
        reason: 'The proof metadata is stale; the waiver is recorded.',
        checks: ['bar_snapshot_proof_inadequate', 'bar_snapshot_proof_stale'],
      });
    });

    it('does not waive other BAR failures with the proof metadata option', async () => {
      mockPg.mockReturnValue(sqlReturning([{
        plan_slug: 'some-plan-2026-08-11', harness_slug: 'papercusp', template: null, template_slug: null,
        acceptance_bar_epoch: 1,
        content: '## Requirements\n\n**R-1 — Result.** The required result.\n',
      }]));
      mockBarLifecycle.mockResolvedValue(verdict('ship', [
        'bar_snapshot_proof_inadequate',
        'bar_snapshot_evidence_plane_unmet',
      ]));

      const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', {
        force: { reason: 'This reason does not waive unrelated BAR failures.', acceptanceBarProofMetadata: true },
      });

      expect(result).toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
      expect(result.forcedPast).toBeUndefined();
      expect(mockRubrics).not.toHaveBeenCalled();
    });

    it('does not activate the separate code-truth force with the metadata-only option', async () => {
      mockFlag.mockImplementation(async (flag) =>
        flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE || flag === FLAGS.PLAN_SPEC_COVERAGE_GATE,
      );
      mockPg.mockReturnValue(sqlReturning([{
        plan_slug: 'some-plan-2026-08-11', harness_slug: 'papercusp', template: null, template_slug: null,
        acceptance_bar_epoch: 1,
        content: '## Requirements\n\n**R-1 — Result.** The required result.\n',
      }]));
      mockBarLifecycle.mockResolvedValue(verdict('ship', ['bar_snapshot_proof_stale']));
      mockSpecCoverage.mockResolvedValue(coverageVerdict({
        satisfied: false,
        code: 'spec_proof_stale',
        wouldBlock: ['1-clause(s)-proven-only-at-a-superseded-revision'],
        message: 'A separate code-truth proof is stale.',
      }));

      const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', {
        force: { reason: 'This reason applies only to BAR proof metadata.', acceptanceBarProofMetadata: true },
      });

      expect(result).toMatchObject({ satisfied: false, code: 'spec_proof_stale' });
      expect(result.forcedPast).toBeUndefined();
    });

    it('requires original contract adoption for legacy Requirements even with an as-built rubric and force', async () => {
      mockPg.mockReturnValue(sqlReturning([{
        plan_slug: 'some-plan-2026-08-11', template: null, template_slug: null,
        acceptance_bar_epoch: null,
        content: '## Requirements\n- Users can bind a wallet and pay for usage.\n\n## Decisions\nD-045: modules are tested seams for a follow-on plan.',
      }]));
      mockBarLifecycle.mockResolvedValue({ ...verdict('ship', []), applicable: false });
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([scorecard()]);
      const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { force: { reason: 'seams disclosed' } });
      expect(result).toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
      expect(mockBarLifecycle).toHaveBeenCalledWith('some-plan-2026-08-11', 'ship', { expectedApplicable: true });
      expect(mockRubrics).not.toHaveBeenCalled();
    });

    it('keeps contract read failure blocking even when independent grading would pass', async () => {
      mockBarLifecycle.mockRejectedValue(new Error('contract source unavailable'));
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([scorecard()]);
      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { force: { reason: 'retry later' } }))
        .toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
      expect(mockRubrics).not.toHaveBeenCalled();
    });

    it('exposes the existing ungraded refusal after pre-grading is ready', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, phase === 'ship'
        ? ['bar_snapshot_grading_missing', 'bar_snapshot_evidence_plane_unmet', 'bar_snapshot_author_verdict_missing']
        : []));
      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11'))
        .toMatchObject({ satisfied: false, code: 'acceptance_ungraded' });
      expect(mockBarLifecycle).toHaveBeenCalledWith('some-plan-2026-08-11', 'pre-grading', { expectedApplicable: true });
    });

    it('does not recruit a grader while pre-grading proof remains inadequate', async () => {
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, phase === 'ship'
        ? ['bar_snapshot_proof_inadequate', 'bar_snapshot_grading_missing']
        : ['bar_snapshot_proof_inadequate']));
      const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true });
      expect(result).toMatchObject({
        satisfied: false, code: 'acceptance_bar_contract_not_ready', blockingPhase: 'pre-grading',
      });
      expect(mockScorecards).not.toHaveBeenCalled();
    });

    it.each(['bar_snapshot_grading_missing', 'bar_snapshot_grading_stale'] as const)(
      'uses the supplied current proof when %s defers to pre-grading (WI-10007726)',
      async (gradingCode) => {
        const current = [{
          planSlug: 'some-plan-2026-08-11',
          specId: 'AUTO-BAR-R-1-P-001',
          evidenceKind: 'test' as const,
          evidenceRef: 'test:measured-proof',
          sourceFingerprint: 'measured-current-source',
          environmentFingerprint: 'measured-current-runtime',
        }];
        mockRubric.mockResolvedValue(acceptanceRubric());
        mockScorecards.mockResolvedValue([]);
        mockBarLifecycle.mockImplementation(async (_slug, phase, options) =>
          verdict(phase, phase === 'ship'
            ? [gradingCode]
            : options?.current === current ? [] : ['bar_snapshot_proof_uncertain']));

        const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { current });

        expect(result).toMatchObject({ satisfied: false, code: 'acceptance_ungraded' });
        expect(mockBarLifecycle).toHaveBeenCalledWith('some-plan-2026-08-11', 'pre-grading', {
          expectedApplicable: true, current,
        });
      },
    );

    it('reuses one supplied BAR snapshot across ship and deferred pre-grading', async () => {
      const snapshot = Promise.resolve({} as never);
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase,
        phase === 'ship' ? ['bar_snapshot_grading_missing'] : []));

      const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', {
        acceptanceBarContractSnapshot: snapshot,
      });

      expect(result).toMatchObject({ satisfied: false, code: 'acceptance_ungraded' });
      const lifecycleCalls = mockBarLifecycle.mock.calls.filter((call) => call[1] === 'ship' || call[1] === 'pre-grading');
      expect(lifecycleCalls).toHaveLength(2);
      expect(lifecycleCalls[0]?.[2]).toMatchObject({ snapshot });
      expect(lifecycleCalls[1]?.[2]).toMatchObject({ snapshot });
    });

    it('threads explicit pending delivery only to pre-grading and retains the strict ship refusal', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([]);
      mockBarLifecycle.mockImplementation(async (_slug, phase, options) => verdict(phase,
        phase === 'ship' ? ['bar_snapshot_grading_missing', 'bar_snapshot_evidence_plane_unmet']
          : options?.pendingDeliveryBarKeys?.includes('R-15') ? [] : ['bar_snapshot_evidence_plane_unmet']));
      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { pendingDeliveryBarKeys: ['R-15'] }))
        .toMatchObject({ satisfied: false, code: 'acceptance_ungraded' });
      expect(mockBarLifecycle).toHaveBeenCalledWith('some-plan-2026-08-11', 'pre-grading', {
        expectedApplicable: true, pendingDeliveryBarKeys: ['R-15'],
      });
      const shipOptions = mockBarLifecycle.mock.calls.find((call) => call[1] === 'ship')?.[2];
      expect(shipOptions).not.toHaveProperty('pendingDeliveryBarKeys');
      // Once grading is present, the same missing public proof still blocks shipment.
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, ['bar_snapshot_evidence_plane_unmet']));
      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { pendingDeliveryBarKeys: ['R-15'] }))
        .toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready', blockingPhase: 'ship' });
    });

    // plan-verification-friction-reduction-2026-10-11 P-002 / R-2 (D-001): a ship call that
    // omits `current` must hand the lifecycle NO caller tuple. listSpecEvidence then
    // re-measures every binding from its recorded recipe, so unchanged proof rates current
    // on the server's own measurement (pinned in spec-evidence-store.test.ts). An empty or
    // placeholder `current` here would replace that measurement with caller blame.
    it('passes no caller fingerprints when the ship call omits current, so proof is server-measured (P-002)', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([]);
      mockBarLifecycle.mockImplementation(async (_slug, phase, options) =>
        verdict(phase, phase === 'ship'
          ? ['bar_snapshot_grading_missing']
          : options && 'current' in options ? ['bar_snapshot_proof_uncertain'] : []));

      const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

      expect(result).toMatchObject({ satisfied: false, code: 'acceptance_ungraded' });
      expect(mockBarLifecycle.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [, , options] of mockBarLifecycle.mock.calls) {
        expect(options).not.toHaveProperty('current');
      }
    });

    it('keeps caller-measured stale proof blocking at pre-grading (WI-10007726)', async () => {
      const current = [{
        planSlug: 'some-plan-2026-08-11',
        specId: 'AUTO-BAR-R-1-P-001',
        evidenceKind: 'test' as const,
        evidenceRef: 'test:measured-proof',
        sourceFingerprint: 'measured-changed-source',
      }];
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([]);
      mockBarLifecycle.mockImplementation(async (_slug, phase, options) =>
        verdict(phase, phase === 'ship'
          ? ['bar_snapshot_grading_missing', 'bar_snapshot_proof_stale']
          : options?.current === current ? ['bar_snapshot_proof_stale'] : []));

      const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { current });

      expect(result).toMatchObject({
        satisfied: false, code: 'acceptance_bar_contract_not_ready', blockingPhase: 'pre-grading',
      });
      expect(result.blockingPhaseLifecycle?.codes).toEqual(['bar_snapshot_proof_stale']);
      expect(mockScorecards).not.toHaveBeenCalled();
    });

    it('exposes the ungraded refusal when only a stale rubric-identity card exists', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric({ revision: 3 }));
      mockScorecards.mockResolvedValue([
        scorecard({ rubricRevision: 3, criteriaHash: 'criteria-hash-before-method-change' }),
      ]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, phase === 'ship'
        ? ['bar_snapshot_proof_inadequate', 'bar_snapshot_grading_stale', 'bar_snapshot_author_verdict_missing']
        : []));

      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true }))
        .toMatchObject({ satisfied: false, code: 'acceptance_ungraded', rubricId: 'ar-some-plan' });
      expect(mockBarLifecycle).toHaveBeenCalledWith('some-plan-2026-08-11', 'pre-grading', { expectedApplicable: true });
    });

    it('keeps the original BAR refusal if a current-revision card arrives after the stale snapshot', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric({ revision: 3 }));
      mockScorecards.mockResolvedValue([scorecard({ rubricRevision: 3 })]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, phase === 'ship'
        ? ['bar_snapshot_grading_stale', 'bar_snapshot_author_verdict_missing']
        : []));

      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true }))
        .toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
    });

    // WI-10002509: the cohort-stale dead end. The BAR stales a below-pass grading once
    // the evidence cohort moves under it, but the rubric REVISION never changed — so the
    // door's rubric-identity filter read the card as current, found a complete grading,
    // and returned its deferred BAR refusal forever. `acceptance_bar_not_met` /
    // `acceptance_bar_contract_not_ready` are outside ACCEPTANCE_GRADER_GATE_CODES, so
    // nothing recruited the re-grade the BAR lifecycle explicitly asks for.
    it('recruits a re-grade when the BAR staled the card by COHORT movement under an unchanged rubric', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric({ revision: 3 }));
      // Graded against THIS revision and this criteriaHash: rubric identity is current.
      mockScorecards.mockResolvedValue([scorecard({ issueId: 'EI-cohort-staled', rubricRevision: 3 })]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, phase === 'ship'
        ? ['bar_snapshot_grading_stale', 'bar_snapshot_author_verdict_missing']
        : [], phase === 'ship' ? 'EI-cohort-staled' : null));

      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true });

      expect(v).toMatchObject({ satisfied: false, code: 'acceptance_ungraded', rubricId: 'ar-some-plan' });
      // The code is what dispatches recruitment, and it must route to exactly ONE
      // independent grading — not a self-grade and not a parallel reviewer.
      expect(planAcceptanceRepairAction('some-plan-2026-08-11', v)).toMatchObject({ kind: 'independent-grading' });
    });

    // The anti-storm half of the same change: widening recruitment to every BAR refusal
    // would re-roll a grader on every ship attempt against a genuinely failing plan.
    // A `not-pass` BAR names no stale card, so the card survives and stays terminal.
    it('CONTROL: a genuine unchanged FAIL does not recruit — the card is not dropped', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric({ revision: 3 }));
      mockScorecards.mockResolvedValue([scorecard({ issueId: 'EI-honest-fail', rubricRevision: 3 })]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, phase === 'ship'
        ? ['bar_snapshot_grading_not_pass', 'bar_snapshot_author_verdict_missing']
        : []));

      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true });

      expect(v).toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
      expect(v.code).not.toBe('acceptance_ungraded');
    });

    // Dropping the cohort-staled card can leave an AUTHOR card standing, which lands on
    // `self_graded_only`. The code is right — a fresh independent grading is exactly what
    // is needed — but the stock wording ("only graded by its own author") is then FALSE:
    // a non-author did grade it, the grade merely went stale. Measured cost of that
    // ambiguity: an agent read the message, concluded no independent grader had ever
    // looked at the plan, and nearly filed a defect against a correctly-settled recruiter.
    it('names the STALE independent grading instead of claiming the plan was self-graded', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric({ revision: 3 }));
      mockScorecards.mockResolvedValue([
        // Independent (non-author) and current by rubric identity — dropped only because
        // the BAR named it cohort-stale.
        scorecard({ issueId: 'EI-cohort-staled', createdBy: 'su-grader', rubricRevision: 3 }),
        scorecard({
          issueId: 'EI-author-accept',
          createdBy: 'su-implementer',
          rubricRevision: 3,
          acceptance: { verdict: 'accept', reasoning: 'author call on record' },
        }),
      ]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) =>
        verdict(phase, phase === 'ship' ? ['bar_snapshot_grading_stale'] : [], phase === 'ship' ? 'EI-cohort-staled' : null));

      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true });

      expect(v).toMatchObject({ satisfied: false, code: 'self_graded_only', rubricId: 'ar-some-plan' });
      // The message must name the real repair and the real card...
      expect(v.message).toContain('EI-cohort-staled');
      expect(v.message).toContain('su-grader');
      expect(v.message).toContain('FRESH independent grading');
      // ...and must NOT assert the thing that is false here.
      expect(v.message).not.toContain('is only graded by its own author');
      expect(v.message).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
    });

    // WI-10003434: excluding ONLY the cohort-staled card let an OLDER independent card at
    // the same rubric revision become authoritative. It predates the cohort move too, and
    // its worse ratings returned the NON-recruiting `acceptance_bar_not_met` — measured on
    // identities-v1-2026-08-30, where a 09-24 card's 'partial' ratings resurfaced after the
    // 09-27 re-grade went cohort-stale. A plan graded twice at one revision could never be
    // re-graded again.
    const outcomeRubric = () =>
      acceptanceRubric({
        revision: 3,
        criteria: [
          {
            key: 'k1',
            title: 'Outcome holds',
            model: 'The outcome holds.',
            method: 'Run the bound check.',
            driftMarkers: 'The check fails.',
            role: 'outcome',
            barKey: 'R-1',
            mandatory: true,
            passRatings: ['pass'],
          },
        ] as unknown as Rubric['criteria'],
      });

    it('an OLDER independent card never outlives the cohort-stale card: the re-grade still recruits', async () => {
      mockRubric.mockResolvedValue(outcomeRubric());
      mockScorecards.mockResolvedValue([
        scorecard({
          issueId: 'EI-cohort-staled',
          createdAt: '2026-08-11T02:00:00Z',
          createdBy: 'su-grader',
          rubricRevision: 3,
        }),
        scorecard({
          issueId: 'EI-older-round',
          createdAt: '2026-08-11T01:00:00Z',
          createdBy: 'su-earlier-grader',
          rubricRevision: 3,
          ratings: { k1: { rating: 'partial', evidence: 'failed before the first repair round' } },
        }),
      ]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) =>
        verdict(phase, phase === 'ship' ? ['bar_snapshot_grading_stale'] : [], phase === 'ship' ? 'EI-cohort-staled' : null));

      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true });

      expect(v.code).not.toBe('acceptance_bar_not_met');
      expect(v).toMatchObject({ satisfied: false, code: 'self_graded_only', rubricId: 'ar-some-plan' });
      expect(v.message).toContain('EI-cohort-staled');
      expect(v.message).toContain('FRESH independent grading');
      expect(planAcceptanceRepairAction('some-plan-2026-08-11', v)).toMatchObject({ kind: 'independent-grading' });
      // WI-10003286: the recruiter must exclude EVERY card this gate excluded, not only the
      // named one — handed just 'EI-cohort-staled', its settlement read fell back to
      // 'EI-older-round' and reported "settled", so no fresh grader was ever dispatched
      // (measured on managed-agent-capability-contract-and-native-cutover-2026-09-13).
      expect(v.staleGradingScorecardId).toBe('EI-cohort-staled');
      expect([...(v.staleGradingScorecardIds ?? [])].sort()).toEqual(['EI-cohort-staled', 'EI-older-round']);
    });

    // CONTROL: the exclusion is bounded by the stale card's grading time. A card graded
    // AFTER it saw the moved cohort, so it must keep its authority — otherwise every fresh
    // re-grade would itself be discarded and the plan would recruit forever.
    it('CONTROL: an independent card graded AFTER the cohort-stale card keeps its authority', async () => {
      mockRubric.mockResolvedValue(outcomeRubric());
      mockScorecards.mockResolvedValue([
        scorecard({
          issueId: 'EI-fresh-regrade',
          createdAt: '2026-08-11T03:00:00Z',
          createdBy: 'su-fresh-grader',
          rubricRevision: 3,
          ratings: { k1: { rating: 'partial', evidence: 'still failing after the repair' } },
        }),
        scorecard({
          issueId: 'EI-cohort-staled',
          createdAt: '2026-08-11T02:00:00Z',
          createdBy: 'su-grader',
          rubricRevision: 3,
        }),
      ]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) =>
        verdict(phase, phase === 'ship' ? ['bar_snapshot_grading_stale'] : [], phase === 'ship' ? 'EI-cohort-staled' : null));

      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true });

      expect(v).toMatchObject({ satisfied: false, code: 'acceptance_bar_not_met', gradedBy: 'su-fresh-grader' });
    });

    // CONTROL: the stock self-graded wording must survive for the case it IS true of,
    // or the branch above is just an unconditional message swap.
    it('CONTROL: a genuinely self-graded plan keeps the self-graded wording', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric({ revision: 3 }));
      mockScorecards.mockResolvedValue([
        scorecard({ issueId: 'EI-self', createdBy: 'su-implementer', rubricRevision: 3 }),
      ]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, [], null));

      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { gradingRecruitment: true });

      expect(v).toMatchObject({ satisfied: false, code: 'self_graded_only' });
      expect(v.message).toContain('is only graded by its own author');
      expect(v.message).not.toContain('FRESH independent grading');
    });

    it('does not recruit through incomplete METHOD or vetting prerequisites', async () => {
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase,
        phase === 'ship' ? ['bar_snapshot_grading_missing', 'bar_snapshot_method_missing'] : ['bar_snapshot_method_missing']));
      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11'))
        .toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
      expect(mockRubrics).not.toHaveBeenCalled();
    });

    // P-038 (review-system-rework-reduction-2026-09-23, R-9): measured friction on
    // consult-expert-routing-2026-09-22 — six ship codes, while the one repair that unblocked
    // was pre-grading's bar_snapshot_vetting_missing. The refusal must NAME that phase and carry
    // its verdict, not make the caller re-probe.
    it('names the blocking pre-grading phase, its codes per BAR, and its next repair (P-038)', async () => {
      const shipCodes: AcceptanceBarLifecycleVerdict['codes'] = [
        'bar_snapshot_evidence_plane_unmet', 'bar_snapshot_proof_stale', 'bar_snapshot_proof_depth_missing',
        'bar_snapshot_vetting_missing', 'bar_snapshot_grading_missing', 'bar_snapshot_author_verdict_missing',
      ];
      mockBarLifecycle.mockImplementation(async (_slug, phase) => phase === 'ship'
        ? verdict('ship', shipCodes)
        : {
            ...verdict('pre-grading', ['bar_snapshot_vetting_missing']),
            blockingBars: [{ barKey: 'R-1', codes: ['bar_snapshot_proof_stale'], contract: 'automated' as const }],
            nextRepair: { code: 'bar_snapshot_vetting_missing', barKey: null, action: 'Vet the current rubric revision' },
          });
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
      expect(v).toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready', blockingPhase: 'pre-grading' });
      expect(v.blockingPhaseLifecycle?.codes).toEqual(['bar_snapshot_vetting_missing']);
      expect(v.blockingPhaseLifecycle?.nextRepair?.code).toBe('bar_snapshot_vetting_missing');
      expect(v.blockingPhaseLifecycle?.blockingBars).toEqual([
        { barKey: 'R-1', codes: ['bar_snapshot_proof_stale'], contract: 'automated' },
      ]);
      // The ship-phase list is still carried in full; the message LEADS with the unblocking repair.
      expect(v.acceptanceBarLifecycle?.codes).toEqual(shipCodes);
      expect(v.message?.startsWith('BLOCKED AT PRE-GRADING')).toBe(true);
      expect(v.message).toContain('NEXT REPAIR: Vet the current rubric revision');
      expect(mockRubrics).not.toHaveBeenCalled();
    });

    it('a ship refusal that never deferred names the ship phase and carries no pre-grading verdict (P-038)', async () => {
      mockBarLifecycle.mockResolvedValue(verdict('ship', ['bar_snapshot_evidence_plane_unmet']));
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
      expect(v).toMatchObject({ satisfied: false, blockingPhase: 'ship' });
      expect(v.blockingPhaseLifecycle).toBeUndefined();
    });

    it('keeps a proof-only ship refusal at the BAR boundary', async () => {
      mockBarLifecycle.mockResolvedValue(verdict('ship', ['bar_snapshot_evidence_plane_unmet']));
      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11'))
        .toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
      expect(mockBarLifecycle).toHaveBeenCalledTimes(1);
    });

    it('cannot ship if a grade arrives after the initial BAR snapshot', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([scorecard()]);
      mockBarLifecycle.mockImplementation(async (_slug, phase) => verdict(phase, phase === 'ship'
        ? ['bar_snapshot_grading_missing', 'bar_snapshot_evidence_plane_unmet'] : []));
      expect(await evaluatePlanAcceptanceGate('some-plan-2026-08-11'))
        .toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
    });
  });

  it('no acceptance rubric → acceptance_rubric_missing with the propose recipe', async () => {
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('acceptance_rubric_missing');
    expect(v.message).toContain("rubrics:propose { kind:'acceptance'");
    expect(v.message).toContain('some-plan-2026-08-11');
    expect(v.message).toContain('plan-class-investigation');
  });

  it('multiple active acceptance rubrics → fails closed before grading either one', async () => {
    mockRubrics.mockResolvedValue([
      acceptanceRubric({ rubricId: 'ar-first' }),
      acceptanceRubric({ rubricId: 'ar-second' }),
    ]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_ambiguous' });
    expect(v.message).toContain('ar-first');
    expect(v.message).toContain('ar-second');
    expect(mockScorecards).not.toHaveBeenCalled();
  });

  it('rubric present but ungraded → acceptance_ungraded naming the rubric + implementer', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_ungraded', rubricId: 'ar-some-plan' });
    expect(v.message).toContain('su-implementer');
    expect(v.message).toContain('scorecards:emit');
    // EI-20249725405239230: naming the tool is what already FAILED to prevent a
    // decline. The author must be handed the claim/admission guarantee so they
    // can state it when routing by hand — the measured peer declined twice on
    // exactly the constraint this sentence denies.
    expect(v.message).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
  });

  it('incomplete or synthesized scorecards do NOT satisfy (still acceptance_ungraded)', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({ missingKeys: ['k1'] }),
      scorecard({ synthesized: true }),
      scorecard({ rubricResolved: false }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_ungraded' });
  });

  it('only self-graded → self_graded_only (grader ≠ implementer, D-005)', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([scorecard({ createdBy: 'su-implementer' })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'self_graded_only', rubricId: 'ar-some-plan' });
    expect(v.message).toContain('su-implementer');
    // Both author-facing refusals mean "go find a non-implementer", so both owe
    // the author the same guarantee (EI-20249725405239230).
    expect(v.message).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
  });

  it('an independent complete grading satisfies the gate and names the grader', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({ createdBy: 'su-implementer' }),
      scorecard({ createdBy: 'su-grader' }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, rubricId: 'ar-some-plan', gradedBy: 'su-grader' });
  });

  it('excludes principal plan implementers while preserving the acceptance-author seat', async () => {
    mockRubric.mockResolvedValue(
      acceptanceRubric({
        createdBy: 'su-acceptance-author',
        proposedBy: 'su-repair-proposer',
        subjectPlan: 'some-plan-2026-08-11',
      }),
    );
    mockPlanImplementers.mockResolvedValue(['su-plan-implementer']);
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-plan-implementer',
        createdAt: '2026-08-21T03:00:00Z',
        createdBy: 'su-plan-implementer',
      }),
      scorecard({
        issueId: 'EI-author-accept',
        createdAt: '2026-08-21T04:00:00Z',
        createdBy: 'su-acceptance-author',
        acceptance: { verdict: 'accept', reasoning: 'The independent grading meets the plan.' },
      }),
    ]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({
      satisfied: false,
      code: 'self_graded_only',
    });
    expect(v.message).toContain('su-plan-implementer');
  });

  it('keeps a genuinely independent grader when a principal implementer also graded', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockPlanImplementers.mockResolvedValue(['su-plan-implementer']);
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-plan-implementer',
        createdAt: '2026-08-21T03:00:00Z',
        createdBy: 'su-plan-implementer',
      }),
      scorecard({
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
      }),
      scorecard({
        issueId: 'EI-author-accept',
        createdAt: '2026-08-21T04:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'The independent grading meets the plan.' },
      }),
    ]);

    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-grader',
    });
  });

  it('fails closed with a named refusal when the full implementer/auditor lineage is unreadable', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockPlanImplementers.mockRejectedValueOnce(new Error('worked_by_history is not an array'));
    mockScorecards.mockResolvedValue([scorecard({ createdBy: 'su-grader' })]);

    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: false,
      code: 'acceptance_lineage_unreadable',
      rubricId: 'ar-some-plan',
    });
  });

  it('satisfies the process gate but reports criteria rated UNKNOWN by the authoritative grader', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({
        createdBy: 'su-grader',
        ratings: { k1: { rating: 'unknown', evidence: 'not measurable in this window' } },
      }),
    ]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(v).toMatchObject({
      satisfied: true,
      rubricId: 'ar-some-plan',
      gradedBy: 'su-grader',
      unknownRatedCriteria: ['k1'],
    });
  });

  it('RED BASELINE: a passed disclosure and author accept cannot waive an unmet mandatory outcome bar', async () => {
    mockRubric.mockResolvedValue(
      acceptanceRubric({
        criteria: [
          {
            key: 'activation-outcome',
            title: 'Coverage activation exists',
            model: 'The code-to-test activation path produces coverage-evidence rows.',
            method: 'Read the activation instrument and the resulting coverage-evidence rows.',
            driftMarkers: 'No rows exist for the activation path.',
            role: 'outcome',
            barKey: 'R-7',
            mandatory: true,
          },
          {
            key: 'activation-shortfall-disclosed',
            title: 'Activation shortfall is disclosed',
            model: 'Any activation shortfall is reported accurately.',
            method: 'Read the completion report.',
            driftMarkers: 'The report overstates activation.',
            role: 'disclosure',
            coversBarKeys: ['R-7'],
            mandatory: false,
          },
        ] as unknown as Rubric['criteria'],
      }),
    );
    const ratings = {
      'activation-outcome': { rating: 'unknown', evidence: 'The required coverage-evidence rows do not exist.' },
      'activation-shortfall-disclosed': { rating: 'pass', evidence: 'The completion report names the shortfall.' },
    };
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-independent-disclosure-pass',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        ratings,
        nKeys: 2,
      }),
      scorecard({
        issueId: 'EI-author-accepts-disclosure',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        ratings,
        nKeys: 2,
        acceptance: {
          verdict: 'accept',
          reasoning: 'The disclosure is accurate even though the activation outcome is unproven.',
        },
      }),
    ]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(v).toMatchObject({
      satisfied: false,
      code: 'acceptance_bar_not_met',
      rubricId: 'ar-some-plan',
      gradedBy: 'su-grader',
    });
    expect(v.message).toContain('activation-outcome');
  });

  it('a new independent grading without an implementer verdict refuses acceptance_not_recorded', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([scorecard({ createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({
      satisfied: false,
      code: 'acceptance_not_recorded',
      rubricId: 'ar-some-plan',
      gradedBy: 'su-grader',
      gradingRef: 'EI-1',
      repairAction: {
        kind: 'author-verdict',
        nextVerb: { name: 'scorecards:get', args: { issueId: 'EI-1' } },
      },
    });
    // WI-10001843: the refusal must name the repair verb's COMPLETE contract. Advertising
    // only 'accept'|'reject' omitted the third valid enum value and steered the reader toward
    // a plain 'accept' even when delivery was still held open — the exact overclaim
    // 'accept-pending-delivery' exists to prevent. Pin all three so the omission cannot return.
    expect(v.message).toContain("acceptance:{ verdict:'accept'|'accept-pending-delivery'|'reject'");
    expect(v.message).toContain('accept-pending-delivery');
  });

  describe('WI-2141007 — acceptance seat inherited from a dead rubric author', () => {
    const seat = {
      succeededFrom: 'su-implementer',
      authorSessionState: 'ended',
      basisWorkItemId: 'WI-1687546',
      basisPlanSlug: 'some-plan-2026-08-11',
      succeededAt: '2026-08-21T02:00:00Z',
    };

    it('accepts a SUCCESSOR verdict whose seat names this rubric author — the plan is no longer bricked', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([
        scorecard({
          issueId: 'EI-successor-accept',
          createdAt: '2026-08-21T02:00:00Z',
          createdBy: 'su-successor',
          acceptance: { verdict: 'accept', reasoning: 'Read the independent grading; it meets the plan.', seat },
        }),
        scorecard({ issueId: 'EI-independent', createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' }),
      ]);
      await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
        satisfied: true,
        gradedBy: 'su-grader',
      });
    });

    it('honors a successor REJECT the same way an author reject is honored', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([
        scorecard({
          issueId: 'EI-successor-reject',
          createdAt: '2026-08-21T02:00:00Z',
          createdBy: 'su-successor',
          acceptance: { verdict: 'reject', reasoning: 'The grading rests on a falsified instrument.', seat },
        }),
        scorecard({ issueId: 'EI-independent', createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' }),
      ]);
      await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
        satisfied: false,
        code: 'acceptance_rejected',
      });
    });

    it('SAFETY: a successor verdict cannot double as its own independent grading', async () => {
      // The whole point of the seat rails: authority to ACCEPT must never also
      // supply the independence being accepted. With only the successor's card
      // on record there is no independent grading at all — and `self_graded_only`
      // is the precise refusal, which is itself the evidence that the successor
      // was classified as AUTHOR-side rather than silently counted as its own
      // independent grader (the failure mode this repair could most easily have
      // introduced).
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([
        scorecard({
          issueId: 'EI-successor-only',
          createdAt: '2026-08-21T02:00:00Z',
          createdBy: 'su-successor',
          acceptance: { verdict: 'accept', reasoning: 'Accepting my own grading.', seat },
        }),
      ]);
      await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
        satisfied: false,
        code: 'self_graded_only',
      });
    });

    it('CONTROL (falsifiability): a seat naming a DIFFERENT author carries no authority here', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([
        scorecard({
          issueId: 'EI-foreign-seat',
          createdAt: '2026-08-21T02:00:00Z',
          createdBy: 'su-successor',
          acceptance: {
            verdict: 'accept',
            reasoning: 'Seat inherited from some other plan’s author.',
            seat: { ...seat, succeededFrom: 'su-unrelated-author' },
          },
        }),
        scorecard({ issueId: 'EI-independent', createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' }),
      ]);
      await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
        satisfied: false,
        code: 'acceptance_not_recorded',
      });
    });

    it('CONTROL (falsifiability): the same card WITHOUT a seat stamp is still not an author verdict', async () => {
      mockRubric.mockResolvedValue(acceptanceRubric());
      mockScorecards.mockResolvedValue([
        scorecard({
          issueId: 'EI-unstamped',
          createdAt: '2026-08-21T02:00:00Z',
          createdBy: 'su-successor',
          acceptance: { verdict: 'accept', reasoning: 'No seat succession was recorded.' },
        }),
        scorecard({ issueId: 'EI-independent', createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' }),
      ]);
      await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
        satisfied: false,
        code: 'acceptance_not_recorded',
      });
    });
  });

  it('teaches verdict-only acceptance of the independent grade', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({ issueId: 'EI-independent', createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' }),
    ]);
    const result = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(result).toMatchObject({ satisfied: false, code: 'acceptance_not_recorded' });
    expect(result.message).toContain("acceptanceOf:'EI-independent'");
    expect(result.message).not.toContain('ratings:{');
  });

  it('a post-grading implementer accept satisfies and a newer reject refuses', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    const independent = scorecard({ createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' });
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-accept',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets the plan.' },
      }),
      independent,
    ]);
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-grader',
    });

    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-reject',
        createdAt: '2026-08-21T03:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'reject', reasoning: 'The regression evidence remains unresolved.' },
      }),
      independent,
    ]);
    const rejected = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(rejected).toMatchObject({ satisfied: false, code: 'acceptance_rejected' });
    expect(rejected.message).toContain('regression evidence remains unresolved');
  });

  // WI-10004135 — measured on p2p-work-distribution-2026-07-02: a plan outside the
  // acceptance-BAR contract read satisfied:true on an 'accept-pending-delivery' verdict
  // while its live criterion was rated unknown. Nothing else blocks on that evidence
  // for such a plan, so the verdict itself must.
  describe('accept-pending-delivery outside the acceptance-BAR contract (WI-10004135)', () => {
    const liveRubric = () =>
      acceptanceRubric({
        criteria: [
          { key: 'k1', title: 'K1', model: '', method: '', driftMarkers: '' },
          {
            key: 'live1',
            title: 'Live journey proven on the rig',
            model: '',
            method: '',
            driftMarkers: '',
            evidencePlane: 'live',
          } as Rubric['criteria'][number],
        ],
      });
    const liveRatings = {
      k1: { rating: 'pass', evidence: 'tree verified' },
      live1: { rating: 'unknown', evidence: 'no banked two-machine run' },
    };
    const independent = () =>
      scorecard({
        issueId: 'EI-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        ratings: liveRatings,
        nKeys: 2,
      });
    const authorCard = (issueId: string, createdAt: string, verdict: 'accept' | 'accept-pending-delivery') =>
      scorecard({
        issueId,
        createdAt,
        createdBy: 'su-implementer',
        ratings: liveRatings,
        nKeys: 2,
        acceptance: { verdict, reasoning: `${verdict}: the live run is the outstanding obligation.` },
      });

    it('refuses the ship and names the undelivered deployed/live criterion', async () => {
      mockRubric.mockResolvedValue(liveRubric());
      mockScorecards.mockResolvedValue([
        authorCard('EI-pending', '2026-08-21T02:00:00Z', 'accept-pending-delivery'),
        independent(),
      ]);
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
      expect(v).toMatchObject({
        satisfied: false,
        code: 'acceptance_pending_delivery',
        gradingRef: 'EI-independent',
        gradedBy: 'su-grader',
        pendingDeliveryCriteria: ['live1'],
        unknownRatedCriteria: ['live1'],
      });
      expect(v.message).toContain('outside the acceptance-BAR contract');
      expect(v.message).toContain("acceptanceOf:'EI-independent'");
      expect(planAcceptanceRepairAction('some-plan-2026-08-11', v)).toMatchObject({
        kind: 'author-verdict',
        repairVerb: 'scorecards:emit',
      });
    });

    it('a newer author accept, recorded once delivery is banked, clears the refusal', async () => {
      mockRubric.mockResolvedValue(liveRubric());
      mockScorecards.mockResolvedValue([
        authorCard('EI-accept', '2026-08-21T03:00:00Z', 'accept'),
        authorCard('EI-pending', '2026-08-21T02:00:00Z', 'accept-pending-delivery'),
        independent(),
      ]);
      await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
        satisfied: true,
        gradedBy: 'su-grader',
      });
    });

    it('inside the BAR contract the verdict does not block: the BAR owns the delivery evidence', async () => {
      mockBarLifecycle.mockResolvedValue({
        phase: 'ship',
        applicable: true,
        satisfied: true,
        codes: [],
        blockingBars: [],
        contractCodes: [],
        codeAttribution: [],
        nextRepair: null,
        staleGradingScorecardId: null,
        message: null,
      });
      mockRubric.mockResolvedValue(liveRubric());
      mockScorecards.mockResolvedValue([
        authorCard('EI-pending', '2026-08-21T02:00:00Z', 'accept-pending-delivery'),
        independent(),
      ]);
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
      expect(v).toMatchObject({ satisfied: true });
      expect(v.code).toBeUndefined();
    });
  });

  it('honors a legacy independent grading directly superseded by the standing author acceptance card', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    const independent = scorecard({
      issueId: 'EI-independent',
      createdAt: '2026-08-21T01:00:00Z',
      createdBy: 'su-grader',
      supersededBy: 'EI-author-accept',
    });
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-author-accept',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        supersedes: independent.issueId,
        acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets the plan.' },
      }),
      independent,
    ]);

    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-grader',
    });
    expect(mockScorecards).toHaveBeenCalledWith({
      rubricRef: 'ar-some-plan',
      limit: 50,
      includeSuperseded: true,
    });
  });

  it('does not revive an unrelated superseded grading outside a standing author-verdict lineage', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-author-accept',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'Author-only evidence is insufficient.' },
      }),
      scorecard({
        issueId: 'EI-old-independent',
        createdAt: '2026-08-21T01:00:00Z',
        createdBy: 'su-grader',
        supersededBy: 'EI-unrelated-correction',
      }),
    ]);

    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: false,
      code: 'self_graded_only',
    });
  });

  it('accepts an audited successor verdict but never counts that successor as the independent grader', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockLineageRelated.mockImplementation(
      async (author, candidate) =>
        author === candidate || (author === 'su-implementer' && candidate === 'su-successor'),
    );
    const successorVerdict = scorecard({
      issueId: 'EI-successor-accept',
      createdAt: '2026-08-21T02:00:00Z',
      createdBy: 'su-successor',
      acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets the plan.' },
    });
    mockScorecards.mockResolvedValue([
      successorVerdict,
      scorecard({ createdAt: '2026-08-21T01:00:00Z', createdBy: 'su-grader' }),
    ]);
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-grader',
    });

    mockScorecards.mockResolvedValue([successorVerdict]);
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: false,
      code: 'self_graded_only',
    });
  });

  it('an implementer verdict filed before independent grading does not count', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({ createdAt: '2026-08-21T03:00:00Z', createdBy: 'su-grader' }),
      scorecard({
        issueId: 'EI-early-accept',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'Filed before the independent card.' },
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_not_recorded' });
  });

  it('a newer independent grading invalidates an older accept and legacy grading', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({
        issueId: 'EI-new-grading',
        createdAt: '2026-08-21T03:00:00Z',
        createdBy: 'su-new-grader',
      }),
      scorecard({
        issueId: 'EI-old-accept',
        createdAt: '2026-08-21T02:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'The earlier grading met the plan.' },
      }),
      scorecard({
        issueId: 'EI-legacy-grading',
        createdAt: '2026-08-11T01:00:00Z',
        createdBy: 'su-old-grader',
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({
      satisfied: false,
      code: 'acceptance_not_recorded',
      gradedBy: 'su-new-grader',
    });
  });

  it('grandfathers complete independent gradings created before the rollout boundary', async () => {
    expect(Date.parse(scorecard().createdAt)).toBeLessThan(Date.parse(ACCEPTANCE_VERDICT_REQUIRED_AFTER));
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([scorecard({ createdBy: 'su-grader', acceptance: undefined })]);
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-grader',
    });
  });

  it('flag read failure degrades toward ON (the gate still applies)', async () => {
    mockFlag.mockImplementation(async (flag) => {
      if (flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE) throw new Error('flags backend down');
      return false;
    });
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_missing' });
  });

  it('a failed plan read cannot establish whether the original requirements are fulfilled', async () => {
    mockPg.mockImplementation(() => {
      throw new Error('pg down');
    });
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
    expect(v.message).toContain('pg down');
  });
});

describe('the floor-aware grader pick (unified-responder-selection-critique-and-grading-2026-08-30 P-004)', () => {
  // Grading is a cascade of up to two graders (D-003 [owner]) and the second may
  // be a below-floor minimum-fill (D-002 [owner]). These cases are about the one
  // residual D-003 names: latest-wins would otherwise hand the verdict to the
  // party the router did NOT match.
  const floorCard = scorecard({ issueId: 'EI-floor', createdAt: '2026-08-25T01:00:00Z', createdBy: 'su-floor' });
  const minimumCard = scorecard({ issueId: 'EI-min', createdAt: '2026-08-25T03:00:00Z', createdBy: 'su-min' });
  const implementerAccept = scorecard({
    issueId: 'EI-accept',
    createdAt: '2026-08-25T02:00:00Z',
    createdBy: 'su-implementer',
    acceptance: { verdict: 'accept', reasoning: 'The independent grading meets the plan.' },
  });

  beforeEach(() => {
    mockRubric.mockResolvedValue(acceptanceRubric());
  });

  it('a LATER minimum-fill card does not supersede the floor grading the implementer accepted', async () => {
    mockScorecards.mockResolvedValue([minimumCard, implementerAccept, floorCard]);
    mockGraderVia.mockResolvedValue(
      new Map([
        ['su-floor', 'floor' as const],
        ['su-min', 'minimum' as const],
      ]),
    );
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-floor',
      gradedVia: 'floor',
    });
  });

  it('CONTROL (falsifiability, in-test — no tree mutation): relabel that same minimum-fill as ABOVE the floor and the identical fixture refuses', async () => {
    // Nothing changes but one label. Under plain latest-wins the case above
    // would already produce THIS verdict, so the pair proves the floor card wins
    // there because of its selection provenance and not because of its dates.
    mockScorecards.mockResolvedValue([minimumCard, implementerAccept, floorCard]);
    mockGraderVia.mockResolvedValue(
      new Map([
        ['su-floor', 'floor' as const],
        ['su-min', 'floor' as const],
      ]),
    );
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_not_recorded', gradedBy: 'su-min' });
  });

  it('an above-floor grading arriving SECOND does supersede — and re-opens the implementer verdict it post-dates', async () => {
    // The mirror image, and the case the rule actually improves: the cascade woke
    // grader 2, grader 2 cleared the floor, and the accept recorded against the
    // below-floor first card no longer covers the grading that now stands.
    mockScorecards.mockResolvedValue([
      scorecard({ issueId: 'EI-min-first', createdAt: '2026-08-25T01:00:00Z', createdBy: 'su-min' }),
      scorecard({
        issueId: 'EI-accept-early',
        createdAt: '2026-08-25T02:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'Accepted against the first grading.' },
      }),
      scorecard({ issueId: 'EI-floor-second', createdAt: '2026-08-25T03:00:00Z', createdBy: 'su-floor' }),
    ]);
    mockGraderVia.mockResolvedValue(
      new Map([
        ['su-min', 'minimum' as const],
        ['su-floor', 'floor' as const],
      ]),
    );
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({
      satisfied: false,
      code: 'acceptance_not_recorded',
      gradedBy: 'su-floor',
      gradedVia: 'floor',
    });
  });

  it('where NO above-floor grader exists the minimum-fill grading still satisfies — and the verdict discloses it', async () => {
    // D-002 accepts this knowingly and asks that it not be rediscovered as a
    // surprise: the ship is allowed, and the reader is told the grading behind
    // it came from a peer the router did not match.
    mockScorecards.mockResolvedValue([
      minimumCard,
      scorecard({
        issueId: 'EI-accept-min',
        createdAt: '2026-08-25T04:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'Below-floor grading read and accepted.' },
      }),
    ]);
    mockGraderVia.mockResolvedValue(new Map([['su-min', 'minimum' as const]]));
    await expect(evaluatePlanAcceptanceGate('some-plan-2026-08-11')).resolves.toMatchObject({
      satisfied: true,
      gradedBy: 'su-min',
      gradedVia: 'minimum',
    });
  });

  it('a grading with no cascade provenance reports gradedVia:null — ranked AS floor, never asserted to BE floor', async () => {
    mockScorecards.mockResolvedValue([floorCard, implementerAccept]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, gradedBy: 'su-floor' });
    expect(v.gradedVia).toBeNull();
  });

  it('reads the provenance for THIS rubric, in the RUBRIC’s workspace rather than the ambient one', async () => {
    mockScorecards.mockResolvedValue([floorCard, implementerAccept]);
    await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(mockGraderVia).toHaveBeenCalledWith('test-ws', 'ar-some-plan');
  });
});

describe('the vetting check (consult-min-max-and-rubric-vetting-2026-08-17 P-004)', () => {
  /** A complete vetting scorecard: meta-rubric grading of the acceptance rubric,
   *  self-emitted by the AUTHOR (self-vetting is the design — the external critique
   *  comes from the linked consult, not from grader independence). */
  const metaVettingCard = (over: Partial<ScorecardRow> = {}): ScorecardRow =>
    scorecard({
      issueId: 'EI-vet',
      rubricRef: 'meta-acceptance-rubric',
      createdBy: 'su-implementer',
      subject: { kind: 'rubric', ref: 'ar-some-plan' },
      vetting: { consultId: 'conv-vet-1', rubricRevision: 7, criteriaHash: 'criteria-hash-current' },
      ...over,
    });

  /** Scorecard store split by rubric: meta cards for the meta-rubric read, an
   *  independent complete acceptance grading for everything else (so the ONLY
   *  variable under test is the vetting state). */
  const stockScorecards = (metaCards: ScorecardRow[], acceptanceCards?: ScorecardRow[]) => {
    mockScorecards.mockImplementation(async (filter?: { rubricRef?: string; subjectRef?: string }) => {
      if (filter?.rubricRef === 'meta-acceptance-rubric') {
        return filter.subjectRef ? metaCards.filter((card) => card.subject?.ref === filter.subjectRef) : metaCards;
      }
      return acceptanceCards ?? [scorecard({ createdBy: 'su-grader' })];
    });
  };

  beforeEach(() => {
    mockFlag.mockImplementation(
      async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE || flag === FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE,
    );
    mockRubric.mockResolvedValue(acceptanceRubric());
    // The meta-rubric is REGISTERED but deliberately still 'proposed': the gate must
    // tolerate it (ratification governs content authority, not gate mechanics) or the
    // whole ship gate deadlocks on the owner's ratification.
    mockGetRubric.mockResolvedValue(
      acceptanceRubric({ rubricId: 'meta-acceptance-rubric', kind: 'standard', subjectPlan: null, status: 'proposed' }),
    );
    mockRevision.mockResolvedValue(7);
    mockPg.mockReturnValue(sqlReturning([{ plan_slug: 'some-plan-2026-08-11', template: null, template_slug: null }]));
  });

  it('refuses acceptance_rubric_unvetted when no meta-scorecard exists — even with an independent acceptance grading already filed', async () => {
    stockScorecards([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted', rubricId: 'ar-some-plan' });
    // The refusal is the teaching surface: it must name the full flow.
    expect(v.message).toContain('Current independent critique is read directly');
    expect(v.message).toContain('criteriaHash');
    expect(v.message).toContain('consult:get_feedback');
  });

  it('names the paused scorecard owner when a pending grade audit blocks plan ship', async () => {
    const suppression = {
      reason: 'workspace-wide-loop-standdown' as const,
      pausedOwnerCount: 7,
      targetOwnerId: 'su-implementer',
    };
    stockScorecards([metaVettingCard({
      vetting: undefined,
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-09-24T03:54:29.339Z',
      },
      // Only a pending audit on a CURRENT rubric subject is dispatchable; a stale or
      // unknown subject is told to re-attest instead (acceptance-rubric-vetting.ts,
      // matching grading-integrity's dispatch filter), so suppression never applies.
      subjectRubricCurrentness: {
        state: 'current',
        reason: 'current',
        recordedRevision: 7,
        currentRevision: 7,
        recordedCriteriaHash: 'criteria-hash-current',
        currentCriteriaHash: 'criteria-hash-current',
      },
    })]);
    const readSuppression = vi.fn(async (ownerId?: string | null) =>
      ownerId === 'su-implementer' ? suppression : null,
    );

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', {
      readGradingAuditDispatchSuppression: readSuppression,
    });

    expect(v).toMatchObject({
      satisfied: false,
      code: 'acceptance_rubric_unvetted',
      gradingAuditDispatchSuppressed: suppression,
    });
    expect(v.message).toContain("scorecard owner 'su-implementer'");
    expect(v.message).toContain('workspace-wide loop stand-down');
    expect(readSuppression).toHaveBeenCalledWith('su-implementer');
  });

  it('names a historical subject-less meta-scorecard as malformed diagnostic evidence', async () => {
    stockScorecards([
      metaVettingCard({
        issueId: 'EI-subjectless-meta',
        subject: undefined,
        vetting: undefined,
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
    expect(v.message).toContain('EI-subjectless-meta');
    expect(v.message).toContain('subject-less meta-scorecard');
    expect(v.message).toContain("names no acceptance rubric");
  });

  it('a plain meta-grade WITHOUT the linked consult does not satisfy — the consult is what makes an attestation a vetting', async () => {
    stockScorecards([metaVettingCard({ vetting: undefined })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
  });

  it('a legacy vetting pinned to an older revision refuses when no substantive hash was recorded', async () => {
    stockScorecards([metaVettingCard({ vetting: { consultId: 'conv-vet-1', rubricRevision: 6 } })]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
    expect(v.message).toContain('revision 6');
    expect(v.message).toContain('revision 7');
    expect(v.message).toContain('EI-vet');
  });

  it('reuses vetting across a revision-only edit when the criteria hash is unchanged', async () => {
    stockScorecards([
      metaVettingCard({
        vetting: { consultId: 'conv-vet-1', rubricRevision: 6, criteriaHash: 'criteria-hash-current' },
      }),
    ]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(v).toMatchObject({ satisfied: true, rubricId: 'ar-some-plan', gradedBy: 'su-grader' });
  });

  it('refuses same-revision vetting when the criteria or method identity changed', async () => {
    stockScorecards([
      metaVettingCard({
        vetting: { consultId: 'conv-vet-1', rubricRevision: 7, criteriaHash: 'criteria-hash-old' },
      }),
    ]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
    expect(v.message).toContain('graded criteria or method changed');
  });

  it('a current-revision vetting with a linked consult satisfies (meta-rubric still proposed — tolerance proven)', async () => {
    stockScorecards([metaVettingCard()]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, rubricId: 'ar-some-plan', gradedBy: 'su-grader' });
  });

  it.each(['pending', 'failed'] as const)(
    'rejects a linked meta-vetting card whose grade-the-grader audit is %s',
    async (state) => {
      stockScorecards([
        metaVettingCard({
          gradingAudit: {
            state,
            metaRubricRef: 'grading-integrity',
            stampedAt: '2026-09-24T03:54:29.339Z',
          },
        }),
      ]);

      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

      expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
      expect(v.message).toContain('EI-vet');
      expect(v.message).toContain('grading-audit-unsettled');
    },
  );

  it('CONTROL (falsifiability, in-test — no tree mutation): the vetting stamp ALONE flips the verdict', async () => {
    // Identical state twice; the only delta is the stamp. If the check were vacuous
    // (or wired to the wrong field), both runs would agree and this control fails.
    stockScorecards([metaVettingCard()]);
    const withStamp = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    stockScorecards([metaVettingCard({ vetting: undefined })]);
    const withoutStamp = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(withStamp.satisfied).toBe(true);
    expect(withoutStamp).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
  });

  it('synthesized or incomplete meta-cards never count as a vetting', async () => {
    stockScorecards([
      metaVettingCard({ synthesized: true }),
      metaVettingCard({ issueId: 'EI-vet-2', missingKeys: ['k2'] }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_unvetted' });
  });

  it('a criteria:[] investigation rubric is exempt from vetting (D-009 — nothing to vet)', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric({ criteria: [], classRef: 'plan-class-investigation' }));
    stockScorecards([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
    expect(v.code).toBeUndefined();
  });

  it('no registered meta-rubric ⇒ the check disables rather than deadlocking every ship', async () => {
    mockGetRubric.mockResolvedValue(null);
    stockScorecards([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, gradedBy: 'su-grader' });
  });

  it('vetting flag OFF ⇒ the sibling rubric checks run unchanged and no vetting is demanded', async () => {
    mockFlag.mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
    stockScorecards([]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: true, gradedBy: 'su-grader' });
  });

  // EI-21827040531672903 split this case in two. It used to be one test asserting that
  // ANY null revision "degrades OPEN", which conflated a rubric that genuinely has no
  // revision (fine — nothing to pin against) with a revision read that FAILED (not
  // fine — the guard silently became no guard, and rendered no refusal, so nothing
  // recorded that it had been skipped). The first still degrades open; the second now
  // refuses. The pair is the falsifiability control for each other.
  it('a criteria hash keeps vetting current when the successful revision read is unversioned', async () => {
    mockRevision.mockResolvedValue(null);
    stockScorecards([
      metaVettingCard({
        vetting: { consultId: 'conv-vet-1', rubricRevision: 3, criteriaHash: 'criteria-hash-current' },
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
  });

  it('a FAILED revision read refuses instead of failing open — the same state that satisfies on a successful read', async () => {
    // Identical scorecard state in both halves; the ONLY delta is whether the read
    // succeeded. If the guard still short-circuited on the null, both would satisfy.
    const staleVetting = [metaVettingCard({
      vetting: { consultId: 'conv-vet-1', rubricRevision: 3, criteriaHash: 'criteria-hash-current' },
    })];

    mockRevisionRead.mockResolvedValue({ ok: true, revision: null });
    stockScorecards(staleVetting);
    expect((await evaluatePlanAcceptanceGate('some-plan-2026-08-11')).satisfied).toBe(true);

    mockRevisionRead.mockResolvedValue({ ok: false, revision: null });
    stockScorecards(staleVetting);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_revision_unreadable' });
    // The refusal must read as an infrastructure fault, not a missing plan step —
    // otherwise the next agent goes looking for work that was already done.
    expect(v.message).toContain('Retry');
  });

  describe('vetting must PRECEDE grading (EI-21827040531672903)', () => {
    // All timestamps here are past VETTING_PRECEDES_GRADING_REQUIRED_AFTER so the
    // ordering leg is live; the grandfathering case below deliberately sits before it.
    const gradedAt = '2026-09-01T02:00:00Z';
    const acceptedCards = [
      scorecard({ createdAt: gradedAt, createdBy: 'su-grader' }),
      scorecard({
        issueId: 'EI-accept',
        createdAt: '2026-09-01T03:00:00Z',
        createdBy: 'su-implementer',
        acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets the plan.' },
      }),
    ];

    it('refuses when the attestation post-dates the grading — the grading was emitted against an unvetted rubric', async () => {
      stockScorecards([metaVettingCard({ createdAt: '2026-09-01T05:00:00Z' })], acceptedCards);
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
      expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_vetted_after_grading' });
      expect(v.gradingRef).toBe('EI-1');
      expect(v.staleGradingScorecardId).toBe('EI-1');
      expect(v.staleGradingScorecardIds).toEqual(['EI-1']);
      // Both timestamps belong in the message: the complaint is about ORDER, and a
      // reader who cannot see both cannot tell that the attestation itself is fine.
      expect(v.message).toContain('2026-09-01T05:00:00Z');
      expect(v.message).toContain(gradedAt);
    });

    it('excludes every pre-vetting independent card from recruitment settlement', async () => {
      stockScorecards([metaVettingCard({ createdAt: '2026-09-01T05:00:00Z' })], [
        scorecard({ issueId: 'EI-newer', createdAt: gradedAt, createdBy: 'su-grader' }),
        scorecard({ issueId: 'EI-older', createdAt: '2026-09-01T01:00:00Z', createdBy: 'su-other-grader' }),
        acceptedCards[1]!,
      ]);
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
      expect(v).toMatchObject({ satisfied: false, code: 'acceptance_rubric_vetted_after_grading',
        staleGradingScorecardId: 'EI-newer' });
      expect(v.staleGradingScorecardIds?.sort()).toEqual(['EI-newer', 'EI-older']);
    });

    it('CONTROL: the same state with the attestation moved BEFORE the grading satisfies', async () => {
      stockScorecards([metaVettingCard({ createdAt: '2026-09-01T01:00:00Z' })], acceptedCards);
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
      expect(v).toMatchObject({ satisfied: true, gradedBy: 'su-grader' });
    });

    it('a grading created BEFORE the compatibility boundary is grandfathered, even though the attestation follows it', async () => {
      stockScorecards(
        [metaVettingCard({ createdAt: '2026-08-30T05:00:00Z' })],
        [
          scorecard({ createdAt: '2026-08-30T02:00:00Z', createdBy: 'su-grader' }),
          scorecard({
            issueId: 'EI-accept',
            createdAt: '2026-08-30T06:00:00Z',
            createdBy: 'su-implementer',
            acceptance: { verdict: 'accept', reasoning: 'The independent evidence meets the plan.' },
          }),
        ],
      );
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
      expect(v).toMatchObject({ satisfied: true, gradedBy: 'su-grader' });
    });
  });

  // EI-20821478338037350: a rubric vetted under an explicit no-critique waiver still
  // ships, but the verdict must SAY so — same posture as `forcedPast`, whose whole
  // point is that a waiver which is easy to hide is worth very little.
  it('a vetting stamped `unanswered` still satisfies, but reports vettedUnderWaiver', async () => {
    stockScorecards([
      metaVettingCard({
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          criteriaHash: 'criteria-hash-current',
          critiquePosts: 0,
          unanswered: true,
          unansweredReason: 'all 3 routed reviewers ended; consult expired 19:54Z with 0 posts',
        },
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({
      satisfied: true,
      vettedUnderWaiver: {
        consultId: 'conv-vet-1',
        reason: 'all 3 routed reviewers ended; consult expired 19:54Z with 0 posts',
      },
    });
  });

  it('CONTROL: a genuinely critiqued vetting satisfies with NO vettedUnderWaiver marker', async () => {
    // Without this, a `vettedUnderWaiver` hard-wired on would pass the test above.
    stockScorecards([
      metaVettingCard({
        vetting: {
          consultId: 'conv-vet-1',
          rubricRevision: 7,
          criteriaHash: 'criteria-hash-current',
          critiquePosts: 2,
          critics: ['su-reviewer'],
        },
      }),
    ]);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
    expect(v.vettedUnderWaiver).toBeUndefined();
  });
});

/**
 * The spec-proof check (first-class-spec-clauses-…-2026-08-20 P-008).
 *
 * The census itself is proven in plan-spec-coverage-gate.test.ts. What is asserted here
 * is only what the WIRING promises: the refusal reaches the caller, `force` waives it
 * like its code-truth siblings, the aggregate rides along on the satisfied verdict so a
 * successful ship still exposes what was proven, and the check sits ahead of rubric
 * ceremony.
 */
describe('the spec-proof check (first-class-spec-clauses-2026-08-20 P-008)', () => {
  const staleVerdict = coverageVerdict({
    satisfied: false,
    code: 'spec_proof_stale',
    wouldBlock: ['1-clause(s)-proven-only-at-a-superseded-revision'],
    message: "plan 'some-plan-2026-08-11' cannot be marked shipped: SPEC-1 (proof at r1, clause now r2)",
  });

  beforeEach(() => {
    mockFlag.mockImplementation(
      async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE || flag === FLAGS.PLAN_SPEC_COVERAGE_GATE,
    );
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([
      scorecard({ createdBy: 'su-implementer' }),
      scorecard({ createdBy: 'su-grader' }),
    ]);
  });

  it('a stale spec proof refuses the ship and carries the aggregate verdict', async () => {
    mockSpecCoverage.mockResolvedValue(staleVerdict);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v).toMatchObject({ satisfied: false, code: 'spec_proof_stale' });
    expect(v.message).toContain('SPEC-1');
    expect(v.specCoverage).toMatchObject({ code: 'spec_proof_stale', satisfied: false });
  });

  it('refuses BEFORE rubric ceremony — a plan with no rubric at all is still sent to re-prove', async () => {
    // Ordering guard: refusing acceptance_rubric_missing here would send the agent to
    // author a rubric for promises that are no longer proven.
    mockSpecCoverage.mockResolvedValue(staleVerdict);
    mockRubric.mockResolvedValue(null);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.code).toBe('spec_proof_stale');
  });

  it('an explicit reasoned force waives it like its code-truth siblings, and records the waiver', async () => {
    mockSpecCoverage.mockResolvedValue(staleVerdict);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', {
      force: { reason: 'clause reworded only; behaviour unchanged and re-verified by hand' },
    });
    expect(v.satisfied).toBe(true);
    expect(v.forcedPast?.checks).toContain('spec_proof_stale');
    expect(v.forcedPast?.reason).toContain('behaviour unchanged');
  });

  it('a satisfied ship still carries the coverage aggregate (advisory reports included)', async () => {
    mockSpecCoverage.mockResolvedValue(coverageVerdict({ reports: ['2-enforceable-clause(s)-with-no-evidence'] }));
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
    // Reported, NOT refused — an uncovered clause is P-013's to enforce (D-018).
    expect(v.code).toBeUndefined();
    expect(v.specCoverage?.reports).toEqual(['2-enforceable-clause(s)-with-no-evidence']);
  });

  it('CONTROL: with the P-008 flag OFF the census is never read and the ship is unaffected', async () => {
    mockFlag.mockImplementation(async (flag) => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE);
    mockSpecCoverage.mockResolvedValue(staleVerdict);
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    expect(v.satisfied).toBe(true);
    expect(v.specCoverage).toBeUndefined();
    expect(mockSpecCoverage).not.toHaveBeenCalled();
  });
});

// WI-10004178 / p2p-public-release-endgame-2026-09-01 D-095 — ship and grade are
// authoring-node acts in v1. A federated receiver must refuse loudly, naming that
// node, instead of reading the authoring node's cards against its own counter.
describe('evaluatePlanAcceptanceGate — federated receiver node (WI-10004178, D-095)', () => {
  const receiverRubric = {
    rubricId: 'acceptance-some-plan-2026-08-11',
    origin: 'remote',
    authorPubkey: null,
    proposedBy: 'su-author',
  };

  it('refuses only when BOTH receiver signals hold', () => {
    const base = { planSlug: 'some-plan-2026-08-11', verifiedRevision: 7, rubric: receiverRubric };
    expect(receiverHeldAcceptanceRefusal(base)?.code).toBe('acceptance_authored_on_other_node');
    // The authoring node: no receiver verification, even with a remote-origin rubric
    // (a peer's supersede federating back — measured live on shipped plans here).
    expect(receiverHeldAcceptanceRefusal({ ...base, verifiedRevision: null })).toBeNull();
    // The authoring node after a peer's plan write federated back and the receiver
    // seed ran here: the rubric content is still this node's own.
    expect(receiverHeldAcceptanceRefusal({ ...base, rubric: { ...receiverRubric, origin: 'local' } })).toBeNull();
    expect(receiverHeldAcceptanceRefusal({ ...base, rubric: null })).toBeNull();
  });

  it('names the authoring node by pot member, by device key, or says it cannot', () => {
    const key = 'a'.repeat(64);
    const member = receiverHeldAcceptanceRefusal({
      planSlug: 'p', verifiedRevision: 3, rubric: { ...receiverRubric, authorPubkey: key }, memberHandle: 'aviynw',
    });
    expect(member?.authoringNode).toMatchObject({ labelSource: 'pot-member', pubkey: key, verifiedRevision: 3 });
    expect(member?.message).toMatch(/^Ship from the authoring node aviynw \(device a{12}…\)\./);

    const device = receiverHeldAcceptanceRefusal({
      planSlug: 'p', verifiedRevision: 3, rubric: receiverRubric, planOwnerPubkey: key,
    });
    expect(device?.authoringNode).toMatchObject({ labelSource: 'pubkey', pubkey: key });
    expect(device?.message).toContain(`Ship from the authoring node device ${'a'.repeat(12)}…`);

    const unnamed = receiverHeldAcceptanceRefusal({ planSlug: 'p', verifiedRevision: 3, rubric: receiverRubric });
    expect(unnamed?.authoringNode).toMatchObject({ labelSource: 'unresolved', pubkey: null, proposedBy: 'su-author' });
    expect(unnamed?.message).toContain('cannot name it');
    expect(unnamed?.message).toContain('proposed there by su-author');
    expect(unnamed?.message).toContain('D-095');
  });

  /** Route each gate query by its text: the subject read, then the rubric-origin read. */
  const receiverPg = (subject: Record<string, unknown>, rubricRows: unknown[]) => {
    const sql = ((strings: TemplateStringsArray) => Promise.resolve(
      strings.join('?').includes('AS proposed_by') ? rubricRows : [subject],
    )) as unknown as ReturnType<typeof getOrgPg>['sql'];
    return { sql } as ReturnType<typeof getOrgPg>;
  };
  const subjectRow = {
    plan_slug: 'some-plan-2026-08-11', harness_slug: 'papercusp', template: null, template_slug: null,
    acceptance_bar_epoch: null, content: '# plan\n', status: 'ready', owner_author_pubkey: null,
  };
  const rubricRow = {
    plan_slug: 'acceptance-some-plan-2026-08-11', origin: 'remote', author_pubkey: null, proposed_by: 'su-author',
  };

  it('B: returns the typed refusal before any rubric-family read, so no grader is recruited here', async () => {
    mockPg.mockReturnValue(receiverPg({ ...subjectRow, acceptance_bar_verified_revision: '12' }, [rubricRow]));
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(v).toMatchObject({
      satisfied: false,
      code: 'acceptance_authored_on_other_node',
      authoringNode: { rubricId: 'acceptance-some-plan-2026-08-11', verifiedRevision: 12, labelSource: 'unresolved' },
    });
    expect(v.message).toMatch(/^Ship from the authoring node /);
    // Not a grader gap: acceptance_ungraded is what the recruiter would act on.
    expect(v.code).not.toBe('acceptance_ungraded');
    expect(mockBarLifecycle).not.toHaveBeenCalled();
    expect(mockRubrics).not.toHaveBeenCalled();
    expect(mockScorecards).not.toHaveBeenCalled();
  });

  it('A: the authoring node is unchanged — no verified receiver revision, ordinary verdict', async () => {
    mockPg.mockReturnValue(receiverPg({ ...subjectRow, acceptance_bar_verified_revision: null }, [rubricRow]));
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(v.code).not.toBe('acceptance_authored_on_other_node');
    expect(v.authoringNode).toBeUndefined();
    expect(mockRubrics).toHaveBeenCalled();
  });

  it('is not waivable by force: force waives code truth, never who may grade', async () => {
    mockPg.mockReturnValue(receiverPg({ ...subjectRow, acceptance_bar_verified_revision: 4 }, [rubricRow]));

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { force: { reason: 'try to push it through' } });

    expect(v).toMatchObject({ satisfied: false, code: 'acceptance_authored_on_other_node' });
    expect(v.forcedPast).toBeUndefined();
  });
});

describe('all-blockers ship preflight (plan-verification-friction-reduction-2026-10-11 P-001)', () => {
  // Measured before this change: a plan with N independent defects needed N ship
  // attempts, because the gate returned at the FIRST failing check. Collect mode keeps
  // evaluating every independent pre-grading check and reports them all at once.
  const barNotReady = (): AcceptanceBarLifecycleVerdict => ({
    phase: 'ship', applicable: true, satisfied: false,
    codes: ['bar_snapshot_evidence_plane_unmet'], blockingBars: [],
    contractCodes: ['bar_snapshot_evidence_plane_unmet'],
    codeAttribution: [{ code: 'bar_snapshot_evidence_plane_unmet', barKeys: [] }],
    nextRepair: null, staleGradingScorecardId: null, message: 'BAR proof or grading is incomplete',
  });
  const specStale = () => coverageVerdict({
    satisfied: false,
    code: 'spec_proof_stale',
    wouldBlock: ['1-clause(s)-proven-only-at-a-superseded-revision'],
    message: 'A clause is proven only at a superseded revision.',
  });

  /** Four independent defects: an ephemeral deliverable, a BAR proof gap, a stale
   * spec proof, and no acceptance rubric at all. */
  const fourDefects = () => {
    mockFlag.mockImplementation(async (flag) =>
      flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE || flag === FLAGS.PLAN_SPEC_COVERAGE_GATE,
    );
    mockPg.mockReturnValue(sqlReturning([{
      plan_slug: 'some-plan-2026-08-11', harness_slug: 'papercusp', template: null, template_slug: null,
      acceptance_bar_epoch: 1,
      content: '## Requirements\n\n**R-1 — Result.** The required result.\n\nReport: https://claude.ai/artifacts/abc123\n',
    }]));
    mockBarLifecycle.mockResolvedValue(barNotReady());
    mockSpecCoverage.mockResolvedValue(specStale());
    mockRubric.mockResolvedValue(undefined as unknown as Rubric);
  };
  const FOUR = [
    'ephemeral_deliverable_unbacked',
    'acceptance_bar_contract_not_ready',
    'spec_proof_stale',
    'acceptance_rubric_missing',
  ];

  it('collect mode reports every independent blocker, each with its own repairAction', async () => {
    fourDefects();
    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { collectAllBlockers: true });

    expect(v.satisfied).toBe(false);
    const codes = (v.blockers ?? []).map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(FOUR));
    // The primary verdict is the FIRST blocker, so routing that keys on `code` is unchanged.
    expect(v.code).toBe(codes[0]);
    for (const blocker of v.blockers ?? []) {
      expect(blocker.repairAction, blocker.code).toBeDefined();
      expect(blocker.message, blocker.code).toBeTruthy();
    }
    // Grading is the LAST step: collect mode stops before reading any grading.
    expect(mockScorecards).not.toHaveBeenCalled();
  });

  it('default mode still stops at the first failure, with the same primary and one blocker', async () => {
    fourDefects();
    const collected = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { collectAllBlockers: true });
    fourDefects();
    const first = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');

    expect(first.satisfied).toBe(false);
    expect(first.code).toBe(collected.code);
    expect(first.message).toBe(collected.message);
    expect(first.blockers).toHaveLength(1);
    expect(first.blockers?.[0]).toMatchObject({ code: first.code });
    // The rubric family was never reached in first-failure mode.
    expect(collected.blockers?.length).toBeGreaterThan(1);
  });

  it('collect mode records an unvetted rubric and assessable grading beside an earlier blocker', async () => {
    mockFlag.mockImplementation(async (flag) =>
      flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE
      || flag === FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE
      || flag === FLAGS.PLAN_SPEC_COVERAGE_GATE,
    );
    mockSpecCoverage.mockResolvedValue(specStale());
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockGetRubric.mockResolvedValue(
      acceptanceRubric({ rubricId: 'meta-acceptance-rubric', kind: 'standard', subjectPlan: null, status: 'proposed' }),
    );
    mockRevision.mockResolvedValue(7);
    mockScorecards.mockResolvedValue([]);

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { collectAllBlockers: true });
    expect(v).toMatchObject({ satisfied: false, code: 'spec_proof_stale' });
    expect((v.blockers ?? []).map((b) => b.code)).toEqual(['spec_proof_stale', 'acceptance_rubric_unvetted', 'acceptance_ungraded']);
    expect(mockScorecards.mock.calls.some(([q]) => q?.rubricRef === 'ar-some-plan')).toBe(true);
  });

  it('collects unmet grading bars and a missing author verdict beside earlier proof failure', async () => {
    mockFlag.mockImplementation(async flag => flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE || flag === FLAGS.PLAN_SPEC_COVERAGE_GATE);
    mockSpecCoverage.mockResolvedValue(specStale());
    const rubric = acceptanceRubric();
    rubric.criteria = rubric.criteria.map(c => ({ ...c, role: 'outcome', mandatory: true, passRatings: ['healthy'] }));
    mockRubric.mockResolvedValue(rubric);
    mockScorecards.mockResolvedValue([scorecard({ createdAt: '2026-10-11T00:00:00Z', ratings: Object.fromEntries(rubric.criteria.map(c => [c.key, { rating: 'broken', evidence: 'measured failed outcome' }])) })]);
    const first = await evaluatePlanAcceptanceGate('some-plan-2026-08-11');
    const collected = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { collectAllBlockers: true });
    expect(first.code).toBe('spec_proof_stale');
    expect(collected.code).toBe(first.code);
    expect(collected.blockers?.map(b => b.code)).toEqual(['spec_proof_stale', 'acceptance_bar_not_met', 'acceptance_not_recorded']);
    expect(collected.blockers?.every(b => b.repairAction)).toBe(true);
  });

  it('collect mode records an unreadable rubric revision and skips the vetting evaluation', async () => {
    mockFlag.mockImplementation(async (flag) =>
      flag === FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE
      || flag === FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE
      || flag === FLAGS.PLAN_SPEC_COVERAGE_GATE,
    );
    mockSpecCoverage.mockResolvedValue(specStale());
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockGetRubric.mockResolvedValue(
      acceptanceRubric({ rubricId: 'meta-acceptance-rubric', kind: 'standard', subjectPlan: null, status: 'proposed' }),
    );
    mockRevisionRead.mockResolvedValue({ ok: false, revision: null });

    const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', { collectAllBlockers: true });
    expect((v.blockers ?? []).map((b) => b.code))
      .toEqual(['spec_proof_stale', 'acceptance_rubric_revision_unreadable']);
    // The vetting evaluation needs the revision, so it never ran (no meta-card read).
    expect(mockScorecards).not.toHaveBeenCalled();
  });

  it('a satisfied verdict carries no blockers in either mode', async () => {
    mockRubric.mockResolvedValue(acceptanceRubric());
    mockScorecards.mockResolvedValue([scorecard()]);
    for (const opts of [{}, { collectAllBlockers: true }]) {
      const v = await evaluatePlanAcceptanceGate('some-plan-2026-08-11', opts);
      expect(v.satisfied).toBe(true);
      expect(v.blockers).toBeUndefined();
    }
  });

  it('messageWithAdditionalBlockers names every OTHER failing check after the primary message', () => {
    const blockers = [
      { code: 'spec_proof_stale' as const, repairAction: undefined as never },
      { code: 'acceptance_rubric_missing' as const, repairAction: undefined as never },
      { code: 'ephemeral_deliverable_unbacked' as const, repairAction: undefined as never },
    ];
    const msg = messageWithAdditionalBlockers('primary message', blockers);
    expect(msg).toMatch(/^primary message\n\nALSO FAILING: 2 more independent check\(s\)/);
    expect(msg).toContain('acceptance_rubric_missing, ephemeral_deliverable_unbacked');
    expect(msg).not.toContain('— spec_proof_stale');
    // One blocker (or none): the message is returned unchanged.
    expect(messageWithAdditionalBlockers('primary message', blockers.slice(0, 1))).toBe('primary message');
    expect(messageWithAdditionalBlockers('primary message', undefined)).toBe('primary message');
  });
});
