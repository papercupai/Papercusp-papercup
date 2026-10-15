/**
 * affected-tests-failing-files-line.test.ts — EI-19395701908500754 regression guard.
 *
 * ## What broke
 *
 * `AFFECTED_TESTS_RESULT ... failed=N` counts TASKS (workspaces). Nothing in a
 * green-checkpoint verdict log named the failing FILES, so triagers mined prose for them —
 * and the prose they reached for was the gate's own `[green-checkpoint] isolation:
 * re-running <files>` narration. green-checkpoint's self-tests drive the real `runGreen`,
 * so those lines are emitted by FIXTURES too and land interleaved in the persisted log.
 *
 * Measured on the 01:36:17Z red (`...-cand-060ea000f206.log`): mining `isolation:` yielded
 * `lib/a.test.ts` / `lib/b.test.ts` — files that do not exist in this tree — while the real
 * break set was 11 files spanning BOTH failing workspaces. Two agents reached opposite
 * conclusions from the same log inside ten minutes.
 *
 * WI-7274 tagged the fixture lines so they are identifiable. This is the other half: give
 * the run a first-class per-FILE break set so there is no reason to read the prose at all.
 *
 * ## What these tests pin
 *
 * 1. The coverage taxonomy — specifically that an EMPTY file list can never read as
 *    "nothing failed" while failed tasks exist. That is the failure mode this whole shape
 *    exists to prevent, and it is the one a naive `files=[]` would reintroduce.
 * 2. The line is single-line and machine-parseable (a log reader greps ONE line).
 * 3. The adversarial property: the fixture prose that misled the original reader cannot
 *    contribute a single path to the new break set.
 * 4. The runner actually wires it in — a formatter nothing calls is not a fix.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { affectedTestRunLogPath } from '../../../../libs/test-config/src/hermetic-tmpdir.ts';

import {
  formatFailingFilesLine,
  attributeFailedTask,
  renderFailingFilesSummary,
  parseFailedTestFiles,
  parseNodeTestFailedFiles,
  parseAstroCheckFailedFiles,
  parseDeclaredFailingFiles,
  formatDeclaredFailingFileLines,
  DECLARED_FAILING_FILE_TOKEN,
  transformCulpritsFrom,
  AFFECTED_TESTS_FAILING_FILES_TOKEN,
  FAILING_FILES_LINE_MAX_ENTRIES,
  failureEntryKey,
  classifyStaleFailureEntries,
  formatStaleFailureSummary,
  AFFECTED_TESTS_STALE_FAILURES_TOKEN,
} from '../../../../scripts/lib/vitest-summary.mjs';
// @ts-ignore -- runtime reporter module intentionally tested from TypeScript; see report-cargo-tests.test.ts, which suppresses the same import for the same reason. NOT enrolled in tsconfig.declarations.json: the generated .d.mts infers `never[]` for this module's option bags and adds 10 fresh TS2322/TS2345/TS2353 errors to that sibling (measured 2026-08-31, WI-1615183).
import { classifyAffectedCargoFailure } from '../../../../scripts/lib/cargo-result.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// Subject path is overridable ONLY so a mutation probe can point this at a COPY outside the
// tree (CLAUDE.md, "Proving a guard is falsifiable"). Mutating the real file in place races
// git-sync's whole-tree sweep, which will happily commit the mutant. Defaults to the real path.
const AFFECTED_TESTS = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

/** Parse the emitted line back into fields, the way a log consumer would. */
function parseLine(line: string) {
  const scalar = (k: string) => line.match(new RegExp(`\\b${k}=([^\\s]+)`))?.[1];
  const json = (k: string) => {
    const at = line.indexOf(`${k}=[`);
    if (at < 0) return null;
    const from = line.slice(at + k.length + 1);
    // The two JSON payloads are adjacent; take the first balanced array.
    let depth = 0;
    for (let i = 0; i < from.length; i++) {
      if (from[i] === '[') depth++;
      else if (from[i] === ']' && --depth === 0) return JSON.parse(from.slice(0, i + 1));
    }
    return null;
  };
  return {
    run: scalar('run'),
    coverage: scalar('coverage'),
    fileCount: Number(scalar('fileCount')),
    unattributedCount: Number(scalar('unattributedCount')),
    truncated: scalar('truncated') === 'true',
    files: json('files') as Array<{ workspace: string; file: string }> | null,
    unattributed: json('unattributed') as Array<{ task: string; reason: string }> | null,
    transformCulpritCount: Number(scalar('transformCulpritCount')),
    transformCulprits: json('transformCulprits') as string[] | null,
    attributionFallbackCount: Number(scalar('attributionFallbackCount') ?? 0),
    attributionFallbacks: json('attributionFallbacks') as Array<{ task: string; source: string }> | null,
  };
}

