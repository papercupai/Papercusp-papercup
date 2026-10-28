// P-003 (plan gate-latency-selection-and-retry-policy-2026-09-06): the retry decision reads the
// first pass's failure SHAPE. Pins the four branches and the fail-safe direction: a flake
// signature always earns a retry; a broad deterministic red never does.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RETRY_BUDGET_CAP_MS,
  RETRY_BUDGET_FLOOR_MS,
  RETRY_BUDGET_HEADROOM,
  RETRY_FLAKE_CLASSES,
  RETRY_SMALL_RED_FILES,
  decideRetry,
  deriveRetryBudget,
  formatRetryBudgetLine,
  formatRetryDecisionLine,
  formatRetryPoolLine,
  matchRetryFlakeClasses,
  vitestFailureEntries,
  vitestFailureReport,
} from '../../../../scripts/lib/retry-failure-shape.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MAX = 15;
const MIN = 60_000;
const files = (n: number) => Array.from({ length: n }, (_, i) => `lib/f${i}.test.ts`);
// The stderr tail of a real red: vitest's failure-report divider, then one entry per failure.
const ASSERTION_RED = [
  '⎯⎯⎯⎯⎯⎯ Failed Tests 37 ⎯⎯⎯⎯⎯⎯',
  'FAIL lib/f0.test.ts > renders',
  'AssertionError: expected "a" to deeply equal "b"',
  '- Expected',
  '+ Received',
].join('\n');

describe('matchRetryFlakeClasses', () => {
  it('names every class it recognises, in catalogue order', () => {
    const out =
      'Error: Test timed out in 60000ms\n' +
      'Error: connect ECONNREFUSED 127.0.0.1:5432\n' +
      'listen EADDRINUSE: address already in use :::3070\n' +
      'Expected test not to call console.error()\n' +
      'FATAL ERROR: Reached heap limit\n' +
      'Error: Transform failed with 1 error';
    expect(matchRetryFlakeClasses(out)).toEqual(RETRY_FLAKE_CLASSES.map((c) => c.id));
  });

  it('sees nothing in an assertion diff, or in no output at all', () => {
    expect(matchRetryFlakeClasses(ASSERTION_RED)).toEqual([]);
    expect(matchRetryFlakeClasses('')).toEqual([]);
    // @ts-expect-error — runtime callers pass null when capture was streamed
    expect(matchRetryFlakeClasses(null)).toEqual([]);
  });

  it('sees a coloured signature — the reporter wraps tokens in ANSI, which breaks a bare \\b match', () => {
    expect(matchRetryFlakeClasses('Error: connect \x1b[31mECONNREFUSED\x1b[39m 127.0.0.1:5432')).toEqual(['connection']);
  });
});

describe('vitestFailureReport', () => {
  it('scopes to the tail from the first failure-report divider, ANSI stripped', () => {
    const out =
      'noise: this passing title says SIGKILL\n' +
      '\x1b[31m⎯⎯⎯⎯⎯⎯\x1b[39m\x1b[1m\x1b[41m Failed Suites 1 \x1b[49m\x1b[22m\x1b[31m⎯⎯⎯⎯⎯⎯⎯\x1b[39m\n' +
      'FAIL lib/a.test.ts [ lib/a.test.ts ]\nError: boom\n' +
      '⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯\nFAIL lib/b.test.ts > x\nAssertionError: nope';
    const r = vitestFailureReport(out);
    expect(r.scope).toBe('failure-report');
    expect(r.report.startsWith('⎯⎯⎯⎯⎯⎯ Failed Suites 1 ')).toBe(true);
    expect(r.report).not.toContain('SIGKILL');
    expect(r.report).toContain('Failed Tests 2');
    expect(r.report).not.toContain('\x1b[');
  });

  it("also anchors on vitest's unhandled-error forms", () => {
    for (const divider of ['⎯⎯ Unhandled Errors ⎯⎯', 'Vitest caught 1 unhandled error during the test run.', '⎯⎯ Unhandled Rejection ⎯⎯']) {
      const r = vitestFailureReport(`green title SIGABRT\n${divider}\nError: Worker exited unexpectedly`);
      expect(r.scope).toBe('failure-report');
      expect(r.report).not.toContain('SIGABRT');
      expect(matchRetryFlakeClasses(`green title SIGABRT\n${divider}\nError: Worker exited unexpectedly`)).toEqual(['worker-crash']);
    }
  });

  it('falls back to the WHOLE capture when no report exists (a crash before any report, a non-vitest runner)', () => {
    const r = vitestFailureReport('npm ERR! spawn ENOENT\nFATAL ERROR: Reached heap limit');
    expect(r).toEqual({ report: 'npm ERR! spawn ENOENT\nFATAL ERROR: Reached heap limit', scope: 'whole-output' });
    expect(matchRetryFlakeClasses('FATAL ERROR: Reached heap limit')).toEqual(['worker-crash']);
    expect(vitestFailureReport('')).toEqual({ report: '', scope: 'whole-output' });
    // @ts-expect-error — runtime callers pass null when capture was streamed
    expect(vitestFailureReport(null)).toEqual({ report: '', scope: 'whole-output' });
  });
});

