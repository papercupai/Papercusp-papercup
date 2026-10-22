import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isLoopPopulationStarvation,
  sweepStalledLoops,
  queueStalledHostRelaunch,
  type LoopPopulationSnapshot,
  type StalledLoopsSweepDeps,
} from './stalled-loops-guard';
import { turnsStalledFloorMs, type LoopStatus } from './loop';
import { evaluateSilentHalt } from './silent-halt-reconcile';
import type { StalledLoopHostReading } from '../../events/await/host-recovery-eligibility';
import { findLiveHostAsync, type PsuPtyHost } from '../../events/await/psu-pty-discovery';

const carryMocks = vi.hoisted(() => ({ build: vi.fn(), inject: vi.fn(), mark: vi.fn() }));
vi.mock('../../carry-respawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../carry-respawn')>()), buildOwnerRespawnLaunchSpec: carryMocks.build,
}));
vi.mock('../../carry-respawn-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../carry-respawn-marker')>()), markRespawnExpected: carryMocks.mark,
}));
vi.mock('../../attention-notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention-notify')>()), notifyAttention: vi.fn(async () => {}),
}));
vi.mock('../../turn-provenance/turn-provenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../turn-provenance/turn-provenance')>()),
  tagTurnForInjection: async (args: { text: string }) => ({ taggedText: args.text }),
}));

// P-007: a turn-stalled owner's host is read before the disarm, and the DEFAULT reader hits the
// real ~/.papercusp/psu-pty directory (and starts the discovery janitor). Keep every test in this
// file hermetic — no live host unless a test injects `readStalledHost` itself.
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/await/psu-pty-discovery')>()),
  findLiveHostAsync: vi.fn(async () => null),
  readHostEventTailAsync: vi.fn(async () => []),
  injectIntoHostWithConfirmation: carryMocks.inject,
}));

describe('stalled host native carry recovery', () => {
  const host = { ownerId: 'su-recovery-unit', bridgeTty: false, launchedBy: 'su-leader',
    caps: ['carry-respawn'], sock: '/unit.sock', startedAt: 123, execution: null } as unknown as PsuPtyHost;
  beforeEach(() => {
    vi.mocked(findLiveHostAsync).mockResolvedValue(host);
    carryMocks.build.mockReset().mockResolvedValue({ firstPrompt: null, systemPromptAddendum: 'saved obligations' });
    carryMocks.inject.mockReset().mockResolvedValue({ ok: true, confirmation: 'acked' });
    carryMocks.mark.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.mocked(findLiveHostAsync).mockResolvedValue(null); });
  it('addresses the same owner and reuses its existing host without changing launch profile', async () => {
    expect(await queueStalledHostRelaunch(host.ownerId, 'ws')).toEqual({ queued: true });
    const [sock, payload] = carryMocks.inject.mock.calls[0];
    expect(sock).toBe(host.sock);
    expect(payload).toEqual({ mode: 'carry-respawn', data: expect.stringContaining(`ADDRESSED TO ${host.ownerId}`),
      systemPromptAddendum: 'saved obligations', ownerId: host.ownerId, expectedHostStartedAt: 123 });
    expect(carryMocks.mark).toHaveBeenCalledWith(host.ownerId);
  });
  it.each([
    { bridgeTty: true }, { launchedBy: '' }, { ownerId: 'another-owner' }, { caps: [] },
    { execution: { ownerStopRequested: true } }, { execution: { ownerInputPending: true } },
  ])('refuses a route or owner-attendance wall %j before cutting', async (override) => {
    vi.mocked(findLiveHostAsync).mockResolvedValue({ ...host, ...override } as PsuPtyHost);
    expect((await queueStalledHostRelaunch(host.ownerId, 'ws')).queued).toBe(false);
    expect(carryMocks.inject).not.toHaveBeenCalled();
    expect(carryMocks.mark).not.toHaveBeenCalled();
  });
  it('requires a real ACK and never marks an optimistic close as a successor', async () => {
    carryMocks.inject.mockResolvedValue({ ok: true, confirmation: 'assumed-close' });
    expect(await queueStalledHostRelaunch(host.ownerId, 'ws')).toEqual({ queued: false, reason: 'carry-assumed-close' });
    expect(carryMocks.mark).not.toHaveBeenCalled();
  });
  it('leaves an unassemblable carry intact', async () => {
    carryMocks.build.mockResolvedValue(null);
    expect(await queueStalledHostRelaunch(host.ownerId, 'ws')).toEqual({ queued: false, reason: 'carry-build-failed' });
    expect(carryMocks.inject).not.toHaveBeenCalled();
  });
});

// Bind the mocks to the REAL dep signatures (the convention session-ingest-lag-watchdog.test.ts
// already uses). A bare `vi.fn(async () => true)` records a ZERO-arg call tuple, so reading
// `broadcast.mock.calls[0][0]` below is a type error — and vitest is type-blind, so a green test
// run cannot see it. It surfaces only at `lint:tsc`, i.e. at the fleet gate.
type BroadcastFn = NonNullable<StalledLoopsSweepDeps['broadcast']>;
// Same reason as BroadcastFn above: the re-arm assertions read `rearm.mock.calls[0][1]`, which
// is a type error against a bare `vi.fn(async () => {})`'s zero-arg call tuple — invisible to a
// green vitest run, red at lint:tsc i.e. at the fleet gate (EI-19406534159939583 hit exactly it).
type RearmFn = NonNullable<StalledLoopsSweepDeps['rearm']>;
// Same reason as the two above, and it bites harder here: the owner-page assertions read
// `notify.mock.calls[0][0].kind` / `.importance`, so a bare `vi.fn(async () => {})` is a zero-arg
// call tuple and every one of those reads is a lint:tsc error a green vitest run cannot see
// (EI-19899301656065801).
type NotifyFn = NonNullable<StalledLoopsSweepDeps['notify']>;
// Same reason again (WI-36685): the wake-starved assertions read `armWake.mock.calls[0][0].ownerId`,
// which against a bare `vi.fn(async () => ...)` is a zero-arg call tuple — TS2493/TS2339 at
// lint:tsc, and completely invisible to a green vitest run.
type ArmWakeFn = NonNullable<StalledLoopsSweepDeps['armWake']>;
// Same reason once more (EI-19966210024116714). Two of these bind for the SAME lint:tsc-only
// reason the four above do: the unaddressable-harness assertions read the disarm REASON itself
// (`autoPause.mock.calls[0][2]`) — the whole point of that fix is the reason string, so asserting
// on it is not optional — and they read `resolveOwnerWorkspaces.mock.calls[0][0]` to prove the
// resolve is batched once per sweep rather than once per owner.
type AutoPauseFn = NonNullable<StalledLoopsSweepDeps['autoPause']>;
type ResolveOwnerWorkspacesFn = NonNullable<StalledLoopsSweepDeps['resolveOwnerWorkspaces']>;

/** Minimal fake `harness_shared.routines` SELECT — the sweep's only direct SQL read. */
function fakeSql(rows: Array<{ id: string; target_owner_id: string }>) {
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (/WITH active_loops AS/i.test(query)) {
      return Promise.resolve([{ active_loops: 0, parked_loops: 0, parked_zero_tool_3h: 0, owner_sample: [] }]);
    }
    if (/SELECT/i.test(query)) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as unknown as {
    (strings: TemplateStringsArray): Promise<unknown[]>;
    array: (values: unknown[]) => unknown[];
    unsafe: (identifier: string) => string;
  };
  sql.array = (values) => values;
  sql.unsafe = (identifier) => identifier;
  return sql as never;
}

function status(overrides: Partial<LoopStatus> & { turnsStalled: boolean }): LoopStatus {
  return {
    name: 'loop-x',
    ownerId: 'owner-x',
    harnessSlug: 'papercusp',
    active: true,
    intervalSec: 60,
    carry: 'warm',
    continuation: 'settle',
    mode: 'work',
    monitor: null,
    monitorStanddown: null,
    standdown: null,
    goal: null,
    fireCount: 10,
    firesSinceArm: 10,
    expectedFiresSinceArm: null,
    effectiveIntervalSec: null,
    cadenceRatio: null,
    longestObservedGapSec: null,
    cadenceDrift: false,
    parked: false,
    parkedForSec: null,
    nextFireAt: null,
    lastFiredAt: '2026-08-01T00:00:00.000Z',
    armedAt: null,
    costCapCents: null,
    maxFires: null,
    maxDurationSec: null,
    fireStarved: false,
    stalled: false,
    stalledSinceMs: null,
    lastDeliveryOutcome: null,
    consecutiveErrors: 0,
    lastWakeChannel: null,
    lastWakeStatus: null,
    lastWakeAt: null,
    lastWakeError: null,
    lastTurnAt: null,
    lastRealTurnAt: null,
    lifecycleBackoff: null,
    ...overrides,
  };
}

/**
 * The wake-reachability oracle, stubbed. `reachable` is the only field the guard reads.
 *
 * Module-scoped rather than per-describe (EI-19899301656065801): since the owner page landed,
 * the DISARM path probes reachability too, so a disarm test that does not inject this falls
 * through to the real `probeWakeReachability` and opens a live Postgres connection from a unit
 * test. Every describe that can disarm therefore needs it, not just the fire-starved one.
 */
const reach = (reachable: boolean) =>
  vi.fn(async () => ({
    reachable,
    channel: (reachable ? 'psu-socket' : 'none') as never,
    durableWhileAlive: reachable,
    summary: reachable ? 'live injectable session' : 'no wake path',
    // WI-36685: an unreachable owner here is a genuine corpse — nothing live to repair TO.
    // The wake-starved shape (unreachable ONLY because the standing await is missing) is
    // `wakeStarvedProbe()` below, deliberately a separate fixture so no existing test
    // silently acquires the new branch's behaviour.
    awaitRepairable: false,
    wouldBeChannel: null,
  }));

/**
 * WI-36685 — the WAKE-STARVED probe shape: `reachable:false` (a wake right now really would
 * not land, because Gate 1 fails) yet `awaitRepairable:true`, because every other liveness
 * signal is healthy and arming the watch alone restores delivery.
 *
 * The pair (`reach(false)` vs this) IS the distinction the guard turns on, which is why they
 * differ in exactly one field: both are unreachable, and only one is repairable.
 */
const wakeStarvedProbe = () =>
  vi.fn(async () => ({
    reachable: false,
    channel: 'none' as never,
    durableWhileAlive: false,
    summary: 'no standing await, but the session is live and would take psu-socket once re-armed',
    awaitRepairable: true,
    wouldBeChannel: 'psu-socket' as never,
  }));

