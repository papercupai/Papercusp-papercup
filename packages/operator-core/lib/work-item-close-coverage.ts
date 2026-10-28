/**
 * P-011 / R-10 (change-provenance-and-admission-throughput-2026-10-27): the close-coverage
 * WARNING `work_items:complete` returns.
 *
 * It compares the files a work-item edited (edit_attribution_ledger rows stamped with the
 * item, P-005) with the test files recorded in harness_shared.test_runs during the item's
 * claim window, and names every edited file no recorded run exercised. It also names every
 * covered file whose PASSING runs were all measured on a dirty tree (or never recorded the
 * flag), because a pass on a dirty tree is the documented trap (CLAUDE.md "A PASS at tip is
 * NOT proof"). The clean-tree verdict is judged only on runs that exercised an edited file:
 * an unrelated clean run elsewhere in the workspace says nothing about these files. The run
 * population is every test_runs row stamped with the workspace (agent-run test files; gate
 * rows carry no workspace and are not counted), whoever ran it. It is a warning only: nothing
 * here can refuse a close (D-003 keeps P-011 at low priority, plan non-goal: no refusal).
 *
 * The classifier is pure; the edit rows, the test runs and the "does test T exercise file F"
 * mapping are injected. {@link directImportCoverageMapping} is the default mapping: a test
 * exercises a file when it IS the file, is its sibling test (`x.ts` ↔ `x.test.ts`,
 * `__tests__/x.test.ts`), or imports it directly through a relative specifier. That is one
 * import hop, so a file reached only transitively reads as uncovered: the warning can over-
 * report, never refuse.
 */
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

/** One edit-ledger row for the work-item. `file` is repo-relative. */
export interface CloseCoverageEdit {
  file: string;
  tsMs: number;
}

/** One recorded test run. `testFile` is the repo-relative test file path. */
export interface CloseCoverageTestRun {
  testFile: string;
  status: string;
  /** test_runs.worktree_dirty; null when the run did not record it. */
  worktreeDirty: boolean | null;
  finishedAtMs: number;
}

/** True when running `testFile` exercises `editedFile`. */
export type CoverageMapping = (editedFile: string, testFile: string) => boolean;

/** Whether any passing run in the window was measured on a clean tree. */
export type CleanTreeVerdict =
  /** At least one passing run recorded worktree_dirty=false. */
  | 'clean-pass'
  /** Passing runs exist, every one recorded worktree_dirty=true. */
  | 'dirty-only'
  /** Passing runs exist; none clean, at least one did not record the flag. */
  | 'unknown'
  /** No passing run in the window. */
  | 'no-pass';

export interface CloseCoverageReport {
  windowStartMs: number;
  windowEndMs: number;
  /** Distinct edited files inside the window, sorted. */
  editedFiles: string[];
  coveredFiles: string[];
  /** Edited files no recorded run in the window exercised. */
  uncoveredFiles: string[];
  /** Test runs in the window whose status counts as having exercised code (pass / fail). */
  runsConsidered: number;
  /** Passing runs in the window that exercised at least one edited file. */
  passingRuns: number;
  /** True iff some passing run that exercised an edited file recorded worktree_dirty=false. */
  anyCleanPass: boolean;
  /** Verdict over the passing runs that exercised an edited file. */
  cleanTree: CleanTreeVerdict;
  /** Covered files whose passing runs all recorded worktree_dirty=true. */
  dirtyOnlyFiles: string[];
  /** Covered files with passing runs, none clean, at least one not recording the flag. */
  unknownTreeFiles: string[];
  /** True when the run read hit its row cap, so coverage may be undercounted. */
  runsTruncated: boolean;
}

function cleanTreeVerdict(passes: CloseCoverageTestRun[]): CleanTreeVerdict {
  if (passes.length === 0) return 'no-pass';
  if (passes.some((r) => r.worktreeDirty === false)) return 'clean-pass';
  return passes.every((r) => r.worktreeDirty === true) ? 'dirty-only' : 'unknown';
}

/** Statuses that mean the test file actually ran. skip / cancelled / running / error do not. */
const EXERCISING_STATUSES = new Set(['pass', 'fail']);