describe('decideRetry', () => {
  it('SKIPS a broad deterministic red — the e70cd139 shape: 36 assertion failures, no flake signature', () => {
    const d = decideRetry({ failedFiles: files(36), output: ASSERTION_RED, maxFiles: MAX });
    expect(d.retry).toBe(false);
    expect(d.mode).toBe('none');
    expect(d.reason).toBe('broad-deterministic-red(36>15)');
    expect(formatRetryDecisionLine('@papercusp/operator-core', d)).toBe(
      'AFFECTED_RETRY_SKIPPED ws=@papercusp/operator-core retry=0 mode=none failedFiles=36 flakeClasses=none ' +
        'flakeScope=failure-report flakeFiles=0 retryFiles=0 reason=broad-deterministic-red(36>15)',
    );
  });

  it('P-006 replay (e70cd139 lane-stateful): flake tokens in PASSING titles and console output do not earn a retry', () => {
    // The first pass's stdout, as captured: green rows whose titles carry SIGKILL/SIGABRT, a
    // green test's console output printing ECONNREFUSED — then the stderr failure report,
    // which holds only assertion diffs.
    const output = [
      '\x1b[32m✓\x1b[39m lib/host-recycle.test.ts \x1b[2m(\x1b[22m\x1b[2m3 tests\x1b[22m\x1b[2m)\x1b[22m',
      '     \x1b[32m✓\x1b[39m installFatalDiagnostics (diagnostic report on native SIGABRT)',
      '     \x1b[32m✓\x1b[39m hitting the deadline SIGTERMs first (it used to SIGKILL and leak)',
      '\x1b[90mstdout\x1b[2m | lib/harness/routines/release-actions.test.ts > a green tick',
      '[release-actions] mocked pool refused: connect ECONNREFUSED 127.0.0.1:5432 (expected under the mock)',
      ' \x1b[31m❯\x1b[39m lib/static-tool-catalog.test.ts (1 test | 1 failed)',
      ...Array.from({ length: 16 }, (_, i) => ` \x1b[31m❯\x1b[39m lib/f${i}.test.ts (9 tests | 1 failed)`),
      '',
      '\x1b[31m⎯⎯⎯⎯⎯⎯\x1b[39m\x1b[1m\x1b[41m Failed Tests 128 \x1b[49m\x1b[22m\x1b[31m⎯⎯⎯⎯⎯⎯\x1b[39m',
      '',
      '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m lib/static-tool-catalog.test.ts\x1b[2m > \x1b[22mmatches every projected MCP identity',
      '\x1b[31m\x1b[1mAssertionError\x1b[22m: derived catalog must have no missing or invented MCP names\x1b[39m',
    ].join('\n');
    expect(matchRetryFlakeClasses(output)).toEqual([]);
    const d = decideRetry({ failedFiles: files(16), output, maxFiles: MAX });
    expect(d).toMatchObject({ retry: false, mode: 'none', flakeScope: 'failure-report', reason: 'broad-deterministic-red(16>15)' });
    // The same tokens INSIDE the report are real signatures and still earn the retry.
    const flaky = `${output}\nError: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect`;
    expect(matchRetryFlakeClasses(flaky)).toEqual(['connection']);
    expect(decideRetry({ failedFiles: files(16), output: flaky, maxFiles: MAX })).toMatchObject({
      retry: true,
      mode: 'whole-workspace',
      reason: 'flake-class:connection(broad)',
    });
  });

  it('SKIPS a mid-sized deterministic red too (above the small-red floor, no signature)', () => {
    const d = decideRetry({ failedFiles: files(RETRY_SMALL_RED_FILES + 1), output: ASSERTION_RED, maxFiles: MAX });
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/^deterministic-shape\(4 file\(s\)/);
  });

  it('retries a TINY red regardless of shape — seconds of cost, highest flake likelihood', () => {
    const d = decideRetry({ failedFiles: files(RETRY_SMALL_RED_FILES), output: ASSERTION_RED, maxFiles: MAX });
    expect(d).toMatchObject({ retry: true, mode: 'fresh-files', reason: `small-red(${RETRY_SMALL_RED_FILES}<=${RETRY_SMALL_RED_FILES})` });
  });

  it('retries the failed files fresh when a flake class is present and the set fits the cap', () => {
    const d = decideRetry({
      failedFiles: files(8),
      output: `${ASSERTION_RED}\nError: Hook timed out in 30000ms`,
      maxFiles: MAX,
    });
    expect(d).toMatchObject({ retry: true, mode: 'fresh-files', flakeClasses: ['test-timeout'] });
    expect(formatRetryDecisionLine('ws', d)).toMatch(/^AFFECTED_RETRY_DECISION ws=ws retry=1 mode=fresh-files failedFiles=8 flakeClasses=test-timeout flakeScope=failure-report flakeFiles=1 retryFiles=8 reason=flake-class:test-timeout$/);
    expect(d.retryFiles).toEqual(files(8));
  });

  it('P-006: a BROAD red whose signatures pin to a few files re-runs ONLY those files fresh (e70cd139: one 180s timeout beside 15 assertion diffs)', () => {
    const output = [
      '⎯⎯⎯⎯⎯⎯ Failed Tests 128 ⎯⎯⎯⎯⎯⎯',
      ...files(15).flatMap((f, i) => [`FAIL ${f} > renders`, 'AssertionError: expected "a" to deeply equal "b"', `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[${i + 1}/16]⎯`]),
      'FAIL lib/agent-tools/fleet_registry/__tests__/launch-on-plan.test.ts > keeps open',
      'Error: Test timed out in 180000ms.',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[16/16]⎯',
      'close timed out after 10000ms',
      'Tests closed successfully but something prevents Vite server from exiting',
    ].join('\n');
    const failedFiles = [...files(15), 'lib/agent-tools/fleet_registry/__tests__/launch-on-plan.test.ts'];
    const d = decideRetry({ failedFiles, output, maxFiles: MAX });
    expect(d).toMatchObject({
      retry: true,
      mode: 'fresh-files',
      flakeClasses: ['test-timeout'],
      flakeFiles: ['lib/agent-tools/fleet_registry/__tests__/launch-on-plan.test.ts'],
      retryFiles: ['lib/agent-tools/fleet_registry/__tests__/launch-on-plan.test.ts'],
      reason: 'flake-class:test-timeout(1 of 16 files)',
    });
    expect(formatRetryDecisionLine('ws', d)).toBe(
      'AFFECTED_RETRY_DECISION ws=ws retry=1 mode=fresh-files failedFiles=16 flakeClasses=test-timeout ' +
        'flakeScope=failure-report flakeFiles=1 retryFiles=1 reason=flake-class:test-timeout(1 of 16 files)',
    );
    // The teardown note alone is not a signature: without the timeout entry this is a skip.
    const noTimeout = output.replace('Error: Test timed out in 180000ms.', 'AssertionError: nope');
    expect(decideRetry({ failedFiles, output: noTimeout, maxFiles: MAX })).toMatchObject({ retry: false, flakeClasses: [] });
    // A signature nobody can pin to a file (an unhandled worker crash outside every entry)
    // keeps the whole-workspace retry — it may have taken any file down with it.
    const crash = `${output}\n⎯⎯ Unhandled Errors ⎯⎯\nError: Worker exited unexpectedly`;
    expect(decideRetry({ failedFiles, output: crash, maxFiles: MAX })).toMatchObject({
      retry: true,
      mode: 'whole-workspace',
      reason: 'flake-class:test-timeout+worker-crash(broad)',
    });
  });

  it('vitestFailureEntries: one entry per FAIL header, closed by the [k/N] rule; the rest is unattributed', () => {
    const { entries, unattributed } = vitestFailureEntries(
      '⎯⎯ Failed Suites 1 ⎯⎯\nFAIL lib/a.test.ts [ lib/a.test.ts ]\nError: no export\n  at x\n⎯⎯⎯⎯⎯[1/2]⎯\n\n⎯⎯ Failed Tests 1 ⎯⎯\nFAIL lib/b.test.ts > s > t\nAssertionError: nope\n⎯⎯⎯⎯⎯[2/2]⎯\nclose timed out after 10000ms',
    );
    expect(entries.map((e) => e.file)).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(entries[0].text).toContain('Error: no export');
    expect(entries[1].text).not.toContain('no export');
    expect(unattributed).toContain('Failed Suites 1');
    expect(unattributed).toContain('close timed out after 10000ms');
    expect(unattributed).not.toContain('AssertionError');
  });

  it('retries the WHOLE workspace when a flake class is present but the set exceeds the cap (unchanged behaviour)', () => {
    const d = decideRetry({ failedFiles: files(40), output: 'listen EADDRINUSE :::9071', maxFiles: MAX });
    expect(d).toMatchObject({ retry: true, mode: 'whole-workspace', reason: 'flake-class:port-conflict(broad)' });
  });

  it('keeps the conservative whole-workspace retry when nothing parsed (unattributed failure)', () => {
    const d = decideRetry({ failedFiles: [], output: 'npm ERR! something else entirely', maxFiles: MAX });
    expect(d).toMatchObject({ retry: true, mode: 'whole-workspace', reason: 'unattributed-failure' });
  });
});

