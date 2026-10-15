import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFleetM = vi.hoisted(() => vi.fn());
const markMissingM = vi.hoisted(() => vi.fn());
const clearMissingM = vi.hoisted(() => vi.fn());
const listFleetRosterM = vi.hoisted(() => vi.fn());
const takeFleetLeadershipM = vi.hoisted(() => vi.fn());

vi.mock('../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFleet: getFleetM,
  markFleetLeaderMissingSince: markMissingM,
  clearFleetLeaderMissingSince: clearMissingM,
}));

vi.mock('../fleet/fleet-roster', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listFleetRosterDiagnosed: listFleetRosterM,
}));

vi.mock('../agent-tools/fleet_registry/take-leadership-core', () => ({
  takeFleetLeadership: takeFleetLeadershipM,
}));

import {
  diagnoseFleetScopeLeaderLiveness,
  FLEET_LEADER_MISSING_GRACE_MS,
  reconcileFleetScopeLeaderSuccession,
} from './fleet-scope-admission';

const WS = 'papercusp-workspace';
const SLUG = 'ios-fleet';
const scope = { workspaceId: WS, fleetSlug: SLUG, ownerId: 'su-member', record: { spec: {} } };
const identity = { ownerId: 'su-member', workspaceId: WS } as never;

function fleet(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WS,
    fleetSlug: SLUG,
    leaderOwnerId: 'su-leader',
    leaderMissingSinceMs: null,
    updatedAt: 100,
    ...overrides,
  };
}

function liveMember(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'su-member',
    agentRole: 'su',
    fleetRole: 'member',
    sessionState: 'live',
    startedAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
}

function roster(overrides: Record<string, unknown> = {}) {
  return {
    entries: [liveMember()],
    degradedLegs: [],
    leaderLiveness: {
      ownerId: 'su-leader',
      presenceRow: true,
      recordedLive: false,
      sessionState: 'live',
      complete: true,
    },
    ...overrides,
  };
}

function absentLeader() {
  return {
    ownerId: 'su-leader',
    presenceRow: false,
    recordedLive: false,
    sessionState: null,
    complete: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getFleetM.mockResolvedValue(fleet());
  listFleetRosterM.mockResolvedValue(roster());
  markMissingM.mockResolvedValue(fleet({ leaderMissingSinceMs: 1_000 }));
  clearMissingM.mockResolvedValue(fleet({ leaderMissingSinceMs: null }));
  takeFleetLeadershipM.mockResolvedValue({ leader: 'su-member' });
});

describe('diagnoseFleetScopeLeaderLiveness — complete roster evidence', () => {
  it('uses the registry leader liveness even when its soft presence label names another fleet', async () => {
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBe(true);
    expect(getFleetM).toHaveBeenCalledWith(WS, SLUG);
    expect(listFleetRosterM).toHaveBeenCalledWith({ fleetSlug: SLUG, workspaceId: WS, leaderOwnerId: 'su-leader' });
  });

  it('treats a recorded-live session as alive', async () => {
    listFleetRosterM.mockResolvedValueOnce(roster({
      leaderLiveness: { ...absentLeader(), recordedLive: true, sessionState: 'recorded' },
    }));
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBe(true);
  });

  // EI-24962274233684871: a leader parked between wakes (or draining) is the
  // oracle's wakeable verdict, not absence — it must never read as vacant.
  it.each(['parked', 'draining'])('treats a %s registered leader as present', async (state) => {
    listFleetRosterM.mockResolvedValueOnce(roster({
      leaderLiveness: { ...absentLeader(), presenceRow: true, sessionState: state },
    }));
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBe(true);
  });

  it('still treats an explicitly ended registered leader as absent', async () => {
    listFleetRosterM.mockResolvedValueOnce(roster({
      leaderLiveness: { ...absentLeader(), presenceRow: true, sessionState: 'ended' },
    }));
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBe(false);
  });

  it('returns false only when complete roster evidence proves the registered leader absent', async () => {
    listFleetRosterM.mockResolvedValueOnce(roster({ leaderLiveness: absentLeader() }));
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBe(false);
  });

  it('keeps liveness unknown when any required roster leg is degraded', async () => {
    listFleetRosterM.mockResolvedValueOnce(roster({
      degradedLegs: ['recorded'],
      leaderLiveness: { ...absentLeader(), complete: false },
    }));
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBeNull();
  });

  it('does not infer absence from a missing registry row or a failed roster read', async () => {
    getFleetM.mockResolvedValueOnce(null);
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBeNull();
    getFleetM.mockResolvedValueOnce(fleet());
    listFleetRosterM.mockRejectedValueOnce(new Error('roster unavailable'));
    await expect(diagnoseFleetScopeLeaderLiveness({ scope: scope as never })).resolves.toBeNull();
  });
});

