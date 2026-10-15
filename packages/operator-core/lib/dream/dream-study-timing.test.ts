import { describe, expect, it, vi } from 'vitest';
import { captureStudyTiming } from './study/timing.mts';
import { dreamCallOwnerId } from './dream-cycle';

const scope = { workspaceId: 'timing-test', potSlug: 'test' };
describe('Dream study named gateway evidence capture', () => {
  it('preserves the actual measured timeline for each dispatched phase once', async () => {
    const log = vi.fn(async (_entry: unknown) => {});
    const report = vi.fn(async (ownerId: string) => ({
      stageTelemetry: { ownerId, recent: [{ ownerId, requestId: 17, durationsMs: { queueWait: 5, upstreamService: 90 } }] },
    }));
    await captureStudyTiming(scope, [{ runId: 'r', phases: ['generation', 'review', 'rerank'] }], { report, log });
    expect(report.mock.calls.map(([owner]) => owner)).toEqual([
      dreamCallOwnerId(scope, 'r', 'generation'), dreamCallOwnerId(scope, 'r', 'review'),
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toMatchObject({
      runId: 'r', callPhase: 'review', status: 'captured',
      stageTelemetry: { recent: [{ requestId: 17, durationsMs: { queueWait: 5, upstreamService: 90 } }] },
    });
  });

  it.each(['empty', 'wrong-owner', 'mixed-owners', 'throws'])('labels %s evidence unknown rather than capacity starvation', async (mode) => {
    const log = vi.fn(async (_entry: unknown) => {});
    const report = vi.fn(async (ownerId: string) => {
      if (mode === 'throws') throw new Error('report unavailable');
      return { stageTelemetry: {
        ownerId: mode === 'wrong-owner' ? 'other' : ownerId,
        recent: mode === 'empty' ? [] : [{ ownerId: mode === 'mixed-owners' ? 'other' : ownerId }],
      } };
    });
    await captureStudyTiming(scope, [{ runId: 'r', phases: ['review'] }], { report, log });
    expect(report).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ status: 'unavailable', callPhase: 'review' });
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty('stageTelemetry');
  });
});
