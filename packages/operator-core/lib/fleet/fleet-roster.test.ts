/**
 * fleet-roster — named-su-agent-fleets P-005. Pure tests for the fleet-keyed clone of
 * the hive-roster fold: the fleet_slug filter, the fold (preserves the
 * {doing,queued,load,orphaned} work-detail and layers presence + the fleet label +
 * Tier-1 on top), and the registry "available = live-member-count" annotation — all
 * without PG.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  filterPresenceToFleet,
  foldFleetRoster,
  foldFederatedSessionPresence,
  annotateFleetsWithCounts,
  isBeeRole,
  isLaunchLiveSessionState,
  occupiesLaunchMemberSeat,
  livePsuFleetMemberIds,
  splitFleetRosterCounts,
  oldestLiveFleetMember,
  type FederatedSessionFoldRow,
  type FleetFoldPresence,
} from './fleet-roster';
import type { AgentAssignment, WorkListItem } from './assignments';
import type { PresenceTier1Joins } from '../agent-tools/coordination/presence-tier1';
import type { WakeabilitySignals } from '../agent-tools/coordination/presence-wakeability';
import type { AgentFleetRecord } from '../agent-fleets-store';
import { deriveVerdict } from '../agent-tools/coordination/liveness-oracle';

const findLiveHostMock = vi.hoisted(() => vi.fn());
vi.mock('../events/await/psu-pty-discovery', () => ({ findLiveHost: findLiveHostMock }));
beforeEach(() => findLiveHostMock.mockReset());

const NOW = Date.parse('2026-06-29T04:00:00Z');

function pres(p: Partial<FleetFoldPresence> & { ownerId: string }): FleetFoldPresence {
  return {
    ownerLabel: null,
    source: 'omp-hook-session',
    intent: '',
    currentPlanSlug: null,
    host: null,
    startedAt: null,
    heartbeatAt: null,
    lastActiveAt: null,
    agentRole: null,
    fleetSlug: null,
    fleetRole: null,
    userId: null,
    stale: false,
    ...p,
  };
}

const WI = (id: string, rank: number | null = null): WorkListItem => ({
  id,
  itemKind: 'feature',
  title: `work ${id}`,
  status: 'wip',
  rank,
  rankWriter: 'cup',
  activity: 'progressing',
});

function asg(p: Partial<AgentAssignment> & { agentId: string }): AgentAssignment {
  return {
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: null,
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: null,
    fleetRole: null,
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...p,
  };
}

const wake = (m: Record<string, Partial<WakeabilitySignals>>): Map<string, WakeabilitySignals> => {
  const out = new Map<string, WakeabilitySignals>();
  for (const [k, v] of Object.entries(m)) out.set(k, { wakeable: false, liveTurn: false, ...v });
  return out;
};

const tier1 = (m: Record<string, Partial<PresenceTier1Joins>>): Map<string, PresenceTier1Joins> => {
  const out = new Map<string, PresenceTier1Joins>();
  for (const [k, v] of Object.entries(m)) {
    out.set(k, {
      claimedItems: [],
      model: null,
      awaitingEvent: false,
      awaitingEventKey: null,
      awaitingNote: null,
      wakeMode: 'auto',
      ...v,
    });
  }
  return out;
};

// WI-5211 (P-301 follow-through): remote fleet members reach fleet:status via the
// federated session-presence fold — without it a cross-machine fleet rendered
// leader-only while its remote members worked.
describe('foldFederatedSessionPresence (WI-5211 — remote members in the fleet roster)', () => {
  const sessionRow = (p: Partial<FederatedSessionFoldRow> & { owner_id: string }): FederatedSessionFoldRow => ({
    kind: 'su',
    intent: 'working the plan',
    plan_slug: 'p-drill',
    github_user_id: 42,
    machine_label: 'mac-vm',
    last_seen_ms: NOW - 5_000,
    fleet_slug: 'atlas',
    fleet_role: 'member',
    ...p,
  });

  it('maps a remote session to a federated fold row carrying its fleet label', () => {
    const out = foldFederatedSessionPresence([], [sessionRow({ owner_id: 'su-remote-1' })], NOW);
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.ownerId).toBe('su-remote-1');
    expect(r.federated).toBe(true);
    expect(r.fleetSlug).toBe('atlas');
    expect(r.fleetRole).toBe('member');
    expect(r.host).toBe('mac-vm');
    expect(r.agentRole).toBe('su');
    expect(r.userId).toBe('42');
    expect(r.stale).toBe(false);
    // The federated row must survive the fleet filter — that is the whole point.
    expect(filterPresenceToFleet(out, 'atlas', false)).toHaveLength(1);
  });

  it('local rows WIN on ownerId collision (the announcer self-applies its own sessions)', () => {
    const local = [pres({ ownerId: 'su-local-1', fleetSlug: 'atlas', host: 'tower' })];
    const out = foldFederatedSessionPresence(
      local,
      [sessionRow({ owner_id: 'su-local-1', machine_label: 'tower' }), sessionRow({ owner_id: 'su-remote-1' })],
      NOW,
    );
    expect(out).toHaveLength(2);
    const localRow = out.find((r) => r.ownerId === 'su-local-1')!;
    expect(localRow.federated).toBeUndefined(); // the local row, untouched
    expect(localRow.host).toBe('tower');
    expect(out.find((r) => r.ownerId === 'su-remote-1')!.federated).toBe(true);
  });

  it('a remote member folds into the fleet roster as an alive presence-only entry', () => {
    const presence = foldFederatedSessionPresence(
      [pres({ ownerId: 'su-leader', fleetSlug: 'atlas', fleetRole: 'leader' })],
      [sessionRow({ owner_id: 'su-remote-1' })],
      NOW,
    );
    const entries = foldFleetRoster(filterPresenceToFleet(presence, 'atlas', false), [], tier1({}), NOW);
    const remote = entries.find((e) => e.agentId === 'su-remote-1')!;
    expect(remote).toBeDefined();
    expect(remote.federated).toBe(true);
    expect(remote.alive).toBe(true); // fresh heartbeat, no wakeability row → heartbeat-derived
    expect(remote.sessionState).toBeNull(); // state unknown at the federation boundary
  });

  it('an aged remote row folds as stale', () => {
    const out = foldFederatedSessionPresence(
      [],
      [sessionRow({ owner_id: 'su-remote-1', last_seen_ms: NOW - 3 * 60 * 60_000 })],
      NOW,
    );
    expect(out[0]!.stale).toBe(true);
  });
});

describe('filterPresenceToFleet', () => {
  const rows = [
    pres({ ownerId: 'a', fleetSlug: 'ui-fleet' }),
    pres({ ownerId: 'b', fleetSlug: 'api-fleet' }),
    pres({ ownerId: 'c', fleetSlug: null }), // in no fleet
  ];

  it('keeps exactly the fleet members (no unattributed by default)', () => {
    expect(filterPresenceToFleet(rows, 'ui-fleet', false).map((r) => r.ownerId)).toEqual(['a']);
  });

  it('includes NULL-fleet agents when includeUnattributed is true', () => {
    expect(filterPresenceToFleet(rows, 'ui-fleet', true).map((r) => r.ownerId)).toEqual(['a', 'c']);
  });

  it('never leaks another fleet', () => {
    expect(filterPresenceToFleet(rows, 'ui-fleet', true).some((r) => r.ownerId === 'b')).toBe(false);
  });
});

describe('oldestLiveFleetMember', () => {
  it('selects the oldest positively-live su member and ignores unknown or non-member rows', () => {
    expect(oldestLiveFleetMember([
      { agentId: 'su-newer', agentRole: 'su', fleetRole: 'member', sessionState: 'live', startedAt: '2026-10-02T10:00:00Z' },
      { agentId: 'su-oldest', agentRole: 'su', fleetRole: 'member', sessionState: 'live', startedAt: '2026-10-02T09:00:00Z' },
      { agentId: 'su-excluded', agentRole: 'su', fleetRole: 'member', sessionState: 'live', startedAt: '2026-10-02T08:00:00Z' },
      { agentId: 'su-unknown', agentRole: 'su', fleetRole: 'member', sessionState: null, startedAt: '2026-10-02T07:00:00Z' },
      { agentId: 'cup', agentRole: 'cup', fleetRole: 'member', sessionState: 'live', startedAt: '2026-10-02T06:00:00Z' },
    ], ['su-excluded'])).toBe('su-oldest');
  });
});

describe('livePsuFleetMemberIds (WI-4755)', () => {
  it('keeps only visible members with a live psu host', () => {
    const rows = [
      { ownerId: 'live', agentRole: 'su' },
      { ownerId: 'dead', agentRole: 'su' },
      { ownerId: 'cup', agentRole: 'cup' },
    ];
    expect(livePsuFleetMemberIds(rows, (id) => (id === 'live' ? {} : null))).toEqual(['live']);
  });

  it('does not treat a nursery cup as a desktop member even if a host-shaped value exists', () => {
    expect(livePsuFleetMemberIds([{ ownerId: 'cup', agentRole: 'cup' }], () => ({}))).toEqual([]);
  });
});

describe('foldFleetRoster', () => {
  it.each([
    { name: 'an old activity clock', signals: { lastActivityMs: NOW - 24 * 60 * 60_000 } },
    { name: 'a missed wake', signals: { wakeAttemptMiss: true } },
  ])('matches targeted presence for a verified native leader despite $name', ({ signals }) => {
    const p = pres({
      ownerId: 'su-native-leader',
      agentRole: 'su',
      fleetRole: 'leader',
      heartbeatAt: new Date(NOW - 5_000).toISOString(),
    });
    const w = { wakeable: true, liveTurn: false, ...signals };
    const assignment = asg({ agentId: p.ownerId, doing: WI('WI-held'), load: 1 });
    findLiveHostMock.mockReturnValue({ pid: 12345 });
    const targeted = deriveVerdict(
      { ...p, claimsHeld: true }, w, new Set(), NOW, () => null,
      { enabled: true, negative: false, positive: true, findHostFn: findLiveHostMock },
    );
    expect(targeted.sessionState).toBe('parked');
    const [member] = foldFleetRoster([p], [assignment], tier1({}), NOW, new Map([[p.ownerId, w]]));
    expect(member.sessionState).toBe(targeted.sessionState);
    expect(member.alive).toBe(true);
    expect(member.doing).toEqual(WI('WI-held'));

    findLiveHostMock.mockReturnValue(null);
    const [hostless] = foldFleetRoster([p], [assignment], tier1({}), NOW, new Map([[p.ownerId, w]]));
    expect(hostless.sessionState).toBe('suspect');
    expect(hostless.alive).toBe(false);
  });

  // P-011(a) / D-011 (EI-25695434826164414 class): a live host rescues a member to
  // `parked`, but a host that cannot take a turn must not be reported as parked.
  describe('host conditions (P-011)', () => {
    const p = pres({
      ownerId: 'su-host-member',
      agentRole: 'su',
      heartbeatAt: new Date(NOW - 5_000).toISOString(),
    });
    const w = { wakeable: true, liveTurn: false, wakeAttemptMiss: true };
    const hosts = new Map<string, unknown | null>([[p.ownerId, { pid: 12345 }]]);
    const fold = (conditions?: Map<string, 'auth-blocked' | null>, presence = p) =>
      foldFleetRoster(
        [presence], [asg({ agentId: presence.ownerId, load: 1 })], tier1({}), NOW,
        new Map([[presence.ownerId, w]]), new Set(), new Map(), new Set(), hosts, conditions,
      )[0];

    it('control: a healthy live host keeps the rescued parked state with wedged null', () => {
      const member = fold(new Map([[p.ownerId, null]]));
      expect(member.sessionState).toBe('parked');
      expect(member.alive).toBe(true);
      expect(member.wedged).toBeNull();
      // No judged map at all (leg degraded) is the same plain derivation.
      expect(fold(undefined).sessionState).toBe('parked');
    });

    it('a dead-auth live host reads suspect, not alive, with its class in wedged', () => {
      const member = fold(new Map([[p.ownerId, 'auth-blocked']]));
      expect(member.sessionState).toBe('suspect');
      expect(member.alive).toBe(false);
      expect(member.wedged).toBe('auth-blocked');
      expect(member.confirmLiveness).toBe(true);
    });

    it('never judges a cup by a host condition', () => {
      const cup = pres({ ownerId: 'cup-x', agentRole: 'cup', heartbeatAt: p.heartbeatAt });
      const member = foldFleetRoster(
        [cup], [asg({ agentId: cup.ownerId, load: 0 })], tier1({}), NOW,
        new Map([[cup.ownerId, { wakeable: true, liveTurn: false }]]), new Set(), new Map(), new Set(),
        new Map([[cup.ownerId, { pid: 1 }]]), new Map([[cup.ownerId, 'auth-blocked' as const]]),
      )[0];
      expect(member.wedged).toBeNull();
      expect(member.sessionState).not.toBe('suspect');
    });
  });

  it.each(['cup', null])('does not rescue an unverified native role %s', (agentRole) => {
    const p = pres({ ownerId: 'unverified-role', agentRole, heartbeatAt: new Date(NOW - 5_000).toISOString() });
    findLiveHostMock.mockReturnValue({ pid: 12345 });
    const [member] = foldFleetRoster(
      [p], [asg({ agentId: p.ownerId, load: 1 })], tier1({}), NOW,
      wake({ [p.ownerId]: { wakeable: true, wakeAttemptMiss: true } }),
    );
    expect(member.sessionState).toBe('suspect');
    expect(member.alive).toBe(false);
  });

  it.each([
    { load: 0, state: 'ended' },
    { load: 1, state: 'suspect' },
  ])('preserves confirmed session death with $load held claims despite a native host', ({ load, state }) => {
    const p = pres({ ownerId: 'ended-native', agentRole: 'su', heartbeatAt: new Date(NOW - 5_000).toISOString() });
    findLiveHostMock.mockReturnValue({ pid: 12345 });
    const [member] = foldFleetRoster(
      [p], [asg({ agentId: p.ownerId, load })], tier1({}), NOW,
      wake({ [p.ownerId]: { wakeable: true } }), new Set(), new Map(), new Set([p.ownerId]),
    );
    expect(member.sessionState).toBe(state);
    expect(member.alive).toBe(false);
  });

  it('preserves the work-detail and layers presence + fleet label + Tier-1 on top', () => {
    const a = asg({
      agentId: 'su-x',
      label: 'su · su-x',
      alive: true,
      heartbeatAt: '2026-06-29T03:59:00Z',
      doing: WI('WI-1', 0),
      queued: [WI('WI-1', 0), WI('WI-2', 1)],
      load: 2,
    });
    const p = pres({
      ownerId: 'su-x',
      ownerLabel: 'su · su-x',
      host: 'box1',
      agentRole: 'su',
      fleetSlug: 'ui-fleet',
      fleetRole: 'leader',
      lastActiveAt: '2026-06-29T03:59:30Z',
    });
    const [e] = foldFleetRoster([p], [a], tier1({ 'su-x': { claimedItems: ['P-006'], model: 'opus' } }), NOW);
    // work-detail preserved verbatim
    expect(e.doing).toEqual(WI('WI-1', 0));
    expect(e.load).toBe(2);
    // presence + fleet label attached
    expect(e.agentRole).toBe('su');
    expect(e.fleetSlug).toBe('ui-fleet');
    expect(e.fleetRole).toBe('leader');
    expect(e.host).toBe('box1');
    expect(e.lastActiveSecAgo).toBe(30);
    // Tier-1 attached
    expect(e.claimedItems).toEqual(['P-006']);
    expect(e.model).toBe('opus');
    expect(e.federated).toBe(false);
  });

  it('carries active-but-divergent intent evidence into the canonical roster', () => {
    const p = pres({
      ownerId: 'su-divergent',
      fleetSlug: 'f',
      lastActiveAt: new Date(NOW - 30_000).toISOString(),
      intentDeclaredAt: new Date(NOW - 1_901_000).toISOString(),
    });
    const [e] = foldFleetRoster(
      [p],
      [asg({ agentId: 'su-divergent', alive: true })],
      tier1({}),
      NOW,
      wake({ 'su-divergent': { wakeable: true, liveTurn: true } }),
    );
    expect(e.intentAgeSec).toBe(1_901);
    expect(e.lastActiveSecAgo).toBe(30);
    expect(e.intentStale).toBe(false);
    expect(e.intentDivergent).toBe(true);
  });

  it('marks a parked member intent stale immediately even when activity age is fresh', () => {
    const p = pres({
      ownerId: 'su-parked-intent',
      fleetSlug: 'f',
      lastActiveAt: new Date(NOW - 60_000).toISOString(),
      intentDeclaredAt: new Date(NOW - 120_000).toISOString(),
    });
    const [e] = foldFleetRoster(
      [p],
      [asg({ agentId: 'su-parked-intent', alive: true })],
      tier1({}),
      NOW,
      wake({ 'su-parked-intent': { wakeable: true, liveTurn: false } }),
    );
    expect(e.sessionState).toBe('parked');
    expect(e.intentStale).toBe(true);
    expect(e.intentDivergent).toBe(false);
  });

  // derived-status-not-hand-written-2026-10-12#D-006 (WI-6554700010009431): the
  // fleet roster reports a held work item as the intent exactly as coord:presence does.
  it('derives intent from a held work item when the declaration is empty, and strips the input', () => {
    const p = pres({ ownerId: 'su-held', intent: '' });
    const [e] = foldFleetRoster(
      [p],
      [],
      tier1({ 'su-held': { heldWorkIntent: { workItemId: 'WI-77', title: 'Fix the roster', planItemRef: 'plan-a#P-002' } } }),
      NOW,
    );
    expect(e.intent).toBe('Fix the roster (WI-77 · plan-a#P-002)');
    expect(e.intentSource).toBe('derived');
    expect(e.intentDerivedFrom).toEqual({ workItemId: 'WI-77', planItemRef: 'plan-a#P-002' });
    expect(e).not.toHaveProperty('heldWorkIntent');
  });

  it('keeps a fresh declared intent over a held work item, with no intentDerivedFrom', () => {
    const p = pres({ ownerId: 'su-decl', intent: 'auditing the gate', intentDeclaredAt: new Date(NOW - 60_000).toISOString() });
    const [e] = foldFleetRoster(
      [p],
      [],
      tier1({ 'su-decl': { heldWorkIntent: { workItemId: 'WI-78', title: 'Other work' } } }),
      NOW,
    );
    expect(e.intent).toBe('auditing the gate');
    expect(e.intentSource).toBe('declared');
    expect(e).not.toHaveProperty('intentDerivedFrom');
  });

  it('includes a presence-only idle member with empty work-detail + its fleet label', () => {
    const p = pres({ ownerId: 'su-idle', intent: 'thinking', fleetSlug: 'ui-fleet', fleetRole: 'member' });
    const [e] = foldFleetRoster([p], [], tier1({}), NOW);
    expect(e.agentId).toBe('su-idle');
    expect(e.doing).toBeNull();
    expect(e.fleetSlug).toBe('ui-fleet');
    expect(e.fleetRole).toBe('member');
    expect(e.intent).toBe('thinking');
    expect(e.claimedItems).toEqual([]); // EMPTY_TIER1 default
  });

  // EI-5858: fleet:status reported a stale `live` boolean that masked `ended`.
  it('gates `alive` to false + reports sessionState:ended for a warm-heartbeat but NOT-wakeable (dead) session', () => {
    // The reported repro: a session whose process ended but whose heartbeat is still
    // fresh within PRESENCE_STALE_MS. Presence/assignment liveness (heartbeat-only)
    // reads alive:true; wakeability says it is NOT wakeable → ended.
    const p = pres({ ownerId: 'su-dead', stale: false, fleetSlug: 'f' });
    const a = asg({ agentId: 'su-dead', alive: true, doing: WI('WI-9', 0), load: 1 });
    const [e] = foldFleetRoster([p], [a], tier1({}), NOW, wake({ 'su-dead': { wakeable: false } }));
    expect(e.sessionState).toBe('ended');
    expect(e.alive).toBe(false); // ← the fix: was `true` (masked the dead session)
  });

  it('reports sessionState live | parked and keeps alive for wakeable sessions', () => {
    const live = pres({ ownerId: 'su-live', stale: false, fleetSlug: 'f' });
    const parked = pres({ ownerId: 'su-parked', stale: false, fleetSlug: 'f' });
    const out = foldFleetRoster(
      [live, parked],
      [asg({ agentId: 'su-live', alive: true }), asg({ agentId: 'su-parked', alive: true })],
      tier1({}),
      NOW,
      wake({
        'su-live': { wakeable: true, liveTurn: true },
        'su-parked': { wakeable: true, liveTurn: false },
      }),
    );
    const byId = new Map(out.map((e) => [e.agentId, e]));
    expect(byId.get('su-live')?.sessionState).toBe('live');
    expect(byId.get('su-live')?.alive).toBe(true);
    expect(byId.get('su-parked')?.sessionState).toBe('parked');
    expect(byId.get('su-parked')?.alive).toBe(true);
  });

  // fleet-liveness-zombie-await-2026-07-07: a reboot-killed member leaves a live
  // wake-await (wakeable:true) but an hour-cold heartbeat. Pre-fix it read `parked`
  // and was COUNTED a live member (the invisible-dead-fleet bug the leader hit);
  // now the DEAD-ceiling backstop forces it to `ended`.
  it('classifies a wakeable-but-hour-cold member as ended (zombie await from an abrupt death)', () => {
    const p = pres({
      ownerId: 'su-zombie',
      stale: true,
      fleetSlug: 'f',
      fleetRole: 'member',
      agentRole: 'su',
      heartbeatAt: '2026-06-29T02:48:00Z', // 72 min before NOW — past the 30m DEAD ceiling
    });
    const [e] = foldFleetRoster([p], [], tier1({}), NOW, wake({ 'su-zombie': { wakeable: true, liveTurn: false } }));
    expect(e.sessionState).toBe('ended'); // was 'parked' pre-fix
    expect(e.alive).toBe(false);
    // fleet:status derives memberCount off the roster with sessionState==='ended'
    // filtered out — so a dead-but-wakeable member no longer inflates the live count.
    const live = [e].filter((m) => m.sessionState !== 'ended');
    expect(splitFleetRosterCounts(live)).toEqual({ members: 0, bees: 0 });
  });

  it('does NOT over-reach: a wakeable member cold < the DEAD ceiling stays parked', () => {
    // Same wakeable+idle shape, but the heartbeat is only ~15 min cold (stale, yet
    // inside the 30m ceiling) → still `parked` (a recently-parked, resumable session).
    const p = pres({
      ownerId: 'su-recent-park',
      stale: true,
      fleetSlug: 'f',
      heartbeatAt: '2026-06-29T03:45:00Z', // 15 min before NOW
    });
    const [e] = foldFleetRoster([p], [], tier1({}), NOW, wake({ 'su-recent-park': { wakeable: true, liveTurn: false } }));
    // The distinguishing signal is sessionState (parked, resumable — NOT ended);
    // `alive` is heartbeat-derived and already false for any stale row.
    expect(e.sessionState).toBe('draining');
    expect(e.alive).toBe(false);
  });

  it('leaves alive heartbeat-derived + sessionState null when wakeability is absent (federated/unknown)', () => {
    // No wakeability entry (a federated peer, or the read was unavailable) → behavior
    // unchanged: alive stays heartbeat-derived and sessionState is null (state unknown).
    const p = pres({ ownerId: 'fed:peer', stale: false, fleetSlug: 'f', federated: true });
    const [e] = foldFleetRoster([p], [asg({ agentId: 'fed:peer', alive: true })], tier1({}), NOW, wake({}));
    expect(e.sessionState).toBeNull();
    expect(e.alive).toBe(true);
  });

  it('sorts live first, then orphan-holders, then newest heartbeat', () => {
    const out = foldFleetRoster(
      [
        pres({ ownerId: 'stale-old', stale: true, heartbeatAt: '2026-06-29T01:00:00Z', fleetSlug: 'f' }),
        pres({ ownerId: 'live', stale: false, heartbeatAt: '2026-06-29T03:00:00Z', fleetSlug: 'f' }),
        pres({ ownerId: 'stale-new', stale: true, heartbeatAt: '2026-06-29T03:30:00Z', fleetSlug: 'f' }),
      ],
      [asg({ agentId: 'stale-old', alive: false, orphaned: true })],
      tier1({}),
      NOW,
    );
    expect(out.map((e) => e.agentId)).toEqual(['live', 'stale-old', 'stale-new']);
  });
});

describe('annotateFleetsWithCounts (available = >=1 live member)', () => {
  const fleet = (slug: string): AgentFleetRecord => ({
    workspaceId: 'ws',
    fleetSlug: slug,
    title: slug,
    description: null,
    owner: 'su-x',
    leaderOwnerId: 'su-x',
    colorScheme: null,
    createdAt: 1,
    updatedAt: 1,
  });

  it('annotates each persisted fleet with its live member/bee counts (0 when none)', () => {
    const out = annotateFleetsWithCounts(
      [fleet('ui-fleet'), fleet('api-fleet'), fleet('bee-only-fleet')],
      new Map([
        ['ui-fleet', { members: 3, bees: 0 }],
        // WI-1764 #4: a fleet with 0 members but live bees — the substrate mismatch.
        ['bee-only-fleet', { members: 0, bees: 2 }],
      ]),
    );
    expect(out.map((f) => [f.fleetSlug, f.liveMemberCount, f.beeCount])).toEqual([
      ['ui-fleet', 3, 0],
      ['api-fleet', 0, 0],
      ['bee-only-fleet', 0, 2],
    ]);
    // the durable registry row survives with zero live members (D-003) — still listed.
    expect(out.find((f) => f.fleetSlug === 'api-fleet')?.liveMemberCount).toBe(0);
    // the mismatch tell: 0 members yet 2 background bees grouped into the fleet.
    const beeOnly = out.find((f) => f.fleetSlug === 'bee-only-fleet');
    expect(beeOnly?.liveMemberCount).toBe(0);
    expect(beeOnly?.beeCount).toBe(2);
  });
});

describe('isBeeRole / splitFleetRosterCounts (WI-1764 #4 member-vs-bee split)', () => {
  it('isBeeRole is true only for the background-nursery bee role', () => {
    expect(isBeeRole('cup')).toBe(true);
    expect(isBeeRole('su')).toBe(false);
    expect(isBeeRole('human')).toBe(false);
    expect(isBeeRole(null)).toBe(false);
    expect(isBeeRole(undefined)).toBe(false);
  });

  it('splits a roster into visible desktop members vs background bees', () => {
    const counts = splitFleetRosterCounts([
      { agentRole: 'su' },
      { agentRole: 'su' },
      { agentRole: 'cup' },
      { agentRole: null }, // unlabeled → counts as a member, not a bee
    ]);
    expect(counts).toEqual({ members: 3, bees: 1 });
  });

  it('an all-bee roster reports 0 members (the substrate mismatch)', () => {
    expect(splitFleetRosterCounts([{ agentRole: 'cup' }, { agentRole: 'cup' }])).toEqual({
      members: 0,
      bees: 2,
    });
  });

  it('an empty roster is 0/0', () => {
    expect(splitFleetRosterCounts([])).toEqual({ members: 0, bees: 0 });
  });

  it('does not count a recorded session as a live launch member', () => {
    expect(isLaunchLiveSessionState('live')).toBe(true);
    expect(isLaunchLiveSessionState('parked')).toBe(true);
    expect(isLaunchLiveSessionState('draining')).toBe(true);
    expect(isLaunchLiveSessionState('recorded')).toBe(false);
    expect(isLaunchLiveSessionState('ended')).toBe(false);
    expect(isLaunchLiveSessionState('suspect')).toBe(false);
    expect(isLaunchLiveSessionState(null)).toBe(false);
  });

  // EI-21428116455038454: a non-caller LEADER (leader:'spawn' / delegator top-up)
  // occupied a member seat in the launch deficit, so a drained 1-executor fleet
  // could never be topped back up with count:1 (relaunchSuppressed forever). The
  // call-site `id !== ownerId` filter only removes the CALLER; the role filter is
  // what removes every non-caller supervisor.
  it('a leader or delegator never occupies a launch member seat', () => {
    expect(occupiesLaunchMemberSeat('leader')).toBe(false);
    expect(occupiesLaunchMemberSeat('delegator')).toBe(false);
    expect(occupiesLaunchMemberSeat('member')).toBe(true);
  });

  it('an unknown/absent fleet role still counts (fail toward suppression, never extra terminals)', () => {
    expect(occupiesLaunchMemberSeat(null)).toBe(true);
    expect(occupiesLaunchMemberSeat(undefined)).toBe(true);
    expect(occupiesLaunchMemberSeat('')).toBe(true);
  });
});
