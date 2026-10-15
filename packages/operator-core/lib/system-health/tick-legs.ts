/**
 * tick-legs.ts: per-leg timing for the system-health tick (EI-25221129396992808).
 *
 * The system-health tick awaits ~30 independent legs: hive resolution, about 20 collectors, the
 * ack sweep, history, the governor snapshot and the sync invalidations. None of them has a
 * deadline, and the tick is single-flighted per workspace (`dedupeInFlight`), so ONE hung leg
 * holds the whole tick. Every later 30s fire then joins the same promise or is swallowed by the
 * scheduler's re-entrancy guard, no new `evaluatedAt` is written, and the stale-snapshot alarm
 * fires. That alarm can only say "the snapshot is stale". It cannot name the leg, and in this
 * incident the alert text pointed at an unrelated component.
 *
 * This module records which legs were started, which settled, and how long each took. Two reports
 * come from it:
 *   - while a tick is still in flight past `inFlightWarnMs`, log the legs that have NOT settled
 *     (the hung one is among them, usually alone);
 *   - when a tick finishes slower than `slowTickMs`, log its slowest legs.
 *
 * When NO leg is unsettled the tick is blocked on an await that is not wrapped in a leg. The
 * in-flight report then names the leg that settled last and how long ago, so the unwrapped await
 * locates itself as "the code right after <label>". (Observed 2026-10-06 20:52-20:56Z: a 276s tick
 * logged "unsettled legs: (none)" at 60s and 180s, which said nothing about where it was.)
 *
 * Deliberately observation-only: it adds no timeout and changes no control flow. Choosing a bound
 * (a per-leg deadline versus releasing the single-flight slot) needs a MEASURED slow leg first;
 * this is the instrument that produces that measurement.
 */

export interface LegTiming {
  label: string;
  ms: number;
}

export interface TickLegTracker {
  /** Time one named leg. Returns the same settled value or rejection; never alters it. `work` is
   *  invoked synchronously (no microtask deferral), exactly as an unwrapped call would be. */
  leg<T>(label: string, work: () => Promise<T> | T): Promise<T>;
  /** Legs started but not yet settled, longest-running first. */
  pending(): LegTiming[];
  /** Settled legs, slowest first, at most `n`. */
  slowest(n: number): LegTiming[];
  /** While no leg is unsettled: the leg that settled most recently (`label: ''` if none has
   *  settled yet) and how long ago, measured from tracker creation when none has. `null` while
   *  any leg is still running. */
  idle(): LegTiming | null;
}

/** Tracker for callers that do not instrument (every non-tick caller of computeSystemHealth). */
export const NOOP_TICK_LEGS: TickLegTracker = {
  leg: async (_label, work) => work(),
  pending: () => [],
  slowest: () => [],
  idle: () => null,
};

export function createTickLegTracker(now: () => number = Date.now): TickLegTracker {
  const started = new Map<string, number>();
  const settled: LegTiming[] = [];
  const createdAt = now();
  let lastSettled: { label: string; at: number } | null = null;
  return {
    leg<T>(label: string, work: () => Promise<T> | T): Promise<T> {
      const t0 = now();
      started.set(label, t0);
      const done = (): void => {
        started.delete(label);
        const at = now();
        settled.push({ label, ms: at - t0 });
        lastSettled = { label, at };
      };
      let p: Promise<T>;
      try {
        p = Promise.resolve(work());
      } catch (e) {
        done();
        return Promise.reject(e);
      }
      return p.then(
        (v) => {
          done();
          return v;
        },
        (e: unknown) => {
          done();
          throw e;
        },
      );
    },
    pending(): LegTiming[] {
      const t = now();
      return [...started.entries()]
        .map(([label, t0]) => ({ label, ms: t - t0 }))
        .sort((a, b) => b.ms - a.ms);
    },
    slowest(n: number): LegTiming[] {
      return [...settled].sort((a, b) => b.ms - a.ms).slice(0, n);
    },
    idle(): LegTiming | null {
      if (started.size > 0) return null;
      const t = now();
      return lastSettled
        ? { label: lastSettled.label, ms: t - lastSettled.at }
        : { label: '', ms: t - createdAt };
    },
  };
}

export function formatLegs(legs: LegTiming[]): string {
  return legs.length === 0 ? '(none)' : legs.map((l) => `${l.label}=${l.ms}ms`).join(', ');
}

/** The in-flight report's leg clause. With nothing unsettled, say where the tick is instead of
 *  just "(none)": after which leg, or before the first one. */
export function formatInFlight(legs: TickLegTracker): string {
  const pending = legs.pending();
  if (pending.length > 0) return formatLegs(pending);
  const idle = legs.idle();
  if (!idle) return '(none)';
  return idle.label
    ? `(none; blocked outside any leg for ${idle.ms}ms since ${idle.label} settled)`
    : `(none; no leg has settled yet, ${idle.ms}ms into the tick)`;
}

/** A tick slower than this logs its slowest legs. Normal ticks measure ~2s. */
export const SLOW_TICK_MS = 20_000;
/** A tick still running after this logs its unsettled legs, then again at 2x, 4x, ... */
export const IN_FLIGHT_WARN_MS = 60_000;

export interface WatchTickOptions {
  now?: () => number;
  log?: (msg: string) => void;
  setTimer?: (cb: () => void, ms: number) => { clear: () => void };
  slowTickMs?: number;
  inFlightWarnMs?: number;
}

function defaultSetTimer(cb: () => void, ms: number): { clear: () => void } {
  const t = setTimeout(cb, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
}

/**
 * Run one tick under a fresh leg tracker and report a slow or still-running tick. Returns the
 * tick's own result or rejection unchanged. The in-flight timer is one-shot and re-armed at a
 * doubling delay, so a tick wedged for an hour logs about six lines, not one per interval.
 */
export async function watchTick<T>(
  label: string,
  run: (legs: TickLegTracker) => Promise<T>,
  opts: WatchTickOptions = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const slowTickMs = opts.slowTickMs ?? SLOW_TICK_MS;
  const legs = createTickLegTracker(now);
  const startedAt = now();
  let timer: { clear: () => void } | null = null;
  let finished = false;
  const arm = (delayMs: number): void => {
    timer = setTimer(() => {
      if (finished) return;
      log(
        `[system-health] tick ${label} still in flight after ${now() - startedAt}ms; ` +
          `unsettled legs: ${formatInFlight(legs)}`,
      );
      arm(delayMs * 2);
    }, delayMs);
  };
  arm(opts.inFlightWarnMs ?? IN_FLIGHT_WARN_MS);
  const finish = (outcome: string): void => {
    finished = true;
    (timer as { clear: () => void } | null)?.clear();
    const total = now() - startedAt;
    if (total >= slowTickMs) {
      log(`[system-health] slow tick ${label} ${outcome} after ${total}ms; slowest legs: ${formatLegs(legs.slowest(5))}`);
    }
  };
  try {
    const result = await run(legs);
    finish('completed');
    return result;
  } catch (e) {
    finish('failed');
    throw e;
  }
}