describe('reconcileFleetScopeLeaderSuccession', () => {
  it('clears a stale absence clock when complete evidence says the leader is live', async () => {
    getFleetM.mockResolvedValueOnce(fleet({ leaderMissingSinceMs: 50 }));
    const nowMs = 200;
    await expect(reconcileFleetScopeLeaderSuccession({ scope: scope as never, identity, nowMs })).resolves.toBe('live');
    expect(clearMissingM).toHaveBeenCalledWith({
      workspaceId: WS,
      fleetSlug: SLUG,
      expectedLeaderOwnerId: 'su-leader',
      expectedLeaderMissingSinceMs: 50,
      expectedUpdatedAtMs: 100,
      observedAtMs: nowMs,
    });
    expect(markMissingM).not.toHaveBeenCalled();
    expect(takeFleetLeadershipM).not.toHaveBeenCalled();
  });

  it('never starts the absence clock or promotes a member while the leader is parked', async () => {
    getFleetM.mockResolvedValueOnce(fleet({ leaderMissingSinceMs: 50 }));
    listFleetRosterM.mockResolvedValueOnce(roster({
      leaderLiveness: { ...absentLeader(), presenceRow: true, sessionState: 'parked' },
    }));
    await expect(
      reconcileFleetScopeLeaderSuccession({ scope: scope as never, identity, nowMs: 50 + FLEET_LEADER_MISSING_GRACE_MS * 10 }),
    ).resolves.toBe('live');
    expect(markMissingM).not.toHaveBeenCalled();
    expect(takeFleetLeadershipM).not.toHaveBeenCalled();
  });

  it('does not start, clear, or promote on incomplete liveness evidence', async () => {
    getFleetM.mockResolvedValueOnce(fleet({ leaderMissingSinceMs: 50 }));
    listFleetRosterM.mockResolvedValueOnce(roster({
      degradedLegs: ['wakeability'],
      leaderLiveness: { ...absentLeader(), complete: false },
    }));
    await expect(reconcileFleetScopeLeaderSuccession({ scope: scope as never, identity, nowMs: 1_000_000 })).resolves.toBeNull();
    expect(markMissingM).not.toHaveBeenCalled();
    expect(clearMissingM).not.toHaveBeenCalled();
    expect(takeFleetLeadershipM).not.toHaveBeenCalled();
  });

  it('starts the absence clock with the registry version captured before the roster read', async () => {
    getFleetM.mockResolvedValueOnce(fleet());
    listFleetRosterM.mockResolvedValueOnce(roster({ leaderLiveness: absentLeader() }));
    const nowMs = 1_000;
    await expect(reconcileFleetScopeLeaderSuccession({ scope: scope as never, identity, nowMs })).resolves.toBe('unavailable');
    expect(markMissingM).toHaveBeenCalledWith({
      workspaceId: WS,
      fleetSlug: SLUG,
      expectedLeaderOwnerId: 'su-leader',
      expectedUpdatedAtMs: 100,
      observedAtMs: nowMs,
    });
    expect(takeFleetLeadershipM).not.toHaveBeenCalled();
  });

  it('does not promote before the ten-minute grace period', async () => {
    getFleetM.mockResolvedValueOnce(fleet({ leaderMissingSinceMs: 1_000 }));
    listFleetRosterM.mockResolvedValueOnce(roster({ leaderLiveness: absentLeader() }));
    await expect(reconcileFleetScopeLeaderSuccession({
      scope: scope as never,
      identity,
      nowMs: 1_000 + FLEET_LEADER_MISSING_GRACE_MS - 1,
    })).resolves.toBe('unavailable');
    expect(takeFleetLeadershipM).not.toHaveBeenCalled();
  });

  it('promotes the oldest positively-live su member at the grace boundary through the shared takeover CAS', async () => {
    const first = liveMember({ agentId: 'su-oldest', startedAt: '2026-10-03T09:00:00.000Z' });
    const second = liveMember({ agentId: 'su-member', startedAt: '2026-10-03T10:00:00.000Z' });
    const nowMs = 1_000 + FLEET_LEADER_MISSING_GRACE_MS;
    getFleetM.mockResolvedValueOnce(fleet({ leaderMissingSinceMs: 1_000 }));
    listFleetRosterM.mockResolvedValueOnce(roster({ entries: [second, first], leaderLiveness: absentLeader() }));
    takeFleetLeadershipM.mockResolvedValueOnce({ leader: 'su-oldest' });
    await expect(reconcileFleetScopeLeaderSuccession({ scope: scope as never, identity, nowMs })).resolves.toBe('live');
    expect(takeFleetLeadershipM).toHaveBeenCalledWith(
      WS,
      fleet({ leaderMissingSinceMs: 1_000 }),
      identity,
      'su-oldest',
      {
        succession: {
          expectedLeaderOwnerId: 'su-leader',
          expectedLeaderMissingSinceMs: 1_000,
          expectedUpdatedAtMs: 100,
          nowMs,
          graceMs: FLEET_LEADER_MISSING_GRACE_MS,
        },
      },
    );
  });

  it('keeps a confirmed vacancy unavailable when no positively-live su member can lead', async () => {
    getFleetM.mockResolvedValueOnce(fleet({ leaderMissingSinceMs: 1_000 }));
    listFleetRosterM.mockResolvedValueOnce(roster({ entries: [], leaderLiveness: absentLeader() }));
    await expect(reconcileFleetScopeLeaderSuccession({
      scope: scope as never,
      identity,
      nowMs: 1_000 + FLEET_LEADER_MISSING_GRACE_MS,
    })).resolves.toBe('unavailable');
    expect(takeFleetLeadershipM).not.toHaveBeenCalled();
  });
});
