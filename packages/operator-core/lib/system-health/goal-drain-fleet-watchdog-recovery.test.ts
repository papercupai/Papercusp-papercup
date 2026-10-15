import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';

const {
  mintMock, registerMock, couplingMock, couplingReadMock, policyMock, launchMock, fleetMock, specMock, livenessMock,
} = vi.hoisted(() => ({
  mintMock: vi.fn(), registerMock: vi.fn(), couplingMock: vi.fn(), couplingReadMock: vi.fn(), policyMock: vi.fn(),
  launchMock: vi.fn(), fleetMock: vi.fn(), specMock: vi.fn(), livenessMock: vi.fn(),
}));
vi.mock('../goals/drain-fleet-mint', () => ({
  mintDrainFleetForGoal: mintMock,
  registerGoalDrainFleetLeader: registerMock,
  ensureGoalDrainLeaderCoupling: couplingMock,
}));
vi.mock('../goal-launch-settings', async (load) => ({
  ...(await load<Record<string, unknown>>()), resolveGoalLaunchForGoal: policyMock,
}));
vi.mock('../launch-agent', async (load) => ({
  ...(await load<Record<string, unknown>>()), launchAgent: launchMock,
}));
vi.mock('../agent-fleets-store', async (load) => ({
  ...(await load<Record<string, unknown>>()), getFleet: fleetMock,
}));
vi.mock('../scheduler/claim-spec-store', async (load) => ({
  ...(await load<Record<string, unknown>>()), getClaimSpec: specMock,
}));
vi.mock('../goals/holder', async (load) => ({
  ...(await load<Record<string, unknown>>()), resolveHolderLiveness: livenessMock,
}));
vi.mock('../coord/couplings', async (load) => ({
  ...(await load<Record<string, unknown>>()), listCouplingsFor: couplingReadMock,
}));

import { defaultRelaunchDrainFleet, type GoalDrainAlert, type GoalDrainRowLike } from './goal-drain-fleet-watchdog';

const alert: GoalDrainAlert = {
  goalId: 'g-1', workspaceId: 'ws', title: 'Goal', drainFleet: 'goal-drain-g-1',
  reason: 'drain-fleet-dead', liveHolders: ['su-holder'], standing: true,
};
const goal: GoalDrainRowLike = {
  goalId: 'g-1', workspaceId: 'ws', title: 'Goal', createdAtMs: 1,
  drainFleet: 'goal-drain-g-1', standing: true, installSlug: 'papercusp',
};
const verdict = (ownerId: string, sessionState: LivenessVerdict['sessionState']): LivenessVerdict => ({
  ownerId, sessionState, wakeable: sessionState !== 'ended', liveTurn: sessionState === 'live',
  confirmLiveness: null, heartbeatFresh: sessionState !== 'ended',
});
let workerRows: Array<{ owner_id: string }> = [];
let observed: Map<string, LivenessVerdict>;
const sql = (async () => workerRows) as unknown as Sql;

beforeEach(() => {
  vi.clearAllMocks();
  workerRows = [];
  observed = new Map();
  fleetMock.mockResolvedValue({ owner: 'su-holder', leaderOwnerId: 'su-leader' });
  specMock.mockResolvedValue({ view: { filter: { field: 'goal', op: '=', value: 'g-1' } } });
  livenessMock.mockImplementation(async (ids: string[]) => new Map(ids.flatMap((id) => {
    const seen = observed.get(id);
    return seen ? [[id, seen]] : [];
  })));
  couplingMock.mockResolvedValue(true);
  couplingReadMock.mockResolvedValue([{
    agentA: 'su-holder', agentB: 'su-leader', state: 'coupled',
  }]);
  registerMock.mockResolvedValue({ registered: true, coupled: true, warning: null });
  policyMock.mockResolvedValue({
    refusal: null, effective: { agent: 'claude', model: 'sonnet', account: 'default' }, degradedReasons: [],
  });
  launchMock.mockResolvedValue({ ok: true, ownerId: 'su-worker-new' });
  mintMock.mockResolvedValue({ fleetSlug: 'goal-drain-g-1' });
});

