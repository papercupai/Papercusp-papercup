/**
 * test-only-propagation.mjs — keep a test-file-only change from dragging every
 * reverse-dependent workspace into the affected set
 * (WI-6554700010018047 case b; green-main-ratchet-convergence-2026-10-17#D-030 #4).
 *
 * `resolveAffected` in scripts/affected-tests.mjs walks reverse dependencies from every
 * directly changed workspace. That walk exists because a changed LIBRARY can break the
 * workspaces that import it. A changed TEST file is a leaf: nothing imports it, so no
 * dependent workspace's suite can observe the change. Before this helper, three
 * operator-core test files selected 8 workspaces and 32 tasks, and every dependent ran its
 * FULL suite: the `--related` narrowing in a dependent sees no changed path inside its own
 * root and falls back to `no-changed-paths-in-scope`. Measured 2026-10-20: one sync-batch
 * delta check on a batch of six operator-core test files spent ~23 minutes in its
 * affected leg.
 *
 * The rule: a directly changed workspace seeds the reverse-dependency walk unless EVERY
 * changed path inside its own directory is a Vitest test file that nothing outside its
 * suite can reach. The workspace itself stays affected, so the changed tests still run.
 *
 * Every uncertain case seeds the walk (the status quo), because under-running certifies
 * nothing while over-running only costs minutes:
 *   - a workspace selected by a non-workspace route or a graph suggestion;
 *   - a workspace with any changed non-test path (`package.json`, a gitlink, source);
 *   - a `.spec.*` file (Playwright, not a Vitest leaf);
 *   - a test file named by a quoted path or specifier in a Vitest config anywhere, in any
 *     file of another workspace, or in a non-test file of its own workspace;
 *   - a test file matched by a Vitest config pattern that points outside the config's
 *     directory (`'../../../templates/*\/checks/*.fixture.test.ts'`);
 *   - a failed reference search (every test file counts as reachable).
 *
 * What a "reference" is: a quoted token whose last path segment, without a script
 * extension, is the test file's stem, and whose parent segment is the test file's parent
 * directory (or which is too short to say: `'./x.test'`, `'@alias/x.test'`). A comment that
 * mentions the file name in prose, or a quoted path to a same-named test file in another
 * directory, is not a reference. Files outside every workspace directory (root `scripts/`,
 * `docs/`) are not module-graph members of any workspace suite and are ignored, except
 * Vitest config files.
 */
import { posix } from "node:path";

