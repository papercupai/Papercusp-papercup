/**
 * testing-case-categories.ts — derived per-case categories over the per-case results
 * ledger (harness_shared.test_case_runs, migration 1478).
 * Plan test-rubric-unification-2026-10-12 P-003 / R-3.
 *
 * Every category is COMPUTED at read time from the record that owns it. No table carries a
 * category column and nothing here writes, so changing a source record changes the reported
 * value with it. A stored hand label would be the drift this file exists to rule out.
 *
 *   layer       <- the test file path, through checkFileTestLayers: the same classifier a
 *                  BAR's requiredTestLayers is judged by, so a case and a bar cannot disagree
 *   subsystem   <- the /admin/testing domain registry (each section's globs)
 *   surfaces    <- coverage_evidence rows naming the case's file (and case title, when set),
 *                  resolved to live testing_surfaces rows
 *   citations   <- rubric `kind:'tests'` checks naming the file (and testName, when set), and
 *                  spec evidence bindings declaring the case in details.adequacy.testCases
 *   cost        <- p50/p95 of recorded duration_ms over executed occurrences
 *   flakiness   <- flip rate across consecutive executed runs (testing-flakiness's
 *                  definition, applied at case grain through statusFlipStats)
 *
 * `uncoveredSurfaces` lists every live testing_surfaces row that no recorded case covers.
 *
 * Case matching reuses the P-002 resolver rule (hasMatchingDeclaredCaseTitle): a cited name
 * matches a recorded case when it equals the full title path or a complete suffix of it at a
 * ` > ` boundary. A substring inside one segment never matches.
 */
import { minimatch } from 'minimatch';
import type { RecordedTestLayer } from '@papercusp/test-config/execution-details';
import { getOrgPg } from '@papercusp/db-org';
import { RESTORED_CHECKOUT_PATH_PATTERN } from '@papercusp/test-config/test-run-paths';
import { checkFileTestLayers } from './acceptance-bar-contract-completeness';
import { hasMatchingDeclaredCaseTitle } from './testing-case-filter';
import { statusFlipStats } from './testing-flakiness';

/* ------------------------------------------------------------------ *
 * Source records (the shapes the reader loads; tests build them directly)
 * ------------------------------------------------------------------ */

export type RecordedCaseStatus = 'pass' | 'fail' | 'skip';

/** One recorded occurrence of a case in one run. */
export interface CaseRunRecord {
  file: string;
  caseKey: string;
  status: RecordedCaseStatus;
  durationMs: number | null;
  /** The run's finished_at (ISO); orders the history for the flip rate. */
  finishedAt: string;
  testRunId: number;
}

/** One live testing_surfaces row. */
export interface SurfaceRecord {
  id: number;
  kind: string;
  surfaceId: string;
  sourceFile: string | null;
}

/** One coverage_evidence row that names a test file. */
export interface CoverageRecord {
  surfaceRef: number;
  testFile: string;
  /** Null = the evidence names the whole file, so it applies to every case in it. */
  testCase: string | null;
  verdict: string | null;
}

/** One rubric criterion whose check is `{ kind:'tests', files, testName? }`. */
export interface RubricTestsCitation {
  rubricId: string;
  criterionKey: string;
  files: readonly string[];
  testName?: string;
}

/** One live spec evidence binding that declares test cases. */
export interface SpecBindingCitation {
  planSlug: string;
  specId: string;
  testFile: string;
  testCases: readonly string[];
}

/** The slice of a testing domain the subsystem derivation reads (TestDomain is compatible). */
export interface DomainRecord {
  id: string;
  sections: ReadonlyArray<{ id: string; globs?: readonly string[] }>;
}

/* ------------------------------------------------------------------ *
 * Derived output
 * ------------------------------------------------------------------ */

export interface CaseSurface {
  surfaceRef: number;
  kind: string;
  surfaceId: string;
  verdict: string | null;
}

export interface CaseCitations {
  rubricChecks: Array<{ rubricId: string; criterionKey: string; testName?: string }>;
  specBindings: Array<{ planSlug: string; specId: string }>;
}

export interface CaseCost {
  /** Null when no executed occurrence recorded a duration. */
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
}

export interface CaseFlakiness {
  flipRate: number;
  flips: number;
  executedRuns: number;
  passCount: number;
  failCount: number;
}

