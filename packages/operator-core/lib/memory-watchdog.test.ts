import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fallbackRecorder from './degradation/fallback-observations';
import {
  startMemoryWatchdog,
  readSelfSwapMb,
  resolveMemoryWatchdogLimitMb,
  resolveMemoryWatchdogProactiveGcMb,
  MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND,
  MEMORY_WATCHDOG_LIMIT_MB_DESKTOP,
  MEMORY_WATCHDOG_LIMIT_MB_REQUEST,
  MEMORY_WATCHDOG_LIMIT_MB_STAGING,
  MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND,
  MEMORY_WATCHDOG_PROACTIVE_GC_MB_DESKTOP,
  MEMORY_WATCHDOG_PROACTIVE_GC_MB_REQUEST,
  MEMORY_WATCHDOG_PROACTIVE_GC_MB_STAGING,
} from './memory-watchdog';

describe('startMemoryWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(fallbackRecorder, 'observeFallback').mockReturnValue(true);
    vi.spyOn(fallbackRecorder, 'flushFallbackObservations').mockResolvedValue({ written: 0, failed: 0, dropped: 0, rejected: 0 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * WI-2145659: the thresholds compare COMMITTED memory (`VmRSS + VmSwap`), so a
   * test that stubs only `process.memoryUsage()` would have the REAL test
   * process's swap silently added to its intended RSS. On this box, under fleet
   * load, that is not hypothetical — it would make every threshold assertion
   * below depend on how much the kernel happened to page out during the run.
   * Injecting a zero swap reader pins committed == the stubbed RSS, preserving
   * each existing test's original meaning. The swap term gets its own tests.
   */
  const noSwap = () => 0;

  function withRss(mb: number) {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: mb * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage);
  }

  it('recycles only after the high-water mark is held for tripsToRecycle samples (a process that GREW into the limit)', () => {
    withRss(800); // healthy first — a grow-into-limit process, not born over budget
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({ readSwapMb: noSwap, intervalMs: 1000, tripsToRecycle: 2, warnMb: 2400, onTrip, log });

    vi.advanceTimersByTime(1000); // sample 1 — healthy (marks sawHealthySample)
    withRss(4000); // over the 3200 default
    vi.advanceTimersByTime(1000); // sample 2 — over, but debounce not met
    expect(onTrip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // sample 3 — over, debounce met → trips
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0][0]).toMatchObject({ limitMb: 3200 });

    // Idempotent: no further trips after recycle latches.
    vi.advanceTimersByTime(3000);
    expect(onTrip).toHaveBeenCalledTimes(1);
    h.stop();
  });

  // EI-11522 — born-over-budget recycle guard: a process that boots straight into
  // an over-budget working set (the desktop sidecar warm-boots ~23 plugins to
  // ~3.1 GB immediately) must NOT SIGKILL-recycle in a loop — the fresh restart
  // boots into the same footprint, reclaims ~nothing, and severs in-flight
  // converse SSE turns each cycle. It escalates loudly and keeps serving instead.
  it('a process BORN over budget (over the limit from boot, never healthy) SUPPRESSES the recycle instead of hot-looping (EI-11522)', () => {
    withRss(3300); // over the 3200 limit from the very first sample
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      tripsToRecycle: 2,
      warnMb: 2400,
      limitMb: 3200,
      onTrip,
      log,
    });

    vi.advanceTimersByTime(1000); // over (count=1)
    vi.advanceTimersByTime(1000); // over (count=2) — would trip, but born over budget
    vi.advanceTimersByTime(5000); // keep sampling — still no recycle
    expect(onTrip).not.toHaveBeenCalled();

    // Escalates loudly exactly once — not per-tick spam.
    const suppressLines = log.mock.calls.filter((c) =>
      String(c[0]).includes('SUPPRESSING the recycle'),
    );
    expect(suppressLines).toHaveLength(1);
    h.stop();
  });

  it('the DEFAULT (no onTrip) recycle is also suppressed — a born-over-budget process never exits (EI-11522)', () => {
    withRss(3300);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      tripsToRecycle: 1,
      warnMb: 2400,
      limitMb: 3200,
      log: vi.fn(),
    });
    vi.advanceTimersByTime(1000); // would trip → suppressed (never healthy)
    vi.advanceTimersByTime(250); // no flush-then-exit was ever scheduled
    expect(exitSpy).not.toHaveBeenCalled();
    h.stop();
  });

  it('the desktop :3270 tier gives its observed born RSS headroom, then recycles growth past the tier', () => {
    // The live desktop dev host measured ~10.6–11.6 GiB at boot. With the
    // dedicated 16 GiB tier, its default 12 GiB warn line sees healthy headroom
    // first, so the born-over-budget guard cannot permanently disarm recycling.
    withRss(10_600);
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      tripsToRecycle: 1,
      limitMb: MEMORY_WATCHDOG_LIMIT_MB_DESKTOP,
      proactiveGcMb: 0,
      onTrip,
      log: vi.fn(),
    });
    vi.advanceTimersByTime(1000); // 10.6 GiB < 12 GiB warn line → healthy sample
    withRss(17_000);
    vi.advanceTimersByTime(1000); // growth past 16 GiB → recycle
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0][0]).toMatchObject({ limitMb: MEMORY_WATCHDOG_LIMIT_MB_DESKTOP });
    h.stop();
  });

  it('a born-over-budget process that later recovers below warn then climbs again DOES recycle (the guard releases) (EI-11522)', () => {
    withRss(3300); // born over budget
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      tripsToRecycle: 1,
      warnMb: 2400,
      limitMb: 3200,
      onTrip,
      log: vi.fn(),
    });
    vi.advanceTimersByTime(1000); // over → suppressed (never healthy yet)
    expect(onTrip).not.toHaveBeenCalled();
    withRss(800);
    vi.advanceTimersByTime(1000); // healthy → sawHealthySample=true, overCount reset
    withRss(4000);
    vi.advanceTimersByTime(1000); // over again — now it demonstrably had headroom → recycles
    expect(onTrip).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('suppressBornOverBudgetRecycle:false restores the always-recycle behavior for a born-over-budget process', () => {
    withRss(3300);
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      tripsToRecycle: 1,
      warnMb: 2400,
      limitMb: 3200,
      suppressBornOverBudgetRecycle: false,
      onTrip,
      log: vi.fn(),
    });
    vi.advanceTimersByTime(1000); // over → recycles (guard disabled)
    expect(onTrip).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('a transient spike that drops back under the limit does NOT recycle (debounce reset)', () => {
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({ readSwapMb: noSwap, intervalMs: 1000, tripsToRecycle: 2, onTrip, log: vi.fn() });

    withRss(4000);
    vi.advanceTimersByTime(1000); // over (count=1)
    withRss(1000); // GC'd back down
    vi.advanceTimersByTime(1000); // under → reset
    withRss(4000);
    vi.advanceTimersByTime(1000); // over again (count=1, not 2)
    expect(onTrip).not.toHaveBeenCalled();
    h.stop();
  });

  it('stays silent and never trips well under the threshold', () => {
    withRss(800);
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({ readSwapMb: noSwap, intervalMs: 1000, warnMb: 2400, onTrip, log });
    vi.advanceTimersByTime(10_000);
    expect(onTrip).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled(); // below warn threshold → silent
    h.stop();
  });

  it('logs a soft-threshold gauge line above warnMb without recycling', () => {
    withRss(2600);
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({ readSwapMb: noSwap, intervalMs: 1000, warnMb: 2400, limitMb: 3200, onTrip, log });
    vi.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalled();
    expect(onTrip).not.toHaveBeenCalled();
    h.stop();
  });

  it('the DEFAULT recycle flushes before exiting NON-ZERO (75) so systemd restarts under Restart=on-failure too (EI-1613, R4-1)', async () => {
    withRss(800); // healthy first — a grow-into-limit process (born-over-budget is suppressed)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // no onTrip injected → exercise the default recycle path
    const h = startMemoryWatchdog({ readSwapMb: noSwap, intervalMs: 1000, tripsToRecycle: 1, warnMb: 2400, log: vi.fn() });
    vi.advanceTimersByTime(1000); // sample 1 — healthy (marks sawHealthySample)
    withRss(4000);
    vi.advanceTimersByTime(1000); // trips → schedules the 250ms flush-then-exit
    expect(exitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250); // flush observation, then process.exit(recycleExitCode)
    expect(fallbackRecorder.flushFallbackObservations).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(75);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
    h.stop();
  });

  it('recycles even when the observation flush never settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withRss(800);
    vi.mocked(fallbackRecorder.flushFallbackObservations).mockImplementation(() => new Promise(() => {}));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const h = startMemoryWatchdog({ readSwapMb: noSwap, intervalMs: 1000, tripsToRecycle: 1,
      warnMb: 2400, log: vi.fn() });
    try {
      vi.advanceTimersByTime(1000);
      withRss(4000); vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(1249);
      expect(exitSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exitSpy).toHaveBeenCalledWith(75);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('memory-watchdog-flush exceeded 1000ms'));
    } finally { h.stop(); }
  });

  it('honors an explicit recycleExitCode in the default recycle', async () => {
    withRss(800); // healthy first — a grow-into-limit process
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(vi.fn<typeof process.exit>());
    const h = startMemoryWatchdog({ readSwapMb: noSwap, intervalMs: 1000, tripsToRecycle: 1, warnMb: 2400, recycleExitCode: 42, log: vi.fn() });
    vi.advanceTimersByTime(1000); // sample 1 — healthy
    withRss(4000);
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(250);
    expect(exitSpy).toHaveBeenCalledWith(42);
    h.stop();
  });

  it('runs proactive GC at its independent threshold while the recycle backstop remains higher', () => {
    withRss(2500);
    const forceGc = vi.fn();
    const onTrip = vi.fn();
    const log = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      limitMb: 12288,
      proactiveGcMb: 1920,
      gcCooldownMs: 0,
      forceGc,
      onTrip,
      log,
    });

    vi.advanceTimersByTime(1000);
    expect(forceGc).toHaveBeenCalledTimes(1);
    expect(onTrip).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[memory-watchdog] proactive GC (heap kept out of the stall zone)',
      expect.objectContaining({ proactiveGcMb: 1920, limitMb: 12288 }),
    );
    h.stop();
  });

  // WI-2145733 — the native-heap trim seam. V8's GC returns freed bytes to the
  // ALLOCATOR, which keeps them: measured on a live :3170 worker, a forced full GC
  // moved 3.8% of committed memory while a `malloc_trim(0)` returned 627 MB. These
  // tests pin the seam's contract, not the (not-yet-existing) binding.
  const TRIM_LINE = '[memory-watchdog] native heap trim (allocator arena returned to the OS)';

  it('runs the native-heap trim AFTER the forced GC and reports the allocator reclaim separately', () => {
    withRss(2500);
    const forceGc = vi.fn(); // a GC that frees nothing the allocator gives back
    const trimNativeHeap = vi.fn(() => withRss(900)); // the trim is what actually returns pages
    const log = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      limitMb: 12288,
      proactiveGcMb: 1920,
      gcCooldownMs: 0,
      forceGc,
      trimNativeHeap,
      log,
    });

    vi.advanceTimersByTime(1000);

    expect(trimNativeHeap).toHaveBeenCalledTimes(1);
    // ORDER is the contract: trimming BEFORE the GC would leave the bytes the GC is
    // about to free still parked in the arena until the next rung.
    expect(forceGc.mock.invocationCallOrder[0]).toBeLessThan(trimNativeHeap.mock.invocationCallOrder[0]);
    expect(log).toHaveBeenCalledWith(
      TRIM_LINE,
      expect.objectContaining({ committedMbBeforeTrim: 2500, committedMbAfterTrim: 900, reclaimedCommittedMb: 1600 }),
    );
    h.stop();
  });

  /**
   * THE REGRESSION GUARD, and the reason the trim emits its own record instead of
   * being folded into the one above it. ~1300 proactive-GC records exist per worker
   * per 14h and the WI-38221 analysis reads them as a time series, so letting the
   * trim's reclaim leak into `committedMbAfter` would silently re-base an existing
   * field from "after GC" to "after GC + trim" — corrupting history rather than
   * correcting it. This asserts the GC record still describes the GC ALONE even
   * though a trim ran in the same tick and dropped committed memory by 1600 MB.
   */
  it('does not re-base the existing proactive-GC record with the trim reclaim', () => {
    withRss(2500);
    const log = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      limitMb: 12288,
      proactiveGcMb: 1920,
      gcCooldownMs: 0,
      forceGc: vi.fn(),
      trimNativeHeap: () => withRss(900),
      log,
    });

    vi.advanceTimersByTime(1000);

    const gcRecord = log.mock.calls.find((c) => c[0] === '[memory-watchdog] proactive GC (heap kept out of the stall zone)');
    expect(gcRecord).toBeDefined();
    // 2500, NOT 900: the GC freed nothing the allocator returned. If this reads 900
    // the trim has been folded into the GC's own sample and the series is corrupt.
    expect(gcRecord?.[1]).toMatchObject({ committedMbAfter: 2500, reclaimedCommittedMb: 0 });
    h.stop();
  });

  it('is DISABLED by default — no trim rung runs when no binding is injected', () => {
    withRss(2500);
    const log = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      limitMb: 12288,
      proactiveGcMb: 1920,
      gcCooldownMs: 0,
      forceGc: vi.fn(),
      log,
    });

    vi.advanceTimersByTime(1000);

    // The proactive GC still ran — this is the control proving the rung was reached
    // at all, so the absent trim line below is a real absence and not a dead test.
    expect(log).toHaveBeenCalledWith(
      '[memory-watchdog] proactive GC (heap kept out of the stall zone)',
      expect.objectContaining({ proactiveGcMb: 1920 }),
    );
    expect(log.mock.calls.some((c) => c[0] === TRIM_LINE)).toBe(false);
    h.stop();
  });

  it('a throwing trim never crashes the watchdog, and the recycle backstop still works', () => {
    withRss(2500);
    const onTrip = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      tripsToRecycle: 1,
      limitMb: 12288,
      proactiveGcMb: 1920,
      gcCooldownMs: 0,
      forceGc: vi.fn(),
      trimNativeHeap: () => {
        throw new Error('binding unavailable');
      },
      onTrip,
      log: vi.fn(),
    });

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    // ...and the watchdog is still live afterwards: push it over the limit and the
    // recycle path still fires, proving the throw did not kill the interval.
    withRss(13000);
    vi.advanceTimersByTime(1000);
    expect(onTrip).toHaveBeenCalledTimes(1);
    h.stop();
  });

  // WI-38221: RSS alone says HOW MUCH a worker holds and never WHAT, which is the
  // gap that left the :3070 ~2GB/worker growth un-diagnosable for weeks.
  function withMemory(rssMb: number, heapUsedMb: number) {
    return vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: rssMb * 1024 * 1024,
      heapTotal: heapUsedMb * 1024 * 1024,
      heapUsed: heapUsedMb * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage);
  }

  it('the soft-threshold gauge carries the V8 heap decomposition, not just the RSS scalar', () => {
    withMemory(2500, 1800);
    const log = vi.fn();
    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      limitMb: 12288,
      warnMb: 2400,
      proactiveGcMb: 0,
      log,
    });

    vi.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalledWith(
      '[memory-watchdog] committed memory above soft threshold',
      expect.objectContaining({
        rssMb: 2500,
        heapUsedMb: 1800,
        externalMb: expect.any(Number),
        arrayBuffersMb: expect.any(Number),
        // Sourced from real V8 in-process; assert shape, not a fixed value.
        detachedContexts: expect.any(Number),
        nativeContexts: expect.any(Number),
      }),
    );
    h.stop();
  });

  it('the proactive-GC line decomposes POST-GC SURVIVORS, not the pre-GC heap (the retention-vs-garbage distinction)', () => {
    // Pre-GC the process holds 2000 MB of heap; the forced GC collects most of it,
    // leaving 400 MB of genuinely-live survivors. The logged decomposition must
    // describe the SURVIVORS — that is the whole diagnostic value of the line, and
    // sampling it before forceGc() would silently report collectable garbage as
    // retained memory.
    const spy = withMemory(2500, 2000);
    const log = vi.fn();
    const forceGc = vi.fn(() => {
      spy.mockReturnValue({
        rss: 2100 * 1024 * 1024,
        heapTotal: 400 * 1024 * 1024,
        heapUsed: 400 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      } as NodeJS.MemoryUsage);
    });

    const h = startMemoryWatchdog({
      readSwapMb: noSwap,
      intervalMs: 1000,
      limitMb: 12288,
      proactiveGcMb: 1920,
      gcCooldownMs: 0,
      forceGc,
      log,
    });

    vi.advanceTimersByTime(1000);
    const call = log.mock.calls.find((c) => String(c[0]).includes('proactive GC'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ rssMbBefore: 2500, rssMbAfter: 2100, reclaimedMb: 400 });
    // The load-bearing assertion: 400 (survivors), never 2000 (pre-GC heap).
    expect((call?.[1] as { heapUsedMb: number }).heapUsedMb).toBe(400);
    h.stop();
  });

  // WI-2145659 — the swap-blindness fix. The measured live case: :3070 worker
  // 3415868 held 1779 MB resident + 1210 MB swapped = 2989 MB committed, i.e. 93%
  // of its 3200 MB limit, while `process.memoryUsage().rss` reported 56%. It sat
  // below the warn line AND below the proactive-GC trigger, so it warned nothing,
  // was never GC'd, and could not recycle — unbounded and invisible.
  describe('committed memory = RSS + swap (WI-2145659)', () => {
    it('warns on a swapped process that RSS alone reports as healthy', () => {
      withRss(1779); // 56% of 3200 — comfortably under the 2400 warn line
      const log = vi.fn();
      const onTrip = vi.fn();
      const h = startMemoryWatchdog({
        readSwapMb: () => 1210, // 2989 MB committed — 93% of the limit
        intervalMs: 1000,
        warnMb: 2400,
        limitMb: 3200,
        onTrip,
        log,
      });

      vi.advanceTimersByTime(1000);
      const warn = log.mock.calls.find((c) => String(c[0]).includes('above soft threshold'));
      expect(warn).toBeDefined();
      // Both halves reported, so a reader sees the split instead of inferring it.
      expect(warn?.[1]).toMatchObject({ committedMb: 2989, rssMb: 1779, swapMb: 1210 });
      // Still under the recycle limit — this is the warn, not the trip.
      expect(onTrip).not.toHaveBeenCalled();
      h.stop();
    });

    it('recycles on committed memory crossing the limit, which RSS never reaches', () => {
      // RSS is pinned at 2000 for the whole test — 62% of the 3200 limit, never
      // crossing it. Only the swap term moves, which is the real shape: the
      // kernel pages growth out, so the process grows while `rss` looks flat.
      // Pre-fix this process could climb forever without warning or recycling.
      withRss(2000);
      // The first sample must land BELOW warnMb so `sawHealthySample` is set and
      // the EI-11522 born-over-budget guard does not suppress the later trip —
      // this is a process that GREW into the limit, which is the case that
      // legitimately recycles.
      let swap = 0;
      const onTrip = vi.fn();
      const h = startMemoryWatchdog({
        readSwapMb: () => swap,
        intervalMs: 1000,
        tripsToRecycle: 1,
        warnMb: 2400, // committed 2000 on sample 1 → healthy
        limitMb: 3200,
        onTrip,
        log: vi.fn(),
      });

      vi.advanceTimersByTime(1000); // committed 2000 — under the limit
      expect(onTrip).not.toHaveBeenCalled();

      swap = 1400; // committed 3400 — over the limit, with RSS unchanged
      vi.advanceTimersByTime(1000);
      expect(onTrip).toHaveBeenCalledTimes(1);
      expect(onTrip.mock.calls[0][0]).toMatchObject({
        committedMb: 3400,
        rssMb: 2000,
        swapMb: 1400,
        limitMb: 3200,
      });
      h.stop();
    });

    it('runs proactive GC on a swapped process that RSS keeps below the trigger', () => {
      withRss(1200); // under the 1920 trigger on RSS alone
      const log = vi.fn();
      const forceGc = vi.fn();
      const h = startMemoryWatchdog({
        readSwapMb: () => 800, // 2000 MB committed — over the trigger
        intervalMs: 1000,
        proactiveGcMb: 1920,
        limitMb: 3200,
        warnMb: 2400,
        forceGc,
        onTrip: vi.fn(),
        log,
      });

      vi.advanceTimersByTime(1000);
      expect(forceGc).toHaveBeenCalledTimes(1);
      const gc = log.mock.calls.find((c) => String(c[0]).includes('proactive GC'));
      // The RSS trio keeps its pre-fix meaning (1300+ records/worker/14h are read
      // as a time series); the committed trio is added beside it, not swapped in.
      expect(gc?.[1]).toMatchObject({
        rssMbBefore: 1200,
        committedMbBefore: 2000,
        committedMbAfter: 2000,
      });
      h.stop();
    });

    // The inversion this whole change is about: an unmeasurable value must never
    // read as a healthy one. On a host with no /proc the watchdog degrades to
    // exactly its pre-fix RSS-only behaviour rather than to a falsely-low
    // committed figure that would suppress the thresholds all over again.
    it('an UNMEASURABLE swap term (-1) degrades to RSS-only, never to a zero it did not measure', () => {
      withRss(2600);
      const log = vi.fn();
      const h = startMemoryWatchdog({
        readSwapMb: () => -1,
        intervalMs: 1000,
        warnMb: 2400,
        limitMb: 3200,
        onTrip: vi.fn(),
        log,
      });

      vi.advanceTimersByTime(1000);
      const warn = log.mock.calls.find((c) => String(c[0]).includes('above soft threshold'));
      expect(warn?.[1]).toMatchObject({ committedMb: 2600, rssMb: 2600, swapMb: -1 });
      h.stop();
    });

    it('exposes committedMb() on the handle alongside rssMb()', () => {
      withRss(500);
      const h = startMemoryWatchdog({
        readSwapMb: () => 250,
        intervalMs: 1000,
        onTrip: vi.fn(),
        log: vi.fn(),
      });
      expect(h.rssMb()).toBe(500);
      expect(h.committedMb()).toBe(750);
      h.stop();
    });
  });
});

