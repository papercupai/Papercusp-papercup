/**
 * empty-suite-guard.test.ts — EI-11132 regression guard.
 *
 * `scripts/affected-tests.mjs` runs each affected workspace's `test` /
 * `test:integration` script verbatim. Several workspaces bake
 * `--passWithNoTests` into that script (tolerating a genuinely test-less
 * package) — but the same flag makes vitest exit 0 when its include glob
 * stops matching ANY real test file, silently reporting the workspace green
 * having verified nothing (the "worst outcome for a release check").
 *
 * `scripts/lib/empty-suite-guard.mjs` computes, per run, whether the
 * workspace's own filesystem genuinely contains matching test files — if so,
 * the caller should disable `--passWithNoTests` for that run so a
 * stopped-matching glob fails loudly instead of silently passing. These
 * tests exercise the REAL helper against real temp-dir fixtures (no mocked
 * fs), split out so it's testable without importing (and thereby executing)
 * affected-tests.mjs's side-effecting top-level CLI flow.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  scriptUsesPassWithNoTests,
  hasMatchingTestFilesOnDisk,
  listMatchingTestFilesOnDisk,
  reuseSkipCoversRun,
  emptySuiteGuardArgs,
  scriptRunsZeroFilesAsPass,
  // The .mjs helper has no declaration file; the diagnostic lands on the
  // `from` line of this multi-line import, so the directive must be the
  // LAST comment line immediately above it.
  // @ts-expect-error
} from '../../../../scripts/lib/empty-suite-guard.mjs';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'esg-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('scriptUsesPassWithNoTests', () => {
  it('detects the flag in a real script string', () => {
    expect(scriptUsesPassWithNoTests('vitest run --passWithNoTests')).toBe(true);
  });

  it('is false for a script without the flag', () => {
    expect(scriptUsesPassWithNoTests('vitest run')).toBe(false);
  });

  it('is false for undefined/empty script text', () => {
    expect(scriptUsesPassWithNoTests(undefined)).toBe(false);
    expect(scriptUsesPassWithNoTests('')).toBe(false);
  });
});

// gate-test-reuse-yield-2026-10-01 P-006 (D-005): reuse eligibility, distinct from the guard.
describe('scriptRunsZeroFilesAsPass', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const operatorCoreScripts = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8'),
  ).scripts as Record<string, string>;

  it('admits a script that declares --passWithNoTests', () => {
    expect(scriptRunsZeroFilesAsPass('vitest run --passWithNoTests')).toBe(true);
  });

  it("admits operator-core's REAL test:lane-pure, which never names the flag", () => {
    const pure = operatorCoreScripts['test:lane-pure'];
    expect(pure).toMatch(/run-vitest-pure-lane\.mjs/);
    expect(scriptUsesPassWithNoTests(pure)).toBe(false);
    expect(scriptRunsZeroFilesAsPass(pure)).toBe(true);
  });

  it('still refuses a plain vitest script and empty text', () => {
    expect(scriptRunsZeroFilesAsPass('vitest run')).toBe(false);
    expect(scriptRunsZeroFilesAsPass('node scripts/run-vitest-pure-lane.mjs.bak')).toBe(false);
    expect(scriptRunsZeroFilesAsPass(undefined)).toBe(false);
  });

  it('leaves the EI-11132 guard keyed on the literal flag: the pure lane gets no --no-passWithNoTests', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'a.test.ts'), '');
    expect(
      emptySuiteGuardArgs({ scriptText: operatorCoreScripts['test:lane-pure'], wsAbsDir: dir, script: 'test:lane-pure' }),
    ).toEqual([]);
  });
});

describe('proof-backed empty runs for plain Vitest commands', () => {
  it('allows a fully reused plain command, keeping partial and unproven runs strict', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'a.test.ts'), '');
    writeFileSync(join(dir, 'b.test.ts'), '');
    const input = { scriptText: 'vitest run', wsAbsDir: dir, script: 'test' };
    expect(emptySuiteGuardArgs({ ...input, reuseSkipped: ['a.test.ts', 'b.test.ts'] })).toEqual(['--passWithNoTests']);
    expect(emptySuiteGuardArgs({ ...input, reuseSkipped: ['a.test.ts'] })).toEqual([]);
    expect(emptySuiteGuardArgs(input)).toEqual([]);
    expect(emptySuiteGuardArgs({ ...input, scriptText: 'node --test', reuseSkipped: ['a.test.ts', 'b.test.ts'] })).toEqual([]);
    expect(emptySuiteGuardArgs({ ...input, scriptText: 'astro check && vitest run', reuseSkipped: ['a.test.ts', 'b.test.ts'] })).toEqual([]);
  });
});

describe('hasMatchingTestFilesOnDisk', () => {
  it('finds a plain *.test.ts file for the unit `test` script', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'foo.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(true);
  });

  it('finds a *.spec.ts file too', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'bar.spec.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(true);
  });

  it('an empty workspace (no test files) is false', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'index.ts'), '// not a test');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(false);
  });

  it('excludes node_modules from the probe', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'node_modules', 'some-dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'some-dep', 'x.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(false);
  });

  it('the `test` (unit) probe EXCLUDES *.integration.test.* files — a workspace with ONLY integration tests must not look like it has unit tests', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'only.integration.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(false);
  });

  it('the `test` (unit) probe EXCLUDES *.browser.test.* files', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'only.browser.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(false);
  });

  it('a `test:integration` script probe ONLY matches *.integration.test.* — a plain unit test file does not count', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'plain.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test:integration')).toBe(false);
  });

  it('a `test:integration` script probe DOES match a real *.integration.test.ts file', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'real.integration.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test:integration')).toBe(true);
  });

  it('a nonexistent directory degrades to false rather than throwing', () => {
    expect(() => hasMatchingTestFilesOnDisk('/no/such/dir/at/all', 'test')).not.toThrow();
    expect(hasMatchingTestFilesOnDisk('/no/such/dir/at/all', 'test')).toBe(false);
  });
});

describe('emptySuiteGuardArgs — the composed per-run decision', () => {
  it('no guard args when the script does not use --passWithNoTests, even with test files present', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'foo.test.ts'), '// fixture');
    expect(emptySuiteGuardArgs({ scriptText: 'vitest run', wsAbsDir: dir, script: 'test' })).toEqual([]);
  });

  it('no guard args when passWithNoTests IS used but the workspace genuinely has no test files (today\'s lenient case, preserved)', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'index.ts'), '// not a test');
    expect(
      emptySuiteGuardArgs({ scriptText: 'vitest run --passWithNoTests', wsAbsDir: dir, script: 'test' }),
    ).toEqual([]);
  });

  it('appends --no-passWithNoTests when the script uses the flag AND real test files exist on disk', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'foo.test.ts'), '// fixture');
    expect(
      emptySuiteGuardArgs({ scriptText: 'vitest run --passWithNoTests', wsAbsDir: dir, script: 'test' }),
    ).toEqual(['--no-passWithNoTests']);
  });

  it('the integration variant only fires off a real *.integration.test.* file', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'foo.test.ts'), '// unit-only fixture — should NOT count for :integration');
    expect(
      emptySuiteGuardArgs({
        scriptText: 'vitest run --config vitest.integration.config.ts --passWithNoTests',
        wsAbsDir: dir,
        script: 'test:integration',
      }),
    ).toEqual([]);

    writeFileSync(join(dir, 'foo.integration.test.ts'), '// fixture');
    expect(
      emptySuiteGuardArgs({
        scriptText: 'vitest run --config vitest.integration.config.ts --passWithNoTests',
        wsAbsDir: dir,
        script: 'test:integration',
      }),
    ).toEqual(['--no-passWithNoTests']);
  });
});

/**
 * P-008 per-file pass reuse excludes every proven file via a skip list and arms
 * only --passWithNoTests scripts, so an all-reused run is EMPTY BY DESIGN.
 * Gate candidate 599dbeeb went red on exactly that: @papercusp/plugin-sdk had
 * 5 of 5 files reused, the guard still appended --no-passWithNoTests, and vitest
 * exited 1 with "No test files found" on both passes.
 */
