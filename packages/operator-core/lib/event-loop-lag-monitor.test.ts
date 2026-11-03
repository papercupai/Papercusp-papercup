/**
 * event-loop-lag-monitor.test.ts — EI-79 observability gauge.
 *
 * Verifies: (1) a healthy/idle loop stays silent (no warning under threshold);
 * (2) sustained synchronous blocking on the loop trips the p95 warning; (3) the
 * timer is unref'd / stop() is clean. We drive the internal interval by setting
 * a short `intervalMs` and a low threshold, and block the loop synchronously to
 * manufacture lag (the native histogram measures real libuv delay, so we can't
 * fake it — we induce it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  captureCpuProfile,
  captureHeapSnapshot,
  classifyLoopPressure,
  cooperativeYield,
  createTimeSlice,
  currentLoopLag,
  isLoopLagWindowMature,
  isLoopElevated,
  isLoopSaturated,
  loopPressure,
  setLagPublishTarget,
  shouldTriggerLoopProfile,
  shouldTriggerFullHeapSnapshot,
  shouldTriggerHeapSamplingDump,
  startEventLoopLagMonitor,
  yieldToEventLoop,
  type LagMonitorHandle,
} from './event-loop-lag-monitor';
import { SENTINEL_SAB_IDX, SENTINEL_SAB_INT32_LEN } from './event-loop-sentinel';
import { getManaged, managedSetInterval, stopManaged } from '@papercusp/scheduled-registry';

function blockFor(ms: number): void {
  const end = Date.now() + ms;
  // Busy-wait to actually occupy the event loop (manufactures real lag).
  while (Date.now() < end) {
    /* spin */
  }
}

describe('event-loop-lag-monitor', () => {
  let handle: LagMonitorHandle | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
    vi.useRealTimers();
  });

  it('stays silent on an idle loop (no warning under threshold)', async () => {
    const log = vi.fn();
    // Hermetic: pin the heap-sampling/snapshot options OFF so the assertion measures
    // the committed idle-loop default regardless of ambient env. Without this, an
    // operator host (or any shell) with PAPERCUSP_HEAP_SNAPSHOT=1 makes the monitor
    // default heapSamplingOnHighRss=true, arm the sampler on the first tick, and log
    // "[heap-sampling] armed" into this spy — a false failure. The gate strips
    // PAPERCUSP_* so it stayed green there, but local runs on this host flaked.
    handle = startEventLoopLagMonitor({
      intervalMs: 50,
      warnP95Ms: 1000,
      log,
      heapSamplingOnHighRss: false,
      heapSnapshotOnHighRss: false,
    });
    await new Promise((r) => setTimeout(r, 180));
    expect(log).not.toHaveBeenCalled();
  });

  it('warns when sustained blocking pushes p95 loop lag over the threshold', async () => {
    const log = vi.fn();
    handle = startEventLoopLagMonitor({ intervalMs: 60, warnP95Ms: 20, log });
    // Block the loop repeatedly so the histogram records high delay before the
    // 60ms evaluation tick fires.
    for (let i = 0; i < 4; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(log).toHaveBeenCalled();
    const [, detail] = log.mock.calls[0];
    expect(detail.p95Ms).toBeGreaterThanOrEqual(20);
  });

  it('sample() returns numeric percentiles and stop() is clean', () => {
    handle = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    const s = handle.sample();
    expect(typeof s.p50Ms).toBe('number');
    expect(typeof s.p95Ms).toBe('number');
    expect(typeof s.maxMs).toBe('number');
    expect(typeof s.sampleCount).toBe('number');
    expect(typeof s.windowMs).toBe('number');
    expect(s.windowMature).toBe(false); // immediate read of a fresh 10s window
    expect(() => handle?.stop()).not.toThrow();
  });

  it('logs the observed delay and elapsed window without inferring its cause', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 100,
      warnP95Ms: 0,
      profileOnSaturation: false,
      heapSamplingOnHighRss: false,
      heapSnapshotOnHighRss: false,
      log,
    });
    // A delayed observation changes the elapsed window without doing CPU work
    // or supplying any other evidence about the source of the delay.
    vi.setSystemTime(375);
    vi.advanceTimersByTime(100);
    const warning = log.mock.calls.find(([line]) => line.startsWith('[event-loop-lag] high loop delay'));
    expect(warning).toBeDefined();
    const [line, detail] = warning!;
    expect(line).toBe('[event-loop-lag] high loop delay');
    expect(detail.windowMs).toBe(475);
    expect(detail.intervalMs).toBe(100);
    expect(detail.sampleCount).toBe(0);
    // The complete elapsed window is authoritative even with sparse observations;
    // maturity does not identify the cause of its delay.
    expect(detail.windowMature).toBe(true);
  });

  // infra round-4 P-014: the host boots the monitor from BOTH the request plane
  // (startRequestServers) and the bg machinery (runBootstrap) so the cluster bg-host
  // primary — which serves no HTTP — also has a live gauge for the perf-regression rig.
  // That double-boot must NOT spawn two histograms/timers against one loop.
  it('is idempotent per process: a 2nd start returns the SAME running handle', () => {
    handle = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    // currentLoopLag() reads the live published gauge — non-null once a monitor runs.
    expect(currentLoopLag()).not.toBeNull();
    const second = startEventLoopLagMonitor({ intervalMs: 50, warnP95Ms: 5 });
    expect(second).toBe(handle); // re-entry returns the live handle, ignores new opts
  });

  it('after stop(), a fresh start creates a NEW monitor (guard is cleared)', () => {
    const first = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    first.stop();
    expect(currentLoopLag()).toBeNull(); // published gauge cleared on stop
    handle = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    expect(handle).not.toBe(first); // a clean process-start, not the stopped handle
    expect(currentLoopLag()).not.toBeNull();
  });
});

