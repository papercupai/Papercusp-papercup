/**
 * PINS the `npm run test:file` exit-code contract (EI-21884126680256710).
 *
 * WHY THIS EXISTS. The mapping was already implemented and mostly correct, but
 * as a handful of independent `return <literal>` decisions that nothing named
 * and nothing pinned. Writing it down found four not-measured refusals that
 * returned `1` — the genuine-red code — while the message printed one line
 * above each of them said the run had measured nothing. That is the
 * misattribution the whole contract exists to prevent, and it survived because
 * no test could see the difference between the two codes.
 *
 * The property worth defending is narrow and absolute: EXACTLY ONE exit code is
 * evidence about the code under test. Everything else is evidence about the
 * harness. A test that only checked "nonzero on failure" would pass on every
 * version of this file, including the broken ones.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEST_FILE_EXIT_FAILED,
  TEST_FILE_EXIT_FINALIZATION_ERROR,
  TEST_FILE_EXIT_NOT_MEASURED,
  TEST_FILE_EXIT_PASSED,
  TEST_FILE_EXIT_TEMPFAIL,
  describeTestFileExit,
  testFileRunWasMeasured,
  // The .mjs contract module has no declaration file; the diagnostic lands on
  // the `from` line, so the suppression must be the LAST comment line directly
  // above it.
  // @ts-expect-error
} from '../../../../scripts/lib/test-file-exit-codes.mjs';
import {
  main,
  REPO_ROOT,
  // @ts-expect-error
} from '../../../../scripts/test-files.mjs';

const CONTRACT = [
  TEST_FILE_EXIT_PASSED,
  TEST_FILE_EXIT_FAILED,
  TEST_FILE_EXIT_FINALIZATION_ERROR,
  TEST_FILE_EXIT_NOT_MEASURED,
  TEST_FILE_EXIT_TEMPFAIL,
] as number[];

/**
 * Ambient environment of the worker this suite runs in, which the nested router
 * run started by `runMain` must NOT inherit.
 *
 * `runMain` drives the REAL CLI entrypoint IN THIS PROCESS, so `main()` reads the
 * env of the vitest worker executing this file, and the child Vitest it spawns
 * inherits it in turn. Two variables that are correct for THIS suite are actively
 * wrong for the router run it starts, and each converts a contract assertion into
 * an unrelated TEST_FILE_ROUTE_ERROR about the harness rather than the contract:
 *
 *  - PAPERCUSP_FORBID_REAL_PG=1 is set for unit lanes, but the router legitimately
 *    opens its own governor pool (resource-governor/execution.ts ->
 *    createDedicatedOrgPg('governed-process'), i.e. pool "org-admin-governed-process"),
 *    so assertRealPgAllowed refuses the launch: "could not launch Vitest: A UNIT
 *    test tried to open a REAL Postgres connection" [EI-19311807188719573].
 *  - PC_HEAVY_PREEMPT_READY_FILE / PC_HEAVY_PSI_FINALIZATION_FILE name the marker
 *    the OUTER pc-heavy wrapper is still holding LIVE. The nested publish then hits
 *    EEXIST, and scripts/lib/preempt-markers.mjs propagates a LIVE owner's EEXIST
 *    BY DESIGN (it reclaims only dead debris), so the run refuses
 *    [EI-21882371330313535].
 *
 * MEASURED 2026-08-31: clearing only the pc-heavy pair still failed on the PG
 * guard, so both must go. Neither is part of the exit-code contract being pinned,
 * so they are cleared for the nested call only and restored in `finally`.
 */
const NESTED_RUN_INHERITED_CONTAMINATION = [
  'PAPERCUSP_FORBID_REAL_PG',
  'PC_HEAVY_PREEMPT_READY_FILE',
  'PC_HEAVY_PSI_FINALIZATION_FILE',
] as const;

