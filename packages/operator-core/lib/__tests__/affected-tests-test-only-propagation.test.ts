/**
 * affected-tests-test-only-propagation.test.ts — WI-6554700010018047 case (b) guard
 * (green-main-ratchet-convergence-2026-10-17#D-030 #4).
 *
 * `scripts/affected-tests.mjs` walked reverse dependencies from every directly changed
 * workspace, including one whose only changed paths were its own test files. Measured
 * 2026-10-20: three operator-core test files selected 8 workspaces / 32 tasks, and a
 * sync-batch delta check on six such files spent ~23 minutes running dependents' FULL
 * suites (their `--related` narrowing falls back to `no-changed-paths-in-scope`).
 *
 * The helper holds a workspace back from SEEDING the walk only when every changed path in
 * its own directory is a Vitest test file that nothing else can reach. Each rule below is
 * pinned in both directions: a case that must hold back and a case that must still seed,
 * so a helper that always holds (or always seeds) fails here.
 *
 * The last block runs the real CLI (`--changed-paths … --print-affected`, which exits
 * before executing any suite) so the wiring in resolveAffected is pinned too.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { matchesGlob, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  crossRootTestPatterns,
  isVitestConfigPath,
  isVitestTestPath,
  propagationSeeds,
  reachableElsewhere,
  referencesTestFile,
  stemSearchPattern,
  testFileStem,
  testFilesNeedingReachability,
} from '../../../../scripts/lib/test-only-propagation.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const T = 'packages/core/lib/improvements/capture.test.ts';
const CORE = 'packages/core';
const inWorkspace = (p: string) => p.startsWith('packages/') || p.startsWith('apps/');

describe('test-only propagation: path classification', () => {
  it('treats *.test.* as a Vitest test file and *.spec.* / sources as not', () => {
    expect(isVitestTestPath('a/b.test.ts')).toBe(true);
    expect(isVitestTestPath('a/b.integration.test.ts')).toBe(true);
    expect(isVitestTestPath('a/b.test.mjs')).toBe(true);
    expect(isVitestTestPath('a/b.spec.ts')).toBe(false);
    expect(isVitestTestPath('a/b.ts')).toBe(false);
    expect(isVitestTestPath('a/package.json')).toBe(false);
  });

  it('recognizes Vitest config files only', () => {
    expect(isVitestConfigPath('apps/web/vitest.config.ts')).toBe(true);
    expect(isVitestConfigPath('vitest.workspace.mjs')).toBe(true);
    expect(isVitestConfigPath('apps/web/vite.config.ts')).toBe(false);
  });

  it('derives the stem and an ERE pre-filter that escapes dots', () => {
    expect(testFileStem(T)).toBe('capture.test');
    const re = new RegExp(stemSearchPattern('capture.test'));
    expect(re.test("from './capture.test';")).toBe(true);
    expect(re.test("'lib/x/capture.test.ts'")).toBe(true);
    expect(re.test("from './captureXtest';")).toBe(false);
    expect(re.test("'./S38-reports-capture.test.ts'")).toBe(false);
  });
});

describe('test-only propagation: what counts as a reference', () => {
  it('counts relative specifiers and paths whose parent directory matches', () => {
    expect(referencesTestFile("import { x } from './capture.test';", T)).toBe(true);
    expect(referencesTestFile("vi.mock('../improvements/capture.test.js')", T)).toBe(true);
    expect(referencesTestFile("'packages/core/lib/improvements/capture.test.ts'", T)).toBe(true);
    expect(referencesTestFile('`${dir}/capture.test.ts`', T)).toBe(true);
    // An alias can map onto any directory, so a two-segment token is conservative.
    expect(referencesTestFile("from '@alias/capture.test'", T)).toBe(true);
  });

  it('does not count prose, a same-named file elsewhere, or a longer stem', () => {
    expect(referencesTestFile(' * `capture.test.ts` fails if a population is hardcoded', T)).toBe(false);
    expect(referencesTestFile('// mirrors capture.test.ts so the handler runs', T)).toBe(false);
    expect(referencesTestFile("globs: ['packages/core/lib/instance-spec/capture.test.ts']", T)).toBe(false);
    expect(referencesTestFile("'packages/core/lib/su/S38-reports-capture.test.ts'", T)).toBe(false);
  });

  it('counts a bare file name only where includes are root-relative (a Vitest config)', () => {
    expect(referencesTestFile("include: ['capture.test.ts']", T)).toBe(false);
    expect(referencesTestFile("include: ['capture.test.ts']", T, { bareCounts: true })).toBe(true);
  });
});

describe('test-only propagation: cross-root Vitest includes', () => {
  it('resolves ../ test globs and paths, and ignores setup files and escapes from the repo', () => {
    const patterns = crossRootTestPatterns([
      {
        path: 'libs/generic/template-kit/vitest.config.ts',
        text: [
          "include: ['../../../templates/*/checks/*.fixture.test.ts',",
          "  '../../../templates/app/checks/composition-integrity.test.ts'],",
          "setupFiles: ['../../../packages/core/lib/setup-vitest.ts'],",
          "x: '../../../../../outside/*.test.ts'",
        ].join('\n'),
      },
    ]);
    expect(patterns).toEqual([
      'templates/*/checks/*.fixture.test.ts',
      'templates/app/checks/composition-integrity.test.ts',
    ]);
  });
});

describe('test-only propagation: reachability', () => {
  const base = { crossRootPatterns: [] as string[], matchesGlob, inWorkspace };
  const files = [{ file: T, workspaceDir: CORE }];

  it('fails open: a failed search marks every test file reachable', () => {
    expect([...reachableElsewhere({ ...base, testFiles: files, lines: null })]).toEqual([T]);
  });

  it('is unreachable when nothing references it', () => {
    expect(reachableElsewhere({ ...base, testFiles: files, lines: [] }).size).toBe(0);
  });

  it('ignores its own line and other test files in its own workspace', () => {
    const lines = [
      { path: T, line: "import './capture.test';" },
      { path: `${CORE}/lib/improvements/capture-volume.test.ts`, line: "vi.mock('./capture.test')" },
    ];
    expect(reachableElsewhere({ ...base, testFiles: files, lines }).size).toBe(0);
  });

  it('counts a non-test file of its own workspace (a dependent can import it)', () => {
    const lines = [{ path: `${CORE}/lib/improvements/index.ts`, line: "export * from './capture.test';" }];
    expect([...reachableElsewhere({ ...base, testFiles: files, lines })]).toEqual([T]);
  });

  it('counts any file of another workspace, test or not', () => {
    const lines = [
      { path: 'apps/web/lib/x.test.ts', line: "import '@core/lib/improvements/capture.test';" },
    ];
    expect([...reachableElsewhere({ ...base, testFiles: files, lines })]).toEqual([T]);
  });

  it('ignores files outside every workspace, except Vitest configs', () => {
    const script = [{ path: 'scripts/verify.mts', line: `run(['${T}'])` }];
    expect(reachableElsewhere({ ...base, testFiles: files, lines: script }).size).toBe(0);
    const config = [{ path: 'vitest.config.ts', line: `include: ['${T}']` }];
    expect([...reachableElsewhere({ ...base, testFiles: files, lines: config })]).toEqual([T]);
  });

  it('counts a test file matched by a cross-root include glob', () => {
    const tpl = 'templates/app/checks/a.fixture.test.ts';
    const out = reachableElsewhere({
      ...base,
      testFiles: [{ file: tpl, workspaceDir: 'templates/app' }],
      lines: [],
      crossRootPatterns: ['templates/*/checks/*.fixture.test.ts'],
    });
    expect([...out]).toEqual([tpl]);
  });
});

describe('test-only propagation: which workspaces seed the reverse-dependency walk', () => {
  const owned = (entries: Array<[string, string[]]>) => new Map(entries);

  it('holds back a workspace whose own changes are all unreachable test files', () => {
    const r = propagationSeeds({
      directlyChanged: ['core'],
      ownedChangedPaths: owned([['core', [T]]]),
      alwaysPropagate: new Set(),
      reachable: new Set(),
    });
    expect([...r.seeds]).toEqual([]);
    expect(r.held).toEqual([{ workspace: 'core', testFiles: [T] }]);
  });

  it('still seeds when any own change is a source, a manifest, a spec, or a reachable test', () => {
    for (const extra of [`${CORE}/lib/x.ts`, `${CORE}/package.json`, `${CORE}/e2e/x.spec.ts`]) {
      const r = propagationSeeds({
        directlyChanged: ['core'],
        ownedChangedPaths: owned([['core', [T, extra]]]),
        alwaysPropagate: new Set(),
        reachable: new Set(),
      });
      expect([...r.seeds], extra).toEqual(['core']);
    }
    const reached = propagationSeeds({
      directlyChanged: ['core'],
      ownedChangedPaths: owned([['core', [T]]]),
      alwaysPropagate: new Set(),
      reachable: new Set([T]),
    });
    expect([...reached.seeds]).toEqual(['core']);
  });

  it('always seeds route and graph selections and workspaces with no own paths', () => {
    const r = propagationSeeds({
      directlyChanged: ['core', 'routed', 'graph'],
      ownedChangedPaths: owned([['core', [T]]]),
      alwaysPropagate: new Set(['core', 'graph']),
      reachable: new Set(),
    });
    expect([...r.seeds].sort()).toEqual(['core', 'graph', 'routed']);
    expect(r.held).toEqual([]);
  });

  it('asks for a reachability search only for test-only, non-forced workspaces', () => {
    const need = testFilesNeedingReachability({
      ownedChangedPaths: owned([
        ['core', [T]],
        ['web', ['apps/web/lib/a.test.ts', 'apps/web/lib/a.ts']],
        ['forced', ['packages/forced/b.test.ts']],
      ]),
      workspaceDirs: new Map([
        ['core', CORE],
        ['web', 'apps/web'],
        ['forced', 'packages/forced'],
      ]),
      alwaysPropagate: new Set(['forced']),
    });
    expect(need).toEqual([{ file: T, workspaceDir: CORE }]);
  });
});

/**
 * The affected workspace names the real CLI computes for an explicit path set, plus the
 * selector's own TEST_ONLY_PROPAGATION stderr lines so a mismatch names its cause (a failed
 * reference search falls back to the full walk and is otherwise indistinguishable).
 */
