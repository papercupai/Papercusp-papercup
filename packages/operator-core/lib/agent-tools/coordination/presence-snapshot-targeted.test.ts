/**
 * EI-9454 — a targeted `coord:presence { owner }` lookup must NOT pay the
 * whole-roster assembly.
 *
 * Observed live (2026-07-11, ~67 active sessions): the targeted lookup timed out
 * at 55s→300s exactly like a full-roster read, because the `owner` filter was
 * applied AFTER the enrichment fan-out (5 batch joins + the GC DELETE) ran for
 * every session. These tests pin the fix:
 *   1. the enrichment joins receive ONLY the matched id(s), not the whole roster;
 *   2. the GC sweep (a maintenance write) is SKIPPED on the targeted point-read;
 *   3. the default (no-owner) read is UNCHANGED — full-roster joins + the sweep.
 *
 * EI-21488009366204518 adds the FOURTH synthesis leg: an owner whose presence
 * row was REAPED but whose adv_sessions records the death must answer a targeted
 * `{ owner }` lookup with an explicit synthesized `ended` row — never an empty
 * roster indistinguishable from "never existed". The tail of this file pins that.
 *
 * Hermetic: every IO seam is mocked; the pure helpers (matchesOwner,
 * selectRosterRows, mergeTier1, toStableRosterRow, deriveSessionState,
 * synthesizeEndedRosterRows) stay real so the selected rows keep production
 * semantics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { gatherOnDesktopSessions } from '../../desktop-window-liveness';

// vi.mock factories are hoisted above module-level consts — vi.hoisted() is the
// sanctioned way to share spies with them (a bare `const` here hits the TDZ).
const {
  listPresenceMock,
  federatedMock,
  recordedLiveSessionsMock,
  nurseryAliasMock,
  sweepMock,
  tier1Mock,
  wakeabilityMock,
  selfWakeMock,
  fleetMock,
  fleetControlStatesMock,
  findLiveHostMock,
  findLiveHostAsyncMock,
  readHostEventTailAsyncMock,
  desktopSessionsMock,
  endedSessionsMock,
  endedOwnerIdsMock,
} = vi.hoisted(() => ({
  listPresenceMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  federatedMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  recordedLiveSessionsMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  nurseryAliasMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  sweepMock: vi.fn(async (..._a: unknown[]) => 0),
  tier1Mock: vi.fn(async (..._a: unknown[]) => new Map()),
  wakeabilityMock: vi.fn(async (..._a: unknown[]) => new Map()),
  selfWakeMock: vi.fn(async (..._a: unknown[]) => new Map()),
  fleetMock: vi.fn(async (..._a: unknown[]) => new Map()),
  fleetControlStatesMock: vi.fn(async (..._a: unknown[]) => new Map()),
  findLiveHostMock: vi.fn<(id: string) => { ownerId: string } | null>(() => null),
  findLiveHostAsyncMock: vi.fn<(id: string) => Promise<{ ownerId: string } | null>>(async () => null),
  // P-011(a): the host-condition leg reads the host's lifecycle tail. Mocked so the
  // suite never touches a real ~/.papercusp/psu-pty events file.
  readHostEventTailAsyncMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  desktopSessionsMock: vi.fn<typeof gatherOnDesktopSessions>(async () => ({
    owners: new Set<string>(), sessionIds: new Set<string>(), advSessionIds: new Set<number>(), windowSignalUnknown: false,
  })),
  // EI-21488009366204518: the targeted-miss session-log death leg.
  endedSessionsMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  // WI-10006738: the oracle's positive ended-session leg (latest adv_session ended).
  endedOwnerIdsMock: vi.fn(async (..._a: unknown[]) => new Set<string>()),
}));
// importOriginal spread (not a bare factory): real presence-wakeability — kept
// real below via its own importOriginal — imports PRESENCE_STALE_MS from
// './presence'; a factory-only mock drops that export and the whole module
// graph fails to collect ("error when mocking a module").
vi.mock('./presence', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listPresence: listPresenceMock,
  sweepStalePresence: sweepMock,
}));
vi.mock('./federated-presence', () => ({ listFederatedPresence: federatedMock }));
vi.mock('../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../adv-sessions')>()),
  listRecordedLiveSessions: recordedLiveSessionsMock,
  // Unification P-002: the snapshot's recorded-session oracle leg.
  recordedLiveOwnerIds: vi.fn(async () => new Set<string>()),
  // EI-21488009366204518: the targeted-miss session-log death leg.
  listEndedAdvSessionsByOwners: endedSessionsMock,
  endedRecordedOwnerIds: endedOwnerIdsMock,
}));
// Pass-through reconcile: the test rows below are already RosterRow-shaped.
// importOriginal keeps the REAL synthesizeEndedRosterRows so the
// EI-21488009366204518 leg runs its production synthesis in these fixtures.
vi.mock('./recorded-sessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileRosterSources: (rows: unknown[]) => rows,
}));
// EI-16639: the nursery-alias leg — no running nursery bees in these fixtures,
// so it contributes nothing (existing counts/ids stay exactly as asserted below).
vi.mock('./nursery-alias-liveness', () => ({
  listRunningNurseryAliasRows: nurseryAliasMock,
  synthesizeNurseryAliasRosterRows: () => [],
  NURSERY_ALIAS_SOURCE: 'nursery-alias',
}));
vi.mock('./presence-tier1', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPresenceTier1: tier1Mock,
}));
vi.mock('./presence-wakeability', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWakeability: wakeabilityMock,
}));
vi.mock('./presence-selfwake', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchSelfWake: selfWakeMock,
}));
vi.mock('./presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPresenceFleet: fleetMock,
}));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFleetControlStates: fleetControlStatesMock,
}));
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findLiveHost: findLiveHostMock,
  findLiveHostAsync: findLiveHostAsyncMock,
  readHostEventTailAsync: readHostEventTailAsyncMock,
}));
vi.mock('../../desktop-window-liveness', () => ({
  gatherOnDesktopSessions: desktopSessionsMock,
}));
vi.mock('../../pty-viewer-heartbeat', () => ({ gatherViewerAttachedOwners: vi.fn(async () => new Set<string>()) }));
vi.mock('../locks/su-lock-store', () => ({
  getTxPool: vi.fn(),
  readPathInterestsByOwner: vi.fn(async () => []),
}));
vi.mock('./watermarks', () => ({ writeWatermark: vi.fn(async () => undefined) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));

import {
  assemblePresenceSnapshot,
  renderPresenceRebootstrapBlock,
  PRESENCE_OPTIONAL_LEG_TIMEOUT_MS,
  PRESENCE_SOURCE_LEG_TIMEOUT_MS,
  type PresenceSnapshotDiagnostic,
  type ResolvedPresenceScope,
} from './presence-snapshot';
import { RECORDED_ENDED_SESSION_SOURCE, RECORDED_SESSION_SOURCE } from './recorded-sessions';

const RESOLVED: ResolvedPresenceScope = { scope: 'workspace', wsId: 'test-ws', potId: null };

const row = (ownerId: string, stale: boolean) => ({
  ownerId,
  ownerLabel: `su · ${ownerId}`,
  stale,
  heartbeatAt: null,
  lastActiveAt: null,
  intentDeclaredAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  findLiveHostAsyncMock.mockImplementation(async (ownerId: string) => findLiveHostMock(ownerId));
  // clearAllMocks keeps mockResolvedValue IMPLEMENTATIONS — restore the leg
  // defaults explicitly so the EI-21488009366204518 tests cannot leak their
  // fixtures into each other (order-dependent false positives).
  endedSessionsMock.mockResolvedValue([]);
  endedOwnerIdsMock.mockResolvedValue(new Set<string>());
  fleetMock.mockResolvedValue(new Map());
  fleetControlStatesMock.mockResolvedValue(new Map());
  findLiveHostMock.mockImplementation(() => null);
  readHostEventTailAsyncMock.mockResolvedValue([]);
  listPresenceMock.mockResolvedValue([row('su-aaa', false), row('su-bbb', false), row('su-ccc', true)]);
  federatedMock.mockResolvedValue([]);
  recordedLiveSessionsMock.mockResolvedValue([]);
  nurseryAliasMock.mockResolvedValue([]);
  selfWakeMock.mockResolvedValue(new Map());
});

describe('assemblePresenceSnapshot targeted { owner } lookup (EI-9454)', () => {
  it('pushes targeted selectors into every broad source leg', async () => {
    await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });

    expect(listPresenceMock).toHaveBeenCalledWith({
      workspaceId: 'test-ws',
      potSlug: null,
      ownerIds: ['su-bbb'],
    });
    expect(federatedMock).toHaveBeenCalledWith({
      workspaceId: 'test-ws',
      potSlug: null,
      ownerIds: ['su-bbb'],
    });
    expect(recordedLiveSessionsMock).toHaveBeenCalledWith({
      workspaceId: 'test-ws',
      ownerIds: ['su-bbb'],
    });
    expect(nurseryAliasMock).toHaveBeenCalledWith({
      workspaceId: 'test-ws',
      ownerIds: ['su-bbb'],
    });
    expect(desktopSessionsMock).toHaveBeenCalledWith(expect.objectContaining({ ownerIds: ['su-bbb'] }));
  });

  it('enriches ONLY the matched id — the batch joins never see the rest of the roster', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });
    // The load-bearing assertion: every per-owner join got the 1 matched id,
    // not the 2-3 roster ids (under real load: 1 id, not ~67).
    expect(tier1Mock).toHaveBeenCalledWith(['su-bbb']);
    expect(wakeabilityMock).toHaveBeenCalledWith(['su-bbb']);
    expect(selfWakeMock).toHaveBeenCalledWith(['su-bbb']);
    expect(fleetMock).toHaveBeenCalledWith(['su-bbb'], {
      workspaceId: 'test-ws',
      liveSessionLogOwnerIds: [],
    });
    // Selection semantics preserved: the matched row comes back, alone.
    expect(snap.active.map((r) => (r as { ownerId?: string }).ownerId)).toEqual(['su-bbb']);
    // Summary describes the matched subset on a targeted read.
    expect(snap.summary.active).toBe(1);
    expect(snap.summary.stale).toBe(0);
  });

  it('skips the GC sweep on the targeted point-read', async () => {
    await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('requests the ledger fallback only for session-log rows with a live verdict', async () => {
    const liveOwner = 'su-session-log-live';
    const parkedOwner = 'su-session-log-parked';
    listPresenceMock.mockResolvedValue([
      { ...row(liveOwner, false), source: RECORDED_SESSION_SOURCE },
      { ...row(parkedOwner, false), source: RECORDED_SESSION_SOURCE },
    ]);
    wakeabilityMock.mockResolvedValue(new Map([
      [liveOwner, { wakeable: false, liveTurn: true }],
      [parkedOwner, { wakeable: true, liveTurn: false }],
    ]));
    fleetMock.mockResolvedValue(new Map([
      [liveOwner, { fleetSlug: 'ledger-fleet', fleetRole: 'member' }],
    ]));

    const snap = await assemblePresenceSnapshot(RESOLVED, {});

    expect(fleetMock).toHaveBeenCalledWith([liveOwner, parkedOwner], {
      workspaceId: 'test-ws',
      liveSessionLogOwnerIds: [liveOwner],
    });
    expect(snap.active.find((r) => r.ownerId === liveOwner)).toMatchObject({
      sessionState: 'live',
      fleetSlug: 'ledger-fleet',
      fleetRole: 'member',
    });
    const parked = snap.active.find((r) => r.ownerId === parkedOwner);
    expect(parked?.sessionState).toBe('parked');
    expect(parked?.fleetSlug).toBeUndefined();
  });

  it('matches a STALE owner too — the "inspect one dead agent" path still enriches it', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'su-ccc' });
    expect(wakeabilityMock).toHaveBeenCalledWith(['su-ccc']); // stale locals still get wakeability
    expect(tier1Mock).toHaveBeenCalledWith([]); // tier-1 stays ACTIVE-only (P-003) — unchanged
    expect(snap.active.map((r) => (r as { ownerId?: string }).ownerId)).toEqual(['su-ccc']);
    expect(snap.summary.stale).toBe(1);
  });

  it('bounds desktop discovery to the complete local roster, including stale rows', async () => {
    const localRows = [row('su-local-active', false), row('su-local-stale', true)];
    listPresenceMock.mockResolvedValue(localRows);
    federatedMock.mockResolvedValue([{ ...row('su-federated', false), federated: true }]);

    await assemblePresenceSnapshot(RESOLVED, {});

    expect(desktopSessionsMock).toHaveBeenCalledWith(expect.objectContaining({
      ownerIds: ['su-local-active', 'su-local-stale'],
    }));
  });

  it('fuzzy owner match (substring) still works through the early filter', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'bbb' });
    expect(snap.active.map((r) => (r as { ownerId?: string }).ownerId)).toEqual(['su-bbb']);
    expect(tier1Mock).toHaveBeenCalledWith(['su-bbb']);
  });

  it('default (no-owner) read is UNCHANGED: whole-roster joins + the GC sweep run', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(sweepMock).toHaveBeenCalledTimes(1);
    expect(desktopSessionsMock).toHaveBeenCalledTimes(1);
    expect(desktopSessionsMock).toHaveBeenCalledWith(expect.objectContaining({
      ownerIds: ['su-aaa', 'su-bbb', 'su-ccc'],
    }));
    expect(tier1Mock).toHaveBeenCalledWith(['su-aaa', 'su-bbb']); // active locals
    expect(wakeabilityMock).toHaveBeenCalledWith(['su-aaa', 'su-bbb', 'su-ccc']); // all locals
    expect(snap.summary.active).toBe(2);
    expect(snap.summary.stale).toBe(1);
  });

  it('uses async host discovery for targeted snapshots, never the synchronous filesystem lookup', async () => {
    const owner = 'su-targeted-host';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'psu' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: false, liveTurn: false }]]));
    findLiveHostAsyncMock.mockResolvedValue({ ownerId: owner });

    await assemblePresenceSnapshot(RESOLVED, { owner });

    expect(findLiveHostAsyncMock).toHaveBeenCalledWith(owner);
    expect(findLiveHostMock).not.toHaveBeenCalled();
  });

  it('skips desktop-only enrichment when building the compact rebootstrap snapshot', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { includeDesktopEnrichment: false });

    expect(desktopSessionsMock).not.toHaveBeenCalled();
    expect(snap.active.map((r) => r.ownerId)).toEqual(['su-aaa', 'su-bbb', 'su-ccc']);
    expect(snap.summary.active).toBe(2);
    expect(snap.summary.stale).toBe(1);
  });

  it('rebootstrap marks host-dependent state unknown without running host lookup or host conditions', async () => {
    const owner = 'su-pty-rebootstrap';
    const noHostDependentStateOwner = 'su-no-pty-role';
    listPresenceMock.mockResolvedValue([
      { ...row(owner, false), agentRole: 'su', source: 'psu' },
      row(noHostDependentStateOwner, false),
    ]);
    wakeabilityMock.mockResolvedValue(new Map([
      [owner, { wakeable: true, liveTurn: false }],
      [noHostDependentStateOwner, { wakeable: true, liveTurn: false }],
    ]));
    findLiveHostAsyncMock.mockResolvedValue({ ownerId: owner, authBlocked: false } as { ownerId: string });

    const snap = await assemblePresenceSnapshot(RESOLVED, {
      includeDesktopEnrichment: false,
      rebootstrapProjection: true,
    });
    const restored = snap.active.find((r) => r.ownerId === owner);
    const unaffected = snap.active.find((r) => r.ownerId === noHostDependentStateOwner);

    expect(findLiveHostAsyncMock).not.toHaveBeenCalled();
    expect(readHostEventTailAsyncMock).not.toHaveBeenCalled();
    expect(restored?.sessionState).toBeNull();
    expect(restored?.confirmLiveness).toBe(true);
    expect(unaffected?.sessionState).toBe('parked');
    expect(unaffected?.confirmLiveness).toBe(false);
    expect(snap.active).toHaveLength(2);
    expect(snap.summary.byState).toMatchObject({ parked: 1, ended: 0, unknown: 1 });
    expect(renderPresenceRebootstrapBlock(snap)).toContain('[liveness unknown]');
    expect(renderPresenceRebootstrapBlock(snap)).toContain('su-no-pty-role [—]');
  });

  it('positive live psu host keeps a non-wakeable su row out of ended', async () => {
    const owner = 'su-pty-live';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'psu' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: false, liveTurn: false }]]));
    findLiveHostMock.mockImplementation((id: string) => (id === owner ? { ownerId: id } : null));

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(snap.active.find((r) => r.ownerId === owner)?.sessionState).toBe('recorded');
  });

  // P-011(a) / D-011: coord:presence trusts a live psu host as proof of life, so it
  // must also ask whether that host can take a turn. Positive control first: a
  // healthy host keeps a wakeable row `parked` with no wedged condition.
  it('P-011: a healthy live psu host keeps a wakeable su row parked, wedged null', async () => {
    const owner = 'su-pty-healthy';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'psu' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    findLiveHostMock.mockImplementation((id: string) =>
      id === owner ? { ownerId: id, authBlocked: false } : null,
    );

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    const r = snap.active.find((x) => x.ownerId === owner);
    expect(r?.sessionState).toBe('parked');
    expect((r as { wedged?: unknown } | undefined)?.wedged ?? null).toBeNull();
    expect(readHostEventTailAsyncMock).toHaveBeenCalledWith(owner);
  });

  it('P-011: a live psu host with dead provider auth reads suspect + wedged auth-blocked, not parked', async () => {
    const owner = 'su-pty-dead-auth';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'psu' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    findLiveHostMock.mockImplementation((id: string) =>
      id === owner ? { ownerId: id, authBlocked: true } : null,
    );

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    const r = snap.active.find((x) => x.ownerId === owner);
    expect(r?.sessionState).toBe('suspect');
    expect((r as { wedged?: unknown } | undefined)?.wedged).toBe('auth-blocked');
  });

  it('P-011: the targeted { owner } read applies the same host-condition leg', async () => {
    const owner = 'su-pty-dead-auth-targeted';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'psu' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    findLiveHostAsyncMock.mockResolvedValue({ ownerId: owner, authBlocked: true } as { ownerId: string });

    const snap = await assemblePresenceSnapshot(RESOLVED, { owner });
    const r = snap.active.find((x) => x.ownerId === owner);
    expect(r?.sessionState).toBe('suspect');
    expect((r as { wedged?: unknown } | undefined)?.wedged).toBe('auth-blocked');
  });

  it('P-011: a host-condition leg failure is fail-soft — the row keeps its plain derivation', async () => {
    const owner = 'su-pty-tail-throws';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'psu' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    findLiveHostMock.mockImplementation((id: string) =>
      id === owner ? { ownerId: id, authBlocked: false } : null,
    );
    readHostEventTailAsyncMock.mockRejectedValue(new Error('EACCES'));

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    const r = snap.active.find((x) => x.ownerId === owner);
    expect(r?.sessionState).toBe('parked');
    expect((r as { wedged?: unknown } | undefined)?.wedged ?? null).toBeNull();
  });

  it('reports snapshot legs and synchronous host lookup cost through the diagnostic seam', async () => {
    const owner = 'su-pty-live';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'psu' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: false, liveTurn: false }]]));
    findLiveHostMock.mockImplementation((id: string) => (id === owner ? { ownerId: id } : null));
    const diagnostics: PresenceSnapshotDiagnostic[] = [];

    await assemblePresenceSnapshot(RESOLVED, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'source', name: 'initialReadBatch', status: 'ok' }),
      expect.objectContaining({ phase: 'enrichment', name: 'enrichmentBatch', status: 'ok' }),
      expect.objectContaining({ phase: 'enrichment', name: 'gatherOnDesktopSessions', status: 'ok' }),
      expect.objectContaining({ phase: 'derivation', name: 'deriveVerdictAndRowDecorators', status: 'ok' }),
    ]));
    const derivation = diagnostics.find((item) => item.name === 'deriveVerdictAndRowDecorators');
    expect(derivation?.details?.hostLookupCalls).toBeGreaterThan(0);
    expect(derivation?.details?.hostLookupTotalMs).toEqual(expect.any(Number));
    expect(derivation?.details?.hostLookupMaxMs).toEqual(expect.any(Number));
  });

  it('surfaces on-desktop awaited substep timings in the presence diagnostics', async () => {
    desktopSessionsMock.mockImplementation(async (opts) => {
      opts?.onDiagnostic?.({ name: 'findLiveHost', elapsedMs: 12, status: 'error' });
      return { owners: new Set<string>(), sessionIds: new Set<string>(), advSessionIds: new Set<number>(), windowSignalUnknown: false };
    });
    const diagnostics: PresenceSnapshotDiagnostic[] = [];

    await assemblePresenceSnapshot(RESOLVED, {
      owner: 'su-bbb',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(diagnostics).toContainEqual({
      phase: 'enrichment',
      name: 'gatherOnDesktopSessions.findLiveHost',
      elapsedMs: 12,
      status: 'error',
    });
  });

  it('degrades a wedged desktop enrichment leg at the caller deadline', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      desktopSessionsMock.mockImplementation(() => new Promise(() => {}));
      const snapshot = assemblePresenceSnapshot(RESOLVED, {});
      await vi.advanceTimersByTimeAsync(PRESENCE_OPTIONAL_LEG_TIMEOUT_MS + 1);
      const result = await snapshot;

      expect(result.summary.active).toBe(2);
      expect(result.active.map((r) => r.ownerId)).toEqual(['su-aaa', 'su-bbb', 'su-ccc']);
      expect(result.active.every((r) => r.onDesktop === false)).toBe(true);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
      desktopSessionsMock.mockResolvedValue({
        owners: new Set<string>(),
        sessionIds: new Set<string>(),
        advSessionIds: new Set<number>(),
        windowSignalUnknown: false,
      });
    }
  });

  it('degrades a wedged optional database enrichment leg at the caller deadline', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      selfWakeMock.mockImplementation(() => new Promise(() => {}));
      const diagnostics: PresenceSnapshotDiagnostic[] = [];
      const snapshot = assemblePresenceSnapshot(RESOLVED, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await vi.advanceTimersByTimeAsync(PRESENCE_OPTIONAL_LEG_TIMEOUT_MS + 1);
      const result = await snapshot;

      expect(result.summary.active).toBe(2);
      expect(result.active.map((r) => r.ownerId)).toEqual(['su-aaa', 'su-bbb', 'su-ccc']);
      expect(diagnostics).toContainEqual(expect.objectContaining({
        phase: 'enrichment',
        name: 'fetchSelfWake',
        status: 'error',
      }));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('degrades a wedged base source leg before the transport deadline', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      listPresenceMock.mockImplementation(() => new Promise(() => {}));
      const diagnostics: PresenceSnapshotDiagnostic[] = [];
      const snapshot = assemblePresenceSnapshot(RESOLVED, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await vi.advanceTimersByTimeAsync(PRESENCE_SOURCE_LEG_TIMEOUT_MS + 1);
      const result = await snapshot;

      expect(result.summary.active).toBe(0);
      expect(result.active).toEqual([]);
      expect(diagnostics).toContainEqual(expect.objectContaining({
        phase: 'source',
        name: 'listPresence',
        status: 'error',
      }));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  // WI-10006738: coord:presence used to omit the oracle's positive ended-session
  // leg, so a session whose latest adv_session had ENDED (here: a launch that
  // never booted, closed as 'cleanup') read `parked`/wakeable for as long as its
  // heartbeat stayed warm — while resolveSessionStates (fleet:status,
  // fleet:assignments, send-miss) said `ended` for the same owner.
  it('a warm, wakeable row whose latest adv_session ENDED reads ended on the targeted read', async () => {
    const owner = 'su-ended-warm';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'omp-hook-session' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    endedOwnerIdsMock.mockResolvedValue(new Set([owner]));

    const snap = await assemblePresenceSnapshot(RESOLVED, { owner });
    expect(endedOwnerIdsMock).toHaveBeenCalledWith([owner]);
    expect(snap.active.find((r) => r.ownerId === owner)?.sessionState).toBe('ended');
  });

  it('the default roster drops that ended row like every other ended row (no wakeable corpse)', async () => {
    const dead = 'su-ended-warm';
    const alive = 'su-still-parked';
    listPresenceMock.mockResolvedValue([row(dead, false), row(alive, false)]);
    wakeabilityMock.mockResolvedValue(
      new Map([
        [dead, { wakeable: true, liveTurn: false }],
        [alive, { wakeable: true, liveTurn: false }],
      ]),
    );
    endedOwnerIdsMock.mockResolvedValue(new Set([dead]));

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(endedOwnerIdsMock).toHaveBeenCalledWith([dead, alive]);
    expect(snap.active.map((r) => r.ownerId)).toEqual([alive]);
    expect(snap.active[0]?.sessionState).toBe('parked');
  });

  it('a failed ended-session read degrades to the prior verdict, never to a death claim', async () => {
    const owner = 'su-ended-leg-down';
    listPresenceMock.mockResolvedValue([row(owner, false)]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    endedOwnerIdsMock.mockRejectedValue(new Error('pg down'));

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(snap.active.find((r) => r.ownerId === owner)?.sessionState).toBe('parked');
  });

  it('emits parked + selfWake:none so a healthy-looking member is visibly stranded', async () => {
    const owner = 'su-stranded';
    listPresenceMock.mockResolvedValue([row(owner, false)]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    selfWakeMock.mockResolvedValue(
      new Map([[owner, { loopArmed: false, standingEventAwait: false, selfWake: 'none' }]]),
    );

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(snap.active[0]).toMatchObject({
      ownerId: owner,
      sessionState: 'parked',
      wakeable: true,
      loopArmed: false,
      selfWake: 'none',
    });
  });

  it('emits null self-wake fields when enrichment is absent, never fabricating none', async () => {
    const owner = 'su-selfwake-unknown';
    listPresenceMock.mockResolvedValue([row(owner, false)]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    selfWakeMock.mockResolvedValue(new Map());

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(snap.active[0]).toMatchObject({
      ownerId: owner,
      sessionState: 'parked',
      loopArmed: null,
      selfWake: null,
    });
  });
});

describe('assemblePresenceSnapshot targeted { owner } lookup — reaped-row session-log leg (EI-21488009366204518)', () => {
  const DEAD = 'su-reaped-dead';
  const endedSessionRow = {
    coordOwnerId: DEAD,
    workspaceId: 'test-ws',
    planSlug: null,
    role: 'su',
    pid: null,
    startedAt: '2026-08-25T13:00:00.000Z',
    endedAt: '2026-08-25T14:06:45.000Z',
    label: null,
  };

  it('synthesizes an ENDED row for a reaped owner whose adv_sessions records the death', async () => {
    endedSessionsMock.mockResolvedValue([endedSessionRow]);
    // A reaped row comes from positive ended_at evidence, not the live
    // session-log marker that means the owner may still be starting.
    wakeabilityMock.mockResolvedValue(new Map([[DEAD, { wakeable: false, liveTurn: false }]]));

    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: DEAD });
    // The miss fired the leg with exactly the needle…
    expect(endedSessionsMock).toHaveBeenCalledWith([DEAD]);
    // …the synthesized row came back…
    const emitted = snap.active.find((r) => r.ownerId === DEAD);
    expect(emitted).toBeDefined();
    // …and the end marker cannot be mistaken for a live session-log row.
    expect(emitted?.source).toBe(RECORDED_ENDED_SESSION_SOURCE);
    expect(emitted?.source).not.toBe(RECORDED_SESSION_SOURCE);
    // …so the shared oracle classified it explicitly dead, not unknown.
    expect(emitted?.sessionState).toBe('ended');
    // The summary says HOW the needle resolved (session-log evidence, not presence).
    expect(snap.summary.ownerLookup).toEqual({ needle: DEAD, matched: 1, fromSessionLog: true });
  });

  it('a genuinely UNKNOWN id stays an explicit not-found, distinct from the ended case', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'su-never-existed' });
    expect(endedSessionsMock).toHaveBeenCalledWith(['su-never-existed']); // the leg ran…
    expect(snap.active).toEqual([]); // …found nothing…
    // …and the summary says so EXPLICITLY instead of reading as silent absence.
    expect(snap.summary.ownerLookup).toEqual({ needle: 'su-never-existed', matched: 0, fromSessionLog: false });
  });

  it('the ended-session leg is never queried when the needle matches the roster', async () => {
    await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });
    expect(endedSessionsMock).not.toHaveBeenCalled();
  });

  it('the default (no-owner) read never pays the session-log leg', async () => {
    await assemblePresenceSnapshot(RESOLVED, {});
    expect(endedSessionsMock).not.toHaveBeenCalled();
  });
});
