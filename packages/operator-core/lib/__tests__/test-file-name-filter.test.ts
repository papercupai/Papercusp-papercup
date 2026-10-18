import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The synchronous `vitest list` spawn is mocked and `main()`'s asynchronous captured-run seam is
// injected so these stay fast UNIT tests while still driving the real router end-to-end. The
// fixtures below are VERBATIM captures from real vitest 4.1.8 runs in this repo (see each block),
// not shapes written from memory — the sibling detector
// `looksLikeSilentCollectionFailure` was broken for weeks by exactly that mistake
// (EI-18819483316574031: it never stripped ANSI, so it matched only hand-written test text).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});
import { spawnSync } from 'node:child_process';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  joinNameFilterArgs,
  nameFilterFrom,
  testsExecutedFrom,
  testsExecutedFromReport,
  outputFilePathFrom,
  main,
  // The .mjs CLI has no declaration file; the diagnostic lands on the `from`
  // line of this multi-line import, so the suppression directive must be the
  // LAST comment line immediately above it.
  // @ts-expect-error
} from '../../../../scripts/test-files.mjs';

const spawnSyncMock = vi.mocked(spawnSync);

/**
 * Captured 2026-08-03 from `npx vitest run --config vitest.config.ts src/strict-args.test.ts`
 * in libs/generic/tooldef, with and without `-t`. These are the three shapes that decide the
 * verdict, plus the "no tests" shape already documented on looksLikeSilentCollectionFailure.
 */
const REAL_ROWS = {
  // -t 'zzz-no-such-test-name' — THE BUG: 20 tests collected, none executed, vitest exits 0.
  allSkipped: ' Test Files  1 skipped (1)\n      Tests  20 skipped (20)\n   Start at  12:10:22\n',
  allPassed: ' Test Files  1 passed (1)\n      Tests  20 passed (20)\n   Start at  12:11:03\n',
  partial: ' Test Files  1 passed (1)\n      Tests  1 passed | 19 skipped (20)\n   Start at  12:11:40\n',
  withFailures: ' Test Files  1 failed (1)\n      Tests  2 failed | 12 passed (14)\n',
  noTests: ' Test Files  2 failed (2)\n        Tests  no tests\n',
};

describe('nameFilterFrom — is a -t/--testNamePattern filter in play, and what did vitest ACTUALLY receive', () => {
  it('returns null when no name filter is present', () => {
    expect(nameFilterFrom([])).toBeNull();
    expect(nameFilterFrom(['--reporter=verbose', '--outputFile', 'r.json'])).toBeNull();
  });

  it('reads the space-separated short form', () => {
    expect(nameFilterFrom(['-t', 'cd'])).toMatchObject({ flag: '-t', pattern: 'cd' });
  });

  it('reads the long form, space-separated and =-joined', () => {
    expect(nameFilterFrom(['--testNamePattern', 'my name'])).toMatchObject({ pattern: 'my name' });
    expect(nameFilterFrom(['--testNamePattern=my name'])).toMatchObject({ pattern: 'my name' });
    expect(nameFilterFrom(['-t=cd'])).toMatchObject({ pattern: 'cd' });
  });

  // THE WHOLE POINT of reporting the pattern as RECEIVED. The reported invocation was
  // `-t 'cd + EXIT-trap'`; npm's arg chain ate the quotes, so vitest got `-t cd` plus two stray
  // POSITIONALS — which vitest reads as extra FILE filters, narrowing the run further. Surfacing
  // them is what makes the quote-eating self-diagnosing instead of a mystery.
  it('captures the stray positionals npm quote-eating leaves behind', () => {
    const found = nameFilterFrom(['-t', 'cd', '+', 'EXIT-trap']);
    expect(found).toMatchObject({ pattern: 'cd' });
    expect(found.strays).toEqual(['+', 'EXIT-trap']);
  });

  it('does not invent a pattern when the flag is last and has no value', () => {
    expect(nameFilterFrom(['-t'])).toBeNull();
  });
});

