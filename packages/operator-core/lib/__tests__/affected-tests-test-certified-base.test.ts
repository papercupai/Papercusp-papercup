/**
 * affected-tests-test-certified-base.test.ts — WI-42146 / green-main-fast-2026-08-25 P-047.
 *
 * Guards the test-certified watermark: the diff base `affected-tests.mjs` uses when
 * the caller did not name one. The whole feature is a fail-safe, and a fail-safe is
 * the hardest kind of thing to test convincingly, because the safe answer
 * (`origin/main`) is ALSO what a completely broken implementation returns. A suite
 * that only asserted `base === 'origin/main'` on the negative cases would pass
 * against `function resolve() { return 'origin/main' }` — every guard deleted.
 *
 * So every negative case here asserts the `reason` too. `reason` names the branch
 * taken, which is what makes "refused because the watermark is behind main" and
 * "refused because the function does nothing" distinguishable at all.
 *
 * The subject is a pure function over an injected git runner, so these run with no
 * git fixture, no temp repo, and no mutation of the shared checkout.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BASE,
  DISABLE_ENV,
  SCOPE_FLAGS,
  TEST_CERTIFIED_REF,
  baseSourceLine,
  decideWatermarkAdvance,
  isScopedInvocation,
  resolveTestCertifiedBase,
} from '../../../../scripts/lib/test-certified-base.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// Overridable so `scripts/mutation-probe.sh` can point the wiring assertions at a
// COPY outside the tree (its tier-2 form) rather than mutating this shared checkout,
// where git-sync would happily commit the mutant mid-probe.
const AFFECTED_TESTS_PATH = resolve(
  REPO_ROOT,
  process.env.PROBE_AFFECTED_TESTS ?? 'scripts/affected-tests.mjs',
);

const WATERMARK = 'a'.repeat(40);
const REV_PARSE = `rev-parse --verify --quiet ${TEST_CERTIFIED_REF}^{commit}`;
const IS_ANCESTOR_OF_HEAD = `merge-base --is-ancestor ${WATERMARK} HEAD`;
const IS_AHEAD_OF_MAIN = `merge-base --is-ancestor ${DEFAULT_BASE} ${WATERMARK}`;

/**
 * A git runner that answers only what it is told to and records what it was asked.
 *
 * `merge-base --is-ancestor` answers through its EXIT STATUS and prints nothing, so
 * the real runner returns `''` for true and `null` for false. Reproducing that here
 * matters: an implementation that tested truthiness instead of `!== null` would read
 * a successful ancestry check as a failure, and every one of these cases would still
 * "pass" by falling back.
 */
function fakeGit(responses: Record<string, string | null>) {
  const calls: string[][] = [];
  const git = (argv: string[]): string | null => {
    calls.push(argv);
    const key = argv.join(' ');
    return key in responses ? responses[key] : null;
  };
  return { git, calls };
}

/** A watermark that exists, is on this history, and is at-or-ahead of main. */
const HEALTHY: Record<string, string | null> = {
  [REV_PARSE]: WATERMARK,
  [IS_ANCESTOR_OF_HEAD]: '',
  [IS_AHEAD_OF_MAIN]: '',
};

