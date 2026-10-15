/**
 * hive-roster — presence-v2 Phase 3 fold (P-006/P-015). Pure tests: the merge +
 * hive-filter assert the fold preserves the fleet {doing,queued,load,orphaned}
 * shape and layers presence + Tier-1 on top, with no PG.
 */
import { describe, it, expect } from 'vitest';
import {
  filterPresenceToHive,
  foldHiveRoster,
  toRosterSnapshot,
  renderRosterSnapshot,
  type FoldPresence,
  type RosterSnapshotLine,
} from './hive-roster';
import type { AgentAssignment, WorkListItem } from './assignments';
import type { PresenceTier1Joins } from '../agent-tools/coordination/presence-tier1';

const NOW = Date.parse('2026-06-14T04:00:00Z');

function pres(p: Partial<FoldPresence> & { ownerId: string }): FoldPresence {
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
    potSlug: null,
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

describe('filterPresenceToHive', () => {
  const rows = [
    pres({ ownerId: 'a', potSlug: 'papercup' }),
    pres({ ownerId: 'b', potSlug: 'other' }),
    pres({ ownerId: 'c', potSlug: null }), // SU / standalone
  ];

  it('keeps the matching hive and (by default) NULL-hive standalone agents', () => {
    expect(filterPresenceToHive(rows, 'papercup', true).map((r) => r.ownerId)).toEqual(['a', 'c']);
  });

  it('drops NULL-hive agents when includeUnattributed is false', () => {
    expect(filterPresenceToHive(rows, 'papercup', false).map((r) => r.ownerId)).toEqual(['a']);
  });

  it('never leaks another hive', () => {
    expect(filterPresenceToHive(rows, 'papercup', true).some((r) => r.ownerId === 'b')).toBe(false);
  });
});

describe('foldHiveRoster', () => {
  it('preserves the fleet work-detail and layers presence + Tier-1 on top', () => {
    const a = asg({
      agentId: 'su-x',
      label: 'su · su-x',
      alive: true,
      heartbeatAt: '2026-06-14T03:59:00Z',
      doing: WI('WI-1', 0),
      queued: [WI('WI-1', 0), WI('WI-2', 1)],
      load: 2,
      orphaned: false,
      claims: [{ type: 'work-item', harnessSlug: 'h', planSlug: null, id: 'WI-1', itemKind: 'feature', detail: 'd', status: 'wip', acquiredTs: null, expiresTs: null, active: true, orphaned: false, stalled: false, lastProgressAt: null, activity: 'progressing', rank: 0, rankWriter: 'cup' }],
    });
    const p = pres({
      ownerId: 'su-x',
      ownerLabel: 'su · su-x',
      host: 'box1',
      agentRole: 'su',
      potSlug: 'papercup',
      lastActiveAt: '2026-06-14T03:59:30Z',
    });
    const [e] = foldHiveRoster([p], [a], tier1({ 'su-x': { claimedItems: ['P-006'], model: 'opus', awaitingEvent: true, awaitingEventKey: 'release:green' } }), NOW);
    // work-detail preserved verbatim
    expect(e.doing).toEqual(WI('WI-1', 0));
    expect(e.queued).toHaveLength(2);
    expect(e.load).toBe(2);
    expect(e.orphaned).toBe(false);
    expect(e.claims).toHaveLength(1);
    // presence + mig-277 scalars attached
    expect(e.agentRole).toBe('su');
    expect(e.potSlug).toBe('papercup');
    expect(e.host).toBe('box1');
    expect(e.lastActiveSecAgo).toBe(30); // 04:00:00 − 03:59:30
    // Tier-1 attached
    expect(e.claimedItems).toEqual(['P-006']);
    expect(e.model).toBe('opus');
    expect(e.awaitingEvent).toBe(true);
    expect(e.awaitingEventKey).toBe('release:green');
    expect(e.federated).toBe(false);
  });

  it('includes a presence-only idle agent (no assignment) with empty work-detail', () => {
    const p = pres({ ownerId: 'su-idle', ownerLabel: 'su · idle', stale: false, intent: 'thinking' });
    const [e] = foldHiveRoster([p], [], tier1({}), NOW);
    expect(e.agentId).toBe('su-idle');
    expect(e.doing).toBeNull();
    expect(e.load).toBe(0);
    expect(e.alive).toBe(true); // from !stale
    expect(e.intent).toBe('thinking');
    expect(e.claimedItems).toEqual([]); // EMPTY_TIER1 default
  });

  it('folds a federated peer (presence-only) with the federated flag, no Tier-1', () => {
    const p = pres({ ownerId: 'fed:99@boxZ', ownerLabel: 'gh:99 · boxZ', potSlug: 'papercup', federated: true });
    const [e] = foldHiveRoster([p], [], tier1({}), NOW);
    expect(e.federated).toBe(true);
    expect(e.ownerLabel).toBe('gh:99 · boxZ');
    expect(e.lastActiveSecAgo).toBeNull();
    expect(e.model).toBeNull();
  });

  // WI-1495: machineLabel is what lets a roster consumer group agents into
  // per-machine tabs and count "across N machines". Three branches, because the
  // interesting one (a federated peer that announced NO label) is the case that
  // would otherwise silently inherit THIS host's name and misreport a remote
  // agent as local.
  it('stamps a LOCAL agent with the injected machine label', () => {
    const p = pres({ ownerId: 'su-local', potSlug: 'papercup' });
    const [e] = foldHiveRoster([p], [], tier1({}), NOW, undefined, undefined, 'box-here');
    expect(e.federated).toBe(false);
    expect(e.machineLabel).toBe('box-here');
  });

  it("prefers a FEDERATED peer's announced machine label over the local one", () => {
    const p = pres({ ownerId: 'fed:99@boxZ', potSlug: 'papercup', federated: true, machineLabel: 'boxZ' });
    const [e] = foldHiveRoster([p], [], tier1({}), NOW, undefined, undefined, 'box-here');
    expect(e.federated).toBe(true);
    expect(e.machineLabel).toBe('boxZ');
  });

  it('leaves a federated peer that announced NO label null — never inherits this host name', () => {
    const p = pres({ ownerId: 'fed:99@?', potSlug: 'papercup', federated: true });
    const [e] = foldHiveRoster([p], [], tier1({}), NOW, undefined, undefined, 'box-here');
    expect(e.federated).toBe(true);
    expect(e.machineLabel).toBeNull();
  });

  // derived-status-not-hand-written-2026-10-12#D-006 (WI-6554700010009431): the
  // hive roster reports a held work item as the intent exactly as coord:presence does.
  it('derives intent from a held work item when the declaration is stale, and strips the input', () => {
    const p = pres({ ownerId: 'su-held', intent: 'old plan', intentDeclaredAt: new Date(NOW - 6 * 3600_000).toISOString() });
    const [e] = foldHiveRoster(
      [p],
      [],
      tier1({ 'su-held': { heldWorkIntent: { workItemId: 'WI-77', title: 'Fix the roster' } } }),
      NOW,
    );
    expect(e.intent).toBe('Fix the roster (WI-77)');
    expect(e.intentSource).toBe('derived');
    expect(e.intentDerivedFrom).toEqual({ workItemId: 'WI-77' });
    expect(e).not.toHaveProperty('heldWorkIntent');
  });

  it('keeps the declared intent when nothing is held, with no intentDerivedFrom', () => {
    const [e] = foldHiveRoster([pres({ ownerId: 'su-decl', intent: 'reviewing PRs' })], [], tier1({}), NOW);
    expect(e.intent).toBe('reviewing PRs');
    expect(e.intentSource).toBe('declared');
    expect(e).not.toHaveProperty('intentDerivedFrom');
  });

  it('defaults machineLabel to null when no local label is injected (pre-WI-1495 callers unchanged)', () => {
    const [e] = foldHiveRoster([pres({ ownerId: 'su-x' })], [], tier1({}), NOW);
    expect(e.machineLabel).toBeNull();
  });

  it('keeps an assignment-only orphan (claim whose holder has no presence row)', () => {
    const a = asg({ agentId: 'su-gone', alive: false, orphaned: true, load: 1, doing: WI('WI-9') });
    const [e] = foldHiveRoster([], [a], tier1({}), NOW);
    expect(e.orphaned).toBe(true);
    expect(e.doing).toEqual(WI('WI-9'));
    expect(e.agentRole).toBeNull(); // no presence row
    expect(e.federated).toBe(false);
  });

  it('sorts live first, then orphan-holders, then newest heartbeat', () => {
    const out = foldHiveRoster(
      [
        pres({ ownerId: 'stale-old', stale: true, heartbeatAt: '2026-06-14T01:00:00Z' }),
        pres({ ownerId: 'live', stale: false, heartbeatAt: '2026-06-14T03:00:00Z' }),
        pres({ ownerId: 'stale-new', stale: true, heartbeatAt: '2026-06-14T03:30:00Z' }),
      ],
      [asg({ agentId: 'stale-old', alive: false, orphaned: true })],
      tier1({}),
      NOW,
    );
    // live first; among stale, orphan-holder (stale-old) before non-orphan (stale-new)
    expect(out.map((e) => e.agentId)).toEqual(['live', 'stale-old', 'stale-new']);
  });
});

describe('toRosterSnapshot (the lean dossier shape — directed-wake P-021 seam)', () => {
  it('projects to one-line-per-agent scalars, dropping the heavy arrays', () => {
    const entries = foldHiveRoster(
      [pres({ ownerId: 'su-x', ownerLabel: 'su · su-x', agentRole: 'su', potSlug: 'papercup', lastActiveAt: '2026-06-14T03:59:00Z' })],
      [asg({ agentId: 'su-x', alive: true, doing: WI('WI-1', 0), queued: [WI('WI-1', 0), WI('WI-2', 1)], load: 2 })],
      tier1({ 'su-x': { claimedItems: ['P-006'], awaitingEvent: true } }),
      NOW,
    );
    const [line] = toRosterSnapshot(entries);
    expect(line).toEqual({
      ownerId: 'su-x',
      label: 'su · su-x',
      agentRole: 'su',
      alive: true,
      lastActiveSecAgo: 60,
      doing: 'WI-1', // doing.id only, not the full WorkListItem
      load: 2,
      claimedItems: ['P-006'],
      awaitingEvent: true,
      federated: false,
    });
    // the heavy arrays are NOT in the lean line
    expect('queued' in line).toBe(false);
    expect('claims' in line).toBe(false);
  });

  it('renders an idle agent as doing:null', () => {
    const entries = foldHiveRoster([pres({ ownerId: 'su-idle' })], [], tier1({}), NOW);
    expect(toRosterSnapshot(entries)[0].doing).toBeNull();
  });
});

describe('renderRosterSnapshot (the `### Hive peers` body — directed-wake P-021 seam)', () => {
  function line(p: Partial<RosterSnapshotLine> & { ownerId: string }): RosterSnapshotLine {
    return {
      label: null,
      agentRole: null,
      alive: true,
      lastActiveSecAgo: null,
      doing: null,
      load: 0,
      claimedItems: [],
      awaitingEvent: false,
      federated: false,
      ...p,
    };
  }

  it('returns empty string for an empty roster (so the seam omits the section)', () => {
    expect(renderRosterSnapshot([])).toBe('');
  });

  it('renders one compact bullet per peer with role + state + age', () => {
    const out = renderRosterSnapshot([
      line({ ownerId: 'su-x', label: 'su · su-x', agentRole: 'worker', doing: 'WI-1', lastActiveSecAgo: 120 }),
    ]);
    expect(out).toBe('- su · su-x (su-x) worker — on WI-1 · active 2m ago');
  });

  it('distinguishes offline / awaiting / idle states', () => {
    const out = renderRosterSnapshot([
      line({ ownerId: 'a', alive: false }),
      line({ ownerId: 'b', awaitingEvent: true, lastActiveSecAgo: 5 }),
      line({ ownerId: 'c', lastActiveSecAgo: 30 }),
    ]);
    // alive peers rank ahead of offline; among alive, most-recently-active first.
    expect(out).toBe(
      ['- b — awaiting · active 5s ago', '- c — idle · active 30s ago', '- a — offline'].join('\n'),
    );
  });

  it('caps to maxPeers and marks the omitted tail (no silent cap)', () => {
    const lines = Array.from({ length: 5 }, (_, i) => line({ ownerId: `p${i}`, lastActiveSecAgo: i }));
    const out = renderRosterSnapshot(lines, 3);
    const rows = out.split('\n');
    expect(rows).toHaveLength(4); // 3 peers + the "+N more" marker
    expect(rows[3]).toBe('- …+2 more peer(s)');
  });
});