describe('joinNameFilterArgs — the name filter must reach vitest as ONE argv token (WI-39830)', () => {
  // WHY THIS IS PINNED. vitest's CAC parser reads a `-`-prefixed token as a NEW OPTION, never as
  // the value of a preceding `-t`. Measured against lib/harness-invoke-once.test.ts (65 tests, 2
  // named `--model=<x> …`): `-t '--model='` exits 1 with 0 matched (`CACError: Unknown option
  // --model`), while `--testNamePattern=--model=` exits 0 and matches both. A pattern CAC *does*
  // know fails differently but as hard (`-t '--silent'` -> "option `-t, --testNamePattern
  // <pattern>` value is missing"). This repo's test names routinely START with `--`, so those
  // tests were unaddressable by name from every caller.
  //
  // FALSIFIABILITY CONTROL. `SPLIT_FORM` below is the OLD, defective construction, kept here
  // permanently as a deliberately-wrong implementation to measure the assertions against — the
  // repo's tier-1 way to prove a guard can fail without mutating the shared tree. Every
  // expectation on joinNameFilterArgs is paired with the same expectation on SPLIT_FORM
  // resolving the other way; an assertion that both satisfy is measuring nothing.
  const SPLIT_FORM = (args: string[]) => args;

  /** No `-t`/`--testNamePattern` may be followed by a token CAC would claim as its own option. */
  const survivesCacParsing = (args: string[]) =>
    args.every(
      (arg, i) =>
        !(arg === '-t' || arg === '--testNamePattern') ||
        args[i + 1] === undefined ||
        !args[i + 1].startsWith('-'),
    );

  it('joins a split `-t <pattern>` into the one token CAC parses correctly', () => {
    expect(joinNameFilterArgs(['-t', '--files= is ignored'])).toEqual([
      '--testNamePattern=--files= is ignored',
    ]);
    // The control: the old construction leaves the two tokens split, which is the shape CAC
    // mis-parses. If this ever starts matching the line above, the subject stopped doing anything.
    expect(SPLIT_FORM(['-t', '--files= is ignored'])).not.toEqual([
      '--testNamePattern=--files= is ignored',
    ]);
  });

  it('joins the long flag the same way', () => {
    expect(joinNameFilterArgs(['--testNamePattern', '--mine (INFERRED)'])).toEqual([
      '--testNamePattern=--mine (INFERRED)',
    ]);
  });

  it('keeps a pattern that itself contains `=` intact — CAC splits on the FIRST `=` only', () => {
    expect(joinNameFilterArgs(['-t', '--model=<x> equals form'])).toEqual([
      '--testNamePattern=--model=<x> equals form',
    ]);
  });

  it('produces argv CAC can parse, where the old split construction does not', () => {
    const dashPrefixed = ['--reporter=json', '-t', '--fake-destructive runs the probe'];
    expect(survivesCacParsing(joinNameFilterArgs(dashPrefixed))).toBe(true);
    // The control resolving the OTHER way is what proves the predicate discriminates at all.
    expect(survivesCacParsing(SPLIT_FORM(dashPrefixed))).toBe(false);
  });

  it('leaves an already-joined filter, other flags, and their order untouched', () => {
    const args = ['--reporter=json', '--outputFile=/tmp/r.json', '--testNamePattern=already'];
    expect(joinNameFilterArgs(args)).toEqual(args);
  });

  it('preserves surrounding flags when it rewrites', () => {
    expect(
      joinNameFilterArgs(['--reporter=json', '-t', 'plain', '--outputFile', '/tmp/r.json']),
    ).toEqual(['--reporter=json', '--testNamePattern=plain', '--outputFile', '/tmp/r.json']);
  });

  it('does not invent a value for a trailing flag — vitest’s own error for that one is correct', () => {
    expect(joinNameFilterArgs(['--reporter=json', '-t'])).toEqual(['--reporter=json', '-t']);
  });

  it('is a no-op on args with no name filter at all', () => {
    expect(joinNameFilterArgs(['--reporter=json', '--outputFile', 'r.json'])).toEqual([
      '--reporter=json',
      '--outputFile',
      'r.json',
    ]);
    expect(joinNameFilterArgs([])).toEqual([]);
  });

  it('leaves the router’s own parser able to read what it produced', () => {
    // The two halves have to agree: whatever this emits, nameFilterFrom must still recognise as
    // a filter in play, or the zero-match guard (EI-19425177453558152) stops policing it.
    const joined = joinNameFilterArgs(['-t', '--files= is ignored']);
    expect(nameFilterFrom(joined)).toMatchObject({ pattern: '--files= is ignored' });
  });
});