export interface TestCaseCategories {
  file: string;
  caseKey: string;
  /** Empty when the path is not a recognised test file (unclassified, not guessed). */
  layer: RecordedTestLayer[];
  subsystem: Array<{ domainId: string; sectionId: string }>;
  surfaces: CaseSurface[];
  citations: CaseCitations;
  cost: CaseCost;
  flakiness: CaseFlakiness;
  lastStatus: RecordedCaseStatus;
  lastRunAt: string;
}

/* ------------------------------------------------------------------ *
 * Derivations — one per category, each a pure function of its source
 * ------------------------------------------------------------------ */

/** Layer from the file path (the classifier BAR requiredTestLayers are judged by). */
export function deriveCaseLayer(file: string): RecordedTestLayer[] {
  return [...(checkFileTestLayers(file) ?? [])].sort();
}

/** Subsystem from the testing domain registry: every domain section whose globs match. */
export function deriveCaseSubsystems(
  file: string,
  domains: readonly DomainRecord[],
): Array<{ domainId: string; sectionId: string }> {
  const out: Array<{ domainId: string; sectionId: string }> = [];
  for (const domain of domains) {
    for (const section of domain.sections) {
      if ((section.globs ?? []).some((glob) => minimatch(file, glob, { dot: true }))) {
        out.push({ domainId: domain.id, sectionId: section.id });
      }
    }
  }
  return out;
}

/** Whether a citation (file + optional case name) names this recorded case. */
export function citationNamesCase(
  file: string,
  caseKey: string,
  citedFile: string,
  citedName: string | null | undefined,
): boolean {
  if (citedFile !== file) return false;
  if (citedName === null || citedName === undefined || citedName === '') return true;
  return hasMatchingDeclaredCaseTitle(citedName, [caseKey]);
}

/** Surfaces from coverage evidence, resolved to live testing_surfaces rows. */
export function deriveCaseSurfaces(
  file: string,
  caseKey: string,
  coverage: readonly CoverageRecord[],
  surfacesById: ReadonlyMap<number, SurfaceRecord>,
): CaseSurface[] {
  const seen = new Set<number>();
  const out: CaseSurface[] = [];
  for (const row of coverage) {
    if (seen.has(row.surfaceRef)) continue;
    if (!citationNamesCase(file, caseKey, row.testFile, row.testCase)) continue;
    const surface = surfacesById.get(row.surfaceRef);
    if (!surface) continue; // retired or out of scope: not a live surface
    seen.add(row.surfaceRef);
    out.push({ surfaceRef: surface.id, kind: surface.kind, surfaceId: surface.surfaceId, verdict: row.verdict });
  }
  return out.sort((a, b) => a.surfaceRef - b.surfaceRef);
}

/** Citations from rubric tests checks and spec evidence bindings. */
export function deriveCaseCitations(
  file: string,
  caseKey: string,
  rubricChecks: readonly RubricTestsCitation[],
  specBindings: readonly SpecBindingCitation[],
): CaseCitations {
  const rubric = rubricChecks
    .filter((c) => c.files.some((citedFile) => citationNamesCase(file, caseKey, citedFile, c.testName)))
    .map((c) => ({
      rubricId: c.rubricId,
      criterionKey: c.criterionKey,
      ...(c.testName !== undefined ? { testName: c.testName } : {}),
    }));
  const spec = specBindings
    .filter((b) => b.testFile === file && b.testCases.some((name) => citationNamesCase(file, caseKey, file, name)))
    .map((b) => ({ planSlug: b.planSlug, specId: b.specId }));
  return { rubricChecks: rubric, specBindings: spec };
}

/** Nearest-rank percentile of an ascending-sorted list. */
function nearestRank(sortedAscending: readonly number[], percentile: number): number {
  const rank = Math.ceil((percentile / 100) * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1]!;
}

/** Cost from recorded durations of executed occurrences (a skip never ran). */
export function deriveCaseCost(runs: ReadonlyArray<Pick<CaseRunRecord, 'status' | 'durationMs'>>): CaseCost {
  const durations = runs
    .filter((r) => r.status !== 'skip' && r.durationMs !== null && Number.isFinite(r.durationMs))
    .map((r) => r.durationMs as number)
    .sort((a, b) => a - b);
  if (durations.length === 0) return { p50Ms: null, p95Ms: null, samples: 0 };
  return { p50Ms: nearestRank(durations, 50), p95Ms: nearestRank(durations, 95), samples: durations.length };
}

