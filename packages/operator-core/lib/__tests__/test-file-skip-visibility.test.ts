/**
 * EI-19380376466745152 — a SKIPPED assertion is an absent measurement wearing a pass.
 *
 * The incident these pin: an agent fixed a regression, ran the owning file, read
 * `Tests  8 passed | 1 skipped (9)` with exit 0, and filed it as proof. A peer had landed
 * `it.skip` on THE EXACT assertion being fixed six minutes earlier, so the fix was never
 * exercised by the evidence cited for it. Every signal in that run read as success.
 *
 * The countermeasure has three parts, and the middle one is load-bearing: a COUNT alone would not
 * have helped — the agent already had the count. What was missing was the skipped test's NAME,
 * which vitest's human reporter never prints.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateGroupResults,
  allSkippedVerdict,
  assertionOutcomesFromReport,
  callerChoseReporting,
  main,
  nonVerdictOptionFrom,
  parseCli,
  requireRanFrom,
  requireRanVerdict,
  testsSkippedFrom,
  withInjectedJsonReport,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — untyped .mjs router, imported by path like its sibling suites
} from '../../../../scripts/test-files.mjs';

describe('non-verdict Vitest options cannot manufacture a green router result', () => {
  it.each(['-h', '--help', '--help=api', '-v', '--version', '--version=short'])('recognizes %s', (option) => {
    expect(nonVerdictOptionFrom([option])).toBe(option);
  });

  it('ignores ordinary execution options', () => {
    expect(nonVerdictOptionFrom(['--run', '--reporter=json'])).toBeNull();
  });

  it.each(['--help', '--version'])('refuses %s before route discovery or child execution', async (option) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await main([
        'packages/operator-core/lib/harness/routines/hive-release-env.integration.test.ts',
        option,
      ]);
      expect(code).toBe(2);
      const output = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('TEST_FILE_NOT_MEASURED');
      expect(output).toContain('reason=non-verdict-option');
      expect(output).toContain(`option=${JSON.stringify(option)}`);
      expect(output).not.toContain('TEST_FILE_RESULT');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('testsSkippedFrom — three-state, because an unreadable row must not read as "nothing skipped"', () => {
  it('reads the skipped segment of a mixed summary row', () => {
    expect(testsSkippedFrom('      Tests  4 passed | 1 skipped (5)')).toBe(1);
  });

  it('counts todo as not-executed too — collected, deliberately not run', () => {
    expect(testsSkippedFrom('      Tests  1 passed | 2 todo (3)')).toBe(2);
  });

  it('sums several not-executed segments', () => {
    expect(testsSkippedFrom('      Tests  1 passed | 2 skipped | 3 todo (6)')).toBe(5);
  });

  it('reports a MEASURED zero for an all-green row', () => {
    // Load-bearing: vitest omits a zero-valued segment rather than printing `0 skipped`. If this
    // returned null the field would read `unknown` on every ordinary green run, and a warning
    // that fires constantly is a warning nobody reads.
    expect(testsSkippedFrom('      Tests  8 passed (8)')).toBe(0);
  });

  it('returns null — not 0 — when there is no summary row at all', () => {
    expect(testsSkippedFrom('some unrelated output')).toBeNull();
  });

  it('strips ANSI first, because vitest colourises this row', () => {
    // EI-18819483316574031 is this same file's previous instance of exactly this trap: a matcher
    // that skipped the strip passed every hand-written test and never once fired on real output.
    const ESC = '\x1b';
    const coloured =
      `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m4 passed${ESC}[39m${ESC}[22m` +
      ` | ${ESC}[33m1 skipped${ESC}[39m (5)`;
    // The fixture is only meaningful if it genuinely carries the control byte: a '\\x1b' typo
    // would make this whole case vacuous while staying green.
    expect(coloured.includes(ESC)).toBe(true);
    expect(ESC.charCodeAt(0)).toBe(27);
    expect(testsSkippedFrom(coloured)).toBe(1);
  });

  it('reads the LAST summary row, so appended output cannot resurrect a superseded one', () => {
    expect(testsSkippedFrom('      Tests  9 skipped (9)\n...\n      Tests  4 passed | 1 skipped (5)')).toBe(1);
  });

  it('treats "no tests" as a measured zero', () => {
    expect(testsSkippedFrom('      Tests  no tests')).toBe(0);
  });
});

describe('assertionOutcomesFromReport — the NAMES, which exist nowhere else', () => {
  const withReport = (body: unknown, run: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'skip-visibility-'));
    try {
      const path = join(dir, 'report.json');
      writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const report = {
    testResults: [
      {
        name: '/repo/lib/voice-prefs.test.ts',
        assertionResults: [
          { status: 'passed', fullName: 'voice defaults keeps PTT as the default' },
          { status: 'failed', fullName: 'voice defaults ships channel-voice defaults' },
          { status: 'skipped', fullName: 'voice-prefs (PG-backed) migrated to PG' },
          { status: 'todo', fullName: 'voice-prefs writes a preference' },
        ],
      },
    ],
  };

  it('splits executed (passed+failed) from collected-but-not-run, keeping full names', () => {
    withReport(report, (path) => {
      const outcomes = assertionOutcomesFromReport(path, '/repo');
      expect(outcomes?.executed).toEqual([
        'voice defaults keeps PTT as the default',
        'voice defaults ships channel-voice defaults',
      ]);
      expect(outcomes?.skipped.map((s: { name: string }) => s.name)).toEqual([
        'voice-prefs (PG-backed) migrated to PG',
        'voice-prefs writes a preference',
      ]);
      expect(outcomes?.skipped[0].file).toBe('/repo/lib/voice-prefs.test.ts');
    });
  });

  it('returns null — never an empty result — for an unreadable report', () => {
    // The distinction IS the guard: null degrades to "names unavailable", while an empty result
    // would render as the reassuring, wrong "nothing was skipped".
    expect(assertionOutcomesFromReport(null, '/repo')).toBeNull();
    expect(assertionOutcomesFromReport('/nope/missing.json', '/repo')).toBeNull();
    withReport('{ not json', (path) => expect(assertionOutcomesFromReport(path, '/repo')).toBeNull());
    withReport({ numTotalTests: 3 }, (path) => expect(assertionOutcomesFromReport(path, '/repo')).toBeNull());
  });
});

describe('withInjectedJsonReport — a private report, without stealing stdout from a human', () => {
  const withReporterFiles = (
    names: string[],
    run: (repoRoot: string, reporterPath: (name: string) => string) => void,
  ) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'injected-reporters-'));
    const reporterDir = join(repoRoot, 'libs/test-config/src');
    mkdirSync(reporterDir, { recursive: true });
    const reporterPath = (name: string) => join(reporterDir, `${name}-reporter.ts`);
    try {
      for (const name of names) writeFileSync(reporterPath(name), 'export default class Reporter {}');
      run(repoRoot, reporterPath);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  };

  it('adds a json reporter ALONGSIDE the default one', () => {
    // Verified against vitest 4.1.8 before this was written: `--reporter=default --reporter=json
    // --outputFile=<p>` keeps the human `Tests` row on stdout AND writes the report. Dropping
    // `--reporter=default` would replace stdout with JSON and break every human caller — which is
    // why this asserts its presence rather than just the outputFile.
    withReporterFiles([], (repoRoot) => {
      const { args, injectedReportPath } = withInjectedJsonReport(['--silent'], '/tmp/r.json', { repoRoot, env: {} });
      expect(args).toEqual(['--silent', '--reporter=default', '--reporter=json', '--outputFile=/tmp/r.json']);
      expect(injectedReportPath).toBe('/tmp/r.json');
    });
  });

  it('preserves the admin ledger reporter when injecting private JSON', () => {
    withReporterFiles(['admin-test-runs'], (repoRoot, reporterPath) => {
      const input = ['--silent'];
      const { args, injectedReportPath } = withInjectedJsonReport(input, '/tmp/r.json', { repoRoot, env: {} });
      expect(args).toEqual([
        '--silent',
        '--reporter=default',
        '--reporter=json',
        `--reporter=${reporterPath('admin-test-runs')}`,
        '--outputFile=/tmp/r.json',
      ]);
      expect(input).toEqual(['--silent']);
      expect(injectedReportPath).toBe('/tmp/r.json');
    });
  });

  it('retains the armed source-map reporter alongside the ledger reporter', () => {
    withReporterFiles(['admin-test-runs', 'executed-source-map'], (repoRoot, reporterPath) => {
      const { args } = withInjectedJsonReport([], '/tmp/r.json', {
        repoRoot,
        env: { PC_EXECUTED_SOURCE_MAP_WORKSPACE: ' @papercusp/operator-core ' },
      });
      expect(args).toEqual([
        '--reporter=default',
        '--reporter=json',
        `--reporter=${reporterPath('admin-test-runs')}`,
        `--reporter=${reporterPath('executed-source-map')}`,
        '--outputFile=/tmp/r.json',
      ]);
    });
  });

  it('honors ledger opt-out without disarming an independently armed source map', () => {
    withReporterFiles(['admin-test-runs', 'executed-source-map'], (repoRoot, reporterPath) => {
      const { args } = withInjectedJsonReport([], '/tmp/r.json', {
        repoRoot,
        env: { PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1', PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'operator-core' },
      });
      expect(args).not.toContain(`--reporter=${reporterPath('admin-test-runs')}`);
      expect(args).toContain(`--reporter=${reporterPath('executed-source-map')}`);
    });
  });

  it.each([undefined, '', '  '])('does not arm source mapping without a workspace (%s)', (workspace) => {
    withReporterFiles(['executed-source-map'], (repoRoot, reporterPath) => {
      const { args } = withInjectedJsonReport([], '/tmp/r.json', {
        repoRoot,
        env: { PC_EXECUTED_SOURCE_MAP_WORKSPACE: workspace },
      });
      expect(args).not.toContain(`--reporter=${reporterPath('executed-source-map')}`);
    });
  });

  it('tolerates missing reporter files even when source mapping was requested', () => {
    withReporterFiles([], (repoRoot) => {
      const { args } = withInjectedJsonReport([], '/tmp/r.json', {
        repoRoot,
        env: { PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'operator-core' },
      });
      expect(args).toEqual(['--reporter=default', '--reporter=json', '--outputFile=/tmp/r.json']);
    });
  });

  it.each(['default', 'verbose', 'dot'])('retains %s human output with private assertion and ledger reports', (reporter) => {
    withReporterFiles(['admin-test-runs', 'executed-source-map'], (repoRoot, reporterPath) => {
      for (const selected of [[`--reporter=${reporter}`], ['--reporter', reporter]]) {
        const input = ['--silent', ...selected];
        const { args, injectedReportPath } = withInjectedJsonReport(input, '/tmp/r.json', {
          repoRoot,
          env: { PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'operator-core' },
        });
        expect(args).toEqual([
          ...input,
          '--reporter=json',
          `--reporter=${reporterPath('admin-test-runs')}`,
          `--reporter=${reporterPath('executed-source-map')}`,
          '--outputFile=/tmp/r.json',
        ]);
        expect(injectedReportPath).toBe('/tmp/r.json');
        expect(input).toEqual(['--silent', ...selected]);
      }
    });
  });

  it('retains evidence with explicit reporters while preserving output formats and paths', () => {
    const chosenSets = [
      ['--reporter=json'],
      ['--reporter', 'json'],
      ['--reporter=junit'],
      ['--reporter=./custom-reporter.mjs'],
      ['--reporter=verbose', '--reporter=json'],
      ['--reporter=verbose', '--outputFile=/x.json'],
    ];
    withReporterFiles(['admin-test-runs', 'executed-source-map'], (repoRoot, reporterPath) => {
      for (const chosen of chosenSets) {
        expect(callerChoseReporting(chosen)).toBe(true);
        const { args, injectedReportPath } = withInjectedJsonReport(chosen, '/tmp/r.json', {
          repoRoot,
          env: { PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'operator-core' },
        });
        expect(args).toEqual([
          ...chosen,
          `--reporter=${reporterPath('admin-test-runs')}`,
          `--reporter=${reporterPath('executed-source-map')}`,
        ]);
        expect(injectedReportPath).toBeNull();
      }
    });
  });

  it.each([['--reporter'], ['--outputFile=/x.json'], ['--outputFile', '/x.json']])(
    'preserves a malformed reporter or outputFile-only config selection (%j)', (...chosen) => {
      withReporterFiles(['admin-test-runs'], (repoRoot) => {
        const result = withInjectedJsonReport(chosen, '/tmp/r.json', { repoRoot, env: {} });
        expect(result).toEqual({ args: chosen, injectedReportPath: null });
      });
    },
  );

  it('keeps one ledger reporter when the caller already selected its workspace wrapper', () => {
    withReporterFiles(['admin-test-runs'], (repoRoot) => {
      const chosen = ['--reporter=json', '--reporter=/workspace/test/reporters/admin-test-runs-reporter.ts'];
      expect(withInjectedJsonReport(chosen, '/tmp/r.json', { repoRoot, env: {} }))
        .toEqual({ args: chosen, injectedReportPath: null });
    });
  });

  it('honors evidence opt-out for a caller-owned JSON report', () => {
    withReporterFiles(['admin-test-runs', 'executed-source-map'], (repoRoot) => {
      const chosen = ['--reporter=json', '--outputFile=/x.json'];
      expect(withInjectedJsonReport(chosen, '/tmp/r.json', {
        repoRoot, env: { PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1' },
      })).toEqual({ args: chosen, injectedReportPath: null });
    });
  });

  it('is a no-op when no report path could be created — diagnostics never fail a real run', () => {
    const { args, injectedReportPath } = withInjectedJsonReport(['--silent'], null);
    expect(args).toEqual(['--silent']);
    expect(injectedReportPath).toBeNull();
  });
});

describe('--require-ran — turning "did my fix get exercised?" into a checked postcondition', () => {
  const outcomes = {
    executed: ['pays for the answer ONCE, not on all thirteen calls'],
    skipped: [{ name: 'voice-prefs (PG-backed) migrated to PG', file: '/repo/a.test.ts' }],
  };

  it('parses the =-form and lets the last one win', () => {
    expect(requireRanFrom(['--require-ran=alpha', 'file.test.ts', '--require-ran=beta'])).toBe('beta');
    expect(requireRanFrom(['--require-ran=', 'file.test.ts'])).toBeNull();
    expect(requireRanFrom(['file.test.ts'])).toBeNull();
  });

  it('does not swallow the file list — the option must not read as the first vitest arg', () => {
    // parseCli stops collecting its own args at the first `-`-prefixed token. A new own-option
    // that is not exempted there silently forwards every FILE after it to vitest as argv.
    const parsed = parseCli(['--require-ran=keeps PTT', 'lib/voice-prefs.test.ts']);
    expect(parsed.files).toEqual(['lib/voice-prefs.test.ts']);
    expect(parsed.requireRan).toBe('keeps PTT');
    expect(parsed.vitestArgs).toEqual([]);
  });

  it('still separates real vitest args, and composes with --dry', () => {
    const parsed = parseCli(['--dry', '--require-ran=x', 'lib/a.test.ts', '-t', 'pattern']);
    expect(parsed.files).toEqual(['lib/a.test.ts']);
    expect(parsed.dry).toBe(true);
    expect(parsed.requireRan).toBe('x');
    // parseCli normalises `-t pattern` to the joined form (WI-39830), so assert THAT — asserting
    // the bare word would pass on the un-normalised shape too and pin nothing.
    expect(parsed.vitestArgs).toEqual(['--testNamePattern=pattern']);
  });

  it('passes only when the named assertion actually EXECUTED', () => {
    expect(requireRanVerdict('pays for the answer ONCE', outcomes)).toMatchObject({ status: 'ran' });
  });

  it('catches the incident: the named assertion exists but was skipped', () => {
    const verdict = requireRanVerdict('migrated to PG', outcomes);
    expect(verdict.status).toBe('skipped');
    expect(verdict.matches).toEqual(['voice-prefs (PG-backed) migrated to PG']);
  });

  it('distinguishes absent from skipped — a typo or rename is a different repair', () => {
    expect(requireRanVerdict('no-such-name', outcomes)).toMatchObject({ status: 'absent' });
  });

  it('reports UNVERIFIED, never a pass, when there is no readable report', () => {
    // The whole point is that an unanswered question must not read as a "yes".
    expect(requireRanVerdict('anything', null)).toMatchObject({ status: 'unverified' });
  });

  it('is inert when not requested', () => {
    expect(requireRanVerdict(null, outcomes)).toMatchObject({ status: 'not-requested' });
  });
});

describe('aggregateGroupResults — skipped counts aggregate three-state, like executed ones', () => {
  const group = (over: Record<string, unknown> = {}) => ({
    requested: 1,
    matched: 1,
    executed: 1,
    unmatchedCount: 0,
    failed: false,
    launchError: false,
    ...over,
  });

  it('sums measured counts and concatenates names across groups', () => {
    const summary = aggregateGroupResults([
      group({ testsSkipped: 1, skippedNames: [{ name: 'a', file: 'f1' }], executedNames: ['x'] }),
      group({ testsSkipped: 2, skippedNames: [{ name: 'b', file: 'f2' }], executedNames: ['y'] }),
    ]);
    expect(summary.testsSkipped).toBe(3);
    expect(summary.skippedUnmeasuredGroups).toBe(0);
    expect(summary.skippedNames.map((s: { name: string }) => s.name)).toEqual(['a', 'b']);
    expect(summary.executedNames).toEqual(['x', 'y']);
  });

  it('counts a group that never measured as UNMEASURED, not as a clean zero', () => {
    // A launch error or zero-match group contributes no count. Folding that into 0 would report
    // `skippedTests=0` for a run that never looked — the exact false reassurance this closes.
    const summary = aggregateGroupResults([group({ testsSkipped: 2 }), group({ launchError: true })]);
    expect(summary.testsSkipped).toBe(2);
    expect(summary.skippedUnmeasuredGroups).toBe(1);
  });

  it('reports null when NO group measured a skip count', () => {
    const summary = aggregateGroupResults([group({ testsSkipped: null })]);
    expect(summary.testsSkipped).toBeNull();
    expect(summary.skippedUnmeasuredGroups).toBe(1);
  });
});

/**
 * EI-21974750710808305 — the same absent-measurement-wearing-a-pass this file opens with, one level
 * up: not one skipped assertion inside a green run, but a run in which EVERY collected test was
 * skipped and the verdict line still said `passed`.
 *
 * The incident: /tmp/p002-omp-d052.log, 2026-08-30T23:54Z. The P-002 real-backend acceptance matrix
 * ran without `PAPERCUSP_REAL_BACKEND_MATRIX=1`, skipped all 14 tests, printed 14 `TEST_FILE_SKIPPED
 * name=` lines — and still emitted `status=passed ... skippedTests=14` with exit 0. Its runner read
 * the verdict line and recorded `STOP reason=green attempts_used=1` for an acceptance leg that never
 * executed a single test. The 14 advisory lines changed nothing, which is the point: advisory output
 * does not beat the verdict line, so the countermeasure has to BE the verdict.
 */