function runAffected(paths: string[]): { ws: string[]; diag: string } {
  const r = spawnSync('node', [AFFECTED_TESTS, '--changed-paths', paths.join(','), '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  expect(r.status, `affected-tests --print-affected failed:\n${r.stderr}`).toBe(0);
  const ws = (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('AFFECTED_WS\t'))
    .map((l) => l.slice('AFFECTED_WS\t'.length).trim())
    .sort();
  const diag = (r.stderr ?? '')
    .split('\n')
    .filter((l) => l.includes('TEST_ONLY_PROPAGATION'))
    .join('\n');
  return { ws, diag: diag || '(no TEST_ONLY_PROPAGATION line on stderr)' };
}

function affectedFor(paths: string[]): string[] {
  return runAffected(paths).ws;
}

describe('affected-tests CLI: a test-only change does not select dependents', () => {
  // This file itself: nothing imports it, and it sits in operator-core, whose dependents
  // (web, operator-vite, ...) are selected by any operator-core SOURCE change.
  const SELF = 'packages/operator-core/lib/__tests__/affected-tests-test-only-propagation.test.ts';
  const SOURCE = 'packages/operator-core/lib/release/promotion-ratchet.ts';

  it('selects only the owning workspace for an unreferenced test file', () => {
    const r = runAffected([SELF]);
    expect(r.ws, r.diag).toEqual(['@papercusp/operator-core']);
  }, 150_000);

  it('still selects dependents when the same workspace also has a source change', () => {
    const withSource = affectedFor([SELF, SOURCE]);
    expect(withSource).toContain('@papercusp/operator-core');
    expect(withSource).toContain('@papercusp/web');
    expect(withSource.length).toBeGreaterThan(1);
  }, 150_000);

  it('keeps the status quo for a workspace a non-workspace route also selects', () => {
    // scripts/ routes to operator-core (NON_WORKSPACE_PATH_ROUTES); a routed selection
    // always seeds, even when operator-core's own changed paths are only test files.
    const withRoute = affectedFor([SELF, 'scripts/lib/test-only-propagation.mjs']);
    expect(withRoute).toContain('@papercusp/operator-core');
    expect(withRoute).toContain('@papercusp/web');
  }, 150_000);
});
