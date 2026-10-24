import { beforeEach, describe, expect, it, vi } from 'vitest';

const getModes = vi.fn();
const setMode = vi.fn();
const getLoopStatus = vi.fn();
const readActiveLoopFacts = vi.fn();
const materializeLoop = vi.fn();
const buildLoopWakePrompt = vi.fn((_args: unknown) => 'wake prompt');
const listActiveAwaits = vi.fn();
const listOperatorCancelledAwaits = vi.fn();
const cancelAwait = vi.fn();
const retireLifecycleBoundWatches = vi.fn();
const registerAwait = vi.fn();
const captureWakeHandleForOwner = vi.fn();
const armInboxWake = vi.fn();
const getPresence = vi.fn();
const getClaimSpecRecord = vi.fn();
const getFlag = vi.fn();
const findMatchingActivePredicateWatch = vi.fn();
const registerPredicateWatch = vi.fn();
const startPredicateWatchPoller = vi.fn();

vi.mock('../../modes/store', () => ({
  getModes: (...args: unknown[]) => getModes(...args),
  setMode: (...args: unknown[]) => setMode(...args),
}));

vi.mock('../../harness/routines/loop', () => ({
  getLoopStatus: (...args: unknown[]) => getLoopStatus(...args),
  readActiveLoopFacts: (...args: unknown[]) => readActiveLoopFacts(...args),
  materializeLoop: (...args: unknown[]) => materializeLoop(...args),
  buildLoopWakePrompt: (args: unknown) => buildLoopWakePrompt(args),
}));

vi.mock('../../events/await/store', () => ({
  listActiveAwaits: (...args: unknown[]) => listActiveAwaits(...args),
  listOperatorCancelledAwaits: (...args: unknown[]) => listOperatorCancelledAwaits(...args),
  cancelAwait: (...args: unknown[]) => cancelAwait(...args),
  retireLifecycleBoundWatches: (...args: unknown[]) => retireLifecycleBoundWatches(...args),
  registerAwait: (...args: unknown[]) => registerAwait(...args),
}));

vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: (...args: unknown[]) => captureWakeHandleForOwner(...args),
}));

vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: (...args: unknown[]) => armInboxWake(...args),
}));

vi.mock('../../events/await/predicate-watch', () => ({
  findMatchingActivePredicateWatch: (...args: unknown[]) => findMatchingActivePredicateWatch(...args),
  registerPredicateWatch: (...args: unknown[]) => registerPredicateWatch(...args),
  startPredicateWatchPoller: (...args: unknown[]) => startPredicateWatchPoller(...args),
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...args: unknown[]) => getFlag(...args),
}));

vi.mock('../coordination/presence', () => ({
  getPresence: (...args: unknown[]) => getPresence(...args),
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  fleetSpecBeeKey: (fleetSlug: string) => `fleet:${fleetSlug}`,
  getClaimSpecRecord: (...args: unknown[]) => getClaimSpecRecord(...args),
}));

import {
  capLeaderProfileTargets,
  ensureFleetLeaderControl,
  LEADER_MONITOR_INTERVAL_SEC,
  LEADER_PROFILE_AUTO_ARM_CAP,
  resolveFleetLeaderAutoArmTargets,
  resolveFleetLeaderTransitionEventKeys,
  retireFleetLeaderWatches,
  shouldMaintainFleetLeaderControl,
} from './leader-control';

const input = {
  workspaceId: 'ws-1',
  ownerId: 'leader-1',
  fleetSlug: 'alpha',
  harnessSlug: 'papercusp',
  planSlug: 'plan-1',
} as const;

function activeWatches() {
  return standardEventKeys().map((eventKey, index) => ({
    id: index + 1,
    eventKey,
    policy: 'wake',
    once: false,
    wakeHandle: { kind: 'psu-socket' },
    boundTo: { kind: 'fleet-leadership', ref: 'alpha' },
    ...(eventKey === 'fleet:member-dead:alpha' ||
      eventKey === 'fleet:member-left:alpha' ||
      eventKey === 'fleet:context-critical:alpha'
      ? { payloadFilter: { not: { agentId: { equals: input.ownerId } } } }
      : {}),
  }));
}

