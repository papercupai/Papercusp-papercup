/**
 * Sidecar circuit breaker (WI-10000740).
 *
 * The thing under test is a COST BOUND, not a log line: with the sidecar down,
 * every seam used to pay the full startup timeout on EVERY call before falling
 * back (measured 2026-09-08: 265+ ten-second waits in one green-checkpoint
 * post-suite phase, holding the shared run-lock for ~35 min). The breaker must
 * (1) trip after N consecutive REAL fallbacks, (2) reject without touching the
 * spawn path while open, (3) not re-trip on its own short-circuit rejections,
 * (4) let exactly ONE probe through after the cooldown, and (5) close on a
 * successful probe / re-open on a failed one. Each of those is asserted against
 * the spawn spy's CALL COUNT — the observable that actually costs 10s — not
 * against the error message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSpy, callSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn<() => Promise<void>>(),
  callSpy: vi.fn<(method: string, params: unknown, opts?: unknown) => Promise<unknown>>(),
}));

vi.mock('./spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: spawnSpy }));
vi.mock('./spawner-ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spawner-ipc-client')>()),
  getSpawnerIpcClient: () => ({ call: callSpy }),
}));

import {
  SIDECAR_BREAKER_COOLDOWN_MS,
  SIDECAR_BREAKER_PROBE_STALE_MS,
  SIDECAR_BREAKER_TRIP_AFTER,
  SidecarCircuitOpenError,
  getSidecarBreakerState,
  getSidecarFallbackStats,
  noteSidecarFallback,
  resetSidecarFallbackStatsForTest,
  runGitStdinViaSpawnerSidecar,
  runGitViaSpawnerSidecar,
} from './git-via-sidecar';

const STARTUP_TIMEOUT = () => new Error('Spawner sidecar startup timeout');
const T0 = 1_700_000_000_000;

/** What every real caller does: try the sidecar, report the failure, fall back. */
async function callerAttempt(subsystem = 'test'): Promise<'sidecar' | 'fallback'> {
  try {
    await runGitViaSpawnerSidecar(['rev-parse', 'HEAD'], '/tmp', 5_000, {});
    return 'sidecar';
  } catch (e) {
    noteSidecarFallback(subsystem, e);
    return 'fallback';
  }
}