describe('emptySuiteGuardArgs — a run the pass-reuse skip list deliberately empties (P-008)', () => {
  const scriptText = 'vitest run --passWithNoTests';
  function workspaceWith(files: string[]): string {
    const dir = makeTmpDir();
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), '// fixture');
    }
    return dir;
  }

  it('stands down when every on-disk test file is reused — the 599dbeeb plugin-sdk shape', () => {
    const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts'];
    const dir = workspaceWith(files);
    expect(emptySuiteGuardArgs({ scriptText, wsAbsDir: dir, script: 'test', reuseSkipped: files })).toEqual([]);
  });

  it('keeps the guard when any on-disk test file is not reused', () => {
    const dir = workspaceWith(['src/a.test.ts', 'src/b.test.ts']);
    expect(
      emptySuiteGuardArgs({ scriptText, wsAbsDir: dir, script: 'test', reuseSkipped: ['src/a.test.ts'] }),
    ).toEqual(['--no-passWithNoTests']);
  });

  it('keeps the guard for an empty skip list', () => {
    const dir = workspaceWith(['src/a.test.ts']);
    expect(emptySuiteGuardArgs({ scriptText, wsAbsDir: dir, script: 'test', reuseSkipped: [] })).toEqual([
      '--no-passWithNoTests',
    ]);
  });

  it('judges a narrowed run by its related selection, not the whole workspace', () => {
    const dir = workspaceWith(['src/a.test.ts', 'src/b.test.ts']);
    expect(
      emptySuiteGuardArgs({
        scriptText,
        wsAbsDir: dir,
        script: 'test',
        reuseSkipped: ['src/a.test.ts'],
        selectedFiles: ['src/a.test.ts'],
      }),
    ).toEqual([]);
    expect(
      emptySuiteGuardArgs({
        scriptText,
        wsAbsDir: dir,
        script: 'test',
        reuseSkipped: ['src/a.test.ts'],
        selectedFiles: ['src/a.test.ts', 'src/b.test.ts'],
      }),
    ).toEqual(['--no-passWithNoTests']);
  });

  it('matches paths regardless of a leading ./ or backslash separators', () => {
    const dir = workspaceWith(['src/a.test.ts']);
    expect(reuseSkipCoversRun({ wsAbsDir: dir, script: 'test', reuseSkipped: ['./src\\a.test.ts'] })).toBe(true);
  });

  it('the census is workspace-relative and applies the probe\'s own exclusions', () => {
    const dir = workspaceWith([
      'src/a.test.ts',
      'b.spec.ts',
      'src/only.integration.test.ts',
      'src/only.browser.test.ts',
      'node_modules/dep/x.test.ts',
    ]);
    expect([...(listMatchingTestFilesOnDisk(dir, 'test') ?? [])].sort()).toEqual(['b.spec.ts', 'src/a.test.ts']);
  });

  it('a failed census is unknown (null), so it can never read as full coverage', () => {
    expect(listMatchingTestFilesOnDisk('/no/such/dir/at/all', 'test')).toBeNull();
    expect(
      reuseSkipCoversRun({ wsAbsDir: '/no/such/dir/at/all', script: 'test', reuseSkipped: ['src/a.test.ts'] }),
    ).toBe(false);
  });
});

