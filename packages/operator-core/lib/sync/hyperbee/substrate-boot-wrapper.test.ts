/**
 * substrate-boot-wrapper.test.ts — the LAZY_SUBSTRATE_BOOT reaper gating
 * (P-008 / WI-596). Proves: OFF ⇒ the reaper never starts (byte-identical eager
 * boot); ON ⇒ tracking is enabled + the reaper starts exactly once (idempotent).
 *
 * Also proves the dark SUBSTRATE_SIDECAR path now boots via remote handles when
 * enabled, while preserving the in-process fallback on startup failure.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

vi.mock('../../degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../degradation/fallback-observations')>()),
  observeFallback: vi.fn(() => true),
}));
afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});

const h = { lazyOn: false, sidecarOn: false, mergeCursorPgOn: false };

vi.mock('@papercusp/flags/server', () => ({
  getFlag: async (key: string) => {
    if (key.includes('lazy-substrate-boot')) return h.lazyOn;
    if (key.includes('substrate-sidecar')) return h.sidecarOn;
    if (key.includes('substrate-merge-cursor-pg')) return h.mergeCursorPgOn;
    return false;
  },
  onFlagChange: () => {},
}));
const enableTracking = vi.fn();
const bootAll = vi.fn(async (opts?: { bootHarness?: (o: any) => Promise<any>; skipSendSideWiring?: boolean }) => {
  if (opts?.bootHarness) {
    await opts.bootHarness({
      workspaceRoot: '/tmp/ws',
      workspaceId: 'ws',
      harnessSlug: 'h',
      swarmBinding: null,
    });
  }
  return {
    attempted: opts?.bootHarness ? 1 : 0,
    booted: opts?.bootHarness ? 1 : 0,
    alreadyBooted: 0,
    failed: 0,
    results: opts?.bootHarness ? [{ workspaceId: 'ws', harnessSlug: 'h', state: 'booted' as const }] : [],
  };
});
const setBootDefaults = vi.fn();
vi.mock('./boot-all', () => ({
  bootAllHarnessesForActiveWorkspace: (opts?: unknown) => bootAll(opts as Parameters<typeof bootAll>[0]),
  closeInProcessBootedHarnesses: async () => [],
  enableSubstrateEvictionTracking: () => enableTracking(),
  gatherBootedHarnessFacts: () => [],
  evictBootedHarnessEngine: async () => false,
  setSubstrateBootDefaults: (o: unknown) => setBootDefaults(o),
  reconcileRemoteHandlesAfterSidecarRestart: () => reconcileRemoteHandles(),
}));

const spawnSidecar = vi.fn(async () => {});
const registerShutdown = vi.fn();
const stopSidecar = vi.fn(async () => {});
const respawnListeners: Array<() => void> = [];
const onSidecarRespawnedMock = vi.fn((listener: () => void) => {
  respawnListeners.push(listener);
  return () => {
    const i = respawnListeners.indexOf(listener);
    if (i >= 0) respawnListeners.splice(i, 1);
  };
});
vi.mock('./substrate-sidecar-spawn', () => ({
  spawnSubstrateSidecar: () => spawnSidecar(),
  registerSidecarShutdownHooks: () => registerShutdown(),
  stopSubstrateSidecar: () => stopSidecar(),
  onSidecarRespawned: (listener: () => void) => onSidecarRespawnedMock(listener),
}));

const reconcileRemoteHandles = vi.fn(async () => ({ rebooted: [], failed: [] }));

const ipcCalls: Array<{ method: string; params?: unknown }> = [];
const ipcClient = {
  async call<T>(method: string, params?: unknown): Promise<T> {
    ipcCalls.push({ method, params });
    if (method === 'sidecar:healthz') return { status: 'ready' } as T;
    if (method === 'substrate:bootHarness') {
      return { storeId: 'store-1', ownLogKey: 'a'.repeat(64), ownLogLength: 0 } as T;
    }
    return undefined as T;
  },
};
vi.mock('./substrate-ipc-client', () => ({
  getSubstrateIpcClient: () => ipcClient,
}));

const startReaper = vi.fn((_opts?: unknown) => ({ stop: vi.fn(), tickOnce: vi.fn(async () => []) }));
vi.mock('./substrate-eviction-reaper', () => ({
  startSubstrateEvictionReaper: (opts: unknown) => startReaper(opts),
}));

const startKeepalive = vi.fn(() => ({ stop: vi.fn(async () => {}) }));
vi.mock('./substrate-outbox-keepalive', () => ({
  startSubstrateOutboxKeepalive: () => startKeepalive(),
}));

const mockOrgPg = vi.fn(() => ({ sql: { listen: vi.fn(async () => ({ unlisten: vi.fn(async () => {}) })) } }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => mockOrgPg(),
}));

import {
  bootSubstrateWithFallback,
  maybeStartSubstrateEvictionReaper,
  stopSubstrateEvictionReaper,
  _resetSidecarRespawnReconcileRegistrationForTests,
} from './substrate-boot-wrapper';
import { createPgMergeCursorStore } from './pg-merge-cursor-store';

beforeEach(() => {
  delete process.env.PAPERCUSP_SUBSTRATE_EVICTION_INTERVAL_MS;
  delete process.env.PAPERCUSP_SUBSTRATE_EVICTION_IDLE_MS;
  h.lazyOn = false;
  h.sidecarOn = false;
  h.mergeCursorPgOn = false;
  enableTracking.mockClear();
  bootAll.mockClear();
  spawnSidecar.mockClear();
  registerShutdown.mockClear();
  stopSidecar.mockClear();
  ipcCalls.length = 0;
  startReaper.mockClear();
  startKeepalive.mockClear();
  mockOrgPg.mockClear();
  setBootDefaults.mockClear();
  onSidecarRespawnedMock.mockClear();
  reconcileRemoteHandles.mockClear();
  respawnListeners.length = 0;
  _resetSidecarRespawnReconcileRegistrationForTests();
  stopSubstrateEvictionReaper(); // reset the module singleton between tests
});
afterEach(() => {
  stopSubstrateEvictionReaper();
  vi.unstubAllGlobals();
});

describe('LAZY_SUBSTRATE_BOOT reaper gating', () => {
  it('does NOT start the reaper when the flag is OFF', async () => {
    h.lazyOn = false;
    const started = await maybeStartSubstrateEvictionReaper();
    expect(started).toBe(false);
    expect(startReaper).not.toHaveBeenCalled();
    expect(enableTracking).not.toHaveBeenCalled();
  });

  it('starts the reaper + enables tracking when the flag is ON', async () => {
    h.lazyOn = true;
    const started = await maybeStartSubstrateEvictionReaper();
    expect(started).toBe(true);
    expect(enableTracking).toHaveBeenCalledOnce();
    expect(startReaper).toHaveBeenCalledOnce();
  });

  it('threads positive operational timing overrides without changing defaults', async () => {
    h.lazyOn = true;
    process.env.PAPERCUSP_SUBSTRATE_EVICTION_INTERVAL_MS = '250';
    process.env.PAPERCUSP_SUBSTRATE_EVICTION_IDLE_MS = '500';
    await maybeStartSubstrateEvictionReaper();
    expect(startReaper).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 250, idleMs: 500 }),
    );

    stopSubstrateEvictionReaper();
    startReaper.mockClear();
    process.env.PAPERCUSP_SUBSTRATE_EVICTION_INTERVAL_MS = '0';
    process.env.PAPERCUSP_SUBSTRATE_EVICTION_IDLE_MS = 'not-a-number';
    await maybeStartSubstrateEvictionReaper();
    expect(startReaper).toHaveBeenCalledWith(
      expect.not.objectContaining({ intervalMs: expect.anything(), idleMs: expect.anything() }),
    );
  });

  it('is idempotent — a second call does not start a second reaper', async () => {
    h.lazyOn = true;
    await maybeStartSubstrateEvictionReaper();
    await maybeStartSubstrateEvictionReaper();
    expect(startReaper).toHaveBeenCalledOnce();
  });
});

describe('bootSubstrateWithFallback', () => {
  it('OFF: boots in-process, no sidecar, no reaper', async () => {
    const r = await bootSubstrateWithFallback();
    expect(bootAll).toHaveBeenCalledOnce();
    // The process-global boot defaults are CLEARED so standalone bootSingleHarness/
    // rekeyHarness boot in-process + wire the drain in-process (the default path).
    expect(setBootDefaults).toHaveBeenCalledWith({ bootHarness: null, skipSendSideWiring: false, mergeCursorStoreFactory: null });
    expect(r.usedSidecar).toBe(false);
    expect(r.evictionReaperStarted).toBe(false);
    expect(startReaper).not.toHaveBeenCalled();
    // Keepalive rides the same flag gate — OFF ⇒ never started (byte-identical).
    expect(r.outboxKeepaliveStarted).toBe(false);
    expect(startKeepalive).not.toHaveBeenCalled();
  });

  // WI-3297: the in-process path must install the PG merge-cursor factory when
  // its flag is ON — without it a packaged install (no sidecar) never persists
  // fold positions and re-folds the whole seed log from 0 on every boot.
  it('WI-3297 in-process + merge-cursor flag ON: installs createPgMergeCursorStore as the factory', async () => {
    h.mergeCursorPgOn = true;
    const r = await bootSubstrateWithFallback();
    expect(r.usedSidecar).toBe(false);
    expect(setBootDefaults).toHaveBeenCalledWith({
      bootHarness: null,
      skipSendSideWiring: false,
      mergeCursorStoreFactory: createPgMergeCursorStore,
    });
  });

  it('WI-3297 sidecar ON: clears the merge-cursor factory (sidecar host builds its own)', async () => {
    h.sidecarOn = true;
    h.mergeCursorPgOn = true;
    await bootSubstrateWithFallback();
    expect(setBootDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ bootHarness: expect.any(Function), mergeCursorStoreFactory: null }),
    );
  });

  it('lazy ON: boots in-process AND starts the reaper + outbox keepalive', async () => {
    h.lazyOn = true;
    const r = await bootSubstrateWithFallback();
    expect(bootAll).toHaveBeenCalledOnce();
    expect(r.usedSidecar).toBe(false);
    expect(r.evictionReaperStarted).toBe(true);
    expect(startReaper).toHaveBeenCalledOnce();
    // AC#2 wiring: the re-boot-on-NOTIFY keepalive starts alongside the reaper.
    expect(r.outboxKeepaliveStarted).toBe(true);
    expect(startKeepalive).toHaveBeenCalledOnce();
  });

  it('sidecar ON: spawns sidecar and boots harnesses through remote handle factory', async () => {
    h.sidecarOn = true;
    const r = await bootSubstrateWithFallback();
    expect(spawnSidecar).toHaveBeenCalledOnce();
    expect(registerShutdown).toHaveBeenCalledOnce();
    expect(bootAll).toHaveBeenCalledWith(expect.objectContaining({ skipSendSideWiring: true }));
    // THE FIX: the sidecar boot config is registered PROCESS-GLOBALLY so EVERY
    // standalone boot route (owner publishCreatedHive, joiner joinHiveAsView /
    // join-shared-harness) routes through the sidecar too — not just this sweep.
    expect(setBootDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ bootHarness: expect.any(Function), skipSendSideWiring: true }),
    );
    expect(ipcCalls.map((c) => c.method)).toEqual(['sidecar:healthz', 'substrate:bootHarness']);
    expect(r.usedSidecar).toBe(true);
    expect(r.booted).toBe(1);
  });

  // WI-1877: a sidecar crash-respawn only restarts the PROCESS — nothing
  // re-boots the harnesses onto it unless this registration runs the
  // reconcile in response.
  it('WI-1877: registers a post-respawn reconcile hook when the sidecar boots', async () => {
    h.sidecarOn = true;
    await bootSubstrateWithFallback();

    expect(onSidecarRespawnedMock).toHaveBeenCalledTimes(1);
    expect(reconcileRemoteHandles).not.toHaveBeenCalled(); // only fires ON a respawn notification

    // Simulate the substrate-sidecar-spawn module notifying a respawn.
    respawnListeners.forEach((l) => l());
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcileRemoteHandles).toHaveBeenCalledTimes(1);
  });

  it('WI-1877: registers the reconcile hook at most once across repeated sidecar boots', async () => {
    h.sidecarOn = true;
    await bootSubstrateWithFallback();
    await bootSubstrateWithFallback();

    expect(onSidecarRespawnedMock).toHaveBeenCalledTimes(1);
  });

  it('WI-1877: never registers the reconcile hook when the sidecar is OFF', async () => {
    h.sidecarOn = false;
    await bootSubstrateWithFallback();
    expect(onSidecarRespawnedMock).not.toHaveBeenCalled();
  });

  it('sidecar startup failure falls back to in-process boot', async () => {
    h.sidecarOn = true;
    spawnSidecar.mockRejectedValueOnce(new Error('spawn failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await bootSubstrateWithFallback();
      expect(r.usedSidecar).toBe(false);
      // Sidecar unavailable → defaults cleared so standalone boots stay in-process.
      expect(setBootDefaults).toHaveBeenLastCalledWith({ bootHarness: null, skipSendSideWiring: false, mergeCursorStoreFactory: null });
      expect(bootAll).toHaveBeenCalledWith(undefined);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sidecar spawn failed'),
        'spawn failed',
      );
      // WI-900 (M4): stopSubstrateSidecar is called unconditionally in the fallback
      // path (a no-op here since spawn never succeeded, but must still fire so the
      // partial-mid-boot-failure case below is covered by the SAME code path).
      expect(stopSidecar).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // WI-900 (M4): a PARTIAL mid-boot failure — the sidecar spawned + passed healthz
  // (so it may already hold corestore file locks for harnesses it booted before a
  // later harness's boot call threw) — must stop the sidecar BEFORE the in-process
  // fallback retries booting, or the retry can't acquire those locks and the
  // harness boots in NEITHER process.
  it('a PARTIAL mid-boot failure (sidecar alive past healthz) stops the sidecar BEFORE the in-process retry', async () => {
    h.sidecarOn = true;
    bootAll.mockImplementationOnce(async (opts?: { bootHarness?: unknown }) => {
      if (opts?.bootHarness) throw new Error('mid-boot failure — a later harness could not boot via sidecar');
      return { attempted: 0, booted: 0, alreadyBooted: 0, failed: 0, results: [] };
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callOrder: string[] = [];
    stopSidecar.mockImplementationOnce(async () => {
      callOrder.push('stopSidecar');
    });
    bootAll.mockImplementationOnce(async (opts?: { bootHarness?: unknown }) => {
      // sidecar-routed attempt (throws, exercised by the mockImplementationOnce above)
      if (opts?.bootHarness) throw new Error('mid-boot failure');
      callOrder.push('bootAll:in-process');
      return { attempted: 0, booted: 0, alreadyBooted: 0, failed: 0, results: [] };
    });
    try {
      const r = await bootSubstrateWithFallback();
      expect(r.usedSidecar).toBe(false);
      expect(spawnSidecar).toHaveBeenCalledOnce();
      expect(ipcCalls.map((c) => c.method)).toContain('sidecar:healthz');
      expect(stopSidecar).toHaveBeenCalledOnce();
      // stopSidecar must run BEFORE the in-process retry, not after.
      expect(callOrder).toEqual(['stopSidecar', 'bootAll:in-process']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('Bun routes native storage and networking through the existing Node sidecar even with the optional flag off', async () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: '1.4.4' } });
    h.sidecarOn = false;

    const result = await bootSubstrateWithFallback();

    expect(spawnSidecar).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ usedSidecar: true, booted: 1 });
    expect(ipcCalls.map(call => call.method)).toEqual(['sidecar:healthz', 'substrate:bootHarness']);
    expect(setBootDefaults).toHaveBeenLastCalledWith(expect.objectContaining({
      bootHarness: expect.any(Function), skipSendSideWiring: true,
    }));
  });

  it('Bun refuses startup after Node sidecar failure instead of opening unsupported native stores in process', async () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: '1.4.4' } });
    h.sidecarOn = true;
    const cause = new Error('retained Node sidecar unavailable');
    spawnSidecar.mockRejectedValueOnce(cause);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(bootSubstrateWithFallback()).rejects.toMatchObject({
        message: expect.stringContaining('Bun requires the retained Node substrate sidecar'), cause,
      });
      expect(stopSidecar).toHaveBeenCalledOnce();
      expect(bootAll).not.toHaveBeenCalled();
      expect(setBootDefaults).not.toHaveBeenCalledWith(expect.objectContaining({ bootHarness: null }));
    } finally { warning.mockRestore(); }
  });
});