describe('spawner sidecar circuit breaker', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    resetSidecarFallbackStatsForTest();
    spawnSpy.mockReset();
    callSpy.mockReset();
    spawnSpy.mockRejectedValue(STARTUP_TIMEOUT());
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    resetSidecarFallbackStatsForTest();
    vi.useRealTimers();
  });

  it('stays CLOSED below the trip threshold (control: the naive path keeps spawning)', async () => {
    for (let i = 0; i < SIDECAR_BREAKER_TRIP_AFTER - 1; i++) {
      expect(await callerAttempt()).toBe('fallback');
    }
    expect(getSidecarBreakerState().state).toBe('closed');
    expect(spawnSpy).toHaveBeenCalledTimes(SIDECAR_BREAKER_TRIP_AFTER - 1);
    // One more real failure trips it.
    expect(await callerAttempt()).toBe('fallback');
    expect(getSidecarBreakerState()).toMatchObject({ state: 'open', trips: 1, consecutiveFailures: SIDECAR_BREAKER_TRIP_AFTER });
    expect(spawnSpy).toHaveBeenCalledTimes(SIDECAR_BREAKER_TRIP_AFTER);
  });

  it('while OPEN, rejects with SidecarCircuitOpenError WITHOUT touching the spawn path', async () => {
    for (let i = 0; i < SIDECAR_BREAKER_TRIP_AFTER; i++) await callerAttempt();
    const spawnsAtTrip = spawnSpy.mock.calls.length;

    await expect(runGitViaSpawnerSidecar(['status'], '/tmp', 5_000, {})).rejects.toBeInstanceOf(
      SidecarCircuitOpenError,
    );
    await expect(runGitStdinViaSpawnerSidecar(['cat-file', '--batch'], '/tmp', 'abc\n', 5_000, {})).rejects.toBeInstanceOf(
      SidecarCircuitOpenError,
    );
    // The whole point: no 10s startup wait was paid for either seam.
    expect(spawnSpy).toHaveBeenCalledTimes(spawnsAtTrip);
    expect(getSidecarBreakerState()).toMatchObject({ state: 'open', shortCircuited: 2 });
    expect(getSidecarBreakerState().retryAfterMs).toBeGreaterThan(0);
    // A fail-closed reader rejects; the breaker cannot claim a local spawn happened.
    expect(new SidecarCircuitOpenError(1000).message).not.toContain('local spawn is being used');
  });

  it('its own short-circuit rejections are COUNTED as fallbacks but never re-trip or extend the open window', async () => {
    for (let i = 0; i < SIDECAR_BREAKER_TRIP_AFTER; i++) await callerAttempt();
    const { openedAtMs, consecutiveFailures } = getSidecarBreakerState();
    vi.setSystemTime(T0 + 30_000);

    // A caller doing what callers do with the short-circuit rejection.
    expect(await callerAttempt('pot-git')).toBe('fallback');

    const after = getSidecarBreakerState();
    expect(after.openedAtMs).toBe(openedAtMs); // not re-stamped
    expect(after.consecutiveFailures).toBe(consecutiveFailures); // not fed
    expect(after.trips).toBe(1);
    // ...but the fallback accounting still sees it: the call DID pay a local fork.
    expect(getSidecarFallbackStats().bySubsystem['pot-git']?.count).toBe(1);
    expect(getSidecarFallbackStats().total).toBe(SIDECAR_BREAKER_TRIP_AFTER + 1);
  });

  it('after the cooldown lets exactly ONE probe through, short-circuits concurrent callers, and CLOSES on probe success', async () => {
    for (let i = 0; i < SIDECAR_BREAKER_TRIP_AFTER; i++) await callerAttempt();
    const spawnsAtTrip = spawnSpy.mock.calls.length;
    vi.setSystemTime(T0 + SIDECAR_BREAKER_COOLDOWN_MS);
    expect(getSidecarBreakerState().state).toBe('half-open');

    // The probe: spawn hangs until we release it, so a second caller arrives mid-probe.
    let releaseProbe!: () => void;
    spawnSpy.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseProbe = resolve)));
    callSpy.mockResolvedValueOnce({ code: 0, stdout: 'abc\n', stderr: '' });

    const probe = runGitViaSpawnerSidecar(['rev-parse', 'HEAD'], '/tmp', 5_000, {});
    await Promise.resolve(); // let the probe reach spawnSpawnerSidecar()
    expect(spawnSpy).toHaveBeenCalledTimes(spawnsAtTrip + 1);

    await expect(runGitViaSpawnerSidecar(['status'], '/tmp', 5_000, {})).rejects.toBeInstanceOf(
      SidecarCircuitOpenError,
    );
    expect(spawnSpy).toHaveBeenCalledTimes(spawnsAtTrip + 1); // the concurrent caller did not spawn

    releaseProbe();
    await expect(probe).resolves.toMatchObject({ code: 0 });
    expect(getSidecarBreakerState()).toMatchObject({ state: 'closed', consecutiveFailures: 0, openedAtMs: null });

    // Closed again: calls flow to the sidecar normally.
    spawnSpy.mockResolvedValueOnce(undefined);
    callSpy.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    expect(await callerAttempt()).toBe('sidecar');
    expect(spawnSpy).toHaveBeenCalledTimes(spawnsAtTrip + 2);
  });

  it('a FAILED probe re-opens the breaker for another cooldown without counting a new trip', async () => {
    for (let i = 0; i < SIDECAR_BREAKER_TRIP_AFTER; i++) await callerAttempt();
    vi.setSystemTime(T0 + SIDECAR_BREAKER_COOLDOWN_MS + 5);

    expect(await callerAttempt()).toBe('fallback'); // the probe, rejected by the (still dead) sidecar
    const s = getSidecarBreakerState();
    expect(s.state).toBe('open');
    expect(s.openedAtMs).toBe(T0 + SIDECAR_BREAKER_COOLDOWN_MS + 5);
    expect(s.trips).toBe(1);

    // And the next call inside the NEW window is short-circuited again.
    const spawns = spawnSpy.mock.calls.length;
    await expect(runGitViaSpawnerSidecar(['status'], '/tmp', 5_000, {})).rejects.toBeInstanceOf(
      SidecarCircuitOpenError,
    );
    expect(spawnSpy).toHaveBeenCalledTimes(spawns);
  });

  it('a probe whose caller never reports back goes stale and does not pin the breaker half-open forever', async () => {
    for (let i = 0; i < SIDECAR_BREAKER_TRIP_AFTER; i++) await callerAttempt();
    vi.setSystemTime(T0 + SIDECAR_BREAKER_COOLDOWN_MS);
    // A probe that rejects, whose caller swallows the error (no noteSidecarFallback).
    await runGitViaSpawnerSidecar(['status'], '/tmp', 5_000, {}).catch(() => {});
    const spawns = spawnSpy.mock.calls.length;

    // Before the stale window: still treated as in flight.
    vi.setSystemTime(T0 + SIDECAR_BREAKER_COOLDOWN_MS + 1_000);
    await expect(runGitViaSpawnerSidecar(['status'], '/tmp', 5_000, {})).rejects.toBeInstanceOf(
      SidecarCircuitOpenError,
    );
    expect(spawnSpy).toHaveBeenCalledTimes(spawns);

    // Past it: a fresh probe is allowed.
    vi.setSystemTime(T0 + SIDECAR_BREAKER_COOLDOWN_MS + SIDECAR_BREAKER_PROBE_STALE_MS + 1);
    await runGitViaSpawnerSidecar(['status'], '/tmp', 5_000, {}).catch(() => {});
    expect(spawnSpy).toHaveBeenCalledTimes(spawns + 1);
  });

  it('a successful sidecar call resets the consecutive-failure count (two blips never accumulate into a trip)', async () => {
    await callerAttempt();
    await callerAttempt();
    spawnSpy.mockResolvedValueOnce(undefined);
    callSpy.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    expect(await callerAttempt()).toBe('sidecar');
    expect(getSidecarBreakerState().consecutiveFailures).toBe(0);
    await callerAttempt();
    await callerAttempt();
    expect(getSidecarBreakerState().state).toBe('closed');
  });
});
