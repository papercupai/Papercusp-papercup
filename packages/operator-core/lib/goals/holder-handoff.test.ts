import { describe, expect, it, vi } from 'vitest';
import {
  notifyGoalHolderHandoff,
  releaseFormerGoalHolderClaimDefault,
  type GoalHolderHandoffDeps,
} from './holder-handoff';

// WI-10006948: the production former-holder release is lazy-imported, so these mocks
// are what it resolves. Each records into one ordered log.
const releaseLog = vi.hoisted(() => ({
  order: [] as string[],
  prior: { assignee: 'su-old' as string | null, wasClaimed: true },
  released: { id: 'WI-x', assignee: null as string | null } as { id: string; assignee: string | null } | null,
  releaseArgs: [] as unknown[],
}));
vi.mock('../work-item-flight-record', () => ({
  captureWorkItemFlightRecordsForItems: vi.fn(async () => {
    releaseLog.order.push('flight-record');
    return { capturedIds: ['WI-x'] };
  }),
}));
vi.mock('../work-item-claims', () => ({
  releaseClaimForItemByOwnerLocal: vi.fn(async () => {
    releaseLog.order.push('claim-ledger');
    return true;
  }),
}));
vi.mock('../work-items', () => ({
  releaseWorkItem: vi.fn(async (id: string, opts: { onPriorState?: (p: unknown) => void }) => {
    releaseLog.order.push('release');
    releaseLog.releaseArgs.push({ id, opts });
    opts.onPriorState?.(releaseLog.prior);
    return releaseLog.released;
  }),
}));

describe('releaseFormerGoalHolderClaimDefault (WI-10006948)', () => {
  const claim = {
    workspaceId: 'ws',
    goalId: 'goal-a',
    id: 'WI-x',
    harness: 'papercusp',
    ownerId: 'su-old',
    exitedAt: new Date('2026-10-06T19:16:13Z'),
  };
  function reset(prior: { assignee: string | null; wasClaimed: boolean }, released: { id: string; assignee: string | null } | null) {
    releaseLog.order = [];
    releaseLog.releaseArgs = [];
    releaseLog.prior = prior;
    releaseLog.released = released;
  }

  it('snapshots evidence, clears the claim row, then compare-and-releases the lease as the former holder', async () => {
    reset({ assignee: 'su-old', wasClaimed: true }, { id: 'WI-x', assignee: null });
    await expect(releaseFormerGoalHolderClaimDefault(claim)).resolves.toBe(true);
    // Same order as the session-death sweep: evidence while the link is intact, then ledgers.
    expect(releaseLog.order).toEqual(['flight-record', 'claim-ledger', 'release']);
    expect(releaseLog.releaseArgs).toEqual([
      { id: 'WI-x', opts: expect.objectContaining({ harness: 'papercusp', expectedAssignee: 'su-old' }) },
    ]);
  });

  it('reports false when the lease had already moved to someone else (compare-and-release no-op)', async () => {
    reset({ assignee: 'su-live-peer', wasClaimed: true }, { id: 'WI-x', assignee: 'su-live-peer' });
    await expect(releaseFormerGoalHolderClaimDefault(claim)).resolves.toBe(false);
  });

  it('reports false when the item was already free or is gone', async () => {
    reset({ assignee: null, wasClaimed: false }, { id: 'WI-x', assignee: null });
    await expect(releaseFormerGoalHolderClaimDefault(claim)).resolves.toBe(false);
    reset({ assignee: 'su-old', wasClaimed: true }, null);
    await expect(releaseFormerGoalHolderClaimDefault(claim)).resolves.toBe(false);
  });
});

