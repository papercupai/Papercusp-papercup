import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemActionCtx } from './system-actions';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: SystemActionCtx) => Promise<unknown>>(),
  reconcile: vi.fn(), runSweep: vi.fn(),
  pinSweep: vi.fn(),
  resolveGrader: vi.fn(),
  enqueue: vi.fn(),
  progressTimers: [] as Array<{ name: string; tick: () => void; stop: ReturnType<typeof vi.fn> }>,
}));
vi.mock('@papercusp/scheduled-registry', () => ({
  managedSetInterval: (name: string, _interval: number, tick: () => void) => {
    const stop = vi.fn();
    h.progressTimers.push({ name, tick, stop });
    return { stop };
  },
}));
vi.mock('./system-actions', () => ({
  registerSystemAction: (name: string, handler: (ctx: SystemActionCtx) => Promise<unknown>) => h.handlers.set(name, handler),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: vi.fn() }),
}));
vi.mock('../../agent-tools/plans/rubric-template', () => ({ RUBRIC_TEMPLATE_NAME: 'rubric' }));
vi.mock('../../plan-acceptance-gate', () => ({ evaluatePlanAcceptanceGate: vi.fn() }));
vi.mock('../../acceptance-grader', () => ({
  ACCEPTANCE_GRADING_SWEEP_ACTOR: 'system:sweep', acceptanceGraderLabelPrefix: vi.fn(), resolveAcceptanceGrader: h.resolveGrader,
  gradingLaunchProfile: (ctx: { gradingLaunch?: unknown }) => ctx.gradingLaunch,
}));
vi.mock('../../grading-integrity', () => ({ reconcilePendingGradingAudits: h.reconcile }));
vi.mock('../../task-manager/store', () => ({ listTasks: vi.fn() }));
vi.mock('../../coord/condition-upsert', () => ({ upsertConditionWorkItem: vi.fn() }));
vi.mock('../../acceptance-grading-sweep-run', () => ({
  acceptanceGradingEscalationBody: vi.fn(), acceptanceGradingStallConditionKey: vi.fn(), runAcceptanceGradingSweep: h.runSweep,
}));
vi.mock('../../acceptance-grading-sweep-observe', () => ({ observeAcceptanceGrader: vi.fn() }));
vi.mock('../../acceptance-bar-pin-sweep', () => ({ runAcceptanceBarPinSweep: h.pinSweep }));
vi.mock('../../acceptance-grading-sweep-dispatch', () => ({ enqueueAcceptanceGradingDispatch: h.enqueue }));
import { resetAcceptanceGradingSweepForTest } from './acceptance-grading-sweep-action';

// Resolve the production adapter's lazy modules before switching the wall clock.
beforeAll(async () => {
  await Promise.all([
    import('@papercusp/db-org'), import('../../agent-tools/plans/rubric-template'),
    import('../../plan-acceptance-gate'), import('../../acceptance-grader'),
    import('../../grading-integrity'), import('../../task-manager/store'),
    import('../../coord/condition-upsert'), import('../../acceptance-grading-sweep-run'),
    import('../../acceptance-grading-sweep-observe'), import('../../acceptance-bar-pin-sweep'),
  ]);
});

beforeEach(() => {
  resetAcceptanceGradingSweepForTest();
  h.progressTimers.length = 0;
  h.reconcile.mockReset().mockResolvedValue({ requestedTargetIds: ['EI-audit'], receipts: [
    { issueId: 'EI-audit', state: 'routed', conversationId: 'audit-conversation' },
  ] });
  h.runSweep.mockReset().mockResolvedValue(undefined);
  h.enqueue.mockReset().mockResolvedValue({ workflowId: 'admitted' });
  h.pinSweep.mockReset().mockResolvedValue({ scanned: 0, reconciled: 0, held: {}, scopeSkipped: 0, errors: [], nextCursor: null });
});
afterEach(() => vi.useRealTimers());

