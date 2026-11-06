/**
 * The green-checkpoint gate's SCHEDULE — the cron it is seeded with, the fire period
 * that cron implies, and the margin its run budget must leave against that period.
 *
 * WHY THIS IS ITS OWN FILE (WI-39841 follow-on). The cron used to be a bare string
 * literal repeated at every site that seeds the routine, plus a fourth copy exported
 * from `harness/routines/release-actions.ts` for the phase invariant to check. That is
 * the exact mirror-drift shape WI-39841 was filed about, one level up: the invariant
 * test reads the EXPORTED constant, so editing a seed site alone leaves the guard green
 * while the real schedule diverges — and the phase collision the guard exists to catch
 * comes straight back.
 *
 * It cannot live in `release-actions.ts` because that module calls
 * `registerSystemAction()` at import time (green-checkpoint, release-trigger). The seed
 * scripts run standalone under `tsx`; importing 2.5k lines of run orchestration and
 * registering two system actions as a side effect, to read one string, is not a trade
 * worth making. So the schedule facts live HERE, in a leaf with no imports at all, and
 * everything that needs them — seeders, retrofit, the invariant test — depends on this
 * file and nothing else.
 *
 * The run BUDGET lives here too, for the same reason and one better. It used to sit in
 * `release-actions.ts` and be HAND-MIRRORED into three other files — `MANUAL_CHECKPOINT_
 * WATCHDOG_MS`, `MIN_MANUAL_SELF_WATCHDOG_MS`, `SUITE_KILL_BUDGET_MIRROR_MS` — each
 * carrying a comment saying it was copied because importing the canonical module would
 * register two system actions as a side effect. That reason was real and is now gone: a
 * leaf with no imports can be depended on from anywhere, including a gate script running
 * standalone under `tsx` in an isolated checkout. So those three are DERIVED now, not
 * copied (and WI-6554700010042457 later DELETED `SUITE_KILL_BUDGET_MIRROR_MS` along with
 * the run-level kill it mirrored), and `release-timing-invariants.test.ts` no longer has to detect a drift that
 * can no longer happen. What it still checks is the part that is a real decision: the
 * ORDERING of the four different numbers in the chain, and the phase relation below.
 */

/**
 * The operator-home cron derived from its install slug. Every seed site calls
 * `greenCheckpointCronForInstall()` with the row's own install slug instead of
 * copying this value, so independent pots spread their hourly fires across the
 * hour instead of stampeding the host-wide materialization barrier.
 * `seed-hive-release-routines.ts`, `apps/operator/lib/release/seed-release-routines.ts`,
 * and `apps/operator/lib/release/retrofit-hive-to-gate.ts`. Hourly at :15, offset from
 * git-sync's every-10-minute ticks.
 *
 * ⚠ Not every routine firing at `0 15 * * * *` is THIS routine. `autoloop-release-readiness-monitor`
 * (seed-autoloop-release-readiness-routine.ts) independently chose the same slot to sit
 * clear of telemetry-retention/hive-canary/cargo-test, and is deliberately NOT wired to
 * this constant — coupling it would mean retuning the gate silently moved an unrelated
 * monitor. Match on the routine NAME before assuming a literal is a copy of this one.
 */
export function greenCheckpointCronForInstall(installSlug: string): string {
  // A position-weighted UTF-8 byte sum is deliberately mirrored in migration
  // 976 so existing rows and future re-seeds converge on the same schedule.
  const bytes = new TextEncoder().encode(installSlug);
  const secondOfHour = bytes.reduce(
    (sum, byte, index) => (sum + byte * (index + 1)) % 3_600,
    0,
  );
  return `${secondOfHour % 60} ${Math.floor(secondOfHour / 60)} * * * *`;
}

export const GREEN_CHECKPOINT_CRON = greenCheckpointCronForInstall('papercusp');

/** The fire period `GREEN_CHECKPOINT_CRON` implies — one hour. */
export const GREEN_CHECKPOINT_FIRE_PERIOD_MS = 60 * 60_000;

/**
 * Minimum gap the suite timeout must leave between a deadline-kill and the next
 * scheduled fire, so the lock is demonstrably free when that fire lands.
 *
 * The slack it is compared against is `(period - (timeout % period)) % period`, and the
 * OUTER modulo is load-bearing: at a timeout that is an exact multiple of the period,
 * `timeout % period === 0` and `period - 0` reads as a FULL period of slack when the
 * truth is zero — the boundary lands epsilon inside the run, which is precisely the
 * refused fire WI-39841 measured. See `release-timing-invariants.test.ts`, which keeps
 * the old 120m value as a permanent control so a "simplification" of that expression
 * fails there instead of in production.
 */
export const GREEN_CHECKPOINT_PHASE_MARGIN_MS = 5 * 60_000;

/**
 * Compatibility duration for explicit bounded validation and the manual launcher's
 * idle/no-progress policy. Main-greening scheduled and detached qualification runs
 * have no aggregate execution-age cutoff (WI-6554700010042457/5611).
 *
 * The former 115m parent < 180m self-watchdog < 185m reaper < 190m stale-lock
 * chain is historical, not an execution-lifetime contract. Progress and verified
 * process custody now determine retention/recovery; test and worker bounds remain.
 * Bounded callers still use this duration and retain the five-minute cron phase
 * margin asserted in release-timing-invariants.test.ts. Do not apply that bound
 * to an owned qualification or recreate the removed parent/OS fuse.
 */
export const GREEN_CHECKPOINT_SUITE_TIMEOUT_MS = 115 * 60_000;

/**
 * Escalation grace for explicitly bounded callers. The manual launcher also uses
 * suite duration + grace as its idle policy; neither value is a main-greening
 * execution-age ceiling or a request deadline for detached qualification children.
 */
export const GREEN_CHECKPOINT_SIGKILL_GRACE_MS = 15_000;
