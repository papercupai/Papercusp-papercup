/**
 * blender:ideate-pass-record (su-ideate-learning-substrate-2026-07-10 P-010).
 * Pins the su-pass → tick mapping:
 *  - a status='ran', origin='su-ideate' tick attributed to the caller's ownerId
 *    (detail.owner), with ideasFiled → ideas_routed and observationsMined →
 *    ideas_generated;
 *  - observationsMined omitted ⇒ ideas_generated 0 and absent from the result;
 *  - notes trimmed onto detail (blank/whitespace dropped);
 *  - install_slug from ctx.harnessSlug, defaulting 'papercusp' for a missing / '*';
 *  - the args schema (ideasFiled required non-negative int; strict).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecordScoutTickInput } from '../../scout/tick-ledger';
import { resolveAgentIdentity } from '../coordination/identity';
import { GOAL_DAY_MIN_CANDIDATES, goalDayIdeationYield } from '../../goal-planning-review';
import {
  ideatePassRecordArgs,
  runIdeatePassRecord,
  toToolResult,
  type IdeatePassRecordDeps,
} from './ideate-pass-record';

vi.mock('../coordination/identity');
const mockIdentity = vi.mocked(resolveAgentIdentity);

function identity(ownerId = 'su-caller') {
  return {
    ownerId,
    ownerLabel: `su · ${ownerId}`,
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  } as ReturnType<typeof resolveAgentIdentity>;
}

/** A deps double: recordTick is a spy; any `over` REPLACES it so the returned
 *  handle is the one the core calls. */
function makeDeps(over: Partial<IdeatePassRecordDeps> = {}) {
  const recordTick = over.recordTick ?? vi.fn(async (_input: RecordScoutTickInput) => undefined);
  return { deps: { ...over, recordTick } as IdeatePassRecordDeps, recordTick };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdentity.mockReturnValue(identity());
});

describe('runIdeatePassRecord', () => {
  it("writes a 'ran'/'su-ideate' tick with the pass yield mapped and the caller attributed", async () => {
    const { deps, recordTick } = makeDeps();
    const out = await runIdeatePassRecord(
      { ideasFiled: 3, observationsMined: 11, notes: 'mined the routed-idea corpus' },
      { harnessSlug: 'papercusp' },
      deps,
    );

    expect(recordTick).toHaveBeenCalledWith({
      status: 'ran',
      origin: 'su-ideate',
      installSlug: 'papercusp',
      ideasRouted: 3, // ideasFiled → ideas_routed
      ideasGenerated: 11, // observationsMined → ideas_generated
      detail: { owner: 'su-caller', notes: 'mined the routed-idea corpus' },
    });
    expect(out).toEqual({
      ok: true,
      origin: 'su-ideate',
      status: 'ran',
      ideasFiled: 3,
      observationsMined: 11,
      notes: 'mined the routed-idea corpus',
      owner: 'su-caller',
      installSlug: 'papercusp',
    });
  });

  it('defaults ideas_generated to 0 and omits observationsMined from the result when not given', async () => {
    const { deps, recordTick } = makeDeps();
    const out = await runIdeatePassRecord({ ideasFiled: 1 }, { harnessSlug: 'papercusp' }, deps);
    expect(recordTick).toHaveBeenCalledWith(
      expect.objectContaining({ ideasGenerated: 0, ideasRouted: 1, detail: { owner: 'su-caller' } }),
    );
    expect(out).not.toHaveProperty('observationsMined');
    expect(out).not.toHaveProperty('notes');
  });

  it('drops blank/whitespace notes (neither on detail nor in the result)', async () => {
    const { deps, recordTick } = makeDeps();
    const out = await runIdeatePassRecord({ ideasFiled: 2, notes: '   ' }, { harnessSlug: 'papercusp' }, deps);
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({ detail: { owner: 'su-caller' } }));
    expect(out).not.toHaveProperty('notes');
  });

  it("derives install_slug from ctx.harnessSlug and defaults 'papercusp' for a missing / '*' harness", async () => {
    const { deps, recordTick } = makeDeps();
    await runIdeatePassRecord({ ideasFiled: 0 }, { harnessSlug: 'my-harness' }, deps);
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'my-harness' }));

    vi.mocked(recordTick).mockClear();
    await runIdeatePassRecord({ ideasFiled: 0 }, {}, deps);
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'papercusp' }));

    vi.mocked(recordTick).mockClear();
    await runIdeatePassRecord({ ideasFiled: 0 }, { harnessSlug: '*' }, deps);
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'papercusp' }));
  });
});