// P-004: the retry BUDGET. Derived from what the runner just measured, with headroom, floored
// and capped — never the 45–90m suite watchdog the retry used to inherit.
describe('deriveRetryBudget', () => {
  it('pins the policy constants the runner relies on', () => {
    expect(RETRY_BUDGET_FLOOR_MS).toBe(1 * MIN);
    expect(RETRY_BUDGET_CAP_MS).toBe(20 * MIN);
    expect(RETRY_BUDGET_HEADROOM).toBe(2);
  });

  it('takes the LARGER of history and the first pass as its reference, with headroom', () => {
    const fromHistory = deriveRetryBudget({ firstPassElapsedMs: 4 * MIN, durationEstimateMs: 5 * MIN });
    expect(fromHistory).toMatchObject({ budgetMs: 10 * MIN, source: 'reference', referenceMs: 5 * MIN, referenceSource: 'history' });
    const fromFirstPass = deriveRetryBudget({ firstPassElapsedMs: 6 * MIN, durationEstimateMs: 5 * MIN });
    expect(fromFirstPass).toMatchObject({ budgetMs: 12 * MIN, source: 'reference', referenceMs: 6 * MIN, referenceSource: 'first-pass' });
  });

  it('CAPS the e70cd139 shape — a 40-minute first pass no longer buys a 34-minute re-run', () => {
    const b = deriveRetryBudget({ firstPassElapsedMs: 40 * MIN, durationEstimateMs: 45 * MIN });
    expect(b).toMatchObject({ budgetMs: RETRY_BUDGET_CAP_MS, source: 'cap', referenceMs: 45 * MIN, referenceSource: 'history' });
  });

  it('FLOORS a tiny reference — a 10s guard still gets a minute', () => {
    const b = deriveRetryBudget({ firstPassElapsedMs: 10_000, durationEstimateMs: null });
    expect(b).toMatchObject({ budgetMs: RETRY_BUDGET_FLOOR_MS, source: 'floor', referenceMs: 10_000, referenceSource: 'first-pass' });
  });

  it('falls back to the CAP, not the floor, when it has no reference at all (fail-safe for flakes)', () => {
    for (const absent of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = deriveRetryBudget({ firstPassElapsedMs: absent, durationEstimateMs: absent });
      expect(b).toMatchObject({ budgetMs: RETRY_BUDGET_CAP_MS, source: 'cap-no-reference', referenceMs: null, referenceSource: 'none' });
    }
  });

  it('honours caller overrides and refuses an inverted floor/cap or sub-unit headroom', () => {
    const b = deriveRetryBudget({ firstPassElapsedMs: 2 * MIN, durationEstimateMs: null, floorMs: 30_000, capMs: 3 * MIN, headroomMultiplier: 3 });
    expect(b).toMatchObject({ budgetMs: 3 * MIN, source: 'cap', floorMs: 30_000, capMs: 3 * MIN, headroomMultiplier: 3 });
    expect(() => deriveRetryBudget({ firstPassElapsedMs: MIN, durationEstimateMs: null, floorMs: 5 * MIN, capMs: MIN })).toThrow(/capMs/);
    expect(() => deriveRetryBudget({ firstPassElapsedMs: MIN, durationEstimateMs: null, headroomMultiplier: 0.5 })).toThrow(/headroomMultiplier/);
    expect(() => deriveRetryBudget({ firstPassElapsedMs: MIN, durationEstimateMs: null, floorMs: 0 })).toThrow(/floorMs/);
  });

  it('renders one greppable budget line per scheduled retry', () => {
    const b = deriveRetryBudget({ firstPassElapsedMs: 4 * MIN, durationEstimateMs: 5 * MIN });
    expect(formatRetryBudgetLine('@papercusp/operator-core', b)).toBe(
      'AFFECTED_RETRY_BUDGET ws=@papercusp/operator-core budgetMs=600000 source=reference ' +
        'referenceMs=300000 referenceSource=history firstPassMs=240000 durationEstimateMs=300000 ' +
        'floorMs=60000 capMs=1200000',
    );
    const none = deriveRetryBudget({ firstPassElapsedMs: null, durationEstimateMs: null });
    expect(formatRetryBudgetLine('ws', none)).toMatch(
      /^AFFECTED_RETRY_BUDGET ws=ws budgetMs=1200000 source=cap-no-reference referenceMs=unknown referenceSource=none firstPassMs=unknown durationEstimateMs=unknown /,
    );
  });

  it('brackets the retry pool with start/done/aborted lines', () => {
    expect(formatRetryPoolLine({ phase: 'start', tasks: 3, budgetSumMs: 1_500_000 })).toBe(
      'AFFECTED_RETRY_POOL phase=start tasks=3 budgetSumMs=1500000',
    );
    expect(formatRetryPoolLine({ phase: 'done', tasks: 3, budgetSumMs: 1_500_000, wallMs: 123_456.7, settled: 3 })).toBe(
      'AFFECTED_RETRY_POOL phase=done tasks=3 budgetSumMs=1500000 wallMs=123457 settled=3',
    );
    expect(formatRetryPoolLine({ phase: 'aborted', tasks: 2, settled: 0, detail: 'admission "starved"' })).toBe(
      'AFFECTED_RETRY_POOL phase=aborted tasks=2 settled=0 detail="admission \\"starved\\""',
    );
  });
});