export function classifyCloseCoverage(input: {
  edits: CloseCoverageEdit[];
  testRuns: CloseCoverageTestRun[];
  covers: CoverageMapping;
  windowStartMs: number;
  windowEndMs: number;
  /** The caller's run read hit its row cap (see {@link CLOSE_COVERAGE_MAX_TEST_FILES}). */
  runsTruncated?: boolean;
}): CloseCoverageReport {
  const { windowStartMs, windowEndMs } = input;
  const inWindow = (ms: number) => Number.isFinite(ms) && ms >= windowStartMs && ms <= windowEndMs;
  const editedFiles = [...new Set(input.edits.filter((e) => inWindow(e.tsMs)).map((e) => normalize(e.file)))]
    .filter(Boolean)
    .sort();
  const runs = input.testRuns.filter(
    (r) => inWindow(r.finishedAtMs) && EXERCISING_STATUSES.has(String(r.status).toLowerCase()),
  );
  const testFiles = [...new Set(runs.map((r) => normalize(r.testFile)).filter(Boolean))];
  const coveredFiles: string[] = [];
  const uncoveredFiles: string[] = [];
  for (const file of editedFiles) {
    (testFiles.some((t) => t === file || input.covers(file, t)) ? coveredFiles : uncoveredFiles).push(file);
  }
  const exercises = (file: string, r: CloseCoverageTestRun) => {
    const t = normalize(r.testFile);
    return t === file || input.covers(file, t);
  };
  // Only runs that exercised an edited file say anything about these files' tree.
  const passes = runs.filter(
    (r) => String(r.status).toLowerCase() === 'pass' && editedFiles.some((f) => exercises(f, r)),
  );
  const anyCleanPass = passes.some((r) => r.worktreeDirty === false);
  const cleanTree = cleanTreeVerdict(passes);
  const dirtyOnlyFiles: string[] = [];
  const unknownTreeFiles: string[] = [];
  for (const file of coveredFiles) {
    const verdict = cleanTreeVerdict(passes.filter((r) => exercises(file, r)));
    if (verdict === 'dirty-only') dirtyOnlyFiles.push(file);
    else if (verdict === 'unknown') unknownTreeFiles.push(file);
  }
  return {
    windowStartMs,
    windowEndMs,
    editedFiles,
    coveredFiles,
    uncoveredFiles,
    runsConsidered: runs.length,
    passingRuns: passes.length,
    anyCleanPass,
    cleanTree,
    dirtyOnlyFiles,
    unknownTreeFiles,
    runsTruncated: input.runsTruncated === true,
  };
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, 12);
  return `${shown.join(', ')}${files.length > shown.length ? ', …' : ''}`;
}

/** The one-line warning `work_items:complete` returns, or undefined when there is nothing to say. */
export function closeCoverageWarningText(itemId: string, r: CloseCoverageReport): string | undefined {
  if (r.editedFiles.length === 0) return undefined;
  const parts: string[] = [];
  if (r.uncoveredFiles.length > 0) {
    parts.push(
      `${r.uncoveredFiles.length} of ${r.editedFiles.length} file(s) ${itemId} edited were exercised by no recorded ` +
        `test run in its claim window: ${listFiles(r.uncoveredFiles)}`,
    );
  }
  if (r.cleanTree === 'no-pass' && r.coveredFiles.length > 0) {
    parts.push('no passing test run that exercised an edited file was recorded in the claim window');
  }
  if (r.dirtyOnlyFiles.length > 0) {
    parts.push(
      `${r.dirtyOnlyFiles.length} edited file(s) passed only on a DIRTY tree (worktree_dirty=true), so they may have ` +
        `passed on bytes that are not committed: ${listFiles(r.dirtyOnlyFiles)}`,
    );
  }
  if (r.unknownTreeFiles.length > 0) {
    parts.push(
      `${r.unknownTreeFiles.length} edited file(s) have no passing run that recorded a clean tree (worktree_dirty ` +
        `unknown): ${listFiles(r.unknownTreeFiles)}`,
    );
  }
  if (parts.length === 0) return undefined;
  if (r.runsTruncated) {
    parts.push(`the test-run read hit its ${CLOSE_COVERAGE_MAX_TEST_FILES * 3}-row cap, so coverage may be undercounted`);
  }
  return (
    `close coverage (warning only, the close is not refused): ${parts.join('; ')}. ` +
    `A run counts when it passed or failed between claim and close; a test exercises a file when it is the file, ` +
    `its sibling test, or imports it directly. Run the tests that cover the named files (testing:run) on a clean tree if you meant to verify them.`
  );
}

