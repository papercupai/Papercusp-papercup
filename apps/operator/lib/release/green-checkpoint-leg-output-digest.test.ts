import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { summarizeLegOutput, summarizeLegStreams } from './green-checkpoint';

/**
 * WI-10002075 — a failing LINT leg must persist the FILES it named, not the advice.
 *
 * The defect this guards: `outputTail` was `(stderr || stdout).slice(-300)`. A per-file
 * tsc BASELINE gate always ENDS with a fixed generic trailer, so the blind tail kept the
 * words "the named file(s)" and discarded every name. Three `lint:tsc*` legs then held
 * the frozen repair queue red for a day with no artifact naming a single offending file.
 *
 * WI-10002081 — the follow-up, and the more instructive half. The first version of both
 * the pattern AND this fixture spelled the per-file row `file.ts: 12 > 11 (+1)`, which the
 * producer NEVER emits: `formatRow` renders `12 → 11` with U+2192. The suite passed 7/7
 * against a broken matcher because the fixture was built from the same invention as the
 * code. A fixture the author made up can only ever confirm the author's assumption, so the
 * rendering below is now PINNED to the producer by `renderProducerRow` — if the real
 * template changes, the pin fails here rather than silently emptying the digest in the gate.
 */
const LEGACY_WINDOW = 300;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BASELINE_GATE_SRC = resolve(REPO_ROOT, 'scripts/lib/tsc-baseline-gate.mjs');

/**
 * Render a per-file row the way the PRODUCER does, read from the producer's own source.
 *
 * Deliberately not a copy of the template: it extracts `formatRow`'s body and asserts the
 * separator it actually uses, so this fixture cannot drift away from the gate it models.
 */
function producerSeparator(): string {
  const src = readFileSync(BASELINE_GATE_SRC, 'utf8');
  const fn = /function formatRow\(r\)\s*\{([\s\S]*?)\n\}/.exec(src);
  // A missing/renamed producer must FAIL, never skip: a vacuous pass here is exactly the
  // false-clean this whole file exists to prevent.
  expect(fn, `formatRow not found in ${BASELINE_GATE_SRC} — update this pin`).not.toBeNull();
  const body = fn![1];
  const sep = /\$\{r\.baseline\}\s*(\S+)\s*\$\{r\.current\}/.exec(body);
  expect(sep, `could not read formatRow's separator from: ${body.trim()}`).not.toBeNull();
  return sep![1];
}

const SEP = producerSeparator();

/** Exactly `formatRow`'s shape: 3-space indent, `base SEP current`, two spaces, signed delta. */
const renderProducerRow = (file: string, baseline: number, current: number): string =>
  `   ${file}: ${baseline} ${SEP} ${current}  (${current - baseline > 0 ? '+' : ''}${current - baseline})`;

/** The invariant trailer the baseline gate prints AFTER every named file. */
const TRAILER = [
  "      (this file's baseline is 0 — every error above is new.)",
  '   Fix the new errors in the named file(s). The baseline only ratchets DOWN (raising a file',
  // Deliberately NOT a real checkout path: the gate prints an absolute one here, but a
  // hardcoded home path in shipped source reds the identity-lint leg (EI-18759401203875869).
  // Only this trailer's LENGTH and trailing position matter to the calibration below.
  `   is a hand-edit of ${'<checkout>'}/papercusp-checkpoint/packages/`,
  '   operator-core/.tsc-baseline.json with justification).',
].join('\n');

const REGRESSED_FILE = 'packages/operator-core/lib/agent-tools/locks/check_command.test.ts';
const SECOND_FILE = 'packages/operator-core/lib/session-port/render.ts';

const BASELINE_GATE_OUTPUT = [
  'lint:tsc: regressed',
  renderProducerRow(REGRESSED_FILE, 11, 12),
  "     L257: checkM.mockResolvedValue({ decision: 'allow' })",
  renderProducerRow(SECOND_FILE, 0, 3),
  "     error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  'LINT_TSC_RESULT label=operator-core exit=1 status=regressed',
  TRAILER,
].join('\n');

