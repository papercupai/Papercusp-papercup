import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemActionCtx } from './system-actions';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: SystemActionCtx) => Promise<unknown>>(),
  reconcile: vi.fn(), runSweep: vi.fn(),
  resolveGrader: vi.fn(),
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
import './acceptance-grading-sweep-action';

beforeEach(() => {
  h.reconcile.mockReset().mockResolvedValue({ requestedTargetIds: ['EI-audit'], receipts: [
    { issueId: 'EI-audit', state: 'routed', conversationId: 'audit-conversation' },
  ] });
  h.runSweep.mockReset().mockResolvedValue(undefined);
});

describe('registered acceptance sweep audit entrypoint', () => {
  it('carries the routine model pin through both audit repairs and eligible plan grading', async () => {
    const profile = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' };
    h.resolveGrader.mockResolvedValue({ state: 'launched' });
    h.runSweep.mockImplementation(async (d) => d.dispatchGrader({ workspaceId: 'ws-sweep', harnessSlug: 'papercusp', planSlug: 'ready-plan' }));
    await h.handlers.get('acceptance-grading-sweep')!({ workspaceId: 'ws-sweep', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: { gradingLaunch: profile } });
    expect(h.reconcile).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ gradingLaunch: profile }) }));
    expect(h.resolveGrader).toHaveBeenCalledWith('ready-plan', expect.objectContaining({ gradingLaunch: profile }));
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
      await h.handlers.get('acceptance-grading-sweep')!({ workspaceId: 'ws-sweep' } as SystemActionCtx);
      expect(h.runSweep).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('reconciliation failed'), 'audit routing unavailable');
    } finally {
      warning.mockRestore();
    }
  });
});