describe('test-certified base: resolution (P-047)', () => {
  it('uses a watermark that is on this history and at-or-ahead of main', () => {
    const { git } = fakeGit(HEALTHY);
    const resolved = resolveTestCertifiedBase({ git, env: {} });

    expect(resolved.base).toBe(WATERMARK);
    expect(resolved.source).toBe('watermark');
    expect(resolved.sha).toBe(WATERMARK);
    expect(resolved.reason).toBe('watermark');
  });

  it('falls back when there is no watermark ref at all — the first-run case', () => {
    const { git } = fakeGit({});
    const resolved = resolveTestCertifiedBase({ git, env: {} });

    expect(resolved.base).toBe(DEFAULT_BASE);
    expect(resolved.source).toBe('default');
    expect(resolved.reason).toBe('no-watermark');
  });

  it('refuses a FOREIGN watermark — one that is not an ancestor of HEAD', () => {
    // A rebase, a force-push, or another pot's ref. Its diff would describe a
    // history this checkout is not on, which could NARROW the run against commits
    // that are not in it — the one direction this feature must never fail in.
    const { git } = fakeGit({ ...HEALTHY, [IS_ANCESTOR_OF_HEAD]: null });
    const resolved = resolveTestCertifiedBase({ git, env: {} });

    expect(resolved.base).toBe(DEFAULT_BASE);
    expect(resolved.reason).toBe('not-ancestor-of-head');
  });

  it('refuses a watermark BEHIND main, so the watermark can only ever shrink a run', () => {
    // If it is behind, `origin/main` already gives the smaller radius. This is the
    // check that makes the whole feature monotone: it can subtract work from a run,
    // never add it.
    const { git } = fakeGit({ ...HEALTHY, [IS_AHEAD_OF_MAIN]: null });
    const resolved = resolveTestCertifiedBase({ git, env: {} });

    expect(resolved.base).toBe(DEFAULT_BASE);
    expect(resolved.reason).toBe('behind-default-base');
  });

  it('honours the kill-switch WITHOUT consulting git at all', () => {
    const { git, calls } = fakeGit(HEALTHY);
    const resolved = resolveTestCertifiedBase({ git, env: { [DISABLE_ENV]: '0' } });

    expect(resolved.base).toBe(DEFAULT_BASE);
    expect(resolved.reason).toBe('disabled');
    // A kill-switch that still shells git is not fully off — it can still fail, hang,
    // or (with a corrupt object store) throw on a run that asked it not to participate.
    expect(calls).toEqual([]);
  });

  it('falls back rather than throwing when no git runner is supplied', () => {
    expect(resolveTestCertifiedBase({ env: {} }).reason).toBe('no-git-runner');
    expect(resolveTestCertifiedBase().base).toBe(DEFAULT_BASE);
  });

  it('the four refusals are DISTINCT branches, not one function that always says origin/main', () => {
    // The calibration case for this whole describe block. Each negative above
    // asserts `origin/main`; only their reasons prove the guards exist separately.
    const reasons = new Set([
      resolveTestCertifiedBase({ git: fakeGit({}).git, env: {} }).reason,
      resolveTestCertifiedBase({ git: fakeGit({ ...HEALTHY, [IS_ANCESTOR_OF_HEAD]: null }).git, env: {} }).reason,
      resolveTestCertifiedBase({ git: fakeGit({ ...HEALTHY, [IS_AHEAD_OF_MAIN]: null }).git, env: {} }).reason,
      resolveTestCertifiedBase({ git: fakeGit(HEALTHY).git, env: { [DISABLE_ENV]: '0' } }).reason,
    ]);
    expect(reasons.size).toBe(4);
    // …and the positive control: the same inputs minus the fault DO yield a watermark,
    // so the four refusals are refusals and not a function that never succeeds.
    expect(resolveTestCertifiedBase({ git: fakeGit(HEALTHY).git, env: {} }).source).toBe('watermark');
  });

  it('announces a non-default radius loudly enough to find in a log', () => {
    const line = baseSourceLine({ sha: WATERMARK });
    expect(line).toContain('AFFECTED_BASE_SOURCE');
    expect(line).toContain(TEST_CERTIFIED_REF);
    expect(line).toContain(WATERMARK.slice(0, 12));
    // The reader of a surprising radius must be told how to turn it off.
    expect(line).toContain(DISABLE_ENV);
  });
});