describe('testsExecutedFrom — how many tests actually EXECUTED (skipped is not executed)', () => {
  it('reads zero from the all-skipped row that caused this bug', () => {
    expect(testsExecutedFrom(REAL_ROWS.allSkipped)).toBe(0);
  });

  it('reads the executed count from a normal run', () => {
    expect(testsExecutedFrom(REAL_ROWS.allPassed)).toBe(20);
  });

  it('counts only the tests that ran when a filter matches some', () => {
    expect(testsExecutedFrom(REAL_ROWS.partial)).toBe(1);
  });

  it('counts failures as executed', () => {
    expect(testsExecutedFrom(REAL_ROWS.withFailures)).toBe(14);
  });

  it('reads the "no tests" row as zero', () => {
    expect(testsExecutedFrom(REAL_ROWS.noTests)).toBe(0);
  });

  // EI-18819483316574031, same file, same class: vitest COLOURISES the summary row, inserting SGR
  // escapes between `Tests` and its counts. A matcher that does not strip ANSI first passes every
  // hand-written test and then never fires on real output.
  it('parses the ANSI-coloured row real vitest emits to a TTY', () => {
    // Written as \x1b ESCAPES, never raw 0x1b bytes. The runtime string is byte-identical - so
    // this still exercises real TTY output - but a raw control byte makes ripgrep treat the whole
    // file as binary and silently skip it (EI-7432), and reds the fleet gate via
    // lint:no-control-bytes. That is WI-9059: it held main at 5b898b7b until this was escaped.
    const coloured = ' \x1b[2mTests \x1b[22m \x1b[33m20 skipped\x1b[39m \x1b[90m(20)\x1b[39m\n';
    expect(testsExecutedFrom(coloured)).toBe(0);
  });

  // Fail OPEN, never invent a red: a JSON reporter writes no summary row to stdout. `null` means
  // UNVERIFIED, which main() must treat differently from a measured zero.
  it('returns null — not zero — when there is no summary row to read', () => {
    expect(testsExecutedFrom('some unrelated output\n')).toBeNull();
    expect(testsExecutedFrom('')).toBeNull();
  });

  it('reads the LAST summary row when output carries more than one', () => {
    expect(testsExecutedFrom(`${REAL_ROWS.allPassed}\n${REAL_ROWS.allSkipped}`)).toBe(0);
  });
});

/**
 * Captured 2026-08-03 by running the real router against
 * packages/operator-core/lib/__tests__/test-file-name-filter.test.ts with
 * `--reporter=json --outputFile=…` and reading the emitted report. Only the fields the
 * detector reads are kept; the counts are the measured ones.
 */
const REAL_REPORTS = {
  // -t 'zzz-definitely-no-such-test' — THE BUG under a machine reporter: 19 collected, 19
  // pending, 0 executed, and vitest still reports success:true.
  allSkipped: { numTotalTests: 19, numPassedTests: 0, numFailedTests: 0, numPendingTests: 19, numTodoTests: 0, success: true },
  // -t 'name filter' — a filter that really matched.
  partial: { numTotalTests: 19, numPassedTests: 7, numFailedTests: 0, numPendingTests: 12, numTodoTests: 0, success: true },
  withFailures: { numTotalTests: 14, numPassedTests: 12, numFailedTests: 2, numPendingTests: 0, numTodoTests: 0, success: false },
};