describe('notifyGoalHolderHandoff', () => {
  it('disarms, messages, and wakes exactly the named predecessor', async () => {
    const deactivate = vi.fn(async () => true);
    const notifyOrders = vi.fn(async () => {});
    const message = vi.fn(async () => {});
    const wake = vi.fn(async () => ({ woken: 1, staged: 0 }));
    const vacateDrainFleet = vi.fn(async () => ({
      fleetSlug: 'goal-drain-demo',
      vacated: true,
      reason: 'vacated' as const,
    }));
    const deps: GoalHolderHandoffDeps = {
      deactivate,
      notifyOrders,
      message,
      wake,
      vacateDrainFleet,
    };

    const result = await notifyGoalHolderHandoff(
      'workspace-1',
      {
        ownerId: 'holder-new',
        goalId: 'goal-1',
        epoch: 4,
        predecessorOwnerId: 'holder-old',
        handoffExpiresAt: '2026-08-30T08:00:00.000Z',
      },
      deps,
    );

    expect(deactivate).toHaveBeenCalledWith('holder-old', expect.stringContaining('epoch 4'));
    expect(notifyOrders).toHaveBeenCalledWith('holder-old');
    expect(message).toHaveBeenCalledWith(
      'holder-old',
      expect.stringContaining('holder-new'),
      expect.stringContaining('goal-scoped context, mutations, and launches refuse'),
    );
    expect(wake).toHaveBeenCalledWith(
      'holder-old',
      expect.any(String),
      expect.objectContaining({ action: 'stand-down', electedOwnerId: 'holder-new' }),
      'workspace-1',
    );
    expect(result).toMatchObject({ loopDeactivated: true, woken: 1, staged: 0 });

    // EI-22402152554463916: the seat is vacated for the OUTGOING holder. Passing the elected
    // holder here instead would re-seat the drain fleet on the portfolio manager — the exact
    // fix the goal steward ruled out, so this argument is the constraint made executable.
    expect(vacateDrainFleet).toHaveBeenCalledWith('workspace-1', 'goal-1', 'holder-old');
    expect(vacateDrainFleet).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'holder-new',
    );
    expect(result).toMatchObject({ drainFleet: { vacated: true, fleetSlug: 'goal-drain-demo' } });
    // The stood-down agent must be TOLD, or it cannot know not to reclaim the seat.
    expect(message).toHaveBeenCalledWith(
      'holder-old',
      expect.any(String),
      expect.stringContaining("drain fleet 'goal-drain-demo'"),
    );
  });

  it('leaves the stand-down body unchanged when there was no seat to vacate', async () => {
    const message = vi.fn(async () => {});
    const deps: GoalHolderHandoffDeps = {
      deactivate: vi.fn(async () => true),
      notifyOrders: vi.fn(async () => {}),
      message,
      wake: vi.fn(async () => ({ woken: 1, staged: 0 })),
      vacateDrainFleet: vi.fn(async () => ({
        fleetSlug: null,
        vacated: false,
        reason: 'no-drain-fleet' as const,
      })),
    };

    const result = await notifyGoalHolderHandoff(
      'workspace-1',
      {
        ownerId: 'holder-new',
        goalId: 'goal-1',
        epoch: 2,
        predecessorOwnerId: 'holder-old',
        handoffExpiresAt: null,
      },
      deps,
    );

    expect(message).toHaveBeenCalledWith(
      'holder-old',
      expect.any(String),
      expect.not.stringContaining('drain fleet'),
    );
    expect(result).toMatchObject({ drainFleet: { vacated: false, reason: 'no-drain-fleet' } });
  });

  it('does nothing for the first holder because there is no predecessor', async () => {
    const deps: GoalHolderHandoffDeps = {
      deactivate: vi.fn(),
      notifyOrders: vi.fn(),
      message: vi.fn(),
      wake: vi.fn(),
      vacateDrainFleet: vi.fn(),
    };
    await expect(
      notifyGoalHolderHandoff(
        'workspace-1',
        {
          ownerId: 'holder-first',
          goalId: 'goal-1',
          epoch: 1,
          predecessorOwnerId: null,
          handoffExpiresAt: null,
        },
        deps,
      ),
    ).resolves.toBeNull();
    expect(deps.deactivate).not.toHaveBeenCalled();
    // A first acquisition supersedes nobody, so no seat is in question.
    expect(deps.vacateDrainFleet).not.toHaveBeenCalled();
  });
});