describe('summarizeLegOutput (WI-10002075, WI-10002081)', () => {
  it('PIN: the producer really does separate the counts with U+2192, not ASCII `>`', () => {
    // The assumption that broke WI-10002075's matcher. Pinned so it cannot silently change.
    expect(SEP).toBe('→');
    expect(renderProducerRow('a/b.ts', 0, 1)).toBe('   a/b.ts: 0 → 1  (+1)');
  });

  it('CALIBRATION: the legacy blind tail really did lose the file names', () => {
    // Not decoration — this is what proves the fixture still exercises the bug.
    const legacy = BASELINE_GATE_OUTPUT.slice(-LEGACY_WINDOW);
    expect(legacy).toContain('the named file(s)');
    expect(legacy).not.toContain(REGRESSED_FILE);
    expect(legacy).not.toContain('error TS2345');
  });

  it('preserves the per-file regression rows a fixer actually needs', () => {
    const summary = summarizeLegOutput(BASELINE_GATE_OUTPUT);
    expect(summary).toContain(REGRESSED_FILE);
    expect(summary).toContain(`11 ${SEP} 12`);
    expect(summary).toContain(SECOND_FILE);
    expect(summary).toContain('error TS2345');
    expect(summary).toContain('LINT_TSC_RESULT');
  });

  it('accepts the ASCII spellings too, so a re-render cannot drop the row again', () => {
    for (const sep of ['→', '->', '>']) {
      const row = `   packages/operator-core/lib/x.ts: 0 ${sep} 4  (+4)`;
      expect(summarizeLegOutput(`${row}\n${TRAILER}`), `separator ${sep}`).toContain(
        'packages/operator-core/lib/x.ts',
      );
    }
    // NEGATIVE CONTROL: a line of the same shape with no count pair is not a regression row,
    // so a pattern loose enough to match anything would fail here.
    const notARow = `   packages/operator-core/lib/x.ts: rebuilt in 4s\n${'filler\n'.repeat(200)}`;
    expect(summarizeLegOutput(notARow)).not.toContain('--- tail ---');
  });

  it('leads with the digest so a FRONT truncation still keeps the names', () => {
    // The joined-legs consumer slices from the front; the names must survive that too.
    const summary = summarizeLegOutput(BASELINE_GATE_OUTPUT);
    expect(summary.indexOf(REGRESSED_FILE)).toBeLessThan(summary.indexOf('--- tail ---'));
    expect(summary.slice(0, LEGACY_WINDOW)).toContain(REGRESSED_FILE);
  });

  it('still keeps the raw tail underneath, where a wedge or crash surfaces', () => {
    const summary = summarizeLegOutput(BASELINE_GATE_OUTPUT);
    expect(summary).toContain('--- tail ---');
  });

  it('falls back to the whole budget when there is no recognizable diagnostic', () => {
    // A wedge/crash prints no per-file row and no TS code: the tail is the only evidence.
    const wedge = `${'noise\n'.repeat(400)}Killed after 3600s waiting for the runner`;
    const summary = summarizeLegOutput(wedge);
    expect(summary).not.toContain('--- tail ---');
    expect(summary).toContain('Killed after 3600s');
  });

  it('respects its budget', () => {
    const huge = Array.from({ length: 500 }, (_, i) =>
      renderProducerRow(`packages/operator-core/lib/f${i}.ts`, i, i + 2),
    ).join('\n');
    expect(summarizeLegOutput(huge, 1200).length).toBeLessThanOrEqual(1200);
  });

  it('drops npm boilerplate that used to crowd out the real diagnostic', () => {
    const withNpmNoise = [
      'npm error workspace @papercusp/web@0.0.1',
      'npm error command failed',
      renderProducerRow(REGRESSED_FILE, 11, 12),
    ].join('\n');
    const summary = summarizeLegOutput(withNpmNoise);
    expect(summary).toContain(REGRESSED_FILE);
    expect(summary).not.toContain('npm error');
  });
});

/**
 * WI-10007516 — a failing TEST leg must persist the test it named, not npm's footer.
 *
 * pipeline_events 601064 (2026-10-07): the frozen repair head's `test:lane-stateful` leg was
 * recorded as `[executed-source-map] written … npm error Lifecycle script … command failed`
 * and nothing else. The STDERR below and the source-map receipt are copied verbatim from that
 * event; the vitest body is the default reporter's real failure layout (progress rollup with
 * `×`, then the Failed Tests section, then the counts).
 */
