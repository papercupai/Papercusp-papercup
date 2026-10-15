/**
 * jev-memory-timeouts-to-zero-2026-10-01 D-001: one unit-start probe per unit per
 * UNIT_START_PROBE_TTL_MS, shared by concurrent callers.
 *
 * Unmemoized, one gitPipelinePosition({ path }) forked systemctl + ps for each of
 * ~5 unit probes, and deploymentPositionForEvidence runs up to 12 paths in
 * parallel, so a single work_items:get could freeze a multi-GB operator's event
 * loop for seconds. These tests pin the single-flight, the TTL expiry (never
 * served stale past it), and negative caching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOY_IN_FLIGHT_TTL_MS,
  UNIT_START_IDENTITY_MAX_MS,
  UNIT_START_PROBE_TTL_MS,
  probeUnitStartShared,
  readDeployInFlightShared,
  resetDeployInFlightCacheForTest,
  resetUnitStartProbeCacheForTest,
} from './git-pipeline-position';
import type { DeployInFlight } from './release-deploy-launch';

type Probe = { pid: number | null; startedAtMs: number | null } | null;

describe('probeUnitStartShared', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T22:00:00Z'));
    resetUnitStartProbeCacheForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetUnitStartProbeCacheForTest();
  });

  it('runs ONE probe for many concurrent callers of the same unit', async () => {
    let release: (v: Probe) => void = () => undefined;
    const uncached = vi.fn(() => new Promise<Probe>((resolve) => { release = resolve; }));
    const pending = Array.from({ length: 10 }, () => probeUnitStartShared('papercusp-dev-api.service', uncached));
    release({ pid: 4242, startedAtMs: 1_000 });
    const results = await Promise.all(pending);
    expect(uncached).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ pid: 4242, startedAtMs: 1_000 });
  });

  it('probes distinct units independently', async () => {
    const uncached = vi.fn(async (unit: string): Promise<Probe> => ({ pid: unit.length, startedAtMs: 1 }));
    await probeUnitStartShared('a.service', uncached);
    await probeUnitStartShared('bb.service', uncached);
    expect(uncached.mock.calls.map((c) => c[0])).toEqual(['a.service', 'bb.service']);
  });

  it('re-probes once the TTL has passed when the cached pid is gone, never serving the old value', async () => {
    let n = 0;
    const uncached = vi.fn(async (): Promise<Probe> => ({ pid: ++n, startedAtMs: n }));
    const pidGone = vi.fn(async () => null);
    await expect(probeUnitStartShared('u.service', uncached, pidGone)).resolves.toEqual({ pid: 1, startedAtMs: 1 });
    vi.setSystemTime(Date.now() + UNIT_START_PROBE_TTL_MS - 1);
    await expect(probeUnitStartShared('u.service', uncached, pidGone)).resolves.toEqual({ pid: 1, startedAtMs: 1 });
    vi.setSystemTime(Date.now() + 2);
    await expect(probeUnitStartShared('u.service', uncached, pidGone)).resolves.toEqual({ pid: 2, startedAtMs: 2 });
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  it('caches an unreadable systemd (null) too, so it is not re-forked per path', async () => {
    const uncached = vi.fn(async (): Promise<Probe> => null);
    await probeUnitStartShared('gone.service', uncached);
    await probeUnitStartShared('gone.service', uncached);
    expect(uncached).toHaveBeenCalledTimes(1);
  });
});

/**
 * WI-10008286: past the 2 s TTL an unchanged unit must not re-fork. The bg-host
 * loop-saturation profile of 2026-10-11T00:10Z (p95 605 ms) spent 19.8% of its samples
 * in probeUnitStartUncached because every 2 s re-probe forked systemctl from a
 * multi-GB process. These tests pin that an unchanged MainPID is re-served from a
 * fork-free /proc identity check, and that every way the identity can change still
 * reaches the real probe.
 */
