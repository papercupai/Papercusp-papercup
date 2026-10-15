/**
 * plan-cleanup-system-repair-2026-10-01 P-004/P-005 — the ONE plan clean-up start
 * path (shared by the Plans-pane route and `system:plan-cleanup-sweep`) and the
 * least-recently-scanned selection that replaced the silent 200-plan cut.
 */
import { describe, expect, it, vi } from 'vitest';
import { BulkRunAlreadyActiveError } from '../attention/bulk-run-store';
import {
  MAX_RUN_PLANS,
  normalizePlanSlugs,
  orderLeastRecentlyScanned,
  selectPlansForRun,
  selectPlansLeastRecentlyScanned,
  startPlanCleanupRun,
  cleanupWorkflowRunId,
  type StartPlanCleanupRunDeps,
  type StartPlanCleanupRunInput,
} from './start-run';

describe('plan selection (P-005)', () => {
  it('normalizes without capping — the cap is selection’s job, not parsing’s', () => {
    const input = [' plan-a ', 'plan-a', '', 7, ...Array.from({ length: MAX_RUN_PLANS + 10 }, (_, i) => `p-${i}`)];
    const slugs = normalizePlanSlugs(input);
    expect(slugs[0]).toBe('plan-a');
    expect(slugs).toHaveLength(MAX_RUN_PLANS + 11);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(normalizePlanSlugs('not-an-array')).toEqual([]);
  });

  it('orders never-scanned plans first, then oldest scan; ties keep offered order', () => {
    const last = new Map([
      ['b', 3_000],
      ['c', 1_000],
      ['e', 1_000],
    ]);
    expect(orderLeastRecentlyScanned(['a', 'b', 'c', 'd', 'e'], last)).toEqual(['a', 'd', 'c', 'e', 'b']);
  });

  it('reports the cut instead of hiding it', () => {
    const offered = ['a', 'b', 'c', 'd'];
    const last = new Map([
      ['a', 5],
      ['b', 1],
    ]);
    expect(selectPlansForRun(offered, last, 3)).toEqual({
      planSlugs: ['c', 'd', 'b'],
      requested: 4,
      accepted: 3,
      truncated: 1,
    });
    expect(selectPlansForRun(offered, last, 10)).toEqual({
      planSlugs: offered,
      requested: 4,
      accepted: 4,
      truncated: 0,
    });
  });

  it('reads scan history only when a cut is needed', async () => {
    const reader = vi.fn(async () => new Map([['p-0', 10]]));
    const under = await selectPlansLeastRecentlyScanned(
      { workspaceId: 'ws', harnessSlug: 'h', planSlugs: ['p-0', 'p-1'], max: 2 },
      reader,
    );
    expect(reader).not.toHaveBeenCalled();
    expect(under).toMatchObject({ requested: 2, accepted: 2, truncated: 0 });

    const over = await selectPlansLeastRecentlyScanned(
      { workspaceId: 'ws', harnessSlug: 'h', planSlugs: ['p-0', 'p-1', 'p-2'], max: 2 },
      reader,
    );
    expect(reader).toHaveBeenCalledWith({ workspaceId: 'ws', harnessSlug: 'h', planSlugs: ['p-0', 'p-1', 'p-2'] });
    expect(over).toEqual({ planSlugs: ['p-1', 'p-2'], requested: 3, accepted: 2, truncated: 1 });
  });
});

function deterministic(overrides: Record<string, unknown> = {}) {
  return {
    needsResolver: false,
    phase: 'complete',
    passes: 1,
    applied: 0,
    skipped: 0,
    failed: 0,
    appliedFindingIds: [],
    recommendationFindingIds: [],
    reconciliationRequired: [],
    fatalError: null,
    authorityRevoked: false,
    authorityRefusal: null,
    ...overrides,
  };
}