describe('outputFilePathFrom — locating the JSON report the router already asked for', () => {
  it('returns null when no --outputFile is present', () => {
    expect(outputFilePathFrom([])).toBeNull();
    expect(outputFilePathFrom(['--reporter=json', '-t', 'x'])).toBeNull();
  });

  it('reads both the =-joined and space-separated forms', () => {
    expect(outputFilePathFrom(['--outputFile=/tmp/r.json'])).toBe('/tmp/r.json');
    expect(outputFilePathFrom(['--outputFile', '/tmp/r.json'])).toBe('/tmp/r.json');
  });

  it('takes the LAST occurrence, as vitest itself does', () => {
    expect(outputFilePathFrom(['--outputFile=/tmp/a.json', '--outputFile', '/tmp/b.json'])).toBe('/tmp/b.json');
  });

  it('treats a trailing flag with no value, or an empty value, as absent', () => {
    expect(outputFilePathFrom(['--outputFile'])).toBeNull();
    expect(outputFilePathFrom(['--outputFile='])).toBeNull();
  });

  // PINNED DELIBERATELY, and the narrowness is the correctness property — not a gap to widen
  // later. `perGroupVitestArgs` rewrites only the two bare forms, so a form it does not rewrite
  // points EVERY group at one shared file; each group would then read whichever group wrote
  // last and report another group's count as its own. If this is ever widened,
  // perGroupVitestArgs must be widened in the same commit.
  it('does NOT recognise the per-reporter --outputFile.json form that perGroupVitestArgs cannot rewrite', () => {
    expect(outputFilePathFrom(['--outputFile.json=/tmp/r.json'])).toBeNull();
  });
});

describe('testsExecutedFromReport — exact counts from the machine reporter (EI-19451028801041450)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tf-report-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  };

  // The whole point: a zero-match run under --reporter=json, where stdout carries no summary
  // row at all and the old detector therefore failed open on every call.
  it('reads ZERO executed from the all-skipped report that caused this bug', () => {
    expect(testsExecutedFromReport(write('r.json', REAL_REPORTS.allSkipped))).toBe(0);
  });

  it('counts only the tests that actually ran when a filter matches some', () => {
    expect(testsExecutedFromReport(write('r.json', REAL_REPORTS.partial))).toBe(7);
  });

  it('counts failures as executed', () => {
    expect(testsExecutedFromReport(write('r.json', REAL_REPORTS.withFailures))).toBe(14);
  });

  it('resolves a relative path against the group cwd', () => {
    write('rel.json', REAL_REPORTS.partial);
    expect(testsExecutedFromReport('rel.json', dir)).toBe(7);
  });

  // Fail OPEN on anything unreadable. `null` means UNVERIFIED; fabricating a 0 here would
  // invent reds for legitimate runs — the opposite, equally expensive mistake.
  it('returns null — never zero — for anything it cannot read', () => {
    expect(testsExecutedFromReport(null)).toBeNull();
    expect(testsExecutedFromReport(join(dir, 'does-not-exist.json'))).toBeNull();
    expect(testsExecutedFromReport(write('bad.json', 'not json at all'))).toBeNull();
    expect(testsExecutedFromReport(write('empty.json', {}))).toBeNull();
    // A report carrying the sibling fields but not the two we count.
    expect(testsExecutedFromReport(write('partialShape.json', { numTotalTests: 9, success: true }))).toBeNull();
  });
});