describe('readSelfSwapMb', () => {
  it('returns a non-negative MiB figure or -1, never NaN', () => {
    const v = readSelfSwapMb();
    expect(Number.isInteger(v)).toBe(true);
    expect(v === -1 || v >= 0).toBe(true);
  });
});

describe('resolveMemoryWatchdogLimitMb (EI-1613 — role-aware RSS default)', () => {
  // Always pass an explicit env WITHOUT VITEST: backgroundWorkersEnabled reads
  // the PASSED env, and would short-circuit to false (request role) under VITEST.
  const bg = (over: Record<string, string> = {}) =>
    ({ PAPERCUSP_BACKGROUND_WORKERS: '1', ...over }) as unknown as NodeJS.ProcessEnv;
  const req = (over: Record<string, string> = {}) =>
    ({ PAPERCUSP_BACKGROUND_WORKERS: '0', ...over }) as unknown as NodeJS.ProcessEnv;

  it('the background primary (BG=1) defaults to 12288 — the substrate footprint, not the 3200 that froze bg-host', () => {
    expect(resolveMemoryWatchdogLimitMb(bg())).toBe(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND);
    expect(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND).toBe(12288);
  });

  it('a request-only worker (BG=0) keeps the lighter 3200 default', () => {
    expect(resolveMemoryWatchdogLimitMb(req())).toBe(MEMORY_WATCHDOG_LIMIT_MB_REQUEST);
    expect(MEMORY_WATCHDOG_LIMIT_MB_REQUEST).toBe(3200);
  });

  it('the desktop dev operator (:3270, BG=0) gets the measured working-set tier', () => {
    expect(resolveMemoryWatchdogLimitMb(req({ PAPERCUSP_HONO_PORT: '3270' }))).toBe(MEMORY_WATCHDOG_LIMIT_MB_DESKTOP);
    expect(MEMORY_WATCHDOG_LIMIT_MB_DESKTOP).toBe(16384);
  });

  it('a default operator host (no BG flag, not :3170) is a background primary → 12288', () => {
    expect(resolveMemoryWatchdogLimitMb({} as unknown as NodeJS.ProcessEnv)).toBe(12288);
  });

  // EI-19484864948547581: :3170 is request-only (BG=0) but its real born
  // working set (~5.5 GB, measured) is far heavier than a plain request
  // worker's 3200 default — that mismatch let the born-over-budget guard
  // suppress the recycle on every boot (10 of 10 observed). :3170 gets its
  // own STAGING tier instead of inheriting REQUEST.
  it('the :3170 staging operator is request-only but heavier than a plain request worker → its own STAGING tier', () => {
    expect(
      resolveMemoryWatchdogLimitMb({ PAPERCUSP_HONO_PORT: '3170' } as unknown as NodeJS.ProcessEnv),
    ).toBe(MEMORY_WATCHDOG_LIMIT_MB_STAGING);
    expect(MEMORY_WATCHDOG_LIMIT_MB_STAGING).toBe(10240);
  });

  it(':3170 STAGING tier only applies when BG is not otherwise forced on', () => {
    // An explicit PAPERCUSP_BACKGROUND_WORKERS=1 on :3170 (unusual, but
    // possible) still wins the substrate-sized 12288 — BACKGROUND is checked
    // before the port-based STAGING fallback.
    expect(
      resolveMemoryWatchdogLimitMb(
        bg({ PAPERCUSP_HONO_PORT: '3170' }) as unknown as NodeJS.ProcessEnv,
      ),
    ).toBe(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND);
  });

  it('BACKGROUND wins over the desktop port tier when :3270 explicitly enables background workers', () => {
    expect(
      resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_HONO_PORT: '3270' }) as unknown as NodeJS.ProcessEnv),
    ).toBe(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND);
  });

  it('an explicit PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB always wins, in either role', () => {
    expect(resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '5000' }))).toBe(5000);
    expect(resolveMemoryWatchdogLimitMb(req({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '5000' }))).toBe(5000);
  });

  it('falls back to the role default for a non-positive / non-numeric explicit limit', () => {
    expect(resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '0' }))).toBe(12288);
    expect(resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '-1' }))).toBe(12288);
    expect(resolveMemoryWatchdogLimitMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: 'nonsense' }))).toBe(12288);
  });
});