const VITEST_TEST_RE = /\.test\.[cm]?[jt]sx?$/;
const SCRIPT_EXT_RE = /\.[cm]?[jt]sx?$/;
const VITEST_CONFIG_RE = /(^|\/)vitest\.(config|workspace)[^/]*\.(ts|mts|cts|js|mjs|cjs)$/;
const QUOTED_TOKEN_RE = /(['"`])([^'"`\s]+?)\1/g;

/**
 * Is this repo-relative path a Vitest test file (`*.test.ts`, `*.test.mjs`, ...)?
 * `.spec.*` is deliberately excluded: those are Playwright specs and are not leaves the
 * Vitest selection can reason about.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isVitestTestPath(file) {
  return VITEST_TEST_RE.test(file);
}

/**
 * Is this repo-relative path a Vitest config or workspace file?
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isVitestConfigPath(file) {
  return VITEST_CONFIG_RE.test(file);
}

/**
 * The basename of a test file without its script extension
 * (`lib/a/capture.test.ts` -> `capture.test`).
 *
 * @param {string} file
 * @returns {string}
 */
export function testFileStem(file) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.replace(SCRIPT_EXT_RE, "");
}

/**
 * An extended regular expression (git grep -E) that pre-filters lines which might
 * reference a file with this stem: the stem after a path or quote boundary, an optional
 * script extension, then a closing quote. {@link referencesTestFile} makes the final call.
 *
 * @param {string} stem
 * @returns {string}
 */
export function stemSearchPattern(stem) {
  const escaped = stem.replace(/[.[\]()*+?^$|\\{}]/g, "\\$&");
  return `(^|[/'"\`])${escaped}(\\.[cm]?[jt]sx?)?['"\`]`;
}

/**
 * Does `file` sit inside the workspace directory `dir`?
 *
 * @param {string} dir repo-relative workspace directory, no trailing slash
 * @param {string} file repo-relative path
 * @returns {boolean}
 */
export function isUnderDir(dir, file) {
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * Does this source line contain a quoted token that may name `testFile`?
 *
 * - A relative specifier (`'./x.test'`, `'../dir/x.test.js'`) or a multi-segment path whose
 *   parent segment matches counts; so does a two-segment token whose parent cannot be
 *   compared (`'@alias/x.test'`), because an alias can map onto any directory.
 * - A bare one-segment token (`'x.test.ts'`) cannot be an import specifier, so it counts
 *   only when `bareCounts` is set (a Vitest config, where includes are root-relative). This
 *   keeps a markdown code span in a comment (`` `x.test.ts` ``) from reading as a reference.
 *
 * @param {string} line
 * @param {string} testFile repo-relative test file path
 * @param {{ bareCounts?: boolean }} [opts]
 * @returns {boolean}
 */
export function referencesTestFile(line, testFile, { bareCounts = false } = {}) {
  const stem = testFileStem(testFile);
  if (!line.includes(stem)) return false;
  const segments = testFile.split("/");
  const parent = segments.length > 1 ? segments[segments.length - 2] : null;
  for (const m of line.matchAll(QUOTED_TOKEN_RE)) {
    const raw = m[2];
    const relative = raw.startsWith("./") || raw.startsWith("../");
    const parts = raw
      .replace(SCRIPT_EXT_RE, "")
      .split("/")
      .filter((s) => s !== "" && s !== "." && s !== "..");
    if (parts.length === 0 || parts[parts.length - 1] !== stem) continue;
    if (parts.length === 1 && !raw.includes("/")) {
      if (bareCounts) return true;
      continue;
    }
    if (relative && parts.length === 1) return true;
    if (parts.length <= 2 || parts[parts.length - 2] === parent) return true;
  }
  return false;
}

/**
 * Repo-relative patterns that Vitest configs use to reach files OUTSIDE their own
 * directory, kept only when they can name a test file (a glob or a `.test.` path).
 * A setup file such as `'../../packages/x/setup-vitest.ts'` is not a test include and
 * is ignored.
 *
 * @param {Array<{ path: string, text: string }>} configs repo-relative config path + source
 * @returns {string[]} normalized repo-relative paths or globs
 */
export function crossRootTestPatterns(configs) {
  const out = new Set();
  const literal = /(['"`])(\.\.\/[^'"`\n]*)\1/g;
  for (const { path: configPath, text } of configs) {
    const base = posix.dirname(configPath);
    for (const m of text.matchAll(literal)) {
      const raw = m[2];
      if (!raw.includes("*") && !raw.includes(".test.")) continue;
      const resolved = posix.normalize(posix.join(base, raw));
      if (resolved.startsWith("../")) continue;
      out.add(resolved);
    }
  }
  return [...out].sort();
}

/**
 * Which changed test files might be imported, or collected by a suite, somewhere other
 * than their own workspace's suite. Fails open: when the reference search failed
 * (`lines === null`) every file is reported as reachable.
 *
 * @param {object} o
 * @param {Array<{ file: string, workspaceDir: string }>} o.testFiles changed test files with their owning workspace directory
 * @param {Array<{ path: string, line: string }> | null} o.lines candidate lines from tracked files (pre-filtered by {@link stemSearchPattern}); null = search failed
 * @param {string[]} o.crossRootPatterns from {@link crossRootTestPatterns}
 * @param {(file: string, pattern: string) => boolean} o.matchesGlob glob matcher (node:path matchesGlob)
 * @param {(file: string) => boolean} o.inWorkspace is this path inside some workspace directory?
 * @returns {Set<string>} the subset of `testFiles[].file` that may be reached elsewhere
 */
export function reachableElsewhere({ testFiles, lines, crossRootPatterns, matchesGlob, inWorkspace }) {
  const reached = new Set();
  if (lines === null) {
    for (const t of testFiles) reached.add(t.file);
    return reached;
  }
  for (const t of testFiles) {
    const referenced = lines.some((l) => {
      if (l.path === t.file) return false;
      const config = isVitestConfigPath(l.path);
      const counts =
        config ||
        (inWorkspace(l.path) && (!isUnderDir(t.workspaceDir, l.path) || !isVitestTestPath(l.path)));
      return counts && referencesTestFile(l.line, t.file, { bareCounts: config });
    });
    if (referenced || crossRootPatterns.some((p) => p === t.file || matchesGlob(t.file, p))) {
      reached.add(t.file);
    }
  }
  return reached;
}

/**
 * Decide which directly affected workspaces seed the reverse-dependency walk.
 *
 * @param {object} o
 * @param {Iterable<string>} o.directlyChanged every directly affected workspace name (directory, route and graph seeds)
 * @param {Map<string, string[]>} o.ownedChangedPaths workspace name -> changed paths inside that workspace's own directory
 * @param {Set<string>} o.alwaysPropagate names selected by something other than their own directory (a non-workspace route or a graph suggestion)
 * @param {Set<string>} o.reachable changed test files that may be reached elsewhere ({@link reachableElsewhere})
 * @returns {{ seeds: Set<string>, held: Array<{ workspace: string, testFiles: string[] }> }}
 *   `held` lists the workspaces that stay affected but do not seed the walk, with the test
 *   files that justified holding them back.
 */
export function propagationSeeds({ directlyChanged, ownedChangedPaths, alwaysPropagate, reachable }) {
  const seeds = new Set();
  const held = [];
  for (const name of directlyChanged) {
    const own = ownedChangedPaths.get(name) ?? [];
    const leafOnly =
      !alwaysPropagate.has(name) &&
      own.length > 0 &&
      own.every((f) => isVitestTestPath(f) && !reachable.has(f));
    if (leafOnly) held.push({ workspace: name, testFiles: [...own].sort() });
    else seeds.add(name);
  }
  return { seeds, held };
}

/**
 * Changed test files that need a reachability check: those owned by a workspace whose own
 * changed paths are ALL Vitest test files and which is not force-propagated. Returns an
 * empty list when no workspace could be held, so the caller can skip the search entirely.
 *
 * @param {object} o
 * @param {Map<string, string[]>} o.ownedChangedPaths
 * @param {Map<string, string>} o.workspaceDirs workspace name -> repo-relative directory
 * @param {Set<string>} o.alwaysPropagate
 * @returns {Array<{ file: string, workspaceDir: string }>}
 */
export function testFilesNeedingReachability({ ownedChangedPaths, workspaceDirs, alwaysPropagate }) {
  const out = [];
  for (const [name, own] of ownedChangedPaths) {
    if (alwaysPropagate.has(name) || own.length === 0 || !own.every(isVitestTestPath)) continue;
    const workspaceDir = workspaceDirs.get(name);
    if (workspaceDir == null) continue;
    for (const file of own) out.push({ file, workspaceDir });
  }
  return out;
}