const FAILING_FILE = 'lib/release/admission-fix-precheck-exec.test.ts';
const FAILING_CASE =
  'resolves on the direct child exit when a backgrounded grandchild still holds stdout, and kills it';
const VITEST_STDOUT = [
  ' RUN  v4.0.8 /checkout/packages/operator-core',
  '',
  ' ✓ lib/release/repair-head-admission.test.ts (31 tests) 812ms',
  ` ❯ ${FAILING_FILE} (6 tests | 1 failed) 2310ms`,
  '   ✓ resolves on a clean exit 12ms',
  `   × ${FAILING_CASE} 2004ms`,
  '     → expected false to be true // Object.is equality',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ` FAIL  ${FAILING_FILE} > admission fix precheck exec > ${FAILING_CASE}`,
  'AssertionError: expected false to be true // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- true',
  '+ false',
  '',
  ` ❯ ${FAILING_FILE}:88:31`,
  ...Array.from({ length: 12 }, (_, i) => `     ${80 + i}|     expect(grandchildAlive(pid)).toBe(false); // frame line ${i}`),
  ...Array.from({ length: 8 }, (_, i) => ` ❯ ChildProcess.<anonymous> lib/release/admission-fix-precheck-exec.ts:${120 + i}:9`),
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  ' Test Files  1 failed | 904 passed (905)',
  '      Tests  1 failed | 9123 passed | 14 skipped (9138)',
  '   Start at  14:02:11',
  '   Duration  612.33s (transform 30.1s, setup 0ms, collect 88.2s, tests 1402.7s)',
  '',
  '[executed-source-map] written ws=@papercusp/operator-core rows=905 skipped=14 sha=f07043ba0fece95393ea27b173dce94ab21726eb dirty=false',
].join('\n');
const NPM_FOOTER_STDERR = [
  'npm error Lifecycle script `test:lane-stateful` failed with error:',
  'npm error code 1',
  'npm error path /checkout/papercusp-checkpoint/packages/operator-core',
  'npm error workspace @papercusp/operator-core@0.1.0',
  'npm error location /checkout/papercusp-checkpoint/packages/operator-core',
  'npm error command failed',
  'npm error command sh -c PC_TEST_LANE=stateful ../../scripts/pc-heavy.sh -- vitest run --passWithNoTests',
].join('\n');

/** The pre-fix capture in `measureTargetedGateRuns`, verbatim: 1000 of each stream, 2000 joined. */
const legacyTargetedTail = (stdout: string, stderr: string): string =>
  [stdout.slice(-1_000).trim(), stderr.slice(-1_000).trim()].filter(Boolean).join('\n').slice(-2_000);

