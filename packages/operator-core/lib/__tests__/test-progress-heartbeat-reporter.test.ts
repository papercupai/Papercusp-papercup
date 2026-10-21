/**
 * EI-26528263655722045 — the test:file router's progress-aware watchdog extends a run only when the
 * child produced output inside its stall window. Vitest's default reporter prints nothing on a
 * non-TTY until a FILE finishes, so one long, passing file looked stalled and was reaped at the
 * 600s floor (measured: mutation-probe-script.test.ts, capturedBytes frozen at 1489 until the reap;
 * the same file passes 157/157 in ~700s). The router now retains a throttled per-test-case
 * heartbeat reporter. These cases pin (1) the reporter's throttle and (2) that the router's
 * reporter list carries it by default, at the path the real repository actually ships.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import TestProgressHeartbeatReporter, {
  TEST_PROGRESS_HEARTBEAT_INTERVAL_MS,
  TEST_PROGRESS_HEARTBEAT_PREFIX,
  // @ts-ignore — untyped .mjs reporter, imported by path like the router's sibling suites
} from '../../../../scripts/lib/test-progress-heartbeat-reporter.mjs';
import {
  REPO_ROOT,
  TEST_FILE_WATCHDOG_STALL_WINDOW_MS,
  withInjectedJsonReport,
  // @ts-ignore — untyped .mjs router, imported by path like its sibling suites
} from '../../../../scripts/test-files.mjs';

const HEARTBEAT_REL = 'scripts/lib/test-progress-heartbeat-reporter.mjs';

function recordingReporter(intervalMs = 30_000) {
  let clock = 0;
  const lines: string[] = [];
  const reporter = new TestProgressHeartbeatReporter({
    intervalMs,
    now: () => clock,
    write: (line: string) => lines.push(line),
  });
  return { reporter, lines, advance: (ms: number) => { clock += ms; } };
}

describe('TestProgressHeartbeatReporter — a per-test progress signal the watchdog can see', () => {
  it('emits on the first completed case, then at most once per interval', () => {
    const { reporter, lines, advance } = recordingReporter(30_000);
    reporter.onTestCaseResult();
    expect(lines).toEqual([`${TEST_PROGRESS_HEARTBEAT_PREFIX} completedCases=1\n`]);

    // 9 more cases inside the same 30s window: counted, not printed.
    for (let i = 0; i < 9; i++) { advance(3_000); reporter.onTestCaseResult(); }
    expect(lines).toHaveLength(1);

    advance(3_000); // 30s since the last emission
    reporter.onTestCaseResult();
    expect(lines).toEqual([
      `${TEST_PROGRESS_HEARTBEAT_PREFIX} completedCases=1\n`,
      `${TEST_PROGRESS_HEARTBEAT_PREFIX} completedCases=11\n`,
    ]);
  });

  it('stays silent when no case completes, so a hung case is still reaped', () => {
    const { reporter, lines, advance } = recordingReporter();
    reporter.onTestCaseResult();
    advance(10 * 60_000);
    expect(lines).toHaveLength(1);
  });

  it('beats well inside the watchdog stall window, so a progressing run is always extended', () => {
    // A run that completes a case at least every interval must produce output inside every stall
    // window; an interval at or above the window would reintroduce the false-stall reap.
    expect(TEST_PROGRESS_HEARTBEAT_INTERVAL_MS * 2).toBeLessThanOrEqual(TEST_FILE_WATCHDOG_STALL_WINDOW_MS);
  });
});

describe('withInjectedJsonReport — retains the heartbeat reporter for router runs', () => {
  const withHeartbeatFile = (run: (repoRoot: string, heartbeatPath: string) => void) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'heartbeat-reporter-'));
    const heartbeatPath = join(repoRoot, HEARTBEAT_REL);
    mkdirSync(join(repoRoot, 'scripts/lib'), { recursive: true });
    writeFileSync(heartbeatPath, 'export default class Reporter {}');
    try {
      run(repoRoot, heartbeatPath);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  };

  it('adds it by default beside the injected human + json reporters', () => {
    withHeartbeatFile((repoRoot, heartbeatPath) => {
      const { args } = withInjectedJsonReport([], '/tmp/r.json', { repoRoot, env: {} });
      expect(args).toEqual([
        '--reporter=default',
        '--reporter=json',
        `--reporter=${heartbeatPath}`,
        '--outputFile=/tmp/r.json',
      ]);
    });
  });

  it('adds it when the caller chose a machine reporter (the testing:run path)', () => {
    withHeartbeatFile((repoRoot, heartbeatPath) => {
      const chosen = ['--reporter=json', '--outputFile=/tmp/caller.json'];
      const { args } = withInjectedJsonReport(chosen, '/tmp/r.json', { repoRoot, env: {} });
      expect(args).toContain(`--reporter=${heartbeatPath}`);
      expect(args.filter((a: string) => a.startsWith('--outputFile'))).toEqual(['--outputFile=/tmp/caller.json']);
    });
  });

  it('omits it when explicitly disabled, and never duplicates a caller-selected copy', () => {
    withHeartbeatFile((repoRoot, heartbeatPath) => {
      const off = withInjectedJsonReport([], '/tmp/r.json', { repoRoot, env: {}, progressHeartbeat: false });
      expect(off.args.some((a: string) => a.includes('test-progress-heartbeat-reporter'))).toBe(false);

      const chosen = ['--reporter=default', `--reporter=${heartbeatPath}`];
      const again = withInjectedJsonReport(chosen, '/tmp/r.json', { repoRoot, env: {} });
      expect(again.args.filter((a: string) => a.includes('test-progress-heartbeat-reporter'))).toHaveLength(1);
    });
  });

  it('resolves to a file the real repository ships (a rename must not silently disable it)', () => {
    expect(existsSync(join(REPO_ROOT, HEARTBEAT_REL))).toBe(true);
  });
});