describe('sweepStalledLoops (WI-6639 — act on turnsStalled instead of leaving it inert)', () => {
  it('leaves a disarmed actionable AUTO session visible to silent-halt without creating an exempting await', async () => {
    for (const intervalSec of [60, 600]) {
      const ownerId = `su-disarm-fallback-${intervalSec}`;
      const loop = status({ ownerId, turnsStalled: true, intervalSec });
      const sql = fakeSql([{ id: 'rt-fallback', target_owner_id: ownerId }]);
      const autoPause = vi.fn<AutoPauseFn>(async () => { loop.active = false; });
      const armWake = vi.fn<ArmWakeFn>(async () => {});
      const result = await sweepStalledLoops({ sql, workspaceId: 'ws' }, {
        getStatuses: async () => new Map([[ownerId, loop]]),
        autoPause, armWake, probeReachability: reach(false),
        broadcast: vi.fn<BroadcastFn>(async () => true),
        notify: vi.fn<NotifyFn>(async () => {}),
      });
      expect(result.paused).toBe(1);
      expect(autoPause).toHaveBeenCalledExactlyOnceWith(sql, 'rt-fallback', expect.any(String));
      expect(loop.active).toBe(false);
      expect(armWake).not.toHaveBeenCalled();

      const floor = Math.max(30 * MIN, 5 * intervalSec * 1000);
      const input = { loopActive: loop.active, hasPosture: true, pendingAwaits: 0,
        heartbeatAgeMs: 1000, lastRealTurnAgeMs: 120 * MIN,
        inactiveForMs: floor, intervalSec, heldWorkItems: 1 };
      expect(evaluateSilentHalt(input)).toMatchObject({ halted: false, staleFloorMs: floor });
      expect(evaluateSilentHalt({ ...input, inactiveForMs: floor + 1 }))
        .toMatchObject({ halted: true, staleFloorMs: floor });
      // A genuine external await remains a wake source after the same disarm.
      expect(evaluateSilentHalt({ ...input, inactiveForMs: floor + 1, pendingAwaits: 1 }))
        .toMatchObject({ halted: false, exemption: 'pending-await x1 (a live wake source)' });
    }
  });

  it('no active loop-% rows and nothing to revive → no status read, no auto-pause, no broadcast', async () => {
    const sql = fakeSql([]);
    const getStatuses = vi.fn();
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );
    expect(res).toEqual({
      checked: 0,
      paused: 0,
      sample: [],
      vetoedByRecentTurn: [],
      reArmedFireStarved: [],
      vetoedByProviderWall: [],
      disarmedWhileReachable: [],
      repairedWakeStarved: [],
      vetoedByWithheldFire: [],
      vetoedByAwaitSuppression: [],
      disarmedUnaddressableHarness: [],
      vetoedByToolActivity: [],
      reArmedToolLiveParked: [],
      routedToHostRecovery: [],
      disarmedHostUnhealthy: [],
      retainedHostRecoveryWalls: [],
      revivedAfterDisarm: [],
      cadenceDrift: [],
      population: {
        status: 'measured',
        active: 0,
        parked: 0,
        parkedRatio: null,
        parkedZeroTool3h: 0,
        parkedZeroToolRatio: null,
        ownerSample: [],
      },
      dryRun: false,
    });
    expect(getStatuses).not.toHaveBeenCalled();
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('disarms every owner whose status is turnsStalled:true, leaves healthy owners untouched', async () => {
    const sql = fakeSql([
      { id: 'rt_dead1', target_owner_id: 'su-dead1' },
      { id: 'rt_dead2', target_owner_id: 'su-dead2' },
      { id: 'rt_ok', target_owner_id: 'su-ok' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-dead1',
            status({
              ownerId: 'su-dead1',
              turnsStalled: true,
              fireCount: 40,
              lastFiredAt: '2026-08-01T10:00:00.000Z',
              lastTurnAt: null,
            }),
          ],
          [
            'su-dead2',
            status({ ownerId: 'su-dead2', turnsStalled: true, fireCount: 12, lastTurnAt: '2026-07-30T00:00:00.000Z' }),
          ],
          ['su-ok', status({ ownerId: 'su-ok', turnsStalled: false })],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.checked).toBe(3);
    expect(res.paused).toBe(2);
    expect(res.sample.sort()).toEqual(['su-dead1', 'su-dead2']);
    expect(res.dryRun).toBe(false);

    expect(autoPause).toHaveBeenCalledTimes(2);
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_dead1', expect.stringContaining('WI-6639'));
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_dead2', expect.stringContaining('WI-6639'));
    // The healthy owner's routine id must never be touched.
    expect(autoPause).not.toHaveBeenCalledWith(sql, 'rt_ok', expect.anything());

    // ONE broadcast for the whole batch, not one per disarmed owner.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]?.[0];
    expect(call?.summary).toContain('2 armed engine loop');
    expect(call?.body).toContain('su-dead1');
    expect(call?.body).toContain('su-dead2');
    expect(call?.body).not.toContain('su-ok');
  });

  it('reports sustained cadence drift as an advisory without pausing a healthy loop', async () => {
    const sql = fakeSql([{ id: 'rt-slow', target_owner_id: 'su-slow' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-slow',
            status({
              ownerId: 'su-slow',
              turnsStalled: false,
              firesSinceArm: 5,
              expectedFiresSinceArm: 62,
              effectiveIntervalSec: 728.0376,
              cadenceRatio: 12.13396,
              longestObservedGapSec: 1207.28,
              // The sweep calls computeCadenceDrift without a pinned clock, so overdue-ness is
              // judged against real Date.now(). A far-past nextFireAt is overdue on any clock
              // ahead of it — the same idiom the fixture's lastFiredAt already uses. The
              // fixture DEFAULT stays null so no other case in this file starts drifting.
              nextFireAt: '2026-08-01T00:00:00.000Z',
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.cadenceDrift).toEqual(['su-slow']);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'loop-cadence-advisory',
        conditionKey: 'loop-cadence-drift:ws',
        oneShot: true,
      }),
    );
    expect(broadcast.mock.calls[0]?.[0].summary).toContain('advisory only');
  });

  it('keeps cadence-drift-only healthy owners advisory beside true turn-stalled owners', async () => {
    const stalledOwners = Array.from({ length: 5 }, (_, i) => `su-turn-stalled-${i + 1}`);
    const cadenceOwners = Array.from({ length: 21 }, (_, i) => `su-cadence-only-${i + 1}`);
    const allOwners = [...stalledOwners, ...cadenceOwners];
    const sql = fakeSql(allOwners.map((ownerId) => ({ id: `rt-${ownerId}`, target_owner_id: ownerId })));
    const statuses = new Map<string, LoopStatus>([
      ...stalledOwners.map(
        (ownerId) =>
          [ownerId, status({ ownerId, turnsStalled: true, lastTurnAt: null, lastRealTurnAt: null })] as [
            string,
            LoopStatus,
          ],
      ),
      ...cadenceOwners.map(
        (ownerId) =>
          [
            ownerId,
            status({
              ownerId,
              turnsStalled: false,
              firesSinceArm: 5,
              expectedFiresSinceArm: 62,
              effectiveIntervalSec: 728.0376,
              cadenceRatio: 12.13396,
              longestObservedGapSec: 1207.28,
              // An overdue next fire is the independent evidence required for the advisory.
              nextFireAt: '2026-08-01T00:00:00.000Z',
            }),
          ] as [string, LoopStatus],
      ),
    ]);
    const getStatuses = vi.fn(async () => statuses);
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.checked).toBe(26);
    expect(res.paused).toBe(5);
    expect(res.sample.slice().sort()).toEqual(stalledOwners.slice().sort());
    expect(res.cadenceDrift).toEqual(cadenceOwners);
    expect(autoPause).toHaveBeenCalledTimes(5);
    expect(autoPause.mock.calls.map((call) => call[1]).sort()).toEqual(
      stalledOwners.map((ownerId) => `rt-${ownerId}`).sort(),
    );
    for (const ownerId of cadenceOwners) {
      expect(autoPause).not.toHaveBeenCalledWith(sql, `rt-${ownerId}`, expect.anything());
    }
  });

  // Companion to the case above: identical drift statistics, but the fire is NOT late. This pins
  // that the sweep hands the settling-gate inputs (parked / nextFireAt) through to
  // computeCadenceDrift. If it ever passed a projection that dropped them, loop.test.ts would
  // stay green while the advisory silently fired on every mid-turn loop.
  it('does NOT report cadence drift for a parked loop with the same drift statistics', async () => {
    const sql = fakeSql([{ id: 'rt-parked', target_owner_id: 'su-parked' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-parked',
            status({
              ownerId: 'su-parked',
              turnsStalled: false,
              firesSinceArm: 5,
              expectedFiresSinceArm: 62,
              effectiveIntervalSec: 728.0376,
              cadenceRatio: 12.13396,
              longestObservedGapSec: 1207.28,
              parked: true,
              nextFireAt: '2026-08-01T00:00:00.000Z',
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.cadenceDrift).toEqual([]);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('no stalled owners → no auto-pause and no broadcast at all', async () => {
    const sql = fakeSql([{ id: 'rt_ok', target_owner_id: 'su-ok' }]);
    const getStatuses = vi.fn(async () => new Map([['su-ok', status({ ownerId: 'su-ok', turnsStalled: false })]]));
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a missing status (owner absent from the batch read) is never treated as stalled', async () => {
    const sql = fakeSql([{ id: 'rt_x', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(async () => new Map<string, LoopStatus>());
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('dryRun reports matches but neither disarms nor broadcasts', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(async () => new Map([['su-dead', status({ ownerId: 'su-dead', turnsStalled: true })]]));
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws', dryRun: true },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.dryRun).toBe(true);
    expect(res.paused).toBe(1);
    expect(res.sample).toEqual(['su-dead']);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('passes the discovered owner ids to getStatuses, deduped by owner (last routine row wins)', async () => {
    const sql = fakeSql([
      { id: 'rt_old', target_owner_id: 'su-dup' },
      { id: 'rt_new', target_owner_id: 'su-dup' },
    ]);
    const getStatuses = vi.fn(async (owners: readonly string[]) => {
      expect(owners).toEqual(['su-dup']);
      return new Map([['su-dup', status({ ownerId: 'su-dup', turnsStalled: true })]]);
    });
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    // Map insertion order means the LAST row for a duplicate owner wins.
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_new', expect.anything());
    expect(autoPause).not.toHaveBeenCalledWith(sql, 'rt_old', expect.anything());
  });

  // EI-19362678179163398 — the second-source veto. `turnsStalled` rests on `last_turn_at`,
  // which has under-reported twice; these lock in that a demonstrably-working agent is never
  // disarmed on that column alone, WITHOUT blunting the comatose-host case the guard is for.
  describe('second-source veto on lastRealTurnAt (EI-19362678179163398)', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    // The veto deliberately warns: a non-zero veto count is the live tell that
    // `last_turn_at` is under-reporting again, and it must reach the operator log rather
    // than vanish. Captured (not silenced) so the tests assert it actually fires.
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it('REFUSES to disarm a turnsStalled owner that produced a real turn inside the floor', async () => {
      const sql = fakeSql([{ id: 'rt_live', target_owner_id: 'su-live' }]);
      const getStatuses = vi.fn(
        async () =>
          new Map([
            [
              'su-live',
              // Exactly the measured false positive: last_turn_at hours stale, yet a real
              // assistant turn landed ~2 min ago.
              status({
                ownerId: 'su-live',
                turnsStalled: true,
                intervalSec: 60,
                lastTurnAt: ago(4 * 60 * 60_000),
                lastRealTurnAt: ago(2 * 60_000),
              }),
            ],
          ]),
      );
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
      );

      expect(res.paused).toBe(0);
      expect(res.vetoedByRecentTurn).toEqual(['su-live']);
      expect(autoPause).not.toHaveBeenCalled();
      // Nothing was disarmed, so there is no fleet-wide event to announce.
      expect(broadcast).not.toHaveBeenCalled();
      // The refusal must be visible in the operator log, not silent.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('VETO su-live'));
    });

    it('still disarms a comatose host — an ancient real turn must NOT engage the veto', async () => {
      const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-comatose' }]);
      const getStatuses = vi.fn(
        async () =>
          new Map([
            [
              'su-comatose',
              status({
                ownerId: 'su-comatose',
                turnsStalled: true,
                intervalSec: 60,
                lastRealTurnAt: ago(6 * 60 * 60_000),
              }),
            ],
          ]),
      );
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
      );

      expect(res.paused).toBe(1);
      expect(res.vetoedByRecentTurn).toEqual([]);
      expect(autoPause).toHaveBeenCalledWith(sql, 'rt_dead', expect.stringContaining('WI-6639'));
      expect(warn).not.toHaveBeenCalled();
    });

    it('a MISSING lastRealTurnAt never engages the veto (liveness is never inferred from absent data)', async () => {
      const sql = fakeSql([{ id: 'rt_null', target_owner_id: 'su-null' }]);
      const getStatuses = vi.fn(
        async () => new Map([['su-null', status({ ownerId: 'su-null', turnsStalled: true, lastRealTurnAt: null })]]),
      );
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
      );

      expect(res.paused).toBe(1);
      expect(res.vetoedByRecentTurn).toEqual([]);
      expect(autoPause).toHaveBeenCalledTimes(1);
    });

    it('sizes the veto window from turnsStalledFloorMs — the SAME floor the verdict uses', async () => {
      // One real turn age (45 min), two intervals. floor(60s) = 30min  -> 45min is OUTSIDE, disarm.
      // floor(1200s) = 80min -> 45min is INSIDE, veto. Pins the guard's window to the verdict's.
      const mk = async (intervalSec: number) => {
        const sql = fakeSql([{ id: 'rt', target_owner_id: 'su-x' }]);
        const getStatuses = vi.fn(
          async () =>
            new Map([
              ['su-x', status({ ownerId: 'su-x', turnsStalled: true, intervalSec, lastRealTurnAt: ago(45 * 60_000) })],
            ]),
        );
        const autoPause = vi.fn(async () => {});
        const broadcast = vi.fn<BroadcastFn>(async () => true);
        return sweepStalledLoops(
          { sql, workspaceId: 'ws' },
          { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
        );
      };

      expect(turnsStalledFloorMs(60)).toBe(30 * 60_000);
      expect(turnsStalledFloorMs(1200)).toBe(80 * 60_000);

      const tight = await mk(60);
      expect(tight.paused).toBe(1);
      expect(tight.vetoedByRecentTurn).toEqual([]);

      const wide = await mk(1200);
      expect(wide.paused).toBe(0);
      expect(wide.vetoedByRecentTurn).toEqual(['su-x']);
    });
  });
});

/**
 * EI-19441932615368003 — WALLED, not stalled.
 *
 * The live incident: on 2026-08-03 three sweeps (11:07Z / 13:07Z / 14:07Z) disarmed 7 + 2 + 6
 * loops on one workspace. At least two were provider-walled rather than dead — su-b9269a31
 * (~4h silent) and su-3a5df0ae (~2h50m, ended only when a human typed "continue where you left
 * off"). Each was correctly backed off by the lifecycle-death re-arm and would have resumed on
 * its own; disarming converted a self-healing wait into a permanent halt.
 *
 * These cases are written as SINGLE-CONDITION REMOVALS around that shape, so the suite fails if
 * the exemption is ever widened into a blanket "never disarm anything with an error outcome" —
 * which would blunt the guard back into the inert state WI-6639 exists to fix.
 */
describe('sweepStalledLoops — walled vs stalled (EI-19441932615368003)', () => {
  const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  let warn: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    logSpy.mockRestore();
  });

  /** The exact shape of the 2026-08-03 incident: fire landed, provider killed the turn, the
   *  backoff parked next_fire_at ~3h out, and no turn can land until the wall lifts. */
  const walled = (ownerId: string, overrides: Partial<LoopStatus> = {}) =>
    status({
      ownerId,
      turnsStalled: true,
      intervalSec: 1200,
      lastFiredAt: ago(2 * 60 * 60_000),
      lastTurnAt: ago(4 * 60 * 60_000),
      lastRealTurnAt: ago(4 * 60 * 60_000),
      lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
      nextFireAt: inFuture(3 * 60 * 60_000),
      ...overrides,
    });

  it('REFUSES to disarm a loop backed off on a provider wall — the measured incident', async () => {
    const sql = fakeSql([{ id: 'rt_walled', target_owner_id: 'su-walled' }]);
    const getStatuses = vi.fn(async () => new Map([['su-walled', walled('su-walled')]]));
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause, rearm, broadcast });

    expect(res.paused).toBe(0);
    expect(res.vetoedByProviderWall).toEqual(['su-walled']);
    expect(autoPause).not.toHaveBeenCalled();
    // SKIP, never re-arm: the backoff already computed a provider-informed next_fire_at, and
    // overwriting it with a plain interval would fire straight back into the wall.
    expect(rearm).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WALLED su-walled'));
  });

  it('recognizes the OTHER observer prefix too (resume-turn-death:) — matching only one was itself a past bug', async () => {
    const sql = fakeSql([{ id: 'rt_fast', target_owner_id: 'su-fast' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-fast', walled('su-fast', { lastDeliveryOutcome: 'resume-turn-death:usage_limit' })]]),
    );
    const autoPause = vi.fn(async () => {});

    const res = await sweepStalledLoops({ sql, workspaceId: 'ws' }, { getStatuses, autoPause });

    expect(res.vetoedByProviderWall).toEqual(['su-fast']);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('SINGLE CONDITION REMOVED — backoff has ELAPSED (next fire in the past) ⇒ genuinely stuck, DISARM', async () => {
    const sql = fakeSql([{ id: 'rt_elapsed', target_owner_id: 'su-elapsed' }]);
    const getStatuses = vi.fn(
      async () =>
        // Same wall, but the retry window has passed and STILL no turn followed. That is no
        // longer "waiting out a transient condition" — it is wedged, and the guard must act.
        new Map([['su-elapsed', walled('su-elapsed', { nextFireAt: ago(30 * 60_000) })]]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.vetoedByProviderWall).toEqual([]);
    expect(res.paused).toBe(1);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });

  it('SINGLE CONDITION REMOVED — an ORDINARY stall outcome ⇒ DISARM (the exemption is not a blanket error-amnesty)', async () => {
    const sql = fakeSql([{ id: 'rt_plain', target_owner_id: 'su-plain' }]);
    const getStatuses = vi.fn(
      async () =>
        // A future nextFireAt alone must never exempt: every healthy armed loop has one.
        new Map([['su-plain', walled('su-plain', { lastDeliveryOutcome: 'loop-stuck-backstop' })]]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.vetoedByProviderWall).toEqual([]);
    expect(res.paused).toBe(1);
  });

  it('SINGLE CONDITION REMOVED — a comatose host with NO delivery outcome is still disarmed', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(async () => new Map([['su-dead', walled('su-dead', { lastDeliveryOutcome: null })]]));
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    expect(res.paused).toBe(1);
    expect(res.vetoedByProviderWall).toEqual([]);
  });

  it('separates walled from comatose in ONE sweep — the shape of the live 14:07Z batch', async () => {
    const sql = fakeSql([
      { id: 'rt_w', target_owner_id: 'su-walled' },
      { id: 'rt_d', target_owner_id: 'su-dead' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-walled', walled('su-walled')],
          ['su-dead', walled('su-dead', { lastDeliveryOutcome: null, nextFireAt: null })],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false) },
    );

    // The whole point: one sweep, two populations, opposite dispositions.
    expect(res.vetoedByProviderWall).toEqual(['su-walled']);
    expect(res.sample).toEqual(['su-dead']);
    expect(res.paused).toBe(1);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });
});

describe('sweepStalledLoops — fire-starved vs turn-stalled (EI-19406534159939583)', () => {
  // Both populations below were observed LIVE in the same fleet on 2026-08-03, which is what
  // makes this a discrimination test rather than a shape test: the guard used to disarm both.
  //
  // NOTE the shapes deliberately: FIRE_STARVED and DEAD_SAME_SHAPE are BYTE-IDENTICAL. That is
  // the whole point — turn ordering alone cannot tell a live fire-starved agent from a WI-6639
  // corpse (whose last turn also lands shortly after its last fire), so the two tests using them
  // differ ONLY in what the reachability probe says. If someone later "simplifies" the guard back
  // to an ordering check, those two tests cannot both pass.
  const FIRE_STARVED = {
    // Answered its last fire (turn AFTER fire), then nothing fired at it again.
    lastFiredAt: '2026-08-03T03:21:00.000Z',
    lastTurnAt: '2026-08-03T03:25:00.000Z',
  };
  const DEAD_SAME_SHAPE = FIRE_STARVED;
  const NO_POST_ARM_FIRE = {
    // The prior fire and turn are both before the current arm; this is deliberately
    // not the answered-last-fire shape above, so only `fireStarved` admits it.
    armedAt: '2026-08-03T03:30:00.000Z',
    lastFiredAt: '2026-08-03T03:21:00.000Z',
    lastTurnAt: '2026-08-03T03:00:00.000Z',
    firesSinceArm: 0,
    expectedFiresSinceArm: 3,
  };
  const COMATOSE = {
    // A fire landed and no turn ever followed it (turn BEFORE fire) — the classic WI-6639 shape.
    lastFiredAt: '2026-08-03T03:25:00.000Z',
    lastTurnAt: '2026-08-03T01:00:00.000Z',
  };

  // The FIRE-STARVED branch warns deliberately (it is an infrastructure finding that must reach
  // the operator log). Silence it here the same way the veto tests above do.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('re-arms a fire-starved loop and NEVER disarms it', async () => {
    const sql = fakeSql([{ id: 'rt_starved', target_owner_id: 'su-starved' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-starved', status({ ownerId: 'su-starved', turnsStalled: true, ...FIRE_STARVED })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(autoPause).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(rearm.mock.calls[0][1]).toBe('rt_starved');
    expect(res.paused).toBe(0);
    expect(res.reArmedFireStarved).toEqual(['su-starved']);
  });

  it('admits a fireStarved-only no-post-arm-fire status and re-arms a reachable owner', async () => {
    const sql = fakeSql([{ id: 'rt-no-post-arm-fire', target_owner_id: 'su-no-post-arm-fire' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-no-post-arm-fire',
            status({
              ownerId: 'su-no-post-arm-fire',
              turnsStalled: false,
              fireStarved: true,
              ...NO_POST_ARM_FIRE,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(probeReachability).toHaveBeenCalledWith('su-no-post-arm-fire');
    expect(rearm).toHaveBeenCalledWith(
      sql,
      'rt-no-post-arm-fire',
      expect.stringContaining('fire-starved'),
    );
    expect(autoPause).not.toHaveBeenCalled();
    expect(res.reArmedFireStarved).toEqual(['su-no-post-arm-fire']);
    expect(res.paused).toBe(0);
  });

  it('CONTROL — the same fireStarved-only no-post-arm-fire shape is disarmed for an unreachable corpse', async () => {
    const sql = fakeSql([{ id: 'rt-no-post-arm-corpse', target_owner_id: 'su-no-post-arm-corpse' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-no-post-arm-corpse',
            status({
              ownerId: 'su-no-post-arm-corpse',
              turnsStalled: false,
              fireStarved: true,
              ...NO_POST_ARM_FIRE,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(false);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(probeReachability).toHaveBeenCalledWith('su-no-post-arm-corpse');
    expect(rearm).not.toHaveBeenCalled();
    expect(autoPause).toHaveBeenCalledWith(
      sql,
      'rt-no-post-arm-corpse',
      expect.stringContaining('WI-6639'),
    );
    expect(res.reArmedFireStarved).toEqual([]);
    expect(res.paused).toBe(1);
  });

  it('WI-6554700010012442 — re-arms (never vetoes) a fire-starved loop whose owner keeps taking real turns via other wakes', async () => {
    const sql = fakeSql([{ id: 'rt-starved-busy', target_owner_id: 'su-starved-busy' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-starved-busy',
            status({
              ownerId: 'su-starved-busy',
              turnsStalled: false,
              fireStarved: true,
              ...NO_POST_ARM_FIRE,
              lastRealTurnAt: new Date(Date.now() - 30_000).toISOString(),
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(false);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(rearm).toHaveBeenCalledWith(sql, 'rt-starved-busy', expect.stringContaining('WI-6554700010012442'));
    expect(autoPause).not.toHaveBeenCalled();
    expect(res.reArmedFireStarved).toEqual(['su-starved-busy']);
    expect(res.vetoedByRecentTurn).toEqual([]);
    expect(res.paused).toBe(0);
  });

  it('THE DISCRIMINATION: identical turn/fire shape, UNREACHABLE owner → disarmed, not re-armed', async () => {
    // Byte-identical to the fire-starved case above. Only the reachability probe differs, and
    // that alone must flip the outcome — this is the WI-6639 corpse the ordering check would
    // have wrongly rescued.
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-dead', status({ ownerId: 'su-dead', turnsStalled: true, ...DEAD_SAME_SHAPE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(false);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(probeReachability).toHaveBeenCalledWith('su-dead');
    expect(rearm).not.toHaveBeenCalled();
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(res.reArmedFireStarved).toEqual([]);
  });

  it('an ERRORING reachability probe fails soft toward the REVERSIBLE mistake (re-arm)', async () => {
    // An uncertain read must never license an irreversible disarm — mirrors
    // checkUnreachableTerminalGuard's own fail-soft catch.
    const sql = fakeSql([{ id: 'rt_x', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-x', status({ ownerId: 'su-x', turnsStalled: true, ...FIRE_STARVED })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = vi.fn(async () => {
      throw new Error('probe unavailable');
    }) as never;
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(autoPause).not.toHaveBeenCalled();
    expect(res.reArmedFireStarved).toEqual(['su-x']);
  });

  it('still disarms the comatose population — the fix must not blunt the guard', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-dead', status({ ownerId: 'su-dead', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(rearm).not.toHaveBeenCalled();
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(res.reArmedFireStarved).toEqual([]);
  });

  it('separates the two in ONE sweep — the shape of the live incident', async () => {
    const sql = fakeSql([
      { id: 'rt_a', target_owner_id: 'su-starved-a' },
      { id: 'rt_b', target_owner_id: 'su-starved-b' },
      { id: 'rt_c', target_owner_id: 'su-dead-c' },
      { id: 'rt_d', target_owner_id: 'su-healthy-d' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-starved-a', status({ ownerId: 'su-starved-a', turnsStalled: true, ...FIRE_STARVED })],
          ['su-starved-b', status({ ownerId: 'su-starved-b', turnsStalled: true, ...FIRE_STARVED })],
          ['su-dead-c', status({ ownerId: 'su-dead-c', turnsStalled: true, ...COMATOSE })],
          ['su-healthy-d', status({ ownerId: 'su-healthy-d', turnsStalled: false })],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(res.reArmedFireStarved).toEqual(['su-starved-a', 'su-starved-b']);
    expect(res.sample).toEqual(['su-dead-c']);
    expect(res.paused).toBe(1);
    expect(res.checked).toBe(4);
    // One broadcast, and it must name BOTH findings — a reader who sees only the disarm half
    // goes looking for dead agents when the real fault is in the firing path.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const body = broadcast.mock.calls[0][0].body;
    expect(body).toContain('su-dead-c');
    expect(body).toContain('FIRE-STARVED');
    expect(body).toContain('su-starved-a');
  });

  it('broadcasts a fire-starved batch even when NOTHING was disarmed', async () => {
    // Before the split this case was silent: the only broadcast was gated on the disarm count,
    // so "every live agent stopped receiving fires" produced no fleet-wide signal at all.
    const sql = fakeSql([{ id: 'rt_a', target_owner_id: 'su-starved-a' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-starved-a', status({ ownerId: 'su-starved-a', turnsStalled: true, ...FIRE_STARVED })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].summary).toContain('stopped RECEIVING fires');
  });

  it('dryRun reports the fire-starved set without writing', async () => {
    const sql = fakeSql([{ id: 'rt_a', target_owner_id: 'su-starved-a' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-starved-a', status({ ownerId: 'su-starved-a', turnsStalled: true, ...FIRE_STARVED })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws', dryRun: true },
      { getStatuses, autoPause, rearm, probeReachability, broadcast },
    );

    expect(res.reArmedFireStarved).toEqual(['su-starved-a']);
    expect(rearm).not.toHaveBeenCalled();
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  // ── EI-19899301656065801: the OWNER page beside the FLEET broadcast ──────────────
  // The guard already escalated a disarm to the fleet via broadcastSevereEvent. The gap was
  // AUDIENCE, not silence: no peer has a mandate to revive someone else's session, and a
  // disarmed loop cannot re-arm itself (reconcileLoopRoutines gates its rescue on active=TRUE),
  // so a still-REACHABLE session that gets disarmed is permanently dark until a human acts.
  // Measured instance: su-4a6e2255 disarmed 2026-08-04T09:07:15Z, dark 4d6h, recovered only
  // because the owner resumed it by hand.
  //
  // The gate is REACHABILITY, and these tests are built so that gate cannot be quietly widened:
  // the reachable and unreachable cases are byte-identical but for `reach(true|false)`, so a
  // change that pages unconditionally fails the second, and one that never pages fails the first.

  it('EI-19899301656065801: pages the OWNER when a still-REACHABLE session is disarmed', async () => {
    const sql = fakeSql([{ id: 'rt_comatose', target_owner_id: 'su-comatose' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-comatose', status({ ownerId: 'su-comatose', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    // It really was DISARMED (not re-armed) — otherwise the page would be about the wrong event.
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(rearm).not.toHaveBeenCalled();
    expect(res.paused).toBe(1);

    expect(notify).toHaveBeenCalledTimes(1);
    const page = notify.mock.calls[0][0];
    expect(page.kind).toBe('intervention');
    expect(page.importance).toBe('urgent');
    expect(page.title).toContain('su-comatose');
    expect(page.body).toContain('su-comatose');

    // BESIDE the broadcast, never replacing it — the fleet signal is a different job.
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('EI-19899301656065801: does NOT page when the disarmed owner is already gone (the WI-6639 corpse)', async () => {
    // Byte-identical to the case above except the reachability probe. Disarming a session that
    // ended long ago is pure hygiene and must stay as silent as it was before this landed —
    // WI-6639's original population was 15 loops whose sessions had ALREADY ended.
    const sql = fakeSql([{ id: 'rt_corpse', target_owner_id: 'su-corpse' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-corpse', status({ ownerId: 'su-corpse', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(false);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    // The FLEET is still told — only the owner page is withheld.
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('EI-19899301656065801: does NOT page a FIRE-STARVED loop — it was re-armed, not disarmed', async () => {
    // Self-healing: the loop is re-armed, so there is nothing for a human to do.
    const sql = fakeSql([{ id: 'rt_starved', target_owner_id: 'su-starved' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-starved', status({ ownerId: 'su-starved', turnsStalled: true, ...FIRE_STARVED })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(rearm).toHaveBeenCalledTimes(1);
    expect(autoPause).not.toHaveBeenCalled();
    expect(res.reArmedFireStarved).toEqual(['su-starved']);
    expect(notify).not.toHaveBeenCalled();
  });

  it('EI-19899301656065801: a FAILING owner page never costs the disarm or the broadcast', async () => {
    // Paging is strictly an addition to this sweep's job. A dead push transport must not roll
    // back bookkeeping that already succeeded.
    const sql = fakeSql([{ id: 'rt_comatose', target_owner_id: 'su-comatose' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-comatose', status({ ownerId: 'su-comatose', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {
      throw new Error('push transport down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(res.dryRun).toBe(false);
    // and it says so rather than swallowing the failure silently
    expect(warn.mock.calls.some((c) => String(c[0]).includes('owner page failed'))).toBe(true);
    warn.mockRestore();
  });

  it('EI-19899301656065801: dryRun pages nobody', async () => {
    const sql = fakeSql([{ id: 'rt_comatose', target_owner_id: 'su-comatose' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-comatose', status({ ownerId: 'su-comatose', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const probeReachability = reach(true);
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws', dryRun: true },
      { getStatuses, autoPause, rearm, probeReachability, broadcast, notify },
    );

    expect(res.dryRun).toBe(true);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

/**
 * WI-36685 — the FOURTH population. Fires kept arriving and every one reached NOBODY, because
 * no standing inbox-wake await was registered, so no `event_wake_deliveries` row was created and
 * the agent was never asked for a turn.
 *
 * `lastWakeAt` is the whole discriminator and it is DERIVED as COALESCE(delivered_at, created_at)
 * (loop.ts:1069) — a row created but never delivered would still advance it, so frozen-under-an-
 * advancing-lastFiredAt can only mean no row was created at all.
 */
describe('sweepStalledLoops — WAKE-STARVED: fires that reached nobody (WI-36685)', () => {
  // This suite is fail-on-console and every branch here logs its reasoning by design.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const FIRED = '2026-08-01T02:00:00.000Z';
  /** Well beyond turnsStalledFloorMs(60) = 30min: the last delivery is ~2h before the last fire. */
  const WAKE_FROZEN = '2026-08-01T00:00:00.000Z';

  it('repairs (arms the watch, then re-arms the loop) instead of disarming, when the await is the only thing missing', async () => {
    const sql = fakeSql([{ id: 'rt_starved', target_owner_id: 'su-starved' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-starved',
            status({
              ownerId: 'su-starved',
              turnsStalled: true,
              lastFiredAt: FIRED,
              lastWakeAt: WAKE_FROZEN,
              // The signature that fools every earlier exemption: the last TURN precedes the last
              // fire, so `answeredItsLastFire` is false and the FIRE-STARVED branch declines.
              lastTurnAt: WAKE_FROZEN,
              lastRealTurnAt: WAKE_FROZEN,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const armWake = vi.fn<ArmWakeFn>(async () => ({}));
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, armWake, probeReachability: wakeStarvedProbe(), broadcast, notify },
    );

    expect(res.repairedWakeStarved).toEqual(['su-starved']);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
    // The owner page is for PERMANENTLY disarmed sessions. Nothing was disarmed, so nobody is paged.
    expect(notify).not.toHaveBeenCalled();

    // BOTH writes, and the arm must come first — a nudge without a restored watch just
    // black-holes another fire, which is the specific half-fix this branch exists to avoid.
    expect(armWake).toHaveBeenCalledTimes(1);
    expect(armWake.mock.calls[0]?.[0]?.ownerId).toBe('su-starved');
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(rearm.mock.calls[0]?.[1]).toBe('rt_starved');
    expect(rearm.mock.calls[0]?.[2]).toContain('WI-36685');
    expect(armWake.mock.invocationCallOrder[0]).toBeLessThan(rearm.mock.invocationCallOrder[0]!);
  });

  it('CONTROL — a corpse with the SAME frozen lastWakeAt is still disarmed, because nothing is repairable', async () => {
    // This is the falsifiability control for the branch above, and it is the case that makes the
    // repairability gate load-bearing rather than decorative: a dead session's standing await was
    // cancelled by its SessionEnd hook, so its later fires ALSO create no delivery rows and its
    // `lastWakeAt` is frozen in exactly the same way. The history test alone cannot separate them.
    const sql = fakeSql([{ id: 'rt_corpse', target_owner_id: 'su-corpse' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-corpse',
            status({
              ownerId: 'su-corpse',
              turnsStalled: true,
              lastFiredAt: FIRED,
              lastWakeAt: WAKE_FROZEN,
              lastTurnAt: WAKE_FROZEN,
              lastRealTurnAt: WAKE_FROZEN,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const armWake = vi.fn<ArmWakeFn>(async () => ({}));
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      // reach(false): unreachable AND not repairable — the corpse shape.
      { getStatuses, autoPause, rearm, armWake, probeReachability: reach(false), broadcast, notify },
    );

    expect(res.repairedWakeStarved).toEqual([]);
    expect(res.paused).toBe(1);
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_corpse', expect.stringContaining('WI-6639'));
    // Never arm a watch for a dead session: that manufactures the zombie await that reads as a
    // false `parked`/`wakeable` session and pins it against the idle-session-reaper.
    expect(armWake).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
  });

  it('CONTROL — a DELIVERED-but-wedged loop is NOT wake-starved and is disarmed (EI-19478552459475620)', async () => {
    // The other direction, and the reason the discriminator is `lastWakeAt` rather than "did a
    // turn happen": there, wakes ARE delivered (lastWakeStatus 'delivered', channel
    // 'psu-socket-reset', no error) into a CLI child wedged on memory reclaim. `lastWakeAt`
    // tracks the fires, so this branch must not claim it — the agent really was asked and really
    // did not answer.
    const sql = fakeSql([{ id: 'rt_wedged', target_owner_id: 'su-wedged' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-wedged',
            status({
              ownerId: 'su-wedged',
              turnsStalled: true,
              lastFiredAt: FIRED,
              // The wake landed one second after the fire — delivery is healthy.
              lastWakeAt: '2026-08-01T02:00:01.000Z',
              lastWakeStatus: 'delivered',
              lastWakeChannel: 'psu-socket-reset',
              lastTurnAt: WAKE_FROZEN,
              lastRealTurnAt: WAKE_FROZEN,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const armWake = vi.fn<ArmWakeFn>(async () => ({}));
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      // Deliberately the REPAIRABLE probe: if the branch were keyed on reachability alone rather
      // than on the delivery history, this test would wrongly repair. It must disarm anyway.
      { getStatuses, autoPause, rearm, armWake, probeReachability: wakeStarvedProbe(), broadcast, notify },
    );

    expect(res.repairedWakeStarved).toEqual([]);
    expect(res.paused).toBe(1);
    expect(armWake).not.toHaveBeenCalled();
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_wedged', expect.stringContaining('WI-6639'));
  });

  describe('cold delivered reset handoff (EI-20502003602774122)', () => {
    const FIRED = '2026-08-15T07:22:00.000Z';
    const DELIVERED = '2026-08-15T07:22:01.000Z';

    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    const coldDelivered = (ownerId: string) =>
      status({
        ownerId,
        turnsStalled: true,
        carry: 'cold',
        lastFiredAt: FIRED,
        lastWakeAt: DELIVERED,
        lastWakeStatus: 'delivered',
        lastWakeChannel: 'psu-socket-reset',
        lastTurnAt: null,
        lastRealTurnAt: null,
      });

    it('vetoes the premature disarm when a delivered cold reset already has agent-authored activity', async () => {
      const sql = fakeSql([{ id: 'rt-cold', target_owner_id: 'su-cold' }]);
      const getStatuses = vi.fn(async () => new Map([['su-cold', coldDelivered('su-cold')]]));
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const readOwnerToolActivity = vi.fn(
        async () =>
          new Map([
            [
              'su-cold',
              // One tool, not OK, is intentional: the cold-specific grace is keyed on strict
              // agent-authored activity, while the general retry-storm veto remains stricter.
              { calls: 1, distinctTools: 1, okCalls: 0, lastCallAt: DELIVERED },
            ],
          ]),
      );

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, broadcast, readOwnerToolActivity, probeReachability: reach(false) },
      );

      expect(res.paused).toBe(0);
      expect(res.vetoedByToolActivity).toEqual(['su-cold']);
      expect(autoPause).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('COLD DELIVERED WAKE VETO su-cold'));
    });

    it('does not treat cold delivery alone as proof of productivity — the wedged handoff still disarms', async () => {
      const sql = fakeSql([{ id: 'rt-cold-wedged', target_owner_id: 'su-cold-wedged' }]);
      const getStatuses = vi.fn(async () => new Map([['su-cold-wedged', coldDelivered('su-cold-wedged')]]));
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const readOwnerToolActivity = vi.fn(async () => new Map());

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, broadcast, readOwnerToolActivity, probeReachability: reach(false) },
      );

      expect(res.paused).toBe(1);
      expect(res.vetoedByToolActivity).toEqual([]);
      expect(autoPause).toHaveBeenCalledWith(sql, 'rt-cold-wedged', expect.stringContaining('WI-6639'));
    });
  });

  it('a FAILED arm does not re-arm the loop and does not report a repair — it falls through to the disarm', async () => {
    // Half-repairing is worse than not repairing: a nudged loop with no standing watch fires
    // straight back into the same hole, while `repairedWakeStarved` would claim it was fixed.
    const sql = fakeSql([{ id: 'rt_starved', target_owner_id: 'su-starved' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-starved',
            status({
              ownerId: 'su-starved',
              turnsStalled: true,
              lastFiredAt: FIRED,
              lastWakeAt: WAKE_FROZEN,
              lastTurnAt: WAKE_FROZEN,
              lastRealTurnAt: WAKE_FROZEN,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const armWake = vi.fn<ArmWakeFn>(async () => {
      throw new Error('await store unavailable');
    });
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, armWake, probeReachability: wakeStarvedProbe(), broadcast, notify },
    );

    expect(res.repairedWakeStarved).toEqual([]);
    expect(rearm).not.toHaveBeenCalled();
    expect(res.paused).toBe(1);
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_starved', expect.anything());
  });

  it('dryRun reports the repair without performing either write', async () => {
    const sql = fakeSql([{ id: 'rt_starved', target_owner_id: 'su-starved' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-starved',
            status({
              ownerId: 'su-starved',
              turnsStalled: true,
              lastFiredAt: FIRED,
              lastWakeAt: WAKE_FROZEN,
              lastTurnAt: WAKE_FROZEN,
              lastRealTurnAt: WAKE_FROZEN,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const armWake = vi.fn<ArmWakeFn>(async () => ({}));
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws', dryRun: true },
      { getStatuses, autoPause, rearm, armWake, probeReachability: wakeStarvedProbe(), broadcast },
    );

    expect(res.repairedWakeStarved).toEqual(['su-starved']);
    expect(armWake).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts the starved population when nothing was disarmed, naming the wake-starved cause', async () => {
    const sql = fakeSql([{ id: 'rt_starved', target_owner_id: 'su-starved' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-starved',
            status({
              ownerId: 'su-starved',
              turnsStalled: true,
              lastFiredAt: FIRED,
              lastWakeAt: WAKE_FROZEN,
              lastTurnAt: WAKE_FROZEN,
              lastRealTurnAt: WAKE_FROZEN,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const armWake = vi.fn<ArmWakeFn>(async () => ({}));
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, rearm, armWake, probeReachability: wakeStarvedProbe(), broadcast },
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]?.[0];
    // A wake-starved-only sweep names ITS OWN fault in the summary rather than the generic
    // "starved" wording: fires-stopped and fires-reached-nobody point at different code, and a
    // reader paged by this line should not have to open the body to tell them apart.
    expect(call?.summary).toContain('reach NOBODY');
    expect(call?.summary).toContain('WI-36685');
    expect(call?.summary).not.toContain('stopped RECEIVING fires');
    expect(call?.body).toContain('WAKE-STARVED');
    expect(call?.body).toContain('su-starved');
    // The fire-starved half must not be fabricated when that population is empty.
    expect(call?.body).not.toContain('FIRE-STARVED');
  });

  it('an owner whose lastWakeAt tracks its fires is left to the existing branches entirely', async () => {
    // Calibration: the branch must not claim a HEALTHY-delivery loop. Without this, a bug that
    // made `wakeStarved` always-true would still pass every test above.
    const sql = fakeSql([{ id: 'rt_ok', target_owner_id: 'su-ok' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-ok',
            status({
              ownerId: 'su-ok',
              turnsStalled: false,
              lastFiredAt: FIRED,
              lastWakeAt: FIRED,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn(async () => {});
    const armWake = vi.fn<ArmWakeFn>(async () => ({}));
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, armWake, probeReachability: wakeStarvedProbe(), broadcast },
    );

    expect(res.repairedWakeStarved).toEqual([]);
    expect(res.paused).toBe(0);
    expect(armWake).not.toHaveBeenCalled();
    expect(autoPause).not.toHaveBeenCalled();
  });

  describe('withheld-fire veto (WI-36792)', () => {
    it('refuses to disarm when the last fire was WITHHELD by the gate — not repairable, but nothing to repair', async () => {
      // Same wake-starved shape as the corpse CONTROL above (not repairable), but this owner's
      // most recent fire never actually went out: the fire gate withheld it, which is why
      // lastWakeAt is frozen too (a withheld fire creates no delivery row, same as a black-holed
      // one). There is nothing for armWake to fix — the standing await is INTACT, which is
      // exactly why the probe reports it REACHABLE: a withheld fire never reached wake(), so
      // Gate 1 of deriveWakeReachability passes and the verdict measures real liveness rather
      // than returning false by construction. Must be vetoed, not disarmed.
      const sql = fakeSql([{ id: 'rt_withheld', target_owner_id: 'su-withheld' }]);
      const getStatuses = vi.fn(
        async () =>
          new Map([
            [
              'su-withheld',
              status({
                ownerId: 'su-withheld',
                turnsStalled: true,
                lastFiredAt: FIRED,
                lastWakeAt: WAKE_FROZEN,
                lastTurnAt: WAKE_FROZEN,
                lastRealTurnAt: WAKE_FROZEN,
                // The discriminator: the gate withheld THIS fire (at/after lastFiredAt), not a
                // stale one from an earlier cycle.
                lastWithheldAt: FIRED,
              }),
            ],
          ]),
      );
      const autoPause = vi.fn(async () => {});
      const rearm = vi.fn<RearmFn>(async () => {});
      const armWake = vi.fn<ArmWakeFn>(async () => ({}));
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const notify = vi.fn<NotifyFn>(async () => {});

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        // Not repairable (nothing is broken) but REACHABLE — the live-session shape. That pair is
        // what distinguishes this population from a corpse; repairability alone cannot, because
        // both read `awaitRepairable: false`.
        { getStatuses, autoPause, rearm, armWake, probeReachability: reach(true), broadcast, notify },
      );

      expect(res.vetoedByWithheldFire).toEqual(['su-withheld']);
      expect(res.paused).toBe(0);
      expect(autoPause).not.toHaveBeenCalled();
      // VETOED, not repaired and not re-armed — the gate's own backoff owns this loop's cadence.
      expect(armWake).not.toHaveBeenCalled();
      expect(rearm).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'live owner', reachable: true, paused: 0 },
      { label: 'dead owner', reachable: false, paused: 1 },
      { label: 'unavailable reachability', reachable: null, paused: 0 },
    ])('honours a withheld fire after a recent delivered wake: $label (WI-10007162)', async ({ reachable, paused }) => {
      const now = Date.now();
      const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
      const ownerId = 'su-withheld-recent';
      const sql = fakeSql([{ id: 'rt_withheld_recent', target_owner_id: ownerId }]);
      const getStatuses = vi.fn(async () => new Map([[ownerId, status({
        ownerId,
        turnsStalled: true,
        lastFiredAt: iso(-60_000),
        lastWithheldAt: iso(-59_000),
        lastWithheldReason: 'fire-gate',
        nextFireAt: iso(5 * 60_000),
        // The October 6 incident: the previous wake was delivered four minutes before
        // this withheld fire, so it is inside the thirty-minute wake-starvation floor.
        lastWakeAt: iso(-5 * 60_000),
        lastTurnAt: iso(-35 * 60_000),
        lastRealTurnAt: iso(-35 * 60_000),
      })]]));
      const autoPause = vi.fn<AutoPauseFn>(async () => {});
      const rearm = vi.fn<RearmFn>(async () => {});
      const armWake = vi.fn<ArmWakeFn>(async () => ({}));
      const probeReachability = reachable === null
        ? vi.fn(async () => { throw new Error('reachability unavailable'); })
        : reach(reachable);
      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, rearm, armWake, probeReachability,
          readOwnerToolActivity: async () => new Map(),
          broadcast: vi.fn<BroadcastFn>(async () => true), notify: vi.fn<NotifyFn>(async () => {}) },
      );

      expect(res.paused).toBe(paused);
      expect(res.vetoedByWithheldFire).toEqual(paused ? [] : [ownerId]);
      expect(autoPause).toHaveBeenCalledTimes(paused);
      // Preserve the gate's retry time, and never repair a healthy standing await.
      expect(rearm).not.toHaveBeenCalled();
      expect(armWake).not.toHaveBeenCalled();
    });

    it('CONTROL — a WITHHELD fire on an owner the probe says is GONE is still disarmed (the veto must not blunt WI-6639)', async () => {
      // The control that decides the shape of this branch, and the reason it is not keyed on the
      // withhold stamp alone. A corpse does not merely TOLERATE a perpetual withhold, it
      // CONVERGES on one: with no standing await its wakes record `no-session-now`,
      // `consecutive_errors` climbs without bound (measured live on su-4a6e2255: 5 in minutes
      // after a relaunch), and the circuit's `base * 2^(errors-1)` backoff denies an
      // ever-growing share of its claims — while `lastWakeAt` stays frozen either way, so
      // `wakeStarved` is permanently true. Sample such a loop at any sweep and
      // `lastWithheldAt >= lastFiredAt` reads TRUE. A veto that engaged on that alone would
      // exempt WI-6639's ENTIRE original population (armed loops on sessions that had already
      // ENDED, 37h-158h) forever — silently converting this guard into a no-op for the exact
      // case it was built for.
      //
      // Byte-identical to the veto test above except for the probe verdict. That is the point:
      // reachability is the ONLY signal separating them.
      const sql = fakeSql([{ id: 'rt_withheld_corpse', target_owner_id: 'su-withheld-corpse' }]);
      const getStatuses = vi.fn(
        async () =>
          new Map([
            [
              'su-withheld-corpse',
              status({
                ownerId: 'su-withheld-corpse',
                turnsStalled: true,
                lastFiredAt: FIRED,
                lastWakeAt: WAKE_FROZEN,
                lastTurnAt: WAKE_FROZEN,
                lastRealTurnAt: WAKE_FROZEN,
                lastWithheldAt: FIRED,
              }),
            ],
          ]),
      );
      const autoPause = vi.fn(async () => {});
      const rearm = vi.fn<RearmFn>(async () => {});
      const armWake = vi.fn<ArmWakeFn>(async () => ({}));
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const notify = vi.fn<NotifyFn>(async () => {});

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, rearm, armWake, probeReachability: reach(false), broadcast, notify },
      );

      expect(res.vetoedByWithheldFire).toEqual([]);
      expect(res.paused).toBe(1);
      expect(autoPause).toHaveBeenCalledWith(sql, 'rt_withheld_corpse', expect.stringContaining('WI-6639'));
    });

    it('a FAILING reachability probe still vetoes — an UNCERTAIN read must not license a permanent disarm', async () => {
      // The control above is the only thing that clears the way to disarm, and it requires the
      // probe to have SUCCEEDED and said "gone". A probe that THREW measured nothing, and this
      // module's stated asymmetry (a wrong veto costs one sweep and self-corrects; a wrong
      // disarm is permanent) makes "unknown" fail toward the reversible mistake — the same
      // direction as the fire-starved branch's `.catch(() => true)`. Guards the `!== false`
      // in the condition: an `=== true` there would silently make a PG blip disarm live agents.
      const sql = fakeSql([{ id: 'rt_probe_fail', target_owner_id: 'su-probe-fail' }]);
      const getStatuses = vi.fn(
        async () =>
          new Map([
            [
              'su-probe-fail',
              status({
                ownerId: 'su-probe-fail',
                turnsStalled: true,
                lastFiredAt: FIRED,
                lastWakeAt: WAKE_FROZEN,
                lastTurnAt: WAKE_FROZEN,
                lastRealTurnAt: WAKE_FROZEN,
                lastWithheldAt: FIRED,
              }),
            ],
          ]),
      );
      const autoPause = vi.fn(async () => {});
      const rearm = vi.fn<RearmFn>(async () => {});
      const armWake = vi.fn<ArmWakeFn>(async () => ({}));
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const notify = vi.fn<NotifyFn>(async () => {});
      const probeReachability = vi.fn(async () => {
        throw new Error('pg pool exhausted');
      }) as unknown as NonNullable<StalledLoopsSweepDeps['probeReachability']>;

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, rearm, armWake, probeReachability, broadcast, notify },
      );

      expect(res.vetoedByWithheldFire).toEqual(['su-probe-fail']);
      expect(res.paused).toBe(0);
      expect(autoPause).not.toHaveBeenCalled();
    });

    it('CONTROL — the SAME wake-starved+unrepairable shape with NO withhold (or a STALE one) is still disarmed', async () => {
      // Falsifiability control: a veto that fires unconditionally on "not repairable" would pass
      // the test above and blunt the guard for every genuine corpse (WI-6639's original
      // population is exactly this: unreachable, not repairable, `lastWithheldAt` absent). Also
      // covers the direction of the `>=` comparison — a withhold timestamp from a PRIOR cycle
      // (strictly before this fire) must not retroactively excuse the current one.
      const sql = fakeSql([{ id: 'rt_corpse2', target_owner_id: 'su-corpse2' }]);
      const getStatuses = vi.fn(
        async () =>
          new Map([
            [
              'su-corpse2',
              status({
                ownerId: 'su-corpse2',
                turnsStalled: true,
                lastFiredAt: FIRED,
                lastWakeAt: WAKE_FROZEN,
                lastTurnAt: WAKE_FROZEN,
                lastRealTurnAt: WAKE_FROZEN,
                // A withhold from a STRICTLY EARLIER cycle than the current fire — must not
                // veto the current disarm.
                lastWithheldAt: WAKE_FROZEN,
              }),
            ],
          ]),
      );
      const autoPause = vi.fn(async () => {});
      const rearm = vi.fn<RearmFn>(async () => {});
      const armWake = vi.fn<ArmWakeFn>(async () => ({}));
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const notify = vi.fn<NotifyFn>(async () => {});

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, rearm, armWake, probeReachability: reach(false), broadcast, notify },
      );

      expect(res.vetoedByWithheldFire).toEqual([]);
      expect(res.paused).toBe(1);
      expect(autoPause).toHaveBeenCalledWith(sql, 'rt_corpse2', expect.stringContaining('WI-6639'));
      expect(armWake).not.toHaveBeenCalled();
      expect(rearm).not.toHaveBeenCalled();
    });

    it('does NOT veto when the wake-starved probe says the await IS repairable — repair still wins', async () => {
      // The veto must be reachable ONLY through the not-repairable branch. If it engaged
      // unconditionally on a withheld timestamp it would short-circuit the WI-36685 repair path
      // for a session that is actually fixable right now.
      const sql = fakeSql([{ id: 'rt_repair', target_owner_id: 'su-repair' }]);
      const getStatuses = vi.fn(
        async () =>
          new Map([
            [
              'su-repair',
              status({
                ownerId: 'su-repair',
                turnsStalled: true,
                lastFiredAt: FIRED,
                lastWakeAt: WAKE_FROZEN,
                lastTurnAt: WAKE_FROZEN,
                lastRealTurnAt: WAKE_FROZEN,
                lastWithheldAt: FIRED,
              }),
            ],
          ]),
      );
      const autoPause = vi.fn(async () => {});
      const rearm = vi.fn<RearmFn>(async () => {});
      const armWake = vi.fn<ArmWakeFn>(async () => ({}));
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const notify = vi.fn<NotifyFn>(async () => {});

      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, rearm, armWake, probeReachability: wakeStarvedProbe(), broadcast, notify },
      );

      expect(res.vetoedByWithheldFire).toEqual([]);
      expect(res.repairedWakeStarved).toEqual(['su-repair']);
      expect(res.paused).toBe(0);
      expect(armWake).toHaveBeenCalledTimes(1);
      expect(rearm).toHaveBeenCalledTimes(1);
    });
  });

  describe('await-suppression veto (WI-10005352)', () => {
    // The measured 2026-10-02 shape (su-ce50c06d), shifted onto the live clock: a wake delivered
    // at -53m, answered by a turn at -48m; the -42m fire suppressed on a blocking await and
    // re-armed to resume in +7m. Fire-to-wake is 11m, inside the 30m floor, so this is NOT
    // wake-starved and the withheld-fire veto above never sees it. computeTurnsStalled's
    // frozen-gap branch condemns it because no fire has landed for a floor's worth of time.
    const MIN = 60_000;
    function suppressedShape(over: Partial<LoopStatus> = {}) {
      const now = Date.now();
      const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
      return status({
        ownerId: 'su-suppressed',
        turnsStalled: true,
        lastWakeAt: iso(-53 * MIN),
        lastTurnAt: iso(-48 * MIN),
        lastRealTurnAt: iso(-48 * MIN),
        lastFiredAt: iso(-42 * MIN),
        lastWithheldAt: iso(-42 * MIN + 1_000),
        lastWithheldReason: 'await-blocking',
        nextFireAt: iso(7 * MIN),
        ...over,
      });
    }
    async function sweep(s: LoopStatus) {
      const sql = fakeSql([{ id: 'rt_suppressed', target_owner_id: 'su-suppressed' }]);
      const getStatuses = vi.fn(async () => new Map([['su-suppressed', s]]));
      const autoPause = vi.fn<AutoPauseFn>(async () => {});
      const rearm = vi.fn<RearmFn>(async () => {});
      const armWake = vi.fn<ArmWakeFn>(async () => ({}));
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const notify = vi.fn<NotifyFn>(async () => {});
      const res = await sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        { getStatuses, autoPause, rearm, armWake, probeReachability: reach(false), broadcast, notify },
      );
      return { res, autoPause, rearm };
    }

    it('refuses to disarm an owner whose last fire was await-suppressed with a resume still pending', async () => {
      const { res, autoPause, rearm } = await sweep(suppressedShape());

      expect(res.vetoedByAwaitSuppression).toEqual(['su-suppressed']);
      expect(res.paused).toBe(0);
      expect(autoPause).not.toHaveBeenCalled();
      // Left alone: the suppression re-arm already owns next_fire_at.
      expect(rearm).not.toHaveBeenCalled();
    });

    it('CONTROL — once the resume has passed with no fire or turn, the ordinary disarm applies', async () => {
      const { res, autoPause } = await sweep(suppressedShape({ nextFireAt: new Date(Date.now() - MIN).toISOString() }));

      expect(res.vetoedByAwaitSuppression).toEqual([]);
      expect(res.paused).toBe(1);
      expect(autoPause).toHaveBeenCalledTimes(1);
    });

    it('CONTROL — a newer fire past the withhold means the suppression is not the latest event', async () => {
      const { res } = await sweep(
        suppressedShape({ lastWithheldAt: new Date(Date.now() - 50 * MIN).toISOString() }),
      );

      expect(res.vetoedByAwaitSuppression).toEqual([]);
      expect(res.paused).toBe(1);
    });

    it('CONTROL — a fire-gate withhold is not this veto (keyed on the await-blocking reason)', async () => {
      const { res } = await sweep(suppressedShape({ lastWithheldReason: 'fire-gate' }));

      expect(res.vetoedByAwaitSuppression).toEqual([]);
    });
  });
});

describe('sweepStalledLoops — UNADDRESSABLE HARNESS: naming WHY the disarm happened (EI-19966210024116714)', () => {
  // A loop can be armed against a harness its OWN session scope cannot address: the routine sits
  // on workspace X while the owner's session_briefs row resolves to workspace Y, so every
  // harness-scoped call that session makes returns `harness_forbidden`. Its fires land, it cannot
  // reach the work it was woken for, no turn follows, and this sweep reaps it.
  //
  // The disarm is CORRECT and this branch does not change it. What it changes is the RECORD: the
  // generic "turns-stalled: N fire(s), last turn never" reason states the symptom and loses the
  // cause, and the remedy every other surface prints — "re-arm with loop:arm" — silently
  // re-creates the identical hole, because re-arming does not touch the session's scope.
  //
  // So the assertions here are deliberately about the REASON STRING and the two notices, not about
  // the disposition: a change that started re-arming or vetoing these would fail the disarm
  // assertions, and a change that dropped the explanation would fail the string ones.
  const COMATOSE = {
    lastFiredAt: '2026-08-03T03:25:00.000Z',
    lastTurnAt: '2026-08-03T01:00:00.000Z',
  };

  // The fail-open paths warn deliberately (an operator-log finding). Silence it here.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** The strand: the owner's own session resolves to a DIFFERENT workspace than its routine. */
  const stranded = (owner: string, ownerWs = 'default') =>
    vi.fn<ResolveOwnerWorkspacesFn>(async () => new Map([[owner, ownerWs]]));

  it('THE CASE: names the unaddressable harness in the disarm reason, with both workspaces', async () => {
    const sql = fakeSql([{ id: 'rt_strand', target_owner_id: 'su-strand' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-strand', status({ ownerId: 'su-strand', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        notify,
        probeReachability: reach(false),
        resolveOwnerWorkspaces: stranded('su-strand'),
      },
    );

    // Still DISARMED — this branch explains, it does not exempt.
    expect(res.paused).toBe(1);
    expect(res.disarmedUnaddressableHarness).toEqual(['su-strand']);
    expect(autoPause).toHaveBeenCalledTimes(1);

    const reason = autoPause.mock.calls[0][2];
    expect(reason).toContain('WI-6639'); // the existing prefix survives
    expect(reason).toContain('UNADDRESSABLE HARNESS');
    expect(reason).toContain("'ws'"); // the routine's workspace
    expect(reason).toContain("'default'"); // the session's actual scope
    expect(reason).toContain('harness_forbidden');
    // The distinct remedy — the whole reason this population is separated out.
    expect(reason).toContain('Re-arming alone will NOT fix this');
    expect(reason).toContain('EI-19966210024116714');
  });

  it('CONTROL — a MATCHING workspace is disarmed with the ordinary reason and never accused', async () => {
    // Byte-identical to the case above but for the resolved workspace, so a change that starts
    // accusing every disarm fails here while still passing the test above.
    const sql = fakeSql([{ id: 'rt_ok', target_owner_id: 'su-ok' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-ok', status({ ownerId: 'su-ok', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        probeReachability: reach(false),
        resolveOwnerWorkspaces: stranded('su-ok', 'ws'),
      },
    );

    expect(res.paused).toBe(1);
    expect(res.disarmedUnaddressableHarness).toEqual([]);
    expect(autoPause.mock.calls[0][2]).toContain('turns-stalled');
    expect(autoPause.mock.calls[0][2]).not.toContain('UNADDRESSABLE');
  });

  it('FAILS OPEN — an owner whose scope is UNKNOWN is disarmed but never accused', async () => {
    // Absent from the map is UNKNOWN, never "mismatched". A wrong accusation lands in a permanent
    // record, so only a CONFIRMED different workspace qualifies.
    const sql = fakeSql([{ id: 'rt_unknown', target_owner_id: 'su-unknown' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-unknown', status({ ownerId: 'su-unknown', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        probeReachability: reach(false),
        resolveOwnerWorkspaces: vi.fn<ResolveOwnerWorkspacesFn>(async () => new Map()),
      },
    );

    expect(res.paused).toBe(1);
    expect(res.disarmedUnaddressableHarness).toEqual([]);
    expect(autoPause.mock.calls[0][2]).not.toContain('UNADDRESSABLE');
  });

  it('a THROWING resolver costs the explanation and NOTHING else — the sweep still disarms + broadcasts', async () => {
    const sql = fakeSql([{ id: 'rt_x', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-x', status({ ownerId: 'su-x', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        probeReachability: reach(false),
        resolveOwnerWorkspaces: vi.fn<ResolveOwnerWorkspacesFn>(async () => {
          throw new Error('session_briefs unavailable');
        }),
      },
    );

    expect(res.paused).toBe(1);
    expect(res.disarmedUnaddressableHarness).toEqual([]);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('resolves owner scopes ONCE per sweep, batched — never once per owner', async () => {
    const sql = fakeSql([
      { id: 'rt_a', target_owner_id: 'su-a' },
      { id: 'rt_b', target_owner_id: 'su-b' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-a', status({ ownerId: 'su-a', turnsStalled: true, ...COMATOSE })],
          ['su-b', status({ ownerId: 'su-b', turnsStalled: true, ...COMATOSE })],
        ]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const resolveOwnerWorkspaces = vi.fn<ResolveOwnerWorkspacesFn>(async () => new Map([['su-a', 'default']]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      { getStatuses, autoPause, broadcast, probeReachability: reach(false), resolveOwnerWorkspaces },
    );

    expect(resolveOwnerWorkspaces).toHaveBeenCalledTimes(1);
    expect(resolveOwnerWorkspaces.mock.calls[0][0]).toEqual(['su-a', 'su-b']);
    // Only the one whose scope actually diverged is named.
    expect(res.disarmedUnaddressableHarness).toEqual(['su-a']);
    expect(res.paused).toBe(2);
  });

  it('the fleet BROADCAST names the population and withdraws the re-arm advice for it', async () => {
    const sql = fakeSql([{ id: 'rt_strand', target_owner_id: 'su-strand' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-strand', status({ ownerId: 'su-strand', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        probeReachability: reach(false),
        resolveOwnerWorkspaces: stranded('su-strand'),
      },
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    const body = broadcast.mock.calls[0][0].body ?? '';
    expect(body).toContain('su-strand');
    expect(body).toContain('OF THE DISARMED ABOVE');
    // The generic paragraph tells the fleet to re-arm; this clause must take that back for these.
    expect(body).toContain('does NOT apply');
    expect(body).toContain('relaunched with the correct');
    // Names where to start, like every other population's paragraph in this module.
    expect(body).toContain('harness_workspace_mismatch');
  });

  it('the OWNER PAGE carries the distinct remedy when the strand is also still reachable', async () => {
    // The page already fires for a reachable disarm, and a scope-stranded session is typically
    // alive — so without this clause the owner is paged with advice ("resume and re-arm") that
    // provably cannot work for it.
    const sql = fakeSql([{ id: 'rt_strand', target_owner_id: 'su-strand' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-strand', status({ ownerId: 'su-strand', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        notify,
        probeReachability: reach(true),
        resolveOwnerWorkspaces: stranded('su-strand'),
      },
    );

    // It lands in BOTH populations by design — they overlap, neither partitions the other.
    expect(res.disarmedWhileReachable).toEqual(['su-strand']);
    expect(res.disarmedUnaddressableHarness).toEqual(['su-strand']);

    expect(notify).toHaveBeenCalledTimes(1);
    const page = notify.mock.calls[0][0];
    expect(page.body).toContain('will NOT be fixed by that');
    expect(page.body).toContain('RELAUNCH');
    expect(page.body).toContain('harness_forbidden');
    expect(page.data?.unaddressableHarness).toBe('su-strand');
    expect(page.data?.unaddressableHarnessCount).toBe(1);
  });

  it('THE GATE IS NOT WIDENED — an UNREACHABLE strand is a corpse and is still paged about by nobody', async () => {
    // Byte-identical to the case above but for `reach(false)`. Corpse-reaping staying silent is
    // the whole point of gating the page on a non-empty reachable subset (WI-6639's original
    // population was 15 already-ended sessions); a strand that is also gone is exactly that.
    const sql = fakeSql([{ id: 'rt_strand', target_owner_id: 'su-strand' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-strand', status({ ownerId: 'su-strand', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        notify,
        probeReachability: reach(false),
        resolveOwnerWorkspaces: stranded('su-strand'),
      },
    );

    expect(res.disarmedUnaddressableHarness).toEqual(['su-strand']);
    expect(res.disarmedWhileReachable).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    // …but the reason and the fleet broadcast still explain it — the page is the only thing gated.
    expect(autoPause.mock.calls[0][2]).toContain('UNADDRESSABLE HARNESS');
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('dryRun reports the population without disarming, broadcasting or paging', async () => {
    const sql = fakeSql([{ id: 'rt_strand', target_owner_id: 'su-strand' }]);
    const getStatuses = vi.fn(
      async () => new Map([['su-strand', status({ ownerId: 'su-strand', turnsStalled: true, ...COMATOSE })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws', dryRun: true },
      {
        getStatuses,
        autoPause,
        broadcast,
        notify,
        probeReachability: reach(true),
        resolveOwnerWorkspaces: stranded('su-strand'),
      },
    );

    expect(res.dryRun).toBe(true);
    expect(res.disarmedUnaddressableHarness).toEqual(['su-strand']);
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('workspace loop-population starvation (P-007 / WI-41230)', () => {
  const incident: LoopPopulationSnapshot = {
    status: 'measured',
    active: 12,
    parked: 8,
    parkedRatio: 8 / 12,
    parkedZeroTool3h: 5,
    parkedZeroToolRatio: 5 / 8,
    ownerSample: ['su-zero-1', 'su-zero-2'],
  };

  it('pure control: a large parked zero-tool cohort is an incident', () => {
    expect(isLoopPopulationStarvation(incident)).toBe(true);
  });

  it('pure healthy control: parked share alone is context, not the gate', () => {
    expect(
      isLoopPopulationStarvation({
        status: 'measured',
        active: 168,
        parked: 76,
        parkedRatio: 76 / 168,
        parkedZeroTool3h: 6,
        parkedZeroToolRatio: 6 / 76,
        ownerSample: [],
      }),
    ).toBe(false);
  });

  it('pure small-population control: a perfect ratio cannot satisfy the absolute floors', () => {
    expect(
      isLoopPopulationStarvation({
        status: 'measured',
        active: 9,
        parked: 9,
        parkedRatio: 1,
        parkedZeroTool3h: 9,
        parkedZeroToolRatio: 1,
        ownerSample: ['su-small'],
      }),
    ).toBe(false);
  });

  const healthySweep = (population: LoopPopulationSnapshot) => {
    const owners = Array.from({ length: 12 }, (_, i) => `su-pop-${i + 1}`);
    const sql = fakeSql(owners.map((ownerId) => ({ id: `rt-${ownerId}`, target_owner_id: ownerId })));
    const getStatuses = vi.fn(
      async () => new Map(owners.map((ownerId) => [ownerId, status({ ownerId, turnsStalled: false })])),
    );
    const autoPause = vi.fn(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const readPopulation: NonNullable<StalledLoopsSweepDeps['readPopulation']> = vi.fn(async () => population);
    return { sql, getStatuses, autoPause, broadcast, readPopulation };
  };

  it('broadcasts one condition-keyed advisory for an incident and changes no loop state', async () => {
    const fx = healthySweep(incident);
    const result = await sweepStalledLoops(
      { sql: fx.sql, workspaceId: 'ws-pop' },
      {
        getStatuses: fx.getStatuses,
        autoPause: fx.autoPause,
        broadcast: fx.broadcast,
        readPopulation: fx.readPopulation,
        probeReachability: reach(false),
      },
    );

    expect(result.population).toEqual(incident);
    expect(result.paused).toBe(0);
    expect(fx.autoPause).not.toHaveBeenCalled();
    expect(fx.broadcast).toHaveBeenCalledTimes(1);
    expect(fx.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'loop-population-advisory',
        conditionKey: 'loop-population-starvation:ws-pop',
        oneShot: true,
      }),
    );
    expect(fx.broadcast.mock.calls[0]?.[0].body).toContain('context only');
  });

  it('does not broadcast when the zero-tool share is healthy', async () => {
    const healthy: LoopPopulationSnapshot = {
      status: 'measured',
      active: 168,
      parked: 76,
      parkedRatio: 76 / 168,
      parkedZeroTool3h: 6,
      parkedZeroToolRatio: 6 / 76,
      ownerSample: [],
    };
    const fx = healthySweep(healthy);
    const result = await sweepStalledLoops(
      { sql: fx.sql, workspaceId: 'ws-pop' },
      {
        getStatuses: fx.getStatuses,
        autoPause: fx.autoPause,
        broadcast: fx.broadcast,
        readPopulation: fx.readPopulation,
        probeReachability: reach(false),
      },
    );

    expect(result.population).toEqual(healthy);
    expect(fx.broadcast).not.toHaveBeenCalled();
    expect(fx.autoPause).not.toHaveBeenCalled();
  });

  it('a failed population read is explicit unknown and NEVER disables the existing reaper', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = fakeSql([{ id: 'rt-dead', target_owner_id: 'su-dead' }]);
      const getStatuses = vi.fn(async () => new Map([['su-dead', status({ ownerId: 'su-dead', turnsStalled: true })]]));
      const autoPause = vi.fn(async () => {});
      const broadcast = vi.fn<BroadcastFn>(async () => true);
      const result = await sweepStalledLoops(
        { sql, workspaceId: 'ws-pop' },
        {
          getStatuses,
          autoPause,
          broadcast,
          readPopulation: vi.fn(async () => {
            throw new Error('population source unavailable');
          }),
          probeReachability: reach(false),
        },
      );

      expect(result.population).toEqual({ status: 'unknown', reason: 'population source unavailable' });
      expect(result.paused).toBe(1);
      expect(autoPause).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast.mock.calls[0]?.[0].category).toBe('severe-event');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('existing reaper continues unchanged'));
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * parked-agent-census-resumption-and-root-cause-2026-10-09 P-007 — REPAIR, not disarm.
 *
 * THE MEASUREMENT: on 2026-10-10, 37 of 61 turns-stalled disarms were sessions whose codex child
 * held a dead provider login. The wake executor recycles exactly that child on the next wake
 * (P-004), so the disarm threw the recovery away and left the session dark. The guard now reads
 * the owner's psu host before disarming and keeps a loop armed only when the classifier says the
 * next wake carries a recycle the executor will actually perform.
 *
 * Every case pins BOTH halves of the decision — what was written (route vs autoPause) and what
 * was reported (result arrays + the disarm reason) — because the reason string is the only place
 * a human learns that re-arming will not help.
 */
describe('sweepStalledLoops — host-aware disarm (parked-agent-census P-007)', () => {
  type ReadHostFn = NonNullable<StalledLoopsSweepDeps['readStalledHost']>;
  type RouteFn = NonNullable<StalledLoopsSweepDeps['routeToHostRecovery']>;

  const recyclable = {
    ownerId: 'su-walled',
    bridgeTty: false,
    launchedBy: 'su-leader',
    caps: ['quota-recovery', 'auth-recovery'],
  };
  const hostFor =
    (byOwner: Record<string, StalledLoopHostReading>): ReadHostFn =>
    async (ownerId) =>
      byOwner[ownerId] ?? { host: null, events: [] };
  const authWalled = (ownerId: string): StalledLoopHostReading => ({
    host: { ...recyclable, ownerId, authBlocked: true },
    events: [],
  });
  const unbound = (ownerId: string): StalledLoopHostReading => ({
    host: { ...recyclable, ownerId },
    // D-007: only the unbindable reason, timestamped, reads as an unbound successor.
    events: [
      { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: new Date().toISOString() },
    ] as unknown as StalledLoopHostReading['events'],
  });
  const stalled = (ownerId: string) => status({ ownerId, turnsStalled: true, fireCount: 9, lastTurnAt: null });

  // The routed branch logs a HOST-RECOVERY line; fail-on-console requires it to be asserted.
  const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  let warn: ReturnType<typeof spyWarn>;
  beforeEach(() => {
    warn = spyWarn();
  });
  afterEach(() => {
    warn.mockRestore();
  });
  const routedWarning = (ownerId: string) =>
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`HOST-RECOVERY ${ownerId}`));

  it('THE CASE: a dead-login host is ROUTED to recovery — kept armed and made due, never paused', async () => {
    const sql = fakeSql([{ id: 'rt_walled', target_owner_id: 'su-walled' }]);
    const getStatuses = vi.fn(async () => new Map([['su-walled', stalled('su-walled')]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const routeToHostRecovery = vi.fn<RouteFn>(async () => ({ routed: true }));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        probeReachability: reach(true),
        readStalledHost: hostFor({ 'su-walled': authWalled('su-walled') }),
        routeToHostRecovery,
      },
    );

    expect(routeToHostRecovery).toHaveBeenCalledTimes(1);
    expect(routeToHostRecovery).toHaveBeenCalledWith(sql, 'rt_walled', expect.stringContaining('P-007'), 'auth-blocked');
    expect(autoPause).not.toHaveBeenCalled();
    expect(res.paused).toBe(0);
    expect(res.routedToHostRecovery).toEqual([{ ownerId: 'su-walled', condition: 'auth-blocked' }]);
    expect(res.disarmedHostUnhealthy).toEqual([]);
    routedWarning('su-walled');

    // Nothing was disarmed, so the REPAIRED notice carries it, under its own headline.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]?.[0];
    expect(call?.summary).toContain('host is walled');
    expect(call?.body).toContain('HOST-WALLED');
    expect(call?.body).toContain('su-walled (auth-blocked)');
  });

  it('route budget SPENT retains an active recovery wall instead of disarming', async () => {
    const sql = fakeSql([{ id: 'rt_walled', target_owner_id: 'su-walled' }]);
    const getStatuses = vi.fn(async () => new Map([['su-walled', stalled('su-walled')]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const routeToHostRecovery = vi.fn<RouteFn>(async () => ({ routed: false }));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        probeReachability: reach(false),
        readStalledHost: hostFor({ 'su-walled': authWalled('su-walled') }),
        routeToHostRecovery,
      },
    );

    expect(routeToHostRecovery).toHaveBeenCalledTimes(1);
    expect(autoPause).not.toHaveBeenCalled();
    expect(res.paused).toBe(0);
    expect(res.routedToHostRecovery).toEqual([]);
    expect(res.disarmedHostUnhealthy).toEqual([]);
    expect(res.retainedHostRecoveryWalls).toEqual([
      { ownerId: 'su-walled', condition: 'auth-blocked', reason: expect.stringContaining('route budget is spent'), remedy: expect.stringContaining('P-012') },
    ]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('an UNBOUND successor queues a bounded carry cut and retains the loop', async () => {
    const sql = fakeSql([{ id: 'rt_unbound', target_owner_id: 'su-unbound' }]);
    const getStatuses = vi.fn(async () => new Map([['su-unbound', stalled('su-unbound')]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const routeToHostRecovery = vi.fn<RouteFn>(async () => ({ routed: true }));
    const queueHostRelaunch = vi.fn<NonNullable<StalledLoopsSweepDeps['queueHostRelaunch']>>(async () => ({ queued: true }));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast: vi.fn<BroadcastFn>(async () => true),
        probeReachability: reach(false),
        readStalledHost: hostFor({ 'su-unbound': unbound('su-unbound') }),
        routeToHostRecovery,
        queueHostRelaunch,
      },
    );

    expect(routeToHostRecovery).toHaveBeenCalledWith(sql, 'rt_unbound', expect.any(String), 'unbound-successor', { deferFire: true });
    expect(queueHostRelaunch).toHaveBeenCalledWith('su-unbound', 'ws');
    expect(autoPause).not.toHaveBeenCalled();
    expect(res.routedToHostRecovery).toEqual([{ ownerId: 'su-unbound', condition: 'unbound-successor' }]);
    expect(res.retainedHostRecoveryWalls).toEqual([]);
    routedWarning('su-unbound');
  });

  it('a pending-turn-stuck host reserves its carry route before queuing the same owner', async () => {
    const ownerId = 'su-pending';
    const now = Date.now();
    const sql = fakeSql([{ id: 'rt_pending', target_owner_id: ownerId }]);
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const routeToHostRecovery = vi.fn<RouteFn>(async () => ({ routed: true }));
    const queueHostRelaunch = vi.fn<NonNullable<StalledLoopsSweepDeps['queueHostRelaunch']>>(async () => ({ queued: true }));
    const result = await sweepStalledLoops({ sql, workspaceId: 'ws' }, {
      getStatuses: async () => new Map([[ownerId, stalled(ownerId)]]),
      probeReachability: reach(false), autoPause, routeToHostRecovery, queueHostRelaunch,
      broadcast: vi.fn<BroadcastFn>(async () => true),
      readStalledHost: hostFor({ [ownerId]: {
        host: { ...recyclable, ownerId },
        events: [45, 30, 15].map(minutes => ({ kind: 'duplicate-delivery-id', state: 'pending',
          ts: new Date(now - minutes * 60_000).toISOString() })) as StalledLoopHostReading['events'],
      } }),
    });
    expect(routeToHostRecovery).toHaveBeenCalledWith(sql, 'rt_pending', expect.any(String), 'pending-turn-stuck', { deferFire: true });
    expect(queueHostRelaunch).toHaveBeenCalledWith(ownerId, 'ws');
    expect(routeToHostRecovery.mock.invocationCallOrder[0]).toBeLessThan(queueHostRelaunch.mock.invocationCallOrder[0]!);
    expect(autoPause).not.toHaveBeenCalled();
    expect(result.routedToHostRecovery).toEqual([{ ownerId, condition: 'pending-turn-stuck' }]);
    expect(result.retainedHostRecoveryWalls).toEqual([]);
    routedWarning(ownerId);
  });

  it('an owner-attended quota wall retains its obligation without recycling or disarming', async () => {
    const ownerId = 'su-quota';
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const routeToHostRecovery = vi.fn<RouteFn>(async () => ({ routed: true }));
    const queueHostRelaunch = vi.fn<NonNullable<StalledLoopsSweepDeps['queueHostRelaunch']>>(async () => ({ queued: true }));
    const retainHostRecoveryWall = vi.fn<NonNullable<StalledLoopsSweepDeps['retainHostRecoveryWall']>>(async () => ({ retained: true, changed: false }));
    const sql = fakeSql([{ id: 'rt_quota', target_owner_id: ownerId }]);
    const result = await sweepStalledLoops({ sql, workspaceId: 'ws' }, {
      getStatuses: async () => new Map([[ownerId, stalled(ownerId)]]),
      probeReachability: reach(false), autoPause, routeToHostRecovery, queueHostRelaunch, retainHostRecoveryWall,
      broadcast: vi.fn<BroadcastFn>(async () => true),
      readStalledHost: hostFor({ [ownerId]: { host: { ...recyclable, ownerId, bridgeTty: true, quotaBlocked: true }, events: [] } }),
    });
    expect(autoPause).not.toHaveBeenCalled();
    expect(routeToHostRecovery).not.toHaveBeenCalled();
    expect(queueHostRelaunch).not.toHaveBeenCalled();
    expect(retainHostRecoveryWall).toHaveBeenCalledWith(sql, 'rt_quota', expect.objectContaining({ ownerId, condition: 'quota-blocked' }));
    expect(result.retainedHostRecoveryWalls).toEqual([expect.objectContaining({ ownerId, condition: 'quota-blocked' })]);
    expect(result.paused).toBe(0);
  });

  it('CONTROL — a HEALTHY host is disarmed exactly as before: ordinary reason, no route, no host finding', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(async () => new Map([['su-dead', stalled('su-dead')]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const routeToHostRecovery = vi.fn<RouteFn>(async () => ({ routed: true }));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast: vi.fn<BroadcastFn>(async () => true),
        probeReachability: reach(false),
        readStalledHost: hostFor({ 'su-dead': { host: { ...recyclable, ownerId: 'su-dead' }, events: [] } }),
        routeToHostRecovery,
      },
    );

    expect(routeToHostRecovery).not.toHaveBeenCalled();
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause.mock.calls[0]?.[2]).not.toContain('HOST UNHEALTHY');
    expect(res.disarmedHostUnhealthy).toEqual([]);
    expect(res.routedToHostRecovery).toEqual([]);
  });

  it('a THROWING host read decides as no-host — the pre-P-007 disarm, never a held loop', async () => {
    const sql = fakeSql([{ id: 'rt_dead', target_owner_id: 'su-dead' }]);
    const getStatuses = vi.fn(async () => new Map([['su-dead', stalled('su-dead')]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const routeToHostRecovery = vi.fn<RouteFn>(async () => ({ routed: true }));
    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast: vi.fn<BroadcastFn>(async () => true),
        probeReachability: reach(false),
        readStalledHost: async () => {
          throw new Error('EIO on discovery dir');
        },
        routeToHostRecovery,
      },
    );
    expect(routeToHostRecovery).not.toHaveBeenCalled();
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deciding as no-host'));
  });

  it('reads the host ONLY for owners that reached the disarm — a healthy sweep pays nothing', async () => {
    const sql = fakeSql([
      { id: 'rt_ok', target_owner_id: 'su-ok' },
      { id: 'rt_dead', target_owner_id: 'su-dead' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-ok', status({ ownerId: 'su-ok', turnsStalled: false })],
          ['su-dead', stalled('su-dead')],
        ]),
    );
    const readStalledHost = vi.fn<ReadHostFn>(async () => ({ host: null, events: [] }));

    await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause: vi.fn<AutoPauseFn>(async () => {}),
        broadcast: vi.fn<BroadcastFn>(async () => true),
        probeReachability: reach(false),
        readStalledHost,
        routeToHostRecovery: vi.fn<RouteFn>(async () => ({ routed: true })),
      },
    );

    expect(readStalledHost.mock.calls.map((c) => c[0])).toEqual(['su-dead']);
  });

  it('a mixed sweep reports both in ONE disarm broadcast', async () => {
    const sql = fakeSql([
      { id: 'rt_walled', target_owner_id: 'su-walled' },
      { id: 'rt_dead', target_owner_id: 'su-dead' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-walled', stalled('su-walled')],
          ['su-dead', stalled('su-dead')],
        ]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast,
        probeReachability: reach(false),
        readStalledHost: hostFor({ 'su-walled': authWalled('su-walled') }),
        routeToHostRecovery: vi.fn<RouteFn>(async () => ({ routed: true })),
      },
    );

    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledWith(sql, 'rt_dead', expect.any(String));
    expect(res.routedToHostRecovery).toEqual([{ ownerId: 'su-walled', condition: 'auth-blocked' }]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const body = broadcast.mock.calls[0]?.[0].body ?? '';
    expect(body).toContain('Owners: su-dead.');
    expect(body).toContain('ALSO NOT disarmed: 1 loop(s) were HOST-WALLED (su-walled: auth-blocked)');
    routedWarning('su-walled');
  });

  it('a refused carry retains a durable wall and pages even an unreachable owner', async () => {
    const sql = fakeSql([{ id: 'rt_unbound', target_owner_id: 'su-unbound' }]);
    const getStatuses = vi.fn(async () => new Map([['su-unbound', stalled('su-unbound')]]));
    const notify = vi.fn<NotifyFn>(async () => {});

    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const retainHostRecoveryWall = vi.fn<NonNullable<StalledLoopsSweepDeps['retainHostRecoveryWall']>>(async () => ({ retained: true, changed: true }));
    const result = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        broadcast: vi.fn<BroadcastFn>(async () => true),
        probeReachability: reach(false),
        notify,
        readStalledHost: hostFor({ 'su-unbound': unbound('su-unbound') }),
        routeToHostRecovery: vi.fn<RouteFn>(async () => ({ routed: true })),
        queueHostRelaunch: async () => ({ queued: false, reason: 'owner-attended-host' }),
        retainHostRecoveryWall,
      },
    );

    expect(notify).toHaveBeenCalledTimes(1);
    const page = notify.mock.calls[0]?.[0];
    expect(autoPause).not.toHaveBeenCalled();
    expect(result.paused).toBe(0);
    expect(page?.body).toContain('owner-attended-host');
    expect(page?.body).toContain('loop remains active');
    expect(page?.body).toContain('su-unbound (unbound-successor)');
    expect(page?.data).toMatchObject({ hostUnhealthy: 'su-unbound', hostUnhealthyCount: 1 });
  });

  it('an exhausted carry budget never injects, and an unchanged wall does not page again', async () => {
    const queueHostRelaunch = vi.fn<NonNullable<StalledLoopsSweepDeps['queueHostRelaunch']>>(async () => ({ queued: true }));
    const notify = vi.fn<NotifyFn>(async () => {});
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const result = await sweepStalledLoops({ sql: fakeSql([{ id: 'rt_unbound', target_owner_id: 'su-unbound' }]), workspaceId: 'ws' }, {
      getStatuses: async () => new Map([['su-unbound', stalled('su-unbound')]]),
      readStalledHost: hostFor({ 'su-unbound': unbound('su-unbound') }),
      probeReachability: reach(false), autoPause, notify,
      broadcast: vi.fn<BroadcastFn>(async () => true),
      routeToHostRecovery: async () => ({ routed: false }), queueHostRelaunch,
      retainHostRecoveryWall: async () => ({ retained: true, changed: false }),
    });
    expect(queueHostRelaunch).not.toHaveBeenCalled();
    expect(autoPause).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(result.retainedHostRecoveryWalls[0]?.reason).toContain('route budget is spent');
  });

  it('dryRun reports the route without writing it', async () => {
    const sql = fakeSql([{ id: 'rt_walled', target_owner_id: 'su-walled' }]);
    const getStatuses = vi.fn(async () => new Map([['su-walled', stalled('su-walled')]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const routeToHostRecovery = vi.fn<RouteFn>(async () => ({ routed: true }));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws', dryRun: true },
      {
        getStatuses,
        autoPause,
        broadcast,
        probeReachability: reach(false),
        readStalledHost: hostFor({ 'su-walled': authWalled('su-walled') }),
        routeToHostRecovery,
      },
    );

    expect(routeToHostRecovery).not.toHaveBeenCalled();
    expect(autoPause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(res.routedToHostRecovery).toEqual([{ ownerId: 'su-walled', condition: 'auth-blocked' }]);
    routedWarning('su-walled');
  });
});