/** Flakiness from the ordered history of executed statuses (oldest first). */
export function deriveCaseFlakiness(
  runs: ReadonlyArray<Pick<CaseRunRecord, 'status' | 'finishedAt' | 'testRunId'>>,
): CaseFlakiness {
  const executed = runs
    .filter((r) => r.status !== 'skip')
    .slice()
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.testRunId - b.testRunId);
  const stats = statusFlipStats(executed.map((r) => r.status));
  return { ...stats, executedRuns: executed.length };
}

/**
 * Live surfaces that no recorded case covers. A surface is covered when some coverage row
 * for it names a file with recorded cases and (when it names a case) matches one of them.
 */
export function deriveUncoveredSurfaces(
  liveSurfaces: readonly SurfaceRecord[],
  coverage: readonly CoverageRecord[],
  recordedCaseKeysByFile: ReadonlyMap<string, readonly string[]>,
): SurfaceRecord[] {
  const covered = new Set<number>();
  for (const row of coverage) {
    const keys = recordedCaseKeysByFile.get(row.testFile);
    if (!keys || keys.length === 0) continue;
    if (row.testCase === null || row.testCase === '' || hasMatchingDeclaredCaseTitle(row.testCase, keys)) {
      covered.add(row.surfaceRef);
    }
  }
  return liveSurfaces.filter((s) => !covered.has(s.id)).sort((a, b) => a.id - b.id);
}

export interface CategoriesInput {
  runs: readonly CaseRunRecord[];
  liveSurfaces: readonly SurfaceRecord[];
  coverage: readonly CoverageRecord[];
  rubricChecks: readonly RubricTestsCitation[];
  specBindings: readonly SpecBindingCitation[];
  domains: readonly DomainRecord[];
  /** Recorded case keys for every file a coverage row names (the uncovered-surfaces input). */
  coverageCaseKeysByFile: ReadonlyMap<string, readonly string[]>;
}

export interface CategoriesResult {
  cases: TestCaseCategories[];
  uncoveredSurfaces: SurfaceRecord[];
}

/** Compose every derivation for every recorded case (grouped by file + case key). */
export function deriveTestCaseCategories(input: CategoriesInput): CategoriesResult {
  const surfacesById = new Map(input.liveSurfaces.map((s) => [s.id, s] as const));
  const byCase = new Map<string, CaseRunRecord[]>();
  for (const run of input.runs) {
    const id = `${run.file}\u0000${run.caseKey}`;
    const list = byCase.get(id);
    if (list) list.push(run);
    else byCase.set(id, [run]);
  }
  const cases: TestCaseCategories[] = [];
  for (const runs of byCase.values()) {
    const { file, caseKey } = runs[0]!;
    const latest = runs.reduce((a, b) =>
      b.finishedAt.localeCompare(a.finishedAt) > 0 || (b.finishedAt === a.finishedAt && b.testRunId > a.testRunId) ? b : a,
    );
    cases.push({
      file,
      caseKey,
      layer: deriveCaseLayer(file),
      subsystem: deriveCaseSubsystems(file, input.domains),
      surfaces: deriveCaseSurfaces(file, caseKey, input.coverage, surfacesById),
      citations: deriveCaseCitations(file, caseKey, input.rubricChecks, input.specBindings),
      cost: deriveCaseCost(runs),
      flakiness: deriveCaseFlakiness(runs),
      lastStatus: latest.status,
      lastRunAt: latest.finishedAt,
    });
  }
  cases.sort((a, b) => a.file.localeCompare(b.file) || a.caseKey.localeCompare(b.caseKey));
  return {
    cases,
    uncoveredSurfaces: deriveUncoveredSurfaces(input.liveSurfaces, input.coverage, input.coverageCaseKeysByFile),
  };
}

/* ------------------------------------------------------------------ *
 * Reader — loads the source records and composes the derivations
 * ------------------------------------------------------------------ */

/** A postgres-js-like tagged-template client; injectable so the reader stays unit-testable. */
export type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