/** Drive the real CLI entrypoint with console captured, and return its exit code. */
async function runMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  // The router also writes diagnostics on console.warn (e.g. the unscoped
  // focused-run notice when PAPERCUSP_TEST_RUN_HARNESS is unset). Capture every
  // channel the real CLI uses, or vitest-fail-on-console reds this file whenever
  // a new warn-level diagnostic is added to the router.
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const saved = new Map<string, string | undefined>(
    NESTED_RUN_INHERITED_CONTAMINATION.map((key) => [key, process.env[key]]),
  );
  for (const key of NESTED_RUN_INHERITED_CONTAMINATION) delete process.env[key];
  try {
    const code = (await main(argv)) as number;
    return {
      code,
      out: logSpy.mock.calls.map((call) => String(call[0])).join('\n'),
      err: [...errorSpy.mock.calls, ...warnSpy.mock.calls].map((call) => String(call[0])).join('\n'),
    };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    errorSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  }
}

describe('test:file exit-code contract', () => {
  it('reserves distinct codes, and exactly ONE of them blames the code under test', () => {
    expect(new Set(CONTRACT).size).toBe(CONTRACT.length);

    const blaming = CONTRACT.filter((code) => describeTestFileExit(code).blamesCodeUnderTest);
    expect(blaming).toEqual([TEST_FILE_EXIT_FAILED]);

    // Finalization failure retains a measured outcome without blaming tests.
    expect(CONTRACT.filter((code) => testFileRunWasMeasured(code))).toEqual([
      TEST_FILE_EXIT_PASSED,
      TEST_FILE_EXIT_FAILED,
      TEST_FILE_EXIT_FINALIZATION_ERROR,
    ]);
  });

  it('treats an UNRECOGNISED code as not-measured rather than folding it into failure', () => {
    // A crash, a signal kill (null), or a code some future path adds must never
    // read as "the tests failed" — the default has to fail toward "I do not know".
    for (const code of [null, undefined, 4, 137, -1]) {
      const verdict = describeTestFileExit(code as unknown as number);
      expect(verdict.status).toBe('unknown');
      expect(verdict.measured).toBe(false);
      expect(verdict.blamesCodeUnderTest).toBe(false);
      expect(testFileRunWasMeasured(code as unknown as number)).toBe(false);
    }
  });

  it('keeps a finalization failure unsuccessful, measured and unsafe to rerun automatically', () => {
    expect(describeTestFileExit(TEST_FILE_EXIT_FINALIZATION_ERROR)).toMatchObject({
      status: 'finalization-error',
      measured: true,
      blamesCodeUnderTest: false,
      retryable: false,
    });
  });

  it('marks EX_TEMPFAIL as the retryable not-measured code and nothing else as retryable', () => {
    expect(CONTRACT.filter((code) => describeTestFileExit(code).retryable)).toEqual([
      TEST_FILE_EXIT_TEMPFAIL,
    ]);
  });
});

describe('the router honours the contract on paths that measure nothing', () => {
  it('returns NOT MEASURED — never the red code — for a usage error with no files', async () => {
    const { code, err } = await runMain([]);
    expect(code).toBe(TEST_FILE_EXIT_NOT_MEASURED);
    expect(code).not.toBe(TEST_FILE_EXIT_FAILED);
    expect(err).toContain('usage: npm run test:file');
  });

  it('returns NOT MEASURED for a route error (a file that does not exist)', async () => {
    const { code, err } = await runMain(['packages/operator-core/lib/__tests__/no-such-file.test.ts']);
    expect(code).toBe(TEST_FILE_EXIT_NOT_MEASURED);
    expect(code).not.toBe(TEST_FILE_EXIT_FAILED);
    expect(err).toContain('TEST_FILE_ROUTE_ERROR');
  });

  it('returns NOT MEASURED when every requested path is a non-test input', async () => {
    const { code, err } = await runMain(['packages/operator-core/lib/agent-tools/capability/inspect.ts']);
    expect(code).toBe(TEST_FILE_EXIT_NOT_MEASURED);
    expect(err).toContain('TEST_FILE_ROUTE_ERROR');
  });

  it('returns NOT MEASURED when a -t name filter matches zero tests — the path that used to return the red code', async () => {
    // THE CASE THAT PROVES THE FIX. Before EI-21884126680256710 this returned 1,
    // so this assertion fails against the pre-fix router: a run that collected
    // tests, executed none of them, and refused to print a verdict was reporting
    // the same exit code as a genuine assertion failure. It runs Vitest for real
    // rather than driving a helper, because the literal being pinned is the one
    // the CLI hands to the shell.
    const { code, err } = await runMain([
      'packages/operator-core/lib/__tests__/test-file-exit-codes.test.ts',
      '--',
      '-t',
      'zzz-no-test-has-this-name-EI21884126680256710',
    ]);
    expect(err).toContain('TEST_FILE_NAME_FILTER_NO_MATCH');
    expect(code).toBe(TEST_FILE_EXIT_NOT_MEASURED);
    expect(code).not.toBe(TEST_FILE_EXIT_FAILED);
  }, 120_000);

  it('CALIBRATION: --dry resolves routing and returns PASSED, so the cases above are not just "main always refuses"', async () => {
    const { code, out } = await runMain([
      '--dry',
      'packages/operator-core/lib/__tests__/test-file-exit-codes.test.ts',
    ]);
    expect(code).toBe(TEST_FILE_EXIT_PASSED);
    expect(out).toContain('TEST_FILE_DRYRUN');
  });
});

