import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateAgentObligations,
  planAcceptanceChangedKey,
} from '../../agent-obligations';
import { independentVerificationObligation } from '../../agent-obligation-providers';
import { readAgentObligationAgenda } from '../../agent-obligation-reader';
import type { PlanAcceptanceGateVerdict } from '../../plan-acceptance-gate';
import { parsePlan, type PlanItem } from '@papercusp/plan-parser';
import { flipStatusInBody, releaseTerminalGrips } from './set-status';
import { applyPlanDrainTransition } from './plan-drain-transition';
import { planDrainSweepCandidate } from './plan-drain-sweep';
import { runAcceptanceDrainSweepOnce } from './acceptance-drain-sweep';

const M = vi.hoisted(() => ({
  withPlanLock: vi.fn(),
  getFlag: vi.fn(),
  sql: vi.fn(),
  list: vi.fn(),
  evaluate: vi.fn(),
  upsert: vi.fn(),
  sessionBrief: vi.fn(),
}));

vi.mock('./with-plan-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./with-plan-lock')>();
  return { ...actual, withPlanLock: M.withPlanLock };
});
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return { ...actual, getFlag: M.getFlag };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: M.sql }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
// primeWorkScopePolicy: the sweep awaits it before filtering (WI-10002448); a factory
// mock without it throws "No export is defined on the mock" on that await.
vi.mock('../../work-scope-policy', () => ({ isHarnessInScope: () => true, primeWorkScopePolicy: async () => {} }));
vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return { ...actual, listPlanIndexRowsForWorkspace: M.list };
});
vi.mock('../../plan-acceptance-gate', () => ({
  evaluatePlanAcceptanceGate: M.evaluate,
}));
// P-006 (verification-system-improvements-2026-10-10 D-039): the drain transition now
// asks the blind gap review door before moving a plan to awaiting-acceptance. This
// lifecycle suite is not about that door, whose real DB reads would hit the mocked sql
// above and fail closed; it reads as not applicable here. The door itself is exercised by
// plan-acceptance-gate-blind-review.integration.test.ts.
vi.mock('../../blind-review-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../blind-review-gate')>()),
  evaluateBlindReviewGate: async () => ({
    satisfied: true,
    applicable: false,
    notApplicableReason: 'pre-cohort',
    acceptedReviewIds: [],
    rejectedReviews: [],
    undispositionedGaps: [],
  }),
}));
vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: M.upsert,
}));
vi.mock('../../session-brief', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-brief')>();
  return { ...actual, getSessionBrief: M.sessionBrief };
});

const NOW = '2026-09-20T01:45:00.000Z';
const WS = 'papercusp-workspace';
const PLAN = 'drained-plan-2026-09-20';

/**
 * This file asserts on the ACCEPTANCE lane's obligations. The reader also
 * assembles an owner-directive obligation (P-006 of plan
 * `turn-start-memory-two-class-2026-09-21`) whose default dependency reads
 * harness_shared.owner_directives — a table this suite never seeds and the rest
 * of the fleet writes to constantly. Left to the default, the assertions below
 * would measure whatever real directives happen to be pending on the box.
 * Pinning it empty keeps them exact; the family has its own suite in
 * agent-obligation-owner-directives.test.ts.
 */
// The same holds for the waiting-on family (D-055 A4): its default dependency
// reads live event awaits plus the lock queue through getOrgPg().sql, which
// this suite MOCKS to answer the acceptance-filing probe. Unpinned, a second
// primary obligation appeared on the agenda below (measured 2026-09-22,
// WI-2144525). It has its own suite; pin it empty here.
//
// The same applies to the plan-acceptance read itself (D-039): the reader's
// DEFAULT `planAcceptance` dep now serves the PERSISTED closure observation
// (goals/plan-closure-observations), not an inline gate evaluation, so with the
// mocked `getOrgPg().sql` it resolved to "plan does not resolve" -> `unknown` /
// `inspect` instead of the `due` / `repair` this lifecycle asserts (measured
// 2026-10-01T22:42Z, run 20452719, before any consult-reconciliation edit).
// This suite's subject is the drain -> filing -> obligation join over the MOCKED
// gate verdict, so it pins the dep to that same verdict; the persisted-read path
// has its own coverage in the plan-closure-observations tests.
const NO_OWNER_DIRECTIVES = {
  ownerDirectives: async () => [],
  waitingOn: async () => [],
  fleetStaffing: async () => [],
  strandedGoalWork: async (_ws: string, goalId: string) => ({ goalId, thresholdMs: 0, total: 0, refusedCount: 0, sample: [], truncatedByLimit: false }),
  planAcceptance: async (_workspaceId: string, planSlug: string) => M.evaluate(planSlug),
};
let currentBody: string;