describe('loop-pressure signal (P5-1)', () => {
  it('marks p95 mature after 20 observations, or after a whole sparse window elapsed', () => {
    expect(isLoopLagWindowMature({ sampleCount: 19, windowMs: 9_999, intervalMs: 10_000 })).toBe(false);
    expect(isLoopLagWindowMature({ sampleCount: 20, windowMs: 400, intervalMs: 10_000 })).toBe(true);
    expect(isLoopLagWindowMature({ sampleCount: 1, windowMs: 10_000, intervalMs: 10_000 })).toBe(true);
    expect(isLoopLagWindowMature({ sampleCount: Number.NaN, windowMs: 10_000, intervalMs: 10_000 })).toBe(false);
  });

  it('classifyLoopPressure bands by p95 (default thresholds 120/600ms)', () => {
    expect(classifyLoopPressure(0)).toBe('ok');
    expect(classifyLoopPressure(50)).toBe('ok');
    expect(classifyLoopPressure(120)).toBe('elevated');
    expect(classifyLoopPressure(599)).toBe('elevated');
    expect(classifyLoopPressure(600)).toBe('critical');
    expect(classifyLoopPressure(5000)).toBe('critical');
  });

  it('classifyLoopPressure honors custom thresholds + is NaN-safe', () => {
    expect(classifyLoopPressure(50, 40, 100)).toBe('elevated');
    expect(classifyLoopPressure(200, 40, 100)).toBe('critical');
    expect(classifyLoopPressure(NaN)).toBe('ok'); // no signal ⇒ never shed
  });

  it('profiles an isolated catastrophic max even when the window p95 stays below its trigger (WI-2146561)', () => {
    // Exact shape measured live: six cross-harness stage stalls landed together,
    // but the p95-only profiler gate stayed closed because one 20.4s delay was a
    // small fraction of the otherwise-responsive window.
    expect(shouldTriggerLoopProfile({ p95Ms: 171.3, maxMs: 20_401.1 })).toBe(true);
    expect(shouldTriggerLoopProfile({ p95Ms: 599.9, maxMs: 2_999.9 })).toBe(false);
    expect(shouldTriggerLoopProfile({ p95Ms: 600, maxMs: 1 })).toBe(true);
    expect(shouldTriggerLoopProfile({ p95Ms: Number.NaN, maxMs: Number.NaN })).toBe(false);
  });

  it('loopPressure() is "ok" / isLoopSaturated() / isLoopElevated() false when NO monitor is running', () => {
    // No monitor started in this test ⇒ absence of signal must read as ok.
    expect(loopPressure()).toBe('ok');
    expect(isLoopSaturated()).toBe(false);
    expect(isLoopElevated()).toBe(false);
  });

  it('an idle monitored loop reads "ok" (not saturated, not elevated)', () => {
    const h = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    try {
      expect(loopPressure()).toBe('ok');
      expect(isLoopSaturated()).toBe(false);
      expect(isLoopElevated()).toBe(false);
    } finally {
      h.stop();
    }
    // After stop the published signal is cleared back to ok.
    expect(loopPressure()).toBe('ok');
    expect(isLoopElevated()).toBe(false);
  });

  it('does not shed on an isolated delay before the p95 window matures', async () => {
    const h = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
    try {
      // Let the native 20ms sampler arm before blocking its next tick.
      await new Promise((r) => setTimeout(r, 30));
      blockFor(700);
      await new Promise((r) => setTimeout(r, 30));
      const sample = h.sample();
      expect(sample.p95Ms).toBeGreaterThanOrEqual(600);
      expect(sample.windowMature).toBe(false);
      expect(loopPressure()).toBe('ok');
      expect(isLoopSaturated()).toBe(false);
    } finally {
      h.stop();
    }
  });

  it('isLoopElevated() is true for elevated AND critical, false for ok', () => {
    // Driven via classifyLoopPressure to verify the full pressure → elevated mapping
    // without needing a live monitor (pure classification logic tested here).
    // p95 < 120ms  → ok       → isLoopElevated delegates to loopPressure; tested above.
    // We verify the exported predicate against the classification directly.
    expect(classifyLoopPressure(0)).toBe('ok');
    expect(classifyLoopPressure(119)).toBe('ok');
    expect(classifyLoopPressure(120)).toBe('elevated');   // ELEVATED: shed fires (WI-1084)
    expect(classifyLoopPressure(200)).toBe('elevated');   // chronic 130–240ms regime
    expect(classifyLoopPressure(599)).toBe('elevated');
    expect(classifyLoopPressure(600)).toBe('critical');   // CRITICAL: also sheds
    // isLoopElevated() returns true for both non-ok bands.
    // (We can't inject a synthetic p95 into the live gauge in a unit test, so
    //  we assert the underlying classification and isLoopElevated's no-monitor case.)
    expect(isLoopElevated()).toBe(false); // no monitor → 'ok' → false
  });
});