/** Hard cap on case-occurrence rows one read loads; hitting it is reported, never hidden. */
export const CASE_ROW_CAP = 20_000;

export interface ReadTestCaseCategoriesOptions {
  sql?: SqlLike;
  workspaceId?: string | null;
  /** Restrict to these repo-relative test files. Empty/omitted = every file with recorded cases. */
  files?: readonly string[];
  lookbackDays?: number;
  /** Max cases returned. Aggregates still cover every loaded occurrence of each returned case. */
  limit?: number;
  /** Max uncovered surfaces returned (the total is always reported). */
  uncoveredLimit?: number;
  /** Rubric tests checks; defaults to the active rubric library (standard + acceptance). */
  loadRubricChecks?: () => Promise<RubricTestsCitation[]>;
  /** Testing domains; defaults to the operator's /admin/testing registry. */
  loadDomains?: () => Promise<readonly DomainRecord[]>;
}

export interface ReadTestCaseCategoriesResult {
  cases: TestCaseCategories[];
  casesTotal: number;
  /** True when the occurrence fetch hit CASE_ROW_CAP: counts and aggregates are then floors. */
  truncatedByLimit: boolean;
  occurrenceRows: number;
  uncoveredSurfaces: { total: number; liveSurfaces: number; items: SurfaceRecord[] };
  population: string;
}

async function defaultRubricChecks(): Promise<RubricTestsCitation[]> {
  const { listRubricsPage } = await import('./rubrics');
  const out: RubricTestsCitation[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const read = await listRubricsPage({ status: 'active', kind: 'any', limit: 200, offset });
    for (const rubric of read.rubrics) {
      for (const criterion of rubric.criteria) {
        const check = criterion.check;
        if (check?.kind !== 'tests') continue;
        out.push({
          rubricId: rubric.rubricId,
          criterionKey: criterion.key,
          files: check.files,
          ...(check.testName !== undefined ? { testName: check.testName } : {}),
        });
      }
    }
    if (!read.hasMore || read.nextOffset === null) break;
    offset = read.nextOffset;
  }
  return out;
}

async function defaultDomains(): Promise<readonly DomainRecord[]> {
  const { adminRegistry } = await import('./testing-domains-registry');
  return adminRegistry;
}

