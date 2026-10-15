/**
 * goal-plan-fleet-obligation-detector-2026-08-27 P-002/P-003 — the plan-fleet
 * leg's REAL delivery defaults (escalation, events, holder message + wake).
 *
 * The sibling suite (goal-drain-fleet-watchdog.test.ts) injects every delivery
 * dep, which proves the sweep CALLS them but not what they SEND. This file
 * leaves `escalatePlanFleet` / `emitPlanFleet` / `notifyPlanFleetHolders` at
 * their defaults and mocks only the platform seams they call, so the wire
 * shapes a parked goal holder depends on are pinned: the dedup identity, the
 * two event keys and their payload, and WHO gets woken.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Sql } from 'postgres';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import {
  GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
  fleetKey,
  runGoalDrainFleetSweepOnce,
  type GoalDrainFleetSweepDeps,
  type GoalPlanFleetCohort,
} from './goal-drain-fleet-watchdog';

const { openEscalationMock, emitMock, sendMessageMock, wakeMock } = vi.hoisted(() => ({
  openEscalationMock: vi.fn(async (): Promise<{ coalesced?: boolean }> => ({})),
  emitMock: vi.fn(async () => {}),
  sendMessageMock: vi.fn(async () => ({})),
  wakeMock: vi.fn(async () => ({})),
}));

vi.mock('../agent-tools/coordination/escalations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/escalations')>()),
  openEscalation: openEscalationMock,
}));
vi.mock('../events/await/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/await/engine')>()),
  emitAwaitedEvent: emitMock,
}));
vi.mock('../agent-tools/coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/messages')>()),
  sendMessage: sendMessageMock,
}));
vi.mock('../agent-tools/coordination/inbox-wake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/inbox-wake')>()),
  wakeRecipients: wakeMock,
}));

const NOW = 1_800_000_000_000;
const sql = null as unknown as Sql; // every reader is injected; sql must never be touched

function verdict(ownerId: string, sessionState: LivenessVerdict['sessionState']): LivenessVerdict {
  return {
    ownerId,
    sessionState,
    wakeable: sessionState !== 'ended',
    liveTurn: sessionState === 'live',
    confirmLiveness: null,
    heartbeatFresh: sessionState !== 'ended',
  };
}

const plan = (targetingFleets: GoalPlanFleetCohort['plans'][number]['targetingFleets'] = []) => ({
  goalId: 'g-1',
  workspaceId: 'ws',
  harnessSlug: 'papercusp',
  planSlug: 'p-started',
  itemIds: ['P-002', 'P-003'],
  targetingFleets,
});

/** A goal held by one LIVE holder (su-a) and one ENDED holder (su-gone), with a healthy drain fleet. */
function deps(cohort: GoalPlanFleetCohort): Partial<GoalDrainFleetSweepDeps> {
  return {
    // Canonical condition-rail producer cases cover the independent broadcast.
    // This suite counts the legacy directed holder message and its wake only.
    rail: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) },
    readGoals: vi.fn(async () => ({
      goals: [
        { goalId: 'g-1', workspaceId: 'ws', title: 'ship it', createdAtMs: NOW - GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS * 2, drainFleet: 'drain-1' },
      ],
      holders: [
        { goalId: 'g-1', workspaceId: 'ws', ownerId: 'su-a', setAtMs: NOW - 1 },
        { goalId: 'g-1', workspaceId: 'ws', ownerId: 'su-gone', setAtMs: NOW - 1 },
      ],
    })),
    resolveLiveness: vi.fn(async () => new Map([['su-a', verdict('su-a', 'live')], ['su-gone', verdict('su-gone', 'ended')]])),
    resolveFleetLiveness: vi.fn(async () => new Map([[fleetKey('ws', 'drain-1'), 'alive' as const]])),
    resolveFleetSpecScopes: vi.fn(async () => new Map([['g-1', 'goal-scoped' as const]])),
    escalate: vi.fn(async () => {}),
    emitDrainDead: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    readPlanFleetCohort: vi.fn(async () => cohort),
    // This suite exercises plan-fleet delivery, not the independent pull-stall
    // census. Keep that reader hermetic instead of touching the sentinel SQL.
    readPullStallAlerts: vi.fn(async () => []),
  };
}

beforeEach(() => {
  openEscalationMock.mockReset().mockResolvedValue({});
  emitMock.mockReset().mockResolvedValue(undefined);
  sendMessageMock.mockReset().mockResolvedValue({});
  wakeMock.mockReset().mockResolvedValue({});
});