/**
 * The mechanism this whole fix depends on: appending `--no-passWithNoTests`
 * AFTER a script's own baked-in `--passWithNoTests` must actually override
 * it in the REAL installed vitest CLI (a raw cac/mri negation flag — see
 * node_modules/cac/dist/index.js's mri2, "last occurrence wins"). This is
 * the empirical end-to-end guard: if a future vitest/cac upgrade changes
 * that parsing behavior, THIS test catches it directly against the real
 * binary, not just against our own wrapper logic above.
 */
describe('the --no-passWithNoTests override against the REAL installed vitest binary (EI-11132)', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const VITEST_BIN = resolve(REPO_ROOT, 'node_modules/.bin/vitest');

  function runVitest(fixtureDir: string, extraArgs: string[], lenient = true) {
    return spawnSync(VITEST_BIN, ['run', '--root', fixtureDir, ...(lenient ? ['--passWithNoTests'] : []), ...extraArgs], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it.skipIf(!existsSync(VITEST_BIN))('passes a proof-covered empty run but rejects an accidental empty run with the real CLI', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['missing/**/*.test.ts'] } };\n");
    writeFileSync(join(dir, 'a.test.ts'), '');
    const input = { scriptText: 'vitest run', wsAbsDir: dir, script: 'test' };
    const reused = runVitest(dir, emptySuiteGuardArgs({ ...input, reuseSkipped: ['a.test.ts'] }), false);
    expect(reused.status, reused.stdout + reused.stderr).toBe(0);
    const unproven = runVitest(dir, emptySuiteGuardArgs(input), false);
    expect(unproven.status, unproven.stdout + unproven.stderr).toBe(1);
  });

  it.skipIf(!existsSync(VITEST_BIN))(
    'a zero-match workspace exits 0 under --passWithNoTests alone, and 1 once --no-passWithNoTests is appended after it',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'esg-real-vitest-'));
      try {
        writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['**/*.test.ts'] } };\n");
        // No test files at all — the "glob stopped matching" scenario.
        const lenient = runVitest(dir, []);
        expect(lenient.status, `expected exit 0 (lenient): ${lenient.stdout}${lenient.stderr}`).toBe(0);

        const guarded = runVitest(dir, ['--no-passWithNoTests']);
        expect(guarded.status, `expected exit 1 (guarded): ${guarded.stdout}${guarded.stderr}`).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