describe('main() — a name filter that matches ZERO tests must not report a verdict (EI-19425177453558152)', () => {
  // WHY THIS IS PINNED. `test-files.mjs` already hard-fails a zero-or-partial FILE match before
  // executing, and CLAUDE.md advertises exactly that — which is precisely what teaches callers to
  // trust its verdict. A zero TEST match sailed through as `status=passed`, exit 0. It fires in
  // the expensive direction: the canonical reason to pass `-t` is to confirm a pre-fix RED, and a
  // false green there reads as "the defect isn't real", so the natural next move is to stop —
  // closing the item having verified nothing.
  const FILE = 'libs/generic/tooldef/src/strict-args.test.ts';
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const runCapturedTestProcessMock = vi.fn();
  const runVitestListMock = vi.fn();

  const runMain = (argv: string[]) =>
    main(argv, {
      runCapturedTestProcessImpl: runCapturedTestProcessMock,
      runVitestListImpl: runVitestListMock,
    });

  const linesFrom = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  /** first spawn = `vitest list` (drives the file match), second = `vitest run`. */
  /**
   * Dispatches on the COMMAND SHAPE, never on call ordinal.
   *
   * This used to queue two `mockReturnValueOnce`s positionally (1st = `vitest list`, 2nd = `vitest
   * run`), which silently coupled every test here to the exact number of subprocesses `main()`
   * happens to spawn. Adding ANY unrelated spawn ahead of them — EI-18681435059177620 added git
   * calls for the provenance stamp — consumed both stubs, so the real vitest calls received
   * `undefined` and all 11 tests died with a bare `Cannot read properties of undefined`, which
   * reads as a defect in the runner rather than an exhausted fixture. Matching on argv keeps this
   * suite's subject (the name-filter verdict) independent of what else main() shells out to.
   */
  const stubVitest = (runStdout: string, runStatus = 0) => {
    spawnSyncMock.mockReset();
    runCapturedTestProcessMock.mockReset();
    runCapturedTestProcessMock.mockResolvedValue({
      status: runStatus,
      signal: null,
      stdout: runStdout,
      stderr: '',
      error: null,
      timedOut: false,
    });
    spawnSyncMock.mockImplementation(((command: string, args: string[]) => {
      if (command === 'git') return { status: 0, stdout: '', stderr: '' } as never;
      if (args?.includes('list')) {
        return {
          status: 0,
          stdout: 'src/strict-args.test.ts > strict-args > rejects unknown keys\n',
          stderr: '',
        } as never;
      }
      return { status: runStatus, stdout: runStdout, stderr: '' } as never;
    }) as never);
    runVitestListMock.mockImplementation(async (_command: string, args: string[]) => {
      const result = spawnSyncMock('npx', args, { encoding: 'utf8' }) as {
        status?: number | null;
        signal?: string | null;
        stdout?: string;
        stderr?: string;
        error?: Error | null;
      };
      return {
        status: result.status ?? 0,
        signal: result.signal ?? null,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error ?? null,
        timedOut: false,
      };
    });
  };

  /** The `vitest run` invocation, located by shape rather than by index for the same reason. */
  const vitestRunCall = () =>
    runCapturedTestProcessMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[]).includes('run'),
    );

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // main() also writes warn-level diagnostics (the unscoped focused-run notice
    // when PAPERCUSP_TEST_RUN_HARNESS is unset). Swallow them like log/error, or
    // vitest-fail-on-console reds every case here whenever the router gains one.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // main forwards child output directly. Synthetic failed/skip summaries
    // belong to this fixture, never to the outer runner's verdict parser.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // These tests drive main() as a UNIT, but this suite is itself normally run
    // BY `npm run test:file`, i.e. under pc-heavy — which exports
    // PC_HEAVY_PREEMPT_READY_FILE and has ALREADY published that marker for the
    // outer run. main() publishes it with `wx`, so the inherited path made every
    // main() call here die with EEXIST and answer TEST_FILE_ROUTE_ERROR instead
    // of the router verdict under test (10 failures, all from this one cause).
    // The empty value is the real "not under pc-heavy" shape: publishPreemptMarker
    // treats a blank path as "no marker to publish" rather than as an error.
    vi.stubEnv('PC_HEAVY_PREEMPT_READY_FILE', '');
    vi.stubEnv('PC_HEAVY_PSI_FINALIZATION_FILE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    spawnSyncMock.mockReset();
    runCapturedTestProcessMock.mockReset();
    runVitestListMock.mockReset();
  });

  it('exits non-zero when the name filter executed no tests', async () => {
    stubVitest(REAL_ROWS.allSkipped);
    expect(await runMain([FILE, '--', '-t', 'zzz-no-such-test-name'])).not.toBe(0);
  });

  // The EI-19376339983058011 invariant: TEST_FILE_RESULT's PRESENCE is what callers grep to ask
  // "did this actually run?" (`if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED; fi`). Zero tests
  // ran, so the marker must be absent — not present with status=failed.
  it('does NOT print the TEST_FILE_RESULT verdict marker for a run that tested nothing', async () => {
    stubVitest(REAL_ROWS.allSkipped);
    await runMain([FILE, '--', '-t', 'zzz-no-such-test-name']);
    expect(linesFrom(logSpy)).not.toContain('TEST_FILE_RESULT');
  });

  it('names the pattern AS VITEST RECEIVED IT, so npm quote-eating is self-diagnosing', async () => {
    stubVitest(REAL_ROWS.allSkipped);
    await runMain([FILE, '--', '-t', 'cd', '+', 'EXIT-trap']);
    const err = linesFrom(errSpy);
    expect(err).toContain('TEST_FILE_NAME_FILTER_NO_MATCH');
    expect(err).toContain('pattern="cd"');
    expect(err).toContain('EXIT-trap');
  });

  it('preserves a failing beforeAll instead of blaming the name filter for skipped assertions', async () => {
    // Shape observed in mode-identity-binding.integration.test.ts: the selected
    // test exists, but database setup fails before any assertion can execute.
    stubVitest(
      ' Test Files  1 failed (1)\n      Tests  3 skipped (3)\n' +
      ' FAIL  selected identity > beforeAll\nError: Hook timed out in 120000ms.\n',
      1,
    );
    expect(await runMain([FILE, '--', '-t', 'rejects'])).toBe(1);
    expect(linesFrom(errSpy)).not.toContain('TEST_FILE_NAME_FILTER_NO_MATCH');
    expect(linesFrom(logSpy)).toMatch(/TEST_FILE_RESULT .*status=failed/);
  });

  it('preserves a watchdog refusal instead of diagnosing an unmatched name filter', async () => {
    stubVitest(REAL_ROWS.allSkipped);
    runCapturedTestProcessMock.mockResolvedValue({
      status: null, signal: 'SIGTERM', stdout: REAL_ROWS.allSkipped,
      stderr: '', error: null, timedOut: true,
    });
    expect(await runMain([FILE, '--', '-t', 'rejects'])).toBe(2);
    expect(linesFrom(errSpy)).toContain('TEST_FILE_NOT_MEASURED');
    expect(linesFrom(errSpy)).not.toContain('TEST_FILE_NAME_FILTER_NO_MATCH');
    expect(linesFrom(logSpy)).not.toContain('TEST_FILE_RESULT');
  });

  it('stays green when the filter DID match tests (guards against a blanket refusal)', async () => {
    stubVitest(REAL_ROWS.partial);
    expect(await runMain([FILE, '--', '-t', 'rejects'])).toBe(0);
    expect(linesFrom(logSpy)).toMatch(/TEST_FILE_RESULT .*status=passed/);
  });

  it('forwards Vitest flags placed directly after the file list', async () => {
    stubVitest(REAL_ROWS.partial);
    expect(await runMain([FILE, '-t', 'rejects'])).toBe(0);
    // WI-39830: forwarded as the JOINED token. This assertion previously pinned the split
    // `['-t', 'rejects']` pair — i.e. it pinned the defect, which is why the defect survived a
    // green suite. Order matters: `arrayContaining(['-t','rejects'])` would also pass on argv
    // where the two are far apart, so match the single token that actually reaches CAC.
    expect(vitestRunCall()?.[1]).toContain('--testNamePattern=rejects');
    expect(vitestRunCall()?.[1]).not.toContain('-t');
    expect(linesFrom(logSpy)).toMatch(/TEST_FILE_RESULT .*status=passed/);
  });

  // The end-to-end shape of WI-39830, through the real main(): a `--`-prefixed pattern — which
  // this repo's own test names routinely are — must never reach vitest as two argv entries.
  it('never hands vitest a split `-t <pattern>` for a name that starts with `--`', async () => {
    stubVitest(REAL_ROWS.partial);
    expect(await runMain([FILE, '--', '-t', '--files= is ignored'])).toBe(0);
    const argv = vitestRunCall()?.[1] as string[];
    expect(argv).toContain('--testNamePattern=--files= is ignored');
    // The failing shape stated positively: `-t` immediately followed by a `-`-prefixed token is
    // exactly what CAC reads as a new option instead of as the pattern.
    expect(argv.some((a, i) => a === '-t' && (argv[i + 1] ?? '').startsWith('-'))).toBe(false);
  });

  // Non-vacuousness: every assertion above would also hold if the new check refused EVERY run.
  // Pin that an ordinary no-filter run is untouched.
  it('leaves a run with no name filter alone', async () => {
    stubVitest(REAL_ROWS.allPassed);
    expect(await runMain([FILE])).toBe(0);
    expect(linesFrom(logSpy)).toMatch(/TEST_FILE_RESULT .*status=passed/);
    expect(linesFrom(errSpy)).not.toContain('TEST_FILE_NAME_FILTER');
  });

  it.each(['', '{"testResults":[]}\n', 'Tests summary unavailable\n'])(
    'refuses an unreadable named-test count without fabricating zero or a verdict: %j',
    async (stdout) => {
      stubVitest(stdout);
      expect(await runMain([FILE, '--', '-t', 'anything', '--reporter=json'])).toBe(2);
      const err = linesFrom(errSpy);
      expect(err).toContain('TEST_FILE_NAME_FILTER_UNVERIFIED');
      expect(err).toContain('TEST_FILE_NOT_MEASURED');
      expect(err).not.toContain('TEST_FILE_NAME_FILTER_NO_MATCH');
      expect(err).not.toContain('testsExecuted=0');
      expect(linesFrom(logSpy)).not.toContain('TEST_FILE_RESULT');
    },
  );

  it('preserves a measured failure when the named-test count is unreadable', async () => {
    stubVitest(' FAIL  selected identity > beforeAll\nError: setup failed\n', 1);
    expect(await runMain([FILE, '--', '-t', 'rejects'])).toBe(1);
    expect(linesFrom(errSpy)).toContain('TEST_FILE_NAME_FILTER_UNVERIFIED');
    expect(linesFrom(errSpy)).not.toContain('TEST_FILE_NOT_MEASURED');
    expect(linesFrom(errSpy)).not.toContain('TEST_FILE_NAME_FILTER_NO_MATCH');
    expect(linesFrom(logSpy)).toMatch(/TEST_FILE_RESULT .*status=failed/);
  });

  it('preserves the watchdog reason when the named-test count is unreadable', async () => {
    stubVitest('');
    runCapturedTestProcessMock.mockResolvedValue({
      status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null, timedOut: true,
    });
    expect(await runMain([FILE, '--', '-t', 'rejects'])).toBe(2);
    expect(linesFrom(errSpy)).toContain('a watchdog reaped at least one run');
    expect(linesFrom(logSpy)).not.toContain('TEST_FILE_RESULT');
  });

  it('preserves a finalization error without emitting an unreadable passing verdict', async () => {
    stubVitest('');
    runCapturedTestProcessMock.mockResolvedValue({
      status: 0, signal: null, stdout: '', stderr: '', error: null, timedOut: false,
      governedFinalizationError: new Error('finalization failed'),
    });
    expect(await runMain([FILE, '--', '-t', 'rejects'])).toBe(3);
    expect(linesFrom(errSpy)).toContain('TEST_FILE_FINALIZATION_ERROR');
    expect(linesFrom(errSpy)).toContain('TEST_FILE_NOT_MEASURED');
    expect(linesFrom(logSpy)).not.toContain('TEST_FILE_RESULT');
  });

  /**
   * EI-19451028801041450 — the guard above was INERT for the primary consumer.
   *
   * `testing:run` (the surface CLAUDE.md tells every agent to prefer over `npm run test:file`)
   * always passes `--reporter=json --outputFile=…`. Under a machine reporter vitest prints no
   * `Tests` summary row at all, so the stdout detector returned "unreadable" and the check
   * failed OPEN on every single call — verified end-to-end from the CLI, and never once firing
   * through the surface that mattered.
   *
   * These drive main() with EMPTY stdout — exactly what a JSON reporter leaves behind — so they
   * can only pass by reading the report. Note the pairing: same empty stdout, opposite verdicts,
   * decided solely by the report's contents. Without the green half, a blanket refusal would
   * satisfy the red half.
   */
  describe('under a machine reporter, where stdout carries no summary row at all', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tf-main-report-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const withReport = (body: unknown) => {
      const p = join(dir, 'report.json');
      writeFileSync(p, JSON.stringify(body));
      return p;
    };

    it('fails a zero-match run that the stdout-only detector let through as passed', async () => {
      const report = withReport(REAL_REPORTS.allSkipped);
      stubVitest('');
      expect(await runMain([FILE, '--', '-t', 'zzz-no-such-test-name', '--reporter=json', `--outputFile=${report}`])).not.toBe(0);
      const err = linesFrom(errSpy);
      expect(err).toContain('TEST_FILE_NAME_FILTER_NO_MATCH');
      expect(err).toContain('testsExecuted=0');
      // The UNVERIFIED branch is what the old code took here; it must be gone, not merely joined.
      expect(err).not.toContain('TEST_FILE_NAME_FILTER_UNVERIFIED');
      expect(linesFrom(logSpy)).not.toContain('TEST_FILE_RESULT');
    });

    it('stays green when the report shows the filter really did match tests', async () => {
      const report = withReport(REAL_REPORTS.partial);
      stubVitest('');
      expect(await runMain([FILE, '--', '-t', 'rejects', '--reporter=json', `--outputFile=${report}`])).toBe(0);
      expect(linesFrom(logSpy)).toMatch(/TEST_FILE_RESULT .*status=passed/);
      expect(linesFrom(errSpy)).not.toContain('TEST_FILE_NAME_FILTER');
    });

    // The report is PREFERRED, not merely consulted: when the two sources disagree the exact
    // one must win. Here stdout claims a full green run while the report records zero executed.
    it('prefers the report over a stdout summary row that disagrees with it', async () => {
      const report = withReport(REAL_REPORTS.allSkipped);
      stubVitest(REAL_ROWS.allPassed);
      expect(await runMain([FILE, '--', '-t', 'zzz-no-such-test-name', '--reporter=json', `--outputFile=${report}`])).not.toBe(0);
      expect(linesFrom(errSpy)).toContain('testsExecuted=0');
    });

    // A named report that never appeared (a crashed run, a bad path) must
    // fall back to the stdout parse rather than fabricate a zero.
    it('falls back to stdout when the named report does not exist', async () => {
      stubVitest(REAL_ROWS.partial);
      const missing = join(dir, 'never-written.json');
      expect(await runMain([FILE, '--', '-t', 'rejects', '--reporter=json', `--outputFile=${missing}`])).toBe(0);
      expect(linesFrom(logSpy)).toMatch(/TEST_FILE_RESULT .*status=passed/);
    });
  });
});
