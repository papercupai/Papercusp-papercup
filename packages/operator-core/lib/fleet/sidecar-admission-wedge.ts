/**
 * Spawner-sidecar admission WEDGE breaker (WI-6554700010008488).
 *
 * MEASURED 2026-10-11 07:24-08:06Z: the spawner sidecar's org-admin postgres-js
 * pool stopped issuing queries. Its two pgbouncer clients sat `idle` with no
 * request for ~40 minutes while pgbouncer itself had zero waiting clients and
 * 110 idle servers, so every `boundedOrgTxn:begin(admin)` in the sidecar ran out
 * its 45s acquisition deadline and every git spawn the fleet routes through the
 * sidecar failed with `AdmissionPersistenceError`. git-sync committed nothing
 * for ~40 minutes. Killing the sidecar (bg-host respawns it) cleared it at once.
 * A graceful SIGTERM did NOT: shutdown waits for admission settlement, which
 * needs the same wedged pool.
 *
 * This breaker makes that recovery automatic. It watches the outcome of every
 * admission the sidecar attempts. A run of consecutive ACQUISITION-DEADLINE
 * failures, with no successful admission in between, spanning at least
 * `minSpanMs`, trips it once; the owner then exits the process so the host's
 * existing bounded respawn (spawner-sidecar-spawn.ts scheduleRespawn: backoff +
 * give-up budget) brings up a fresh process with a fresh pool.
 *
 * What it deliberately does NOT count:
 *   - non-deadline admission failures (validation, idempotency conflict, a SQL
 *     error): those are request faults, not a dead pool;
 *   - a deadline that is interleaved with any success: one slow admission on a
 *     loaded box is not a wedge. Any success resets the run.
 *
 * Root-cause note: a driver-level reservation fix for postgres-js landed
 * separately (patches/postgres+3.4.9.patch, EI-25667422637200991). This breaker
 * is the recurrence guard for the CLASS (any cause that leaves the sidecar's
 * pool unable to begin), not a fix for one mechanism.
 */

export interface AdmissionHealthObserver {
  recordSuccess(): void;
  recordFailure(error: unknown): void;
}

export interface AdmissionWedgeTrip {
  consecutiveDeadlines: number;
  firstDeadlineAtMs: number;
  lastDeadlineAtMs: number;
  /** The last deadline's label / pool, so the log names WHAT is wedged. */
  label: string | null;
  pool: string | null;
  reason: string;
}

export interface AdmissionWedgeBreakerOptions {
  /** Consecutive acquisition deadlines required to trip. Default 3. */
  threshold?: number;
  /** The run must span at least this long (first to last deadline). Default 90s. */
  minSpanMs?: number;
  now?: () => number;
  onTrip: (trip: AdmissionWedgeTrip) => void;
}

export const ADMISSION_WEDGE_DEFAULT_THRESHOLD = 3;
export const ADMISSION_WEDGE_DEFAULT_MIN_SPAN_MS = 90_000;

interface DeadlineShape {
  label: string | null;
  pool: string | null;
}

/**
 * Find a DbCallDeadlineError in an error's cause chain. Duck-typed on its
 * stable fields rather than `instanceof`, so a duplicated module record (the
 * tsx CJS/ESM split) cannot make a real deadline look like something else.
 * Bounded depth: a cyclic `cause` must not hang the sidecar.
 */
export function findAcquisitionDeadline(error: unknown): DeadlineShape | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (typeof current === 'object') {
      const candidate = current as {
        name?: unknown;
        label?: unknown;
        deadlineMs?: unknown;
        pool?: unknown;
        cause?: unknown;
      };
      if (
        candidate.name === 'DbCallDeadlineError' ||
        (typeof candidate.label === 'string' && typeof candidate.deadlineMs === 'number')
      ) {
        return {
          label: typeof candidate.label === 'string' ? candidate.label : null,
          pool: typeof candidate.pool === 'string' ? candidate.pool : null,
        };
      }
      current = candidate.cause;
      continue;
    }
    return null;
  }
  return null;
}