function harness(overrides: Partial<StartPlanCleanupRunDeps> = {}) {
  const phases: Array<{ phase: string; error?: string | null; resolverOwner?: string | null }> = [];
  const deps: StartPlanCleanupRunDeps = {
    getRun: vi.fn(async () => null),
    createRun: vi.fn(async () => ({ runId: 'run-1', workspaceId: 'ws-1', totalItems: 2 }) as never),
    setRunPhase: vi.fn(async (input) => {
      phases.push({ phase: input.phase, error: input.error, resolverOwner: input.resolverOwner });
      return { phase: input.phase } as never;
    }),
    runDeterministic: vi.fn(async () => deterministic() as never),
    buildCall: vi.fn(() => (async () => ({})) as never),
    launchResolver: vi.fn(async () => ({ ok: true, sessionId: 's-1' })),
    invalidate: vi.fn(async () => undefined),
    newResolverOwner: () => 'su-resolver',
    ...overrides,
  };
  return { deps, phases };
}

const INPUT: StartPlanCleanupRunInput = {
  planSlugs: ['plan-a', 'plan-b'],
  harness: 'papercusp',
  workspaceId: 'ws-1',
  filter: { source: 'test' },
  launch: { model: 'm', effort: 'high', account: 'default', carry: 'warm' } as never,
  automationPolicy: { mode: 'recommend', minConfidence: 'high' } as never,
  requestedBy: 'system:plan-cleanup-sweep',
};

