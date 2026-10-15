/**
 * plan-cleanup-system-repair-2026-10-01 P-004 (WI-10004728) — the deterministic
 * recurring plan clean-up. It replaces an LLM plan-run template that never
 * produced a single cleanup run, so the guard here is: a fire STARTS A RUN through
 * the shared start path, every skip says why, and a failed run fails the fire.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./system-actions', () => ({ registerSystemAction: vi.fn() }));

import { makePlanCleanupSweepAction, type PlanCleanupSweepDeps } from './plan-cleanup-sweep-action';
import { cleanupWorkflowRunId, MAX_RUN_PLANS, PLAN_CLEANUP_SWEEP_REQUESTER } from '../../plan-cleanup/start-run';
import type { SystemActionCtx } from './system-actions';

const CTX: SystemActionCtx = {
  installSlug: 'papercusp',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
};

function deps(overrides: Partial<PlanCleanupSweepDeps> = {}) {
  const logs: string[] = [];
  const base: PlanCleanupSweepDeps = {
    readRun: vi.fn(async () => null),
    enabled: vi.fn(async () => true),
    runningRun: vi.fn(async () => null),
    listPlans: vi.fn(async () => ['plan-a', 'plan-b', 'plan-c']),
    select: vi.fn(async (input) => ({
      planSlugs: input.planSlugs.slice(0, 2),
      requested: input.planSlugs.length,
      accepted: 2,
      truncated: input.planSlugs.length - 2,
    })),
    readPolicy: vi.fn(async () => ({ mode: 'recommend', minConfidence: 'high' }) as never),
    readLaunchProfile: vi.fn(async () => null),
    start: vi.fn(async () => ({
      kind: 'settled' as const,
      runId: 'run-1',
      phase: 'complete' as const,
      totalPlans: 2,
      launched: false,
      resolverNeeded: false,
      deterministic: { applied: 3 } as never,
    })),
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps: base, logs };
}

describe('system:plan-cleanup-sweep', () => {
  it('DBOS replay resumes its existing run before the competing-run skip or fresh selection', async () => {
    const { deps: d, logs } = deps({
      readRun: vi.fn(async () => ({
        runId: cleanupWorkflowRunId('workflow-1'), seedRefs: ['original-plan'],
        filterSnapshot: { routineWorkflowId: 'workflow-1' },
        launchSnapshot: { model: 'gpt-6.1-sol', effort: 'xhigh', account: 'default', carry: 'warm' },
        automationPolicy: { mode: 'recommend', minConfidence: 'high' },
      }) as never),
      runningRun: vi.fn(async () => ({ runId: cleanupWorkflowRunId('workflow-1'), phase: 'pending' })),
    });
    const result = await makePlanCleanupSweepAction(d)({ ...CTX, workflowId: 'workflow-1' });
    expect(result.diagnostics).toMatchObject({ outcome: 'resumed' });
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'workflow-1', planSlugs: ['original-plan'] }));
    expect(d.runningRun).not.toHaveBeenCalled();
    expect(d.listPlans).not.toHaveBeenCalled();
    expect(d.readLaunchProfile).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('recovered workflow=workflow-1');
  });

  it('a new workflow retains the competing-run single-flight guard', async () => {
    const { deps: d } = deps({ runningRun: vi.fn(async () => ({ runId: 'other-run', phase: 'running' })) });
    const result = await makePlanCleanupSweepAction(d)({ ...CTX, workflowId: 'workflow-2' });
    expect(result.diagnostics).toMatchObject({ outcome: 'skipped', runId: 'other-run' });
    expect(d.start).not.toHaveBeenCalled();
  });

  it('passes the durable fire identity into a first start', async () => {
    const { deps: d } = deps();
    await makePlanCleanupSweepAction(d)({ ...CTX, workflowId: 'workflow-1' });
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'workflow-1' }));
  });

  it('a fire starts a plan-cleanup run through the shared start path', async () => {
    const { deps: d } = deps();
    const result = await makePlanCleanupSweepAction(d)(CTX);
    expect(d.listPlans).toHaveBeenCalledWith({ workspaceId: 'ws-1', harnessSlug: 'papercusp' });
    expect(d.select).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlugs: ['plan-a', 'plan-b', 'plan-c'],
      max: MAX_RUN_PLANS,
    });
    expect(d.start).toHaveBeenCalledWith(
      expect.objectContaining({
        planSlugs: ['plan-a', 'plan-b'],
        harness: 'papercusp',
        workspaceId: 'ws-1',
        requestedBy: PLAN_CLEANUP_SWEEP_REQUESTER,
        filter: { source: PLAN_CLEANUP_SWEEP_REQUESTER, requested: 3, accepted: 2, truncated: 1 },
      }),
    );
    expect(result.diagnostics).toMatchObject({
      outcome: 'started',
      runId: 'run-1',
      phase: 'complete',
      applied: 3,
      resolverNeeded: false,
      requested: 3,
      accepted: 2,
      truncated: 1,
    });
  });

  it('honours a smaller trigger_config.max_plans but never exceeds MAX_RUN_PLANS', async () => {
    const small = deps();
    await makePlanCleanupSweepAction(small.deps)({ ...CTX, triggerConfig: { max_plans: 25 } });
    expect(small.deps.select).toHaveBeenCalledWith(expect.objectContaining({ max: 25 }));

    const huge = deps();
    await makePlanCleanupSweepAction(huge.deps)({ ...CTX, triggerConfig: { max_plans: 10_000 } });
    expect(huge.deps.select).toHaveBeenCalledWith(expect.objectContaining({ max: MAX_RUN_PLANS }));
  });

  it.each([
    ['flag off', { enabled: vi.fn(async () => false) }, /feature flag is off/],
    ['a run executing', { runningRun: vi.fn(async () => ({ runId: 'run-0', phase: 'running' })) }, /run=run-0 is running/],
    ['no open plans', { listPlans: vi.fn(async () => []) }, /no open plans/],
  ] as const)('every skip says why: %s', async (_label, override, reason) => {
    const { deps: d, logs } = deps(override as Partial<PlanCleanupSweepDeps>);
    const result = await makePlanCleanupSweepAction(d)(CTX);
    expect(result.diagnostics).toMatchObject({ outcome: 'skipped' });
    expect(String(result.diagnostics?.reason)).toMatch(reason);
    expect(logs.join('\n')).toMatch(reason);
    expect(d.start).not.toHaveBeenCalled();
  });

  // WI-10004814: run bulk-c830bde2 launched claude on `default` while the standing
  // plan-cleanup profile named gpt-6.1-sol/xhigh — the sweep never read the profile.
  it('launches the standing plan-cleanup resolver profile, with authority from the policy', async () => {
    const { deps: d } = deps({
      // The standing policy's LEVEL drives the mode (bulkAutomationSnapshot: L0 → review-all).
      readPolicy: vi.fn(async () => ({ level: 'L0', minConfidence: 'high' }) as never),
      readLaunchProfile: vi.fn(async () => ({
        model: 'gpt-6.1-sol',
        effort: 'xhigh' as const,
        account: 'default',
        carry: 'warm' as const,
        // A profile-borne mode must NOT override the standing policy's authority.
        automationMode: 'safe-medium-plus' as const,
      })),
    });
    await makePlanCleanupSweepAction(d)(CTX);
    expect(d.readLaunchProfile).toHaveBeenCalledTimes(1);
    const launch = (d.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.launch;
    expect(launch).toMatchObject({
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      account: 'default',
      carry: 'warm',
      backend: 'codex',
      automationMode: 'review-all',
      minConfidence: 'high',
    });
  });

  it('no stored profile launches the built-in defaults', async () => {
    const { deps: d } = deps();
    await makePlanCleanupSweepAction(d)(CTX);
    const launch = (d.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.launch;
    expect(launch).toMatchObject({ model: null, effort: null, account: 'default', carry: 'warm' });
  });

  it('an unreadable profile FAILS the fire instead of silently launching the defaults', async () => {
    const { deps: d } = deps({
      readLaunchProfile: vi.fn(async () => {
        throw new Error('operator_state unavailable');
      }),
    });
    await expect(makePlanCleanupSweepAction(d)(CTX)).rejects.toThrow(/operator_state unavailable/);
    expect(d.start).not.toHaveBeenCalled();
  });

  it('losing the single-flight race is a logged skip', async () => {
    const { deps: d } = deps({
      start: vi.fn(async () => ({
        kind: 'already-active' as const,
        error: Object.assign(new Error('busy'), { activeRunId: 'run-9' }) as never,
      })),
    });
    const result = await makePlanCleanupSweepAction(d)(CTX);
    expect(result.diagnostics).toMatchObject({ outcome: 'skipped', runId: 'run-9' });
  });

  it('a failed run FAILS the fire (no success-shaped fire for a failed sweep)', async () => {
    const { deps: d } = deps({
      start: vi.fn(async () => ({
        kind: 'settled' as const,
        runId: 'run-2',
        phase: 'failed' as const,
        totalPlans: 2,
        launched: false,
        resolverNeeded: true,
        deterministic: { applied: 0 } as never,
        launchError: 'spawn refused',
      })),
    });
    await expect(makePlanCleanupSweepAction(d)(CTX)).rejects.toThrow(/run-2 failed: spawn refused/);
  });
});
