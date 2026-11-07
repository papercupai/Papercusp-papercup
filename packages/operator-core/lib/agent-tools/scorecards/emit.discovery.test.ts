import { beforeEach, describe, expect, it, vi } from 'vitest';
const reads = vi.hoisted(() => ({ rubric: vi.fn() }));
vi.mock('../../rubrics', async original => ({
  ...(await original<typeof import('../../rubrics')>()), readRubric: reads.rubric,
}));
import { emitScorecard } from './emit';
import { specQualitySubjectRef } from '../plans/spec-quality';

describe('spec-quality review emission discovery admission', () => {
  beforeEach(() => { vi.clearAllMocks(); reads.rubric.mockResolvedValue({ kind: 'missing' }); });
  const args = () => ({ rubricRef: 'spec-quality', terminal: true,
    subject: { kind: 'plan' as const, ref: specQualitySubjectRef('review-plan', 'plan-class-feature-ship', 'a'.repeat(64)) },
    ratings: {} });
  const input = { createdBy: 'su-reviewer', workspaceId: 'ws-review', ctxHarness: 'reviewer-home' };
  it('resolves the subject harness and refuses stale discovery before grading, persistence, or recruitment', async () => {
    const gate = vi.fn(async () => ({ ok: false as const, error: 'discovery_not_ready' as const, nextAction: 'Reconcile discovery.' }));
    const result = await emitScorecard(args(), input, {
      resolveSpecQualityPlanSubject: async () => ({ planSlug: 'review-plan', harnessSlug: 'subject-harness' }),
      withCurrentDiscovery: gate as never,
    });
    expect(result).toMatchObject({ ok: false, code: 'discovery_not_ready' });
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'review-plan', harnessSlug: 'subject-harness' }), expect.any(Function));
    expect(reads.rubric).not.toHaveBeenCalled();
  });
  it('admits a current finalized subject to the existing emitter', async () => {
    const result = await emitScorecard(args(), input, {
      resolveSpecQualityPlanSubject: async () => ({ planSlug: 'review-plan', harnessSlug: 'subject-harness' }),
      withCurrentDiscovery: (async (_input: unknown, accept: () => Promise<unknown>) => ({ ok: true, result: await accept() })) as never,
    });
    expect(reads.rubric).toHaveBeenCalledWith('spec-quality');
    expect(result).toMatchObject({ ok: false, error: "rubric 'spec-quality' not found" });
  });
  it('refuses unresolved or forged subject identity before any emitter effect', async () => {
    const gate = vi.fn();
    const result = await emitScorecard(args(), input, {
      resolveSpecQualityPlanSubject: async () => null, withCurrentDiscovery: gate as never,
    });
    expect(result).toMatchObject({ ok: false, code: 'discovery_subject_unresolved' });
    expect(gate).not.toHaveBeenCalled();
    expect(reads.rubric).not.toHaveBeenCalled();
  });
});
