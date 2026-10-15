/**
 * Unit tests for the SHARED leadership-transfer effect (EI-5705 / EI-5704). The store +
 * presence + coord seams are mocked, so this verifies the ORCHESTRATION — single-leader
 * install, prior-leader demotion (incl. the no-fleet-label case), the displaced-leader
 * notification, and the `notified` return — without PG. The pure `shouldDemotePriorLeader`
 * predicate runs real (it is cheap + tested separately in _shared.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentFleetRecord } from '../../agent-fleets-store';

const setFleetLeader = vi.fn();
const promoteFleetLeaderIfMissing = vi.fn();
const emitAwaitedEvent = vi.fn();
const heartbeatPresence = vi.fn();
const setPresenceFleet = vi.fn();
const fetchPresenceFleet = vi.fn();
const sendMessage = vi.fn();
const ensureFleetLeaderControl = vi.fn();
const retireFleetLeaderWatches = vi.fn();
const resolveFleetLeaderTransitionEventKeys = vi.fn();
const clearOperatorCancelledAwaits = vi.fn();
const getClaimSpecRecord = vi.fn();
const getModeSubject = vi.fn();

vi.mock('../../modes/store', () => ({
  getModeSubject: (...a: unknown[]) => getModeSubject(...a),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  setFleetLeader: (...a: unknown[]) => setFleetLeader(...a),
  promoteFleetLeaderIfMissing: (...a: unknown[]) => promoteFleetLeaderIfMissing(...a),
}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: (...a: unknown[]) => emitAwaitedEvent(...a),
}));
vi.mock('../coordination/presence', () => ({
  heartbeatPresence: (...a: unknown[]) => heartbeatPresence(...a),
  setPresenceFleet: (...a: unknown[]) => setPresenceFleet(...a),
}));
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...a: unknown[]) => fetchPresenceFleet(...a),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));
vi.mock('./leader-control', () => ({
  ensureFleetLeaderControl: (...a: unknown[]) => ensureFleetLeaderControl(...a),
  resolveFleetLeaderTransitionEventKeys: (...a: unknown[]) => resolveFleetLeaderTransitionEventKeys(...a),
  retireFleetLeaderWatches: (...a: unknown[]) => retireFleetLeaderWatches(...a),
}));
vi.mock('../../events/await/store', () => ({
  clearOperatorCancelledAwaits: (...a: unknown[]) => clearOperatorCancelledAwaits(...a),
}));
vi.mock('../../scheduler/claim-spec-store', () => ({
  fleetSpecBeeKey: (fleetSlug: string) => `fleet:${fleetSlug}`,
  getClaimSpecRecord: (...a: unknown[]) => getClaimSpecRecord(...a),
}));

import { takeFleetLeadership } from './take-leadership-core';

const WS = 'ws';
const SLUG = 'rocket';
const identity = { ownerId: 'su-bob', workspaceId: WS } as never;

function fleet(over: Partial<AgentFleetRecord> = {}): AgentFleetRecord {
  return {
    workspaceId: WS,
    fleetSlug: SLUG,
    title: null,
    description: null,
    owner: null,
    leaderOwnerId: null,
    colorScheme: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getModeSubject.mockResolvedValue(null);
  fetchPresenceFleet.mockResolvedValue(new Map()); // default: prior leader carries no fleet label
  sendMessage.mockResolvedValue({ msg_id: 'm1' });
  setFleetLeader.mockResolvedValue(fleet({ leaderOwnerId: 'su-bob' }));
  promoteFleetLeaderIfMissing.mockResolvedValue(fleet({ leaderOwnerId: 'su-bob' }));
  emitAwaitedEvent.mockResolvedValue({ ok: true, waiters: 1 });
  ensureFleetLeaderControl.mockResolvedValue({
    healthy: true,
    mode: { healthy: true, changed: true },
  });
  retireFleetLeaderWatches.mockResolvedValue(0);
  resolveFleetLeaderTransitionEventKeys.mockReturnValue([
    'fleet:member-dead:rocket',
    'fleet:drained:rocket',
    'fleet:context-critical:rocket',
  ]);
  clearOperatorCancelledAwaits.mockResolvedValue(0);
  getClaimSpecRecord.mockResolvedValue({
    source: 'fleet',
    harnessSlug: 'papercusp',
    fleetSlug: SLUG,
    spec: {},
    revision: 1,
    updatedBy: 'test',
    updatedAt: 'now',
  });
});

describe('takeFleetLeadership (D-002 single-leader + notify, EI-5705/EI-5704)', () => {
  it('refuses GOAL holder leadership before any registry or presence mutation', async () => {
    getModeSubject.mockResolvedValue('goal-1');
    await expect(takeFleetLeadership(WS, fleet(), identity, 'su-bob')).rejects.toMatchObject({
      code: 'goal_plan_fleet_self_leadership',
    });
    expect(getClaimSpecRecord).not.toHaveBeenCalled();
    expect(setFleetLeader).not.toHaveBeenCalled();
    expect(setPresenceFleet).not.toHaveBeenCalled();
  });
  it('refuses before writing leadership when the fleet claim spec has no concrete harness binding', async () => {
    getClaimSpecRecord.mockResolvedValueOnce({
      source: 'default',
      harnessSlug: null,
      fleetSlug: SLUG,
      spec: {},
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });

    await expect(takeFleetLeadership(WS, fleet({ leaderOwnerId: null }), identity, 'su-bob')).rejects.toMatchObject({
      code: 'fleet_harness_binding_required',
    });
    expect(setFleetLeader).not.toHaveBeenCalled();
    expect(heartbeatPresence).not.toHaveBeenCalled();
    expect(setPresenceFleet).not.toHaveBeenCalled();
  });

  it('fails closed when the fleet claim-spec binding cannot be read', async () => {
    getClaimSpecRecord.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(takeFleetLeadership(WS, fleet(), identity, 'su-bob')).rejects.toMatchObject({
      code: 'fleet_harness_binding_unavailable',
    });
    expect(setFleetLeader).not.toHaveBeenCalled();
  });

  it('installs the caller as leader + labels their presence; no prior leader → no demote/notify', async () => {
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: null }), identity, 'su-bob');
    expect(setFleetLeader).toHaveBeenCalledWith(WS, SLUG, 'su-bob', undefined, null);
    expect(setPresenceFleet).toHaveBeenCalledWith(WS, 'su-bob', SLUG, 'leader');
    expect(ensureFleetLeaderControl).toHaveBeenCalledWith({
      workspaceId: WS,
      ownerId: 'su-bob',
      fleetSlug: SLUG,
      harnessSlug: undefined,
      planSlug: undefined,
      carry: undefined,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      leader: 'su-bob',
      previousLeader: null,
      demotedPriorLeader: null,
      notified: false,
      autoArmSuppressions: { requested: false, eventKeys: [], cleared: 0 },
      control: { healthy: true },
    });
  });

  it('uses the vacancy registry CAS and emits the shared leader-change event for scheduler succession', async () => {
    const succession = {
      expectedLeaderOwnerId: 'su-alice',
      expectedLeaderMissingSinceMs: 1_000,
      expectedUpdatedAtMs: 2_000,
      nowMs: 602_000,
      graceMs: 600_000,
    };
    const out = await takeFleetLeadership(
      WS,
      fleet({ leaderOwnerId: 'su-alice', leaderMissingSinceMs: 1_000, updatedAt: 2_000 }),
      identity,
      'su-successor',
      { succession },
    );

    expect(promoteFleetLeaderIfMissing).toHaveBeenCalledWith({
      workspaceId: WS,
      fleetSlug: SLUG,
      expectedLeaderOwnerId: 'su-alice',
      expectedLeaderMissingSinceMs: 1_000,
      expectedUpdatedAtMs: 2_000,
      replacementLeaderOwnerId: 'su-successor',
      nowMs: 602_000,
      graceMs: 600_000,
    });
    expect(setFleetLeader).not.toHaveBeenCalled();
    expect(heartbeatPresence).not.toHaveBeenCalled();
    expect(setPresenceFleet).toHaveBeenCalledWith(WS, 'su-successor', SLUG, 'leader');
    expect(emitAwaitedEvent).toHaveBeenCalledWith({
      key: 'fleet:leader-changed:rocket',
      summary: "Fleet 'rocket' leadership changed to su-successor.",
      payload: { fleet: 'rocket', previousLeader: 'su-alice', leader: 'su-successor' },
      source: 'su-bob',
      workspaceId: WS,
    });
    expect(out.leader).toBe('su-successor');
  });

  it('clears exact operator-cancel markers only when leadership explicitly requests a re-arm', async () => {
    clearOperatorCancelledAwaits.mockResolvedValue(2);

    const out = await takeFleetLeadership(WS, fleet(), identity, 'su-bob', {
      clearAutoArmSuppressions: true,
    });

    expect(resolveFleetLeaderTransitionEventKeys).toHaveBeenCalledWith({ fleetSlug: SLUG });
    expect(clearOperatorCancelledAwaits).toHaveBeenCalledWith('su-bob', [
      'fleet:member-dead:rocket',
      'fleet:drained:rocket',
      'fleet:context-critical:rocket',
    ]);
    expect(out.autoArmSuppressions).toEqual({
      requested: true,
      eventKeys: ['fleet:member-dead:rocket', 'fleet:drained:rocket', 'fleet:context-critical:rocket'],
      cleared: 2,
    });
  });

  it('reports a suppression-clear failure without undoing the committed transfer', async () => {
    clearOperatorCancelledAwaits.mockRejectedValue(new Error('await store down'));

    const out = await takeFleetLeadership(WS, fleet(), identity, 'su-bob', {
      clearAutoArmSuppressions: true,
    });

    expect(out.leader).toBe('su-bob');
    expect(out.autoArmSuppressions).toMatchObject({
      requested: true,
      cleared: 0,
      error: 'await store down',
    });
    expect(ensureFleetLeaderControl).toHaveBeenCalled();
  });

  it('re-taking your OWN leadership does not demote or notify yourself', async () => {
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-bob' }), identity, 'su-bob');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(out.demotedPriorLeader).toBeNull();
    expect(out.notified).toBe(false);
  });

  it('demotes + notifies a distinct prior leader still labeled in THIS fleet', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map([['su-alice', { fleetSlug: SLUG, fleetRole: 'leader' }]]));
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob');
    expect(setPresenceFleet).toHaveBeenCalledWith(WS, 'su-alice', SLUG, 'member');
    expect(retireFleetLeaderWatches).toHaveBeenCalledWith('su-alice', SLUG);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ to: ['su-alice'] });
    expect(out).toMatchObject({ previousLeader: 'su-alice', demotedPriorLeader: 'su-alice', notified: true });
  });

  it('demotes + notifies a prior leader with NO fleet label (the leader-of-record case, EI-5705)', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map()); // su-alice carries no fleet label
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob');
    expect(setPresenceFleet).toHaveBeenCalledWith(WS, 'su-alice', SLUG, 'member');
    expect(out.demotedPriorLeader).toBe('su-alice');
    expect(out.notified).toBe(true);
  });

  it('does NOT demote a prior leader who moved to another fleet — but STILL notifies them', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map([['su-alice', { fleetSlug: 'other', fleetRole: 'leader' }]]));
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob');
    // caller is set to leader, but su-alice is NOT demoted (would yank them out of 'other')
    expect(setPresenceFleet).not.toHaveBeenCalledWith(WS, 'su-alice', SLUG, 'member');
    expect(retireFleetLeaderWatches).toHaveBeenCalledWith('su-alice', SLUG);
    expect(out.demotedPriorLeader).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(out.notified).toBe(true);
  });

  it('a notify failure leaves notified:false but the transfer still lands', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map([['su-alice', { fleetSlug: SLUG, fleetRole: 'leader' }]]));
    sendMessage.mockRejectedValue(new Error('coord down'));
    const out = await takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob');
    expect(setFleetLeader).toHaveBeenCalledWith(WS, SLUG, 'su-bob', undefined, 'su-alice');
    expect(out.demotedPriorLeader).toBe('su-alice'); // demote happened before the notify
    expect(out.notified).toBe(false);
  });

  it('refuses a stale transfer when another leader won after authorization', async () => {
    setFleetLeader.mockResolvedValue(null);
    await expect(takeFleetLeadership(WS, fleet({ leaderOwnerId: 'su-alice' }), identity, 'su-bob'))
      .rejects.toThrow('fleet_leadership_superseded');
    expect(setPresenceFleet).not.toHaveBeenCalled();
  });
});
