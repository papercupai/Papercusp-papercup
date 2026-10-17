import { describe, expect, it, vi } from 'vitest';

const reviewMocks = vi.hoisted(() => ({
  captureImprovement: vi.fn(),
  enterAgentReview: vi.fn(),
  setCaptureReviewState: vi.fn(),
  recordCaptureReviewFailure: vi.fn(),
}));

vi.mock('../improvements/capture-core', () => ({
  captureImprovement: reviewMocks.captureImprovement,
  setCaptureReviewState: reviewMocks.setCaptureReviewState,
  recordCaptureReviewFailure: reviewMocks.recordCaptureReviewFailure,
}));
vi.mock('../improvements/agent-review', () => ({ enterAgentReview: reviewMocks.enterAgentReview }));

import { makeWorkItemAdmissionDeltaSweepAction, productionFileUmbrella } from './work-item-admission-delta-sweep-action';

describe('work-item admission delta-sweep system action', () => {
  it('runs one durable tick, invalidates the ledger, and logs the umbrella yield', async () => {
    const run = vi.fn(async () => ({
      runId: 'delta-live-1',
      recentItems: 5,
      titleItems: 17,
      clusterShards: 2,
      sourceCensusRunId: 'census-live',
      modelCalled: true,
      tokensIn: 400,
      tokensOut: 80,
      umbrellaYield: 1,
      linksWritten: 5,
      umbrellas: [
        {
          id: 'EI-umbrella',
          created: true,
          title: 'Shared lock leak',
          memberIds: ['WI-1', 'WI-2', 'WI-3', 'WI-4', 'WI-5'],
          linksWritten: 5,
        },
      ],
    }));
    const invalidate = vi.fn(async () => undefined);
    const log = vi.fn();
    const action = makeWorkItemAdmissionDeltaSweepAction({ run, invalidate, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws', installSlug: 'papercusp' }));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('umbrellas=1 links=5'));
  });

  it('files unverified model umbrellas as review-required changes and enrolls them before reopening', async () => {
    reviewMocks.captureImprovement.mockResolvedValue({
      created: true,
      reviewRequired: true,
      reviewState: 'blocked',
      issue: { id: 'EI-umbrella', title: 'Possible shared cause: Shared lock leak' },
    });
    reviewMocks.enterAgentReview.mockResolvedValue({ entered: true });
    reviewMocks.setCaptureReviewState.mockResolvedValue({
      workItem: { id: 'EI-umbrella', state: 'open' },
      appliedState: 'open',
    });

    const filed = await productionFileUmbrella({
      runId: 'delta-review-1',
      harnessSlug: 'papercusp',
      watchdogKey: 'delta-sweep:shared-lock',
      proposal: {
        title: 'Shared lock leak',
        body: 'Several admitted work-items report the same lock symptom.',
        reason: 'Model-proposed hypothesis; not independently verified.',
        memberIds: ['EI-1', 'EI-2', 'EI-3'],
      },
    });

    expect(reviewMocks.captureImprovement).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'change',
      reviewRequired: true,
      reviewHarness: 'papercusp',
      sourceRole: 'system',
    }));
    expect(reviewMocks.captureImprovement.mock.calls[0]?.[0]).not.toHaveProperty('severity', 'major');
    expect(reviewMocks.enterAgentReview).toHaveBeenCalledWith({
      id: 'EI-umbrella',
      submittedBy: 'system:work-item-admission-delta-sweep',
      harnessSlug: 'papercusp',
    });
    expect(reviewMocks.setCaptureReviewState).toHaveBeenCalledWith(
      'EI-umbrella',
      'open',
      expect.objectContaining({ reason: 'agent-review enrollment succeeded' }),
    );
    expect(filed).toEqual({ id: 'EI-umbrella', created: true });
  });
});