describe('ideatePassRecordArgs (schema)', () => {
  it('requires a non-negative integer ideasFiled and is strict', () => {
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 4 }).success).toBe(true);
    expect(ideatePassRecordArgs.safeParse({}).success).toBe(false);
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: -1 }).success).toBe(false);
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 1.5 }).success).toBe(false);
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 1, bogus: true }).success).toBe(false);
  });

  it('accepts optional observationsMined + notes', () => {
    const parsed = ideatePassRecordArgs.safeParse({ ideasFiled: 2, observationsMined: 9, notes: 'x' });
    expect(parsed.success).toBe(true);
  });
});

const goalReview = {
  goalId: 'goal-1',
  disposition: 'existing-plans-sufficient' as const,
  rationale: 'The current plan covers the remaining goal outcome.',
  evidenceRefs: ['plan:papercusp/existing-plan'],
  planRefs: ['plan:papercusp/existing-plan'],
  coverage: [{ need: 'checkout recovery', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'plan:papercusp/existing-plan' }],
};
const reviewContext = {
  goalId: 'goal-1',
  portfolioFingerprint: 'server-measured-portfolio',
  observedAt: '2026-09-23T06:00:00.000Z',
};

/**
 * EI-24428150977170134 / plan scout-su-ideate-pipeline-gaps-2026-10-08 P-007 (R-15).
 * The three refusal shapes measured on live tool_invocations 2026-09-27..10-08
 * (23 of 120 calls): an undeclared pass `lens`, a bare plan slug in planRefs, and
 * a coverage need with no work-items yet. Each fixture is the measured shape.
 */
describe('ideate-pass-record invalid_input regressions (R-15)', () => {
  it('accepts the pass lens, stores it on the tick detail and echoes it', async () => {
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 2, lens: 'risk-first' }).success).toBe(true);
    const { deps, recordTick } = makeDeps();
    const out = await runIdeatePassRecord({ ideasFiled: 2, lens: ' cost-leverage ' }, { harnessSlug: 'papercusp' }, deps);
    expect(recordTick).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { owner: 'su-caller', lens: 'cost-leverage' } }),
    );
    expect(out).toMatchObject({ ok: true, lens: 'cost-leverage' });
  });

  it('canonicalizes a bare plan slug in goalReview.planRefs instead of refusing it', () => {
    const parsed = ideatePassRecordArgs.safeParse({
      ideasFiled: 0,
      goalReview: { ...goalReview, planRefs: ['fuzzy-tool-name-resolution-2026-07-02', 'papercusp/existing-plan'] },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.goalReview?.planRefs).toEqual([
      'plan:fuzzy-tool-name-resolution-2026-07-02',
      'plan:papercusp/existing-plan',
    ]);
  });

  it('still refuses a malformed plan ref (normalization only rescues bare slugs)', () => {
    expect(
      ideatePassRecordArgs.safeParse({ ideasFiled: 0, goalReview: { ...goalReview, planRefs: ['two words'] } }).success,
    ).toBe(false);
  });

  it('accepts a coverage need with no work-items yet when it is justified or plan-covered', () => {
    const blocked = {
      ...goalReview,
      disposition: 'blocked' as const,
      coverage: [
        { need: 'Fresh independent stewardship grade', itemRefs: [], justification: 'Rubric trend is stale; no item exists yet.' },
        { need: 'Custody routing rubric read', itemRefs: [], planRef: 'plan:papercusp/existing-plan' },
      ],
    };
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 0, goalReview: blocked }).success).toBe(true);
  });

  it('refuses an empty coverage need that carries neither a justification nor a planRef', () => {
    const bare = { ...goalReview, disposition: 'blocked' as const, coverage: [{ need: 'Unexplained need', itemRefs: [] }] };
    const parsed = ideatePassRecordArgs.safeParse({ ideasFiled: 0, goalReview: bare });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('itemRefs');
  });
});

