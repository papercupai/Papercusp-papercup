/** scorecards:repair — callable immediate pending-audit reconciliation. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const reconcilePendingGradingAudits = vi.hoisted(() => vi.fn());

// Deliberately NOT the real 500/50: distinctive values prove the description is
// DERIVED from the dispatcher's constants rather than hardcoded beside them.
vi.mock('../../grading-integrity', () => ({
  reconcilePendingGradingAudits,
  GRADING_AUDIT_BACKLOG_SCAN_LIMIT: 777,
  GRADING_AUDIT_DISPATCH_LIMIT: 33,
}));

import repairTool, { SCORECARD_REPAIR_TIMEOUT_SEC, scorecardRepairArgs } from './repair';

const makeContext = (): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
  runId: 'scorecards-repair-test',
  isSuperuser: true,
  uiClientId: 'su-scorecards-repair-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'full',
  tx: {},
});

describe('scorecards:repair', () => {
  beforeEach(() => {
    reconcilePendingGradingAudits.mockReset().mockResolvedValue({
      requestedTargetIds: ['EI-target'],
      receipts: [{ issueId: 'EI-target', state: 'launched' }],
    });
  });

  it('forwards explicit target ids, harness, and the complete caller context', async () => {
    const ctx = makeContext();
    const result = await repairTool.handler(
      { targetIds: ['EI-target'], harness: 'papercusp' } as never,
      ctx,
    );

    expect(reconcilePendingGradingAudits).toHaveBeenCalledOnce();
    expect(reconcilePendingGradingAudits).toHaveBeenCalledWith({
      targetIds: ['EI-target'],
      harness: 'papercusp',
      ctx,
    });
    expect(result).toEqual({
      data: {
        ok: true,
        requestedTargetIds: ['EI-target'],
        receipts: [{ issueId: 'EI-target', state: 'launched' }],
      },
    });
  });

  it('omits target selection so the dispatcher owns bounded oldest-first backlog selection', async () => {
    const ctx = makeContext();
    await repairTool.handler({} as never, ctx);

    expect(reconcilePendingGradingAudits).toHaveBeenCalledWith({ ctx });
  });

  it('carries the requested model pin into exact-target audit repair without changing caller identity', async () => {
    const ctx = makeContext();
    const gradingLaunch = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' };
    const args = scorecardRepairArgs.parse({ targetIds: ['EI-target'], harness: 'papercusp', gradingLaunch });

    await repairTool.handler(args, ctx);

    const dispatched = reconcilePendingGradingAudits.mock.calls[0][0];
    expect(dispatched).toEqual({ targetIds: ['EI-target'], harness: 'papercusp', ctx: { ...ctx, gradingLaunch } });
    expect(dispatched.ctx).not.toBe(ctx);
    expect(ctx).not.toHaveProperty('gradingLaunch');
  });

  it.each([
    { agent: 'claude', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' },
    { agent: 'codex', model: 'other-model', effort: 'xhigh', account: 'auto' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', account: 'auto' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'default' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto', fallback: true },
  ])('rejects unsupported or incomplete launch profiles before dispatch: %j', async (gradingLaunch) => {
    await expect(async () => {
      const args = scorecardRepairArgs.parse({ targetIds: ['EI-target'], gradingLaunch });
      await repairTool.handler(args, makeContext());
    }).rejects.toThrow();
    expect(reconcilePendingGradingAudits).not.toHaveBeenCalled();
  });

  it('describes the no-target sweep as the newest-window selection it really is (WI-10005150)', () => {
    // The old text promised "the oldest bounded backlog". The dispatcher reads the
    // NEWEST N scorecards and picks oldest-first only inside that window, so an
    // older pending card is unreachable without targetIds. An agent trusting the
    // old text would wait on a sweep that never reaches its card.
    const targetIdsHelp = scorecardRepairArgs.shape.targetIds.description ?? '';
    for (const text of [repairTool.description, targetIdsHelp]) {
      expect(text).not.toMatch(/oldest bounded/);
      expect(text).toContain('NEWEST 777 scorecards');
      expect(text).toContain('up to 33');
      expect(text).toContain('reachable only via targetIds');
    }
  });

  it('declares a long-running transport budget for multi-target sweeps', () => {
    expect(repairTool.timeoutSec).toBe(SCORECARD_REPAIR_TIMEOUT_SEC);
    expect(SCORECARD_REPAIR_TIMEOUT_SEC).toBeGreaterThan(55);
    expect(repairTool.skipWorkspaceTx).toBe(true);
  });
});
