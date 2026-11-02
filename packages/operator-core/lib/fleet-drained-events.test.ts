/**
 * fleet-drained-events.test — the fleet-drain signal through the await primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-105 deferred tail; WI-1830).
 *
 * Pure drain arithmetic + injected-emit / injected-assignments seams, so the whole
 * detector unit-tests without PG (session-compacted-events / plan-item-events discipline).
 */
import { describe, expect, it, vi } from 'vitest';
import type { FleetAssignmentRow } from './fleet/assignments';
import type { FleetLaneHealth } from './fleet/lane-health';
import type { FleetScopeTerminalExhaustion } from './scheduler/fleet-scope-admission';
import {
  isTerminalItemStatus,
  countOpenItems,
  isPlanDrained,
  emitFleetDrainedEvent,
  drainedFleetsForPlan,
  emitFleetDrainedForPlan,
} from './fleet-drained-events';

type EmitOpts = { key: string; summary?: string; payload?: unknown; to?: string[]; source?: string };
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0 }));

function laneHealth(claimable: number | null): FleetLaneHealth {
  return {
    claimable: claimable ?? 0,
    matchedByFilter: claimable ?? 0,
    excluded: {},
    issueFamily: { claimable: claimable ?? 0, matchedByFilter: claimable ?? 0, excluded: {} },
    featureFamily: null,
    effective: { claimable, matchedByFilter: claimable, excluded: {}, basis: 'issue-family' },
    familyReachability: { issue: true, feature: false },
    spec: {
      ref: 'bugs@7',
      specId: 'bugs',
      revision: 7,
      matchedBy: 'fleet-slug',
      harness: 'papercusp',
      assigneeScoped: null,
    },
  };
}

const zeroLane = () => vi.fn(async () => laneHealth(0));
const terminalPopulation = (
  matchedByFilter: number,
  terminalMatchedByFilter: number,
  inFlightMatchedByFilter = 0,
  parkedMatchedByFilter = 0,
) => vi.fn(async (): Promise<FleetScopeTerminalExhaustion | null> => ({
  matchedByFilter,
  terminalMatchedByFilter,
  inFlightMatchedByFilter,
  parkedMatchedByFilter,
}));

/** A fleet_assignment row with every field defaulted; override only what a case needs. */
function row(p: Partial<FleetAssignmentRow>): FleetAssignmentRow {
  return {
    source: 'presence',
    workspaceId: 'w',
    agentId: null,
    agentLabel: null,
    agentName: null,
    harnessSlug: null,
    planSlug: null,
    itemId: null,
    workItemId: null,
    itemKind: null,
    detail: '',
    status: null,
    claimAcquiredTs: null,
    claimExpiresTs: null,
    claimActive: null,
    livenessMode: null,
    lastActivityTs: null,
    holderPresent: false,
    holderAlive: false,
    holderHeartbeatAt: null,
    holderIntent: null,
    holderPlanSlug: null,
    orphaned: false,
    stalled: null,
    lastProgressAt: null,
    declaredPlanMatches: null,
    assigneeRank: null,
    rankWriter: null,
    fleetSlug: null,
    fleetRole: null,
    ...p,
  };
}

const items = (...statuses: string[]) => statuses.map((s) => ({ storedStatus: s }));

describe('pure drain arithmetic', () => {
  it('isTerminalItemStatus — done/dropped are terminal, the rest are open', () => {
    expect(isTerminalItemStatus('done')).toBe(true);
    expect(isTerminalItemStatus('dropped')).toBe(true);
    for (const s of ['todo', 'wip', 'blocked', 'needs-human']) expect(isTerminalItemStatus(s)).toBe(false);
  });

  it('countOpenItems counts only non-terminal items', () => {
    expect(countOpenItems(items('done', 'dropped', 'todo', 'wip', 'blocked', 'needs-human'))).toBe(4);
    expect(countOpenItems(items('done', 'dropped'))).toBe(0);
    expect(countOpenItems([])).toBe(0);
  });

  it('isPlanDrained — all-terminal with ≥1 item is drained; any open item is not', () => {
    expect(isPlanDrained(items('done', 'dropped'))).toBe(true);
    expect(isPlanDrained(items('done'))).toBe(true);
    expect(isPlanDrained(items('done', 'todo'))).toBe(false);
    expect(isPlanDrained(items('needs-human'))).toBe(false);
  });

  it('isPlanDrained — an EMPTY plan is NOT a drain (no work ever existed)', () => {
    expect(isPlanDrained([])).toBe(false);
  });
});