export function createAdmissionWedgeBreaker(options: AdmissionWedgeBreakerOptions): AdmissionHealthObserver & {
  readonly tripped: boolean;
  readonly consecutiveDeadlines: number;
} {
  const threshold = Math.max(1, Math.trunc(options.threshold ?? ADMISSION_WEDGE_DEFAULT_THRESHOLD));
  const minSpanMs = Math.max(0, options.minSpanMs ?? ADMISSION_WEDGE_DEFAULT_MIN_SPAN_MS);
  const now = options.now ?? Date.now;
  let consecutive = 0;
  let firstAt = 0;
  let tripped = false;

  return {
    get tripped() {
      return tripped;
    },
    get consecutiveDeadlines() {
      return consecutive;
    },
    recordSuccess() {
      consecutive = 0;
      firstAt = 0;
    },
    recordFailure(error: unknown) {
      const deadline = findAcquisitionDeadline(error);
      if (!deadline) return; // a request fault, not a pool that cannot begin
      const at = now();
      if (consecutive === 0) firstAt = at;
      consecutive += 1;
      if (tripped || consecutive < threshold || at - firstAt < minSpanMs) return;
      tripped = true;
      const spanSec = Math.round((at - firstAt) / 1000);
      options.onTrip({
        consecutiveDeadlines: consecutive,
        firstDeadlineAtMs: firstAt,
        lastDeadlineAtMs: at,
        label: deadline.label,
        pool: deadline.pool,
        reason:
          `${consecutive} consecutive admission acquisition deadlines over ${spanSec}s with no successful ` +
          `admission in between (last: "${deadline.label ?? 'unknown'}" on pool ${deadline.pool ?? 'unknown'}). ` +
          `This process's DB pool cannot begin a transaction; exiting so the host respawns a fresh one.`,
      });
    },
  };
}

/**
 * Exit code when the breaker trips. Any exit the host did not request makes it
 * respawn the sidecar (spawner-sidecar-spawn.ts scheduleRespawn, bounded by its
 * backoff + give-up budget); a distinct code makes the cause readable in the
 * host's "[spawner-sidecar] died (exit code N)" line. 75 is
 * SIDECAR_EXIT_SOCKET_IN_USE, which the host treats as deliberate: never reuse it.
 */
export const SIDECAR_EXIT_ADMISSION_WEDGED = 76;
/**
 * Graceful drain can itself wait on the wedged pool (measured 2026-10-11: a
 * SIGTERM'd wedged sidecar never finished), so the drain gets a hard cap.
 */
export const SIDECAR_ADMISSION_WEDGE_EXIT_GRACE_MS = 10_000;

export interface AdmissionWedgeExitDeps {
  pid: number;
  /** Start the owner's graceful shutdown (stop accepting work, abort, drain). */
  requestShutdown: (reason: string) => void;
  /** The code the owner's drained exit must use, so a clean drain still says why. */
  setDrainExitCode: (code: number) => void;
  exit: (code: number) => void;
  log?: (line: string) => void;
  graceMs?: number;
  /** Must keep the process alive until it fires (a ref'd timer): it is the exit guarantee. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/**
 * The trip action: name the wedge, mark the exit code, start a graceful drain,
 * and arm a hard exit in case that drain waits on the same dead pool. Idempotent
 * per handler (the breaker trips once, but a second call must not double-arm).
 */
export function createAdmissionWedgeExitHandler(deps: AdmissionWedgeExitDeps): (trip: AdmissionWedgeTrip) => void {
  const log = deps.log ?? ((line: string) => console.error(line));
  const graceMs = deps.graceMs ?? SIDECAR_ADMISSION_WEDGE_EXIT_GRACE_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let armed = false;
  return (trip) => {
    if (armed) return;
    armed = true;
    log(`[spawner-sidecar] pid ${deps.pid} ADMISSION WEDGE: ${trip.reason}`);
    deps.setDrainExitCode(SIDECAR_EXIT_ADMISSION_WEDGED);
    setTimer(() => {
      log(
        `[spawner-sidecar] pid ${deps.pid} drain did not finish within ${graceMs}ms after the admission wedge; ` +
          'exiting anyway',
      );
      deps.exit(SIDECAR_EXIT_ADMISSION_WEDGED);
    }, graceMs);
    deps.requestShutdown('admission-wedge');
  };
}

/**
 * Wrap an admission `begin` so every outcome feeds the observer. The observer
 * must never change the admission's own result: its errors are swallowed.
 */
export function observeAdmission<A extends unknown[], R>(
  begin: (...args: A) => Promise<R>,
  observer: AdmissionHealthObserver | undefined,
): (...args: A) => Promise<R> {
  if (!observer) return begin;
  return async (...args: A) => {
    let result: R;
    try {
      result = await begin(...args);
    } catch (error) {
      try {
        observer.recordFailure(error);
      } catch {
        /* the observer must never mask the admission failure */
      }
      throw error;
    }
    try {
      observer.recordSuccess();
    } catch {
      /* observer faults are not admission faults */
    }
    return result;
  };
}