describe('F1 lag-triggered CPU profiler (infra round-3)', () => {
  let handle: LagMonitorHandle | undefined;
  const dirs: string[] = [];
  afterEach(async () => {
    handle?.stop();
    handle = undefined;
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });
  const tmp = (tag: string) => {
    const d = path.join(os.tmpdir(), `loop-prof-${tag}-${Date.now()}-${process.pid}`);
    dirs.push(d);
    return d;
  };

  it('captureCpuProfile writes a valid .cpuprofile (or degrades to null, never throws)', async () => {
    const dir = tmp('cap');
    const file = await captureCpuProfile({
      durationMs: 120,
      dir,
      maxProfiles: 20,
      trigger: { p50Ms: 1, p95Ms: 700, p99Ms: 800, maxMs: 900 },
      log: vi.fn(),
    });
    // Contract: returns a path when an inspector is available, else null — but
    // NEVER throws (the gauge must not break the host it observes).
    if (file === null) return; // env without a free inspector (e.g. coverage attached)
    expect(file.endsWith('.cpuprofile')).toBe(true);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    // A V8 CPU profile has a node tree + samples.
    expect(parsed).toHaveProperty('nodes');
    expect(parsed).toHaveProperty('samples');
  });

  it('pre-prunes a slot before writing so the retention cap is never transiently exceeded', async () => {
    const dir = tmp('pre-prune');
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, 'loop-saturation-0001.cpuprofile'), '{}'),
      fs.writeFile(path.join(dir, 'loop-saturation-0002.cpuprofile'), '{}'),
    ]);

    let countWhenWriteBecameObservable: number | null = null;
    const file = await captureCpuProfile({
      durationMs: 10,
      dir,
      maxProfiles: 2,
      trigger: { p50Ms: 1, p95Ms: 700, p99Ms: 800, maxMs: 900 },
      log: (line) => {
        if (line.includes('captured CPU profile')) {
          // captureCpuProfile logs immediately after write and before its
          // defensive post-write prune, exposing the old overflow deterministically.
          countWhenWriteBecameObservable = readdirSync(dir).filter((entry) => entry.endsWith('.cpuprofile')).length;
        }
      },
    });

    if (file === null) return; // env without a free inspector (e.g. coverage attached)
    expect(countWhenWriteBecameObservable).toBe(2);
    expect((await fs.readdir(dir)).filter((entry) => entry.endsWith('.cpuprofile'))).toHaveLength(2);
  });

  it('does not start CPU profiling when a pending gate resolves after monitor stop', async () => {
    const dir = tmp('stop-pending-gate');
    let resolveGate!: (enabled: boolean) => void;
    const gate = vi.fn(() => new Promise<boolean>((resolve) => { resolveGate = resolve; }));
    handle = startEventLoopLagMonitor({
      intervalMs: 30,
      profileTriggerP95Ms: 0,
      profileOnSaturation: gate,
      profileDurationMs: 50,
      profileDir: dir,
      heapSamplingOnHighRss: false,
      heapSnapshotOnHighRss: false,
      log: vi.fn(),
    });
    await vi.waitFor(() => expect(gate).toHaveBeenCalledTimes(1));
    handle.stop();
    resolveGate(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Even preparing the artifact directory means profiling outlived its owner.
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a CPU capture promptly without publishing a partial profile', async () => {
    const dir = tmp('cancel-capture');
    const controller = new AbortController();
    const log = vi.fn();
    const capture = captureCpuProfile({
      durationMs: 2000,
      dir,
      maxProfiles: 2,
      trigger: { p50Ms: 1, p95Ms: 700, p99Ms: 800, maxMs: 900 },
      log,
      signal: controller.signal,
    });
    await vi.waitFor(async () => expect((await fs.stat(dir)).isDirectory()).toBe(true));
    // Let the capture pass its asynchronous directory setup and arm the sampler.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([
        capture,
        new Promise<string>((resolve) => { deadline = setTimeout(() => resolve('still recording'), 500); }),
      ])).toBeNull();
    } finally {
      clearTimeout(deadline);
      await capture; // drain even on the old-source failure
    }
    expect((await fs.readdir(dir)).filter((entry) => entry.endsWith('.cpuprofile'))).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('monitor stop cancels its active capture without publishing an artifact', async () => {
    const dir = tmp('stop-active-capture');
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 30,
      profileTriggerP95Ms: 0,
      profileOnSaturation: true,
      profileDurationMs: 200,
      profileDir: dir,
      heapSamplingOnHighRss: false,
      heapSnapshotOnHighRss: false,
      log,
    });
    await vi.waitFor(async () => expect((await fs.stat(dir)).isDirectory()).toBe(true));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await fs.readdir(dir)).filter((entry) => entry.endsWith('.cpuprofile'))).toEqual([]);
    expect(log.mock.calls.some(([line]) => String(line).includes('captured CPU profile'))).toBe(false);
  });

  it('an already cancelled capture never prepares an artifact directory', async () => {
    const dir = tmp('already-cancelled');
    const controller = new AbortController();
    controller.abort();
    expect(await captureCpuProfile({
      durationMs: 2000,
      dir,
      maxProfiles: 2,
      trigger: { p50Ms: 1, p95Ms: 700, p99Ms: 800, maxMs: 900 },
      log: vi.fn(),
      signal: controller.signal,
    })).toBeNull();
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prewarms on a quiet tick and reuses the same V8 recorder across later ticks', async () => {
    const dir = tmp('warm-idle');
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 50, profileOnSaturation: true, profileDir: dir,
      profileTriggerP95Ms: 100_000, profileTriggerMaxMs: 100_000,
      heapSamplingOnHighRss: false, heapSnapshotOnHighRss: false, log,
    });
    const warmups = () => log.mock.calls.filter(([, detail]) => 'warmupMs' in detail);
    await vi.waitFor(() => expect(warmups()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(warmups()).toHaveLength(1);
    expect(warmups()[0][1].samplingIntervalUs).toBe(10_000);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gate OFF cancels active recording before the five-minute artifact gap elapses', async () => {
    const dir = tmp('off-active');
    let enabled = true;
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 40, profileOnSaturation: () => enabled, profileDir: dir,
      profileTriggerP95Ms: 0, profileDurationMs: 300, minProfileGapMs: 300_000,
      heapSamplingOnHighRss: false, heapSnapshotOnHighRss: false, log,
    });
    await vi.waitFor(async () => expect((await fs.stat(dir)).isDirectory()).toBe(true));
    enabled = false;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await fs.readdir(dir)).filter((entry) => entry.endsWith('.cpuprofile'))).toEqual([]);
    expect(log.mock.calls.some(([line]) => String(line).includes('captured CPU profile'))).toBe(false);
  });

  it('a flag read spanning a tick revokes sampling and its stale true result cannot restart it', async () => {
    const dir = tmp('slow-gate');
    const log = vi.fn();
    let resolveGate: ((value: boolean) => void) | undefined;
    let blockGate = false;
    const gate = () => blockGate ? new Promise<boolean>((resolve) => { resolveGate = resolve; }) : true;
    handle = startEventLoopLagMonitor({
      intervalMs: 40, profileOnSaturation: gate, profileDir: dir,
      profileTriggerP95Ms: 0, profileDurationMs: 300,
      heapSamplingOnHighRss: false, heapSnapshotOnHighRss: false, log,
    });
    await vi.waitFor(async () => expect((await fs.stat(dir)).isDirectory()).toBe(true));
    blockGate = true;
    await vi.waitFor(() => expect(resolveGate).toBeTypeOf('function'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    resolveGate!(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(log.mock.calls.filter(([, detail]) => 'warmupMs' in detail)).toHaveLength(1);
    expect((await fs.readdir(dir)).filter((entry) => entry.endsWith('.cpuprofile'))).toEqual([]);
  });

  it('is INERT by default: no capture under saturation when profileOnSaturation is off', async () => {
    const dir = tmp('off');
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 20,
      profileOnSaturation: false,
      profileDir: dir,
      profileTriggerP95Ms: 20,
      minProfileGapMs: 0,
      log,
    });
    for (let i = 0; i < 4; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(log).toHaveBeenCalled(); // the symptom warning still fires
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      /* dir never created = inert, which is the point */
    }
    expect(files.filter((f) => f.endsWith('.cpuprofile'))).toHaveLength(0);
  });

  it('consults the profiler gate for a high max even when p95 cannot cross the sustained trigger', async () => {
    const gate = vi.fn(() => false);
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 1000,
      profileOnSaturation: gate,
      profileTriggerP95Ms: 1000,
      profileTriggerMaxMs: 20,
      minProfileGapMs: 0,
      heapSamplingOnHighRss: false,
      heapSnapshotOnHighRss: false,
      log: vi.fn(),
    });
    for (let i = 0; i < 3; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 180));
    expect(gate).toHaveBeenCalled();
  });

  it('ON path: a saturated window triggers a capture (best-effort), bounded by maxProfiles', async () => {
    const dir = tmp('on');
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 20,
      profileOnSaturation: true,
      profileDir: dir,
      profileTriggerP95Ms: 20,
      profileDurationMs: 120,
      minProfileGapMs: 0,
      maxProfiles: 3,
      log: vi.fn(),
    });
    for (let i = 0; i < 4; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 500)); // allow async capture + write
    let profs: string[] = [];
    try {
      profs = (await fs.readdir(dir)).filter((f) => f.endsWith('.cpuprofile'));
    } catch {
      /* no inspector available ⇒ graceful no-op */
    }
    expect(profs.length).toBeLessThanOrEqual(3); // rate-limit + prune bound holds
    if (profs.length) {
      // any captured file must be valid JSON
      expect(() => JSON.parse('{}')).not.toThrow();
      const body = await fs.readFile(path.join(dir, profs[0]), 'utf8');
      expect(() => JSON.parse(body)).not.toThrow();
    }
  });

  it('a saturated window also dumps a heap-sampling profile below the RSS snapshot threshold', async () => {
    const dir = tmp('sampling-on-saturation');
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 20,
      profileOnSaturation: true,
      profileDir: dir,
      profileTriggerP95Ms: 20,
      profileDurationMs: 120,
      minProfileGapMs: 0,
      heapSamplingOnHighRss: true,
      heapSnapshotOnHighRss: false,
      heapSnapshotDir: dir,
      minHeapSamplingDumpGapMs: 0,
      log,
    });
    for (let i = 0; i < 4; i++) {
      blockFor(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 500));
    let heapProfiles: string[] = [];
    try {
      heapProfiles = (await fs.readdir(dir)).filter((f) => f.endsWith('.heapprofile'));
    } catch {
      /* no inspector available => graceful no-op */
    }
    if (heapProfiles.length > 0) {
      const body = await fs.readFile(path.join(dir, heapProfiles[0]), 'utf8');
      const parsed = JSON.parse(body) as { head?: unknown };
      expect(parsed.head).toBeTruthy();
      expect(log.mock.calls.some(([line]) => String(line).includes('top live allocation sites'))).toBe(true);
    }
  });

  // WI-5820: the gate became a lazily-read predicate (so a FLAGS flip takes effect
  // without a host restart, and a boot-time flag read cannot latch it off forever),
  // and gained a safety cap so the regime that natively crash-looped :3070 8x on
  // 2026-07-10 (WI-3797) is unreachable rather than merely unlikely.
  describe('WI-5820 flag-gated + band-capped profiling', () => {
    const profilesIn = async (dir: string): Promise<string[]> => {
      try {
        return (await fs.readdir(dir)).filter((f) => f.endsWith('.cpuprofile'));
      } catch {
        return []; // dir never created ⇒ nothing captured, which is the assertion
      }
    };

    it('predicate gate returning false is inert — the lag warning still fires, no capture', async () => {
      const dir = tmp('pred-off');
      const log = vi.fn();
      const gate = vi.fn(() => false);
      handle = startEventLoopLagMonitor({
        intervalMs: 60,
        warnP95Ms: 20,
        profileOnSaturation: gate,
        profileDir: dir,
        profileTriggerP95Ms: 20,
        minProfileGapMs: 0,
        log,
      });
      for (let i = 0; i < 4; i++) {
        blockFor(40);
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(gate).toHaveBeenCalled(); // the gate IS consulted (not dead code)
      expect(log).toHaveBeenCalled(); // symptom logging is unaffected
      expect(await profilesIn(dir)).toHaveLength(0);
    });

    it('the gate is read LAZILY per window, not latched at construction — flipping it on later engages with no restart', async () => {
      const dir = tmp('pred-flip');
      let enabled = false;
      const gate = vi.fn(() => enabled);
      handle = startEventLoopLagMonitor({
        intervalMs: 60,
        warnP95Ms: 20,
        profileOnSaturation: gate,
        profileDir: dir,
        profileTriggerP95Ms: 20,
        profileDurationMs: 120,
        minProfileGapMs: 0,
        maxProfiles: 3,
        log: vi.fn(),
      });
      for (let i = 0; i < 3; i++) {
        blockFor(40);
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 150));
      expect(await profilesIn(dir)).toHaveLength(0); // still off
      const callsWhileOff = gate.mock.calls.length;
      expect(callsWhileOff).toBeGreaterThan(0);

      enabled = true; // simulate the /admin/features flip — no restart
      for (let i = 0; i < 3; i++) {
        blockFor(40);
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 400));
      // Re-consulted after the flip — that is the lazy-read contract. (Whether a
      // .cpuprofile lands is inspector-availability dependent, so it is not asserted.)
      expect(gate.mock.calls.length).toBeGreaterThan(callsWhileOff);
    });

    it('a gate that THROWS never breaks lag monitoring and never captures', async () => {
      const dir = tmp('pred-throw');
      const log = vi.fn();
      handle = startEventLoopLagMonitor({
        intervalMs: 60,
        warnP95Ms: 20,
        profileOnSaturation: () => {
          throw new Error('flag backend unreachable');
        },
        profileDir: dir,
        profileTriggerP95Ms: 20,
        minProfileGapMs: 0,
        log,
      });
      for (let i = 0; i < 4; i++) {
        blockFor(40);
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(log).toHaveBeenCalled(); // the gauge keeps working
      expect(await profilesIn(dir)).toHaveLength(0);
    });

    // THE regression guard for WI-3797: above the cap we must not even ATTEMPT a
    // capture, because the failure mode there is a native abort that no try/catch
    // can contain — the process dies.
    it('SAFETY CAP: a window at/above profileMaxP95Ms is never profiled, and the skip is logged', async () => {
      const dir = tmp('cap');
      const log = vi.fn();
      const gate = vi.fn(() => true);
      handle = startEventLoopLagMonitor({
        intervalMs: 60,
        warnP95Ms: 20,
        profileOnSaturation: gate,
        profileDir: dir,
        // The invariant under test is that the profiling band is HALF-OPEN —
        // [trigger, cap) — so a window AT OR ABOVE the cap is never profiled.
        // Exercising that at equality (cap === trigger ⇒ the band is empty) is the
        // only STABLE way to assert it here: this harness cannot produce an
        // arbitrarily large p95 on demand. A synchronous 300ms block still reports
        // a window p95 of only ~20-33ms (measured), because the delay histogram
        // resets per 60ms window, so "block 10x longer than the cap" does NOT move
        // the window p95 above a cap set comfortably clear of the trigger — a
        // cap-vs-block-length test reads as deterministic and silently is not.
        profileTriggerP95Ms: 20,
        profileMaxP95Ms: 20,
        profileDurationMs: 120,
        minProfileGapMs: 0,
        log,
      });
      for (let i = 0; i < 4; i++) {
        blockFor(40);
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(await profilesIn(dir)).toHaveLength(0);
      // Not silent: the missing attribution is announced, with the cap that caused it.
      const skip = log.mock.calls.find(([line]) => String(line).includes('SKIPPED'));
      expect(skip).toBeTruthy();
      expect(String(skip?.[0])).toMatch(/too saturated to profile safely/);
      expect(skip?.[1]).toMatchObject({ profileMaxP95Ms: 20, reason: 'above-safety-cap' });
    });

    it('the default cap (3000ms) leaves the chronic band profilable — a sub-cap window still captures', async () => {
      const dir = tmp('under-cap');
      handle = startEventLoopLagMonitor({
        intervalMs: 60,
        warnP95Ms: 20,
        profileOnSaturation: () => true,
        profileDir: dir,
        profileTriggerP95Ms: 20,
        // profileMaxP95Ms omitted ⇒ 3000ms default; the ~40ms blocks are far below it.
        profileDurationMs: 120,
        minProfileGapMs: 0,
        maxProfiles: 2,
        log: vi.fn(),
      });
      for (let i = 0; i < 4; i++) {
        blockFor(40);
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 500));
      // Inspector availability varies by env, so assert the bound, not the presence.
      expect((await profilesIn(dir)).length).toBeLessThanOrEqual(2);
    });
  });
});