describe('emitFleetDrainedEvent (WI-1830)', () => {
  it('fires fleet:drained:<slug> with the slug in both key and payload; awaiter-only (no `to`)', async () => {
    const emit = typedEmit();
    emitFleetDrainedEvent('my-fleet', {
      emit,
      readLaneHealth: zeroLane(),
      readTerminalExhaustion: terminalPopulation(3, 3),
      workspaceId: 'ws',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.key).toBe('fleet:drained:my-fleet');
    expect(call).toMatchObject({
      source: 'fleet',
      payload: {
        fleetSlug: 'my-fleet',
        claimableProof: { value: 0, basis: 'issue-family', spec: 'bugs@7', harness: 'papercusp' },
        terminalProof: { matched: 3, terminal: 3, nonTerminal: 0 },
      },
    });
    expect(call.summary).toContain('my-fleet');
    expect(call.to).toBeUndefined();
  });

  it('suppresses a false drain when the authoritative fleet lane still has work', async () => {
    const emit = typedEmit();
    const readLaneHealth = vi.fn(async () => laneHealth(422));
    emitFleetDrainedEvent('busy-fleet', { emit, readLaneHealth, workspaceId: 'ws' });
    await new Promise((r) => setTimeout(r, 0));
    expect(readLaneHealth).toHaveBeenCalledWith({ fleet: 'busy-fleet', workspaceId: 'ws' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not call held or admission-pending matches drained when claimability is zero', async () => {
    const emit = typedEmit();
    const readTerminalExhaustion = terminalPopulation(2, 0, 1, 0);
    emitFleetDrainedEvent('frozen-burndown', {
      emit,
      readLaneHealth: zeroLane(),
      readTerminalExhaustion,
      workspaceId: 'ws',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(readTerminalExhaustion).toHaveBeenCalledWith({ fleet: 'frozen-burndown', workspaceId: 'ws' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('fails closed when the terminal population is empty or unavailable', async () => {
    const emptyEmit = typedEmit();
    emitFleetDrainedEvent('empty-fleet', {
      emit: emptyEmit,
      readLaneHealth: zeroLane(),
      readTerminalExhaustion: terminalPopulation(0, 0),
      workspaceId: 'ws',
    });
    const unknownEmit = typedEmit();
    emitFleetDrainedEvent('unknown-fleet', {
      emit: unknownEmit,
      readLaneHealth: zeroLane(),
      readTerminalExhaustion: vi.fn(async () => null),
      workspaceId: 'ws',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emptyEmit).not.toHaveBeenCalled();
    expect(unknownEmit).not.toHaveBeenCalled();
  });

  it('fails closed when fleet claimability is unknown', async () => {
    const emit = typedEmit();
    emitFleetDrainedEvent('unknown-fleet', {
      emit,
      readLaneHealth: vi.fn(async () => null),
      workspaceId: 'ws',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).not.toHaveBeenCalled();
  });

  it('never rejects on an emit failure (warns; the status flip must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() =>
      emitFleetDrainedEvent('f1', {
        emit: emit as never,
        readLaneHealth: zeroLane(),
        readTerminalExhaustion: terminalPopulation(1, 1),
        workspaceId: 'ws',
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('drained-event for f1'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ended = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    const missing = vi.fn(async () => {
      throw new Error('relation "harness_shared.event_await" does not exist');
    });
    emitFleetDrainedEvent('f2', {
      emit: ended as never,
      readLaneHealth: zeroLane(),
      readTerminalExhaustion: terminalPopulation(1, 1),
      workspaceId: 'ws',
    });
    emitFleetDrainedEvent('f3', {
      emit: missing as never,
      readLaneHealth: zeroLane(),
      readTerminalExhaustion: terminalPopulation(1, 1),
      workspaceId: 'ws',
    });
    await new Promise((r) => setTimeout(r, 0));
    const drainedEventWarnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('drained-event for f2') || message.includes('drained-event for f3'));
    expect(drainedEventWarnings).toEqual([]);
    warn.mockRestore();
  });
});

describe('drainedFleetsForPlan (pure fleet↔plan derivation)', () => {
  it('a fleet with a lane on the drained plan and no other active lane is drained', () => {
    const rows = [row({ source: 'presence', fleetSlug: 'alpha', planSlug: 'plan-x', agentId: 'su-1' })];
    expect(drainedFleetsForPlan('plan-x', rows)).toEqual(['alpha']);
  });

  it('EXCLUDES a fleet that still holds an active claim on a DIFFERENT plan', () => {
    const rows = [
      row({ source: 'presence', fleetSlug: 'alpha', planSlug: 'plan-x', agentId: 'su-1' }),
      // same fleet, a live work-item claim on another plan → still in flight → not drained
      row({ source: 'work_item_claim', fleetSlug: 'alpha', planSlug: 'plan-y', claimActive: true, agentId: 'su-1' }),
    ];
    expect(drainedFleetsForPlan('plan-x', rows)).toEqual([]);
  });

  it('an INACTIVE (lapsed/terminal) claim on another plan does NOT block drain', () => {
    const rows = [
      row({ source: 'presence', fleetSlug: 'alpha', planSlug: 'plan-x', agentId: 'su-1' }),
      row({ source: 'plan_item_claim', fleetSlug: 'alpha', planSlug: 'plan-y', claimActive: false, agentId: 'su-1' }),
    ];
    expect(drainedFleetsForPlan('plan-x', rows)).toEqual(['alpha']);
  });

  it('reports MULTIPLE fleets on the drained plan, slug-sorted', () => {
    const rows = [
      row({ source: 'presence', fleetSlug: 'beta', planSlug: 'plan-x', agentId: 'su-2' }),
      row({ source: 'presence', fleetSlug: 'alpha', planSlug: 'plan-x', agentId: 'su-1' }),
    ];
    expect(drainedFleetsForPlan('plan-x', rows)).toEqual(['alpha', 'beta']);
  });

  it('rows with no fleet membership yield no drained fleets', () => {
    const rows = [row({ source: 'presence', fleetSlug: null, planSlug: 'plan-x', agentId: 'su-1' })];
    expect(drainedFleetsForPlan('plan-x', rows)).toEqual([]);
  });

  it("a fleet on a DIFFERENT plan is not a candidate for this plan's drain", () => {
    const rows = [row({ source: 'presence', fleetSlug: 'alpha', planSlug: 'other', agentId: 'su-1' })];
    expect(drainedFleetsForPlan('plan-x', rows)).toEqual([]);
  });
});

describe('emitFleetDrainedForPlan (orchestrator, injected seams)', () => {
  it('loads the assignments snapshot and fires once per drained fleet', async () => {
    const emit = typedEmit();
    const listAssignments = vi.fn(async () => [
      row({ source: 'presence', fleetSlug: 'alpha', planSlug: 'plan-x', agentId: 'su-1' }),
      row({ source: 'presence', fleetSlug: 'beta', planSlug: 'plan-x', agentId: 'su-2' }),
      // gamma is on plan-x BUT still holds a live lane elsewhere → not drained
      row({ source: 'presence', fleetSlug: 'gamma', planSlug: 'plan-x', agentId: 'su-3' }),
      row({ source: 'work_item_claim', fleetSlug: 'gamma', planSlug: 'plan-z', claimActive: true, agentId: 'su-3' }),
    ]);
    emitFleetDrainedForPlan('plan-x', {
      emit,
      listAssignments,
      readLaneHealth: zeroLane(),
      readTerminalExhaustion: terminalPopulation(1, 1),
      workspaceId: 'ws',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(listAssignments).toHaveBeenCalledTimes(1);
    const keys = emit.mock.calls.map((c) => c[0].key).sort();
    expect(keys).toEqual(['fleet:drained:alpha', 'fleet:drained:beta']);
  });

  it('fires nothing when no fleet is on the plan', async () => {
    const emit = typedEmit();
    const listAssignments = vi.fn(async () => [
      row({ source: 'presence', fleetSlug: 'alpha', planSlug: 'somewhere-else', agentId: 'su-1' }),
    ]);
    emitFleetDrainedForPlan('plan-x', { emit, listAssignments });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).not.toHaveBeenCalled();
  });

  it('suppresses a plan-terminal drain when the fleet oracle still has claimable work', async () => {
    const emit = typedEmit();
    const listAssignments = vi.fn(async () => [
      row({ source: 'presence', fleetSlug: 'busy-fleet', planSlug: 'plan-x', agentId: 'su-1' }),
    ]);
    const readLaneHealth = vi.fn(async () => laneHealth(422));
    emitFleetDrainedForPlan('plan-x', {
      emit,
      listAssignments,
      readLaneHealth,
      workspaceId: 'ws',
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(readLaneHealth).toHaveBeenCalledWith({ fleet: 'busy-fleet', workspaceId: 'ws' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('never rejects when the assignments load fails (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listAssignments = vi.fn(async () => {
      throw new Error('pool exhausted');
    });
    expect(() => emitFleetDrainedForPlan('plan-x', { listAssignments })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('drained-scan for plan plan-x'));
    warn.mockRestore();
  });
});
