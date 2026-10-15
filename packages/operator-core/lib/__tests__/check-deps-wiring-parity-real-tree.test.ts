/**
 * check-deps-wiring-parity-real-tree.test.ts — the WIRING that puts
 * `lint:deps-wiring-parity` on a blocking path (WI-1728261, 2026-08-31).
 *
 * Its sibling `check-deps-wiring-parity.test.ts` proves the DETECTOR works, but runs it
 * over synthetic fixtures — "proves the detector works, runs it over nothing", the exact
 * shape check-lint-guard-reachability flags as a guard that enforces on no path. This
 * test EXECUTES the guard over the real tree in `--fail` mode, which is what classifies
 * it as BLOCKING (the ENFORCING_TEST_RE discriminator: it spawns the script over the
 * repo root).
 *
 * `--fail` blocks on NEW findings only: the 44 findings / 33 distinct rows that existed
 * when it was wired live in its SHRINK-ONLY FAIL_BASELINE (see the script). Wiring it
 * unbaselined would have red-pinned the fleet on debt that accrued over the entire
 * period the check did not exist — the rot mode the reachability meta-guard documents.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/**
 * Budget for ONE guard run, and the vitest timer for every test here. A full-tree scan
 * measured 56.6s wall at load average ~355 on the 128-core dev box (2026-10-13,
 * WI-6554700010009462); CI ran this file in 115-183s. The subprocess always had a 180s
 * budget, but each `it` ran under vitest's 60s default, which made that budget dead code:
 * the file went red by "Test timed out in 60000ms" with every assertion intact. The two
 * budgets are now one number, plus headroom for spawn and output parsing.
 */
const GUARD_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = GUARD_TIMEOUT_MS + 30_000;

function runGuard(args: string[]): { stdout: string; exitCode: number } {
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('node', ['scripts/check-deps-wiring-parity.mjs', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: GUARD_TIMEOUT_MS,
    });
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; stdout?: string };
    // A guard killed by a signal (its timeout, or an external kill) produced no verdict.
    // Mapping that to exit 1 used to report a TIMEOUT as "guard reported NEW divergence".
    if (err.status === null || err.status === undefined) {
      throw new Error(
        `check-deps-wiring-parity did not finish (signal ${err.signal ?? 'unknown'}, budget ` +
          `${GUARD_TIMEOUT_MS}ms): this is a timeout, not a divergence. Partial output:\n${err.stdout ?? ''}`,
      );
    }
    exitCode = err.status;
    stdout = err.stdout ?? '';
  }
  return { stdout, exitCode };
}

