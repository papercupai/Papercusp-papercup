import { describe, expect, it } from 'vitest';
import { REVIEWABLE_MISS_SAMPLE, reviewableMiss } from './reviewable-miss';

describe('reviewableMiss (WI-10004358)', () => {
  it('returns null when nothing is pending peer review', () => {
    expect(reviewableMiss({ pendingAgentReview: 0 })).toBeNull();
    expect(reviewableMiss(null)).toBeNull();
    expect(reviewableMiss(undefined)).toBeNull();
    expect(reviewableMiss({ pendingAgentReview: Number.NaN })).toBeNull();
    expect(reviewableMiss({ pendingAgentReview: -2 })).toBeNull();
  });

  it('threads harness + spec into every step of the review route', () => {
    const r = reviewableMiss({ pendingAgentReview: 24 }, { harness: 'papercusp', spec: 'goal-drain-x' });
    expect(r).not.toBeNull();
    expect(r!.route).toEqual({
      pendingAgentReview: 24,
      list: {
        tool: 'work_items:claimable',
        args: {
          harness: 'papercusp',
          spec: 'goal-drain-x',
          breakdownOnly: true,
          sampleExcluded: REVIEWABLE_MISS_SAMPLE,
          projection: { pick: ['excludedSample.queueControl.agentReview'] },
        },
        idsAt: 'excludedSample.queueControl.agentReview[].id',
      },
      claim: {
        tool: 'improvements:agent-review',
        mode: 'claim',
        idFrom: 'excludedSample.queueControl.agentReview[].id',
        harness: 'papercusp',
      },
      grade: { tool: 'blender:grade-idea', ideaIdFrom: 'ledgerIdeaId' },
    });
    expect(r!.route.claim.idFrom).toBe(r!.route.list.idsAt);
    expect(r!.route.list.args.projection).toEqual({ pick: ['excludedSample.queueControl.agentReview'] });
    expect(r!.advice).toContain("work_items:claimable { harness:'papercusp', spec:'goal-drain-x', breakdownOnly:true");
    expect(r!.advice).toContain("improvements:agent-review { mode:'claim', id:<listed id>, harness:'papercusp' }");
  });

  it('omits absent scope keys instead of emitting empty strings', () => {
    const r = reviewableMiss({ pendingAgentReview: 1 }, { harness: '  ', spec: null });
    expect(r!.route.list.args).toEqual({
      breakdownOnly: true,
      sampleExcluded: REVIEWABLE_MISS_SAMPLE,
      projection: { pick: ['excludedSample.queueControl.agentReview'] },
    });
    expect(r!.route.claim).toEqual({
      tool: 'improvements:agent-review',
      mode: 'claim',
      idFrom: 'excludedSample.queueControl.agentReview[].id',
    });
    expect(r!.route.claim).not.toHaveProperty('args');
    expect(r!.advice).not.toContain("harness:''");
  });

  it('keeps review claims inside the scoped sample and never advertises harness-wide claim-next', () => {
    const r = reviewableMiss({ pendingAgentReview: 3 });
    expect(r!.message).toMatch(/never self-clears/);
    expect(r!.advice).toMatch(/claimed:false/);
    expect(r!.advice).toContain("reason 'agent-review-not-pending'");
    expect(r!.advice).toMatch(/read-only snapshot, not a reservation/);
    expect(r!.advice).toMatch(/refresh the scoped claimability sample/);
    expect(r!.advice).toMatch(/does not establish a selector defect/);
    expect(r!.advice).toMatch(/no review is available from this bounded sample/);
    expect(r!.advice).toMatch(/Do not use claim-next/);
    expect(r!.advice).not.toContain("mode:'claim-next'");
    expect(r!.advice).toMatch(/does not prove the full pending-review population is exhausted/);
  });

  it('qualifies grade-4 approval advice with the bug reproduction gate', () => {
    const advice = reviewableMiss({ pendingAgentReview: 1 })!.advice;
    expect(advice).toContain('A grade of 4+ approves only after its gates pass');
    expect(advice).toContain('bugs need an accepted current-build reproduction receipt');
    expect(advice).toContain('leaves the bug revision-requested/not-ready');
    expect(advice).not.toContain('4+ approves it into the claimable pool');
    expect(advice).toContain('A grade of 3 or lower sends it back for revision');
  });
});