describe('allSkippedVerdict — a run that executed ZERO of its collected tests is not a pass', () => {
  const summaryOf = (over: Record<string, unknown> = {}) => ({
    anyFailed: false,
    skippedUnmeasuredGroups: 0,
    skippedNames: [] as { name: string; file: string }[],
    executedNames: [] as string[],
    ...over,
  });
  const skips = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `SU-session real-backend acceptance matrix omp CASE ${i}`,
      file: 'lib/su-session-real-backend-matrix.integration.test.ts',
    }));

  it('REFUSES the incident shape — 14 collected, 14 skipped, 0 executed', () => {
    const verdict = allSkippedVerdict(summaryOf({ skippedNames: skips(14) }));
    expect(verdict.vacuous).toBe(true);
    expect(verdict.reason).toBe('every-collected-test-was-skipped');
  });

  it('does NOT refuse when even ONE test executed — a partially-skipped run still measured something', () => {
    const verdict = allSkippedVerdict(
      summaryOf({ skippedNames: skips(13), executedNames: ['matrix omp CREATE'] }),
    );
    expect(verdict.vacuous).toBe(false);
    expect(verdict.reason).toBe('tests-executed');
  });

  it('does NOT refuse an ordinary green run', () => {
    expect(allSkippedVerdict(summaryOf({ executedNames: ['a', 'b'] })).vacuous).toBe(false);
  });

  it('leaves a GENUINE FAILURE reported as failed instead of softening it into a refusal', () => {
    const verdict = allSkippedVerdict(summaryOf({ anyFailed: true, skippedNames: skips(14) }));
    expect(verdict.vacuous).toBe(false);
    expect(verdict.reason).toBe('genuine-failure');
  });

  it('FAILS OPEN when no report was readable — empty name lists must not fabricate a refusal', () => {
    // Load-bearing control, and the reason the guard keys on NAMES rather than a zero count: when no
    // json report is readable both lists are empty, which is indistinguishable from "nothing ran".
    // Refusing there would invent a verdict out of a hole — the same collapse of "unreadable" into a
    // confident value that EI-19380376466745152 above closed for the skip COUNT.
    const verdict = allSkippedVerdict(summaryOf({ skippedNames: [], executedNames: [] }));
    expect(verdict.vacuous).toBe(false);
    expect(verdict.reason).toBe('no-collected-skips');
  });

  it('does NOT refuse while any group’s skip count is UNMEASURED', () => {
    const verdict = allSkippedVerdict(
      summaryOf({ skippedNames: skips(3), skippedUnmeasuredGroups: 1 }),
    );
    expect(verdict.vacuous).toBe(false);
    expect(verdict.reason).toBe('skip-count-unmeasured');
  });

  it('tolerates a summary missing the name arrays entirely rather than throwing', () => {
    // aggregateGroupResults always supplies both, but main() reads `?? []` on them for a reason:
    // an early-return summary shape must degrade to "no verdict", never to a crash in the refusal.
    expect(allSkippedVerdict({ anyFailed: false, skippedUnmeasuredGroups: 0 }).vacuous).toBe(false);
  });
});