describe('lint:deps-wiring-parity over the real tree (blocking wiring)', { timeout: TEST_TIMEOUT_MS }, () => {
  // ONE full-tree scan, shared by the three whole-tree assertions. `--fail` changes only
  // the exit code (`if (opts.fail && newFindings.length > 0) process.exit(1)` in the
  // script); the "examined N files" line and the STALE-row warning print in both modes.
  // Scanning the whole tree three times measured nothing new and tripled the runtime.
  let fullTree: { stdout: string; exitCode: number } = { stdout: '', exitCode: -1 };
  beforeAll(() => {
    fullTree = runGuard(['--fail']);
  }, TEST_TIMEOUT_MS);

  it('finds no NEW deps-seam divergence beyond the shrink-only baseline', () => {
    const { stdout, exitCode } = fullTree;

    // Exit 2 = EXIT_NOT_CHECKED (zero candidate files) — a scan that examined nothing
    // must never read as a clean bill of health, so fail loudly rather than pass.
    expect(stdout).not.toContain('NOT CHECKED');
    expect(exitCode, `guard reported NEW divergence:\n${stdout}`).toBe(0);
  });

  it('actually examined the tree — a guard measuring nothing is not a passing guard', () => {
    const { stdout } = fullTree;
    const examined = /examined (\d+) files/.exec(stdout);
    expect(examined, `no "examined N files" line in:\n${stdout}`).not.toBeNull();
    expect(Number(examined![1])).toBeGreaterThan(1000);
  });

  /**
   * The regression this whole guard exists for, asserted against the LIVE tree rather
   * than a fixture: Scout's two production entry points must wire `ScoutCycleDeps`
   * identically. If someone drops a seam from either one, this fails by name.
   */
  it('keeps Scout’s two entry points wired identically (the defect that has recurred 4x)', () => {
    const { stdout, exitCode } = runGuard([
      '--fail',
      '--files=packages/operator-core/lib/scout/run.ts,' +
        'packages/operator-core/lib/scout/scout-cycle-action.ts,' +
        'packages/operator-core/lib/blueprint-steps/ops/scout-cycle.ts',
    ]);
    expect(stdout).not.toContain('ScoutCycleDeps');
    expect(exitCode, `ScoutCycleDeps diverged again:\n${stdout}`).toBe(0);
  });

  it('reports stale baseline rows so the baseline can only shrink', () => {
    const { stdout } = fullTree;
    // A stale row means a recorded divergence was fixed; the guard must SAY so, or the
    // baseline silently accumulates rows that no longer correspond to anything.
    if (stdout.includes('STALE baseline row')) {
      expect(stdout).toContain('prune from FAIL_BASELINE');
    }
  });

  it('keeps the disposable phase-I drill exempt from managed roster readers', () => {
    const { stdout, exitCode } = runGuard([
      '--fail', '--json',
      '--files=packages/operator-core/lib/harness/git-sync/run-git-sync.ts,' +
        'packages/operator-core/lib/harness/git-sync/git-sync-action.ts,' +
        'packages/operator-core/lib/sync/pot-git/physical-drill-phase-i.ts',
    ]);
    const report = JSON.parse(stdout);
    // This scope contains an actually stale row. JSON.parse must succeed even
    // when plain output would append a human-readable stale-baseline warning.
    expect(report.staleBaseline.length).toBeGreaterThan(0);
    const drill = report.findings.find((finding: { file: string; interface: string }) =>
      finding.file.endsWith('/physical-drill-phase-i.ts') && finding.interface === 'RunGitSyncOpts');
    // Calibrate on the real omission: a scan that missed the drill cannot prove its exemption.
    expect(drill?.missing).toContain('loadMigrationFenceRoster');
    expect(report.newFindings, stdout).toEqual([]);
    expect(exitCode, stdout).toBe(0);
  });

  it('keeps goal-report persistence and fleet-cue body rendering scoped to their producers', () => {
    const { stdout, exitCode } = runGuard([
      '--fail', '--json',
      '--files=packages/operator-core/lib/agent-tools/coordination/messages.ts,' +
        'packages/operator-core/lib/agent-tools/coordination/tools/send.ts,' +
        'packages/operator-core/lib/agent-tools/fleet_registry/control-core.ts',
    ]);
    const report = JSON.parse(stdout);
    const send = report.findings.find((finding: { file: string; interface: string }) =>
      finding.file.endsWith('/coordination/tools/send.ts') && finding.interface === 'SendOptions');
    const cue = report.findings.find((finding: { file: string; interface: string }) =>
      finding.file.endsWith('/fleet_registry/control-core.ts') && finding.interface === 'SendOptions');
    // Preserve the measured asymmetry; a scan that sees neither caller is not proof.
    expect(send?.missing).toEqual(['bodyWithMsgId']);
    expect(cue?.missing).toEqual(['persistEnvelope']);
    expect(report.newFindings, stdout).toEqual([]);
    expect(exitCode, stdout).toBe(0);
  });

  /**
   * The concatenated-key regression (WI-10002020). FAIL_BASELINE records ONE ROW PER
   * SEAM, but a finding carries the whole SET of seams a site omits. While the match
   * key was `${interface}|${file}|${missing.join(',')}` a row could only match a
   * finding omitting EXACTLY that one seam — so the day an unrelated seam
   * (`inTransaction`) was added to `WithPlanLockOpts`, every single-seam row stopped
   * matching at once, and the SAME divergence was reported twice, contradictorily:
   * NEW (rc=1, blocking the fleet gate) and STALE (prune it) in one run.
   *
   * The `plans/*` sites below each omit TWO seams that are baselined SEPARATELY, so
   * they are precisely the shape the old key could not match. Reverting BASELINE_SEAMS
   * to a seam-SET key turns all of them back into NEW findings and fails here.
   */
  it('matches single-seam baseline rows against a MULTI-seam finding (the concatenated-key regression)', () => {
    const scope = [
      'packages/operator-core/lib/agent-tools/plans/start.ts',
      'packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-drain-transition.ts',
      'packages/operator-core/lib/agent-tools/plans/add-decision.ts',
    ].join(',');
    const { stdout, exitCode } = runGuard(['--fail', `--files=${scope}`]);

    // CALIBRATION — this only tests anything while the scan still contains a site
    // omitting TWO OR MORE seams. If the tree loses that shape the assertion below
    // would pass for the wrong reason, so fail as UN-CALIBRATED instead.
    let maxSeamsAtOneSite = 0;
    let seamsHere = 0;
    for (const line of stdout.split('\n')) {
      if (line.includes('constructs `')) {
        maxSeamsAtOneSite = Math.max(maxSeamsAtOneSite, seamsHere);
        seamsHere = 0;
      } else if (line.includes('missing seam')) {
        seamsHere += 1;
      }
    }
    maxSeamsAtOneSite = Math.max(maxSeamsAtOneSite, seamsHere);
    expect(
      maxSeamsAtOneSite,
      `no multi-seam construction site left in scope — this guard is no longer calibrated ` +
        `and cannot detect the concatenated-key regression:\n${stdout}`,
    ).toBeGreaterThanOrEqual(2);

    const tally = /\((\d+) new, (\d+) baselined\)/.exec(stdout);
    expect(tally, `no "(N new, M baselined)" tally in:\n${stdout}`).not.toBeNull();
    expect(
      Number(tally![1]),
      `single-seam baseline rows stopped matching a multi-seam finding — the match key ` +
        `is a function of the seam SET again:\n${stdout}`,
    ).toBe(0);
    expect(Number(tally![2])).toBeGreaterThanOrEqual(4);
    expect(exitCode, stdout).toBe(0);
  });
});