describe('resolveMemoryWatchdogProactiveGcMb (EI-20237116358190923)', () => {
  const bg = (over: Record<string, string> = {}) =>
    ({ PAPERCUSP_BACKGROUND_WORKERS: '1', ...over }) as unknown as NodeJS.ProcessEnv;
  const req = (over: Record<string, string> = {}) =>
    ({ PAPERCUSP_BACKGROUND_WORKERS: '0', ...over }) as unknown as NodeJS.ProcessEnv;

  it('keeps the background proactive-GC trigger at its role tier when the recycle backstop is raised', () => {
    expect(
      resolveMemoryWatchdogProactiveGcMb(bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '32768' })),
    ).toBe(MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND);
  });

  it('keeps request-worker proactive GC at its role tier when the recycle backstop is raised', () => {
    expect(
      resolveMemoryWatchdogProactiveGcMb(req({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '12288' })),
    ).toBe(MEMORY_WATCHDOG_PROACTIVE_GC_MB_REQUEST);
  });

  it('selects desktop and staging proactive-GC tiers by port', () => {
    expect(resolveMemoryWatchdogProactiveGcMb(req({ PAPERCUSP_HONO_PORT: '3270' }))).toBe(
      MEMORY_WATCHDOG_PROACTIVE_GC_MB_DESKTOP,
    );
    expect(resolveMemoryWatchdogProactiveGcMb(req({ PAPERCUSP_HONO_PORT: '3170' }))).toBe(
      MEMORY_WATCHDOG_PROACTIVE_GC_MB_STAGING,
    );
  });

  it('honors an explicit proactive-GC threshold override without coupling it to the recycle limit', () => {
    expect(
      resolveMemoryWatchdogProactiveGcMb(
        bg({ PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '32768', PAPERCUSP_MEMORY_PROACTIVE_GC_MB: '6000' }),
      ),
    ).toBe(6000);
  });

  it('falls back to the role tier for a non-positive or invalid proactive-GC override', () => {
    expect(resolveMemoryWatchdogProactiveGcMb(bg({ PAPERCUSP_MEMORY_PROACTIVE_GC_MB: '0' }))).toBe(
      MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND,
    );
    expect(resolveMemoryWatchdogProactiveGcMb(bg({ PAPERCUSP_MEMORY_PROACTIVE_GC_MB: 'nope' }))).toBe(
      MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND,
    );
  });
});
