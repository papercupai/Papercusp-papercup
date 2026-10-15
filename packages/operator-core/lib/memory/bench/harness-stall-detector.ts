import fs from 'node:fs';

/**
 * Main-thread stall detector for timing benchmarks (plan
 * mdenseon-adoption-measurements-2026-10-01 D-010).
 *
 * A latency benchmark is only as good as its claim that the process under test
 * was RUNNING for the whole window. On this box the pc-heavy PSI admission
 * controller cooperatively freezes a heavy run's cgroup under memory pressure;
 * the P-007 v2 robustness runs were frozen mid-soak (harness sampler gaps of
 * 6.9s and 21.4s), and the frozen window surfaced as a soak latency "regression"
 * and a failed /healthz probe that the sidecar never caused.
 *
 * A timer gap alone cannot tell the two causes of a stall apart:
 *   - BUSY: the main thread was running (a synchronous block — a real defect of
 *     the code under test, e.g. inline inference on the event loop);
 *   - NOT SCHEDULED: the thread neither ran nor waited to run (frozen, stopped,
 *     or asleep in a synchronous syscall) — the measurement window is void.
 * The kernel's per-thread schedstat (run ns, run-queue wait ns) does: a frozen
 * task is not runnable, so neither counter advances, while a busy one accrues
 * run time and a CPU-starved one accrues wait time.
 */
export interface StallDetectorConfig {
  /** Timer cadence. */
  tickMs: number;
  /** A tick later than tickMs + stallMs is a stall. */
  stallMs: number;
  /** A stall whose (run + wait) is below this fraction of the gap is 'not-scheduled'. */
  scheduledFractionMin: number;
}
export const STALL_DETECTOR_DEFAULTS: StallDetectorConfig = { tickMs: 100, stallMs: 1000, scheduledFractionMin: 0.1 };

export type StallKind = 'not-scheduled' | 'starved' | 'busy';
export interface HarnessStall<P extends string = string> {
  /** Label current when the gap began / ended (a gap can straddle a boundary). */
  labelAtStart: P; label: P;
  /** Gap start, in the caller's clock (ms). */
  atMs: number;
  gapMs: number;
  /** Main-thread run time and run-queue wait within the gap; wait is null without schedstat. */
  runMs: number; waitMs: number | null;
  kind: StallKind;
}
export type ThreadTimeSource = 'schedstat' | 'thread-cpu';

interface ThreadTimes { runMs: number; waitMs: number | null }

/** Classify one gap. Pure: the tested decision. */
export function classifyStall(gapMs: number, runMs: number, waitMs: number | null,
  config: StallDetectorConfig = STALL_DETECTOR_DEFAULTS): StallKind | null {
  if (gapMs < config.tickMs + config.stallMs) return null;
  const scheduled = runMs + (waitMs ?? 0);
  if (scheduled < gapMs * config.scheduledFractionMin) return 'not-scheduled';
  return waitMs !== null && waitMs > runMs ? 'starved' : 'busy';
}

const SCHEDSTAT_PATH = '/proc/thread-self/schedstat';

function readSchedstat(): ThreadTimes | null {
  try {
    const [run, wait] = fs.readFileSync(SCHEDSTAT_PATH, 'utf8').trim().split(/\s+/).map(Number);
    return Number.isFinite(run) && Number.isFinite(wait) ? { runMs: run / 1e6, waitMs: wait / 1e6 } : null;
  } catch { return null; }
}

function threadCpu(): ThreadTimes {
  const u = process.threadCpuUsage();
  return { runMs: (u.user + u.system) / 1000, waitMs: null };
}

/**
 * Start sampling the CALLING thread. `label()` names the window a stall belongs
 * to (a benchmark phase); `now()` is the caller's clock so stalls align with
 * its samples. Call `stop()` to end sampling and read every stall recorded.
 */
export function startStallDetector<P extends string>(opts: { label: () => P; now: () => number;
  config?: Partial<StallDetectorConfig> }) {
  const config = { ...STALL_DETECTOR_DEFAULTS, ...opts.config };
  const source: ThreadTimeSource = readSchedstat() ? 'schedstat' : 'thread-cpu';
  const read = source === 'schedstat' ? () => readSchedstat() ?? threadCpu() : threadCpu;
  const stalls: HarnessStall<P>[] = [];
  let last = opts.now(), lastTimes = read(), lastLabel = opts.label(), running = true;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    const at = opts.now(), times = read(), label = opts.label(), gapMs = at - last;
    const runMs = times.runMs - lastTimes.runMs;
    const waitMs = times.waitMs === null || lastTimes.waitMs === null ? null : times.waitMs - lastTimes.waitMs;
    const kind = classifyStall(gapMs, runMs, waitMs, config);
    if (kind) stalls.push({ labelAtStart: lastLabel, label, atMs: last, gapMs, runMs, waitMs, kind });
    last = at; lastTimes = times; lastLabel = label;
    if (running) { timer = setTimeout(tick, config.tickMs); timer.unref?.(); }
  };
  timer = setTimeout(tick, config.tickMs); timer.unref?.();
  return {
    source, config,
    stop(): HarnessStall<P>[] {
      if (running) { running = false; clearTimeout(timer); tick(); }
      return stalls;
    },
  };
}