describe('formatFailingFilesLine — coverage is reported separately from scope', () => {
  it('reports coverage=complete only when every failed task was attributed to files', () => {
    const line = formatFailingFilesLine({
      runToken: '1234-abcd0000',
      entries: [
        { workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' },
        { workspace: '@papercusp/web', file: 'app/_lints/no-nul-bytes.test.ts' },
      ],
    });
    const p = parseLine(line);
    expect(p.coverage).toBe('complete');
    expect(p.fileCount).toBe(2);
    expect(p.unattributedCount).toBe(0);
    expect(p.files).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' },
      { workspace: '@papercusp/web', file: 'app/_lints/no-nul-bytes.test.ts' },
    ]);
  });

  /**
   * THE case this shape exists for. A run where tasks failed but none could be attributed
   * must not emit anything a reader can mistake for a clean result. Under a bare
   * `files=[...]` field this run and a green one are byte-identical on the file list.
   */
  it('never reads as clean when tasks failed but no file could be named', () => {
    const line = formatFailingFilesLine({
      runToken: '1234-abcd0000',
      entries: [],
      unattributed: [{ task: '@papercusp/operator-core :: test', reason: 'no-file-rows' }],
    });
    const p = parseLine(line);
    expect(p.coverage).toBe('unattributed');
    expect(p.fileCount).toBe(0);
    // The distinguishing evidence: the failure is stated, with its reason, not omitted.
    expect(p.unattributedCount).toBe(1);
    expect(p.unattributed).toEqual([{ task: '@papercusp/operator-core :: test', reason: 'no-file-rows' }]);
    // And it is NOT the same line a genuinely-empty run would produce.
    expect(line).not.toBe(formatFailingFilesLine({ runToken: '1234-abcd0000' }));
  });

  it('reports coverage=partial when only some failed tasks were attributed', () => {
    const p = parseLine(
      formatFailingFilesLine({
        runToken: '1234-abcd0000',
        entries: [{ workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' }],
        unattributed: [{ task: 'papercusp-desktop :: cargo test', reason: 'non-vitest' }],
      }),
    );
    expect(p.coverage).toBe('partial');
    expect(p.fileCount).toBe(1);
    expect(p.unattributedCount).toBe(1);
  });

  it('reports coverage=none only when nothing failed at all', () => {
    expect(parseLine(formatFailingFilesLine({ runToken: 't' })).coverage).toBe('none');
  });

  it('carries the run token so a fixture line cannot be mistaken for this run', () => {
    // The token is the same one in `Full run log: /tmp/papercusp-affected-tests-<token>.log`,
    // which is what lets a reader tie a break set to a specific run in an interleaved log.
    expect(parseLine(formatFailingFilesLine({ runToken: '99-deadbeef' })).run).toBe('99-deadbeef');
  });

  it('stays on ONE line even with paths that would otherwise break a log reader', () => {
    const line = formatFailingFilesLine({
      runToken: 't',
      entries: [{ workspace: '@papercusp/web', file: 'lib/weird\nname.test.ts' }],
    });
    expect(line.split('\n')).toHaveLength(1);
    expect(parseLine(line).files).toEqual([{ workspace: '@papercusp/web', file: 'lib/weird\nname.test.ts' }]);
  });

  it('truncates a pathological break set but keeps the COUNT exact', () => {
    const entries = Array.from({ length: FAILING_FILES_LINE_MAX_ENTRIES + 5 }, (_, i) => ({
      workspace: '@papercusp/operator-core',
      file: `lib/f${i}.test.ts`,
    }));
    const p = parseLine(formatFailingFilesLine({ runToken: 't', entries }));
    expect(p.truncated).toBe(true);
    expect(p.fileCount).toBe(entries.length); // the count is never truncated
    expect(p.files).toHaveLength(FAILING_FILES_LINE_MAX_ENTRIES);
  });
});

describe('the fixture prose that caused EI-19395701908500754 cannot reach the break set', () => {
  /**
   * VERBATIM from the red-#12 verdict log
   * (`2026-08-03T01-36-17-607Z-base-1e0ddc586454-cand-060ea000f206.log`). Every path here
   * is SYNTHETIC — `lib/a.test.ts`, `lib/b.test.ts` do not exist in this tree — and the
   * candidate `abc123` is a fixture sha. This is what a `grep 'isolation:'` returned.
   */
  const FIXTURE_CONTAMINATED_LOG = [
    '[green-checkpoint] isolation: re-running 2 originally-failing file(s) at single concurrency: lib/a.test.ts, lib/b.test.ts',
    '[green-checkpoint] isolation: ALL 2 originally-failing file(s) PASSED ... absorbed as load-flake(s): @papercusp/operator-core::lib/a.test.ts, @papercusp/operator-core::lib/b.test.ts',
    '[green-checkpoint] __CAPTURED_TEST_FIXTURE_RESULT__ {"reason":"not-green","green":false,"candidate":"abc123"}',
    '[green-checkpoint] worker-crash: ALL 1 crashed workspace(s) PASSED on a reduced-concurrency re-run — absorbed as load/infra flake(s): @papercusp/operator-core',
    '[green-checkpoint] suite red was absorbed as a load-flake, but a post-suite leg FAILED — holding the gate: @papercusp/operator-vite (SPA build)',
  ].join('\n');

  it('yields ZERO files from the prose an agent actually mined', () => {
    // The prose names five plausible-looking paths. The break set is derived from vitest's
    // own line-anchored FAIL/rollup rows, which narration cannot forge.
    expect(FIXTURE_CONTAMINATED_LOG).toContain('lib/a.test.ts');
    expect(parseFailedTestFiles(FIXTURE_CONTAMINATED_LOG)).toEqual([]);
  });

  it('still names the REAL failures when genuine vitest rows are interleaved with that prose', () => {
    // The falsifier for the test above: prove it returns [] because the prose is not a FAIL
    // row, NOT because the parser is inert on this input.
    const withRealRows = [
      FIXTURE_CONTAMINATED_LOG,
      ' ❯ lib/release/green-checkpoint-real-deps.test.ts (12 tests | 2 failed) 812ms',
      'FAIL  app/adv/create/PreviewPanel.test.tsx',
    ].join('\n');
    expect(parseFailedTestFiles(withRealRows).sort()).toEqual([
      'app/adv/create/PreviewPanel.test.tsx',
      'lib/release/green-checkpoint-real-deps.test.ts',
    ]);
  });
});

describe('the shared parser does not truncate an extension into a phantom path', () => {
  /**
   * Measured on the 060ea000f206 verdict log while documenting the fallback recipe. The
   * recipe CLAUDE.md used to give — `grep -oE 'FAIL +[^ ]+\.test\.ts'` — does not merely
   * skip a `.tsx` suite: `\.test\.ts` matches the PREFIX of `PreviewPanel.test.tsx`, and
   * `-o` prints the truncated match. So it emitted `app/adv/create/PreviewPanel.test.ts`,
   * a path that does not exist in this tree, and the real `.tsx` file never appeared.
   *
   * Pinned here because the production parser is the thing everything else now depends on:
   * if its file-shape fragment is ever narrowed back to `\.test\.ts`, the break set this
   * whole change exists to make trustworthy starts fabricating paths instead.
   */
  const REAL_FAIL_ROW = 'FAIL  app/adv/create/PreviewPanel.test.tsx';

  it('keeps the full .tsx path that the naive regex truncates', () => {
    expect(parseFailedTestFiles(REAL_FAIL_ROW)).toEqual(['app/adv/create/PreviewPanel.test.tsx']);
  });

  it('demonstrates the truncation it is guarding against (the falsifier)', () => {
    // Not a test of our code — proof that the failure mode above is real, so the assertion
    // above cannot later be dismissed as guarding nothing.
    const naive = REAL_FAIL_ROW.match(/FAIL +[^ ]+\.test\.ts/)?.[0].replace(/^FAIL +/, '');
    expect(naive).toBe('app/adv/create/PreviewPanel.test.ts'); // ← the phantom path
    expect(naive).not.toBe('app/adv/create/PreviewPanel.test.tsx');
  });

  it('covers the other extensions a monorepo actually has', () => {
    const rows = [
      'FAIL  lib/a.test.ts',
      'FAIL  lib/b.spec.tsx',
      'FAIL  lib/c.test.mts',
      'FAIL  lib/d.test.jsx',
    ].join('\n');
    expect(parseFailedTestFiles(rows).sort()).toEqual([
      'lib/a.test.ts',
      'lib/b.spec.tsx',
      'lib/c.test.mts',
      'lib/d.test.jsx',
    ]);
  });
});

describe('attributeFailedTask — a red task never contributes nothing', () => {
  /** VERBATIM shape of a real captured vitest failure (rollup row + FAIL row). */
  const REAL_FAILURE_OUTPUT = [
    ' ❯ lib/release/green-checkpoint-real-deps.test.ts (12 tests | 2 failed) 812ms',
    'FAIL  app/adv/create/PreviewPanel.test.tsx',
    ' Test Files  2 failed | 3274 passed (3276)',
  ].join('\n');

  it('names every file a captured red printed', () => {
    const a = attributeFailedTask({
      workspace: '@papercusp/operator-core',
      task: '@papercusp/operator-core :: test',
      captured: true,
      output: REAL_FAILURE_OUTPUT,
    });
    expect(a.unattributed).toEqual([]);
    expect(a.entries.map((e) => e.file).sort()).toEqual([
      'app/adv/create/PreviewPanel.test.tsx',
      'lib/release/green-checkpoint-real-deps.test.ts',
    ]);
    expect(a.entries.every((e) => e.workspace === '@papercusp/operator-core')).toBe(true);
  });

  it('records an un-captured red (interactive TTY) instead of dropping it', () => {
    const a = attributeFailedTask({ workspace: 'w', task: 'w :: test', captured: false });
    expect(a.entries).toEqual([]);
    expect(a.unattributed).toEqual([{ task: 'w :: test', reason: 'no-captured-output' }]);
  });

  it('records a crash/OOM red whose output has no FAIL rows at all', () => {
    const a = attributeFailedTask({
      workspace: 'w',
      task: 'w :: test',
      captured: true,
      // A worker crash: real, fatal, and it never reached the reporter.
      output: 'Error: Worker terminated due to reaching memory limit: JS heap out of memory\n',
    });
    expect(a.entries).toEqual([]);
    expect(a.unattributed).toEqual([{ task: 'w :: test', reason: 'no-file-rows' }]);
  });

  it('uses a caller-provided fallback only when a watchdog-killed task names no failed file', () => {
    const silentTimeout = attributeFailedTask({
      workspace: 'w',
      task: 'w :: test:lane-stateful',
      captured: true,
      output: 'Test Files  1554 passed (1554)\n',
      fallbackReason: 'batch-timeout',
    });
    expect(silentTimeout.entries).toEqual([]);
    expect(silentTimeout.unattributed).toEqual([
      { task: 'w :: test:lane-stateful', reason: 'batch-timeout' },
    ]);

    const parsedTimeout = attributeFailedTask({
      workspace: 'w',
      task: 'w :: test:lane-stateful',
      captured: true,
      output: [
        ' ❯ lib/event-loop-lag-monitor.test.ts (44 tests | 1 failed) 50.36m',
        'FAIL  lib/event-loop-lag-monitor.test.ts',
        ' Test Files  1 failed | 1551 passed | 2 skipped (1554)',
      ].join('\n'),
      fallbackReason: 'batch-timeout',
    });
    expect(parsedTimeout.unattributed).toEqual([]);
    expect(parsedTimeout.entries).toEqual([
      { workspace: 'w', file: 'lib/event-loop-lag-monitor.test.ts' },
    ]);
  });

  it('falls back to the initial task output when a rowless retry replaces the result', () => {
    const initial = [
      ' ❯ lib/harness/routines/release-actions.test.ts (169 tests | 1 failed) 2723ms',
      ' Test Files  1 failed | 1945 passed | 5 skipped (1953)',
      ' Tests  1 failed | 29127 passed | 26 skipped | 3 todo (29166)',
    ].join('\n');
    const retry = [
      'AFFECTED_TASK_PROGRESS state=governed-admission-error',
      'durable receipt is not leaseable',
    ].join('\n');
    const a = attributeFailedTask({
      workspace: '@papercusp/operator-core',
      task: '@papercusp/operator-core :: test:lane-stateful',
      captured: true,
      output: retry,
      fallbackOutput: initial,
      fallbackSource: 'initial-task-output',
    });

    expect(a.entries).toEqual([
      {
        workspace: '@papercusp/operator-core',
        file: 'lib/harness/routines/release-actions.test.ts',
      },
    ]);
    expect(a.unattributed).toEqual([]);
    expect(a.attributionSource).toBe('initial-task-output');
  });

  it('does not union stale initial rows when the final retry names a file', () => {
    const a = attributeFailedTask({
      workspace: 'w',
      task: 'w :: test',
      captured: true,
      output: ' ❯ lib/current.test.ts (1 test | 1 failed) 10ms',
      fallbackOutput: ' ❯ lib/stale.test.ts (1 test | 1 failed) 10ms',
      fallbackSource: 'initial-task-output',
    });

    expect(a.entries).toEqual([{ workspace: 'w', file: 'lib/current.test.ts' }]);
    expect(a.attributionSource).toBeUndefined();
    expect(a.unattributed).toEqual([]);
  });

  it('every branch yields exactly one of files-or-a-reason — never silence', () => {
    const cases = [
      { workspace: 'w', task: 't', captured: true, output: REAL_FAILURE_OUTPUT },
      { workspace: 'w', task: 't', captured: true, output: '' },
      { workspace: 'w', task: 't', captured: false },
    ];
    for (const c of cases) {
      const a = attributeFailedTask(c);
      expect(a.entries.length + a.unattributed.length).toBeGreaterThan(0);
    }
  });
});

describe('attributeFailedTask — `node --test` output is a SECOND runner format (EI-20095409199430877)', () => {
  /**
   * VERBATIM bytes from run 3655179-735cdb19, the run that made this a bug: the task was
   * reported `unattributed / no-file-rows` — the reason documented as "a worker crash, an
   * OOM, a spawn error" — while its own captured output named the file and line in plain
   * text. Copied from the surviving log, not retyped from the incident report's prose.
   */
  const REAL_NODE_TEST_FAILURE = [
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at test/build-desktop-sidecar-lock.test.js:11:1',
    '✖ every cargo build closes the sidecar flock fd before sccache can daemonize (3.437277ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '',
    '  0 !== 2',
    '',
  ].join('\n');

  it('names the file a red `node --test` task printed, instead of reporting it unattributable', () => {
    const a = attributeFailedTask({
      workspace: '@papercusp/desktop',
      task: '@papercusp/desktop :: test',
      captured: true,
      output: REAL_NODE_TEST_FAILURE,
    });
    expect(a.unattributed).toEqual([]);
    expect(a.entries).toEqual([
      { workspace: '@papercusp/desktop', file: 'test/build-desktop-sidecar-lock.test.js' },
    ]);
  });

  it('unions BOTH runner formats — a task chaining vitest and node --test loses neither', () => {
    const a = attributeFailedTask({
      workspace: 'w',
      task: 'w :: test',
      captured: true,
      output: [
        ' ❯ lib/release/green-checkpoint-real-deps.test.ts (12 tests | 2 failed) 812ms',
        'FAIL  app/adv/create/PreviewPanel.test.tsx',
        REAL_NODE_TEST_FAILURE,
      ].join('\n'),
    });
    expect(a.unattributed).toEqual([]);
    expect(a.entries.map((e) => e.file).sort()).toEqual([
      'app/adv/create/PreviewPanel.test.tsx',
      'lib/release/green-checkpoint-real-deps.test.ts',
      'test/build-desktop-sidecar-lock.test.js',
    ]);
  });

  it('FALSIFIABILITY: a genuinely silent red still reports no-file-rows — the parser has not been widened into always-succeeding', () => {
    const a = attributeFailedTask({
      workspace: 'w',
      task: 'w :: test',
      captured: true,
      output: 'Error: Worker terminated due to reaching memory limit: JS heap out of memory\n',
    });
    expect(a.entries).toEqual([]);
    expect(a.unattributed).toEqual([{ task: 'w :: test', reason: 'no-file-rows' }]);
  });

  /**
   * EI-21440128879545486. A router refusal executes NOTHING, so every parser above speaks for
   * nothing and the reason used to land on `no-file-rows` — "a worker crash, an OOM, a spawn
   * error". Triage then hunts infrastructure while the router has already printed the refusal
   * AND the offending paths in plain text. That misread survived seven unrelated test fixes and
   * kept `main` frozen, because no test was ever broken and re-running changed nothing.
   *
   * Verbatim captured shape from the run that froze the gate
   * (checkpoint log ...-cand-dfe7bd9f4e56.log, lines 23162-23164).
   */
  const ROUTE_REFUSAL_OUTPUT = [
    '  unmatched e2e/design-dashboard-flow.spec.ts',
    '  unmatched e2e/docs-routes.spec.ts',
    'TEST_FILE_ROUTE_ERROR (group cwd=apps/operator) requested=330 matched=328; refusing a ' +
      'false-green zero/partial-match run for this group; For the supported routed test ' +
      'surface, use testing:run { files: [...] }.',
  ].join('\n');

  it('names a ROUTER REFUSAL instead of blaming infrastructure', () => {
    const a = attributeFailedTask({
      workspace: '@papercusp/web',
      task: '@papercusp/web :: test',
      captured: true,
      output: ROUTE_REFUSAL_OUTPUT,
    });
    // Still unattributed — the unmatched files did not FAIL, they never ran, so naming them as
    // failing files would send the gate's isolation re-run after tests that pass.
    expect(a.entries).toEqual([]);
    expect(a.unattributed).toEqual([{ task: '@papercusp/web :: test', reason: 'route-refusal' }]);
  });

  it('FALSIFIABILITY: the new reason is not a catch-all — no marker means the verdict does not move', () => {
    // Paired control: without the refusal line the reason must stay put, or `route-refusal`
    // would just be a rename of the reason it was split out of.
    const a = attributeFailedTask({
      workspace: '@papercusp/web',
      task: '@papercusp/web :: test',
      captured: true,
      output: '  unmatched e2e/docs-routes.spec.ts\nJS heap out of memory\n',
    });
    expect(a.unattributed).toEqual([
      { task: '@papercusp/web :: test', reason: 'no-file-rows' },
    ]);
  });

  it('leaves a DECLARED reason ahead of it — the branch may only replace no-file-rows', () => {
    const declared = attributeFailedTask({
      workspace: 'w',
      task: 'w :: test',
      captured: true,
      output: ROUTE_REFUSAL_OUTPUT,
      fallbackReason: 'non-vitest',
    });
    expect(declared.unattributed).toEqual([{ task: 'w :: test', reason: 'non-vitest' }]);
  });

  it('still attributes real failing files when a refusal marker is also present', () => {
    // One group refusing must not erase another group's genuine FAIL rows.
    const a = attributeFailedTask({
      workspace: '@papercusp/web',
      task: '@papercusp/web :: test',
      captured: true,
      output: `${ROUTE_REFUSAL_OUTPUT}\n FAIL  lib/real-thing.test.ts > it breaks\n`,
    });
    expect(a.entries.map((e) => e.file)).toContain('lib/real-thing.test.ts');
    expect(a.unattributed).toEqual([]);
  });

  it('does NOT attribute a PASSING run: `test at` is failure-exclusive, verified against emitted bytes', () => {
    // A green node --test run prints per-file ✔ rows and a summary, and NO `test at` line —
    // that exclusivity is the property the matcher leans on, so it is pinned here.
    const green = ['✔ alpha passes (1.9ms)', 'ℹ tests 2', 'ℹ pass 2', 'ℹ fail 0'].join('\n');
    expect(parseNodeTestFailedFiles(green)).toEqual([]);
  });

  it('dedupes repeats — several failures in one file name it once', () => {
    const out = ['test at test/a.test.js:1:1', 'test at test/a.test.js:9:1'].join('\n');
    expect(parseNodeTestFailedFiles(out)).toEqual(['test/a.test.js']);
  });

  it('REGRESSION: captures unconventional suite naming — `@papercusp/cli` uses *.node-test.ts', () => {
    // The first draft of the matcher reused VITEST_TEST_FILE_SOURCE, which demands a literal
    // `.test.`/`.spec.` segment. `node-test.ts` is `-test`, not `.test`, so cli's failures kept
    // reporting no-file-rows while the conventional `.test.js` case passed — the fix silently
    // not applying to one of the three workspaces it claimed to cover. Bytes below are from a
    // real `node --test --import tsx src/thing.node-test.ts` run.
    const out = 'test at src/thing.node-test.ts:2:871\n✖ cli-style name fails (1ms)\n';
    expect(parseNodeTestFailedFiles(out)).toEqual(['src/thing.node-test.ts']);
  });

  it('needs the `test at` anchor — a bare path mentioned in prose is not a failure', () => {
    expect(parseNodeTestFailedFiles('see test/a.test.js:1:1 for context\n')).toEqual([]);
    expect(parseNodeTestFailedFiles('  at Test.run (node:internal/test_runner/test:1201:25)\n')).toEqual([]);
  });
});

describe('renderFailingFilesSummary — the block the red path actually prints', () => {
  it('leads with the files, warns that failed=N counts tasks, and ends with the machine line', () => {
    const lines = renderFailingFilesSummary({
      runToken: '1234-abcd0000',
      failedTaskCount: 2,
      entries: [
        { workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' },
        { workspace: '@papercusp/web', file: 'app/_lints/no-nul-bytes.test.ts' },
      ],
    });
    expect(lines[0]).toContain('2 failing test file(s)');
    expect(lines[0]).toContain('failed=2 above counts TASKS, not files');
    expect(lines).toContain('  - @papercusp/operator-core :: lib/x.test.ts');
    expect(lines).toContain('  - @papercusp/web :: app/_lints/no-nul-bytes.test.ts');
    expect(lines.at(-1)).toContain(AFFECTED_TESTS_FAILING_FILES_TOKEN);
    expect(parseLine(String(lines.at(-1))).coverage).toBe('complete');
  });

  it('states, in prose a triager will read, that an unattributed list is not complete', () => {
    const lines = renderFailingFilesSummary({
      runToken: 't',
      failedTaskCount: 2,
      entries: [{ workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' }],
      unattributed: [{ task: 'papercusp-desktop :: cargo test', reason: 'non-vitest' }],
    });
    const prose = lines.join('\n');
    expect(prose).toContain('could NOT be attributed to files');
    expect(prose).toContain('do not read the list above as complete');
    expect(prose).toContain('  - papercusp-desktop :: cargo test (non-vitest)');
    expect(parseLine(String(lines.at(-1))).coverage).toBe('partial');
  });

  it('never emits a bare empty list when tasks failed', () => {
    const lines = renderFailingFilesSummary({
      runToken: 't',
      failedTaskCount: 1,
      unattributed: [{ task: '@papercusp/web :: test', reason: 'no-file-rows' }],
    });
    expect(lines.join('\n')).toContain('@papercusp/web :: test (no-file-rows)');
    expect(parseLine(String(lines.at(-1))).coverage).toBe('unattributed');
  });

  it('states when a secondary task-scoped output supplied the file attribution', () => {
    const lines = renderFailingFilesSummary({
      runToken: 't',
      failedTaskCount: 2,
      entries: [{ workspace: '@papercusp/operator-core', file: 'lib/x.test.ts' }],
      unattributed: [{ task: 'w :: test:el-suite', reason: 'no-file-rows' }],
      attributionFallbacks: [
        {
          task: '@papercusp/operator-core :: test:lane-stateful',
          source: 'initial-task-output',
        },
      ],
    });
    const prose = lines.join('\n');
    expect(prose).toContain('used a secondary attribution source');
    expect(prose).toContain('@papercusp/operator-core :: test:lane-stateful (source=initial-task-output)');
    const parsed = parseLine(String(lines.at(-1)));
    expect(parsed.coverage).toBe('partial');
    expect(parsed.attributionFallbackCount).toBe(1);
    expect(parsed.attributionFallbacks).toEqual([
      {
        task: '@papercusp/operator-core :: test:lane-stateful',
        source: 'initial-task-output',
      },
    ]);
  });

  it('emits every line as a single log line, so an interleaved log stays parseable', () => {
    // The leading blank separator is deliberate; no OTHER line may carry an embedded newline.
    const lines = renderFailingFilesSummary({
      runToken: 't',
      failedTaskCount: 1,
      entries: [{ workspace: '@papercusp/web', file: 'a.test.ts' }],
    });
    expect(lines.slice(1).filter((l) => l.includes('\n'))).toEqual([]);
  });
});

describe('stale failure advisory — a moved blob is evidence, not a green verdict', () => {
  const entries = [
    { workspace: '@papercusp/operator-core', file: 'lib/old.test.ts' },
    { workspace: '@papercusp/operator-core', file: 'lib/current.test.ts' },
    { workspace: '@papercusp/operator-core', file: 'lib/unresolved.test.ts' },
  ];

  it('classifies only entries whose known run-start and report blobs differ', () => {
    const runStartBlobs = {
      [failureEntryKey(entries[0])]: 'old-blob',
      [failureEntryKey(entries[1])]: 'same-blob',
      [failureEntryKey(entries[2])]: null,
    };
    const reportBlobs = {
      [failureEntryKey(entries[0])]: 'new-blob',
      [failureEntryKey(entries[1])]: 'same-blob',
      [failureEntryKey(entries[2])]: 'now-known',
    };
    const classified = classifyStaleFailureEntries({ entries, runStartBlobs, reportBlobs });
    expect(classified.stale).toEqual([{ ...entries[0], runStartBlob: 'old-blob', reportBlob: 'new-blob' }]);
    expect(classified.current).toEqual([{ ...entries[1], runStartBlob: 'same-blob', reportBlob: 'same-blob' }]);
    expect(classified.unknown).toEqual([{ ...entries[2], runStartBlob: null, reportBlob: 'now-known' }]);
  });

  it('renders a one-line, greppable advisory with both refs and blob evidence', () => {
    const lines = formatStaleFailureSummary({
      runStartHead: 'start-head',
      reportHead: 'report-head',
      stale: [
        {
          ...entries[0],
          runStartBlob: 'old-blob',
          reportBlob: 'new-blob',
        },
      ],
    });
    expect(lines[0]).toContain('STALE FAILURE ADVISORY');
    expect(lines.join('\n')).toContain('runStartHead=start-head reportHead=report-head');
    expect(lines.join('\n')).toContain('judgedBlob=old-blob treeBlob=new-blob');
    expect(lines.at(-1)).toContain(AFFECTED_TESTS_STALE_FAILURES_TOKEN);
    expect(lines.slice(1).every((line) => !line.includes('\n'))).toBe(true);
  });

  it('emits nothing when no entry is proven stale', () => {
    expect(formatStaleFailureSummary({ stale: [] })).toEqual([]);
  });
});

describe('scripts/affected-tests.mjs wires the block in (a helper nothing calls is not a fix)', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8').replaceAll('"', "'");

  it('emits the summary on the failure path', () => {
    const failureBlock = source.slice(source.indexOf('if (failed) {'));
    expect(failureBlock).toContain('renderFailingFilesSummary({');
    expect(failureBlock).toContain('runToken: RUN_TOKEN');
    // Emitted alongside — not instead of — the task-level verdict line.
    expect(failureBlock).toContain("resultLine('failed')");
  });

  it('routes every failed vitest task through the attributor, keeping BOTH of its outputs', () => {
    // The vitest reasons are asserted behaviourally above, on the helper itself. What can
    // only be checked here is that the runner keeps the `unattributed` half — dropping it
    // is precisely what makes an empty file list read as clean.
    expect(source).toContain('attributeFailedTask({');
    expect(source).toContain('failedFileEntries.push(...a.entries)');
    expect(source).toContain('unattributedTasks.push(...a.unattributed)');
  });

  it('keeps the initial task-scoped output when a retry replaces the in-memory result', () => {
    expect(source).toContain(
      "const initialTaskOutput = `${scheduled.value.stdout ?? ''}${scheduled.value.stderr ?? ''}`;",
    );
    expect(source).toContain('fallbackOutput: initialTaskOutput');
    expect(source).toContain("fallbackSource: 'initial-task-output'");
    expect(source).toContain('attributionFallbacks.push({');
    expect(source).toContain('attributionFallbacks,');
  });

  it('uses batch-timeout only as the attributor fallback, never as a parser bypass', () => {
    expect(source).toContain("fallbackReason: watchdogTimedOut ? 'batch-timeout' : undefined");
    expect(source).not.toMatch(
      /if \(watchdogTimedOut\)[\s\S]{0,500}unattributedTasks\.push\([\s\S]{0,200}batch-timeout/,
    );
  });

  it('threads the transform culprits through as well — WI-37607', () => {
    // The THIRD output of the attributor. A culprit set that is collected but never passed to
    // the renderer produces exactly today's bug (a fully-attributed break set with no stated
    // cause), and every behavioural test above would still pass, because they call the
    // renderer directly. This assertion is the only thing covering the runner's own call.
    expect(source).toContain('transformCulpritPaths.push(...a.transformCulprits)');
    expect(source).toContain('transformCulprits: transformCulpritPaths');
  });

  it('accounts for the non-vitest cargo task, which the attributor cannot speak for', () => {
    // Cargo does not go through attributeFailedTask, so its two failure sites — exit-nonzero
    // and runner-error — are the one place a red task could still be silently omitted from
    // the break set. Both must reach `unattributedTasks`, or an empty file list reads as
    // clean while cargo is red.
    //
    // This assertion used to COUNT the literal `reason: 'non-vitest'` twice in this file.
    // EI-21950408988436927 made that reason structured and per-class
    // (non-vitest | disk-admission-refused | killed-by-signal) and moved the ordinary-failure
    // literal into the pure classifier — so the count went red (WI-1593459) while the
    // invariant itself still held. A literal count is a proxy for the wiring; assert the
    // wiring and the behaviour directly, neither of which depends on which file a string
    // happens to live in.

    // Site 1 — exit-nonzero: classified, gated, and pushed with the CLASSIFIER's reason.
    expect(source).toContain('classifyAffectedCargoFailure({');
    expect(source).toContain(
      "if (cargoFailureClass.gating && !quarantined.has('papercusp-desktop'))",
    );
    expect(source).toContain('reason: cargoFailureClass.reason,');
    expect(source).toContain("failedTaskNames.push('papercusp-desktop :: cargo test')");

    // Site 2 — runner-error: the catch path accounts for itself directly.
    expect(source).toContain(
      "failedTaskNames.push('papercusp-desktop :: cargo test (runner error)')",
    );

    // BOTH sites reach the break set. This is the assertion the literal count was standing
    // in for, stated against the push that actually carries the task.
    const cargoUnattributed =
      source.match(/unattributedTasks\.push\(\{\s*task: 'papercusp-desktop :: cargo test/g) ?? [];
    expect(cargoUnattributed).toHaveLength(2); // exit-nonzero, and runner-error

    // BEHAVIOUR, so relocating the literal cannot quietly change what the break set is keyed
    // on: an ordinary cargo failure still carries `non-vitest`, and every class stays gating —
    // a suite that never ran must never be able to let the gate go green.
    expect(classifyAffectedCargoFailure({ code: 1, output: '' }).reason).toBe('non-vitest');
    expect(classifyAffectedCargoFailure({ code: 1, output: '' }).gating).toBe(true);
    expect(classifyAffectedCargoFailure({ code: 75, output: '' }).gating).toBe(true);
  });

  it('stamps the same run token that names the full run log', () => {
    const declaration = source.match(/^const RUN_LOG_PATH\s*=\s*.+;$/m)?.[0];
    expect(declaration).toBeDefined();
    expect(source).toMatch(/import\s*\{[^}]*\baffectedTestRunLogPath\b[^}]*\}\s*from\s*'[^']+\/hermetic-tmpdir\.ts'/);
    const home = mkdtempSync(join(tmpdir(), 'affected-run-token-'));
    try {
      // Execute the runner's initializer: a hard-coded token or a move back into
      // swept scratch must fail even if the helper's own tests still pass.
      for (const runToken of ['1234-abcd', '5678-ef01']) {
        const journal = new Script(`${declaration}\nRUN_LOG_PATH`).runInNewContext({
          RUN_TOKEN: runToken,
          RUN_LOG_ROOT: join(home, 'scratch'),
          join,
          affectedTestRunLogPath: (token: string) => affectedTestRunLogPath(token, home),
        });
        expect(journal).toBe(join(home, '.papercusp', 'logs', 'papercusp-affected-tests', `${runToken}.log`));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('greps for the token via the shared constant, so a rename cannot desync', () => {
    expect(AFFECTED_TESTS_FAILING_FILES_TOKEN).toBe('AFFECTED_TESTS_FAILING_FILES');
  });

  it('captures the run-start ref and wires report-time stale classification', () => {
    expect(source).toContain('const RUN_START_HEAD');
    expect(source).toContain('runStartHead=${RUN_START_HEAD');
    expect(source).toContain('classifyStaleFailureEntries({');
    expect(source).toContain('runStartBlobs');
    expect(source).toContain('reportBlobs');
    expect(source).toContain('formatStaleFailureSummary({');
  });
});

/**
 * WI-37607 — a PARSE failure in one module reds every test file that imports it, and the run
 * reported that as an ordinary, fully-attributed break set.
 *
 * The fixture below is VERBATIM from a real run log
 * (/tmp/papercusp-affected-tests-465313-5f9da4f2.log, 2026-08-09 21:24:47) rather than
 * hand-rolled — including esbuild's `File:` echo, which repeats the culprit path WITHOUT an
 * `ERROR:` marker and is the exact shape that double-counts a naive matcher.
 *
 * ⚠ ONE substitution: the absolute checkout prefix was replaced with `/w/repo`. Pasting the log
 * verbatim would have committed the build box's home path into shipped source, which reds the
 * green-checkpoint identity-lint leg and freezes `main` for the whole fleet. Every property the
 * parser actually depends on — the `Transform failed with N error` header, the
 * `path:line:col: ERROR: msg` shape, the `Plugin:` line and the ERROR-less `File:` echo — is
 * untouched. Worth noting that reaching for a verbatim fixture is what introduced the leak.
 *
 * THE CONTROL THAT MATTERS is 'a transform failure coexists with FULLY attributed files'. The
 * fix first proposed for this item discriminated only the `no-file-rows` reason — which never
 * fires here, because vitest DOES emit FAIL/rollup rows for a file whose import graph fails to
 * parse. That fix would have read as correct, changed nothing about the measured incident, and
 * left `coverage=complete` stamped on 21 innocent files.
 */
const REAL_TRANSFORM_OUTPUT = [
  'Error: Transform failed with 1 error:',
  '/w/repo/packages/operator-core/lib/sync/hyperbee/log-snapshot.ts:592:0: ERROR: Unexpected end of file',
  '  Plugin: vite:esbuild',
  '  File: /w/repo/packages/operator-core/lib/sync/hyperbee/log-snapshot.ts:592:0',
  ' FAIL  lib/cell-falsifier-reality.test.ts [ lib/cell-falsifier-reality.test.ts ]',
  ' FAIL  lib/sync/hyperbee/shipped-seed-artifact.test.ts [ lib/sync/hyperbee/shipped-seed-artifact.test.ts ]',
  ' ❯ lib/sync/hyperbee/__tests__/multi-peer-scale.test.ts (0 test)',
].join('\n');

const CULPRIT =
  '/w/repo/packages/operator-core/lib/sync/hyperbee/log-snapshot.ts:592:0';

describe('WI-37607 — transform-casualty attribution', () => {
  describe('transformCulpritsFrom — the detector, on real esbuild output', () => {
    it('names the culprit module exactly once despite the File: echo line', () => {
      expect(transformCulpritsFrom(REAL_TRANSFORM_OUTPUT)).toEqual([CULPRIT]);
    });

    it('CALIBRATION: an ordinary red with no parse failure yields no culprits', () => {
      // Without this, every assertion above is satisfiable by a detector that always fires.
      const ordinaryRed = ' FAIL  lib/a.test.ts [ lib/a.test.ts ]\n  AssertionError: expected 1 to be 2';
      expect(transformCulpritsFrom(ordinaryRed)).toEqual([]);
    });

    it('sees through ANSI colour, which real gate output always carries', () => {
      const coloured = REAL_TRANSFORM_OUTPUT.replace('ERROR:', '\u001b[31mERROR:\u001b[39m');
      expect(transformCulpritsFrom(coloured)).toEqual([CULPRIT]);
    });
  });

  describe('attributeFailedTask — culprits are independent of attribution', () => {
    it('THE CONTROL: a transform failure coexists with FULLY attributed files', () => {
      const a = attributeFailedTask({
        workspace: '@papercusp/operator-core',
        task: '@papercusp/operator-core :: test',
        captured: true,
        output: REAL_TRANSFORM_OUTPUT,
      });
      // Files ARE attributed and NOTHING is unattributed — the measured shape.
      expect(a.entries.length).toBeGreaterThan(0);
      expect(a.unattributed).toEqual([]);
      // ...yet the culprit is still reported. A fix keyed off `unattributed` misses this.
      expect(a.transformCulprits).toEqual([CULPRIT]);
    });

    it('reports reason=transform (not no-file-rows) when the collapse beat the reporter', () => {
      const noRows = REAL_TRANSFORM_OUTPUT.split('\n')
        .filter((l) => !/FAIL|❯/.test(l))
        .join('\n');
      const a = attributeFailedTask({ workspace: 'w', task: 'w :: test', captured: true, output: noRows });
      expect(a.entries).toEqual([]);
      expect(a.unattributed).toEqual([{ task: 'w :: test', reason: 'transform' }]);
    });

    it('CALIBRATION: a rowless red with no parse failure keeps reason=no-file-rows', () => {
      const a = attributeFailedTask({ workspace: 'w', task: 'w :: test', captured: true, output: 'worker crashed' });
      expect(a.unattributed).toEqual([{ task: 'w :: test', reason: 'no-file-rows' }]);
      expect(a.transformCulprits).toEqual([]);
    });

    it('an uncaptured run reports no culprits rather than claiming none exist', () => {
      const a = attributeFailedTask({ workspace: 'w', task: 'w :: test', captured: false });
      expect(a.transformCulprits).toEqual([]);
      expect(a.unattributed).toEqual([{ task: 'w :: test', reason: 'no-captured-output' }]);
    });
  });

  describe('formatFailingFilesLine — a THIRD axis, orthogonal to coverage', () => {
    it('carries the culprits while leaving coverage=complete untouched', () => {
      const p = parseLine(
        formatFailingFilesLine({
          runToken: 't',
          entries: [{ workspace: 'w', file: 'a.test.ts' }],
          transformCulprits: [CULPRIT],
        }),
      );
      // coverage keeps its DOCUMENTED meaning — green-checkpoint and CLAUDE.md consume these
      // four values, so a parse failure must not be smuggled in as a 5th.
      expect(p.coverage).toBe('complete');
      expect(p.fileCount).toBe(1);
      expect(p.transformCulpritCount).toBe(1);
      expect(p.transformCulprits).toEqual([CULPRIT]);
    });

    it('a clean break set reports zero culprits, never a missing field', () => {
      const p = parseLine(formatFailingFilesLine({ runToken: 't', entries: [{ workspace: 'w', file: 'a.test.ts' }] }));
      expect(p.transformCulpritCount).toBe(0);
      expect(p.transformCulprits).toEqual([]);
      // The pre-existing payloads must still parse — a third adjacent JSON array is exactly
      // the kind of addition that silently breaks a positional log reader.
      expect(p.files).toEqual([{ workspace: 'w', file: 'a.test.ts' }]);
      expect(p.unattributed).toEqual([]);
    });

    it('deduplicates culprits repeated per importing worker', () => {
      const p = parseLine(formatFailingFilesLine({ runToken: 't', transformCulprits: [CULPRIT, CULPRIT, CULPRIT] }));
      expect(p.transformCulprits).toEqual([CULPRIT]);
    });
  });

  describe('renderFailingFilesSummary — the warning must be read BEFORE the list', () => {
    const rendered = (transformCulprits: string[]) =>
      renderFailingFilesSummary({
        runToken: 't',
        failedTaskCount: 1,
        entries: [{ workspace: 'w', file: 'a.test.ts' }],
        transformCulprits,
      });

    it('puts the parse-failure block ahead of the per-file list', () => {
      const block = rendered([CULPRIT]).join('\n');
      const warnAt = block.indexOf('PARSE (transform) FAILURE DETECTED');
      const listAt = block.indexOf('failing test file(s)');
      expect(warnAt).toBeGreaterThanOrEqual(0);
      // Ordering IS the fix: CLAUDE.md tells triagers to read `coverage` before `files`, so a
      // caveat printed after the list is read after the wrong conclusion has already formed.
      expect(warnAt).toBeLessThan(listAt);
    });

    it('names the culprit and says plainly that the listed files are casualties', () => {
      const block = rendered([CULPRIT]).join('\n');
      expect(block).toContain(CULPRIT);
      expect(block).toContain('CASUALTIES');
      // The precise misreading this exists to prevent.
      expect(block).toMatch(/coverage[\s\S]*NOT whether those files are themselves broken/);
    });

    it('CALIBRATION: an ordinary red prints no such block at all', () => {
      const block = rendered([]).join('\n');
      expect(block).not.toContain('PARSE (transform) FAILURE DETECTED');
      expect(block).toContain('failing test file(s)');
    });
  });
});

/**
 * EI-20102376842495928 — `astro check` attribution.
 *
 * Two tasks (`@papercupai/operator-docs :: test`, `@papercupai/papercusp-docs :: test`) are
 * literally `astro check`. A red in either used to report `no-file-rows`, whose documented
 * causes are "a worker crash, an OOM, a spawn error" — so the runner handed the triager a
 * plausible INFRASTRUCTURE diagnosis for what is really a type error on a named line.
 *
 * Every fixture below is verbatim from a real astro 6.3.6 run (a scratch copy of the
 * operator-docs app with a planted two-error .astro file), read back through `cat -A`.
 */
describe('parseAstroCheckFailedFiles (EI-20102376842495928)', () => {
  // REAL BYTES. astro colors its output even when redirected to a file, so this is the
  // shape production actually captures — not the rendered text a terminal shows.
  const ERROR_ROW =
    '\x1b[96msrc/pages/__fixture-broken.astro\x1b[0m:\x1b[93m3\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m ts(2322): \x1b[0mType \'undefined\' is not assignable to type \'string\'.';
  const SECOND_ERROR_SAME_FILE =
    '\x1b[96msrc/pages/__fixture-broken.astro\x1b[0m:\x1b[93m2\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m ts(2322): \x1b[0mType \'string\' is not assignable to type \'number\'.';
  const WARNING_ROW =
    '\x1b[96msrc/content.config.ts\x1b[0m:\x1b[93m34\x1b[0m:\x1b[93m14\x1b[0m - \x1b[93mwarning\x1b[0m\x1b[90m ts(6385): \x1b[0m\'z\' is deprecated.';
  const RESULT_TAIL = 'Result (6 files): \n- 2 errors\n- 0 warnings\n- 23 hints';

  it('names the file from REAL colored bytes', () => {
    expect(parseAstroCheckFailedFiles([WARNING_ROW, ERROR_ROW, RESULT_TAIL].join('\n'))).toEqual([
      'src/pages/__fixture-broken.astro',
    ]);
  });

  /**
   * The reason the ANSI strip is load-bearing rather than decorative, pinned as an assertion
   * so nobody "simplifies" it away. A matcher written from the RENDERED text finds nothing in
   * these bytes — and an empty parse result reads as "nothing failed", never as "my matcher is
   * wrong". This is the third time this class has bitten this module.
   */
  it('CALIBRATION: the raw bytes contain no literal `error ts(` — a matcher that skips the strip sees zero', () => {
    expect(ERROR_ROW).not.toContain('error ts(');
    expect(ERROR_ROW).toMatch(/error/); // it IS there, just not contiguous
  });

  it('is failure-exclusive: warnings and hints never attribute', () => {
    expect(parseAstroCheckFailedFiles([WARNING_ROW, RESULT_TAIL].join('\n'))).toEqual([]);
  });

  it('dedupes several errors in one file', () => {
    expect(parseAstroCheckFailedFiles([ERROR_ROW, SECOND_ERROR_SAME_FILE].join('\n'))).toEqual([
      'src/pages/__fixture-broken.astro',
    ]);
  });

  /**
   * No extension whitelist — astro check reports on .astro/.ts/.md/.mdx and whatever a future
   * integration adds. Pinning a list is the naming-convention assumption that made
   * parseNodeTestFailedFiles return [] for @papercusp/cli: correct on the case you sampled,
   * empty on the one you did not.
   */
  it('attributes any file shape the typechecker names, not a fixed extension list', () => {
    const mdx = "src/content/docs/guide.mdx:12:3 - error ts(2304): Cannot find name 'Foo'.";
    expect(parseAstroCheckFailedFiles(mdx)).toEqual(['src/content/docs/guide.mdx']);
  });

  it('a clean run attributes nothing', () => {
    expect(parseAstroCheckFailedFiles('Result (6 files): \n- 0 errors\n- 0 warnings\n- 23 hints')).toEqual(
      [],
    );
  });

  it('END-TO-END: a real astro red is attributed to its file instead of reporting no-file-rows', () => {
    const res = attributeFailedTask({
      workspace: '@papercupai/operator-docs',
      task: '@papercupai/operator-docs :: test',
      captured: true,
      output: [WARNING_ROW, ERROR_ROW, RESULT_TAIL].join('\n'),
    });
    expect(res.entries).toEqual([
      { workspace: '@papercupai/operator-docs', file: 'src/pages/__fixture-broken.astro' },
    ]);
    expect(res.unattributed).toEqual([]);
  });
});

/**
 * The DECLARED_FAILING_FILE contract (EI-20102376842495928).
 *
 * Every other parser in vitest-summary.mjs reverse-engineers somebody else's output format, so
 * its risk is "the format changed and my regex went quiet". This one is OURS on both ends,
 * which removes that risk and adds a different one: the emitter and the matcher drifting apart.
 * These tests pin the ROUND TRIP for that reason — asserting the parser against a hand-written
 * string would pass just as happily while the emitter wrote something else.
 *
 * The fixture strings below are VERBATIM bytes from a real failing run of
 * apps/operator/scripts/el-tools-check.mjs (scratch registry, both error classes planted, read
 * back through `cat -A`) — not a reconstruction from the source.
 */
describe('parseDeclaredFailingFiles — a harness naming its own culprits', () => {
  const REAL_ERROR_ROW =
    "  - demo_thing (demo.thing in demo.ts): registered as browser:'optional' but pushed as " +
    "client-tool. Promote browser to 'required'.";
  const REAL_DECLARATIONS = [
    'DECLARED_FAILING_FILE scripts/el-agent-sync.mjs',
    'DECLARED_FAILING_FILE ../../packages/operator-core/lib/commands/defs/demo.ts',
  ];

  it('round-trips: what the shared emitter writes is exactly what the parser reads back', () => {
    const paths = ['scripts/el-agent-sync.mjs', '../../packages/operator-core/lib/commands/defs/demo.ts'];
    expect(parseDeclaredFailingFiles(formatDeclaredFailingFileLines(paths).join('\n'))).toEqual(paths);
  });

  it('emits the bytes a real run emitted', () => {
    expect(
      formatDeclaredFailingFileLines([
        'scripts/el-agent-sync.mjs',
        '../../packages/operator-core/lib/commands/defs/demo.ts',
      ]),
    ).toEqual(REAL_DECLARATIONS);
  });

  /**
   * A culprit outside the workspace keeps its `../` segments. The summary renders entries as
   * `<workspace> :: <file>`, so a repo-root-relative path would resolve against the wrong base
   * for whoever reads it — silently pointing at a file that does not exist there.
   */
  it('preserves a cross-tree workspace-relative path rather than normalising it away', () => {
    expect(parseDeclaredFailingFiles(REAL_DECLARATIONS[1])).toEqual([
      '../../packages/operator-core/lib/commands/defs/demo.ts',
    ]);
  });

  /**
   * The narration around a declaration names files too. `demo.ts` appears in the real error row
   * above as a bare basename that resolves nowhere — attributing it would send a triager to a
   * path that does not exist, which is worse than the `no-file-rows` this replaced.
   */
  it('reads the declaration, not the prose around it', () => {
    expect(parseDeclaredFailingFiles([REAL_ERROR_ROW, ...REAL_DECLARATIONS].join('\n'))).toEqual([
      'scripts/el-agent-sync.mjs',
      '../../packages/operator-core/lib/commands/defs/demo.ts',
    ]);
  });

  /** Line-anchored, so the token quoted inside a sentence is not a declaration. */
  it('ignores the token mid-line and a malformed multi-word payload', () => {
    const noise = [
      `  see ${DECLARED_FAILING_FILE_TOKEN} <path> for the format`,
      `${DECLARED_FAILING_FILE_TOKEN} two words here`,
      `prefixed${DECLARED_FAILING_FILE_TOKEN} a/b.ts`,
    ].join('\n');
    expect(parseDeclaredFailingFiles(noise)).toEqual([]);
  });

  /**
   * ANSI is stripped FIRST. Our emitter writes plain bytes, so this looks redundant — it is the
   * same assumption that left a sibling parser dead in production for weeks
   * (EI-18819483316574031) and made a `grep 'error ts('` over real astro output return zero.
   */
  it('still matches when the surrounding harness colourises its output', () => {
    const coloured = `\x1b[31m${DECLARED_FAILING_FILE_TOKEN} scripts/el-agent-sync.mjs\x1b[0m`;
    expect(parseDeclaredFailingFiles(coloured)).toEqual(['scripts/el-agent-sync.mjs']);
  });

  it('dedupes, and drops paths that cannot survive the line format', () => {
    expect(formatDeclaredFailingFileLines(['a/b.ts', 'a/b.ts', '', '   ', 'has space.ts'])).toEqual([
      `${DECLARED_FAILING_FILE_TOKEN} a/b.ts`,
    ]);
  });

  /** A green run declares nothing, so it can never contribute files to a break set. */
  it('attributes nothing to a run that declared nothing', () => {
    expect(parseDeclaredFailingFiles('[el-tools-check] ✓ aligned — 2 client tools.')).toEqual([]);
    expect(formatDeclaredFailingFileLines([])).toEqual([]);
  });

  it('END-TO-END: a real el-tools-check red is attributed instead of reporting no-file-rows', () => {
    const res = attributeFailedTask({
      workspace: '@papercusp/web',
      task: '@papercusp/web :: lint:el-tools',
      captured: true,
      output: ['[el-tools-check] ✗ 2 drift errors:', REAL_ERROR_ROW, ...REAL_DECLARATIONS].join('\n'),
    });
    expect(res.entries).toEqual([
      { workspace: '@papercusp/web', file: 'scripts/el-agent-sync.mjs' },
      { workspace: '@papercusp/web', file: '../../packages/operator-core/lib/commands/defs/demo.ts' },
    ]);
    expect(res.unattributed).toEqual([]);
  });
});