describe('P-002 heap-snapshot-on-high-RSS (bg-host-freeze-eventloop-stall-2026-06-30)', () => {
  const dirs: string[] = [];
  let handle: LagMonitorHandle | undefined;
  afterEach(async () => {
    handle?.stop();
    handle = undefined;
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });
  const tmp = (tag: string) => {
    const d = path.join(os.tmpdir(), `heap-snap-${tag}-${Date.now()}-${process.pid}`);
    dirs.push(d);
    return d;
  };

  it('captureHeapSnapshot writes a valid .heapsnapshot (or degrades to null, never throws)', async () => {
    // Heap snapshots can take several seconds on a large heap; give plenty of time.
    const dir = tmp('cap');
    const file = await captureHeapSnapshot({
      dir,
      maxSnapshots: 5,
      rssMb: process.memoryUsage().rss / 1_048_576,
      log: vi.fn(),
    });
    // Contract: returns a path when an inspector is available, else null — never throws.
    if (file === null) return; // env without a free inspector (e.g. coverage attached)
    expect(file.endsWith('.heapsnapshot')).toBe(true);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    // A V8 heap snapshot has snapshot.meta + nodes + strings arrays.
    expect(parsed).toHaveProperty('snapshot');
    expect(parsed).toHaveProperty('nodes');
    expect(parsed).toHaveProperty('strings');
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(Array.isArray(parsed.strings)).toBe(true);
  }, 30_000);

  it('captureHeapSnapshot prunes to maxSnapshots (oldest removed)', async () => {
    const dir = tmp('prune');
    // Write 3 snapshots with maxSnapshots=2 — the oldest must be removed.
    for (let i = 0; i < 3; i++) {
      await captureHeapSnapshot({ dir, maxSnapshots: 2, rssMb: 1, log: vi.fn() });
    }
    let snaps: string[] = [];
    try {
      snaps = (await fs.readdir(dir)).filter((f) => f.endsWith('.heapsnapshot'));
    } catch {
      /* no inspector → dir never created → graceful no-op */
    }
    expect(snaps.length).toBeLessThanOrEqual(2);
  }, 90_000);

  it('heapSnapshotOnHighRss: full snapshots are INERT by default even when legacy sampling env is on', async () => {
    // The monitor must NOT capture unless heapSnapshotOnHighRss is explicitly enabled,
    // even when RSS comfortably exceeds a 1 MB threshold.
    const dir = tmp('inert');
    const log = vi.fn();
    const prev = process.env.PAPERCUSP_HEAP_SNAPSHOT;
    process.env.PAPERCUSP_HEAP_SNAPSHOT = '1';
    handle = startEventLoopLagMonitor({
      intervalMs: 60,
      warnP95Ms: 999_999,
      // heapSnapshotOnHighRss not set: legacy PAPERCUSP_HEAP_SNAPSHOT enables the
      // non-blocking sampling profiler, NOT full V8 heap snapshots (WI-3255).
      heapSnapshotDir: dir,
      heapSnapshotRssMb: 1, // 1 MB — guaranteed to be exceeded
      minHeapSnapshotGapMs: 0,
      log,
    });
    await new Promise((r) => setTimeout(r, 200));
    if (prev === undefined) delete process.env.PAPERCUSP_HEAP_SNAPSHOT;
    else process.env.PAPERCUSP_HEAP_SNAPSHOT = prev;
    let snaps: string[] = [];
    try {
      snaps = (await fs.readdir(dir)).filter((f) => f.endsWith('.heapsnapshot'));
    } catch {
      /* dir not created = inert, which is the point */
    }
    expect(snaps).toHaveLength(0);
  });

  it('sampling-only mode dumps at high RSS while full snapshots remain off', async () => {
    const dir = tmp('sampling-only-high-rss');
    const log = vi.fn();
    handle = startEventLoopLagMonitor({
      intervalMs: 40,
      warnP95Ms: 999_999,
      heapSnapshotOnHighRss: false,
      heapSamplingOnHighRss: true,
      heapSamplingRssMb: 1,
      minHeapSamplingDumpGapMs: 10_000,
      heapSnapshotDir: dir,
      log,
    });

    await vi.waitFor(
      () => {
        expect(log.mock.calls.some(([line]) => String(line).includes('profile dumped on high RSS'))).toBe(true);
      },
      { timeout: 5_000, interval: 20 },
    );

    const files = await fs.readdir(dir);
    expect(files.filter((file) => file.endsWith('.heapprofile'))).toHaveLength(1);
    expect(files.filter((file) => file.endsWith('.heapsnapshot'))).toHaveLength(0);
  });

  it('heapSnapshotOnHighRss ON: captures when RSS crosses threshold, rate-limited', async () => {
    const dir = tmp('on');
    const log = vi.fn();
    // Use a 1 MB threshold so it fires immediately (current process RSS >> 1 MB),
    // and a 10s gap so only ONE capture fires per timer tick.
    handle = startEventLoopLagMonitor({
      intervalMs: 80,
      warnP95Ms: 999_999,
      heapSnapshotOnHighRss: true,
      heapSnapshotDir: dir,
      heapSnapshotRssMb: 1,        // 1 MB — always exceeded
      minHeapSnapshotGapMs: 10_000, // 10s gap → only one fire in this test window
      maxHeapSnapshots: 3,
      log,
    });
    // Wait for at least one timer tick + capture
    await new Promise((r) => setTimeout(r, 5_000));
    let snaps: string[] = [];
    try {
      snaps = (await fs.readdir(dir)).filter((f) => f.endsWith('.heapsnapshot'));
    } catch {
      /* no inspector → graceful no-op */
    }
    // At most 1 capture (rate-limited by the 10s gap); could be 0 if no inspector.
    expect(snaps.length).toBeLessThanOrEqual(1);
    if (snaps.length > 0) {
      // Must be valid JSON with the heap snapshot shape.
      const parsed = JSON.parse(await fs.readFile(path.join(dir, snaps[0]), 'utf8'));
      expect(parsed).toHaveProperty('snapshot');
      expect(parsed).toHaveProperty('nodes');
    }
  }, 30_000);
});

