import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enqueue: vi.fn(), resolve: vi.fn() }));
vi.mock('./dbos/primary-dbos-client', () => ({
  getPrimaryDbosClient: async () => ({ enqueue: h.enqueue }),
  primaryDbosAppVersion: () => 'primary-version',
}));
vi.mock('./acceptance-grader', () => ({
  ACCEPTANCE_GRADING_SWEEP_ACTOR: 'system:acceptance-grading-sweep',
  resolveAcceptanceGrader: h.resolve,
}));
import {
  acceptanceGradingDispatchId,
  enqueueAcceptanceGradingDispatch,
  executeAcceptanceGradingDispatch,
  type AcceptanceGradingDispatch,
} from './acceptance-grading-sweep-dispatch';

const input: AcceptanceGradingDispatch = {
  workspaceId: 'ws', harnessSlug: 'app', planSlug: 'ready-plan', gradeableSinceMs: 123,
};
beforeEach(() => {
  h.enqueue.mockReset().mockResolvedValue({ getResult: () => { throw new Error('detector must not wait for the workflow result'); } });
  h.resolve.mockReset().mockResolvedValue({ state: 'launched' });
});

describe('grading dispatch episode admission', () => {
  it('reuses an episode across repeated/concurrent admissions and retains the primary version', async () => {
    const receipts = await Promise.all(Array.from({ length: 4 }, () => enqueueAcceptanceGradingDispatch({ ...input })));
    expect(new Set(receipts.map(r => r.workflowId)).size).toBe(1);
    for (const [options, payload] of h.enqueue.mock.calls) {
      expect(options).toEqual({
        workflowName: 'acceptanceGradingDispatch', queueName: 'acceptance-grading-dispatch',
        workflowID: receipts[0].workflowId, deduplicationID: receipts[0].workflowId,
        duplicationPolicy: 'return-existing', appVersion: 'primary-version',
      });
      expect(payload).toEqual(input);
    }
  });

  it.each([
    { workspaceId: 'other-ws' }, { harnessSlug: 'other-app' },
    { planSlug: 'other-plan' }, { gradeableSinceMs: 124 },
  ])('distinguishes a different scope or episode: %j', (changed) => {
    expect(acceptanceGradingDispatchId({ ...input, ...changed })).not.toBe(acceptanceGradingDispatchId(input));
  });

  it.each([
    { workspaceId: '' }, { harnessSlug: '' }, { planSlug: ' ' },
    { gradeableSinceMs: NaN }, { gradeableSinceMs: -1 }, { gradeableSinceMs: 1.5 },
  ])('refuses incomplete identity before durable submission: %j', async (changed) => {
    await expect(enqueueAcceptanceGradingDispatch({ ...input, ...changed })).rejects.toThrow('complete scope and gradeable-since');
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('pins the receiver launch identity across replay and forwards the scoped system principal', async () => {
    const first = await executeAcceptanceGradingDispatch(input);
    h.resolve.mockResolvedValueOnce({ state: 'deduped' });
    const replay = await executeAcceptanceGradingDispatch({ ...input });
    expect(replay.workflowId).toBe(first.workflowId);
    expect(h.resolve).toHaveBeenLastCalledWith('ready-plan', expect.objectContaining({
      workspaceId: 'ws', harnessSlug: 'app',
      principal: { kind: 'system', slug: 'system:acceptance-grading-sweep', workspaceId: 'ws', capabilities: new Set<string>() },
    }), { dispatchEpisodeIdentity: first.workflowId });
  });

  it('leaves a failed effect retryable instead of recording a successful workflow step', async () => {
    h.resolve.mockResolvedValueOnce({ state: 'failed', error: 'launch transport unavailable' });
    await expect(executeAcceptanceGradingDispatch(input)).rejects.toThrow('launch transport unavailable');
  });
});