// The wiring in scripts/affected-tests.mjs is reachable by no unit test (every branch runs only
// once a task has already FAILED — on a healthy tree, never), so the structural properties that
// make P-004 safe are pinned as source assertions, the same way the load-suspect and
// stdout-ordering suites pin theirs.
describe('affected-tests.mjs retry pool wiring (P-004)', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');

  it('runs every retry through ONE budgeted pool — never Promise.all over single-task pools', () => {
    // A single-task pool assumes the whole worker budget; N of them in flight would admit N×
    // the configured ceiling. One pool keeps the retries inside the same global envelope the
    // initial pass had.
    expect(src).toMatch(/await runBudgetedTasks\(retryPoolTasks, \{/);
    expect(src).not.toMatch(/runBudgetedTasks\(\[scheduled\.task\]/);
    expect(src).not.toMatch(/Promise\.all\([^\n]*retry/i);
  });

  it('decides and budgets EVERY retry (phase A) before ANY retry runs (phase B), then reports in order (phase C)', () => {
    const decide = src.indexOf('const retryDecision = decideRetry({');
    const budget = src.indexOf('const budget = deriveRetryBudget({');
    const pool = src.indexOf('await runBudgetedTasks(retryPoolTasks');
    const report = src.indexOf('const prep = retryPrep.get(scheduled.index);');
    expect(decide).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(decide);
    expect(pool).toBeGreaterThan(budget);
    expect(report).toBeGreaterThan(pool);
    // Both lines reach the log, in that order, per retried workspace.
    const decisionLine = src.indexOf('errSync(formatRetryDecisionLine(t.ws.name, retryDecision));');
    const budgetLine = src.indexOf('errSync(formatRetryBudgetLine(t.ws.name, budget));');
    expect(decisionLine).toBeGreaterThan(pool);
    expect(budgetLine).toBeGreaterThan(decisionLine);
    expect(src).toContain('formatRetryPoolLine({');
  });

  it('gives the retry child its budget as BOTH the watchdog timeout and, off the gate, the extension ceiling', () => {
    // The progress-aware watchdog extends a still-emitting child up to `maxMs`; off the
    // release gate the budget is the ceiling, so the bound is hard and the initial pass keeps
    // BATCH_TIMEOUT_MAX_MS. On the gate (PC_HEAVY_RELEASE_GATE=1) there is NO ceiling
    // (owner #2574, WI-6554700010042457): only a task whose output went flat is killed.
    expect(src).toMatch(/const historyTimeoutMs =\s*retryBudgetMs \?\?\s*resolveTaskTimeoutMs\(\{/);
    expect(src).toMatch(
      /const watchdogCeilingMs =\s*process\.env\.PC_HEAVY_RELEASE_GATE === '1' \? null : \(retryBudgetMs \?\? BATCH_TIMEOUT_MAX_MS\);/,
    );
    // `null` is routed around Math.min, which would coerce it to 0 and kill the task at once.
    expect(src).toMatch(
      /maxMs: watchdogCeilingMs === null\s*\?\s*\(Number\.isFinite\(launcherWatchdogMs\) \? launcherWatchdogMs : null\)\s*:\s*Math\.min\(watchdogCeilingMs, launcherWatchdogMs\),/,
    );
    expect(src).toMatch(/retryBudgetMs != null\s*\?\s*"retry-budget"/);
  });

  it('keeps governed receipts distinct when two lane retries converge on the default test script', () => {
    // lane-pure and lane-stateful both spawn `@papercusp/operator-core :: test`
    // during fresh-file absorption. The declared task key must survive in the
    // receipt identity or the concurrent retry pool leases the same receipt twice.
    expect(src).toContain(
      'const processIdentity = `${taskKey(context.t)}=>${taskKey(spawnTask)}:${journalLabel}`;',
    );
    expect(src).not.toContain(
      'const processIdentity = `${taskKey(spawnTask)}:${journalLabel}`;',
    );
  });

  it('keeps a retry pool failure from becoming a LOST RUN: the initial failures stand and the run still reports', () => {
    const poolCall = src.indexOf('await runBudgetedTasks(retryPoolTasks');
    const aborted = src.indexOf('phase: "aborted"', poolCall);
    expect(aborted).toBeGreaterThan(poolCall);
    expect(src).toContain('retry did not settle — retaining the initial failure.');
  });
});