function standardEventKeys(): string[] {
  return resolveFleetLeaderTransitionEventKeys({ fleetSlug: 'alpha' });
}

beforeEach(() => {
  vi.clearAllMocks();
  getFlag.mockResolvedValue(true);
  getModes.mockResolvedValue([{ mode: 'auto' }]);
  setMode.mockResolvedValue({ ok: true });
  getLoopStatus.mockResolvedValue({
    active: true,
    harnessSlug: 'papercusp',
    intervalSec: LEADER_MONITOR_INTERVAL_SEC,
    mode: 'monitor',
    carry: 'warm',
  });
  readActiveLoopFacts.mockResolvedValue(null);
  materializeLoop.mockResolvedValue(undefined);
  listActiveAwaits.mockResolvedValue(activeWatches());
  listOperatorCancelledAwaits.mockResolvedValue([]);
  captureWakeHandleForOwner.mockResolvedValue({
    handle: { kind: 'psu-socket' },
    note: 'reachable',
  });
  registerAwait.mockImplementation(async (args: Record<string, unknown>) => ({
    ...args,
    id: 100 + registerAwait.mock.calls.length,
  }));
  cancelAwait.mockResolvedValue(undefined);
  retireLifecycleBoundWatches.mockResolvedValue({ awaits: 0, predicateWatches: 0 });
  armInboxWake.mockResolvedValue(undefined);
  getPresence.mockResolvedValue({ potSlug: 'papercusp', agentRole: 'su' });
  getClaimSpecRecord.mockResolvedValue({ harnessSlug: null });
  findMatchingActivePredicateWatch.mockResolvedValue(null);
  registerPredicateWatch.mockResolvedValue({});
});

describe('retireFleetLeaderWatches', () => {
  it("retires only the departed owner's fleet-leadership binding", async () => {
    retireLifecycleBoundWatches.mockResolvedValue({ awaits: 5, predicateWatches: 1 });

    await expect(retireFleetLeaderWatches('leader-1', 'alpha')).resolves.toBe(6);

    expect(retireLifecycleBoundWatches).toHaveBeenCalledWith(
      { kind: 'fleet-leadership', ref: 'alpha' },
      { ownerIds: ['leader-1'] },
    );
  });
});

