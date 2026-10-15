import { describe, expect, it } from 'vitest';
import { goalPlanningPortfolioFingerprint, goalPlanningReviewInputSchema, parseGoalPlanningReview } from './goal-planning-review';

const review = {
  goalId: 'goal-1',
  disposition: 'existing-plans-sufficient',
  rationale: 'The existing plan covers the remaining outcome.',
  evidenceRefs: ['plan:papercusp/checkout'],
  planRefs: ['plan:papercusp/checkout'],
  coverage: [{ need: 'checkout recovery', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'plan:papercusp/checkout' }],
};
const portfolio = {
  goal: { id: 'goal-1', title: 'Checkout', status: 'active', body: 'Recover failed checkouts', killCriterion: null, standing: true, parentId: null },
  worklist: [{ ref: 'plan:papercusp/checkout', status: 'active' }],
  pending: { blenderIdeas: 0 },
};

describe('goal planning review contract', () => {
  it('represents sufficient existing plans without requiring a new idea', () => {
    expect(goalPlanningReviewInputSchema.parse(review)).toEqual(review);
  });
  it('does not accept caller-authored measurement fields', () => {
    expect(goalPlanningReviewInputSchema.safeParse({ ...review, reviewedAt: '2026-09-23T06:00:00Z' }).success).toBe(false);
    expect(goalPlanningReviewInputSchema.safeParse({ ...review, portfolioFingerprint: 'forged' }).success).toBe(false);
  });
  it('reads only complete supported persisted reviews', () => {
    const persisted = { ...review, schemaVersion: 1, portfolioFingerprint: 'measured', reviewedAt: '2026-09-23T06:00:00Z' };
    expect(parseGoalPlanningReview(persisted)).toEqual(persisted);
    expect(parseGoalPlanningReview({ ...persisted, schemaVersion: 2 })).toBeNull();
    expect(parseGoalPlanningReview({ ...persisted, evidenceRefs: [] })).toBeNull();
    expect(parseGoalPlanningReview(review)).toBeNull();
    expect(parseGoalPlanningReview(null)).toBeNull();
  });
  it('ignores observation clocks and ordinary activity while pinning planning state', () => {
    const measured = goalPlanningPortfolioFingerprint(portfolio);
    const observedAgain = { ...portfolio, assembledAt: 'later', queue: { inFlight: 100 } };
    expect(goalPlanningPortfolioFingerprint(observedAgain)).toBe(measured);
    expect(goalPlanningPortfolioFingerprint({ ...portfolio, goal: { ...portfolio.goal, body: 'A changed outcome' } })).not.toBe(measured);
    expect(goalPlanningPortfolioFingerprint({ ...portfolio, goal: { ...portfolio.goal, status: 'paused' } })).not.toBe(measured);
    expect(goalPlanningPortfolioFingerprint({ ...portfolio, pending: { blenderIdeas: 1 } })).not.toBe(measured);
    expect(goalPlanningPortfolioFingerprint({ ...portfolio, worklist: [{ ref: 'plan:papercusp/checkout', status: 'shipped' }] })).not.toBe(measured);
  });
  it('preserves worklist priority in the fingerprint', () => {
    const plans = [...portfolio.worklist, { ref: 'plan:papercusp/recovery', status: 'ready' }];
    expect(goalPlanningPortfolioFingerprint({ ...portfolio, worklist: plans })).not.toBe(
      goalPlanningPortfolioFingerprint({ ...portfolio, worklist: [...plans].reverse() }),
    );
  });
});
