/** scorecards:repair — callable immediate pending-audit reconciliation. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const reconcilePendingGradingAudits = vi.hoisted(() => vi.fn());
const guardResource = vi.hoisted(() => vi.fn());

// Deliberately NOT the real 500/50: distinctive values prove the description is
// DERIVED from the dispatcher's constants rather than hardcoded beside them.
vi.mock('../../grading-integrity', () => ({
  reconcilePendingGradingAudits,
  GRADING_AUDIT_BACKLOG_SCAN_LIMIT: 777,
  GRADING_AUDIT_DISPATCH_LIMIT: 33,
}));
vi.mock('../locks/resource-lock-guard', () => ({ guardResource }));
vi.mock('../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'repair-owner', ownerLabel: 'repair owner', coordinationDomain: 'caller-domain' })),
}));
vi.mock('../locks/coordination-domain', () => ({
  resourceLockDomain: vi.fn((resource: string) => `host-global:${resource}`),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'repair-owner', ownerLabel: 'repair owner' })),
}));

import repairTool, {
  SCORECARD_REPAIR_LOCK_TTL_SEC,
  SCORECARD_REPAIR_RESOURCE,
  SCORECARD_REPAIR_TIMEOUT_SEC,
  scorecardRepairArgs,
} from './repair';

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
    guardResource.mockReset().mockImplementation(async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
      acquired: true,
      result: await run({}),
      lock_id: 'repair-lock',
    }));
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
      recertifyStranded: false,
      ctx,
    });
    expect(result).toEqual({
      data: {
        ok: true,
        requestedTargetIds: ['EI-target'],
        receipts: [{ issueId: 'EI-target', state: 'launched' }],
      },
    });
    expect(guardResource).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinationDomain: 'host-global:staging-server',
        ownerId: 'repair-owner',
        ownerLabel: 'repair owner',
        resource: SCORECARD_REPAIR_RESOURCE,
        mode: 'shared',
        ttlSec: SCORECARD_REPAIR_LOCK_TTL_SEC,
      }),
      expect.any(Function),
    );
  });

  it('refuses before dispatch when staging-server is draining for a restart', async () => {
    guardResource.mockResolvedValueOnce({
      acquired: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'restart-owner', owner_label: 'restart owner', mode: 'exclusive', status: 'held' }],
    });

    const result = await repairTool.handler({ targetIds: ['EI-target'] } as never, makeContext());

    expect(result).toEqual({
      data: {
        ok: false,
        reason: 'resource_held_exclusive',
        resource: SCORECARD_REPAIR_RESOURCE,
        holders: [{ owner: 'restart-owner', owner_label: 'restart owner', mode: 'exclusive', status: 'held' }],
      },
    });
    expect(reconcilePendingGradingAudits).not.toHaveBeenCalled();
  });

  it('omits target selection so the dispatcher owns bounded oldest-first backlog selection', async () => {
    const ctx = makeContext();
    await repairTool.handler({} as never, ctx);

    expect(reconcilePendingGradingAudits).toHaveBeenCalledWith({ ctx, recertifyStranded: false });
  });

  it('carries the requested model pin into exact-target audit repair without changing caller identity', async () => {
    const ctx = makeContext();
    const gradingLaunch = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' };
    const args = scorecardRepairArgs.parse({ targetIds: ['EI-target'], harness: 'papercusp', gradingLaunch });

    await repairTool.handler(args, ctx);

    const dispatched = reconcilePendingGradingAudits.mock.calls[0][0];
    expect(dispatched).toEqual({
      targetIds: ['EI-target'],
      harness: 'papercusp',
      recertifyStranded: false,
      ctx: { ...ctx, gradingLaunch },
    });
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

  it('directs generation-bound repairs to the operator API serving the graded build', () => {
    expect(repairTool.description).toContain('operator-api runtime that serves its graded build');
    expect(repairTool.description).toContain('current-build :3170 route selected by dev:pipeline_position');
    expect(repairTool.guidance?.when).toContain('older or unproven runtimes are refused before reservation');
  });
});
