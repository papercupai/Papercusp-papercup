/**
 * fleet-transition-sweep-action.test — the sweep that drives P-009's two DERIVED
 * transitions (member-dead, context-critical).
 *
 * The sweep's whole job is to carry state between rounds correctly. The cases that
 * matter are the ones where getting that wrong produces a monitor nobody trusts:
 * firing on the first round (a restart storm), re-firing while a state persists (a
 * wake storm), and — the subtle one — failing to advance the snapshot when nothing
 * fired, which would make the sweep permanently blind to the next crossing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const productionMocks = vi.hoisted(() => ({
  listFleetAssignments: vi.fn(),
  reconcileWakeability: vi.fn(),
  decorateParkedOn: vi.fn(),
  decorateLoopMonitorStates: vi.fn(),
  fetchContextPressure: vi.fn(),
  readFleetAdmissionBlocks: vi.fn(),
  readFleetRepeatedRecoveryStates: vi.fn(),
}));

vi.mock('../../fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/assignments')>()),
  listFleetAssignments: productionMocks.listFleetAssignments,
}));
vi.mock('../../agent-tools/fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-tools/fleet/assignments')>()),
  reconcileWakeability: productionMocks.reconcileWakeability,
  decorateParkedOn: productionMocks.decorateParkedOn,
  decorateLoopMonitorStates: productionMocks.decorateLoopMonitorStates,
}));
vi.mock('../../agent-tools/coordination/context-pressure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-tools/coordination/context-pressure')>()),
  fetchContextPressure: productionMocks.fetchContextPressure,
}));
vi.mock('../../agent-tools/coordination/fleet-scope-admission-blocks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-tools/coordination/fleet-scope-admission-blocks')>()),
  readFleetAdmissionBlocks: productionMocks.readFleetAdmissionBlocks,
}));
vi.mock('../../fleet-repeated-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet-repeated-recovery')>()),
  readFleetRepeatedRecoveryStates: productionMocks.readFleetRepeatedRecoveryStates,
}));
import {
  __resetFleetTransitionSnapshotForTests,
  gatherFleetObservations,
  gatherFleetAdmissionObservations,
  runFleetTransitionSweep,
} from './fleet-transition-sweep-action';
import { detectFleetAdmissionTransitions, type FleetMemberObservation } from '../../fleet-transition-events';

const member = (over: Partial<FleetMemberObservation> = {}): FleetMemberObservation => ({
  agentId: 'su-a',
  fleetSlug: 'push-not-poll',
  sessionState: 'live',
  contextPressure: 'ok',
  ...over,
});

const settle = () => new Promise((r) => setImmediate(r));

const presenceRow = (detail: string) => ({
  source: 'presence' as const,
  workspaceId: 'papercusp-workspace',
  agentId: 'su-a',
  agentLabel: 'su-a',
  agentName: null,
  harnessSlug: 'papercusp',
  planSlug: null,
  itemId: null,
  workItemId: null,
  itemKind: null,
  detail,
  status: null,
  claimAcquiredTs: null,
  claimExpiresTs: null,
  claimActive: null,
  livenessMode: null,
  lastActivityTs: null,
  holderPresent: true,
  holderAlive: true,
  holderHeartbeatAt: '2026-08-27T09:00:00.000Z',
  holderIntent: null,
  holderPlanSlug: null,
  orphaned: false,
  stalled: null,
  lastProgressAt: null,
  declaredPlanMatches: null,
  assigneeRank: null,
  rankWriter: null,
  fleetSlug: 'fleet-a',
  fleetRole: 'member',
});

/** Drive a scripted sequence of sweeps, returning the keys emitted per round. */
async function sweepRounds(rounds: FleetMemberObservation[][]): Promise<string[][]> {
  const perRound: string[][] = [];
  for (const observations of rounds) {
    const emit = vi.fn().mockResolvedValue(undefined);
    await runFleetTransitionSweep({
      gather: async () => observations,
      emit,
      currentContextEpoch: async () => null,
    });
    await settle();
    perRound.push(emit.mock.calls.map((c) => c[0].key as string));
  }
  return perRound;
}