describe('test-certified base: scope detection (the false-certification hole)', () => {
  // MEASURED 2026-08-26 against the implementation this test was written for:
  // `--changed-paths=p.ts` is a fully supported scoped invocation (the CLI splits
  // `--flag=value` for every VALUE_FLAG before parsing), and the original guard's
  // `process.argv.includes('--changed-paths')` answered FALSE for it. A one-file run
  // would therefore have certified the entire tree from RUN_START_HEAD. These cases
  // are that regression, pinned in both argument forms.
  it.each([
    ['space form', ['node', 'affected-tests.mjs', '--changed-paths', 'p.ts']],
    ['equals form', ['node', 'affected-tests.mjs', '--changed-paths=p.ts']],
    ['range-from equals form', ['node', 'affected-tests.mjs', '--range-from=abc']],
    ['range-to space form', ['node', 'affected-tests.mjs', '--range-to', 'abc']],
    ['qualification remaining work space form', ['node', 'affected-tests.mjs', '--qualification-work', '/snapshot']],
    ['qualification remaining work equals form', ['node', 'affected-tests.mjs', '--qualification-work=/snapshot']],
  ])('treats %s as scoped', (_label, argv) => {
    expect(isScopedInvocation(argv)).toBe(true);
  });

  it.each([
    ['a bare unscoped run', ['node', 'affected-tests.mjs']],
    ['an unrelated flag', ['node', 'affected-tests.mjs', '--integration']],
    // Control against an over-broad matcher: a flag that merely CONTAINS a scope
    // flag's name is a different flag, and reading it as scoped would silently stop
    // the watermark ever advancing — a failure that looks exactly like "no effect".
    ['a longer flag with a scope flag as its prefix', ['node', 'x.mjs', '--changed-paths-from-file=f']],
    ['a path value that merely contains a flag name', ['node', 'x.mjs', '--exclude', 'src/--range-to.ts']],
  ])('does not treat %s as scoped', (_label, argv) => {
    expect(isScopedInvocation(argv)).toBe(false);
  });

  it('agrees with the CLI that a --prefixed token after a value flag is a FLAG, not its value', () => {
    // `arg()` in affected-tests.mjs (`!args[i + 1].startsWith("--")`) refuses to consume
    // a `--`-prefixed token as a value, so in `--exclude --range-to` the CLI really does
    // see `--range-to` as present. Matching that is both correct and the safe direction:
    // over-detecting scope only ever declines to advance the watermark, while
    // under-detecting it certifies code the run never executed.
    expect(isScopedInvocation(['node', 'x.mjs', '--exclude', '--range-to'])).toBe(true);
  });

  it('is strictly stronger than the bare includes() it replaced (permanent control)', () => {
    // The deliberately-wrong implementation, kept HERE permanently rather than mutated
    // into the shared tree — the prescribed falsifiability technique for a subject the
    // test imports. This is verbatim what the guard did before P-047.
    const naive = (argv: string[]) =>
      argv.includes('--changed-paths') || argv.includes('--range-from') || argv.includes('--range-to');

    const equalsForm = ['node', 'x.mjs', '--changed-paths=p.ts'];
    expect(naive(equalsForm), 'the control must reproduce the bug, or it proves nothing').toBe(false);
    expect(isScopedInvocation(equalsForm)).toBe(true);

    // Calibration: on the space form the two AGREE. Without this, a control that simply
    // always disagreed would look identical to one that isolates the `=` handling.
    const spaceForm = ['node', 'x.mjs', '--changed-paths', 'p.ts'];
    expect(naive(spaceForm)).toBe(true);
    expect(isScopedInvocation(spaceForm)).toBe(true);
  });

  it('survives a non-array or non-string argv instead of throwing mid-run', () => {
    expect(isScopedInvocation(undefined as unknown as string[])).toBe(false);
    expect(isScopedInvocation([null, 42, '--changed-paths'] as unknown as string[])).toBe(true);
  });
});

