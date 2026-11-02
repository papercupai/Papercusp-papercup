/**
 * WI-3818: listFleetRosterDiagnosed / listFleetRoster's bounded fan-out — a slow/
 * hanging sub-read (presence, Tier-1, assignments, wakeability) must degrade to an
 * empty fallback within FLEET_ROSTER_SUBREAD_TIMEOUT_MS instead of hanging the whole
 * roster read. Unlike fleet-roster.test.ts (deliberately PG-free, pure-fold-only),
 * this file exercises the IO-seam wrapper itself: `readPresence` is injected (the
 * existing DI seam); `fetchPresenceTier1` / `listFleetAssignments` / `fetchWakeability`
 * are module-mocked since they aren't injectable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PresenceTier1Joins } from '../agent-tools/coordination/presence-tier1';
import type { WakeabilitySignals } from '../agent-tools/coordination/presence-wakeability';
import type { SelfWakeSignals } from '../agent-tools/coordination/presence-selfwake';
import type { FleetAssignmentRow } from './assignments';
import type {
  FleetFoldPresence,
  FleetRosterPresenceLegTiming,
  FleetRosterPresenceStageTiming,
} from './fleet-roster';

const {
  fetchPresenceTier1Mock,
  fetchWakeabilityMock,
  listFleetAssignmentsMock,
  recordedLiveOwnerIdsMock,
  endedRecordedOwnerIdsMock,
  fetchSelfWakeMock,
  findLiveHostMock,
  findLiveHostAsyncMock,
  listPresenceMock,
  fetchPresenceFleetMock,
  listLiveSessionPresenceMock,
} = vi.hoisted(() => ({
  fetchPresenceTier1Mock: vi.fn(),
  fetchWakeabilityMock: vi.fn(),
  listFleetAssignmentsMock: vi.fn(),
  recordedLiveOwnerIdsMock: vi.fn(),
  endedRecordedOwnerIdsMock: vi.fn(),
  fetchSelfWakeMock: vi.fn(),
  findLiveHostMock: vi.fn(),
  findLiveHostAsyncMock: vi.fn(),
  listPresenceMock: vi.fn(),
  fetchPresenceFleetMock: vi.fn(),
  listLiveSessionPresenceMock: vi.fn(),
}));

vi.mock('../agent-tools/coordination/presence-tier1', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/presence-tier1')>();
  return { ...actual, fetchPresenceTier1: fetchPresenceTier1Mock };
});
vi.mock('../agent-tools/coordination/presence-wakeability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/presence-wakeability')>();
  return { ...actual, fetchWakeability: fetchWakeabilityMock };
});
vi.mock('./assignments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assignments')>();
  return { ...actual, listFleetAssignments: listFleetAssignmentsMock };
});
// The recorded-session rescue leg (unification P-003) hits adv_sessions PG —
// mock it like the other non-injectable legs so this file stays PG-free.
vi.mock('../adv-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adv-sessions')>();
  return { ...actual, recordedLiveOwnerIds: recordedLiveOwnerIdsMock, endedRecordedOwnerIds: endedRecordedOwnerIdsMock };
});
// EI-19407725333778711: the forward-looking self-wake leg also hits PG — mock it
// like every other non-injectable leg so this file stays PG-free.
vi.mock('../agent-tools/coordination/presence-selfwake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/presence-selfwake')>();
  return { ...actual, fetchSelfWake: fetchSelfWakeMock };
});
vi.mock('../agent-tools/coordination/presence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/presence')>();
  return { ...actual, listPresence: listPresenceMock };
});
vi.mock('../agent-tools/coordination/presence-fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/presence-fleet')>();
  return { ...actual, fetchPresenceFleet: fetchPresenceFleetMock };
});
vi.mock('../sync/hyperbee/session-presence-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync/hyperbee/session-presence-store')>();
  return { ...actual, listLiveSessionPresence: listLiveSessionPresenceMock };
});
vi.mock('../events/await/psu-pty-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/await/psu-pty-discovery')>();
  return {
    ...actual,
    findLiveHost: findLiveHostMock,
    findLiveHostAsync: findLiveHostAsyncMock,
  };
});

// Imported AFTER the mocks so the mocked bindings are the ones wired in.
const { listFleetRosterDiagnosed, listFleetRoster, FLEET_ROSTER_SUBREAD_TIMEOUT_MS } = await import(
  './fleet-roster'
);

function pres(ownerId: string, fleetSlug = 'p2p-parity-lanes'): FleetFoldPresence {
  return {
    ownerId,
    ownerLabel: null,
    source: 'omp-hook-session',
    intent: '',
    currentPlanSlug: null,
    host: null,
    startedAt: null,
    heartbeatAt: '2026-07-10T10:00:00Z',
    lastActiveAt: '2026-07-10T10:00:00Z',
    agentRole: null,
    fleetSlug,
    fleetRole: 'member',
    userId: null,
    stale: false,
  };
}

const neverSettles = <T>(): Promise<T> => new Promise<T>(() => {});

async function expectPresenceStageTimeout(
  expectedStage: FleetRosterPresenceStageTiming['stage'],
): Promise<void> {
  fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
  fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
  listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
  const stageTimings: FleetRosterPresenceStageTiming[] = [];
  let presenceLegTiming: FleetRosterPresenceLegTiming | undefined;
  const resultPromise = listFleetRosterDiagnosed({
    fleetSlug: 'p2p-parity-lanes',
    workspaceId: 'workspace-1',
    onPresenceStageTiming: (timing) => stageTimings.push(timing),
    onPresenceLegTiming: (timing) => { presenceLegTiming = timing; },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stageTimings.some((timing) => timing.stage === expectedStage && timing.status === 'running')).toBe(true);
  await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
  const result = await resultPromise;
  expect(result.degradedLegs).toContain('presence');
  expect(presenceLegTiming).toMatchObject({ status: 'degraded', reason: 'timeout' });
  expect(presenceLegTiming?.elapsedMs).toBeGreaterThanOrEqual(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
}

describe('listFleetRosterDiagnosed (WI-3818 bounded fan-out)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchPresenceTier1Mock.mockReset();
    fetchWakeabilityMock.mockReset();
    listFleetAssignmentsMock.mockReset();
    recordedLiveOwnerIdsMock.mockReset();
    endedRecordedOwnerIdsMock.mockReset();
    fetchSelfWakeMock.mockReset();
    findLiveHostMock.mockReset();
    findLiveHostAsyncMock.mockReset().mockResolvedValue(null);
    listPresenceMock.mockReset().mockResolvedValue([]);
    fetchPresenceFleetMock.mockReset().mockResolvedValue(new Map());
    listLiveSessionPresenceMock.mockReset().mockResolvedValue([]);
    // Default: the recorded leg answers promptly with "nobody recorded-live" —
    // the pre-existing tests' degradedLegs expectations stay exact.
    recordedLiveOwnerIdsMock.mockResolvedValue(new Set<string>());
    endedRecordedOwnerIdsMock.mockResolvedValue(new Set<string>());
    // Same treatment for the self-wake leg (EI-19407725333778711): answer
    // promptly by default so every pre-existing degradedLegs expectation in
    // this file keeps asserting EXACTLY the leg it was written to assert.
    fetchSelfWakeMock.mockResolvedValue(new Map<string, SelfWakeSignals>());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with a full roster + no degraded legs when every sub-read answers in time', async () => {
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result.degradedLegs).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].agentId).toBe('su-1');
  });

  it('records ordered stage timings and counts without letting observer errors affect the roster', async () => {
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    listPresenceMock.mockResolvedValue([pres('su-1')]);
    fetchPresenceFleetMock.mockResolvedValue(new Map([
      ['su-1', { fleetSlug: 'p2p-parity-lanes', fleetRole: 'member' }],
    ]));
    listLiveSessionPresenceMock.mockResolvedValue([]);
    const stageTimings: FleetRosterPresenceStageTiming[] = [];
    let presenceLegTiming: FleetRosterPresenceLegTiming | undefined;
    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      workspaceId: 'workspace-1',
      onPresenceStageTiming: (timing) => {
        stageTimings.push(timing);
        throw new Error('observer failed');
      },
      onPresenceLegTiming: (timing) => {
        presenceLegTiming = timing;
        throw new Error('observer failed');
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(stageTimings.map(({ stage, status }) => [stage, status])).toEqual([
      ['coordPresence', 'running'], ['coordPresence', 'completed'],
      ['fleetMembership', 'running'], ['fleetMembership', 'completed'],
      ['sharedSessionPresence', 'running'], ['sharedSessionPresence', 'completed'],
    ]);
    expect(stageTimings.find((timing) => timing.stage === 'coordPresence' && timing.status === 'completed'))
      .toMatchObject({ elapsedMs: expect.any(Number), resultCount: 1 });
    expect(stageTimings.find((timing) => timing.stage === 'fleetMembership' && timing.status === 'completed'))
      .toMatchObject({ elapsedMs: expect.any(Number), inputCount: 1, resultCount: 1 });
    expect(stageTimings.find((timing) => timing.stage === 'sharedSessionPresence' && timing.status === 'completed'))
      .toMatchObject({ elapsedMs: expect.any(Number), resultCount: 0 });
    expect(presenceLegTiming).toMatchObject({ status: 'completed', elapsedMs: expect.any(Number) });
    expect(result.degradedLegs).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it('retains the best-effort federated-stage failure when local presence succeeds', async () => {
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    listPresenceMock.mockResolvedValue([pres('su-1')]);
    fetchPresenceFleetMock.mockResolvedValue(new Map([
      ['su-1', { fleetSlug: 'p2p-parity-lanes', fleetRole: 'member' }],
    ]));
    listLiveSessionPresenceMock.mockRejectedValue(new Error('federated read failed'));
    const stageTimings: FleetRosterPresenceStageTiming[] = [];
    let presenceLegTiming: FleetRosterPresenceLegTiming | undefined;
    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      workspaceId: 'workspace-1',
      onPresenceStageTiming: (timing) => stageTimings.push(timing),
      onPresenceLegTiming: (timing) => { presenceLegTiming = timing; },
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(stageTimings.find((timing) => timing.stage === 'sharedSessionPresence' && timing.status === 'failed'))
      .toMatchObject({ errorName: 'Error' });
    expect(presenceLegTiming).toMatchObject({ status: 'completed' });
    expect(result.degradedLegs).not.toContain('presence');
    expect(result.entries).toHaveLength(1);
  });

  it('identifies which serial presence stage is still running when the aggregate leg times out', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      listPresenceMock.mockReturnValue(neverSettles());
      await expectPresenceStageTimeout('coordPresence');

      listPresenceMock.mockResolvedValue([pres('su-1')]);
      fetchPresenceFleetMock.mockReturnValue(neverSettles());
      await expectPresenceStageTimeout('fleetMembership');

      listPresenceMock.mockResolvedValue([pres('su-1')]);
      fetchPresenceFleetMock.mockResolvedValue(new Map([
        ['su-1', { fleetSlug: 'p2p-parity-lanes', fleetRole: 'member' }],
      ]));
      listLiveSessionPresenceMock.mockReturnValue(neverSettles());
      await expectPresenceStageTimeout('sharedSessionPresence');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('freezes the active-stage snapshot after timeout when the underlying read settles late', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
      fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
      listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
      fetchPresenceFleetMock.mockResolvedValue(new Map([
        ['su-1', { fleetSlug: 'p2p-parity-lanes', fleetRole: 'member' }],
      ]));
      listLiveSessionPresenceMock.mockResolvedValue([]);
      let resolvePresence: ((rows: FleetFoldPresence[]) => void) | undefined;
      listPresenceMock.mockImplementation(() => new Promise<FleetFoldPresence[]>((resolve) => {
        resolvePresence = resolve;
      }));
      const stageTimings: FleetRosterPresenceStageTiming[] = [];
      let presenceLegTiming: FleetRosterPresenceLegTiming | undefined;
      const resultPromise = listFleetRosterDiagnosed({
        fleetSlug: 'p2p-parity-lanes',
        workspaceId: 'workspace-1',
        onPresenceStageTiming: (timing) => stageTimings.push(timing),
        onPresenceLegTiming: (timing) => { presenceLegTiming = timing; },
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
      const result = await resultPromise;
      expect(result.degradedLegs).toContain('presence');
      expect(stageTimings).toEqual([
        { stage: 'coordPresence', status: 'running', elapsedMs: 0 },
      ]);
      expect(presenceLegTiming).toMatchObject({ status: 'degraded', reason: 'timeout' });

      const stageCountAtTimeout = stageTimings.length;
      resolvePresence?.([pres('su-1')]);
      await vi.advanceTimersByTimeAsync(0);
      expect(stageTimings).toHaveLength(stageCountAtTimeout);
      expect(stageTimings).not.toContainEqual(expect.objectContaining({ status: 'completed' }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses async psu-host discovery in the request path without calling the sync lookup', async () => {
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map([
      ['su-1', { wakeable: true, liveTurn: true }],
    ]));
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    findLiveHostAsyncMock.mockResolvedValue({ ownerId: 'su-1', pid: 12345 });

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [{ ...pres('su-1'), agentRole: 'su', tty: '/dev/pts/1' }],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.degradedLegs).toEqual([]);
    expect(findLiveHostAsyncMock).toHaveBeenCalledWith('su-1');
    expect(findLiveHostMock).not.toHaveBeenCalled();
  });

  it('degrades a stalled psu-host discovery leg within the roster budget', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    findLiveHostAsyncMock.mockReturnValue(neverSettles<never>());

    let completed = false;
    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [{ ...pres('su-1'), agentRole: 'su' }],
    }).then((result) => {
      completed = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.degradedLegs).toContain('psuHosts');
    expect(result.entries).toHaveLength(1);
    expect(findLiveHostAsyncMock).toHaveBeenCalledWith('su-1');
    warnSpy.mockRestore();
  });

  it('reads the durable leader through the liveness legs even when it has no presence row', async () => {
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    recordedLiveOwnerIdsMock.mockResolvedValue(new Set(['su-leader']));

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      leaderOwnerId: 'su-leader',
      readPresence: async () => [],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(fetchWakeabilityMock).toHaveBeenCalledWith(['su-leader']);
    expect(recordedLiveOwnerIdsMock).toHaveBeenCalledWith(['su-leader']);
    expect(result.leaderEntry).toBeNull();
    expect(result.leaderLiveness).toEqual({
      ownerId: 'su-leader',
      presenceRow: false,
      recordedLive: true,
      sessionState: 'recorded',
      complete: true,
    });
  });

  it('keeps a missing leader unknown when the recorded-session leg degrades', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    recordedLiveOwnerIdsMock.mockRejectedValue(new Error('session ledger unavailable'));

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      leaderOwnerId: 'su-leader',
      readPresence: async () => [],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.degradedLegs).toContain('recorded');
    expect(result.leaderLiveness).toMatchObject({
      ownerId: 'su-leader',
      presenceRow: false,
      recordedLive: null,
      complete: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fleet-roster:recorded failed'));
    warn.mockRestore();
  });

  it('folds the latest recorded end into leader liveness despite a warm wake-await', async () => {
    vi.setSystemTime(new Date('2026-07-10T10:00:10Z'));
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map([
      ['su-leader', { wakeable: true, liveTurn: false }],
    ]));
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    endedRecordedOwnerIdsMock.mockResolvedValue(new Set(['su-leader']));
    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes', leaderOwnerId: 'su-leader',
      readPresence: async () => [{ ...pres('su-leader'), agentRole: 'su', fleetRole: 'leader' }],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(endedRecordedOwnerIdsMock).toHaveBeenCalledWith(['su-leader']);
    expect(result.leaderLiveness).toMatchObject({ sessionState: 'ended', recordedLive: false, complete: true });
  });

  it('keeps leader liveness incomplete when the recorded end read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    endedRecordedOwnerIdsMock.mockRejectedValue(new Error('session end ledger unavailable'));
    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes', leaderOwnerId: 'su-leader', readPresence: async () => [],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result.degradedLegs).toContain('recorded');
    expect(result.leaderLiveness).toMatchObject({ recordedLive: null, complete: false });
    warn.mockRestore();
  });

  it('enriches a multi-fleet leader without adding it to the queried roster', async () => {
    vi.setSystemTime(new Date('2026-07-10T10:00:10Z'));
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(
      new Map<string, WakeabilitySignals>([
        ['su-member', { wakeable: true, liveTurn: true }],
        ['su-leader', { wakeable: true, liveTurn: true }],
      ]),
    );
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      leaderOwnerId: 'su-leader',
      readPresence: async () => [
        pres('su-member'),
        { ...pres('su-leader', 'other-fleet'), fleetRole: 'leader' },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.entries.map((entry) => entry.agentId)).toEqual(['su-member']);
    expect(result.leaderEntry).toEqual(
      expect.objectContaining({
        agentId: 'su-leader',
        fleetSlug: 'other-fleet',
        sessionState: 'live',
        alive: true,
      }),
    );
    expect(fetchWakeabilityMock).toHaveBeenCalledWith(['su-member', 'su-leader']);
  });

  it('degrades to an EMPTY roster (not a hang) when presence itself never resolves, reporting the leg', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: () => neverSettles<FleetFoldPresence[]>(),
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs).toContain('presence');
    expect(result.entries).toEqual([]);
    warnSpy.mockRestore();
  });

  it('starts the independent assignments leg before a slow presence read consumes its budget', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockReturnValue(neverSettles<FleetAssignmentRow[]>());

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: () => neverSettles<FleetFoldPresence[]>(),
    });

    // This is the regression assertion: before EI-20255612618270299 the
    // assignments query was not even started until the presence timeout fired.
    expect(listFleetAssignmentsMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs).toEqual(['presence', 'assignments']);
    expect(result.entries).toEqual([]);
    warnSpy.mockRestore();
  });

  it('degrades to a SLIM-BUT-USABLE roster (identity present, work-detail empty) when only assignments hangs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockReturnValue(neverSettles<FleetAssignmentRow[]>());

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs).toEqual(['assignments']);
    // The whole point of WI-3818: presence still answered, so the caller gets a
    // usable roster with the member's identity/liveness — just no doing/queued/load
    // detail (the "drop queued detail first" fallback happening at the fold level).
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ agentId: 'su-1', doing: null, queued: [], load: 0 }),
    );
    warnSpy.mockRestore();
  });

  it('degrades tier1 + wakeability independently while assignments answers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockReturnValue(neverSettles<Map<string, PresenceTier1Joins>>());
    fetchWakeabilityMock.mockReturnValue(neverSettles<Map<string, WakeabilitySignals>>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs.sort()).toEqual(['tier1', 'wakeability']);
    expect(result.entries).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('degrades the recorded-session leg independently while everything else answers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    recordedLiveOwnerIdsMock.mockReturnValue(neverSettles<Set<string>>());

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs).toEqual(['recorded']);
    // The rescue leg degrading must never drop the roster itself — entries
    // still fold from presence + assignments, just without the recorded rescue.
    expect(result.entries).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('degrades the self-wake leg independently, reporting UNKNOWN rather than a false alarm', async () => {
    // EI-19407725333778711. The failure direction that matters: a slow query
    // must not make every healthy member look stranded. `selfWake:'none'` is an
    // escalation-worthy claim ("nothing will ever wake this agent"), so a
    // degraded leg has to yield `null` (UNKNOWN) instead.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Pin `now` next to the fixture's heartbeat, otherwise the PRESENCE_DEAD_MS
    // ceiling force-ends su-1 and the verdict under test never reaches `parked`.
    vi.setSystemTime(new Date('2026-07-10T10:00:10Z'));
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(
      new Map<string, WakeabilitySignals>([['su-1', { wakeable: true, liveTurn: false }]]),
    );
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    fetchSelfWakeMock.mockReturnValue(neverSettles<Map<string, SelfWakeSignals>>());

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs).toEqual(['selfwake']);
    // The roster survives, and the rest of the liveness verdict is unaffected —
    // self-wake is an ENRICHMENT leg, not a gate on the read.
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].sessionState).toBe('parked');
    expect(result.entries[0].selfWake).toBeNull();
    warnSpy.mockRestore();
  });

  it('carries selfWake through to the entry when the leg answers', async () => {
    vi.setSystemTime(new Date('2026-07-10T10:00:10Z')); // see the note above
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(
      new Map<string, WakeabilitySignals>([['su-1', { wakeable: true, liveTurn: false }]]),
    );
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);
    // The incident shape: push-wakeable and parked, but nothing will wake it.
    fetchSelfWakeMock.mockResolvedValue(
      new Map<string, SelfWakeSignals>([
        ['su-1', { loopArmed: false, standingEventAwait: false, selfWake: 'none' }],
      ]),
    );

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result.degradedLegs).toEqual([]);
    expect(result.entries[0].sessionState).toBe('parked');
    expect(result.entries[0].selfWake).toBe('none');
  });

  it('listFleetRoster (back-compat wrapper) still resolves promptly with just the entries array', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockReturnValue(neverSettles<Map<string, WakeabilitySignals>>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRoster({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const entries = await resultPromise;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