describe('P-014 delegated drain recovery', () => {
  it('repairs missing coupling and preserves a verified leader and worker', async () => {
    workerRows = [{ owner_id: 'su-worker' }];
    couplingReadMock.mockResolvedValueOnce([]);
    observed.set('su-leader', verdict('su-leader', 'live'));
    observed.set('su-worker', verdict('su-worker', 'live'));
    const result = await defaultRelaunchDrainFleet(sql, alert, goal);
    expect(result.actions).toEqual({
      reminted: false, leaderLaunched: false, couplingRepaired: true, memberLaunched: false,
    });
    expect(couplingMock).toHaveBeenCalledWith(expect.objectContaining({
      holderOwnerId: 'su-holder', leaderOwnerId: 'su-leader',
      declaredBy: 'goal-drain-fleet-watchdog',
    }));
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('replaces a dead leader by CAS while preserving a verified worker', async () => {
    workerRows = [{ owner_id: 'su-worker' }];
    observed.set('su-leader', verdict('su-leader', 'ended'));
    observed.set('su-worker', verdict('su-worker', 'live'));
    launchMock.mockResolvedValueOnce({ ok: true, ownerId: 'su-new-leader' });
    const result = await defaultRelaunchDrainFleet(sql, alert, goal);
    expect(registerMock).toHaveBeenCalledWith(expect.objectContaining({
      holderOwnerId: 'su-holder', leaderOwnerId: 'su-new-leader',
      expectedLeaderOwnerId: 'su-leader', declaredBy: 'goal-drain-fleet-watchdog',
      identity: expect.objectContaining({ ownerId: 'goal-drain-fleet-watchdog' }),
    }));
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'auto', fleet: 'goal-drain-g-1', slug: 'papercusp',
    }));
    expect(result.actions).toMatchObject({ leaderLaunched: true, memberLaunched: false });
  });

  // WI-10004787: a watchdog-relaunched drain member ran 400+ calls stamped
  // goal_id NULL because its launch carried no --launched-by, the only seam
  // through which bootstrap-su inherits the goal. Both shapes must name the holder.
  it('launches a replacement leader AND worker on behalf of the goal holder (goal inheritance)', async () => {
    observed.set('su-leader', verdict('su-leader', 'ended'));
    launchMock
      .mockResolvedValueOnce({ ok: true, ownerId: 'su-new-leader' })
      .mockResolvedValueOnce({ ok: true, ownerId: 'su-new-worker' });
    const result = await defaultRelaunchDrainFleet(sql, alert, goal);
    expect(result.actions).toMatchObject({ leaderLaunched: true, memberLaunched: true });
    expect(launchMock).toHaveBeenCalledTimes(2);
    for (const [opts] of launchMock.mock.calls) {
      expect(opts).toMatchObject({ launchedBy: 'su-holder', fleet: 'goal-drain-g-1', headless: true });
    }
  });

  it('fills only the missing worker when delegated leadership is live', async () => {
    observed.set('su-leader', verdict('su-leader', 'live'));
    policyMock.mockResolvedValueOnce({
      refusal: null,
      effective: { agent: 'claude', model: 'sonnet', account: 'default', carry: 'cold', compactionLimit: 180_000 },
      degradedReasons: [],
    });
    const result = await defaultRelaunchDrainFleet(sql, alert, goal);
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(policyMock).toHaveBeenCalledWith(expect.objectContaining({ goalRole: 'drain-fleet-member' }));
    expect(launchMock).toHaveBeenCalledWith(expect.objectContaining({ carry: 'cold', compactionLimit: 180_000 }));
    expect(result.actions).toMatchObject({ leaderLaunched: false, memberLaunched: true });
    expect(couplingMock).not.toHaveBeenCalled();
  });

  it('does not open a worker or report success after a concurrent leader wins the CAS', async () => {
    observed.set('su-leader', verdict('su-leader', 'ended'));
    launchMock.mockResolvedValueOnce({ ok: true, ownerId: 'su-new-leader' });
    registerMock.mockResolvedValueOnce({ registered: false, coupled: false, warning: 'CAS lost' });
    await expect(defaultRelaunchDrainFleet(sql, alert, goal)).rejects.toThrow('registry CAS lost');
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses replacement when the recorded leader is unresolved', async () => {
    await expect(defaultRelaunchDrainFleet(sql, alert, goal)).rejects.toThrow('liveness is unresolved');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('preserves an unconfirmed worker rather than launching a duplicate', async () => {
    observed.set('su-leader', verdict('su-leader', 'live'));
    workerRows = [{ owner_id: 'su-unconfirmed-worker' }];
    await expect(defaultRelaunchDrainFleet(sql, alert, goal)).rejects.toThrow('worker liveness unresolved');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('refuses to open any agent when the existing lane lost its positive goal fence', async () => {
    specMock.mockResolvedValueOnce({ view: {} });
    await expect(defaultRelaunchDrainFleet(sql, alert, goal)).rejects.toThrow('no positive goal claim-spec leaf');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('does not report a partial worker launch as restored', async () => {
    observed.set('su-leader', verdict('su-leader', 'live'));
    launchMock.mockResolvedValueOnce({ ok: true, ownerId: 'su-unconfirmed', warning: 'exited early' });
    await expect(defaultRelaunchDrainFleet(sql, alert, goal)).rejects.toThrow('did not confirm the drain worker');
  });
});