describe('registered acceptance sweep audit entrypoint', () => {
  it('releases a slow repair at its deadline and joins it on the next tick', async () => {
    vi.useFakeTimers();
    let finishPins!: (value: unknown) => void;
    h.pinSweep.mockImplementationOnce(() => new Promise(resolve => { finishPins = resolve; }));
    const handler = h.handlers.get('acceptance-grading-sweep')!;
    const first = handler({ workspaceId: 'ws-sweep' } as SystemActionCtx);
    await vi.waitFor(() => expect(h.pinSweep).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toMatchObject({ softError: expect.stringContaining('remains in flight') });
    expect(h.runSweep).toHaveBeenCalledOnce();
    const second = handler({ workspaceId: 'ws-sweep' } as SystemActionCtx);
    await vi.waitFor(() => expect(h.progressTimers.filter(t => t.name.endsWith(':subject-pins'))).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(h.pinSweep).toHaveBeenCalledOnce();
    expect(h.runSweep).toHaveBeenCalledTimes(2);
    finishPins({ scanned: 0, reconciled: 0, errors: [], nextCursor: null });
    await handler({ workspaceId: 'ws-sweep' } as SystemActionCtx);
    expect(h.pinSweep).toHaveBeenCalledOnce();
    for (const timer of h.progressTimers) expect(timer.stop).toHaveBeenCalledOnce();
  });

  it('logs the exact plan operation before its settlement', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    h.runSweep.mockImplementation(async (deps) => {
      deps.onEvent({ kind: 'observe-started', planSlug: 'waiting-plan', operation: 'gate' });
      deps.onEvent({ kind: 'observe-settled', planSlug: 'waiting-plan', operation: 'gate', outcome: 'failed', durationMs: 90_000 });
    });
    try {
      await h.handlers.get('acceptance-grading-sweep')!({ workspaceId: 'ws-sweep', workflowId: 'measured-sweep' } as SystemActionCtx);
      expect(log).toHaveBeenCalledWith('[acceptance-grading-sweep] sweep=measured-sweep plan=waiting-plan operation=gate started');
      expect(log).toHaveBeenCalledWith('[acceptance-grading-sweep] sweep=measured-sweep plan=waiting-plan operation=gate failed elapsedMs=90000');
    } finally {
      log.mockRestore();
    }
  });

  it('repairs subject pins before grading and retains its bounded scan cursor', async () => {
    const cursor = { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: 'last-plan' };
    const order: string[] = [];
    h.pinSweep.mockImplementationOnce(async () => {
      order.push('pins');
      return { scanned: 50, reconciled: 1, held: {}, scopeSkipped: 0, errors: [], nextCursor: cursor };
    });
    h.runSweep.mockImplementation(async () => { order.push('grading'); });
    const handler = h.handlers.get('acceptance-grading-sweep')!;
    expect(await handler({ workspaceId: 'ws-sweep' } as SystemActionCtx)).toMatchObject({
      diagnostics: { subjectPins: { reconciled: 1 } },
    });
    expect(order).toEqual(['pins', 'grading']);
    await handler({ workspaceId: 'ws-sweep' } as SystemActionCtx);
    expect(h.pinSweep).toHaveBeenLastCalledWith({ after: cursor });
  });

  it('keeps grading running and records routine health when the pin scan fails', async () => {
    h.pinSweep.mockRejectedValue(new Error('pin scan unavailable'));
    const result = await h.handlers.get('acceptance-grading-sweep')!({ workspaceId: 'ws-sweep' } as SystemActionCtx);
    expect(result).toMatchObject({ softError: expect.stringContaining('pin scan unavailable') });
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.runSweep).toHaveBeenCalledOnce();
  });

  it('records per-target pin errors without hiding the successful portion of the scan', async () => {
    h.pinSweep.mockResolvedValue({ scanned: 2, reconciled: 1, errors: [{ error: 'pin read failed' }], nextCursor: null });
    expect(await h.handlers.get('acceptance-grading-sweep')!({ workspaceId: 'ws-sweep' } as SystemActionCtx)).toMatchObject({
      softError: 'subject-pin reconciliation failed for 1 plan(s)',
      diagnostics: { subjectPins: { scanned: 2, reconciled: 1 } },
    });
    expect(h.runSweep).toHaveBeenCalledOnce();
  });

  it('carries the routine model pin through both audit repairs and eligible plan grading', async () => {
    const profile = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' };
    h.resolveGrader.mockResolvedValue({ state: 'launched' });
    h.runSweep.mockImplementation(async (d) => d.dispatchGrader({ workspaceId: 'ws-sweep', harnessSlug: 'papercusp', planSlug: 'ready-plan', gradeableSinceMs: 123 }));
    await h.handlers.get('acceptance-grading-sweep')!({ workspaceId: 'ws-sweep', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: { gradingLaunch: profile } });
    expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ gradingLaunch: profile }) }));
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'ready-plan', gradeableSinceMs: 123, gradingLaunch: profile }));
    expect(h.resolveGrader).not.toHaveBeenCalled();
  });

  it('dispatches the pending audit queue with a scoped system identity and accepts routed delivery', async () => {
    const handler = h.handlers.get('acceptance-grading-sweep');
    expect(handler).toBeDefined();
    await handler!({ workspaceId: 'ws-sweep', installSlug: 'papercusp' } as SystemActionCtx);
    expect(h.reconcile).toHaveBeenCalledWith({
      harness: 'papercusp', ctx: expect.objectContaining({
        workspaceId: 'ws-sweep', principal: { kind: 'system', slug: 'system:sweep', workspaceId: 'ws-sweep' },
      }),
    });
    expect(h.runSweep).toHaveBeenCalledOnce();
  });

  it('keeps acceptance recovery running when audit routing fails explicitly', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.reconcile.mockRejectedValue(new Error('audit routing unavailable'));
    try {
      const result = await h.handlers.get('acceptance-grading-sweep')!({ workspaceId: 'ws-sweep' } as SystemActionCtx);
      expect(h.runSweep).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('reconciliation failed'), 'audit routing unavailable');
      expect(result).toMatchObject({
        softError: expect.stringContaining('audit routing unavailable'),
        diagnostics: { stages: { 'pending-audits': { outcome: 'failed' }, 'plan-grading': { outcome: 'completed' } } },
      });
    } finally {
      warning.mockRestore();
    }
  });

  it('identifies an in-flight repair without releasing it or starting the next stage', async () => {
    let finishAudit!: (value: unknown) => void;
    h.reconcile.mockImplementationOnce(() => new Promise(resolve => { finishAudit = resolve; }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const running = h.handlers.get('acceptance-grading-sweep')!({
      workspaceId: 'ws-sweep', workflowId: 'measured-sweep',
    } as SystemActionCtx);
    try {
      await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledOnce());
      const progress = h.progressTimers.find(timer => timer.name.endsWith(':pending-audits'))!;
      progress.tick();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('sweep=measured-sweep stage=pending-audits still running elapsedMs='));
      expect(progress.stop).not.toHaveBeenCalled();
      expect(h.runSweep).not.toHaveBeenCalled();
      finishAudit({ receipts: [] });
      expect(await running).toMatchObject({ diagnostics: { stages: {
        'subject-pins': { outcome: 'completed', durationMs: expect.any(Number) },
        'pending-audits': { outcome: 'completed', durationMs: expect.any(Number) },
        'plan-grading': { outcome: 'completed', durationMs: expect.any(Number) },
      } } });
      expect(h.progressTimers).toHaveLength(3);
      for (const timer of h.progressTimers) expect(timer.stop).toHaveBeenCalledOnce();
    } finally {
      finishAudit({ receipts: [] });
      await running;
      warning.mockRestore();
    }
  });

  it('stops the progress timer when the final stage throws', async () => {
    h.runSweep.mockRejectedValueOnce(new Error('gate read failed'));
    await expect(h.handlers.get('acceptance-grading-sweep')!({ workspaceId: 'ws-sweep' } as SystemActionCtx))
      .rejects.toThrow('gate read failed');
    for (const timer of h.progressTimers) expect(timer.stop).toHaveBeenCalledOnce();
  });
});