function planBody(status: string, itemStatus = 'done'): string {
  return [
    '---',
    'title: Drained plan',
    `slug: ${PLAN}`,
    `status: ${status}`,
    '---',
    '',
    '## Phase 1',
    '',
    `- **P-001** \`${itemStatus}\` final implementation item`,
    '',
  ].join('\n');
}

function gate(overrides: Partial<PlanAcceptanceGateVerdict>): PlanAcceptanceGateVerdict {
  return {
    buildProvenance: { sha: 'test-sha', version: 'test' },
    satisfied: false,
    code: 'acceptance_rubric_missing',
    message: 'author the acceptance rubric',
    ...overrides,
  };
}

const item = (status: PlanItem['storedStatus']): PlanItem => ({
  id: 'P-001',
  text: 'final implementation item',
  storedStatus: status,
  importance: 'normal',
  blockedBy: [],
  decisionRefs: [],
  phase: null,
  lineNumber: 1,
  rawLine: '',
});

function obligationFor(gateVerdict: PlanAcceptanceGateVerdict, planSlug = 'drained-plan') {
  return independentVerificationObligation({
    workspaceId: WS,
    ownerId: 'su-test',
    planSlug,
    observedAt: NOW,
    sourceGeneration: `gate:${gateVerdict.code ?? 'satisfied'}`,
    read: {
      status: 'known',
      value: {
        gate: gateVerdict,
        evidenceRef: 'plan-acceptance:drained-plan',
        gradeable: true,
      },
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  currentBody = planBody('ready');
  let openFiling = false;
  M.withPlanLock.mockImplementation(
    async (
      _ctx: unknown,
      _opts: unknown,
      mutator: (
        current: string,
        meta: unknown,
        scope: { workspaceId: string; harnessSlug: string },
      ) => Promise<{ newBody: string | null; value: unknown }>,
    ) => {
      // The real lock hands every mutator the scope it resolved (WI-6554700010010577).
      const mutation = await mutator(currentBody, {}, { workspaceId: WS, harnessSlug: 'papercusp' });
      if (mutation.newBody !== null) currentBody = mutation.newBody;
      return {
        kind: 'applied',
        value: mutation.value,
      };
    },
  );
  M.getFlag.mockResolvedValue(true);
  M.sql.mockImplementation(async () =>
    openFiling ? [{ ref: `${WS}/papercusp/${PLAN}` }] : [],
  );
  M.list.mockImplementation(async ({ status }: { status: string }) =>
    parsePlan(currentBody).frontmatter.status === status
      ? [{ planSlug: PLAN, harnessSlug: 'papercusp', template: null }]
      : [],
  );
  M.evaluate.mockResolvedValue(gate({}));
  M.sessionBrief.mockResolvedValue({ currentPlanSlug: PLAN });
  M.upsert.mockImplementation(async () => {
    openFiling = true;
    return { created: true, id: 'WI-ACCEPTANCE' };
  });
});

describe('P-023 drained-to-acceptance lifecycle', () => {
  it('moves a drained ready plan into awaiting-acceptance before the acceptance gate runs', () => {
    expect(planDrainSweepCandidate('ready', [item('done')])).toEqual({
      from: 'ready',
      to: 'awaiting-acceptance',
    });
  });

  it('records the refusal as an actionable obligation with a material-change wake', () => {
    const obligation = obligationFor(gate({}));

    expect(obligation).toMatchObject({
      family: 'independent-verification',
      // `due`, not `blocked`: an AUTHOR-owned refusal (rubric missing / unaudited)
      // is actionable by the plan's own author right now — D-009 ruling 3 of
      // generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20
      // (isActionable vs isDelegable in independentVerificationObligation).
      status: 'due',
      action: { kind: 'repair' },
      changeSignal: { event: planAcceptanceChangedKey('drained-plan') },
      scope: { planSlug: 'drained-plan' },
    });
  });

  it('removes the acceptance obligation from the primary agenda once the gate reports satisfied', () => {
    const obligation = obligationFor(
      gate({
        satisfied: true,
        code: undefined,
        message: 'accepted',
        rubricId: 'rubric-1',
        gradedBy: 'independent-grader',
      }),
    );
    const agenda = evaluateAgentObligations([obligation], NOW);

    expect(obligation.status).toBe('satisfied');
    expect(agenda.primary).toEqual([]);
    expect(agenda.evaluations).toEqual([expect.objectContaining({ status: 'satisfied' })]);
  });

  it('joins terminal cleanup, drain transition, acceptance filing, and obligation clearing', async () => {
    // Exercise the real item mutator too; this fixture starts with unfinished
    // implementation rather than assuming a completed item in the input.
    currentBody = planBody('ready', 'wip');
    expect(await applyPlanDrainTransition(PLAN, 'papercusp')).toMatchObject({
      applied: false,
      skipped: 'no_transition_warranted',
    });
    const close = flipStatusInBody(currentBody, 'P-001', 'done');
    expect(close).toMatchObject({ found: true, oldStatus: 'wip' });
    currentBody = close.newBody;

    const persistence = {
      releasedClaims: [] as string[][],
      clearedAssignments: [] as string[][],
    };

    const grips = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: 'su-test',
      scope: { workspaceId: WS, harnessSlug: 'papercusp' },
      slug: PLAN,
      itemId: 'P-001',
      releaseClaim: async (...args) => {
        persistence.releasedClaims.push(args);
        return true;
      },
      clearAssignment: async (...args) => {
        persistence.clearedAssignments.push(args);
        return { itemId: 'P-001' };
      },
    });
    expect(grips).toEqual({ claimReleased: true, assignmentReleased: true });

    const transition = await applyPlanDrainTransition(PLAN, 'papercusp');
    expect(transition).toMatchObject({
      applied: true,
      from: 'ready',
      to: 'awaiting-acceptance',
    });
    expect(M.withPlanLock).toHaveBeenCalledTimes(2);
    expect(parsePlan(currentBody).frontmatter.status).toBe('awaiting-acceptance');
    expect(persistence.releasedClaims).toEqual([[WS, 'papercusp', PLAN, 'P-001', 'su-test']]);
    expect(persistence.clearedAssignments).toEqual([[WS, 'papercusp', PLAN, 'P-001']]);

    M.evaluate.mockResolvedValue(gate({ code: 'acceptance_unaudited', message: 'run plans:audit' }));
    const sweep = await runAcceptanceDrainSweepOnce({ workspaceId: WS });
    expect(sweep).toMatchObject({
      scanned: 1,
      alreadyFiled: 0,
      shippableNow: 0,
      filed: [{ planSlug: PLAN, harnessSlug: 'papercusp', code: 'acceptance_unaudited', workItemId: 'WI-ACCEPTANCE' }],
    });
    expect(M.upsert).toHaveBeenCalledWith(
      `acceptance-drain:papercusp/${PLAN}`,
      expect.objectContaining({
        payload: expect.objectContaining({
          acceptanceDrainPlan: `${WS}/papercusp/${PLAN}`,
          planSlug: PLAN,
          blockerCode: 'acceptance_unaudited',
        }),
      }),
    );

    const refused = await readAgentObligationAgenda({
      workspaceId: WS,
      ownerId: 'su-test',
      goalId: null,
      now: new Date(NOW),
      deps: NO_OWNER_DIRECTIVES,
    });
    expect(refused.agenda.primary).toHaveLength(1);
    expect(refused.agenda.primary[0]).toMatchObject({
      family: 'independent-verification',
      // `due`, not `blocked`: an AUTHOR-owned refusal (rubric missing / unaudited)
      // is actionable by the plan's own author right now — D-009 ruling 3 of
      // generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20
      // (isActionable vs isDelegable in independentVerificationObligation).
      status: 'due',
      scope: { planSlug: PLAN },
      action: { kind: 'repair' },
    });

    // Leaving a plan's session context is a SEPARATE edge, not an automatic
    // consequence of releaseTerminalGrips. The default scope reader consults
    // the session brief, not the outstanding acceptance filing.
    M.sessionBrief.mockResolvedValue({ currentPlanSlug: null });
    M.evaluate.mockClear();
    const clearedContext = await readAgentObligationAgenda({
      workspaceId: WS,
      ownerId: 'su-test',
      goalId: null,
      now: new Date(NOW),
      deps: NO_OWNER_DIRECTIVES,
    });
    expect(clearedContext.planSlugs).toEqual([]);
    // Leaving the plan context clears the ACCEPTANCE obligation. The
    // owner-directive family is assembled unconditionally (P-006) and reports a
    // measured empty queue as `not-applicable`, which is never actionable — so
    // what must be empty here is `primary`, not `evaluations`. Asserting the
    // latter empty would only be asserting that no OTHER family exists.
    // The same reasoning covers every OTHER unconditional family (waiting-on,
    // D-055 A4, joined it later): assert per family, never the exact list.
    expect(clearedContext.agenda.primary).toEqual([]);
    const clearedFamilies = clearedContext.agenda.evaluations.map((entry) => [entry.family, entry.status]);
    expect(clearedFamilies).toContainEqual(['owner-directive', 'not-applicable']);
    expect(clearedFamilies.filter(([family]) => family === 'independent-verification')).toEqual([]);
    expect(clearedFamilies.every(([, status]) => status === 'not-applicable')).toBe(true);
    expect(M.evaluate).not.toHaveBeenCalled();
    expect(parsePlan(currentBody).frontmatter.status).toBe('awaiting-acceptance');

    M.sessionBrief.mockResolvedValue({ currentPlanSlug: PLAN });
    M.evaluate.mockResolvedValue(
      gate({
        satisfied: true,
        code: undefined,
        message: 'accepted',
        rubricId: 'rubric-1',
        gradedBy: 'independent-grader',
      }),
    );
    const accepted = await readAgentObligationAgenda({
      workspaceId: WS,
      ownerId: 'su-test',
      goalId: null,
      now: new Date(NOW),
      deps: NO_OWNER_DIRECTIVES,
    });
    expect(accepted.agenda.primary).toEqual([]);
    expect(accepted.agenda.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'owner-directive', status: 'not-applicable' }),
        expect.objectContaining({ family: 'independent-verification', status: 'satisfied' }),
      ]),
    );
    expect(
      accepted.agenda.evaluations
        .filter((entry) => entry.family !== 'independent-verification')
        .every((entry) => entry.status === 'not-applicable'),
    ).toBe(true);

    // The obligation reader has cleared its primary agenda entry. The sweep still
    // re-reads the canonical gate and refreshes the same keyed filing, so readiness
    // is visible rather than becoming a dedupe sink.
    M.evaluate.mockClear();
    const suppressed = await runAcceptanceDrainSweepOnce({ workspaceId: WS });
    expect(suppressed).toMatchObject({
      scanned: 1,
      alreadyFiled: 1,
      shippableNow: 0,
      refreshed: 1,
      ready: 1,
      filed: [],
    });
    expect(M.evaluate).toHaveBeenCalledExactlyOnceWith(PLAN);
    expect(M.upsert).toHaveBeenCalledTimes(1);
    expect(parsePlan(currentBody).frontmatter.status).toBe('awaiting-acceptance');
  });

  it('observes a shippable plan without an open filing but does not ship it', async () => {
    await applyPlanDrainTransition(PLAN, 'papercusp');
    M.evaluate.mockResolvedValue(gate({ satisfied: true, code: undefined }));
    const sweep = await runAcceptanceDrainSweepOnce({ workspaceId: WS });
    expect(sweep).toMatchObject({ scanned: 1, alreadyFiled: 0, shippableNow: 1, filed: [] });
    expect(M.evaluate).toHaveBeenCalledExactlyOnceWith(PLAN);
    expect(M.upsert).not.toHaveBeenCalled();
    expect(parsePlan(currentBody).frontmatter.status).toBe('awaiting-acceptance');
  });
});
