/**
 * Throttled per-test-case heartbeat for the test:file router (EI-26528263655722045).
 *
 * WHY: the router's progress-aware watchdog (scripts/lib/batch-watchdog.mjs) only extends a run
 * past its first deadline when the child produced output inside the stall window. Vitest's
 * `default` reporter in a non-TTY prints a file's results only when the FILE finishes, so a single
 * long file that is passing test after test emits nothing for its whole runtime. Measured
 * 2026-10-20: packages/operator-core/lib/mutation-probe-script.test.ts held capturedBytes at 1489
 * from start-up until the 600s reap (TEST_FILE_NOT_MEASURED), and an identical rerun under a
 * widened budget passed 157/157 in 699s. The watchdog was judging a healthy run as stalled.
 *
 * This reporter writes one short stderr line when a test case completes, at most once per
 * `intervalMs`. A real per-test signal is the right progress source: a run whose cases keep
 * completing gets extended, while a single hung case emits nothing and is still reaped by the
 * stall window. Throttling keeps the line count tiny (a 157-case, 700s file emits ~24 lines), so
 * it never approaches the router's capture ceiling.
 *
 * Vitest constructs a CLI-path reporter with no options; the constructor arguments exist only as
 * test seams.
 */
export const TEST_PROGRESS_HEARTBEAT_INTERVAL_MS = 30_000;
export const TEST_PROGRESS_HEARTBEAT_PREFIX = 'TEST_FILE_HEARTBEAT';

export default class TestProgressHeartbeatReporter {
  constructor({
    intervalMs = TEST_PROGRESS_HEARTBEAT_INTERVAL_MS,
    now = () => Date.now(),
    write = (line) => process.stderr.write(line),
  } = {}) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.write = write;
    this.completedCases = 0;
    this.lastEmitAt = null;
  }

  onTestCaseResult() {
    this.completedCases += 1;
    const at = this.now();
    if (this.lastEmitAt !== null && at - this.lastEmitAt < this.intervalMs) return;
    this.lastEmitAt = at;
    this.write(`${TEST_PROGRESS_HEARTBEAT_PREFIX} completedCases=${this.completedCases}\n`);
  }
}
