/**
 * affected-tests-selected-files-line.test.ts — EI-19416573016968871 regression guard.
 *
 * ## What broke
 *
 * A verdict log emitted `AFFECTED_TESTS_FAILING_FILES` (which files FAILED) with no
 * counterpart for which files RAN. Because `test:affected` only runs the workspaces the
 * changed paths map into, a file can be absent from a run entirely — and to every
 * documented grep recipe that looks identical to "it passed".
 *
 * The absence reads as a POSITIVE observation, so agents used it to DATE regressions:
 * "the 05:48Z verdict didn't list this test; loop.ts changed 05:51Z; the 07:05Z verdict
 * does" — a clean, plausible, wrong causal story. Measured 2026-08-03 on
 * deliver-and-wake.test.ts: the previous 7 verdict logs mention it exactly ONCE each (an
 * inert list entry) vs 13 times in the log that actually ran it. Two agents reached the
 * same false "brand-new break" reading within the hour; one was actively chasing an
 * innocent commit on that basis. The real cause was that ~1162 files changed in the
 * window, pulling the file into the affected set for the FIRST time — so the break may
 * have been far older.
 *
 * ## What these tests pin
 *
 * 1. The coverage taxonomy — specifically that `complete` is the ONLY value licensing the
 *    inference "X is absent from `files`, therefore X did not run". Shipping this line
 *    without that axis would reproduce, at one remove, the exact ambiguity it kills.
 * 2. A task that ran WITHOUT an enumerable file list is NAMED, never omitted. Omitting it
 *    is what would let `complete` lie.
 * 3. The line is single-line and machine-parseable (a log reader greps ONE line).
 * 4. The runner actually wires it in, on every clean exit path INCLUDING the passing one —
 *    a formatter nothing calls is not a fix, and a green run is when this matters most.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { formatRefusalCounterFields } from '../../../../scripts/lib/terminal-counter-fields.mjs';

import {
  formatSelectedFilesLine,
  AFFECTED_TESTS_SELECTED_FILES_TOKEN,
  SELECTED_FILES_LINE_MAX_ENTRIES,
} from '../../../../scripts/lib/vitest-summary.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Overridable so `scripts/mutation-probe.sh` can point the wiring assertions at a COPY
 *  outside the tree (CLAUDE.md tier 2) instead of mutating the shared checkout. */
const AFFECTED_TESTS = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

/** Parse the one field out of the rendered line, so assertions read as the grep a triager
 *  would actually run rather than as substring soup. */
function field(line: string, key: string): string {
  const m = new RegExp(`\\b${key}=([^\\s]+)`).exec(line);
  expect(m, `field ${key}= not present in: ${line}`).not.toBeNull();
  return m![1];
}

describe('AFFECTED_TESTS_SELECTED_FILES coverage taxonomy', () => {
  it('nothing ran at all reads none', () => {
    const line = formatSelectedFilesLine({ runToken: 'r1' });
    expect(field(line, 'coverage')).toBe('none');
    expect(field(line, 'fileCount')).toBe('0');
    expect(field(line, 'unenumeratedCount')).toBe('0');
  });

  it('every executed task enumerated reads complete — the ONLY value licensing an absence inference', () => {
    const line = formatSelectedFilesLine({
      runToken: 'r2',
      entries: [
        { workspace: '@papercusp/operator-core', file: 'lib/deliver-and-wake.test.ts' },
      ],
    });
    expect(field(line, 'coverage')).toBe('complete');
    expect(field(line, 'fileCount')).toBe('1');
    expect(field(line, 'unenumeratedCount')).toBe('0');
  });

  it('an UNENUMERABLE task can never leave the line reading complete', () => {
    // The load-bearing case. A wide/non-narrowable task ran, so the file list is a lower
    // bound — if this reported `complete`, an absent file would look like proof it did not
    // run, which is precisely the false inference this line exists to kill.
    const line = formatSelectedFilesLine({
      runToken: 'r3',
      entries: [{ workspace: '@papercusp/operator-core', file: 'lib/a.test.ts' }],
      unenumerated: [{ task: '@papercusp/sync :: test:integration', reason: 'not-narrowed' }],
    });
    expect(field(line, 'coverage')).toBe('partial');
    expect(field(line, 'coverage')).not.toBe('complete');
  });

  it('tasks ran but NONE could be enumerated reads unenumerated, never none', () => {
    // `none` would say "nothing ran"; the truth is "things ran and we cannot say which
    // files". Collapsing those two is the same class of error as a bare empty list.
    const line = formatSelectedFilesLine({
      runToken: 'r4',
      unenumerated: [{ task: '@papercusp/operator-core :: test', reason: 'wide-run' }],
    });
    expect(field(line, 'coverage')).toBe('unenumerated');
    expect(field(line, 'coverage')).not.toBe('none');
    expect(field(line, 'fileCount')).toBe('0');
  });

  it('names the unenumerable tasks rather than omitting them', () => {
    const line = formatSelectedFilesLine({
      runToken: 'r5',
      unenumerated: [{ task: '@papercusp/sync :: test:el-suite', reason: 'not-narrowed' }],
    });
    expect(line).toContain('@papercusp/sync :: test:el-suite');
    expect(line).toContain('not-narrowed');
  });
});