describe('goal-local planning review', () => {
  it('accepts an evidence-backed sufficient-plan review with zero new ideas', () => {
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 0, goalReview }).success).toBe(true);
  });

  it('requires evidence and rationale instead of a no-work checkbox', () => {
    for (const patch of [{ evidenceRefs: [] }, { rationale: ' ' }, { goalId: ' ' }]) {
      expect(ideatePassRecordArgs.safeParse({ ideasFiled: 0, goalReview: { ...goalReview, ...patch } }).success).toBe(false);
    }
    expect(ideatePassRecordArgs.safeParse({
      ideasFiled: 0,
      goalReview: { ...goalReview, portfolioFingerprint: 'caller-forged' },
    }).success).toBe(false);
  });

  // P-003: a no-new-plan review must show which plan covers each recurring need.
  it('refuses a no-new-plan review without a coverage map, or with an unplanned 3+ item cluster', () => {
    const { coverage: _omit, ...unbacked } = goalReview;
    const missing = ideatePassRecordArgs.safeParse({ ideasFiled: 0, goalReview: unbacked });
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error?.issues)).toContain('coverage map');
    const cluster = ideatePassRecordArgs.safeParse({
      ideasFiled: 0,
      goalReview: { ...goalReview, coverage: [{ need: 'stale loop wakes', itemRefs: ['WI-4', 'WI-5', 'WI-6'] }] },
    });
    expect(cluster.success).toBe(false);
    expect(JSON.stringify(cluster.error?.issues)).toContain('plans:new');
    expect(ideatePassRecordArgs.safeParse({
      ideasFiled: 0,
      goalReview: { ...goalReview, coverage: [{ need: 'one-off typo', itemRefs: ['WI-7'], justification: 'single item, drain handles it' }] },
    }).success).toBe(true);
  });

  it('refuses a coverage planRef that names no live plan, recording nothing', async () => {
    const recordTick = vi.fn(async () => {});
    const result = await runIdeatePassRecord(
      { ideasFiled: 0, goalReview },
      { ownerId: 'su-goal', workspaceId: 'ws-1' },
      {
        recordTick,
        readGoalReviewContext: async () => reviewContext,
        missingPlanRefs: async (_ws, refs) => [...refs],
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'goal-review-unresolved-plan-ref' });
    expect(recordTick).not.toHaveBeenCalled();
  });

  it('requires the uncovered outcome for a new-plan disposition', () => {
    const input = { ...goalReview, disposition: 'plan-needed' };
    expect(ideatePassRecordArgs.safeParse({ ideasFiled: 0, goalReview: input }).success).toBe(false);
    expect(ideatePassRecordArgs.safeParse({
      ideasFiled: 0,
      goalReview: { ...input, uncoveredOutcome: 'Existing plans do not cover failed-checkout recovery.' },
    }).success).toBe(true);
  });

  it('requires an existing plan reference for adoption or revision', () => {
    for (const disposition of ['adopt-plan', 'revise-plan']) {
      expect(ideatePassRecordArgs.safeParse({
        ideasFiled: 0, goalReview: { ...goalReview, disposition, planRefs: [] },
      }).success).toBe(false);
      expect(ideatePassRecordArgs.safeParse({
        ideasFiled: 0, goalReview: { ...goalReview, disposition },
      }).success).toBe(true);
    }
  });

  it('writes the review on the existing tick with server-derived scope and fingerprint', async () => {
    const readGoalReviewContext = vi.fn(async () => reviewContext);
    const { deps, recordTick } = makeDeps({ readGoalReviewContext });
    const out = await runIdeatePassRecord({ ideasFiled: 0, goalReview }, { harnessSlug: 'papercusp' }, deps);
    expect(readGoalReviewContext).toHaveBeenCalledWith('ws-1', 'su-caller');
    const storedReview = {
      ...goalReview,
      schemaVersion: 1,
      portfolioFingerprint: reviewContext.portfolioFingerprint,
      reviewedAt: reviewContext.observedAt,
    };
    expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      origin: 'su-ideate',
      ideasRouted: 0,
      detail: { owner: 'su-caller', goalReview: storedReview },
    }));
    expect(out).toMatchObject({ ok: true, ideasFiled: 0, goalReview: storedReview });
  });

  it('refuses a review for a different goal without writing a tick', async () => {
    const { deps, recordTick } = makeDeps({ readGoalReviewContext: vi.fn(async () => ({ ...reviewContext, goalId: 'other-goal' })) });
    const out = await runIdeatePassRecord({ ideasFiled: 0, goalReview }, { harnessSlug: 'papercusp' }, deps);
    expect(out).toMatchObject({ ok: false, reason: 'goal-review-scope-mismatch' });
    expect(recordTick).not.toHaveBeenCalled();
    expect(toToolResult(out).isError).toBe(true);
  });

  it.each(['absent', 'failed'])('keeps %s goal scope unmeasured instead of recording a review', async (failure) => {
    const readGoalReviewContext = vi.fn(async () => {
      if (failure === 'failed') throw new Error('read failed');
      return null;
    });
    const { deps, recordTick } = makeDeps({ readGoalReviewContext });
    const out = await runIdeatePassRecord({ ideasFiled: 0, goalReview }, { harnessSlug: 'papercusp' }, deps);
    expect(out).toMatchObject({ ok: false, reason: 'goal-review-unavailable' });
    expect(recordTick).not.toHaveBeenCalled();
  });

  it('leaves ordinary ideation records backward compatible without a goal read', async () => {
    const readGoalReviewContext = vi.fn(async () => reviewContext);
    const { deps } = makeDeps({ readGoalReviewContext });
    const out = await runIdeatePassRecord({ ideasFiled: 1 }, { harnessSlug: 'papercusp' }, deps);
    expect(out).toMatchObject({ ok: true, ideasFiled: 1 });
    expect(out).not.toHaveProperty('goalReview');
    expect(readGoalReviewContext).not.toHaveBeenCalled();
  });
});