describe('the red code has exactly one producer', () => {
  /**
   * A source-derived guard, in the same family as
   * `kernel-adapter-options-are-read.test.ts`: the behavioural cases above can
   * prove the not-measured paths do NOT return 1, but nothing they do can prove
   * that 1 is still reachable only from a measured failure. A future edit that
   * routed a refusal back to the red code would pass every test above.
   *
   * It FAILS rather than skips when it cannot find what it is looking for. A
   * guard that silently measures nothing is the defect this whole item is about.
   */
  it('only the measured-failure ternary yields TEST_FILE_EXIT_FAILED', () => {
    // Overridable so `scripts/mutation-probe.sh` can point this guard at a COPY
    // outside the tree and prove it fails on a mutant, without ever holding the
    // shared checkout dirty (the copy-out tier; the sweep commits whatever it
    // finds, so an in-tree mutation can be committed even when nothing goes wrong).
    const subject =
      process.env.PROBE_TEST_FILES_PATH ?? join(REPO_ROOT as string, 'scripts/test-files.mjs');
    const source = readFileSync(subject, 'utf8');

    const importsContract = /from\s+'\.\/lib\/test-file-exit-codes\.mjs'/.test(source);
    expect(importsContract, 'test-files.mjs must import the exit-code contract').toBe(true);

    const failedUses = source.match(/TEST_FILE_EXIT_FAILED/g) ?? [];
    // One in the import list, one at the single return site.
    expect(failedUses.length, 'TEST_FILE_EXIT_FAILED should appear only in the import and one return').toBe(2);

    expect(source).toContain(
      'return summary.anyFailed ? TEST_FILE_EXIT_FAILED : TEST_FILE_EXIT_PASSED;',
    );
  });

  /**
   * `testing:run` keeps its own literal for the not-measured code rather than
   * importing this module, deliberately: operator-core is bundled for the
   * desktop sidecar and must not take a dependency on `scripts/`. A second copy
   * of a truth another module owns is exactly the drift the derived-truth
   * ladder warns about, so the copy is PINNED here instead of trusted. Its
   * doc-comment used to say `1 = a refused false-green OR a genuine test
   * failure` — a duplicated copy of the bug itself, which is how the ambiguity
   * survived long enough to be filed as a mystery.
   */
  it('keeps testing:run\'s private router-exit literal equal to the contract', () => {
    const runTs = readFileSync(
      join(REPO_ROOT as string, 'packages/operator-core/lib/agent-tools/testing/run.ts'),
      'utf8',
    );
    const declaration = /const ROUTER_EXIT_ROUTE_ERROR = (\d+);/.exec(runTs);
    expect(declaration, 'ROUTER_EXIT_ROUTE_ERROR declaration not found in run.ts').not.toBeNull();
    expect(Number(declaration![1])).toBe(TEST_FILE_EXIT_NOT_MEASURED);
  });
});