describe('test-certified base: the advance decision', () => {
  const CLEAN = { env: {}, argv: ['node', 'affected-tests.mjs'], runStartHead: 'b'.repeat(40) };

  it('advances after a clean, unscoped, fully-determined run', () => {
    const decision = decideWatermarkAdvance(CLEAN);
    expect(decision.advance).toBe(true);
    expect(decision.reason).toBe('advance');
    // It certifies the sha the run STARTED at. git-sync commits this shared tree
    // continuously, so HEAD has almost certainly moved during a run this long, and
    // certifying HEAD would vouch for commits no task ever saw.
    expect(decision.sha).toBe(CLEAN.runStartHead);
  });

  it.each([
    ['a scoped run (space form)', { argv: ['node', 'x', '--changed-paths', 'p.ts'] }, 'scoped'],
    ['a scoped run (equals form)', { argv: ['node', 'x', '--changed-paths=p.ts'] }, 'scoped'],
    ['remaining qualification work (space form)', { argv: ['node', 'x', '--qualification-work', '/snapshot'] }, 'scoped'],
    ['remaining qualification work (equals form)', { argv: ['node', 'x', '--qualification-work=/snapshot'] }, 'scoped'],
    ['a failing run', { failed: true }, 'failed'],
    ['a run with an undetermined task', { undeterminedTasks: true }, 'undetermined'],
    ['a run with a timed-out task', { timedOutTasks: true }, 'timed-out'],
    ['a run whose start sha is unknown', { runStartHead: null }, 'no-run-start-head'],
    ['a run with the kill-switch set', { env: { [DISABLE_ENV]: '0' } }, 'disabled'],
  ])('refuses %s', (_label, override, reason) => {
    const decision = decideWatermarkAdvance({ ...CLEAN, ...override });
    expect(decision.advance).toBe(false);
    expect(decision.reason).toBe(reason);
    // Never hand back a sha it refused to certify — a caller that read `sha` without
    // checking `advance` would write the ref anyway.
    expect(decision.sha).toBeNull();
  });

  it('does not read "no failures reported" as "everything passed"', () => {
    // `undetermined` and `timedOut` are refusals in their own right rather than being
    // folded into `failed`. A task whose verdict was never established is exactly the
    // case where an absence of failures must not be promoted to a pass.
    expect(decideWatermarkAdvance({ ...CLEAN, failed: false, undeterminedTasks: true }).advance).toBe(false);
    expect(decideWatermarkAdvance({ ...CLEAN, failed: false, timedOutTasks: true }).advance).toBe(false);
  });

  it('refuses on a bare call rather than certifying an unknown sha', () => {
    expect(decideWatermarkAdvance().advance).toBe(false);
  });
});

describe('wiring: affected-tests.mjs actually uses this (a helper nothing calls is not a fix)', () => {
  const src = readFileSync(AFFECTED_TESTS_PATH, 'utf8');

  it('imports the module and routes both decisions through it', () => {
    expect(src).toContain('./lib/test-certified-base.mjs');
    expect(src).toMatch(/resolveTestCertifiedBase\(\{/);
    expect(src).toMatch(/decideWatermarkAdvance\(\{/);
  });

  it('no longer scope-checks raw argv with a bare includes()', () => {
    // The exact shape of the defect this test was written for. If it comes back, the
    // `=` form silently stops counting as scoped again and nothing else would notice.
    expect(src).not.toMatch(/process\.argv\.includes\(\s*["']--changed-paths["']\s*\)/);
    expect(src).not.toMatch(/process\.argv\.includes\(\s*["']--range-(from|to)["']\s*\)/);
  });

  it('every SCOPE_FLAG is a VALUE_FLAG in the CLI, which is WHY the = form must be handled', () => {
    // Pins the copy to its source (derived-truth ladder). `isScopedInvocation` mirrors
    // the CLI's `--flag=value` splitting; that mirroring is only correct while these
    // flags actually take values there. If one stops being a VALUE_FLAG — or a new
    // scope-narrowing value flag is added and not mirrored here — this fails loudly
    // rather than quietly re-opening the false-certification hole.
    const valueFlags = src.match(/const VALUE_FLAGS = new Set\(\[([\s\S]*?)\]\)/);
    expect(valueFlags, 'VALUE_FLAGS not found — affected-tests.mjs changed shape').toBeTruthy();
    for (const flag of SCOPE_FLAGS) {
      expect(valueFlags![1], `${flag} must remain a VALUE_FLAG`).toContain(`"${flag}"`);
    }
  });

  it('the real CLI still derives origin/main when the watermark is switched off', () => {
    // End-to-end control: the pure functions above could all be correct while the
    // script mis-wires them. `--print-affected` exits before any suite runs.
    const r = spawnSync('node', [AFFECTED_TESTS_PATH, '--changed-paths', 'README.md', '--print-affected'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, [DISABLE_ENV]: '0' },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
      killSignal: 'SIGKILL',
    });
    expect(r.status, `--print-affected failed:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/AFFECTED_DERIVATION /);
    // With the switch off it must be silent about the watermark, whatever refs exist.
    expect(r.stderr).not.toContain('AFFECTED_BASE_SOURCE');
  });
});