describe('goal review → routed-idea ledger feedback (P-009)', () => {
  const feedback = [{ planRef: 'plan:papercusp/existing-plan', action: 'existing-attribution' as const, ideaId: 'scout-1', origin: 'scout' }];

  it('feeds the recorded review, with server-derived scope, into the ledger and echoes the disposition', async () => {
    const recordGoalFeedback = vi.fn(async () => feedback);
    const { deps, recordTick } = makeDeps({ readGoalReviewContext: vi.fn(async () => reviewContext), recordGoalFeedback });
    const out = await runIdeatePassRecord({ ideasFiled: 0, goalReview }, { harnessSlug: 'papercusp' }, deps);
    expect(recordTick).toHaveBeenCalledTimes(1);
    expect(recordGoalFeedback).toHaveBeenCalledTimes(1);
    expect(recordGoalFeedback).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      ownerId: 'su-caller',
      review: expect.objectContaining({ goalId: 'goal-1', planRefs: goalReview.planRefs, portfolioFingerprint: 'server-measured-portfolio' }),
    });
    expect(vi.mocked(recordTick).mock.invocationCallOrder[0]).toBeLessThan(recordGoalFeedback.mock.invocationCallOrder[0]!);
    expect(out).toMatchObject({ ok: true, goalFeedback: feedback });
  });

  it('keeps the review recorded when ledger feedback fails, and skips feedback without plan refs or a review', async () => {
    const failing = vi.fn(async () => { throw new Error('ledger down'); });
    const { deps, recordTick } = makeDeps({ readGoalReviewContext: vi.fn(async () => reviewContext), recordGoalFeedback: failing });
    const out = await runIdeatePassRecord({ ideasFiled: 0, goalReview }, { harnessSlug: 'papercusp' }, deps);
    expect(recordTick).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    expect(out).not.toHaveProperty('goalFeedback');

    const unused = vi.fn(async () => feedback);
    const noRefs = makeDeps({ readGoalReviewContext: vi.fn(async () => reviewContext), recordGoalFeedback: unused });
    await runIdeatePassRecord(
      { ideasFiled: 0, goalReview: { ...goalReview, disposition: 'no-eligible-work', planRefs: [] } },
      { harnessSlug: 'papercusp' },
      noRefs.deps,
    );
    await runIdeatePassRecord({ ideasFiled: 1 }, { harnessSlug: 'papercusp' }, noRefs.deps);
    expect(unused).not.toHaveBeenCalled();
  });
});