describe('plan-fleet leg — real delivery defaults', () => {
  it('leg A opens ONE deduped advisory escalation keyed on (workspace, goal, reason, plan)', async () => {
    const res = await runGoalDrainFleetSweepOnce(sql, deps({ status: 'known', plans: [plan()] }));
    expect(res.planFleetEscalated).toBe(1);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [identity, input] = openEscalationMock.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string; body: string; meta: Record<string, unknown> },
    ];
    expect(identity.ownerId).toBe('goal-drain-fleet-watchdog');
    expect(input.severity).toBe('advisory');
    expect(input.summary).toContain("started plan 'p-started' has no live fleet targeting it");
    expect(input.body).toContain("fleet:launch-on-plan { plan: 'p-started' }");
    expect(input.meta).toMatchObject({
      dedupKind: 'goal-plan-fleet-obligation',
      subjectSignature: 'ws:g-1:started-plan-no-live-targeting-fleet:p-started',
      goalId: 'g-1',
      goalWorkspaceId: 'ws',
      planSlug: 'p-started',
      openItemIds: ['P-002', 'P-003'],
    });
  });

  it('emits BOTH the shared placement key and the leg-specific key, each carrying the evidence payload', async () => {
    await runGoalDrainFleetSweepOnce(sql, deps({ status: 'known', plans: [plan()] }));
    const calls = emitMock.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);
    expect(calls.map((c) => c.key).sort()).toEqual(['goal:plan-fleet-missing:g-1', 'goal:plan-placement:g-1']);
    for (const call of calls) {
      expect(call).toMatchObject({
        workspaceId: 'ws',
        source: 'goal-drain-fleet-watchdog',
        payload: {
          goalId: 'g-1',
          reason: 'started-plan-no-live-targeting-fleet',
          planSlug: 'p-started',
          harnessSlug: 'papercusp',
          openItemCount: 2,
          liveHolders: ['su-a'],
        },
      });
    }
  });

  it('leg B fires the unclaimed key and names the targeting fleet and its spec in the payload', async () => {
    await runGoalDrainFleetSweepOnce(
      sql,
      deps({ status: 'known', plans: [plan([{ fleetSlug: 'fleet-p', liveness: 'alive', liveClaimItemIds: [] }])] }),
    );
    const leg = emitMock.mock.calls
      .map((c) => (c as unknown as [Record<string, unknown>])[0])
      .find((c) => c.key === 'goal:plan-fleet-unclaimed:g-1');
    expect(leg).toBeDefined();
    expect(leg!.payload).toMatchObject({
      reason: 'started-plan-targeting-fleet-zero-live-claims',
      targetingFleets: [{ fleetSlug: 'fleet-p', liveness: 'alive', claimSpecRef: 'fleet:fleet-p', liveClaimCount: 0 }],
    });
  });

  it('wakes exactly the POSITIVELY-live holder — never an ended one — with a durable message first', async () => {
    await runGoalDrainFleetSweepOnce(sql, deps({ status: 'known', plans: [plan()] }));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [, msg] = sendMessageMock.mock.calls[0] as unknown as [unknown, { to: string[]; summary: string; body: string }];
    expect(msg.to).toEqual(['su-a']);
    expect(msg.body).toContain('Evidence: {');
    expect(wakeMock).toHaveBeenCalledTimes(1);
    const [recipients, opts] = wakeMock.mock.calls[0] as unknown as [string[], { workspaceId: string; source: string }];
    expect(recipients).toEqual(['su-a']);
    expect(opts).toMatchObject({ workspaceId: 'ws', source: 'goal-drain-fleet-watchdog' });
    // message before wake: the woken turn must find the remedy already in its inbox
    expect(sendMessageMock.mock.invocationCallOrder[0]).toBeLessThan(wakeMock.mock.invocationCallOrder[0]);
  });

  it('a coalesced escalation (condition already reported) re-emits the events but sends no message and no wake', async () => {
    openEscalationMock.mockResolvedValue({ coalesced: true });
    const res = await runGoalDrainFleetSweepOnce(sql, deps({ status: 'known', plans: [plan()] }));
    expect(res.planFleetEscalated).toBe(1);
    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it('control: a healthy plan reaches none of the delivery seams', async () => {
    await runGoalDrainFleetSweepOnce(
      sql,
      deps({ status: 'known', plans: [plan([{ fleetSlug: 'fleet-p', liveness: 'alive', liveClaimItemIds: ['P-002'] }])] }),
    );
    expect(openEscalationMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(wakeMock).not.toHaveBeenCalled();
  });
});