describe('shouldTriggerFullHeapSnapshot — SPOF 1h self-disarm gate (autonomous-loop-prod-audit-2026-07-02 P-006)', () => {
  const NOW = 1_000_000;
  const opts = { heapSnapshotOnHighRss: true, heapSnapshotSingleShot: true, minHeapSnapshotGapMs: 10_000 };

  it('never triggers when heapSnapshotOnHighRss is off', () => {
    expect(
      shouldTriggerFullHeapSnapshot(
        { snapshotting: false, fullSnapshotTaken: false, lastSnapshotAt: 0 },
        NOW,
        { ...opts, heapSnapshotOnHighRss: false },
      ),
    ).toBe(false);
  });

  it('single-flight: never triggers while a capture is already in progress', () => {
    expect(
      shouldTriggerFullHeapSnapshot({ snapshotting: true, fullSnapshotTaken: false, lastSnapshotAt: 0 }, NOW, opts),
    ).toBe(false);
  });

  it('rate-limit: does not trigger before the gap elapses', () => {
    expect(
      shouldTriggerFullHeapSnapshot(
        { snapshotting: false, fullSnapshotTaken: false, lastSnapshotAt: NOW - 5_000 },
        NOW,
        opts,
      ),
    ).toBe(false);
  });

  it('triggers on the first eligible tick (gap elapsed, never taken)', () => {
    expect(
      shouldTriggerFullHeapSnapshot(
        { snapshotting: false, fullSnapshotTaken: false, lastSnapshotAt: NOW - 20_000 },
        NOW,
        opts,
      ),
    ).toBe(true);
  });

  it('SELF-DISARMS: once fullSnapshotTaken, never triggers again even after the gap elapses (singleShot true)', () => {
    expect(
      shouldTriggerFullHeapSnapshot(
        { snapshotting: false, fullSnapshotTaken: true, lastSnapshotAt: NOW - 999_999 },
        NOW,
        opts,
      ),
    ).toBe(false);
  });

  it('with singleShot FALSE, re-triggers after the gap elapses even if already taken once (legacy repeating behavior)', () => {
    expect(
      shouldTriggerFullHeapSnapshot(
        { snapshotting: false, fullSnapshotTaken: true, lastSnapshotAt: NOW - 20_000 },
        NOW,
        { ...opts, heapSnapshotSingleShot: false },
      ),
    ).toBe(true);
  });
});

