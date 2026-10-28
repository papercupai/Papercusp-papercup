/**
 * P-011 / R-10 (change-provenance-and-admission-throughput-2026-10-27): the close-coverage
 * WARNING `work_items:complete` returns.
 *
 * It compares the files a work-item edited (edit_attribution_ledger rows stamped with the
 * item, P-005) with the test files recorded in harness_shared.test_runs during the item's
 * claim window, and names every edited file no recorded run exercised. It also says whether
 * any PASSING run was measured on a clean tree, because a pass on a dirty tree is the
 * documented trap (CLAUDE.md "A PASS at tip is NOT proof"). It is a warning only: nothing
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
  passingRuns: number;
  /** True iff some passing run in the window recorded worktree_dirty=false. */
  anyCleanPass: boolean;
  cleanTree: CleanTreeVerdict;
}

/** Statuses that mean the test file actually ran. skip / cancelled / running / error do not. */
const EXERCISING_STATUSES = new Set(['pass', 'fail']);

export function classifyCloseCoverage(input: {
  edits: CloseCoverageEdit[];
  testRuns: CloseCoverageTestRun[];
  covers: CoverageMapping;
  windowStartMs: number;
  windowEndMs: number;
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
  const passes = runs.filter((r) => String(r.status).toLowerCase() === 'pass');
  const anyCleanPass = passes.some((r) => r.worktreeDirty === false);
  const cleanTree: CleanTreeVerdict =
    passes.length === 0
      ? 'no-pass'
      : anyCleanPass
        ? 'clean-pass'
        : passes.every((r) => r.worktreeDirty === true)
          ? 'dirty-only'
          : 'unknown';
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
  };
}

/** The one-line warning `work_items:complete` returns, or undefined when there is nothing to say. */
export function closeCoverageWarningText(itemId: string, r: CloseCoverageReport): string | undefined {
  if (r.editedFiles.length === 0) return undefined;
  const parts: string[] = [];
  if (r.uncoveredFiles.length > 0) {
    const shown = r.uncoveredFiles.slice(0, 12);
    parts.push(
      `${r.uncoveredFiles.length} of ${r.editedFiles.length} file(s) ${itemId} edited were exercised by no recorded ` +
        `test run in its claim window: ${shown.join(', ')}${r.uncoveredFiles.length > shown.length ? ', …' : ''}`,
    );
  }
  if (r.cleanTree !== 'clean-pass') {
    parts.push(
      r.cleanTree === 'no-pass'
        ? 'no passing test run was recorded in the claim window'
        : r.cleanTree === 'dirty-only'
          ? 'every passing run in the claim window was measured on a DIRTY tree (worktree_dirty=true), so it may have passed on bytes that are not committed'
          : 'no passing run in the claim window recorded a clean tree (worktree_dirty unknown)',
    );
  }
  if (parts.length === 0) return undefined;
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
    const runRows = await sql<{ file_path: string; status: string; worktree_dirty: boolean | null; finished_ms: string | number }[]>`
      SELECT DISTINCT ON (file_path, status, worktree_dirty)
             file_path, status, worktree_dirty, extract(epoch FROM finished_at) * 1000 AS finished_ms
        FROM harness_shared.test_runs
       WHERE workspace_id = ${workspaceId}
         AND finished_at >= ${from} AND finished_at <= ${to}
         AND status IN ('pass', 'fail')
       ORDER BY file_path, status, worktree_dirty, finished_at DESC
       LIMIT ${CLOSE_COVERAGE_MAX_TEST_FILES * 3}
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