describe('ensureFleetLeaderControl', () => {
  it('treats typed wind-down as a stop boundary after loop:end', () => {
    expect(shouldMaintainFleetLeaderControl('active')).toBe(true);
    expect(shouldMaintainFleetLeaderControl('winding-down')).toBe(false);
    // Legacy callers without the typed field retain the pre-existing behavior.
    expect(shouldMaintainFleetLeaderControl(undefined)).toBe(true);
  });

  it('derives the exact seven standard event keys from the fleet-leader auto-arm profile', () => {
    expect(standardEventKeys()).toEqual([
      'fleet:member-dead:alpha',
      'fleet:member-left:alpha',
      'fleet:drained:alpha',
      'fleet:context-critical:alpha',
      'fleet:claim-released:alpha',
      'fleet:admission-blocked:alpha',
      'fleet:launch-failed:alpha',
    ]);
    expect(standardEventKeys()).not.toContain('fleet:item-completed:alpha');
  });

  it('caps one resolved agent/profile before any watches can be registered', () => {
    const candidates = Array.from({ length: LEADER_PROFILE_AUTO_ARM_CAP + 3 }, (_, index) => `target-${index}`);

    const bounded = capLeaderProfileTargets(candidates);

    expect(bounded.selected).toHaveLength(LEADER_PROFILE_AUTO_ARM_CAP);
    expect(bounded.omitted).toEqual(candidates.slice(LEADER_PROFILE_AUTO_ARM_CAP));
  });

  it('fails closed if an owner-attention surface is injected into the auto-arm resolver', () => {
    expect(() =>
      resolveFleetLeaderAutoArmTargets({
        fleetSlug: 'alpha',
        reader: vi.fn() as never,
        rows: [
          {
            context: 'fleet-leader',
            watch: { kind: 'owner-attention', source: 'open-owner-questions' },
            tier: 'auto-arm',
            why: 'malformed control row proving interactive owner surfaces never become leader wakes',
          },
        ],
      }),
    ).toThrow("cannot arm owner-attention source 'open-owner-questions'");
  });

  it('preserves cold-auto (and any registry-derived autonomous posture) instead of switching to plain auto', async () => {
    getModes.mockResolvedValue([{ mode: 'cold-auto' }]);

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.mode).toEqual({ healthy: true, changed: false });
    expect(setMode).not.toHaveBeenCalled();
    expect(materializeLoop).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
    expect(out.watches.cancel).toEqual({
      tool: 'events:cancel',
      args: { await_ids: [1, 2, 3, 4, 5, 6, 7] },
    });
  });

  it('honours the flag-off kill switch by retiring lifecycle-bound profile watches', async () => {
    getFlag.mockResolvedValue(false);
    retireLifecycleBoundWatches.mockResolvedValue({ awaits: 5, predicateWatches: 1 });

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches).toMatchObject({ enabled: false, healthy: true, removed: 6, cancel: null });
    expect(retireLifecycleBoundWatches).toHaveBeenCalledWith(
      { kind: 'fleet-leadership', ref: 'alpha' },
      { ownerIds: ['leader-1'] },
    );
    expect(listActiveAwaits).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('fails safe to the default-ON profile when flag lookup errors', async () => {
    getFlag.mockRejectedValue(new Error('flag backend unavailable'));

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches.enabled).toBe(true);
    expect(out.watches.flag).toEqual({ fallback: true, error: 'flag backend unavailable' });
    expect(out.watches.active).toEqual(standardEventKeys());
  });

  it('repairs a missing autonomy mode, inactive loop, and absent standing watches in one pass', async () => {
    getModes.mockResolvedValue([]);
    getLoopStatus.mockResolvedValue({
      active: false,
      harnessSlug: 'papercusp',
      intervalSec: 300,
      mode: 'work',
      carry: 'cold',
    });
    listActiveAwaits.mockResolvedValue([]);

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.repaired).toBe(true);
    expect(out.mode).toEqual({ healthy: true, changed: true });
    expect(setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        ownerId: 'leader-1',
        modeId: 'auto',
        enabled: true,
      }),
    );
    expect(materializeLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        ownerId: 'leader-1',
        intervalSec: 300,
        carry: 'cold',
        mode: 'work',
        onlyIfInactive: true,
      }),
    );
    expect(registerAwait).toHaveBeenCalledTimes(7);
    expect(out.watches.added).toEqual(standardEventKeys());
    expect(out.watches.cancel).toEqual({
      tool: 'events:cancel',
      args: { await_ids: [101, 102, 103, 104, 105, 106, 107] },
    });

    const registrations = registerAwait.mock.calls.map(([args]) => args as Record<string, unknown>);
    expect(
      registrations.every(
        (args) => JSON.stringify(args.boundTo) === JSON.stringify({ kind: 'fleet-leadership', ref: 'alpha' }),
      ),
    ).toBe(true);
    expect(registrations.find((args) => args.eventKey === 'fleet:member-dead:alpha')).toMatchObject({
      payloadFilter: { not: { agentId: { equals: 'leader-1' } } },
    });
    expect(registrations.find((args) => args.eventKey === 'fleet:context-critical:alpha')).toMatchObject({
      payloadFilter: { not: { agentId: { equals: 'leader-1' } } },
    });
    for (const eventKey of ['fleet:claim-released:alpha', 'fleet:drained:alpha', 'fleet:admission-blocked:alpha']) {
      expect(registrations.find((args) => args.eventKey === eventKey)).not.toHaveProperty('payloadFilter');
    }
  });

  it('falls back to the fleet claim-spec harness when a takeover has no session scope', async () => {
    const noHarnessInput = { ...input, harnessSlug: undefined };
    getLoopStatus.mockResolvedValue({
      active: false,
      harnessSlug: null,
      intervalSec: 300,
      mode: 'monitor',
      carry: 'warm',
    });
    getPresence.mockResolvedValue({ potSlug: null, agentRole: 'su' });
    getClaimSpecRecord.mockResolvedValue({ source: 'fleet', harnessSlug: 'papercusp' });

    const out = await ensureFleetLeaderControl(noHarnessInput);

    expect(getClaimSpecRecord).toHaveBeenCalledWith({ cupId: 'fleet:alpha', workspaceId: 'ws-1' });
    expect(out.loop).toMatchObject({ healthy: true, harness: 'papercusp' });
    expect(materializeLoop).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', harnessSlug: 'papercusp' }),
    );
  });

  it.each(['work', 'monitor'] as const)('preserves an explicitly ended %s loop while keeping push watches', async (mode) => {
    getLoopStatus.mockResolvedValue({
      active: false,
      explicitlyEnded: true,
      harnessSlug: 'papercusp',
      intervalSec: 600,
      mode,
    });
    listActiveAwaits.mockResolvedValue(activeWatches());

    const out = await ensureFleetLeaderControl(input);

    expect(materializeLoop).not.toHaveBeenCalled();
    expect(out.loop).toMatchObject({ healthy: true, changed: false, standdown: 'explicit_loop_end' });
    expect(out.watches.active).toEqual(standardEventKeys());
    expect(armInboxWake).toHaveBeenCalled();
    expect(cancelAwait).not.toHaveBeenCalled();
  });

  it('preserves an inactive loop control payload and pending watches during recovery', async () => {
    const priorGoal = 'lead the fleet at the widened fallback cadence';
    const priorMonitor = {
      predicateKey: 'fleet:alpha',
      stopCondition: 'fleet alpha is drained or leadership ends',
      noDeltaBudget: 100,
      remainingNoDeltaBudget: 73,
      authority: { kind: 'fleet-leader' as const, fleet: 'alpha' },
    };
    const priorKickoff =
      '⏸ BACKOFF PREMISE — re-check blockedOn.event `release:green` before proceeding.\n\ncustom monitor kickoff';
    getLoopStatus.mockResolvedValue({
      active: false,
      harnessSlug: 'papercusp',
      intervalSec: 1200,
      mode: 'monitor',
      carry: 'cold',
      continuation: 'gated',
      goal: priorGoal,
    });
    readActiveLoopFacts.mockResolvedValue({
      active: false,
      intervalSec: 1200,
      harnessSlug: 'papercusp',
      goal: priorGoal,
      kickoff: priorKickoff,
      customWakePrompt: true,
      fireCount: 12,
      carry: 'cold',
      continuation: 'gated',
      mode: 'monitor',
      monitor: priorMonitor,
      armedAt: '2026-08-22T23:00:00.000Z',
    });
    // This await belongs to the loop's blocker, not fleet-leadership control. Recovery
    // may reconcile its own five standing watches, but must never consume this pending
    // await while replacing the inactive routine row.
    listActiveAwaits.mockResolvedValue([
      ...activeWatches(),
      {
        id: 99,
        eventKey: 'release:green',
        policy: 'wake',
        once: true,
        wakeHandle: { kind: 'psu-socket' },
        boundTo: { kind: 'loop', ref: 'loop-1' },
      },
    ]);
    materializeLoop.mockResolvedValue({ changed: true, intervalSec: 1200 });

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.loop).toMatchObject({
      healthy: true,
      changed: true,
      intervalSec: 1200,
      mode: 'monitor',
    });
    expect(materializeLoop).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      ownerId: 'leader-1',
      intervalSec: 1200,
      kickoff: priorKickoff,
      goal: priorGoal,
      carry: 'cold',
      continuation: 'gated',
      mode: 'monitor',
      monitor: priorMonitor,
      onlyIfInactive: true,
      customWakePrompt: true,
    });
    expect(registerAwait).not.toHaveBeenCalled();
    expect(cancelAwait).not.toHaveBeenCalled();
    expect(out.watches.active).toEqual(standardEventKeys());
    expect(out.watches.awaitIds).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it.each(['status', 'payload', 'standdown'] as const)(
    'does not resurrect an inactive exhausted monitor recorded by %s while preserving push watches',
    async (evidenceSource) => {
      const exhaustedMonitor = {
        predicateKey: 'fleet:alpha',
        stopCondition: 'fleet alpha is drained or leadership ends',
        noDeltaBudget: 100,
        remainingNoDeltaBudget: 0,
        authority: { kind: 'fleet-leader' as const, fleet: 'alpha' },
      };
      getLoopStatus.mockResolvedValue({
        active: false,
        harnessSlug: 'papercusp',
        intervalSec: 1200,
        mode: 'monitor',
        carry: 'cold',
        continuation: 'gated',
        monitor: evidenceSource === 'status' ? exhaustedMonitor : null,
        monitorStanddown:
          evidenceSource === 'standdown'
            ? {
                code: 'no_delta_budget_exhausted',
                reason: 'quiet-wake budget exhausted',
                authorityCode: null,
                atMs: 1791335177901,
              }
            : null,
      });
      readActiveLoopFacts.mockResolvedValue({
        active: false,
        intervalSec: 1200,
        harnessSlug: 'papercusp',
        goal: 'lead fleet alpha without reviving an exhausted monitor',
        kickoff: 'preserved monitor kickoff',
        fireCount: 100,
        carry: 'cold',
        continuation: 'gated',
        mode: 'monitor',
        monitor: evidenceSource === 'payload' ? exhaustedMonitor : null,
      });
      materializeLoop.mockResolvedValue({ changed: true, intervalSec: 1200 });
      listActiveAwaits.mockResolvedValue([
        ...activeWatches(),
        {
          id: 99,
          eventKey: 'release:green',
          policy: 'wake',
          once: true,
          wakeHandle: { kind: 'psu-socket' },
          boundTo: { kind: 'loop', ref: 'loop-1' },
        },
      ]);

      const out = await ensureFleetLeaderControl(input);

      expect(materializeLoop).not.toHaveBeenCalled();
      expect(buildLoopWakePrompt).not.toHaveBeenCalled();
      expect(out.healthy).toBe(true);
      expect(out.repaired).toBe(false);
      expect(out.loop).toMatchObject({
        healthy: true,
        changed: false,
        intervalSec: 1200,
        mode: 'monitor',
        standdown: 'no_delta_budget_exhausted',
      });
      expect(out.inboxWake.healthy).toBe(true);
      expect(armInboxWake).toHaveBeenCalledTimes(1);
      expect(out.watches.active).toEqual(standardEventKeys());
      expect(out.watches.awaitIds).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(registerAwait).not.toHaveBeenCalled();
      expect(cancelAwait).not.toHaveBeenCalled();
      expect(retireLifecycleBoundWatches).not.toHaveBeenCalled();
      expect(exhaustedMonitor.remainingNoDeltaBudget).toBe(0);
    },
  );

  it('recovers a renewed positive monitor budget despite historical exhaustion metadata', async () => {
    const renewedMonitor = {
      predicateKey: 'fleet:alpha',
      stopCondition: 'fleet alpha is drained or leadership ends',
      noDeltaBudget: 100,
      remainingNoDeltaBudget: 73,
      authority: { kind: 'fleet-leader' as const, fleet: 'alpha' },
    };
    getLoopStatus.mockResolvedValue({
      active: false,
      harnessSlug: 'papercusp',
      intervalSec: 1200,
      mode: 'monitor',
      carry: 'warm',
      monitor: renewedMonitor,
      monitorStanddown: { code: 'no_delta_budget_exhausted', reason: 'historical standdown' },
    });
    readActiveLoopFacts.mockResolvedValue({
      active: false,
      intervalSec: 1200,
      mode: 'monitor',
      monitor: renewedMonitor,
      kickoff: 'renewed monitor kickoff',
    });
    materializeLoop.mockResolvedValue({ changed: true, intervalSec: 1200 });

    const out = await ensureFleetLeaderControl(input);

    expect(out.loop).toMatchObject({ healthy: true, changed: true, mode: 'monitor' });
    expect(out.loop).not.toHaveProperty('standdown');
    expect(materializeLoop).toHaveBeenCalledWith(
      expect.objectContaining({ monitor: renewedMonitor, onlyIfInactive: true }),
    );
  });

  it('preserves an active deliberately retuned work loop instead of overwriting its cadence and goal', async () => {
    const deliberateGoal = 'continue the staged verification at the widened fallback cadence';
    getLoopStatus.mockResolvedValue({
      active: true,
      harnessSlug: 'papercusp',
      intervalSec: 1200,
      mode: 'work',
      carry: 'cold',
      goal: deliberateGoal,
    });

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.repaired).toBe(false);
    expect(out.loop).toMatchObject({
      healthy: true,
      changed: false,
      intervalSec: 1200,
      mode: 'work',
    });
    expect(materializeLoop).not.toHaveBeenCalled();
    expect(buildLoopWakePrompt).not.toHaveBeenCalled();
    expect(out.watches.active).toEqual(standardEventKeys());
  });

  it('repairs legacy self-transition watches while preserving the other watches as unfiltered', async () => {
    listActiveAwaits.mockResolvedValue(activeWatches().map(({ payloadFilter: _payloadFilter, ...row }) => row));

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches.repaired).toEqual([
      'fleet:member-dead:alpha',
      'fleet:member-left:alpha',
      'fleet:context-critical:alpha',
    ]);
    expect(registerAwait).toHaveBeenCalledTimes(3);
    expect(registerAwait.mock.calls.map(([args]) => args.eventKey)).toEqual([
      'fleet:member-dead:alpha',
      'fleet:member-left:alpha',
      'fleet:context-critical:alpha',
    ]);
    expect(registerAwait.mock.calls.every(([args]) => args.payloadFilter?.not?.agentId?.equals === 'leader-1')).toBe(
      true,
    );
  });

  it('retires an unbound legacy standing watch before re-arming its bound profile row', async () => {
    const target = 'fleet:member-dead:alpha';
    const legacyStanding = {
      id: 99,
      eventKey: target,
      policy: 'wake',
      once: false,
      wakeHandle: { kind: 'psu-socket' },
      boundTo: null,
      note: 'standing fleet leader transition watch (alpha)',
    };
    const manualWait = {
      ...legacyStanding,
      id: 100,
      note: 'operator standing wait for a member-dead transition',
    };
    listActiveAwaits.mockResolvedValue([
      ...activeWatches().filter((row) => row.eventKey !== target),
      legacyStanding,
      manualWait,
    ]);

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches.repaired).toContain(target);
    expect(registerAwait).toHaveBeenCalledTimes(1);
    expect(registerAwait).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: target,
        boundTo: { kind: 'fleet-leadership', ref: 'alpha' },
      }),
    );
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 99, subscriberId: 'leader-1' });
    expect(cancelAwait).not.toHaveBeenCalledWith({ awaitId: 100, subscriberId: 'leader-1' });
  });

  it('treats an explicit operator cancellation as sticky during reconciliation', async () => {
    const suppressedKey = 'fleet:context-critical:alpha';
    listOperatorCancelledAwaits.mockResolvedValue([
      { id: 77, subscriberId: 'leader-1', eventKey: suppressedKey, cancelledAt: '2026-08-23T20:00:00.000Z' },
    ]);
    listActiveAwaits.mockResolvedValue(activeWatches().filter((row) => row.eventKey !== suppressedKey));

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches.suppressed).toEqual([suppressedKey]);
    expect(out.watches.active).toEqual(standardEventKeys().filter((key) => key !== suppressedKey));
    expect(registerAwait).not.toHaveBeenCalled();
    expect(listOperatorCancelledAwaits).toHaveBeenCalledWith('leader-1', standardEventKeys());
  });
});
