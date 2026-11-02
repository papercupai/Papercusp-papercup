/**
 * Pins the `.gitignore` dot-prefixed-test block added for EI-19319605650500051.
 *
 * WHY THIS EXISTS. A leading dot is what agents already reach for to mean "scratch,
 * deleted after this run", and on this tree that intent counts for nothing: git-sync
 * auto-commits the WHOLE tree on a schedule, so the file is committed before the agent
 * gets back to deleting it. That is measured, not hypothetical —
 * `agent-tools/coordination/.wi1347-live-verify.test.ts` opened with the words
 * "THROWAWAY (not committed, deleted after run)", was committed anyway, survived ~a
 * week, and became a genuine shared-gate red (harness_shared.test_runs source='ci',
 * 5 failures, latest 2026-08-02T05:37:44Z) while INSERTing and DELETEing rows in the
 * live fleet coordination tables from what the runner treats as a unit test.
 *
 * The `.gitignore` patterns are what make the leading dot actually hold. They are
 * ordinary-looking lines in a 200-line file with no test over them, so deleting or
 * rewording them silently reopens the hole — the failure this pins against. The
 * rationale comment lives beside the patterns in `.gitignore`; this is its
 * build-time divergence check (the PIN rung of
 * /internal/docs/agent-insights/derived-truth-ladder).
 *
 * DERIVED, NOT HAND-MAINTAINED: every assertion reads the real `.gitignore` and asks
 * real `git check-ignore`, so a pattern that is added, reworded, or moved re-derives
 * itself here. Do not replace the git call with a hand-written regex over the file —
 * matching the TEXT is not the same claim as matching the PATH, and it is the path
 * behaviour the fix depends on.
 *
 * DELIBERATELY NOT PINNED HERE: the `.gitignore` comment also records that vitest's
 * include glob runs tinyglobby with `dot:false`, so a dot-prefixed test is not
 * collected by a normal run (measured 2026-08-30). That claim is explanatory rather
 * than load-bearing — if it ever drifts the guidance goes stale, but the hole stays
 * shut, because these patterns keep the file out of the repo either way. Pinning it
 * would mean importing `tinyglobby`, which is declared by no workspace here, so the
 * pin would cost an undeclared dependency to guard the weaker half. Re-measure it by
 * hand if you are changing the runner's globbing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GITIGNORE = join(REPO_ROOT, '.gitignore');

// Bounds every sync `git` call below (WI-1218849). A sync spawn blocks the worker's event loop,
// so vitest's timeouts — JS timers — cannot fire; the pure lane shares one fork across ~2,740
// files, so an unbounded call here wedges all of them until the batch watchdog kills the task 45
// minutes later. SIGKILL is what makes the bound hold if the child ignores SIGTERM.
const GIT_TIMEOUT_MS = 15_000;

/**
 * Ask git whether a path WOULD be ignored, independent of whether it is tracked.
 * `--no-index` is essential: plain `git check-ignore` skips tracked paths, so without
 * it an already-committed offender reports "not ignored" and the probe reads clean
 * for exactly the files that matter most.
 */
function isIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', relPath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch (err) {
    // `git check-ignore --quiet` exits 1 for "not ignored" — that is the ANSWER, and the only
    // failure this may swallow. Everything else (a timeout, a missing binary, a broken repo)
    // also throws, and reporting an instrument failure as "not ignored" would hand back a clean
    // bill of health for precisely the files this probe exists to catch. Rethrow instead: a
    // broken probe must be loud, not quietly reassuring.
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

/** Dot-prefixed scratch shapes that MUST stay out of the repo. */
const MUST_BE_IGNORED = [
  'packages/operator-core/lib/agent-tools/coordination/.wi1347-live-verify.test.ts',
  'packages/operator-core/lib/.scratch.test.ts',
  'apps/operator/lib/.tmp-probe.test.tsx',
  'apps/operator/lib/.tmp-probe.test.mts',
  'libs/flags/src/.debug.spec.ts',
];

/**
 * Controls. A guard that has never been shown to DISCRIMINATE is not a guard — if the
 * patterns were widened to something like `**\/*scratch*`, every one of these real,
 * committed files would start being ignored and would silently stop being committed.
 * The scratch-NAMED entries are the sharp cases: they are legitimate tests OF the
 * scratch subsystem, and they are why the fix keys on the leading DOT rather than on
 * the word "scratch" appearing in a filename.
 */
const MUST_NOT_BE_IGNORED = [
  'packages/operator-core/lib/scratch-gc.test.ts',
  'packages/operator-core/lib/scratch-uri.test.ts',
  'packages/operator-core/lib/scratch-reference.test.ts',
  'packages/operator-core/lib/endpoint-route/__tests__/scratch.test.ts',
  'apps/operator/e2e/scratch-route.spec.ts',
  'packages/operator-core/lib/nonasserting-test-guard.test.ts',
];

describe('dot-prefixed test scratch is gitignored (EI-19319605650500051)', () => {
  it('the .gitignore block is present', () => {
    const text = readFileSync(GITIGNORE, 'utf8');
    // Assert the EFFECTIVE patterns, not the prose around them — the comment may be
    // reworded freely, the patterns may not be dropped.
    for (const pattern of ['**/.*.test.ts', '**/.*.test.tsx', '**/.*.spec.ts']) {
      expect(
        text.includes(`\n${pattern}\n`),
        `.gitignore no longer contains the pattern \`${pattern}\`. Removing it silently ` +
          `reopens EI-19319605650500051: a dot-prefixed scratch test becomes committable ` +
          `again, and git-sync will commit it on its next tick.`,
      ).toBe(true);
    }
  });

  it.each(MUST_BE_IGNORED)('ignores dot-prefixed scratch: %s', (relPath) => {
    expect(isIgnored(relPath), `${relPath} should be ignored but is not`).toBe(true);
  });

  it.each(MUST_NOT_BE_IGNORED)('does NOT ignore a real test: %s', (relPath) => {
    expect(
      isIgnored(relPath),
      `${relPath} is a REAL committed test and must not be ignored — a pattern here has ` +
        `been widened too far, and files matching it will silently stop being committed.`,
    ).toBe(false);
  });

  it('no TRACKED file is captured by the dot-test patterns', () => {
    // The mirror-image failure: gitignoring something already committed does NOT
    // untrack it, it just makes it invisible to the ignore probe people usually run
    // (plain `git check-ignore`, which skips tracked paths). That is how 529 scratch
    // files came to sit tracked-but-ignored under .papercusp/ — see WI-4419. If a dot
    // -prefixed test is ever committed before this pattern catches it, say so here
    // rather than letting it hide.
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
      .split('\n')
      .filter((p) => /(^|\/)\.[^/]*\.(test|spec)\.(ts|tsx|mts|cts)$/.test(p));

    expect(
      tracked,
      'dot-prefixed test file(s) are TRACKED. The .gitignore pattern cannot evict what ' +
        'is already committed, so these need `git rm --cached` (or deletion, if they are ' +
        'the scratch they look like).',
    ).toEqual([]);
  });
});

describe('Wrangler local output is gitignored', () => {
  it('ignores generated public-app middleware bundles', () => {
    const relPath = 'apps/operator-public/.wrangler/tmp/dev-fixture/index.js.map';
    expect(isIgnored(relPath), `${relPath} should be ignored but is not`).toBe(true);
  });
});