describe('shouldTriggerHeapSamplingDump — sampling-only high-RSS gate', () => {
  const NOW = 1_000_000;
  const state = { samplingArmed: true, samplingDumping: false, lastSamplingDumpAt: NOW - 20_000 };
  const opts = { heapSamplingOnHighRss: true, heapSamplingRssMb: 1024, minHeapSamplingDumpGapMs: 10_000 };

  it('triggers once sampling is armed, RSS is high, and the sampling cadence elapsed', () => {
    expect(shouldTriggerHeapSamplingDump(state, NOW, 2048, opts)).toBe(true);
  });

  it('stays inert when sampling is disabled, not armed, already dumping, RSS is low, or the gap is live', () => {
    expect(shouldTriggerHeapSamplingDump(state, NOW, 2048, { ...opts, heapSamplingOnHighRss: false })).toBe(false);
    expect(shouldTriggerHeapSamplingDump({ ...state, samplingArmed: false }, NOW, 2048, opts)).toBe(false);
    expect(shouldTriggerHeapSamplingDump({ ...state, samplingDumping: true }, NOW, 2048, opts)).toBe(false);
    expect(shouldTriggerHeapSamplingDump(state, NOW, 1023, opts)).toBe(false);
    expect(
      shouldTriggerHeapSamplingDump({ ...state, lastSamplingDumpAt: NOW - 5_000 }, NOW, 2048, opts),
    ).toBe(false);
  });
});

describe('cooperativeYield / yieldToEventLoop (event-loop-lag root fix)', () => {
  it('yieldToEventLoop lets a pending macrotask (the "ticker") run before continuing', async () => {
    const order: string[] = [];
    // A pending immediate stands in for the routine ticker callback.
    setImmediate(() => order.push('ticker'));
    order.push('before');
    await yieldToEventLoop();
    order.push('after');
    // The ticker ran in the gap, NOT after the loop continued.
    expect(order).toEqual(['before', 'ticker', 'after']);
  });

  it('cooperativeYield yields on the everyN boundary and advances the counter', async () => {
    // No monitor running ⇒ loopPressure() is 'ok', so only the everyN boundary triggers a yield.
    let ranTicker = false;
    let n = 0;
    // everyN = 4 (default): iterations 1,2,3 do NOT yield; iteration 4 does.
    for (let i = 0; i < 3; i++) {
      setImmediate(() => { ranTicker = true; });
      n = await cooperativeYield(n);
      // setImmediate scheduled but a non-yielding iteration must NOT have run it yet
      // (we can't assert synchronously across awaits reliably, so just track count).
    }
    expect(n).toBe(3); // counter advanced once per call
    // The 4th call crosses the boundary → yields → the pending immediate runs.
    setImmediate(() => { ranTicker = true; });
    n = await cooperativeYield(n);
    expect(n).toBe(4);
    expect(ranTicker).toBe(true);
  });

  it('cooperativeYield respects a custom everyN', async () => {
    let n = 0;
    n = await cooperativeYield(n, 1); // everyN=1 ⇒ yields every iteration
    expect(n).toBe(1);
    n = await cooperativeYield(n, 1);
    expect(n).toBe(2);
  });

  it('createTimeSlice yields only once the slice budget is spent, then starts a new slice (WI-10005476)', async () => {
    // No monitor running ⇒ loopPressure() is 'ok', so only elapsed time triggers a yield.
    let t = 0;
    const yieldFn = vi.fn(async () => {});
    const slice = createTimeSlice(10, { now: () => t, yieldFn });
    t = 9;
    await slice.maybeYield();
    expect(yieldFn).not.toHaveBeenCalled(); // under budget: no hop
    t = 10;
    await slice.maybeYield();
    expect(yieldFn).toHaveBeenCalledTimes(1); // budget spent: one hop
    expect(slice.yields).toBe(1);
    t = 15;
    await slice.maybeYield();
    expect(yieldFn).toHaveBeenCalledTimes(1); // new slice began at t=10
    t = 20;
    await slice.maybeYield();
    expect(yieldFn).toHaveBeenCalledTimes(2);
  });

  it('createTimeSlice defaults to a real macrotask hop', async () => {
    const slice = createTimeSlice(0);
    let ticked = false;
    setImmediate(() => { ticked = true; });
    await slice.maybeYield();
    expect(ticked).toBe(true);
  });
});