describe('summarizeLegStreams (WI-10007516)', () => {
  it('CALIBRATION: the legacy capture really did lose the failing test', () => {
    // Not decoration — proves this fixture still reproduces 601064's empty diagnosis.
    const tail = legacyTargetedTail(VITEST_STDOUT, NPM_FOOTER_STDERR);
    expect(tail).not.toContain(FAILING_CASE);
    expect(tail).not.toContain(` FAIL  ${FAILING_FILE}`);
    const brief = tail.replace(/\s+/g, ' ').slice(-600);
    expect(brief).toContain('npm error Lifecycle script');
    expect(brief).not.toContain('Test Files');
    // ...and the other two seams' `stderr || stdout` never even looked at vitest's stdout.
    expect(summarizeLegOutput(NPM_FOOTER_STDERR || VITEST_STDOUT)).not.toContain(FAILING_FILE);
  });

  it('names the failing file, case and counts, ahead of everything else', () => {
    const summary = summarizeLegStreams([VITEST_STDOUT, NPM_FOOTER_STDERR], 1_900);
    expect(summary).toContain(` FAIL  ${FAILING_FILE}`);
    expect(summary).toContain(`× ${FAILING_CASE}`);
    expect(summary).toContain(`${FAILING_FILE} (6 tests | 1 failed)`);
    expect(summary).toContain('Test Files  1 failed | 904 passed (905)');
    expect(summary).toContain('AssertionError: expected false to be true');
    expect(summary.indexOf(FAILING_CASE)).toBeLessThan(summary.indexOf('--- tail ---'));
  });

  it('fits the failing case inside the 600-char summary budget', () => {
    const brief = summarizeLegStreams([VITEST_STDOUT, NPM_FOOTER_STDERR], 600);
    expect(brief.length).toBeLessThanOrEqual(600);
    expect(brief).toContain(FAILING_CASE);
  });

  it('drops the npm footer and the source-map receipt that used to fill the window', () => {
    const summary = summarizeLegStreams([VITEST_STDOUT, NPM_FOOTER_STDERR], 1_900);
    expect(summary).not.toContain('npm error');
    expect(summary).not.toContain('[executed-source-map]');
  });

  it('lists a case vitest prints twice (progress + Failed Tests) once', () => {
    const twice = `${VITEST_STDOUT}\n FAIL  ${FAILING_FILE} > admission fix precheck exec > ${FAILING_CASE}`;
    // Count in the DIGEST: the raw tail underneath may legitimately repeat the last line.
    const digest = summarizeLegStreams([twice], 1_900).split('--- tail ---')[0]!;
    expect(digest.split(` FAIL  ${FAILING_FILE}`).length - 1).toBe(1);
  });

  it('keeps a node:test failure (spec and TAP reporters)', () => {
    const spec = [
      '✔ resolves the sidecar root (1.1ms)',
      '✖ fails loudly when papercusp is missing (3.2ms)',
      "  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /papercusp not found at/. Input:",
      '      at Test.postRun (node:internal/test_runner/test:1330:19)',
      'ℹ tests 14',
      'ℹ fail 1',
    ].join('\n');
    const specSummary = summarizeLegStreams([spec, NPM_FOOTER_STDERR]);
    expect(specSummary).toContain('✖ fails loudly when papercusp is missing');
    expect(specSummary).toContain('AssertionError [ERR_ASSERTION]: The input did not match');
    expect(specSummary).toContain('ℹ fail 1');
    const tap = summarizeLegStreams(['ok 1 - resolves\nnot ok 2 - fails loudly\n# fail 1']);
    expect(tap).toContain('not ok 2 - fails loudly');
    expect(tap).toContain('# fail 1');
  });

  it('keeps a process-level termination, the tell that a red is not a test failure', () => {
    const killed = summarizeLegStreams([
      ' ✓ lib/a.test.ts (3 tests) 9ms',
      'npm error path /checkout/packages/operator-core\nnpm error signal SIGKILL\nnpm error command failed',
    ]);
    expect(killed).toContain('npm error signal SIGKILL');
    expect(killed).not.toContain('npm error command failed');
  });

  it('never lets logged error headers push a failing name out of the digest', () => {
    // A passing test that logs an expected error prints the same header shape. 40 of them
    // ahead of the real FAIL line must not crowd it out.
    const noisy = [
      ...Array.from({ length: 40 }, (_, i) => `Error: expected rejection ${i} (logged by a passing test)`),
      ` FAIL  ${FAILING_FILE} > ${FAILING_CASE}`,
    ].join('\n');
    const summary = summarizeLegStreams([noisy], 1_900);
    expect(summary.split('\n')[0]).toContain(FAILING_CASE);
    expect(summary.split('--- tail ---')[0]!.match(/^Error: expected rejection/gm)?.length).toBeLessThanOrEqual(8);
  });

  it('keeps an npm-only stream when it is the only evidence (missing script, spawn failure)', () => {
    const missing = summarizeLegStreams([
      '',
      'npm error Missing script: "test:lane-stateful"\nnpm error\nnpm error To see a list of scripts, run:',
    ]);
    expect(missing).toContain('Missing script: "test:lane-stateful"');
    const bare = summarizeLegStreams([undefined, 'npm error code 1\nnpm error command failed']);
    expect(bare).toContain('npm error command failed');
  });

  it('splits the no-digest fallback across streams, so neither hides the other', () => {
    const out = summarizeLegStreams([`${'x'.repeat(5_000)}\nSTDOUT-LAST`, `${'y'.repeat(5_000)}\nSTDERR-LAST`], 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toContain('STDOUT-LAST');
    expect(out).toContain('STDERR-LAST');
    expect(summarizeLegStreams([undefined, '', '  '])).toBe('');
  });
});