describe('goal-day ideation yield on the receipt (P-004 / D-001)', () => {
  const goalDay = (plansNew: number, ideasFiled: number) =>
    vi.fn(async () => ({ since: '2026-09-22T06:00:00.000Z', plansNew, ideasFiled }));

  it('reports owed:true when the goal-day has no candidate, this zero-idea pass included', async () => {
    const readGoalDayCandidates = goalDay(0, 0);
    const { deps } = makeDeps({ readGoalReviewContext: vi.fn(async () => reviewContext), readGoalDayCandidates });
    const out = await runIdeatePassRecord({ ideasFiled: 0, goalReview }, { harnessSlug: 'papercusp' }, deps);
    expect(readGoalDayCandidates).toHaveBeenCalledWith({ workspaceId: 'ws-1', goalId: 'goal-1', at: expect.any(Date) });
    expect(out).toMatchObject({ ok: true, ideationYield: { goalId: 'goal-1', candidates: 0, owed: true } });
    expect(out.ok && out.ideationYield?.message).toMatch(/owes at least 1 per goal-day/);
  });

  it("adds this pass's ideas, which the ledger does not hold yet, so one filed idea discharges the day", async () => {
    const { deps } = makeDeps({ readGoalReviewContext: vi.fn(async () => reviewContext), readGoalDayCandidates: goalDay(0, 0) });
    const out = await runIdeatePassRecord({ ideasFiled: 1, goalReview }, { harnessSlug: 'papercusp' }, deps);
    expect(out).toMatchObject({ ok: true, ideationYield: { ideasFiled: 1, candidates: 1, owed: false } });
  });

  it('counts a plan proposed for the goal earlier in the goal-day as a candidate', async () => {
    const { deps } = makeDeps({ readGoalReviewContext: vi.fn(async () => reviewContext), readGoalDayCandidates: goalDay(1, 0) });
    const out = await runIdeatePassRecord({ ideasFiled: 0, goalReview }, { harnessSlug: 'papercusp' }, deps);
    expect(out).toMatchObject({ ok: true, ideationYield: { plansNew: 1, candidates: 1, owed: false } });
  });

  it('omits ideationYield when the count cannot be read, and never reads it for an ordinary pass', async () => {
    const failing = vi.fn(async () => { throw new Error('pg down'); });
    const withGoal = makeDeps({ readGoalReviewContext: vi.fn(async () => reviewContext), readGoalDayCandidates: failing });
    const out = await runIdeatePassRecord({ ideasFiled: 0, goalReview }, { harnessSlug: 'papercusp' }, withGoal.deps);
    expect(out.ok).toBe(true);
    expect(out).not.toHaveProperty('ideationYield');
    const plain = goalDay(0, 0);
    const ordinary = makeDeps({ readGoalDayCandidates: plain });
    await runIdeatePassRecord({ ideasFiled: 0 }, { harnessSlug: 'papercusp' }, ordinary.deps);
    expect(plain).not.toHaveBeenCalled();
  });

  it('shares the WOE threshold and never counts a negative or fractional input as a candidate', () => {
    expect(GOAL_DAY_MIN_CANDIDATES).toBe(1);
    const y = goalDayIdeationYield({ goalId: 'g', since: 's', plansNew: -2, priorIdeasFiled: 0.5, thisPassIdeasFiled: -1 });
    expect(y).toMatchObject({ plansNew: 0, ideasFiled: 0, candidates: 0, owed: true });
  });
});

describe('toToolResult', () => {
  it('wraps an ok result with no isError flag', () => {
    const env = toToolResult({
      ok: true,
      origin: 'su-ideate',
      status: 'ran',
      ideasFiled: 1,
      owner: 'su-caller',
      installSlug: 'papercusp',
    });
    expect(env.isError).toBeUndefined();
    expect(JSON.parse(env.content[0].text)).toMatchObject({ ok: true, origin: 'su-ideate' });
  });
});