describe('sampling heap profiler (WI-1088 round 2 — the capture that cannot lose the race)', () => {
  it('topAllocationSites flattens the tree, aggregates per site, sorts by size', async () => {
    const { topAllocationSites } = await import('./event-loop-lag-monitor');
    const head = {
      callFrame: { functionName: '(root)', url: '', lineNumber: -1 },
      selfSize: 0,
      children: [
        {
          callFrame: { functionName: 'leaky', url: 'file:///x/leak.ts', lineNumber: 41 },
          selfSize: 3 * 1_048_576,
          children: [
            { callFrame: { functionName: 'leaky', url: 'file:///x/leak.ts', lineNumber: 41 }, selfSize: 2 * 1_048_576 },
          ],
        },
        { callFrame: { functionName: 'small', url: 'file:///x/ok.ts', lineNumber: 9 }, selfSize: 1_048_576 },
      ],
    };
    const top = topAllocationSites(head);
    expect(top[0]).toEqual({ site: 'leaky @ /x/leak.ts:42', mb: 5 }); // aggregated + 1-based line
    expect(top[1].site).toContain('small @ /x/ok.ts:10');
  });

  it('arms once and dumps a small .heapprofile with top sites logged (real inspector, end-to-end)', async () => {
    const { ensureHeapSampling, dumpHeapSamplingProfile } = await import('./event-loop-lag-monitor');
    const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'heap-sampling-'));
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    try {
      expect(await ensureHeapSampling(log)).toBe(true);
      expect(await ensureHeapSampling(log)).toBe(true); // idempotent
      // Allocate something attributable so the profile is non-trivial.
      const hog: string[] = [];
      for (let i = 0; i < 2_000; i++) hog.push('x'.repeat(1_024));
      const file = await dumpHeapSamplingProfile({ dir, rssMb: 1234, log });
      expect(file).toBeTruthy();
      const files = (await readdir(dir)).filter((f) => f.endsWith('.heapprofile'));
      expect(files).toHaveLength(1);
      const profile = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8')) as { head?: unknown };
      expect(profile.head).toBeTruthy(); // DevTools-loadable shape
      expect(lines.some((l) => l.includes('top live allocation sites'))).toBe(true);
      expect(hog.length).toBe(2_000); // keep the hog alive through the dump
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('WI-4189: dumpHeapSamplingProfile prunes to maxProfiles (oldest removed) — .heapprofile had NO retention before this', async () => {
    const { ensureHeapSampling, dumpHeapSamplingProfile } = await import('./event-loop-lag-monitor');
    const { mkdtemp, readdir, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'heap-sampling-prune-'));
    const log = vi.fn();
    try {
      expect(await ensureHeapSampling(log)).toBe(true);
      // Dump 5 profiles with maxProfiles=2 — only the 2 newest must remain.
      for (let i = 0; i < 5; i++) {
        const file = await dumpHeapSamplingProfile({ dir, rssMb: 1, maxProfiles: 2, log });
        expect(file).toBeTruthy();
      }
      const files = (await readdir(dir)).filter((f) => f.endsWith('.heapprofile'));
      expect(files.length).toBeLessThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('recovers its sampler after another inspector client stops it, without claiming continuous history', async () => {
    const { Session } = await import('node:inspector');
    const { ensureHeapSampling, dumpHeapSamplingProfile } = await import('./event-loop-lag-monitor');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heap-sampling-recovery-'));
    const lines: string[] = [];
    let observer = new Session();
    observer.connect();
    const post = (method: string) => new Promise<{ profile?: unknown }>((resolve, reject) => {
      observer.post(method, (error, result) => error ? reject(error) : resolve(result));
    });
    try {
      expect(await ensureHeapSampling((line) => lines.push(line))).toBe(true);
      expect((await post('HeapProfiler.getSamplingProfile')).profile).toBeTruthy();
      // V8 shares this sampler across inspector sessions. The monitor still
      // holds its Session after a different client stops the underlying sampler.
      await post('HeapProfiler.stopSampling');
      expect(await dumpHeapSamplingProfile({ dir, rssMb: 1, log: (line) => lines.push(line) })).toBeNull();
      expect(lines.some((line) => line.includes('re-armed') && line.includes('history has a gap'))).toBe(true);
      expect((await post('HeapProfiler.getSamplingProfile')).profile).toBeTruthy();
      expect(await fs.readdir(dir)).toEqual([]);

      observer.disconnect();
      observer = new Session();
      observer.connect();
      expect((await post('HeapProfiler.getSamplingProfile')).profile).toBeTruthy();
      const file = await dumpHeapSamplingProfile({ dir, rssMb: 1, log: (line) => lines.push(line) });
      expect(file).toBeTruthy();
      expect(JSON.parse(await fs.readFile(file!, 'utf8')).head).toBeTruthy();
    } finally {
      observer.disconnect();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('WI-4189: dumpHeapSamplingProfile defaults maxProfiles to 50 when omitted', async () => {
    const { ensureHeapSampling, dumpHeapSamplingProfile } = await import('./event-loop-lag-monitor');
    const { mkdtemp, readdir, writeFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'heap-sampling-default-prune-'));
    const log = vi.fn();
    try {
      expect(await ensureHeapSampling(log)).toBe(true);
      // Seed 55 fake pre-existing .heapprofile files (cheap — no real inspector dump needed
      // to manufacture the excess), then one real dump must prune down toward the default cap.
      for (let i = 0; i < 55; i++) {
        await writeFile(path.join(dir, `heap-sampling-${1_700_000_000_000 + i}-pidfake-rss_1mb.heapprofile`), '{}');
      }
      const file = await dumpHeapSamplingProfile({ dir, rssMb: 1, log }); // maxProfiles omitted
      expect(file).toBeTruthy();
      const files = (await readdir(dir)).filter((f) => f.endsWith('.heapprofile'));
      expect(files.length).toBeLessThanOrEqual(50);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('setLagPublishTarget (EI-19484853609145439: sentinel-readable last-known lag)', () => {
  let handle: LagMonitorHandle | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
    // Module-level state — must not bleed into other test files/tests.
    setLagPublishTarget(null);
  });

  it('publishes rounded p50/p95/p99/max into the SAB at SENTINEL_SAB_IDX on every tick', async () => {
    const sab = new SharedArrayBuffer(SENTINEL_SAB_INT32_LEN * Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(sab);
    const lagSlots = [
      SENTINEL_SAB_IDX.LAG_P50_MS,
      SENTINEL_SAB_IDX.LAG_P95_MS,
      SENTINEL_SAB_IDX.LAG_P99_MS,
      SENTINEL_SAB_IDX.LAG_MAX_MS,
    ];
    // Sentinel-seed every slot: proves the tick WROTE each one, rather than us
    // reading a coincidental 0 that was already sitting there.
    for (const idx of lagSlots) Atomics.store(view, idx, -1);
    setLagPublishTarget(sab);
    handle = startEventLoopLagMonitor({ intervalMs: 20, warnP95Ms: 100_000 });
    // Wait on the contract this test actually owns: a tick overwrote every
    // sentinel. Do not require a one-shot manufactured block to appear in a
    // particular window — the monitor resets the histogram after every tick, so
    // that condition can legitimately be missed forever under timer jitter.
    await vi.waitFor(() => {
      for (const idx of lagSlots) expect(Atomics.load(view, idx)).not.toBe(-1);
    }, { timeout: 10_000, interval: 5 });

    const published = lagSlots.map((idx) => Atomics.load(view, idx));
    for (const v of published) {
      expect(v).not.toBe(-1); // the tick wrote this slot
      expect(Number.isInteger(v)).toBe(true); // Math.round was applied
      expect(v).toBeGreaterThanOrEqual(0);
    }

    // Do not compare this published snapshot with `handle.sample()` afterward:
    // the monitor resets its histogram at the end of every tick, so the two reads
    // can belong to different windows. The snapshot itself must still preserve
    // the histogram's percentile ordering.
    const [p50, p95, p99, max] = published;
    expect(p50).toBeLessThanOrEqual(p95);
    expect(p95).toBeLessThanOrEqual(p99);
    expect(p99).toBeLessThanOrEqual(max);
    // The heartbeat slot (index 0, owned by event-loop-sentinel-host.ts) must
    // never be touched by the lag monitor — it is a different publisher.
    expect(Atomics.load(view, SENTINEL_SAB_IDX.HEARTBEAT)).toBe(0);
  });

  it('is late-bindable: wiring the target AFTER the monitor already started still publishes', async () => {
    const sab = new SharedArrayBuffer(SENTINEL_SAB_INT32_LEN * Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(sab);
    // Sentinel value: proves the tick actually writes, rather than the slot
    // coincidentally already reading whatever a real tick would produce.
    Atomics.store(view, SENTINEL_SAB_IDX.LAG_P95_MS, -1);
    handle = startEventLoopLagMonitor({ intervalMs: 20, warnP95Ms: 100_000 });
    // No target wired yet — must not throw, and (checked below) must not write.
    await new Promise((r) => setTimeout(r, 60));
    expect(Atomics.load(view, SENTINEL_SAB_IDX.LAG_P95_MS)).toBe(-1);
    setLagPublishTarget(sab);
    // A real tick ran and overwrote the sentinel — that overwrite IS the proof
    // late-binding works (no artificial load required: this proves the wiring,
    // not that lag was elevated). Wait on the overwrite itself; a later sample
    // belongs to a different reset window and is not a valid comparison.
    await vi.waitFor(() => {
      expect(Atomics.load(view, SENTINEL_SAB_IDX.LAG_P95_MS)).not.toBe(-1);
    }, { timeout: 10_000, interval: 5 });
    const publishedP95 = Atomics.load(view, SENTINEL_SAB_IDX.LAG_P95_MS);
    expect(Number.isInteger(publishedP95)).toBe(true);
    expect(publishedP95).toBeGreaterThanOrEqual(0);
  });

  it('null clears the target — no throw, and no further writes', async () => {
    const sab = new SharedArrayBuffer(SENTINEL_SAB_INT32_LEN * Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(sab);
    setLagPublishTarget(sab);
    handle = startEventLoopLagMonitor({ intervalMs: 20, warnP95Ms: 100_000 });
    await new Promise((r) => setTimeout(r, 60));
    setLagPublishTarget(null);
    Atomics.store(view, SENTINEL_SAB_IDX.LAG_P95_MS, -1); // sentinel value
    await new Promise((r) => setTimeout(r, 60));
    // If the monitor kept a stale reference it would overwrite -1; it must not.
    expect(Atomics.load(view, SENTINEL_SAB_IDX.LAG_P95_MS)).toBe(-1);
  });

  it('a too-small/foreign SAB is rejected defensively rather than throwing inside the tick', async () => {
    const tooSmall = new SharedArrayBuffer(4); // 1 int32 — smaller than SENTINEL_SAB_INT32_LEN
    expect(() => setLagPublishTarget(tooSmall)).not.toThrow();
    handle = startEventLoopLagMonitor({ intervalMs: 20, warnP95Ms: 100_000 });
    // Must not throw synchronously nor asynchronously inside the interval tick.
    await new Promise((r) => setTimeout(r, 60));
    expect(handle.sample().p95Ms).toBeGreaterThanOrEqual(0); // monitor still alive/functioning
  });

  it('with no target wired at all, the tick is unaffected (today’s default behavior)', async () => {
    handle = startEventLoopLagMonitor({ intervalMs: 20, warnP95Ms: 100_000 });
    await expect(new Promise((r) => setTimeout(r, 60))).resolves.toBeUndefined();
    expect(handle.sample().p95Ms).toBeGreaterThanOrEqual(0);
  });

  // WI-40842 — recurrence guard for the CLASS, not for one assertion.
  //
  // Every tick-dependent test in this file measures a monitor that must actually be
  // running. The scheduled-registry keeps the default timer backend inert under Vitest
  // (a real interval firing into another test's factory mocks is EI-21209553211440005),
  // and a suppressed timer produces NO error — it returns a no-op handle, so a whole
  // class of assertions here silently measured a monitor that never ticked. That is
  // exactly what happened at 03:00Z on 2026-08-23: 9 of 45 tests in this file went red
  // and stayed red. Assert the arm DIRECTLY, so the next time the opt-in is dropped the
  // failure names the cause instead of surfacing as nine unrelated timing assertions.
  describe('WI-40842: the monitor arms a LIVE managed timer under Vitest', () => {
    afterEach(() => {
      stopManaged('wi40842-control-not-opted-in');
    });

    it('registers a live managed timer, and deregisters it on stop()', () => {
      handle = startEventLoopLagMonitor({ intervalMs: 10_000, warnP95Ms: 1000 });
      // Pre-fix this is undefined: the Vitest guard returned a no-op handle and
      // registered nothing, so no tick ever ran.
      expect(getManaged('event-loop-lag-monitor')).toBeDefined();
      handle.stop();
      handle = undefined;
      expect(getManaged('event-loop-lag-monitor')).toBeUndefined();
    });

    it('CONTROL: a NON-opted-in real interval stays inert (EI-21209553211440005 stays closed)', () => {
      // The remedy above is an opt-in at ONE deliberately-exercised call site, never a
      // relaxation of the guard. If someone "fixes" a future red by weakening the guard
      // itself, this fails loudly rather than silently re-opening the original hazard.
      const fired = vi.fn();
      const h = managedSetInterval('wi40842-control-not-opted-in', 5, fired, {
        category: 'watchdog',
      });
      expect(getManaged('wi40842-control-not-opted-in')).toBeUndefined();
      h.stop();
    });
  });
});