beforeEach(() => {
  __resetFleetTransitionSnapshotForTests();
  productionMocks.listFleetAssignments.mockReset();
  productionMocks.reconcileWakeability.mockReset();
  productionMocks.decorateParkedOn.mockReset();
  productionMocks.decorateLoopMonitorStates.mockReset();
  productionMocks.decorateParkedOn.mockImplementation(async (agents: unknown[]) => agents);
  productionMocks.decorateLoopMonitorStates.mockImplementation(async (agents: unknown[]) => agents);
  productionMocks.fetchContextPressure.mockReset();
  productionMocks.readFleetAdmissionBlocks.mockReset();
  productionMocks.readFleetRepeatedRecoveryStates.mockReset();
  productionMocks.readFleetRepeatedRecoveryStates.mockResolvedValue(new Map());
});

describe('runFleetTransitionSweep', () => {
  it('is SILENT on the first sweep, then fires on the crossing in the second', async () => {
    const rounds = await sweepRounds([[member({ sessionState: 'live' })], [member({ sessionState: 'ended' })]]);
    expect(rounds[0]).toEqual([]);
    expect(rounds[1]).toEqual(['fleet:member-dead:push-not-poll']);
  });

  it('wakes once for a recorded, non-wakeable member while claims remain', async () => {
    const rounds = await sweepRounds([
      [member({ sessionState: 'live', wakeable: true, claimCount: 2 })],
      [member({ sessionState: 'recorded', wakeable: false, claimCount: 2 })],
      [member({ sessionState: 'recorded', wakeable: false, claimCount: 2 })],
      [member({ sessionState: 'recorded', wakeable: false, claimCount: 0 })],
    ]);
    expect(rounds).toEqual([[], ['fleet:member-left:push-not-poll'], [], []]);
  });

  it('carries a healthy loop state from fleet assignments into member observations', async () => {
    productionMocks.listFleetAssignments.mockResolvedValue([presenceRow('gather')]);
    productionMocks.reconcileWakeability.mockImplementation(async (agents) =>
      agents.map((agent: object) => ({ ...agent, sessionState: 'recorded', wakeable: false })),
    );
    productionMocks.decorateLoopMonitorStates.mockImplementation(async (agents) => {
      for (const agent of agents) Object.assign(agent, { monitorState: 'waiting' });
      return agents;
    });
    productionMocks.fetchContextPressure.mockResolvedValue(new Map());

    await expect(gatherFleetObservations()).resolves.toMatchObject([
      { sessionState: 'recorded', wakeable: false, loopMonitorState: 'waiting' },
    ]);
  });

  it('does not wake the leader repeatedly for live/recorded flaps with unchanged claims', async () => {
    const live = member({ sessionState: 'live', wakeable: true, claimCount: 2, claimKeys: ['WI-1', 'WI-2'] });
    const recorded = member({ sessionState: 'recorded', wakeable: false, claimCount: 2, claimKeys: ['WI-1', 'WI-2'] });
    const rounds = await sweepRounds([[live], [recorded], [live], [recorded], [live], [recorded]]);
    expect(rounds).toEqual([[], ['fleet:member-left:push-not-poll'], [], [], [], []]);
  });

  it('does not fire on the FIRST sweep even when a member is already dead — the restart-storm guard', async () => {
    const rounds = await sweepRounds([[member({ sessionState: 'ended', contextPressure: 'critical' })]]);
    expect(rounds[0]).toEqual([]);
  });

  it('fires ONCE for a state that persists across many sweeps', async () => {
    const rounds = await sweepRounds([
      [member({ sessionState: 'live' })],
      [member({ sessionState: 'ended' })],
      [member({ sessionState: 'ended' })],
      [member({ sessionState: 'ended' })],
    ]);
    expect(rounds.map((r) => r.length)).toEqual([0, 1, 0, 0]);
  });

  it('ADVANCES the snapshot on a quiet sweep — otherwise the next crossing is invisible', async () => {
    // The regression this pins: if the sweep only stored a snapshot when it fired,
    // round 2's transition to 'high' would be dropped and round 3 would compare
    // against round 1, so a genuine high→critical crossing could be missed or
    // mis-attributed. Three rounds where only the LAST is a crossing.
    const rounds = await sweepRounds([
      [member({ contextPressure: 'ok' })],
      [member({ contextPressure: 'high' })],
      [member({ contextPressure: 'critical' })],
    ]);
    expect(rounds).toEqual([[], [], ['fleet:context-critical:push-not-poll']]);
  });

  it('fires repeated-recovery once on 1 → 2 and not again on 2 → 3', async () => {
    const rounds = await sweepRounds([
      [member({ consecutiveRecoveryOnlyCycles: 1 })],
      [member({ consecutiveRecoveryOnlyCycles: 2 })],
      [member({ consecutiveRecoveryOnlyCycles: 3 })],
    ]);
    expect(rounds).toEqual([[], ['fleet:repeated-recovery:push-not-poll'], []]);
  });

  it('returns the number of edges it fired', async () => {
    await runFleetTransitionSweep({ gather: async () => [member({ sessionState: 'live' })], emit: vi.fn() });
    const fired = await runFleetTransitionSweep({
      gather: async () => [member({ sessionState: 'ended', contextPressure: 'critical' })],
      emit: vi.fn().mockResolvedValue(undefined),
    });
    expect(fired).toBe(2);
  });

  it('shares the leader-recovery pass with the sweep without requiring a member pull', async () => {
    const recoverObservedLeaders = vi.fn().mockResolvedValue(1);
    const observations = [member({ sessionState: 'ended' })];
    const fired = await runFleetTransitionSweep({
      gather: async () => observations,
      emit: vi.fn(),
      recoverObservedLeaders,
    });

    expect(recoverObservedLeaders).toHaveBeenCalledWith(observations);
    expect(fired).toBe(1);
  });

  it('revalidates a context-critical edge against the current writer before delivery', async () => {
    await runFleetTransitionSweep({
      gather: async () => [member({ contextPressure: 'high' })],
      emit: vi.fn(),
    });
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentContextPressure = vi.fn(async () => 'ok' as const);

    await runFleetTransitionSweep({
      gather: async () => [member({ contextPressure: 'critical' })],
      emit,
      currentContextPressure,
    });
    await settle();

    expect(currentContextPressure).toHaveBeenCalledWith('su-a');
    expect(emit).not.toHaveBeenCalled();
  });

  it('wires member-dead production edges to a last-moment member revalidation', async () => {
    let gatherState: 'live' | 'ended' = 'live';
    let currentState: 'live' | 'ended' = 'live';
    productionMocks.listFleetAssignments.mockImplementation(async (options?: { fleet?: string }) => [
      presenceRow(options?.fleet ? 'current' : 'gather'),
    ]);
    productionMocks.reconcileWakeability.mockImplementation(async (agents: Array<{ intent: string }>) =>
      agents.map((agent) => ({
        ...agent,
        sessionState: agent.intent === 'current' ? currentState : gatherState,
        wakeable: true,
      })),
    );
    productionMocks.fetchContextPressure.mockResolvedValue(new Map());

    await runFleetTransitionSweep({ gatherAdmissions: async () => [], emit: vi.fn() });
    gatherState = 'ended';
    currentState = 'live';
    const emit = vi.fn().mockResolvedValue(undefined);

    await runFleetTransitionSweep({ gatherAdmissions: async () => [], emit });
    await settle();

    expect(productionMocks.listFleetAssignments).toHaveBeenCalledWith({ fleet: 'fleet-a', agent: 'su-a' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('wires member-stalled production edges to a last-moment assignment revalidation', async () => {
    let gatherStalled = false;
    let currentStalled = true;
    const claimRow = (stalled: boolean) => ({
      ...presenceRow('claim'),
      source: 'work_item_claim' as const,
      workItemId: 'WI-1',
      detail: 'claim',
      claimActive: true,
      holderPresent: true,
      stalled,
    });
    productionMocks.listFleetAssignments.mockImplementation(async (options?: { fleet?: string }) => [
      presenceRow(options?.fleet ? 'current' : 'gather'),
      claimRow(options?.fleet ? currentStalled : gatherStalled),
    ]);
    productionMocks.reconcileWakeability.mockImplementation(async (agents: Array<{ intent: string }>) =>
      agents.map((agent) => ({ ...agent, sessionState: 'live', wakeable: true })),
    );
    productionMocks.fetchContextPressure.mockResolvedValue(new Map());

    await runFleetTransitionSweep({ gatherAdmissions: async () => [], emit: vi.fn() });
    const emit = vi.fn().mockResolvedValue(undefined);
    gatherStalled = true;
    currentStalled = false;

    await runFleetTransitionSweep({ gatherAdmissions: async () => [], emit });
    await settle();

    expect(emit).not.toHaveBeenCalled();
    expect(productionMocks.listFleetAssignments).toHaveBeenCalledWith({ fleet: 'fleet-a', agent: 'su-a' });
  });

  it('does not snapshot recorded, non-wakeable, claimless stand-down residue', async () => {
    const rounds = await sweepRounds([
      [member({ contextPressure: 'high', wakeable: true, claimCount: 1 })],
      [member({ sessionState: 'recorded', contextPressure: 'critical', wakeable: false, claimCount: 0 })],
    ]);
    expect(rounds).toEqual([[], []]);
  });

  it('excludes recorded non-wakeable former members from admission blocks while retaining live members', async () => {
    productionMocks.listFleetAssignments.mockResolvedValue([
      { ...presenceRow('live'), agentId: 'su-live', agentLabel: 'su-live' },
      { ...presenceRow('recorded'), agentId: 'su-former', agentLabel: 'su-former' },
    ]);
    productionMocks.reconcileWakeability.mockImplementation(async (agents: Array<{ agentId: string }>) =>
      agents.map((agent) => ({
        ...agent,
        sessionState: agent.agentId === 'su-former' ? 'recorded' : 'live',
        wakeable: agent.agentId !== 'su-former',
      })),
    );
    productionMocks.readFleetAdmissionBlocks.mockResolvedValue({ available: true, blocks: [{}] });

    await expect(gatherFleetAdmissionObservations()).resolves.toEqual([
      { fleetSlug: 'fleet-a', blockedCount: 1, newestBlockAtMs: null },
    ]);
    expect(productionMocks.readFleetAdmissionBlocks).toHaveBeenCalledWith('fleet-a', {
      liveMemberIds: ['su-live'],
    });
  });

  it('reports the newest listed block time with the count', async () => {
    productionMocks.listFleetAssignments.mockResolvedValue([presenceRow('live')]);
    productionMocks.reconcileWakeability.mockImplementation(async (agents: unknown[]) => agents);
    productionMocks.readFleetAdmissionBlocks.mockResolvedValue({
      available: true,
      blocks: [{ atMs: 1_000 }, { atMs: 3_000 }, { atMs: 2_000 }],
    });

    await expect(gatherFleetAdmissionObservations()).resolves.toEqual([
      { fleetSlug: 'fleet-a', blockedCount: 3, newestBlockAtMs: 3_000 },
    ]);
  });

  // WI-10003609: the admission baseline is module state, so every sweep-process
  // restart used to re-announce each still-listed block as a 0-to-N rise.
  describe('admission first sighting after a restart', () => {
    const baselineSinceMs = 1_790_000_000_000;
    const gather = async () => [];

    it('does not re-announce an unchanged block list raised before the baseline began', async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const stale = [{ fleetSlug: 'p013-bcd', blockedCount: 2, newestBlockAtMs: baselineSinceMs - 15 * 3_600_000 }];
      // First process: the blocks were new to it and it announced them.
      __resetFleetTransitionSnapshotForTests({ admissionBaselineSinceMs: baselineSinceMs - 20 * 3_600_000 });
      await runFleetTransitionSweep({ gather, gatherAdmissions: async () => stale, emit });
      await settle();
      expect(emit).toHaveBeenCalledTimes(1);

      // Restart: fresh module state, same block list. No second wake.
      __resetFleetTransitionSnapshotForTests({ admissionBaselineSinceMs: baselineSinceMs });
      await runFleetTransitionSweep({ gather, gatherAdmissions: async () => stale, emit });
      await runFleetTransitionSweep({ gather, gatherAdmissions: async () => stale, emit });
      await settle();
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('control: without the first-sighting gate the same stale list manufactures a 0-to-N edge', () => {
      const stale = [{ fleetSlug: 'p013-bcd', blockedCount: 2, newestBlockAtMs: baselineSinceMs - 15 * 3_600_000 }];
      // The pre-fix call shape. If this stops firing, the restart test above
      // passes vacuously and no longer proves the gate does anything.
      expect(detectFleetAdmissionTransitions(new Map(), stale)).toEqual([
        { kind: 'admission-blocked', fleetSlug: 'p013-bcd', from: 0, to: 2 },
      ]);
      expect(detectFleetAdmissionTransitions(new Map(), stale, { firstSightingSinceMs: baselineSinceMs })).toEqual([]);
    });

    it('still announces a block raised after the baseline began', async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      __resetFleetTransitionSnapshotForTests({ admissionBaselineSinceMs: baselineSinceMs });
      await runFleetTransitionSweep({
        gather,
        gatherAdmissions: async () => [{ fleetSlug: 'p013-bcd', blockedCount: 1, newestBlockAtMs: baselineSinceMs + 1 }],
        emit,
      });
      await settle();
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'fleet:admission-blocked:p013-bcd',
          payload: expect.objectContaining({ from: 0, to: 1 }),
        }),
      );
    });

    it('seeds silently from old blocks, then fires when a new block raises the count', async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      __resetFleetTransitionSnapshotForTests({ admissionBaselineSinceMs: baselineSinceMs });
      await runFleetTransitionSweep({
        gather,
        gatherAdmissions: async () => [{ fleetSlug: 'p013-bcd', blockedCount: 2, newestBlockAtMs: baselineSinceMs - 60_000 * 60 }],
        emit,
      });
      await runFleetTransitionSweep({
        gather,
        gatherAdmissions: async () => [{ fleetSlug: 'p013-bcd', blockedCount: 3, newestBlockAtMs: baselineSinceMs + 5_000 }],
        emit,
      });
      await settle();
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ from: 2, to: 3 }) }),
      );
    });

    it('fails open when the newest block time is unknown', async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      __resetFleetTransitionSnapshotForTests({ admissionBaselineSinceMs: baselineSinceMs });
      await runFleetTransitionSweep({
        gather,
        gatherAdmissions: async () => [{ fleetSlug: 'p013-bcd', blockedCount: 2, newestBlockAtMs: null }],
        emit,
      });
      await settle();
      expect(emit).toHaveBeenCalledTimes(1);
    });
  });

  it('retains the last measured admission count across an unavailable sweep', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const gather = async () => [];

    await runFleetTransitionSweep({
      gather,
      gatherAdmissions: async () => [{ fleetSlug: 'fleet-a', blockedCount: 0 }],
      emit,
    });
    await runFleetTransitionSweep({
      gather,
      gatherAdmissions: async () => [{ fleetSlug: 'fleet-a', blockedCount: 4 }],
      emit,
    });
    await runFleetTransitionSweep({
      gather,
      gatherAdmissions: async () => [{ fleetSlug: 'fleet-a', blockedCount: null }],
      emit,
    });
    await runFleetTransitionSweep({
      gather,
      gatherAdmissions: async () => [],
      emit,
    });
    await runFleetTransitionSweep({
      gather,
      gatherAdmissions: async () => [{ fleetSlug: 'fleet-a', blockedCount: 4 }],
      emit,
    });
    await settle();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'fleet:admission-blocked:fleet-a',
        payload: expect.objectContaining({ from: 0, to: 4 }),
      }),
    );
  });

  it('projects a thrown admission read as unknown instead of zero', async () => {
    productionMocks.listFleetAssignments.mockResolvedValue([presenceRow('live')]);
    productionMocks.reconcileWakeability.mockImplementation(async (agents: unknown[]) => agents);
    productionMocks.readFleetAdmissionBlocks.mockRejectedValue(new Error('optional read failed'));

    await expect(gatherFleetAdmissionObservations()).resolves.toEqual([{ fleetSlug: 'fleet-a', blockedCount: null }]);
  });

  it('keeps fleets independent — a crossing in one fleet is not attributed to another', async () => {
    const a = member({ agentId: 'su-a', fleetSlug: 'fleet-a' });
    const b = member({ agentId: 'su-b', fleetSlug: 'fleet-b' });
    const rounds = await sweepRounds([
      [a, b],
      [{ ...a, sessionState: 'ended' }, b],
    ]);
    expect(rounds[1]).toEqual(['fleet:member-dead:fleet-a']);
  });

  it('treats an empty observation set as a quiet sweep, not a mass death', async () => {
    const rounds = await sweepRounds([[member({ sessionState: 'live' })], []]);
    expect(rounds[1]).toEqual([]);
  });
});