function normalize(p: string): string {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_SUFFIX = /\.(?:integration\.)?(?:test|spec)$/;

/** `a/b/x.ts` → `a/b/x`; `a/b/__tests__/x.test.ts` → `a/b/x`. Non-code paths return null. */
function subjectStem(p: string): string | null {
  if (!CODE_EXT.test(p)) return null;
  const noExt = p.replace(CODE_EXT, '').replace(TEST_SUFFIX, '');
  return noExt.replace(/\/__tests__\//, '/');
}

/** Relative specifiers a test file imports (`import … from './x'`, `import('./x')`, `vi.mock('./x')`, `require('./x')`). */
export function relativeImportSpecifiers(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*|mock\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.add(m[1]);
  return [...out];
}

/**
 * The default {@link CoverageMapping}: same file, sibling test, or one relative-import hop.
 * `readSource` returns a test file's text (repo-relative path) or null; results are cached.
 */
export function directImportCoverageMapping(readSource: (testFile: string) => string | null): CoverageMapping {
  const importsOf = new Map<string, Set<string>>();
  const importedStems = (testFile: string): Set<string> => {
    let s = importsOf.get(testFile);
    if (s) return s;
    s = new Set<string>();
    const text = readSource(testFile);
    if (text) {
      const dir = nodePath.posix.dirname(testFile);
      for (const spec of relativeImportSpecifiers(text)) {
        const resolved = nodePath.posix.normalize(nodePath.posix.join(dir, spec));
        s.add(resolved.replace(CODE_EXT, '').replace(/\/index$/, ''));
        s.add(resolved.replace(CODE_EXT, ''));
      }
    }
    importsOf.set(testFile, s);
    return s;
  };
  return (editedFile, testFile) => {
    const f = normalize(editedFile);
    const t = normalize(testFile);
    if (f === t) return true;
    const fStem = subjectStem(f);
    if (!fStem) return false;
    if (subjectStem(t) === fStem) return true;
    const fNoExt = f.replace(CODE_EXT, '');
    const imported = importedStems(t);
    return imported.has(fNoExt) || imported.has(fNoExt.replace(/\/index$/, ''));
  };
}

/** Preload the test sources the default mapping needs, so the mapping itself stays synchronous. */
export async function loadTestSources(repoRoot: string, testFiles: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    [...new Set(testFiles)].map(async (t) => {
      try {
        out.set(t, await readFile(nodePath.resolve(repoRoot, t), 'utf8'));
      } catch {
        out.set(t, null);
      }
    }),
  );
  return out;
}

/** Bound on the distinct test files one close reads, so a long claim window cannot stall the close. */
export const CLOSE_COVERAGE_MAX_TEST_FILES = 4000;

/**
 * Read the inputs from Postgres and classify. Best-effort: returns null on any failure, so the
 * caller never refuses or fails a close because of this check.
 */
export async function computeCloseCoverage(opts: {
  workspaceId: string | null | undefined;
  workItemId: string;
  windowStartMs: number;
  windowEndMs: number;
  repoRoot: string;
}): Promise<CloseCoverageReport | null> {
  try {
    const { workspaceId, workItemId, windowStartMs, windowEndMs } = opts;
    if (!workspaceId || !Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) return null;
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const from = new Date(windowStartMs);
    const to = new Date(windowEndMs);
    const editRows = await sql<{ file: string; ts_ms: string | number }[]>`
      SELECT file, extract(epoch FROM max(ts)) * 1000 AS ts_ms
        FROM harness_shared.edit_attribution_ledger
       WHERE workspace_id = ${workspaceId}
         AND work_item_id = ${workItemId}
         AND ts >= ${from} AND ts <= ${to}
       GROUP BY file
    `;
    if (editRows.length === 0) return null;
    // Only tests under an edited file's package root can exercise it (same file, sibling test,
    // or a direct relative import). Filtering in SQL keeps the row cap from dropping the
    // alphabetically-late test files of a busy window: 24 h of workspace runs measured
    // 15,112 (file, status, dirty) rows on 2026-10-28, above the cap.
    const rootPatterns = [...new Set(editRows.map((r) => packageRoot(r.file)))];
    const filterByRoot = rootPatterns.length > 0 && !rootPatterns.includes('');
    const likePatterns = rootPatterns.map((r) => `${r.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`);
    const rowCap = CLOSE_COVERAGE_MAX_TEST_FILES * 3;
    const runRows = await sql<{ file_path: string; status: string; worktree_dirty: boolean | null; finished_ms: string | number }[]>`
      SELECT DISTINCT ON (file_path, status, worktree_dirty)
             file_path, status, worktree_dirty, extract(epoch FROM finished_at) * 1000 AS finished_ms
        FROM harness_shared.test_runs
       WHERE workspace_id = ${workspaceId}
         AND finished_at >= ${from} AND finished_at <= ${to}
         AND status IN ('pass', 'fail')
         AND (${!filterByRoot} OR file_path LIKE ANY(${likePatterns}::text[]))
       ORDER BY file_path, status, worktree_dirty, finished_at DESC
       LIMIT ${rowCap}
    `;
    const testRuns: CloseCoverageTestRun[] = runRows.map((r) => ({
      testFile: r.file_path,
      status: r.status,
      worktreeDirty: r.worktree_dirty,
      finishedAtMs: Number(r.finished_ms),
    }));
    const edits: CloseCoverageEdit[] = editRows.map((r) => ({ file: r.file, tsMs: Number(r.ts_ms) }));
    // Only tests that could cover an edited file need their source read: same top-level package.
    const roots = new Set(edits.map((e) => packageRoot(e.file)));
    const candidateTests = [...new Set(testRuns.map((r) => r.testFile))].filter((t) => roots.has(packageRoot(t)));
    const sources = await loadTestSources(opts.repoRoot, candidateTests);
    return classifyCloseCoverage({
      edits,
      testRuns,
      covers: directImportCoverageMapping((t) => sources.get(t) ?? null),
      windowStartMs,
      windowEndMs,
      runsTruncated: runRows.length >= rowCap,
    });
  } catch {
    return null;
  }
}

/** `packages/operator-core/lib/x.ts` → `packages/operator-core`; top-level files → ''. */
function packageRoot(p: string): string {
  const parts = normalize(p).split('/');
  if (parts.length <= 1) return '';
  return ['packages', 'apps', 'libs'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0];
}