describe('probeUnitStartShared fork-free identity revalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T00:30:00Z'));
    resetUnitStartProbeCacheForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetUnitStartProbeCacheForTest();
  });

  const START = 1_791_000_000_123.456;

  it('probes an unchanged unit ONCE across many TTL windows while /proc identity matches', async () => {
    const uncached = vi.fn(async (): Promise<Probe> => ({ pid: 4242, startedAtMs: START }));
    const readStart = vi.fn(async (pid: number) => (pid === 4242 ? START : null));
    for (let i = 0; i < 20; i++) {
      await expect(probeUnitStartShared('papercusp-bg-host.service', uncached, readStart)).resolves.toEqual({
        pid: 4242,
        startedAtMs: START,
      });
      vi.setSystemTime(Date.now() + UNIT_START_PROBE_TTL_MS + 500);
    }
    expect(uncached).toHaveBeenCalledTimes(1);
    expect(readStart).toHaveBeenCalled();
    expect(readStart.mock.calls.every(([pid]) => pid === 4242)).toBe(true);
  });

  it('falls through to the real probe when the pid now has a different start (recycled pid / restart)', async () => {
    let probes = 0;
    const uncached = vi.fn(async (): Promise<Probe> => {
      probes += 1;
      return probes === 1 ? { pid: 4242, startedAtMs: START } : { pid: 4242, startedAtMs: START + 90_000 };
    });
    let liveStart = START;
    const readStart = vi.fn(async () => liveStart);
    await probeUnitStartShared('u.service', uncached, readStart);
    liveStart = START + 90_000;
    vi.setSystemTime(Date.now() + UNIT_START_PROBE_TTL_MS + 1);
    await expect(probeUnitStartShared('u.service', uncached, readStart)).resolves.toEqual({
      pid: 4242,
      startedAtMs: START + 90_000,
    });
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  it('falls through to the real probe when the cached pid has exited', async () => {
    let probes = 0;
    const uncached = vi.fn(async (): Promise<Probe> => ({ pid: ++probes === 1 ? 4242 : 5151, startedAtMs: START + probes }));
    let alive = true;
    const readStart = vi.fn(async (pid: number) => (alive && pid === 4242 ? START + 1 : null));
    await probeUnitStartShared('u.service', uncached, readStart);
    alive = false;
    vi.setSystemTime(Date.now() + UNIT_START_PROBE_TTL_MS + 1);
    await expect(probeUnitStartShared('u.service', uncached, readStart)).resolves.toEqual({ pid: 5151, startedAtMs: START + 2 });
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  it('re-probes at the identity backstop even while identity still matches', async () => {
    const uncached = vi.fn(async (): Promise<Probe> => ({ pid: 4242, startedAtMs: START }));
    const readStart = vi.fn(async () => START);
    await probeUnitStartShared('u.service', uncached, readStart);
    vi.setSystemTime(Date.now() + UNIT_START_IDENTITY_MAX_MS - 1);
    await probeUnitStartShared('u.service', uncached, readStart);
    expect(uncached).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2);
    await probeUnitStartShared('u.service', uncached, readStart);
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  it('never identity-serves a value it cannot check: null, pid 0 and unknown start keep the 2 s TTL', async () => {
    const readStart = vi.fn(async () => START);
    for (const value of [null, { pid: 0, startedAtMs: START }, { pid: null, startedAtMs: START }, { pid: 4242, startedAtMs: null }] as Probe[]) {
      resetUnitStartProbeCacheForTest();
      const uncached = vi.fn(async (): Promise<Probe> => value);
      await probeUnitStartShared('u.service', uncached, readStart);
      vi.setSystemTime(Date.now() + UNIT_START_PROBE_TTL_MS + 1);
      await probeUnitStartShared('u.service', uncached, readStart);
      expect(uncached).toHaveBeenCalledTimes(2);
    }
    expect(readStart).not.toHaveBeenCalled();
  });
});

/**
 * WI-10008286 (same class): readDeployInFlight forks `systemctl show` per call, and
 * one evidence read fans gitPipelinePosition out over up to 12 paths. 8.1% of the
 * 00:10Z bg-host stall profile. Pin one shared read per window, re-read after it.
 */
describe('readDeployInFlightShared', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T00:30:00Z'));
    resetDeployInFlightCacheForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetDeployInFlightCacheForTest();
  });

  const reading = (active: boolean): DeployInFlight =>
    ({ active, unit: 'papercusp-deploy', activeState: active ? 'active' : 'inactive', source: 'systemd' }) as DeployInFlight;

  it('shares ONE systemd read across 12 concurrent callers', async () => {
    const uncached = vi.fn(async () => reading(false));
    const results = await Promise.all(Array.from({ length: 12 }, () => readDeployInFlightShared(uncached)));
    expect(uncached).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.active === false)).toBe(true);
  });

  it('re-reads once the window has passed, so a started deploy is seen', async () => {
    let active = false;
    const uncached = vi.fn(async () => reading(active));
    await expect(readDeployInFlightShared(uncached)).resolves.toMatchObject({ active: false });
    active = true;
    vi.setSystemTime(Date.now() + DEPLOY_IN_FLIGHT_TTL_MS - 1);
    await expect(readDeployInFlightShared(uncached)).resolves.toMatchObject({ active: false });
    vi.setSystemTime(Date.now() + 2);
    await expect(readDeployInFlightShared(uncached)).resolves.toMatchObject({ active: true });
    expect(uncached).toHaveBeenCalledTimes(2);
  });
});
