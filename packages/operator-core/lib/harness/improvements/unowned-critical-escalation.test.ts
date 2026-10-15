/**
 * unowned-critical-escalation.test.ts (WI-5213) — pure detection + claim-spec
 * routing, no PG/DI ceremony (mirrors the watchdog collector test pattern).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNOWNED_CRITICAL_AGE_HOURS,
  unownedAgedCriticals,
  unownedCriticalsMatchingFleetSpec,
  unownedInFlightOrphans,
  unownedInFlightOrphansMatchingFleetSpec,
  partitionUnownedCriticalsByOrigin,
} from './unowned-critical-escalation';
import type { ClaimSpec } from '../../scheduler/claim-spec';
import type { WorkItem } from '../../work-items';

const NOW = Date.parse('2026-07-17T12:00:00.000Z');

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-1',
    kind: 'bug',
    family: 'issue',
    harness: 'papercusp',
    title: 'Something bad',
    summary: '',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'critical',
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    createdAt: new Date(NOW - 8 * 3_600_000).toISOString(), // 8h old by default
    updatedAt: new Date(NOW - 8 * 3_600_000).toISOString(),
    closedAt: null,
    goalId: null,
    ...overrides,
  };
}

describe('unownedAgedCriticals (pure)', () => {
  it('admits an unassigned open critical aged past the default 4h bar', () => {
    const out = unownedAgedCriticals([item()], { nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'WI-1', kind: 'bug', harness: 'papercusp' });
    expect(out[0]!.ageHours).toBeCloseTo(8, 1);
  });

  it('EI-13306 repro: an 8h-orphaned critical clears the default bar', () => {
    expect(DEFAULT_UNOWNED_CRITICAL_AGE_HOURS).toBe(4);
    const out = unownedAgedCriticals(
      [item({ id: 'EI-13306', title: 'claim-spec NULL-poisoning', createdAt: new Date(NOW - 8 * 3_600_000).toISOString() })],
      { nowMs: NOW },
    );
    expect(out.map((c) => c.id)).toEqual(['EI-13306']);
  });

  it('excludes an item younger than the age bar', () => {
    const out = unownedAgedCriticals([item({ createdAt: new Date(NOW - 1 * 3_600_000).toISOString() })], { nowMs: NOW });
    expect(out).toHaveLength(0);
  });

  it('excludes an already-assigned item — the whole point is UNOWNED', () => {
    const out = unownedAgedCriticals([item({ assignee: 'su-someone' })], { nowMs: NOW });
    expect(out).toHaveLength(0);
  });

  it('excludes a non-critical severity', () => {
    const out = unownedAgedCriticals([item({ severity: 'major' })], { nowMs: NOW });
    expect(out).toHaveLength(0);
  });

  it('excludes a non-open state (already resolved/closed)', () => {
    const out = unownedAgedCriticals([item({ state: 'resolved' })], { nowMs: NOW });
    expect(out).toHaveLength(0);
  });

  it('excludes an item with an unparseable createdAt (fails closed, never a phantom escalation)', () => {
    const out = unownedAgedCriticals([item({ createdAt: 'not-a-date' })], { nowMs: NOW });
    expect(out).toHaveLength(0);
  });

  it('respects a custom ageHours bar', () => {
    const twoHoursOld = item({ createdAt: new Date(NOW - 2 * 3_600_000).toISOString() });
    expect(unownedAgedCriticals([twoHoursOld], { nowMs: NOW, ageHours: 4 })).toHaveLength(0);
    expect(unownedAgedCriticals([twoHoursOld], { nowMs: NOW, ageHours: 1 })).toHaveLength(1);
  });
});

describe('unownedCriticalsMatchingFleetSpec (WI-5213 routing rule)', () => {
  const defaultSpec: ClaimSpec = {
    specVersion: '1.0',
    specId: 'default-fixed-ordering',
    revision: 0,
    view: {},
    rank: { mode: 'lexicographic', terms: [] },
  };

  it('the DEFAULT (empty-filter) spec admits every unowned aged critical', () => {
    const out = unownedCriticalsMatchingFleetSpec([item()], defaultSpec, { nowMs: NOW });
    expect(out.map((c) => c.id)).toEqual(['WI-1']);
  });

  it('a spec that excludes the item\'s kind does NOT admit it', () => {
    const spec: ClaimSpec = {
      ...defaultSpec,
      view: { filter: { field: 'kind', op: 'in', value: ['task'] } },
    };
    const out = unownedCriticalsMatchingFleetSpec([item({ kind: 'bug' })], spec, { nowMs: NOW });
    expect(out).toHaveLength(0);
  });

  it('a title-glob exclude (the backlog-drain-clean pattern) fences the matching item out', () => {
    const spec: ClaimSpec = {
      ...defaultSpec,
      view: { filter: { not: { field: 'title', op: 'glob', value: '*federation*' } } },
    };
    const admitted = unownedCriticalsMatchingFleetSpec(
      [item({ id: 'WI-federated', title: 'live-federation-gate RED' })],
      spec,
      { nowMs: NOW },
    );
    expect(admitted).toHaveLength(0);
    const other = unownedCriticalsMatchingFleetSpec(
      [item({ id: 'WI-other', title: 'unrelated critical bug' })],
      spec,
      { nowMs: NOW },
    );
    expect(other.map((c) => c.id)).toEqual(['WI-other']);
  });

  it('a spec that matches by kind still respects the age bar (routing does not bypass detection)', () => {
    const spec: ClaimSpec = { ...defaultSpec, view: { filter: { field: 'kind', op: 'in', value: ['bug'] } } };
    const young = item({ createdAt: new Date(NOW - 1 * 3_600_000).toISOString() });
    expect(unownedCriticalsMatchingFleetSpec([young], spec, { nowMs: NOW })).toHaveLength(0);
  });
});

// EI-18693470222331709 recurrence guard: an item with a checkpoint/progress
// signal + NULL assignee must surface as orphaned-in-flight — exactly the
// regression (WI-6006 sat unassigned 23 minutes, the sole blocker on the plan's
// closing item, with nothing flagging it) that cost this fleet real time.
describe('unownedInFlightOrphans (pure, EI-18693470222331709)', () => {
  it('WI-6006 repro: an unassigned open item with real progress recorded is flagged', () => {
    const out = unownedInFlightOrphans(
      [item({ id: 'WI-6006', kind: 'task', lastProgressAt: new Date(NOW - 23 * 60_000).toISOString() })],
      { nowMs: NOW },
    );
    expect(out.map((c) => c.id)).toEqual(['WI-6006']);
    expect(out[0]!.minutesSinceProgress).toBeCloseTo(23, 0);
  });

  it('excludes an item with no progress ever recorded — never started, not orphaned', () => {
    const out = unownedInFlightOrphans([item({ lastProgressAt: null })], { nowMs: NOW });
    expect(out).toHaveLength(0);
  });

  it('excludes a currently-claimed item — a live re-dispatch is not an orphan', () => {
    const out = unownedInFlightOrphans(
      [item({ assignee: 'su-someone', lastProgressAt: new Date(NOW - 5 * 60_000).toISOString() })],
      { nowMs: NOW },
    );
    expect(out).toHaveLength(0);
  });

  it('excludes a non-open state (already resolved/closed)', () => {
    const out = unownedInFlightOrphans(
      [item({ state: 'resolved', lastProgressAt: new Date(NOW - 5 * 60_000).toISOString() })],
      { nowMs: NOW },
    );
    expect(out).toHaveLength(0);
  });

  it('excludes an item with an unparseable lastProgressAt (fails closed)', () => {
    const out = unownedInFlightOrphans([item({ lastProgressAt: 'not-a-date' })], { nowMs: NOW });
    expect(out).toHaveLength(0);
  });

  it('is NOT age-gated by default — a 1-minute-old orphan is flagged immediately', () => {
    const out = unownedInFlightOrphans(
      [item({ lastProgressAt: new Date(NOW - 1 * 60_000).toISOString() })],
      { nowMs: NOW },
    );
    expect(out).toHaveLength(1);
  });

  it('respects an explicit minAgeMinutes grace window when passed', () => {
    const fiveMinOld = item({ lastProgressAt: new Date(NOW - 5 * 60_000).toISOString() });
    expect(unownedInFlightOrphans([fiveMinOld], { nowMs: NOW, minAgeMinutes: 10 })).toHaveLength(0);
    expect(unownedInFlightOrphans([fiveMinOld], { nowMs: NOW, minAgeMinutes: 1 })).toHaveLength(1);
  });
});

// WI-6846: a leader-brief reading unownedCriticals cannot act on origin:'remote'
// rows from this node (cannot claim — already excluded from self-select; cannot
// close — work_items:set_state refuses remote-authored mutation locally). These
// pin the field carrying that provenance through, and the partition that
// separates what a leader can actually act on from what it cannot.
describe('unownedAgedCriticals carries origin (WI-6846)', () => {
  it('reports origin:\'local\' for a locally-authored item', () => {
    const out = unownedAgedCriticals([item({ origin: 'local' })], { nowMs: NOW });
    expect(out[0]!.origin).toBe('local');
  });

  it('reports origin:\'remote\' for a remote-authored item', () => {
    const out = unownedAgedCriticals([item({ origin: 'remote' })], { nowMs: NOW });
    expect(out[0]!.origin).toBe('remote');
  });

  it('defaults a null/unset origin to \'local\' — never silently drops it from the actionable bucket', () => {
    const out = unownedAgedCriticals([item({ origin: null })], { nowMs: NOW });
    expect(out[0]!.origin).toBe('local');
  });
});

describe('partitionUnownedCriticalsByOrigin (WI-6846)', () => {
  it('splits local-origin into actionable and remote-origin into federatedUnresolvable', () => {
    const candidates = unownedAgedCriticals(
      [
        item({ id: 'WI-local-1', origin: 'local' }),
        item({ id: 'WI-remote-1', origin: 'remote' }),
        item({ id: 'WI-remote-2', origin: 'remote' }),
      ],
      { nowMs: NOW },
    );
    const { actionable, federatedUnresolvable } = partitionUnownedCriticalsByOrigin(candidates);
    expect(actionable.map((c) => c.id)).toEqual(['WI-local-1']);
    expect(federatedUnresolvable.map((c) => c.id)).toEqual(['WI-remote-1', 'WI-remote-2']);
  });

  it('an all-remote backlog partitions to zero actionable — the exact WI-6846 repro (26 of 43 remote)', () => {
    const candidates = unownedAgedCriticals(
      [item({ id: 'EI-a', origin: 'remote' }), item({ id: 'EI-b', origin: 'remote' })],
      { nowMs: NOW },
    );
    const { actionable, federatedUnresolvable } = partitionUnownedCriticalsByOrigin(candidates);
    expect(actionable).toHaveLength(0);
    expect(federatedUnresolvable).toHaveLength(2);
  });

  it('an empty list partitions to two empty buckets', () => {
    const { actionable, federatedUnresolvable } = partitionUnownedCriticalsByOrigin([]);
    expect(actionable).toEqual([]);
    expect(federatedUnresolvable).toEqual([]);
  });

  it('WI-10006515: an own-node row stranded at origin=remote is actionable, not federated', () => {
    const [own, peer] = unownedAgedCriticals(
      [item({ id: 'EI-own', origin: 'remote' }), item({ id: 'EI-peer', origin: 'remote' })],
      { nowMs: NOW },
    );
    const { actionable, federatedUnresolvable } = partitionUnownedCriticalsByOrigin([{ ...own!, ownNode: true }, peer!]);
    expect(actionable.map((c) => c.id)).toEqual(['EI-own']);
    expect(federatedUnresolvable.map((c) => c.id)).toEqual(['EI-peer']);
  });
});

describe('unownedInFlightOrphansMatchingFleetSpec (routing, EI-18693470222331709)', () => {
  const defaultSpec: ClaimSpec = {
    specVersion: '1.0',
    specId: 'default-fixed-ordering',
    revision: 0,
    view: {},
    rank: { mode: 'lexicographic', terms: [] },
  };

  it('the DEFAULT (empty-filter) spec admits every orphaned in-flight item', () => {
    const out = unownedInFlightOrphansMatchingFleetSpec(
      [item({ id: 'WI-6006', lastProgressAt: new Date(NOW - 23 * 60_000).toISOString() })],
      defaultSpec,
      { nowMs: NOW },
    );
    expect(out.map((c) => c.id)).toEqual(['WI-6006']);
  });

  it('a spec that excludes the item\'s kind does NOT admit it — a leader only sees its own fleet\'s orphans', () => {
    const spec: ClaimSpec = { ...defaultSpec, view: { filter: { field: 'kind', op: 'in', value: ['task'] } } };
    const out = unownedInFlightOrphansMatchingFleetSpec(
      [item({ kind: 'bug', lastProgressAt: new Date(NOW - 23 * 60_000).toISOString() })],
      spec,
      { nowMs: NOW },
    );
    expect(out).toHaveLength(0);
  });
});