describe('startPlanCleanupRun (P-004)', () => {
  function interruptedRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: cleanupWorkflowRunId('workflow-1'), workspaceId: 'ws-1', harnessSlug: 'papercusp',
      requestedBy: INPUT.requestedBy, runKind: 'plan-cleanup', phase: 'pending',
      resolverOwner: null, heartbeatAt: null, error: null, totalItems: 1,
      seedRefs: ['original-plan'], filterSnapshot: { routineWorkflowId: 'workflow-1' },
      launchSnapshot: { model: 'gpt-6.1-sol', effort: 'xhigh', account: 'default', carry: 'warm' },
      automationPolicy: { mode: 'recommend', minConfidence: 'high' }, ...overrides,
    } as never;
  }

  it('an interrupted workflow resumes its original run and launch snapshot without reseeding', async () => {
    const prior = interruptedRun();
    const { deps } = harness({
      getRun: vi.fn(async () => prior),
      runDeterministic: vi.fn(async () => deterministic({ needsResolver: true, phase: 'pending' }) as never),
    });
    const result = await startPlanCleanupRun({ ...INPUT, workflowId: 'workflow-1' }, deps);
    expect(result).toMatchObject({ kind: 'settled', runId: cleanupWorkflowRunId('workflow-1'), launched: true });
    expect(deps.createRun).not.toHaveBeenCalled();
    expect(deps.runDeterministic).toHaveBeenCalledWith(expect.objectContaining({ run: prior }));
    expect(deps.launchResolver).toHaveBeenCalledWith(
      cleanupWorkflowRunId('workflow-1'), ['original-plan'], 'papercusp',
      expect.objectContaining({ model: 'gpt-6.1-sol', effort: 'xhigh', account: 'default', carry: 'warm' }),
      'su-resolver', 'ws-1',
    );
  });

  it.each([
    { phase: 'running' }, { phase: 'review' }, { phase: 'complete' },
    { phase: 'failed', error: 'watchdog failed the run' },
    { phase: 'pending', resolverOwner: 'su-existing' },
  ])('replay preserves the existing launch/settlement boundary: %j', async (state) => {
    const { deps } = harness({ getRun: vi.fn(async () => interruptedRun(state)) });
    const result = await startPlanCleanupRun({ ...INPUT, workflowId: 'workflow-1' }, deps);
    expect(result).toMatchObject({ kind: 'existing', phase: state.phase });
    expect(deps.createRun).not.toHaveBeenCalled();
    expect(deps.runDeterministic).not.toHaveBeenCalled();
    expect(deps.launchResolver).not.toHaveBeenCalled();
  });

  it('workflow replay refuses another scope instead of adopting its run', async () => {
    const { deps } = harness({ getRun: vi.fn(async () => interruptedRun({ harnessSlug: 'other' })) });
    await expect(startPlanCleanupRun({ ...INPUT, workflowId: 'workflow-1' }, deps)).rejects.toThrow('scope does not match');
    expect(deps.runDeterministic).not.toHaveBeenCalled();
  });

  it('a first durable fire stores a stable run id and workflow receipt', async () => {
    const { deps } = harness();
    await startPlanCleanupRun({ ...INPUT, workflowId: 'workflow-1' }, deps);
    expect(deps.createRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: cleanupWorkflowRunId('workflow-1'),
      filterSnapshot: { source: 'test', routineWorkflowId: 'workflow-1' },
    }));
  });

  it('a clean deterministic pass settles without ever spawning a resolver', async () => {
    const { deps, phases } = harness();
    const result = await startPlanCleanupRun(INPUT, deps);
    expect(result).toMatchObject({ kind: 'settled', runId: 'run-1', phase: 'complete', launched: false, resolverNeeded: false });
    expect(deps.launchResolver).not.toHaveBeenCalled();
    expect(phases).toEqual([]);
    expect(deps.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runKind: 'plan-cleanup',
        seedRefs: ['plan-a', 'plan-b'],
        requestedBy: 'system:plan-cleanup-sweep',
        harnessSlug: 'papercusp',
        workspaceId: 'ws-1',
      }),
    );
    expect(deps.invalidate).toHaveBeenCalledTimes(1);
  });

  it('judgment residue launches the resolver: pending → running', async () => {
    const { deps, phases } = harness({
      runDeterministic: vi.fn(async () => deterministic({ needsResolver: true, phase: 'pending' }) as never),
    });
    const result = await startPlanCleanupRun(INPUT, deps);
    expect(result).toMatchObject({ kind: 'settled', phase: 'running', launched: true, resolverNeeded: true });
    expect(deps.launchResolver).toHaveBeenCalledWith('run-1', ['plan-a', 'plan-b'], 'papercusp', INPUT.launch, 'su-resolver', 'ws-1');
    expect(phases.map((p) => p.phase)).toEqual(['pending', 'running']);
  });

  it('a failed resolver launch fails the run and surfaces the error', async () => {
    const { deps, phases } = harness({
      runDeterministic: vi.fn(async () => deterministic({ needsResolver: true, phase: 'pending' }) as never),
      launchResolver: vi.fn(async () => ({ ok: false, error: 'spawn refused' })),
    });
    const result = await startPlanCleanupRun(INPUT, deps);
    expect(result).toMatchObject({ kind: 'settled', phase: 'failed', launched: false, launchError: 'spawn refused' });
    expect(phases.map((p) => p.phase)).toEqual(['pending', 'failed']);
    expect(phases[1]?.error).toBe('spawn refused');
  });

  it('a fatal deterministic error fails the run without a resolver', async () => {
    const { deps, phases } = harness({
      runDeterministic: vi.fn(async () => deterministic({ fatalError: 'scan exploded', phase: 'running' }) as never),
    });
    const result = await startPlanCleanupRun(INPUT, deps);
    expect(result).toMatchObject({ kind: 'settled', phase: 'failed', launchError: 'scan exploded' });
    expect(phases).toEqual([{ phase: 'failed', error: 'scan exploded', resolverOwner: undefined }]);
    expect(deps.launchResolver).not.toHaveBeenCalled();
  });

  it('revoked run authority is a typed result, not a launch', async () => {
    const { deps } = harness({
      runDeterministic: vi.fn(
        async () =>
          deterministic({
            authorityRevoked: true,
            phase: 'cancelled',
            authorityRefusal: { reason: 'run_cancelled' },
          }) as never,
      ),
    });
    const result = await startPlanCleanupRun(INPUT, deps);
    expect(result).toMatchObject({ kind: 'authority-revoked', runId: 'run-1', refusal: 'run_cancelled' });
    expect(deps.launchResolver).not.toHaveBeenCalled();
  });

  it('single-flight contention is a typed result; other create errors propagate', async () => {
    const busy = new BulkRunAlreadyActiveError('run-0', 'running');
    const { deps } = harness({ createRun: vi.fn(async () => Promise.reject(busy)) });
    await expect(startPlanCleanupRun(INPUT, deps)).resolves.toEqual({ kind: 'already-active', error: busy });

    const boom = harness({ createRun: vi.fn(async () => Promise.reject(new Error('pg down'))) });
    await expect(startPlanCleanupRun(INPUT, boom.deps)).rejects.toThrow('pg down');
  });
});