/** Read every recorded case's derived categories plus the uncovered live surfaces. */
export async function readTestCaseCategories(
  opts: ReadTestCaseCategoriesOptions = {},
): Promise<ReadTestCaseCategoriesResult> {
  const sql = opts.sql ?? (getOrgPg().sql as unknown as SqlLike);
  const lookbackDays = opts.lookbackDays ?? 14;
  const files = [...new Set(opts.files ?? [])];
  const workspaceId = opts.workspaceId ?? null;
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 500));
  const uncoveredLimit = Math.max(0, Math.min(opts.uncoveredLimit ?? 25, 500));

  const runRows = (await sql`
    SELECT r.id AS test_run_id, r.file_path, r.finished_at, c.case_key, c.status, c.duration_ms
      FROM harness_shared.test_case_runs c
      JOIN harness_shared.test_runs r ON r.id = c.test_run_id
     WHERE r.finished_at IS NOT NULL
       AND r.finished_at > now() - make_interval(days => ${lookbackDays})
       AND r.source NOT IN ('ci', 'mutation-probe')
       AND r.file_path !~ ${RESTORED_CHECKOUT_PATH_PATTERN}
       AND (${files.length === 0} OR r.file_path = ANY(${files}::text[]))
       AND (${workspaceId}::text IS NULL OR r.workspace_id = ${workspaceId} OR r.workspace_id IS NULL)
     ORDER BY r.file_path, c.case_key, r.finished_at, c.occurrence
     LIMIT ${CASE_ROW_CAP}`) as Array<{
    test_run_id: number | string;
    file_path: string;
    finished_at: string | Date;
    case_key: string;
    status: RecordedCaseStatus;
    duration_ms: number | null;
  }>;
  const runs: CaseRunRecord[] = runRows.map((r) => ({
    file: r.file_path,
    caseKey: r.case_key,
    status: r.status,
    durationMs: r.duration_ms,
    finishedAt: r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at),
    testRunId: Number(r.test_run_id),
  }));
  const runFiles = [...new Set(runs.map((r) => r.file))];

  const surfaceRows = (await sql`
    SELECT id, kind, surface_id, source_file
      FROM harness_shared.testing_surfaces
     WHERE retired_at IS NULL
       AND (${workspaceId}::text IS NULL OR workspace_id = ${workspaceId} OR workspace_id IS NULL)`) as Array<{
    id: number | string;
    kind: string;
    surface_id: string;
    source_file: string | null;
  }>;
  const liveSurfaces: SurfaceRecord[] = surfaceRows.map((s) => ({
    id: Number(s.id),
    kind: s.kind,
    surfaceId: s.surface_id,
    sourceFile: s.source_file,
  }));

  const coverageRows = (await sql`
    SELECT surface_ref, test_file, test_case, verdict
      FROM harness_shared.coverage_evidence
     WHERE test_file IS NOT NULL`) as Array<{
    surface_ref: number | string;
    test_file: string;
    test_case: string | null;
    verdict: string | null;
  }>;
  const coverage: CoverageRecord[] = coverageRows.map((c) => ({
    surfaceRef: Number(c.surface_ref),
    testFile: c.test_file,
    testCase: c.test_case,
    verdict: c.verdict,
  }));

  const coverageFiles = [...new Set(coverage.map((c) => c.testFile))];
  const coverageKeyRows = coverageFiles.length === 0
    ? []
    : ((await sql`
    SELECT DISTINCT r.file_path, c.case_key
      FROM harness_shared.test_case_runs c
      JOIN harness_shared.test_runs r ON r.id = c.test_run_id
     WHERE r.file_path = ANY(${coverageFiles}::text[])`) as Array<{ file_path: string; case_key: string }>);
  const coverageCaseKeysByFile = new Map<string, string[]>();
  for (const row of coverageKeyRows) {
    const keys = coverageCaseKeysByFile.get(row.file_path);
    if (keys) keys.push(row.case_key);
    else coverageCaseKeysByFile.set(row.file_path, [row.case_key]);
  }

  const bindingRows = runFiles.length === 0
    ? []
    : ((await sql`
    SELECT plan_slug, spec_id, evidence_ref, details->'adequacy'->'testCases' AS test_cases
      FROM harness_shared.spec_evidence_bindings
     WHERE retracted_at IS NULL
       AND evidence_kind = 'test'
       AND evidence_ref = ANY(${runFiles}::text[])
       AND jsonb_typeof(details->'adequacy'->'testCases') = 'array'
       AND (${workspaceId}::text IS NULL OR workspace_id = ${workspaceId} OR workspace_id IS NULL)`) as Array<{
        plan_slug: string | null;
        spec_id: string;
        evidence_ref: string;
        test_cases: unknown;
      }>);
  const specBindings: SpecBindingCitation[] = bindingRows.map((b) => ({
    planSlug: b.plan_slug ?? '',
    specId: b.spec_id,
    testFile: b.evidence_ref,
    testCases: Array.isArray(b.test_cases) ? b.test_cases.filter((t): t is string => typeof t === 'string') : [],
  }));

  const [rubricChecks, domains] = await Promise.all([
    (opts.loadRubricChecks ?? defaultRubricChecks)(),
    (opts.loadDomains ?? defaultDomains)(),
  ]);

  const derived = deriveTestCaseCategories({
    runs,
    liveSurfaces,
    coverage,
    rubricChecks,
    specBindings,
    domains,
    coverageCaseKeysByFile,
  });
  return {
    cases: derived.cases.slice(0, limit),
    casesTotal: derived.cases.length,
    truncatedByLimit: runRows.length >= CASE_ROW_CAP,
    occurrenceRows: runRows.length,
    uncoveredSurfaces: {
      total: derived.uncoveredSurfaces.length,
      liveSurfaces: liveSurfaces.length,
      items: derived.uncoveredSurfaces.slice(0, uncoveredLimit),
    },
    population:
      `recorded case occurrences from local test runs finished in the last ${lookbackDays} day(s) ` +
      "(source not 'ci'/'mutation-probe', the same population testing:flakiness reads)" +
      (files.length > 0 ? `, restricted to ${files.length} file(s)` : ''),
  };
}