describe('AFFECTED_TESTS_SELECTED_FILES is greppable and machine-parseable', () => {
  it('is exactly one line, opened by the shared token with a run= anchor', () => {
    const line = formatSelectedFilesLine({
      runToken: 'pid-abcd',
      entries: [{ workspace: 'w', file: 'lib/x.test.ts' }],
    });
    expect(line.split('\n')).toHaveLength(1);
    expect(line.startsWith(`${AFFECTED_TESTS_SELECTED_FILES_TOKEN} run=`)).toBe(true);
    expect(field(line, 'run')).toBe('pid-abcd');
  });

  it('files= is valid JSON a reader can parse in one step', () => {
    const entries = [
      { workspace: '@papercusp/operator-core', file: 'lib/deliver-and-wake.test.ts' },
    ];
    const line = formatSelectedFilesLine({ runToken: 'r', entries });
    const json = /files=(\[.*?\]) unenumerated=/.exec(line);
    expect(json, 'files= payload not parseable').not.toBeNull();
    expect(JSON.parse(json![1])).toEqual(entries);
  });

  it('truncation says so and keeps the count exact', () => {
    const entries = Array.from({ length: SELECTED_FILES_LINE_MAX_ENTRIES + 5 }, (_, i) => ({
      workspace: 'w',
      file: `lib/${i}.test.ts`,
    }));
    const line = formatSelectedFilesLine({ runToken: 'r', entries });
    expect(field(line, 'truncated')).toBe('true');
    // The COUNT stays exact even though the payload is clipped — a truncated list must not
    // under-report the size of the run.
    expect(field(line, 'fileCount')).toBe(String(SELECTED_FILES_LINE_MAX_ENTRIES + 5));
  });
});

describe('the original false inference becomes decidable', () => {
  it('a file absent under coverage=complete is provably not-run; under partial it is not', () => {
    const ran = 'lib/deliver-and-wake.test.ts';
    const complete = formatSelectedFilesLine({
      runToken: 'r',
      entries: [{ workspace: '@papercusp/operator-core', file: 'lib/other.test.ts' }],
    });
    // Decidable: the run enumerated everything it executed and this file is not in it.
    expect(field(complete, 'coverage')).toBe('complete');
    expect(complete).not.toContain(ran);

    const partial = formatSelectedFilesLine({
      runToken: 'r',
      entries: [{ workspace: '@papercusp/operator-core', file: 'lib/other.test.ts' }],
      unenumerated: [{ task: '@papercusp/operator-core :: test:integration', reason: 'not-narrowed' }],
    });
    // Same absence, but the line REFUSES to license the inference — which is the fix.
    expect(field(partial, 'coverage')).toBe('partial');
    expect(partial).not.toContain(ran);
  });
});

describe('the runner wires it in (a formatter nothing calls is not a fix)', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('positive control — the runner source was actually read', () => {
    // If this control fails, every absence assertion below is measuring nothing.
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain('AFFECTED_TESTS_RESULT');
  });

  it('imports the shared formatter rather than hand-typing the token', () => {
    expect(source).toContain('formatSelectedFilesLine');
    // Hand-typing the literal beside an import is how an emitter and its matcher drift.
    expect(source).not.toMatch(/["'`]AFFECTED_TESTS_SELECTED_FILES["'`]/);
  });

  it('emits the line unconditionally, NOT gated behind a failure branch', () => {
    const call = source.indexOf('errSync(selectedFilesLine())');
    expect(call, 'selected-files line is never emitted').toBeGreaterThan(-1);

    // The per-FILE break set is deliberately failure-only. This line must NOT be: a green
    // run is exactly when "was X green at candidate Y?" gets asked. Pin that it is emitted
    // before the branch that renders the failing summary.
    const failureOnly = source.indexOf('renderFailingFilesSummary({');
    expect(failureOnly, 'failure summary call not found — instrument is stale').toBeGreaterThan(-1);
    expect(call).toBeLessThan(failureOnly);
  });

  it('stays DOWNSTREAM of dry-run and incomplete-plan refusal exits', () => {
    // Verified empirically: `--dry` reaches a summary and legitimately prints NO selected-
    // files line. That absence is the contract, not a gap — on these paths tasks are
    // SELECTED BUT NEVER RUN. Admission/deadline refusal can also follow settled shards;
    // publishing the WHOLE selected plan then would claim the unstarted remainder ran.
    // A refactor that hoists the emission above any of them would silently overstate
    // execution coverage.
    const call = source.indexOf('errSync(selectedFilesLine())');
    expect(call, 'selected-files line is never emitted').toBeGreaterThan(-1);

    for (const preExecutionExit of [
      'status=dry-run',
      'reason=deadline-insufficient',
      'status=refused reason=${admissionReason}',
    ]) {
      const at = source.indexOf(preExecutionExit);
      // Positive control: an exit that vanished means the instrument is stale, not that
      // the ordering is safe.
      expect(at, `pre-execution exit '${preExecutionExit}' not found — instrument is stale`).toBeGreaterThan(-1);
      expect(
        at,
        `selected-files is emitted BEFORE the '${preExecutionExit}' exit — it would claim ` +
          `files ran when that path never ran them`,
      ).toBeLessThan(call);
    }
  });

  it.each([
    { reason: 'admission-starved', completedTasks: 0 },
    { reason: 'admission-starved', completedTasks: 2 },
    { reason: 'admission-deferred', completedTasks: 0 },
    { reason: 'admission-deferred', completedTasks: 2 },
    { reason: 'deadline-insufficient', completedTasks: 0 },
    { reason: 'deadline-insufficient', completedTasks: 2 },
  ])('does not publish the full selection on $reason after $completedTasks tasks', (sample) => {
    // Execute the real catch body, not a handwritten refusal. The admission reason is
    // interpolated now; checking its old literal spelling rejected correct production
    // code while leaving the newly introduced deferred branch untested.
    const runAt = source.indexOf('initialPool = await runBudgetedTaskShards');
    const catchAt = source.indexOf('} catch (error) {', runAt);
    const bodyAt = catchAt + '} catch (error) {'.length;
    const endAt = source.indexOf('\n}\n', bodyAt);
    expect(runAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(runAt);
    expect(endAt).toBeGreaterThan(bodyAt);

    const output: string[] = [];
    const exit = new Error('captured refusal exit');
    const context = {
      error: new Error(sample.reason),
      isTaskDeadlineRefusal: () => sample.reason === 'deadline-insufficient',
      isSharedAdmissionDeferral: () => sample.reason === 'admission-deferred',
      isSharedAdmissionTimeout: () => sample.reason === 'admission-starved',
      formatRefusalCounterFields,
      readTerminalCounters: () => ({
        tasks: 5, failed: 0, quarantinedFailed: 0, timedOutTasks: 0,
        undeterminedTasks: 0, observedAdmissionErrors: 0,
        completedTasks: sample.completedTasks, observedNonzeroExits: 0,
      }),
      coverage: {},
      formatCoverageFields: () => `testsExecuted=${sample.completedTasks * 3} testsSkipped=0`,
      selectedFilesLine: () => `${AFFECTED_TESTS_SELECTED_FILES_TOKEN} run=refusal-test`,
      errSync: (line: string) => output.push(line),
      RUN_LOG_PATH: '/tmp/selected-files-refusal-test.log',
      terminalEmitted: false,
      process: { exit: (code: number) => {
        expect(code).toBe(78);
        throw exit;
      } },
    };

    expect(() => new Script(source.slice(bodyAt, endAt)).runInNewContext(context)).toThrow(exit);
    expect(context.terminalEmitted).toBe(true);
    expect(output.some((line) => line.includes(`status=refused reason=${sample.reason}`))).toBe(true);
    expect(output.join('\n')).not.toContain(AFFECTED_TESTS_SELECTED_FILES_TOKEN);
  });
});
